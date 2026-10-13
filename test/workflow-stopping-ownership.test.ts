import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { started: new Promise<void>((resolve) => { enter = resolve; }),
    promise: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

class StoppingReadStore extends WorkflowStore {
  readonly reading = gate();
  holdRead = true;
  override async activeForSession(id: string): Promise<WorkflowRecord | undefined> {
    const record = await super.activeForSession(id);
    if (this.holdRead) {
      this.holdRead = false;
      this.reading.enter();
      await this.reading.promise;
    }
    return record;
  }
}

async function waitStarted(hold: ReturnType<typeof gate>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hold.started, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Turn-stopping workflow read did not reach its return barrier")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-workflow-stopping-owner-"));
  const store = new StoppingReadStore(join(directory, "storage"));
  const owner = SessionId("turn-stopping-owner");
  const steering: string[] = [];
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false });
  const agent = { id: owner, session, steer(message: { content: Array<{ text?: string }> }) {
    steering.push(message.content.map((block) => block.text ?? "").join("\n"));
  } } as unknown as Agent;
  const exec = { agent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  let modelCalls = 0;
  const forbidden = async (): Promise<never> => { modelCalls += 1; throw new Error("Turn-stopping inspection cannot start a model"); };
  const gateway: CodexGateway = { startThread: forbidden, resumeThread: forbidden, startTurn: forbidden,
    continueTurn: forbidden, startReview: forbidden, normalizeInFork: forbidden, async interrupt() {} };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    leaseTtlMs: 10000, turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const now = new Date().toISOString();
  const record: WorkflowRecord = { schemaVersion: 1, id: "turn-stopping-workflow", dshSessionId: owner,
    cwd: directory, task: "Review original read-only diagnostics", mode: "planned", phase: "executing",
    createdAt: now, updatedAt: now, assumptions: [], questions: [], reviewCycles: 0, reviewAttempt: 1,
    planMarkdown: "<proposed_plan>\nImplement original diagnostics read-only.\n</proposed_plan>" };
  await store.save(record);
  return { directory, store, manager, runtime, record, agent, exec, steering,
    assertNoModel() { assert.equal(modelCalls, 0); },
    async close() {
      store.reading.release(); await manager.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("turn stopping cannot steer an obsolete workflow after cancellation or plugin stop wins its read", async () => {
  for (const action of ["cancel", "stop"] as const) {
    const f = await fixture();
    const stopping = f.manager.onTurnStopping(f.agent, 7);
    const settled = Promise.allSettled([stopping]);
    try {
      await waitStarted(f.store.reading);
      if (action === "cancel") await f.manager.cancel(f.record.id, f.exec);
      else await f.manager.stop();
      const snapshot = (await f.store.load(f.record.id))!;
      f.store.reading.release();
      const outcome = (await settled)[0]!;
      assert.equal(outcome.status, "fulfilled");
      assert.deepEqual(f.steering, [], `${action}: a stale turn end cannot request another review`);
      assert.deepEqual(await f.store.load(f.record.id), snapshot);
      assert.equal(f.runtime.nudgedTurns.has(`${f.record.id}:7`), false, "a skipped stale read cannot consume a valid later nudge");
      f.assertNoModel();
    } finally { f.store.reading.release(); await settled; await f.close(); }
  }
});

test("turn stopping cannot redirect a captured workflow to a replacement owner, task or review attempt", async () => {
  for (const change of ["owner", "task", "attempt"] as const) {
    const f = await fixture();
    const stopping = f.manager.onTurnStopping(f.agent, 8);
    const settled = Promise.allSettled([stopping]);
    try {
      await waitStarted(f.store.reading);
      await f.store.update(f.record.id, (record) => {
        if (change === "owner") record.dshSessionId = "replacement-owner";
        else if (change === "task") record.task = "REPLACEMENT-TASK-TURNSTOP";
        else record.reviewAttempt = 19;
      });
      const replacement = (await f.store.load(f.record.id))!;
      f.store.reading.release();
      assert.equal((await settled)[0]?.status, "fulfilled");
      assert.deepEqual(f.steering, [], `${change}: an old snapshot cannot steer a newer scope`);
      assert.deepEqual(await f.store.load(f.record.id), replacement, "read-only turn inspection preserves the full replacement row");
      assert.equal(f.runtime.nudgedTurns.has(`${f.record.id}:8`), false);
      f.assertNoModel();
    } finally { f.store.reading.release(); await settled; await f.close(); }
  }
});

test("turn stopping does not prompt a new review while the original model or continuation is already running", async () => {
  for (const running of ["process", "resume"] as const) {
    const f = await fixture();
    const flight = gate();
    let injectedFlight: Promise<WorkflowRecord> | undefined;
    const stopping = f.manager.onTurnStopping(f.agent, 9);
    const settled = Promise.allSettled([stopping]);
    try {
      await waitStarted(f.store.reading);
      if (running === "process") await f.store.update(f.record.id, (record) => { record.processState = "running"; });
      else {
        injectedFlight = flight.promise.then(() => f.store.load(f.record.id)).then((record) => record!);
        f.runtime.resumeFlights.set(f.record.id, injectedFlight);
      }
      const snapshot = (await f.store.load(f.record.id))!;
      f.store.reading.release();
      assert.equal((await settled)[0]?.status, "fulfilled");
      assert.deepEqual(f.steering, [], `${running}: wait for the admitted original operation instead of requesting another round`);
      assert.deepEqual(await f.store.load(f.record.id), snapshot);
      assert.equal(f.runtime.nudgedTurns.has(`${f.record.id}:9`), false);
      f.assertNoModel();
    } finally {
      f.runtime.resumeFlights.delete(f.record.id); flight.release();
      await injectedFlight;
      f.store.reading.release(); await settled; await f.close();
    }
  }
});

test("an unchanged idle workflow receives one appropriate review nudge per turn without durable mutation", async () => {
  const f = await fixture();
  try {
    f.store.reading.release();
    const before = (await f.store.load(f.record.id))!;
    await f.manager.onTurnStopping(f.agent, 10);
    await f.manager.onTurnStopping(f.agent, 10);
    assert.equal(f.steering.length, 1);
    assert.match(f.steering[0]!, /codex_workflow_review/);
    assert.match(f.steering[0]!, /turn-stopping-workflow/);
    assert.deepEqual(await f.store.load(f.record.id), before);
    f.assertNoModel();
  } finally { await f.close(); }
});

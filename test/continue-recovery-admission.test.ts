import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return { promise, started, entered, release };
}

const PLAN = "<proposed_plan>\n# Goal\nImplement health diagnostics without changing production data.\n# Changes\n- Add a read-only configuration and storage diagnostic.\n# Verification\n- Validate success, missing inputs and failure paths.\n# Risks\n- Avoid initializing databases while reading health state.\n</proposed_plan>";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-continue-admission-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const secondFailure = gate();
  const model = gate();
  let turns = 0;
  let threads = 0;
  let pins = 0;
  let endRounds = 0;
  let children = 0;
  let disposals = 0;
  let disposeCalls = 0;
  let recoverySignal: AbortSignal | undefined;
  let available = true;
  let stopSettled = false;
  const gateway: CodexGateway = {
    async startThread() { threads += 1; return "original-planner"; },
    async resumeThread() { throw new Error("retained Planner does not thread/resume"); },
    async startTurn(threadId, options, signal) {
      turns += 1;
      const turnId = `turn-${turns}`;
      await options.onStarted?.({ threadId, turnId });
      if (turns === 2) { secondFailure.entered(); await secondFailure.promise; }
      if (turns <= 2) return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
      recoverySignal = signal;
      if (!available) throw new Error("original thread is unavailable");
      model.entered();
      await model.promise;
      return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
    },
    async normalizeInFork(options) {
      return { kind: "completed", threadId: options.threadId, turnId: "conversion", status: "completed",
        text: JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
    },
    async continueTurn(): Promise<TurnWaitResult> { throw new Error("native clarification is outside this regression"); },
    async startReview(): Promise<never> { throw new Error("review is outside this regression"); },
    async interrupt() {}, async unsubscribeThread() {},
    isThreadAvailable: () => available,
    beginRound() { pins += 1; }, endRound() { pins -= 1; endRounds += 1; },
  };
  const session = Session.create(SessionId("owner"), [], { version: SESSION_FORMAT_VERSION, id: SessionId("owner"),
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = (id = "owner") => ({ agent: { id, session } as Agent, signal: new AbortController().signal,
    deferContext() {} } as unknown as ToolRunContext);
  const childFactory = { create: async () => {
    children += 1;
    let closed = false;
    return { id: `child-${children}`, session, beginContinuation() {}, failAttempt() {}, progress() {}, finish() {},
      async dispose() { disposeCalls += 1; if (!closed) { closed = true; disposals += 1; } },
    } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const tasks: Promise<unknown>[] = [];
  const start = manager.start({ task: "Plan health diagnostics" }, exec());
  tasks.push(start);
  await secondFailure.started;
  const record = (await store.list())[0]!;
  const wait = async () => { secondFailure.release(); return start; };
  const staleContinue = async (afterPark?: () => void) => {
    const loaded = gate();
    const releaseRead = gate();
    const load = store.load.bind(store);
    let held = false;
    store.load = async (id) => {
      const current = await load(id);
      if (!held && id === record.id) { held = true; loaded.entered(); await releaseRead.promise; }
      return current;
    };
    const continued = manager.continue(record.id, {}, exec());
    tasks.push(continued);
    const settled = Promise.allSettled([continued]);
    try {
      await loaded.started; // Facade has a genuine snapshot from before the model failed.
      await wait(); // Original run now parks its original handle in durable waiting state.
      afterPark?.();
    } finally {
      releaseRead.release();
      store.load = load;
    }
    return { continued, settled };
  };
  return { manager, store, exec, record, wait, staleContinue, model, tasks,
    setAvailable(value: boolean) { available = value; },
    get turns() { return turns; }, get threads() { return threads; }, get pins() { return pins; },
    get endRounds() { return endRounds; }, get children() { return children; }, get disposals() { return disposals; },
    get disposeCalls() { return disposeCalls; }, get recoverySignal() { return recoverySignal; },
    markStopSettled() { stopSettled = true; }, get stopSettled() { return stopSettled; },
    async close() { secondFailure.release(); model.release(); await Promise.allSettled(tasks); await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("two parked Planner continue calls share the Manager's one default recovery admission", async () => {
  const f = await fixture();
  try {
    await f.wait();
    const calls = [f.manager.continue(f.record.id, {}, f.exec()), f.manager.continue(f.record.id, {}, f.exec())];
    f.tasks.push(...calls);
    const settled = Promise.allSettled(calls);
    await f.model.started;
    f.model.release();
    const results = await settled;
    assert.ok(results.every((entry) => entry.status === "fulfilled"));
    assert.equal(f.turns, 3);
    assert.equal(f.threads, 1);
    assert.equal(f.children, 1);
    assert.equal(f.pins, 0);
    assert.equal(f.endRounds, 1);
  } finally { await f.close(); }
});

test("continue and default resume join the same parked Planner while a different instruction is refused", async () => {
  const f = await fixture();
  try {
    await f.wait();
    const continued = f.manager.continue(f.record.id, {}, f.exec());
    f.tasks.push(continued);
    await f.model.started;
    const resumed = f.manager.resume(f.record.id, undefined, f.exec());
    f.tasks.push(resumed);
    const settled = Promise.allSettled([continued, resumed]);
    await assert.rejects(f.manager.resume(f.record.id, "Different instruction", f.exec()), /different instruction/);
    f.model.release();
    assert.ok((await settled).every((entry) => entry.status === "fulfilled"));
    assert.equal(f.turns, 3);
    assert.equal(f.endRounds, 1);
  } finally { await f.close(); }
});

test("a pre-failure continue snapshot cannot bypass original-thread availability after the Planner parks", async () => {
  const f = await fixture();
  try {
    const { settled } = await f.staleContinue(() => { f.setAvailable(false); });
    const result = (await settled)[0]!;
    assert.equal(result.status, "rejected");
    assert.equal(f.turns, 2, "no recovery model call starts on an unavailable original thread");
    assert.equal(f.threads, 1);
    assert.equal(f.children, 1);
    assert.equal(f.pins, 1, "denied recovery leaves the original parked round for lifecycle cleanup");
    assert.equal((await f.store.load(f.record.id))?.processState, "waiting");
    await f.manager.stop();
    assert.equal(f.endRounds, 1);
    assert.equal(f.disposeCalls, 1);
    assert.equal(f.disposals, 1);
    assert.equal(f.pins, 0);
  } finally { await f.close(); }
});

test("a pre-failure continue snapshot shares lifecycle tracking so stop awaits the recovery turn", async () => {
  const f = await fixture();
  try {
    const { settled } = await f.staleContinue();
    await f.model.started;
    const stopped = f.manager.stop().then(() => { f.markStopSettled(); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.stopSettled, false, "stop must wait for the admitted original-thread continuation");
    assert.equal(f.recoverySignal?.aborted, true, "the alias must receive the Manager's lifecycle cancellation signal");
    f.model.release();
    await stopped;
    await settled;
    assert.equal(f.endRounds, 1);
    assert.equal(f.disposals, 1);
    assert.equal(f.disposeCalls, 1);
    assert.equal(f.pins, 0);
  } finally { await f.close(); }
});

test("another DSH session cannot continue or join the owning Planner recovery", async () => {
  const f = await fixture();
  try {
    await f.wait();
    await assert.rejects(f.manager.continue(f.record.id, {}, f.exec("other")), /another DSH session/);
    assert.equal(f.turns, 2);
    const continued = f.manager.continue(f.record.id, {}, f.exec());
    f.tasks.push(continued);
    await f.model.started;
    await assert.rejects(f.manager.continue(f.record.id, {}, f.exec("other")), /another DSH session/);
    f.model.release();
    await continued;
    assert.equal(f.turns, 3);
  } finally { await f.close(); }
});

test("cancel of a continued parked Planner remains terminal and releases the original resources once", async () => {
  const f = await fixture();
  try {
    await f.wait();
    const continued = f.manager.continue(f.record.id, {}, f.exec());
    f.tasks.push(continued);
    const settled = Promise.allSettled([continued]);
    await f.model.started;
    await f.manager.cancel(f.record.id, f.exec());
    f.model.release();
    await settled;
    assert.equal((await f.store.load(f.record.id))?.phase, "cancelled");
    assert.equal(f.endRounds, 1);
    assert.equal(f.disposals, 1);
    assert.equal(f.disposeCalls, 1);
    assert.equal(f.pins, 0);
  } finally { await f.close(); }
});

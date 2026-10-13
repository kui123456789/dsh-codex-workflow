import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const TASK = "ORIGINAL-TASK-SENTINEL: plan a local health diagnostic";
const PLAN = "<proposed_plan>\n# Goal\nAdd a local health diagnostic that preserves existing data.\n# Changes\n- Read configuration and inspect storage through read-only adapters.\n- Report unavailable inputs through a compact diagnostic result.\n# Verification\n- Verify valid, missing and invalid input paths in isolated storage.\n# Risks\n- Do not initialize or modify a database during inspection.\n</proposed_plan>";
type Stage = "native" | "conversion";
type Outcome = "ready" | "generic_failure" | "terminal_failure" | "needs_input" | "conversion_failure" | "short_reply";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture(stage: Stage, outcome: Outcome = "ready", controls: {
  holdAtTurn?: number;
  holdNativeAnswer?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-planner-run-ownership-"));
  await mkdir(join(directory, "new-workspace"));
  const store = new WorkflowStore(join(directory, "storage"));
  const pause = gate();
  const turns: Array<{ threadId: string; prompt: string; model?: string; effort?: string }> = [];
  const conversions: string[] = [];
  const continuations: string[] = [];
  const released: string[] = [];
  const disposed: string[] = [];
  const deferred: unknown[] = [];
  const nativeAnswers: string[] = [];
  const tasks: Promise<unknown>[] = [];
  let held = false;
  let threads = 0;
  let children = 0;
  let pins = 0;
  let ends = 0;
  const hold = async (at: Stage, eligible = true) => {
    if (at === stage && eligible && !held) { held = true; pause.enter(); await pause.promise; }
  };
  const gateway: CodexGateway = {
    async startThread() { threads += 1; return "original-planner"; },
    async resumeThread() { throw new Error("A retained Planner must not create or resume a replacement thread"); },
    async startTurn(threadId, options): Promise<TurnWaitResult> {
      turns.push({ threadId, prompt: options.prompt, model: options.model, effort: options.effort });
      const turnId = `visible-${turns.length}`;
      await options.onStarted?.({ threadId, turnId });
      await hold("native", !controls.holdNativeAnswer && turns.length === (controls.holdAtTurn ?? 1));
      if (outcome === "generic_failure" && turns.length <= 2) {
        return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
      }
      if (outcome === "terminal_failure") {
        return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "approval denied", error: "approval denied" };
      }
      if (outcome === "needs_input" && turns.length === 1) return { kind: "needs_input", threadId, turnId, request: {
        requestId: 1, threadId, turnId, itemId: "original-question", questions: [{ id: "scope", header: "Scope",
          question: "Which configuration should be inspected?", options: [], allowOther: true, secret: false }],
      } };
      if (outcome === "short_reply" && turns.length === 1) return { kind: "completed", threadId, turnId,
        status: "completed", text: "Acknowledged; the plan will follow." };
      return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
    },
    async normalizeInFork(options) {
      conversions.push(options.threadId);
      await options.onStarted?.({ threadId: options.threadId, turnId: "private-conversion" });
      await hold("conversion");
      if (outcome === "conversion_failure") return { kind: "completed", threadId: options.threadId,
        turnId: "private-conversion", status: "failed", text: "", reason: "schema conversion failed" };
      return { kind: "completed", threadId: options.threadId, turnId: "private-conversion", status: "completed",
        text: JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
    },
    async continueTurn(pending) {
      nativeAnswers.push(pending.threadId);
      await hold("native", Boolean(controls.holdNativeAnswer));
      return { kind: "completed", threadId: pending.threadId, turnId: pending.turnId, status: "completed", text: PLAN };
    },
    async startReview(): Promise<never> { throw new Error("Review is outside this ownership audit"); },
    async interrupt() {},
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const owner = SessionId("planner-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = { agent: { id: owner, session }, signal: new AbortController().signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext;
  const childFactory = { async create() {
    const id = `planner-child-${++children}`;
    return { id, session, beginContinuation(prompt) { continuations.push(prompt); }, failAttempt() {}, pauseForInput() {},
      progress() {}, finish() {}, async dispose() { disposed.push(id); } } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "default-model", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const start = () => track(manager.start({ task: TASK, plannerModel: "model-A", plannerEffort: "low" }, exec));
  const assertCleanup = () => {
    assert.equal(threads, 1);
    assert.equal(children, 1);
    assert.equal(pins, 0);
    assert.equal(ends, 1);
    assert.deepEqual(disposed, ["planner-child-1"]);
    assert.deepEqual(released, ["original-planner"]);
    assert.equal(runtime.pending.size, 0);
    assert.equal(runtime.plannerInputs.size, 0);
    assert.equal(runtime.recoverableRuns.size, 0);
  };
  const assertUnchanged = async (expected: WorkflowRecord) => {
    assert.deepEqual(await store.load(expected.id), expected, "A displaced Planner must not overwrite the current workflow record");
    assert.deepEqual(deferred, [], "A displaced Planner must not publish a plan to the old owner");
  };
  return { directory, store, manager, exec, session, runtime, pause, start, track, turns, conversions, continuations, deferred, nativeAnswers,
    assertCleanup, assertUnchanged,
    get pins() { return pins; },
    get disposed() { return [...disposed]; },
    async record() { const record = (await store.list())[0]; assert.ok(record); return record; },
    async close() { pause.release(); await Promise.allSettled(tasks); await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const stage of ["native", "conversion"] as const) {
  for (const drift of ["owner", "phase", "cwd"] as const) {
    test(`Planner ${stage} late completion cannot overwrite a changed ${drift}`, async () => {
      const f = await fixture(stage);
      try {
        const pending = f.start();
        const settled = Promise.allSettled([pending]);
        await f.pause.entered;
        const original = await f.record();
        const changed = await f.store.update(original.id, (record) => {
          if (drift === "owner") record.dshSessionId = "new-owner";
          if (drift === "phase") record.phase = "passed";
          if (drift === "cwd") record.cwd = join(f.directory, "new-workspace");
        });
        f.pause.release();
        await settled;
        await f.assertUnchanged(changed.record);
        assert.equal(f.turns.length, 1, "No continuation may be added after the original run loses authority");
        assert.deepEqual(f.continuations, []);
        f.assertCleanup();
      } finally { await f.close(); }
    });
  }
}

for (const outcome of ["generic_failure", "terminal_failure", "needs_input"] as const) {
  test(`late Planner ${outcome} cannot mutate a foreign-owned record or park its session`, async () => {
    const f = await fixture("native", outcome);
    try {
      const pending = f.start();
      const settled = Promise.allSettled([pending]);
      await f.pause.entered;
      const original = await f.record();
      const changed = await f.store.update(original.id, (record) => { record.dshSessionId = "new-owner"; });
      f.pause.release();
      await settled;
      await f.assertUnchanged(changed.record);
      assert.equal(f.turns.length, 1, "A foreign owner must not receive automatic Planner continuation calls");
      assert.deepEqual(f.continuations, []);
      assert.deepEqual(f.conversions, []);
      f.assertCleanup();
    } finally { await f.close(); }
  });
}

test("same-owner Planner failures still recover atomically in the original child and thread", async () => {
  const f = await fixture("native", "generic_failure");
  try {
    const pending = f.start();
    await f.pause.entered;
    f.pause.release();
    const waiting = await pending;
    assert.equal(waiting.dshSessionId, "planner-owner");
    assert.equal(waiting.processState, "waiting");
    assert.equal(waiting.phase, "planning");
    assert.equal(f.turns.length, 2);
    const original = f.runtime.recoverableRuns.get(waiting.id);
    assert.ok(original);
    assert.equal(original.threadId, "original-planner");
    assert.equal(original.child?.id, "planner-child-1");
    const completed = await f.track(f.manager.resume(waiting.id, undefined, f.exec));
    assert.equal(completed.id, waiting.id);
    assert.equal(completed.dshSessionId, waiting.dshSessionId);
    assert.equal(completed.phase, "executing");
    assert.equal(completed.plannerModel, "model-A");
    assert.equal(completed.plannerEffort, "low");
    assert.equal(f.turns.length, 3);
    assert.ok(f.turns.every((turn) => turn.threadId === original.threadId && turn.model === "model-A" && turn.effort === "low"));
    assert.ok(f.turns.slice(1).every((turn) => !turn.prompt.includes(TASK)));
    assert.equal(f.deferred.length, 1, "Only the accepted original plan is injected");
    f.assertCleanup();
  } finally { await f.close(); }
});

test("a late Planner conversion failure cannot mark a foreign-owned record failed", async () => {
  const f = await fixture("conversion", "conversion_failure");
  try {
    const pending = f.start();
    const settled = Promise.allSettled([pending]);
    await f.pause.entered;
    const original = await f.record();
    const changed = await f.store.update(original.id, (record) => { record.dshSessionId = "new-owner"; });
    f.pause.release();
    await settled;
    await f.assertUnchanged(changed.record);
    assert.equal(f.turns.length, 1);
    assert.equal(f.conversions.length, 1);
    f.assertCleanup();
  } finally { await f.close(); }
});

for (const drift of ["phase", "cwd"] as const) {
  test(`same-owner Planner generic failure after ${drift} drift cannot continue or park an obsolete run`, async () => {
    const f = await fixture("native", "generic_failure");
    try {
      const pending = f.start();
      const settled = Promise.allSettled([pending]);
      await f.pause.entered;
      const original = await f.record();
      const changed = await f.store.update(original.id, (record) => {
        if (drift === "phase") record.phase = "passed";
        else record.cwd = join(f.directory, "new-workspace");
      });
      f.pause.release();
      await settled;
      await f.assertUnchanged(changed.record);
      assert.equal(f.turns.length, 1);
      assert.deepEqual(f.continuations, []);
      f.assertCleanup();
    } finally { await f.close(); }
  });
}

for (const entry of ["resume", "continue"] as const) {
  test(`active Planner ${entry} cannot apply its late completion after ownership changes`, async () => {
    const f = await fixture("native", entry === "resume" ? "generic_failure" : "needs_input",
      entry === "resume" ? { holdAtTurn: 3 } : { holdNativeAnswer: true });
    try {
      const waiting = await f.start();
      assert.equal(waiting.phase, entry === "resume" ? "planning" : "waiting_input");
      const originalTurns = f.turns.length;
      const pending = f.track(entry === "resume" ? f.manager.resume(waiting.id, undefined, f.exec)
        : f.manager.continue(waiting.id, { scope: ["Local profile"] }, f.exec));
      const settled = Promise.allSettled([pending]);
      await f.pause.entered;
      const changed = await f.store.update(waiting.id, (record) => { record.dshSessionId = "new-owner"; });
      f.pause.release();
      await settled;
      await f.assertUnchanged(changed.record);
      assert.equal(f.turns.length, originalTurns + (entry === "resume" ? 1 : 0));
      assert.equal(f.nativeAnswers.length, entry === "continue" ? 1 : 0);
      assert.deepEqual(f.conversions, [], "A displaced answer or resume must not launch conversion");
      f.assertCleanup();
    } finally { await f.close(); }
  });
}

for (const drift of ["cwd", "task"] as const) {
  test(`waiting Planner resume preserves the original handle when its ${drift} no longer matches the retained thread`, async () => {
    const f = await fixture("native", "generic_failure", { holdAtTurn: 3 });
    try {
      const waiting = await f.start();
      const retained = f.runtime.recoverableRuns.get(waiting.id);
      assert.ok(retained);
      assert.equal(f.pins, 1);
      const changed = await f.store.update(waiting.id, (record) => {
        if (drift === "cwd") record.cwd = join(f.directory, "new-workspace");
        else record.task = "A DIFFERENT TASK";
      });
      const rejected = f.track(f.manager.resume(waiting.id, undefined, f.exec));
      const settled = Promise.allSettled([rejected]);
      // A wrong implementation enters another model call. Release that call
      // to obtain a deterministic failure instead of leaving the test hung.
      f.pause.release();
      const outcome = (await settled)[0]!;
      assert.equal(outcome.status, "rejected");
      assert.equal(f.turns.length, 2, "A stored record's new scope cannot re-authorize the old retained thread");
      assert.equal(f.runtime.recoverableRuns.get(waiting.id), retained, "Rejected scope drift must not consume the original handle");
      assert.equal(f.pins, 1);
      assert.deepEqual(f.disposed, []);
      await f.assertUnchanged(changed.record);
    } finally { await f.close(); }
  });
}

test("waiting native clarification keeps its original request when the persisted task changes", async () => {
  const f = await fixture("native", "needs_input", { holdNativeAnswer: true });
  try {
    const waiting = await f.start();
    const retained = f.runtime.plannerInputs.get(waiting.id);
    const originalPending = f.runtime.pending.get(waiting.id);
    assert.ok(retained);
    assert.ok(originalPending);
    const changed = await f.store.update(waiting.id, (record) => { record.task = "A DIFFERENT TASK"; });
    const answering = f.track(f.manager.continue(waiting.id, { scope: ["Local profile"] }, f.exec));
    const settled = Promise.allSettled([answering]);
    f.pause.release();
    assert.equal((await settled)[0]!.status, "rejected");
    assert.equal(f.nativeAnswers.length, 0);
    assert.equal(f.runtime.plannerInputs.get(waiting.id), retained);
    assert.equal(f.runtime.pending.get(waiting.id), originalPending);
    assert.equal(f.pins, 1);
    assert.deepEqual(f.disposed, []);
    await f.assertUnchanged(changed.record);
  } finally { await f.close(); }
});

test("controlled Planner completion checks authority again after conversion's final record read", async () => {
  const f = await fixture("native", "short_reply");
  const internal = f.manager as unknown as {
    currentPlannerRun(expected: unknown, exec: ToolRunContext): Promise<WorkflowRecord>;
  };
  const original = internal.currentPlannerRun.bind(f.manager);
  let changed: WorkflowRecord | undefined;
  internal.currentPlannerRun = async (...args) => {
    const observed = await original(...args);
    if (f.conversions.length === 1 && !changed) {
      // The conversion did read the real current record. Another writer then
      // changes ownership before that asynchronous snapshot is returned to
      // the controlled-completion branch: it must recheck before model I/O.
      changed = (await f.store.update(observed.id, (record) => { record.dshSessionId = "new-owner"; })).record;
    }
    return observed;
  };
  try {
    f.pause.release();
    const [outcome] = await Promise.allSettled([f.start()]);
    assert.ok(changed, "The real post-conversion snapshot was displaced by another owner");
    assert.equal(outcome!.status, "rejected");
    assert.equal(f.turns.length, 1, "A controlled completion must check authority before its second model call");
    assert.equal(f.conversions.length, 1);
    assert.deepEqual(f.continuations, []);
    await f.assertUnchanged(changed);
    f.assertCleanup();
  } finally {
    internal.currentPlannerRun = original;
    await f.close();
  }
});

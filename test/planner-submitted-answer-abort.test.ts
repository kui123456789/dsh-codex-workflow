import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnNeedsInputResult, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const TASK = "ORIGINAL-TASK-SENTINEL: plan read-only configuration diagnostics";
const ANSWERS = { scope: ["ANSWER-SENTINEL: inspect the current local profile"] };
const PLAN = "<proposed_plan>\n# Goal\nDiagnose local configuration without changing user data.\n# Changes\n- Add a read-only validation command and report unavailable values.\n- Preserve existing settings and storage.\n# Verification\n- Check valid, missing and invalid configurations in isolated storage.\n# Risks\n- Never initialize a database during inspection.\n</proposed_plan>";
type Interruption = "held" | "failed" | "confirmed";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture(initialInterruption: Interruption) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-submitted-answer-abort-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const controller = new AbortController();
  const submitted = gate();
  const interruptionStarted = gate();
  const explicitCleanup = gate();
  const interruptionAck = gate();
  const nativeAnswers: Array<{ pending: TurnNeedsInputResult; answers: Record<string, string[]> }> = [];
  const interrupts: Array<{ threadId: string; turnId: string; callerAborted: boolean }> = [];
  const startRequests: Array<{ threadId: string; prompt: string; model?: string; effort?: string }> = [];
  const released: string[] = [];
  const deferred: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  const sdkCleanup: Promise<unknown>[] = [];
  let interruption = initialInterruption;
  let originalPending: TurnNeedsInputResult;
  let remoteActive = false;
  let nativeInputOutstanding = false;
  let writerConflicts = 0;
  let threads = 0;
  let children = 0;
  let disposals = 0;
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let nextInterruption: ReturnType<typeof gate> | undefined;
  const gateway: CodexGateway = {
    async startThread() { threads += 1; return "original-planner"; },
    async resumeThread() { throw new Error("The original ephemeral Planner must not be replaced"); },
    async startTurn(threadId, options) {
      startRequests.push({ threadId, prompt: options.prompt, model: options.model, effort: options.effort });
      if (remoteActive) {
        writerConflicts += 1;
        throw new Error("thread-store conflict: original-planner already has an active writer");
      }
      const turnId = `original-turn-${startRequests.length}`;
      await options.onStarted?.({ threadId, turnId });
      if (startRequests.length > 1) return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
      remoteActive = true;
      nativeInputOutstanding = true;
      originalPending = { kind: "needs_input", threadId, turnId, request: {
        requestId: 1, threadId, turnId, itemId: "original-native-question", questions: [{ id: "scope", header: "Scope",
          question: "Which local profile should be inspected?", options: [], allowOther: true, secret: false }],
      } };
      return originalPending;
    },
    async continueTurn(pending, answers, signal) {
      assert.equal(pending, originalPending);
      assert.equal(nativeInputOutstanding, true, "An already submitted native answer must never be sent again");
      nativeAnswers.push({ pending, answers });
      nativeInputOutstanding = false; // The original request RPC has been answered.
      submitted.enter();
      return new Promise<TurnWaitResult>((_resolve, reject) => {
        // Match the installed App Server client's abort behavior: it launches
        // abandonTurn without awaiting the interrupt acknowledgement, then
        // rejects the caller's waiter while the remote writer can remain active.
        const onAbort = () => {
          const cleanup = gateway.interrupt(pending.threadId, pending.turnId);
          sdkCleanup.push(cleanup);
          void cleanup.catch(() => undefined);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    async normalizeInFork(options) {
      return { kind: "completed", threadId: options.threadId, turnId: "conversion", status: "completed",
        text: JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
    },
    async startReview(): Promise<never> { throw new Error("No Reviewer is part of this recovery"); },
    async interrupt(threadId, turnId, signal) {
      interrupts.push({ threadId, turnId, callerAborted: signal?.aborted ?? false });
      nextInterruption?.enter();
      nextInterruption = undefined;
      interruptionStarted.enter();
      if (interrupts.length >= 2) explicitCleanup.enter();
      if (interruption === "held") await interruptionAck.promise;
      if (interruption === "failed") throw new Error("Original submitted turn interruption is unconfirmed");
      remoteActive = false;
    },
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; begins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const owner = SessionId("submitted-answer-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = (signal = new AbortController().signal) => ({ agent: { id: owner, session }, signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext);
  const childFactory = { async create() {
    children += 1;
    return { id: "original-child", session, beginContinuation() {}, pauseForInput() {}, failAttempt() {}, progress() {}, finish() {},
      async dispose() { disposals += 1; } } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const assertCompleted = () => {
    assert.equal(writerConflicts, 0);
    assert.equal(threads, 1);
    assert.equal(children, 1);
    assert.equal(disposals, 1);
    assert.equal(begins, 1);
    assert.equal(ends, 1);
    assert.equal(pins, 0);
    assert.deepEqual(released, ["original-planner"]);
    assert.equal(nativeAnswers.length, 1);
    assert.ok(startRequests.every((request) => request.threadId === "original-planner" && request.model === "model-A" && request.effort === "low"));
    assert.equal(startRequests.length, 2);
    assert.ok(startRequests[1]?.prompt.includes(ANSWERS.scope[0]!));
    assert.equal(startRequests[1]?.prompt.includes(TASK), false);
    assert.equal(deferred.length, 1);
  };
  const assertNoNewWriter = () => {
    assert.equal(writerConflicts, 0);
    assert.equal(startRequests.length, 1);
    assert.equal(nativeAnswers.length, 1);
    assert.equal(nativeInputOutstanding, false);
    assert.equal(deferred.length, 0);
    assert.ok(startRequests.every((request) => request.threadId === "original-planner" && request.model === "model-A" && request.effort === "low"));
  };
  const assertCleanupWithoutModel = () => {
    assertNoNewWriter();
    assert.equal(threads, 1);
    assert.equal(children, 1);
    assert.equal(disposals, 1);
    assert.equal(pins, 0);
    assert.equal(begins, 1);
    assert.equal(ends, 1);
    assert.deepEqual(released, ["original-planner"]);
    assert.equal(runtime.pending.size, 0);
    assert.equal(runtime.plannerInputs.size, 0);
    assert.equal(runtime.recoverableRuns.size, 0);
    assert.equal(runtime.codexChildSessions.size, 0);
  };
  return { manager, store, exec, controller, submitted, interruptionStarted, explicitCleanup, interruptionAck, nativeAnswers,
    interrupts, startRequests, runtime, track, assertCompleted, assertNoNewWriter, assertCleanupWithoutModel,
    watchNextInterruption() { const probe = gate(); nextInterruption = probe; return probe; },
    setInterruption(value: Interruption) { interruption = value; },
    get remoteActive() { return remoteActive; }, get nativeInputOutstanding() { return nativeInputOutstanding; },
    get writerConflicts() { return writerConflicts; },
    get pins() { return pins; }, get disposals() { return disposals; },
    async start() {
      const record = await manager.start({ task: TASK }, exec());
      assert.equal(record.phase, "waiting_input");
      return record;
    },
    async answer(id: string) {
      const answering = track(manager.continue(id, ANSWERS, exec(controller.signal)));
      await submitted.entered;
      controller.abort(new Error("operation aborted"));
      await interruptionStarted.entered;
      return { answering };
    },
    async close() {
      controller.abort(new Error("operation aborted"));
      interruption = "confirmed";
      interruptionAck.release();
      await Promise.allSettled([...tasks, ...sdkCleanup]);
      await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

test("submitted native answer abort waits for original-turn interruption before offering a fresh same-thread turn", async () => {
  const f = await fixture("held");
  try {
    const initial = await f.start();
    const { answering } = await f.answer(initial.id);
    const boundary = await Promise.race([
      f.explicitCleanup.entered.then(() => "cleanup"),
      answering.then(() => "reported"),
    ]);
    assert.equal(boundary, "cleanup", "The caller must not advertise a safe continuation while its submitted original writer is still active");
    assert.equal(f.remoteActive, true);
    assert.equal(f.nativeInputOutstanding, false);
    assert.equal((await f.manager.status(initial.id, f.exec())).continuation?.available, false);
    assert.equal(f.startRequests.length, 1);
    f.interruptionAck.release();
    const waiting = await answering;
    assert.equal(waiting.processState, "waiting");
    assert.equal(f.remoteActive, false);
    const resumed = await f.manager.resume(initial.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    assert.equal(resumed.id, initial.id);
    assert.deepEqual(f.nativeAnswers[0]?.answers, ANSWERS);
    f.assertCompleted();
  } finally { await f.close(); }
});

test("unconfirmed interruption of submitted native answers blocks model turns and never restores the answered request", async () => {
  const f = await fixture("failed");
  try {
    const initial = await f.start();
    const { answering } = await f.answer(initial.id);
    const waiting = await answering;
    assert.equal(waiting.phase, "planning");
    assert.equal(waiting.processState, "waiting");
    assert.equal(f.nativeInputOutstanding, false);
    assert.equal(f.remoteActive, true);
    assert.equal(f.runtime.pending.size, 0, "The submitted question must never be restored as unanswered");
    assert.equal(f.runtime.plannerInputs.size, 0);
    const status = await f.manager.status(initial.id, f.exec());
    await Promise.allSettled([f.manager.resume(initial.id, undefined, f.exec())]);
    assert.deepEqual({ continuation: status.continuation, writerConflicts: f.writerConflicts,
      sdkStartRequests: f.startRequests.length, nativeReplies: f.nativeAnswers.length }, {
      continuation: { available: false, reason: "interruption_unconfirmed" }, writerConflicts: 0, sdkStartRequests: 1, nativeReplies: 1,
    }, "Manual resume must retry cleanup before starting another writer or repeating the submitted answer");
    f.setInterruption("confirmed");
    const resumed = await f.manager.resume(initial.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    assert.ok(f.interrupts.every((entry) => entry.threadId === "original-planner" && entry.turnId === "original-turn-1" && !entry.callerAborted));
    f.assertCompleted();
  } finally { await f.close(); }
});

test("confirmed submitted-answer interruption resumes the same original settings without another native reply", async () => {
  const f = await fixture("confirmed");
  try {
    const initial = await f.start();
    const { answering } = await f.answer(initial.id);
    const waiting = await answering;
    assert.equal(waiting.processState, "waiting");
    assert.equal(f.remoteActive, false);
    assert.equal(f.nativeInputOutstanding, false);
    assert.deepEqual((await f.manager.status(initial.id, f.exec())).continuation, { available: true });
    const resumed = await f.manager.resume(initial.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    assert.equal(resumed.plannerModel, "model-A");
    assert.equal(resumed.plannerEffort, "low");
    f.assertCompleted();
  } finally { await f.close(); }
});

for (const action of ["cancel", "stop"] as const) {
  test(`${action} while the first submitted-answer interruption awaits acknowledgement cannot restore or run the Planner`, async () => {
    const f = await fixture("held");
    try {
      const initial = await f.start();
      const { answering } = await f.answer(initial.id);
      const answered = Promise.allSettled([answering]);
      await f.explicitCleanup.entered;
      const stoppingTurn = f.watchNextInterruption();
      let stopped = false;
      const ending = f.track<unknown>(action === "cancel" ? f.manager.cancel(initial.id, f.exec())
        : f.manager.stop().then(() => { stopped = true; }));
      await stoppingTurn.entered;
      assert.equal(f.remoteActive, true);
      f.assertNoNewWriter();
      if (action === "cancel") assert.equal((await f.store.load(initial.id))?.phase, "cancelled");
      else assert.equal(stopped, false, "Stop must await the in-flight original-turn cleanup");
      f.interruptionAck.release();
      await Promise.all([answered, ending]);
      if (action === "cancel") assert.equal((await f.store.load(initial.id))?.phase, "cancelled");
      else assert.equal(stopped, true);
      f.assertCleanupWithoutModel();
      await f.manager.stop();
      f.assertCleanupWithoutModel();
    } finally { await f.close(); }
  });
}

for (const drift of ["owner", "handle", "cancel"] as const) {
  test(`manual cleanup of an answered native turn cannot claim a ${drift}-changed recovery`, async () => {
    const f = await fixture("failed");
    try {
      const initial = await f.start();
      const { answering } = await f.answer(initial.id);
      await answering;
      const original = f.runtime.recoverableRuns.get(initial.id);
      assert.ok(original);
      assert.equal(original.interruptionTurnId, "original-turn-1");
      f.setInterruption("held");
      const enteringCleanup = f.watchNextInterruption();
      const resume = f.track(f.manager.resume(initial.id, undefined, f.exec()));
      const resumed = Promise.allSettled([resume]);
      await enteringCleanup.entered;
      assert.equal(f.remoteActive, true);
      assert.equal(f.runtime.recoverableRuns.get(initial.id), original, "Cleanup must run before claiming the retained handle");
      let replacement = original;
      let ending: Promise<unknown> | undefined;
      let changedRecord: WorkflowRecord | undefined;
      if (drift === "owner") changedRecord = (await f.store.update(initial.id, (record) => { record.dshSessionId = "new-owner"; })).record;
      if (drift === "handle") {
        replacement = { ...original, state: { ...original.state } };
        f.runtime.recoverableRuns.set(initial.id, replacement);
      }
      if (drift === "cancel") {
        const cancellingTurn = f.watchNextInterruption();
        ending = f.track(f.manager.cancel(initial.id, f.exec()));
        await cancellingTurn.entered;
        assert.equal(f.runtime.recoverableRuns.has(initial.id), false);
      }
      f.assertNoNewWriter();
      f.interruptionAck.release();
      const outcome = (await resumed)[0]!;
      if (ending) await ending;
      f.assertNoNewWriter();
      if (drift === "cancel") {
        assert.equal((await f.store.load(initial.id))?.phase, "cancelled");
        f.assertCleanupWithoutModel();
      } else {
        assert.equal(outcome.status, "rejected");
        assert.equal(f.runtime.recoverableRuns.get(initial.id), replacement, "The stale cleanup cannot consume another run's handle");
        assert.equal(replacement.interruptionTurnId, "original-turn-1");
        assert.equal(f.pins, 1);
        assert.equal(f.disposals, 0);
        if (changedRecord) assert.deepEqual(await f.store.load(initial.id), changedRecord, "A stale cleanup must not modify a foreign owner's record");
      }
      await f.close();
      f.assertCleanupWithoutModel();
    } finally { await f.close(); }
  });
}

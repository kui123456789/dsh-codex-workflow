import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const ANSWERS = { scope: ["Inspect local configuration"] };
const PLAN = "<proposed_plan>\n# Goal\nDiagnose local configuration without changing user data.\n# Changes\n- Add a read-only validation command.\n- Preserve existing settings and report unavailable values.\n# Verification\n- Check valid, missing and invalid configurations.\n# Risks\n- Do not initialize storage during inspection.\n</proposed_plan>";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { enter, release, entered, promise };
}

async function fixture(interruption: "success" | "failure" | "held") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-native-input-abort-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const startingCommit = gate();
  const interruptGate = gate();
  const controller = new AbortController();
  const activeTasks: Promise<unknown>[] = [];
  const releases: string[] = [];
  const interrupts: Array<{ threadId: string; turnId: string; callerSignalAborted: boolean }> = [];
  const turnPrompts: string[] = [];
  const continuations: string[] = [];
  const nativeAnswers: Array<Record<string, string[]>> = [];
  let nativeInputOutstanding = false;
  let writerConflicts = 0;
  let threadStarts = 0;
  let childStarts = 0;
  let rawDisposals = 0;
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let delayed = false;
  const owner = SessionId(`native-input-abort-${interruption}`);
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = (signal = new AbortController().signal) => ({ agent: { id: owner, session } as Agent,
    signal, deferContext() {} } as unknown as ToolRunContext);
  const complete = (threadId: string, turnId: string): TurnWaitResult => ({
    kind: "completed", threadId, turnId, status: "completed", text: PLAN,
  });
  const gateway: CodexGateway = {
    async startThread() { threadStarts += 1; return "original-planner"; },
    async resumeThread() { throw new Error("An ephemeral Planner must not be recreated"); },
    async startTurn(threadId, options) {
      if (nativeInputOutstanding) {
        writerConflicts += 1;
        throw new Error("thread-store conflict: thread original-planner already has an active writer");
      }
      turnPrompts.push(options.prompt);
      const turnId = `original-turn-${turnPrompts.length}`;
      await options.onStarted?.({ threadId, turnId });
      if (turnPrompts.length > 1) return complete(threadId, turnId);
      nativeInputOutstanding = true;
      return { kind: "needs_input", threadId, turnId, request: {
        requestId: 1, threadId, turnId, itemId: "original-input", questions: [{
          id: "scope", header: "Scope", question: "Which configuration should the plan inspect?",
          options: [], allowOther: true, secret: false,
        }],
      } };
    },
    async continueTurn(pending, answers) {
      assert.equal(nativeInputOutstanding, true, "the original unanswered request is still active");
      nativeAnswers.push(answers);
      nativeInputOutstanding = false;
      return complete(pending.threadId, pending.turnId);
    },
    async normalizeInFork(options) {
      return { kind: "completed", threadId: options.threadId, turnId: "conversion-turn", status: "completed",
        text: JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
    },
    async startReview(): Promise<never> { throw new Error("No Reviewer should be started"); },
    async interrupt(threadId, turnId, signal) {
      interrupts.push({ threadId, turnId, callerSignalAborted: signal?.aborted ?? false });
      if (interrupts.length === 1 && interruption === "held") {
        interruptGate.enter();
        await interruptGate.promise;
      }
      if (interruption === "failure") throw new Error("original Planner interruption was not confirmed");
      signal?.throwIfAborted();
      nativeInputOutstanding = false;
    },
    async unsubscribeThread(threadId) { releases.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { begins += 1; pins += 1; },
    endRound() { ends += 1; pins -= 1; },
  };
  const childFactory = { create: async () => {
    childStarts += 1;
    return { id: "original-child", session,
      beginContinuation(prompt: string) { continuations.push(prompt); },
      pauseForInput() {}, failAttempt() {}, progress() {}, finish() {},
      async dispose() { rawDisposals += 1; },
    } as CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "planner-model", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config,
    undefined, undefined, undefined, {}, undefined, childFactory);
  const update = store.update.bind(store);
  store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, opts?: Parameters<typeof update>[2]) => {
    if (!delayed && mutate.toString().includes("return mutate")) {
      const prior = await store.load(id);
      if (prior) {
        // The ownership fence wraps Planner record-only mutations. Probe a
        // copy to identify the starting commit without gateway/model effects.
        // Usage-observer callbacks are excluded because they own live counters.
        const candidate = structuredClone(prior);
        mutate(candidate);
        if (prior.phase === "waiting_input" && candidate.phase === "planning" && candidate.processState === "running") {
          delayed = true;
          startingCommit.enter();
          await startingCommit.promise;
        }
      }
    }
    return update<T>(id, mutate, opts);
  };
  const track = <T>(task: Promise<T>) => { activeTasks.push(task); void task.catch(() => undefined); return task; };
  const snapshot = () => ({ threadStarts, childStarts, rawDisposals, pins, begins, ends, releases: [...releases] });
  const assertRetained = () => assert.deepEqual(snapshot(), {
    threadStarts: 1, childStarts: 1, rawDisposals: 0, pins: 1, begins: 1, ends: 0, releases: [],
  });
  const assertCleaned = () => assert.deepEqual(snapshot(), {
    threadStarts: 1, childStarts: 1, rawDisposals: 1, pins: 0, begins: 1, ends: 1, releases: ["original-planner"],
  });
  return { manager, store, exec, controller, startingCommit, interruptGate, interrupts, turnPrompts, nativeAnswers,
    continuations, track, snapshot, assertRetained, assertCleaned,
    get nativeInputOutstanding() { return nativeInputOutstanding; },
    get writerConflicts() { return writerConflicts; },
    async start() {
      const initial = await manager.start({ task: "ORIGINAL-TASK: plan a local configuration diagnostic" }, exec());
      assert.equal(initial.phase, "waiting_input");
      return initial;
    },
    async abortBeforeRpc(id: string) {
      const answering = track(manager.continue(id, ANSWERS, exec(controller.signal)));
      await Promise.race([startingCommit.entered, answering.then(() => {
        throw new Error("Answer settled before the pre-RPC barrier");
      })]);
      controller.abort(new Error("operation aborted"));
      startingCommit.release();
      return { answering };
    },
    async close() {
      startingCommit.release();
      interruptGate.release();
      await Promise.allSettled(activeTasks);
      await manager.stop();
      store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test("unsubmitted native answers interrupt the original request before parking for same-thread recovery", async () => {
  const f = await fixture("success");
  try {
    const initial = await f.start();
    const { answering } = await f.abortBeforeRpc(initial.id);
    const parked = await answering;
    assert.equal(parked.phase, "planning");
    assert.equal(parked.processState, "waiting");
    assert.equal(f.nativeAnswers.length, 0);
    assert.deepEqual(f.interrupts, [{ threadId: "original-planner", turnId: "original-turn-1", callerSignalAborted: false }]);
    assert.equal(f.nativeInputOutstanding, false);
    f.assertRetained();
    const resumed = await f.manager.resume(initial.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    assert.equal(resumed.id, initial.id);
    assert.equal(resumed.planMarkdown, PLAN);
    assert.equal(f.writerConflicts, 0);
    assert.equal(f.turnPrompts.length, 2);
    assert.ok(f.turnPrompts[1]?.includes(ANSWERS.scope[0]!));
    assert.ok(!f.turnPrompts[1]?.includes("ORIGINAL-TASK"));
    f.assertCleaned();
  } finally { await f.close(); }
});

test("unconfirmed interruption restores the same native request without offering new-turn recovery", async () => {
  const f = await fixture("failure");
  try {
    const initial = await f.start();
    const { answering } = await f.abortBeforeRpc(initial.id);
    const waiting = await answering;
    assert.equal(waiting.phase, "waiting_input");
    assert.deepEqual(waiting.pendingInput, initial.pendingInput);
    assert.deepEqual(waiting.questions, initial.questions);
    assert.equal(waiting.retryState, undefined);
    assert.ok(waiting.error, "an unconfirmed interruption must expose its diagnostic");
    assert.equal(f.nativeInputOutstanding, true);
    assert.equal(f.nativeAnswers.length, 0);
    assert.equal(f.turnPrompts.length, 1);
    f.assertRetained();
    await assert.rejects(f.manager.resume(initial.id, undefined, f.exec()), /no in-process continuation|not.*waiting|original input/i);
    assert.equal(f.writerConflicts, 0);
    assert.equal(f.turnPrompts.length, 1);
    const planned = await f.manager.continue(initial.id, ANSWERS, f.exec());
    assert.equal(planned.phase, "executing");
    assert.deepEqual(f.nativeAnswers, [ANSWERS]);
    assert.equal(f.writerConflicts, 0);
    f.assertCleaned();
  } finally { await f.close(); }
});

for (const action of ["cancel", "stop"] as const) test(`${action} winning during native interruption cannot restore waiting resources`, async () => {
  const f = await fixture("held");
  try {
    const initial = await f.start();
    const { answering } = await f.abortBeforeRpc(initial.id);
    await Promise.race([f.interruptGate.entered, answering.then(() => {
      throw new Error("Answer parked before interrupting the original native request");
    })]);
    let stopping: Promise<void> | undefined;
    let stopped = false;
    if (action === "cancel") await f.manager.cancel(initial.id, f.exec());
    else {
      stopping = f.track(f.manager.stop().then(() => { stopped = true; }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopped, false, "stop awaits the interruption and owning answer operation");
    }
    f.interruptGate.release();
    await answering;
    if (stopping) await stopping;
    if (action === "cancel") assert.equal((await f.store.load(initial.id))?.phase, "cancelled");
    else await assert.rejects(f.manager.continue(initial.id, ANSWERS, f.exec()), /stopped/);
    assert.equal(f.nativeAnswers.length, 0);
    assert.equal(f.turnPrompts.length, 1);
    assert.equal(f.writerConflicts, 0);
    f.assertCleaned();
    await f.manager.stop();
    f.assertCleaned();
  } finally { await f.close(); }
});

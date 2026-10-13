import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { PlannerQuestion, TurnNeedsInputResult, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const TASK = "ORIGINAL-TASK-SENTINEL: plan a scoped configuration diagnostic";
const ANSWERS = { scope: ["ANSWER-SENTINEL: local configuration only"] };
const QUESTION: PlannerQuestion = { id: "scope", header: "Scope", question: "Which scope should the plan cover?",
  options: [], allowOther: true, secret: false };
const SECOND_QUESTION: PlannerQuestion = { id: "location", header: "Location", question: "Which local configuration should be inspected?",
  options: [], allowOther: true, secret: false };
const PLAN = "<proposed_plan>\n# Goal\nDiagnose local configuration without changing user data.\n# Changes\n- Add a read-only configuration validation command.\n- Preserve existing state and report unavailable settings.\n# Verification\n- Check valid, missing and invalid configurations.\n# Risks\n- Do not initialize storage while inspecting configuration.\n</proposed_plan>";

type InputMode = "native" | "converted";
type AnswerOutcome = "success" | "generic_fail" | "abort";
const UNRECOVERABLE_INPUT = /unavailable|no .*session|cannot recover|not loaded|original|in-process|handle/i;

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { enter = resolve; });
  return { promise, started, enter, release };
}

async function fixture(mode: InputMode, answerOutcome: AnswerOutcome = "success", controls: {
  repeatClarification?: boolean;
  holdAnswer?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-planner-clarification-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const controller = new AbortController();
  const turns: Array<{ threadId: string; prompt: string; model?: string; effort?: string }> = [];
  const nativeAnswers: Array<{ pending: TurnNeedsInputResult; answers: Record<string, string[]> }> = [];
  const continuations: string[] = [];
  const disposed: string[] = [];
  const finished: Array<{ id: string; status: string }> = [];
  const released: string[] = [];
  const interrupted: Array<{ threadId: string; turnId: string }> = [];
  const heldAnswer = gate();
  const activeTasks: Promise<unknown>[] = [];
  let answerSignal: AbortSignal | undefined;
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let children = 0;
  let threads = 0;
  let answerAttempts = 0;
  let available = true;
  let initialReturned = false;
  const answer = async (threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnWaitResult> => {
    answerAttempts += 1;
    if (controls.holdAnswer && answerAttempts === 1) {
      answerSignal = signal;
      heldAnswer.enter();
      await heldAnswer.promise;
      signal?.throwIfAborted();
    }
    if (answerOutcome === "abort" && answerAttempts === 1) {
      controller.abort(new Error("operation aborted"));
      throw new Error("operation aborted");
    }
    if (answerOutcome === "generic_fail" && answerAttempts <= 2) {
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    if (controls.repeatClarification && answerAttempts === 1) {
      if (mode === "native") return { kind: "needs_input", threadId, turnId, request: {
        requestId: 2, threadId, turnId, itemId: "second-native-question", questions: [SECOND_QUESTION],
      } };
      return { kind: "completed", threadId, turnId, status: "completed", text: `2. ${SECOND_QUESTION.question}` };
    }
    return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
  };
  const gateway: CodexGateway = {
    async startThread() { return ++threads === 1 ? "original-planner" : `replacement-planner-${threads}`; },
    async resumeThread() { throw new Error("An ephemeral Planner must not use thread/resume"); },
    async startTurn(threadId, options, signal) {
      turns.push({ threadId, prompt: options.prompt, ...(options.model ? { model: options.model } : {}), effort: options.effort });
      const turnId = `visible-turn-${turns.length}`;
      await options.onStarted?.({ threadId, turnId });
      if (!initialReturned) {
        initialReturned = true;
        if (mode === "native") {
          return { kind: "needs_input", threadId, turnId, request: {
            requestId: 1, threadId, turnId, itemId: "native-question", questions: [QUESTION],
          } };
        }
        return { kind: "completed", threadId, turnId, status: "completed", text: `1. ${QUESTION.question}` };
      }
      return answer(threadId, turnId, signal);
    },
    async continueTurn(pending, answers, signal) {
      nativeAnswers.push({ pending, answers });
      return answer(pending.threadId, pending.turnId, signal);
    },
    async normalizeInFork(options) {
      const question = [QUESTION, SECOND_QUESTION].find((candidate) => options.prompt.includes(candidate.question));
      const result = question
        ? { status: "needs_input", questions: [question], assumptions: [], message: "Choose the scope" }
        : { status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] };
      return { kind: "completed", threadId: options.threadId, turnId: "conversion-turn", status: "completed",
        text: JSON.stringify(result) };
    },
    async startReview(): Promise<never> { throw new Error("Review is outside this regression"); },
    async interrupt(threadId, turnId) { interrupted.push({ threadId, turnId }); },
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => available,
    beginRound() { begins += 1; pins += 1; },
    endRound() { ends += 1; pins -= 1; },
  };
  const owner = SessionId("clarification-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = (signal = new AbortController().signal, id: string = owner) => {
    const agentId = SessionId(id);
    const agentSession = agentId === owner ? session : Session.create(agentId, [], {
      version: SESSION_FORMAT_VERSION, id: agentId, createdAt: Date.now(), cwd: directory,
      delegationDepth: 0, isSeeded: false,
    });
    return { agent: { id: agentId, session: agentSession } as Agent, signal, deferContext() {} } as unknown as ToolRunContext;
  };
  const childFactory = { create: async () => {
    const id = `planner-child-${++children}`;
    return { id, session,
      beginContinuation(instruction: string) { continuations.push(instruction); },
      pauseForInput() {},
      failAttempt() {}, progress() {},
      finish(_text: string, status: string) { finished.push({ id, status }); },
      async dispose() { disposed.push(id); },
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
  const makeManager = (storage: WorkflowStore) => new WorkflowManager(storage, gateway, config,
    undefined, undefined, undefined, {}, undefined, childFactory);
  const manager = makeManager(store);
  const restartedManagers: Array<{ manager: WorkflowManager; store: WorkflowStore }> = [];
  const restart = () => {
    const storage = new WorkflowStore(store.directory);
    const replacement = { manager: makeManager(storage), store: storage };
    restartedManagers.push(replacement);
    return replacement.manager;
  };
  const snapshot = () => ({ threads, children, pins, begins, ends,
    disposed: [...disposed], released: [...released], finished: [...finished] });
  const assertWaitingResources = (snapshotValue = snapshot()) => assert.deepEqual(snapshotValue, {
    threads: 1, children: 1, pins: 1, begins: 1, ends: 0, disposed: [], released: [], finished: [],
  }, "Waiting for clarification must retain the original round, thread and child");
  const assertCompletedResources = () => assert.deepEqual(snapshot(), {
    threads: 1, children: 1, pins: 0, begins: 1, ends: 1,
    disposed: ["planner-child-1"], released: ["original-planner"], finished: [{ id: "planner-child-1", status: "completed" }],
  }, "Completion must release the one original round exactly once");
  const assertNoTaskResend = () => {
    assert.ok(turns[0]?.prompt.includes(TASK));
    assert.ok(turns.slice(1).every((turn) => !turn.prompt.includes(TASK)), "Answers and recovery must never resend the full original task");
    assert.ok(continuations.every((instruction) => !instruction.includes(TASK)));
    assert.ok(turns.every((turn) => turn.threadId === "original-planner"));
  };
  const track = <T>(task: Promise<T>) => { activeTasks.push(task); void task.catch(() => undefined); return task; };
  return { manager, store, exec, controller, restart, turns, nativeAnswers, continuations, disposed, released, heldAnswer, track,
    interrupted, snapshot, assertWaitingResources, assertCompletedResources, assertNoTaskResend,
    setAvailable(value: boolean) { available = value; },
    get answerAttempts() { return answerAttempts; },
    get answerSignal() { return answerSignal; },
    async start() {
      const waiting = await manager.start({ task: TASK }, exec());
      assert.equal(waiting.phase, "waiting_input");
      assert.deepEqual(waiting.questions, [QUESTION]);
      return waiting;
    },
    async close() {
      heldAnswer.release();
      await Promise.allSettled(activeTasks);
      for (const entry of restartedManagers) { await entry.manager.stop(); entry.store.close(); }
      await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const mode of ["native", "converted"] as const) {
  test(`${mode} clarification answers complete in the same Planner thread and child`, async () => {
    const f = await fixture(mode);
    try {
      const waiting = await f.start();
      const parked = f.snapshot();
      const planned = await f.manager.continue(waiting.id, ANSWERS, f.exec());
      assert.equal(planned.id, waiting.id);
      assert.equal(planned.phase, "executing");
      assert.equal(planned.plannerModel, "planner-model");
      assert.equal(planned.plannerEffort, "low");
      f.assertWaitingResources(parked);
      f.assertCompletedResources();
      f.assertNoTaskResend();
      assert.equal(f.answerAttempts, 1);
      if (mode === "native") {
        assert.equal(f.nativeAnswers.length, 1);
        assert.equal(f.nativeAnswers[0]?.pending.threadId, "original-planner");
        assert.deepEqual(f.nativeAnswers[0]?.answers, ANSWERS);
      } else {
        assert.equal(f.nativeAnswers.length, 0);
        assert.ok(f.turns[1]?.prompt.includes(ANSWERS.scope[0]!));
      }
      assert.equal((await f.store.load(waiting.id))?.phase, "executing");
    } finally { await f.close(); }
  });

  test(`${mode} clarification model failure gets one continuation and then original-session manual recovery`, async () => {
    const f = await fixture(mode, "generic_fail");
    try {
      const initial = await f.start();
      const parked = f.snapshot();
      const failed = await f.manager.continue(initial.id, ANSWERS, f.exec());
      assert.equal(failed.id, initial.id);
      assert.equal(failed.phase, "planning");
      assert.equal(failed.processState, "waiting");
      assert.equal(failed.retryState?.stage, "planning");
      assert.equal(f.answerAttempts, 2, "The failed answer permits only one automatic continuation");
      f.assertWaitingResources(parked);
      const retained = f.snapshot();
      assert.equal(retained.pins, 1);
      assert.equal(retained.children, 1);
      assert.equal(retained.threads, 1);
      assert.deepEqual(retained.disposed, []);
      assert.deepEqual(retained.released, []);
      const resumed = await f.manager.resume(failed.id, undefined, f.exec());
      assert.equal(resumed.id, initial.id);
      assert.equal(resumed.phase, "executing");
      assert.equal(f.answerAttempts, 3);
      f.assertCompletedResources();
      f.assertNoTaskResend();
      assert.equal(f.nativeAnswers.length, mode === "native" ? 1 : 0, "An already answered native request must not be sent again");
    } finally { await f.close(); }
  });

  test(`${mode} clarification answer interruption keeps the original session available for manual recovery`, async () => {
    const f = await fixture(mode, "abort");
    try {
      const initial = await f.start();
      const parked = f.snapshot();
      const interrupted = await f.manager.continue(initial.id, ANSWERS, f.exec(f.controller.signal));
      assert.equal(interrupted.id, initial.id);
      assert.equal(interrupted.phase, "planning");
      assert.equal(interrupted.processState, "waiting");
      assert.equal(interrupted.retryState?.stage, "planning");
      assert.equal(f.answerAttempts, 1, "An aborted caller must wait for a new continuation request");
      f.assertWaitingResources(parked);
      assert.equal(f.snapshot().pins, 1);
      assert.deepEqual(f.disposed, []);
      const resumed = await f.manager.resume(initial.id, undefined, f.exec());
      assert.equal(resumed.phase, "executing");
      assert.equal(f.answerAttempts, 2);
      f.assertCompletedResources();
      f.assertNoTaskResend();
    } finally { await f.close(); }
  });

  for (const action of ["cancel", "stop"] as const) {
    test(`${action} of ${mode} waiting clarification releases its original resources once`, async () => {
      const f = await fixture(mode);
      try {
        const waiting = await f.start();
        const parked = f.snapshot();
        if (action === "cancel") {
          await f.manager.cancel(waiting.id, f.exec());
          await f.manager.cancel(waiting.id, f.exec());
          assert.equal((await f.store.load(waiting.id))?.phase, "cancelled");
        } else {
          await f.manager.stop();
          await f.manager.stop();
        }
        f.assertWaitingResources(parked);
        const cleaned = f.snapshot();
        assert.equal(cleaned.pins, 0);
        assert.equal(cleaned.begins, 1);
        assert.equal(cleaned.ends, 1);
        assert.deepEqual(cleaned.disposed, ["planner-child-1"]);
        assert.deepEqual(cleaned.released, ["original-planner"]);
        assert.equal(cleaned.finished.length, 1);
        assert.equal(cleaned.finished[0]?.id, "planner-child-1");
        assert.equal(f.answerAttempts, 0);
        assert.equal(cleaned.children, 1);
        assert.equal(cleaned.threads, 1);
      } finally { await f.close(); }
    });
  }

  test(`${mode} clarification refuses an unavailable original thread without replacing it`, async () => {
    const f = await fixture(mode);
    try {
      const waiting = await f.start();
      const before = f.snapshot();
      f.setAvailable(false);
      await assert.rejects(f.manager.continue(waiting.id, ANSWERS, f.exec()), UNRECOVERABLE_INPUT);
      assert.equal(f.snapshot().threads, 1);
      assert.equal(f.snapshot().children, 1);
      assert.equal(f.answerAttempts, 0);
      assert.equal(f.turns.length, 1);
      assert.equal(f.nativeAnswers.length, 0);
      assert.deepEqual(f.snapshot(), before, "Unavailable-thread diagnostics must not launch or silently replace the waiting Planner");
    } finally { await f.close(); }
  });

  test(`${mode} clarification after process restart has no original input handle and cannot silently start again`, async () => {
    const f = await fixture(mode);
    try {
      const waiting = await f.start();
      await f.manager.stop();
      const before = f.snapshot();
      const restarted = f.restart();
      await assert.rejects(restarted.continue(waiting.id, ANSWERS, f.exec()), UNRECOVERABLE_INPUT);
      assert.equal(f.answerAttempts, 0);
      assert.equal(f.nativeAnswers.length, 0);
      assert.deepEqual(f.snapshot(), before, "A durable workflow record alone cannot recreate its ephemeral input handle");
    } finally { await f.close(); }
  });
}

test("legacy waiting_input without a process-local handle cannot create a replacement Planner", async () => {
  const f = await fixture("converted");
  try {
    const now = new Date().toISOString();
    const legacy: WorkflowRecord = { schemaVersion: 1, id: "legacy-clarification", dshSessionId: "clarification-owner",
      cwd: f.store.directory, task: TASK, phase: "waiting_input", createdAt: now, updatedAt: now,
      plannerThreadId: "old-planner-thread", questions: [QUESTION], assumptions: [], reviewCycles: 0 };
    await f.store.save(legacy);
    await assert.rejects(f.manager.continue(legacy.id, ANSWERS, f.exec()), UNRECOVERABLE_INPUT);
    assert.deepEqual(f.snapshot(), { threads: 0, children: 0, pins: 0, begins: 0, ends: 0,
      disposed: [], released: [], finished: [] });
    assert.equal(f.turns.length, 0);
    assert.equal(f.nativeAnswers.length, 0);
  } finally { await f.close(); }
});

for (const mode of ["native", "converted"] as const) {
  test(`two ${mode} clarification rounds conserve the original thread, child and pin`, async () => {
    const f = await fixture(mode, "success", { repeatClarification: true });
    try {
      const first = await f.start();
      f.assertWaitingResources();
      const second = await f.manager.continue(first.id, ANSWERS, f.exec());
      assert.equal(second.id, first.id);
      assert.equal(second.phase, "waiting_input");
      assert.deepEqual(second.questions, [SECOND_QUESTION]);
      assert.equal(f.answerAttempts, 1);
      f.assertWaitingResources();
      const secondAnswers = { location: ["SECOND-ANSWER-SENTINEL: current profile"] };
      const completed = await f.manager.continue(second.id, secondAnswers, f.exec());
      assert.equal(completed.id, first.id);
      assert.equal(completed.phase, "executing");
      assert.equal(f.answerAttempts, 2);
      f.assertCompletedResources();
      f.assertNoTaskResend();
      assert.equal(f.nativeAnswers.length, mode === "native" ? 2 : 0);
      if (mode === "native") {
        assert.notEqual(f.nativeAnswers[0]?.pending.request.requestId, f.nativeAnswers[1]?.pending.request.requestId);
        assert.deepEqual(f.nativeAnswers[1]?.answers, secondAnswers);
      } else {
        assert.ok(f.turns[2]?.prompt.includes(secondAnswers.location[0]!));
      }
    } finally { await f.close(); }
  });

  test(`concurrent ${mode} clarification answers join by value and reject differing or foreign submissions`, async () => {
    const f = await fixture(mode, "success", { holdAnswer: true });
    try {
      const waiting = await f.start();
      await assert.rejects(f.manager.continue(waiting.id, ANSWERS, f.exec(undefined, "foreign-owner")), /another DSH session/);
      assert.equal(f.answerAttempts, 0, "Ownership must be checked before any answer is admitted");
      const answers = { scope: [...ANSWERS.scope], format: ["plain text"] };
      const first = f.track(f.manager.continue(waiting.id, answers, f.exec()));
      await f.heldAnswer.started;
      const sameAnswersReordered = { format: ["plain text"], scope: [...ANSWERS.scope] };
      const duplicate = f.track(f.manager.continue(waiting.id, sameAnswersReordered, f.exec()));
      await assert.rejects(f.manager.continue(waiting.id, { scope: ["Different scope"], format: ["plain text"] }, f.exec()),
        /different planner input/);
      await assert.rejects(f.manager.continue(waiting.id, sameAnswersReordered, f.exec(undefined, "foreign-owner")), /another DSH session/);
      await assert.rejects(f.manager.continue(waiting.id, { scope: ["Different scope"] }, f.exec(undefined, "foreign-owner")), /another DSH session/,
        "Authorization must win before comparison with an active input flight");
      assert.equal(f.answerAttempts, 1);
      f.assertWaitingResources();
      f.heldAnswer.release();
      const [result, joined] = await Promise.all([first, duplicate]);
      assert.deepEqual(joined, result);
      assert.equal(result.id, waiting.id);
      assert.equal(result.phase, "executing");
      assert.equal(f.answerAttempts, 1, "Equivalent object-key order must share one original answer operation");
      f.assertCompletedResources();
      f.assertNoTaskResend();
      assert.equal(f.nativeAnswers.length, mode === "native" ? 1 : 0);
    } finally { await f.close(); }
  });

  for (const action of ["cancel", "stop"] as const) {
    test(`${action} during an active ${mode} clarification answer aborts its transport and cleans once`, async () => {
      const f = await fixture(mode, "success", { holdAnswer: true });
      try {
        const waiting = await f.start();
        const answering = f.track(f.manager.continue(waiting.id, ANSWERS, f.exec()));
        const answerSettled = Promise.allSettled([answering]);
        await f.heldAnswer.started;
        f.assertWaitingResources();
        let stopSettled = false;
        let stopping: Promise<void> | undefined;
        if (action === "cancel") {
          await f.manager.cancel(waiting.id, f.exec());
          assert.equal((await f.store.load(waiting.id))?.phase, "cancelled");
        } else {
          stopping = f.track(f.manager.stop().then(() => { stopSettled = true; }));
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(stopSettled, false, "Stop must await the active answer's transport cleanup");
          assert.equal(f.snapshot().pins, 1, "The execution still owns its pin while the transport gate is held");
        }
        assert.equal(f.answerSignal?.aborted, true);
        assert.ok(f.interrupted.some((turn) => turn.threadId === "original-planner"));
        f.heldAnswer.release();
        await answerSettled;
        if (stopping) await stopping;
        if (action === "cancel") {
          await f.manager.cancel(waiting.id, f.exec());
          assert.equal((await f.store.load(waiting.id))?.phase, "cancelled");
        } else {
          await f.manager.stop();
          assert.equal(stopSettled, true);
        }
        const cleaned = f.snapshot();
        assert.equal(cleaned.pins, 0);
        assert.equal(cleaned.begins, 1);
        assert.equal(cleaned.ends, 1);
        assert.equal(cleaned.children, 1);
        assert.equal(cleaned.threads, 1);
        assert.deepEqual(cleaned.disposed, ["planner-child-1"]);
        assert.deepEqual(cleaned.released, ["original-planner"]);
        assert.equal(cleaned.finished.length, 1);
        assert.equal(f.answerAttempts, 1, "Teardown must not start a replacement or automatic continuation");
        const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
        assert.equal(runtime.inputFlights.size, 0);
        assert.equal(runtime.inputControllers.size, 0);
        assert.equal(runtime.plannerInputs.size, 0);
        assert.equal(runtime.recoverableRuns.size, 0);
        assert.equal(runtime.codexChildSessions.size, 0);
        f.assertNoTaskResend();
      } finally { await f.close(); }
    });
  }
}

test("lost native pending request cannot turn clarification answers into an ordinary new turn", async () => {
  const f = await fixture("native");
  try {
    const waiting = await f.start();
    const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    const input = runtime.plannerInputs.get(waiting.id);
    const original = runtime.pending.get(waiting.id);
    assert.ok(original);
    assert.equal(input?.pending, original);
    const before = f.snapshot();
    const recordBefore = await f.store.load(waiting.id);
    runtime.pending.delete(waiting.id);
    await assert.rejects(f.manager.continue(waiting.id, ANSWERS, f.exec()), /lost its original clarification request/);
    assert.equal(f.turns.length, 1, "Absence of the native request must never authorize turn/start");
    assert.equal(f.nativeAnswers.length, 0);
    assert.equal(f.answerAttempts, 0);
    assert.equal(runtime.plannerInputs.get(waiting.id), input, "The rejection must not claim or replace the retained input run");
    assert.deepEqual(await f.store.load(waiting.id), recordBefore);
    assert.deepEqual(f.snapshot(), before);
  } finally { await f.close(); }
});

test("already aborted native clarification entry preserves its request for the next normal answer", async () => {
  const f = await fixture("native");
  try {
    const waiting = await f.start();
    const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    const originalInput = runtime.plannerInputs.get(waiting.id);
    const originalPending = runtime.pending.get(waiting.id);
    assert.ok(originalInput);
    assert.ok(originalPending);
    assert.equal(originalInput.pending, originalPending);
    const before = f.snapshot();
    const recordBefore = await f.store.load(waiting.id);
    const aborted = new AbortController();
    aborted.abort(new Error("already aborted at clarification entry"));
    await assert.rejects(f.manager.continue(waiting.id, ANSWERS, f.exec(aborted.signal)), /already aborted at clarification entry/);
    assert.equal(f.answerAttempts, 0);
    assert.equal(f.nativeAnswers.length, 0);
    assert.equal(f.turns.length, 1, "The rejected entry must not start an additional model turn");
    assert.equal(runtime.plannerInputs.get(waiting.id), originalInput);
    assert.equal(runtime.pending.get(waiting.id), originalPending);
    assert.equal(runtime.inputFlights.size, 0);
    assert.equal(runtime.inputControllers.size, 0);
    assert.deepEqual(await f.store.load(waiting.id), recordBefore);
    assert.deepEqual(f.snapshot(), before);
    f.assertWaitingResources();
    const completed = await f.manager.continue(waiting.id, ANSWERS, f.exec());
    assert.equal(completed.id, waiting.id);
    assert.equal(completed.phase, "executing");
    assert.equal(f.answerAttempts, 1);
    assert.equal(f.nativeAnswers.length, 1);
    assert.equal(f.nativeAnswers[0]?.pending, originalPending, "The next answer must submit the exact retained native request");
    assert.deepEqual(f.nativeAnswers[0]?.answers, ANSWERS);
    f.assertCompletedResources();
    f.assertNoTaskResend();
    assert.equal(runtime.plannerInputs.size, 0);
    assert.equal(runtime.pending.size, 0);
  } finally { await f.close(); }
});

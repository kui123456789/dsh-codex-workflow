import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { CodexCliAuditDispatcher } from "../src/codex-cli-audit.js";
import type { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import { retryTransient, transientReason, TransientRetryExhaustedError } from "../src/transient-retry.js";
import type { TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

type Entry = "control" | "planning" | "reviewing" | "cli";
type Scenario = { name: string; elapsed: number[]; wall: number[]; calls: number; budget?: number;
  cancel?: boolean; injected?: boolean; initialSuccess?: boolean; failures?: number };
type TurnEntries = {
  startTurnWithTransientRetry(threadId: string, options: { prompt: string }, signal: AbortSignal): Promise<TurnWaitResult>;
  startReviewWithTransientRetry(options: { threadId: string; cwd: string; detached: true;
    target: { type: "custom"; instructions: string } }, signal: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
};
type ProcessResult = { code: number; stdout: string; stderr: string };
type CliEntries = {
  run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string, signal: AbortSignal,
    threadId?: string): Promise<ProcessResult>;
  runWithTransientRetry(input: { workflowId: string; submissionId: string; prompt: string; signal: AbortSignal;
    resumeThreadId: string; buildArgs(threadId?: string): string[] }): Promise<ProcessResult>;
};

const scenarios: Scenario[] = [
  { name: "clock rollback at deadline", elapsed: [50], wall: [500], calls: 1 },
  { name: "clock rollback after deadline", elapsed: [210], wall: [500], calls: 1 },
  { name: "clock advance while inside budget", elapsed: [10], wall: [2000], calls: 2 },
  { name: "ordinary within-budget retry", elapsed: [10], wall: [1010], calls: 2 },
  { name: "cancellation before exhausted-budget handling", elapsed: [210], wall: [500], calls: 1, cancel: true },
  { name: "zero-budget transient failure", elapsed: [], wall: [], calls: 1, budget: 0 },
  { name: "zero-budget initial success", elapsed: [], wall: [], calls: 1, budget: 0, initialSuccess: true },
  { name: "explicit clock override", elapsed: [210], wall: [500], calls: 1, injected: true },
  { name: "successive rollbacks do not extend one original budget", elapsed: [10, 50], wall: [500, 400], calls: 2, failures: 2 },
];

function config(directory: string, budgetMs: number): WorkflowConfig {
  return { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 10, transientRetryMaxMs: 10, transientRetryBudgetMs: budgetMs, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: directory };
}

async function check(t: TestContext, entry: Entry, scenario: Scenario) {
  let wall = 1000, elapsed = 0, calls = 0, sleeps = 0, creates = 0;
  const wallMock = t.mock.method(Date, "now", () => wall);
  const elapsedMock = t.mock.method(performance, "now", () => elapsed);
  const controller = new AbortController(), cause = new Error("original caller cancelled");
  const threads: Array<string | undefined> = [];
  const budgetMs = scenario.budget ?? 50;
  const policy = { baseMs: 10, maxMs: 10, budgetMs, jitterRatio: 0 };
  const hooks = { ...(scenario.injected ? { now: () => elapsed } : {}), sleep: async (ms: number) => {
    assert.equal(ms, 10);
    elapsed = scenario.elapsed[sleeps]!; wall = scenario.wall[sleeps]!; sleeps++;
    assert.ok(Number.isFinite(elapsed) && Number.isFinite(wall), "only the original bounded sleep sequence is allowed");
    if (scenario.cancel) controller.abort(cause);
  } };
  const shouldFail = () => !scenario.initialSuccess && calls <= (scenario.failures ?? 1);
  let lastError: Error | undefined, lastTurn: TurnWaitResult | undefined, lastProcess: ProcessResult | undefined;
  let manager: WorkflowManager | undefined, store: WorkflowStore | undefined;
  let audit: CodexCliAuditDispatcher | undefined, directory: string | undefined;
  try {
    let outcome: unknown, failure: unknown;
    if (entry === "control") {
      try { outcome = await retryTransient(async () => {
        calls++; if (shouldFail()) { lastError = new Error("503 Service Unavailable"); throw lastError; }
        return "original success";
      }, error => transientReason((error as Error).message), policy, hooks, controller.signal); }
      catch (error) { failure = error; }
    } else if (entry === "cli") {
      audit = new CodexCliAuditDispatcher({ command: "unused", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
        timeoutMs: 1000, retry: policy, ...hooks });
      const entries = audit as unknown as CliEntries;
      entries.run = async (_workflow, _submission, _args, _prompt, _signal, threadId) => {
        calls++; threads.push(threadId);
        return lastProcess = shouldFail() ? { code: 1, stdout: "", stderr: "503 Service Unavailable" }
          : { code: 0, stdout: "original success", stderr: "" };
      };
      try { outcome = await entries.runWithTransientRetry({ workflowId: "original-workflow", submissionId: "original-submission",
        resumeThreadId: "original-thread", prompt: "Original review", buildArgs: threadId => ["resume", threadId!], signal: controller.signal }); }
      catch (error) { failure = error; }
    } else {
      directory = await mkdtemp(join(tmpdir(), "dsh-monotonic-budget-"));
      store = new WorkflowStore(directory);
      const run = async (threadId: string): Promise<TurnWaitResult> => {
        calls++; threads.push(threadId);
        return lastTurn = { kind: "completed", threadId, turnId: `original-turn-${calls}`,
          status: shouldFail() ? "failed" : "completed", text: shouldFail() ? "" : "original success",
          ...(shouldFail() ? { error: "503 Service Unavailable" } : {}) };
      };
      const gateway = { startThread: async () => { creates++; throw new Error("No replacement thread is allowed"); },
        startTurn: run, startReview: async (options: { threadId: string }) => ({ threadId: options.threadId, result: await run(options.threadId) }) } as unknown as CodexGateway;
      manager = new WorkflowManager(store, gateway, config(directory, budgetMs), undefined, undefined, undefined, hooks);
      const entries = manager as unknown as TurnEntries;
      try { outcome = entry === "planning" ? await entries.startTurnWithTransientRetry("original-thread", { prompt: "Original planning" }, controller.signal)
        : (await entries.startReviewWithTransientRetry({ threadId: "original-thread", cwd: directory, detached: true,
          target: { type: "custom", instructions: "Original review" } }, controller.signal)).result; }
      catch (error) { failure = error; }
    }
    assert.equal(calls, scenario.calls, "only operations admitted by the original elapsed budget can run");
    assert.equal(creates, 0);
    assert.ok(threads.every(threadId => threadId === "original-thread"));
    if (scenario.cancel) assert.equal(failure, cause, "retain the original caller's cancellation object");
    else if (entry === "control" && shouldFail()) {
      assert.ok(failure instanceof TransientRetryExhaustedError);
      assert.equal(failure.attempts, calls); assert.equal(failure.lastError, lastError);
    } else {
      assert.equal(failure, undefined);
      assert.equal(outcome, entry === "control" ? "original success" : entry === "cli" ? lastProcess : lastTurn,
        "preserve the last actual outcome from the original operation");
    }
    assert.equal(sleeps, scenario.elapsed.length);
  } finally {
    wallMock.mock.restore(); elapsedMock.mock.restore();
    try { await manager?.stop(); await audit?.stop(); }
    finally {
      store?.close();
      if (directory) { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
    }
  }
}

for (const entry of ["control", "planning", "reviewing", "cli"] as const) {
  for (const scenario of scenarios) test(`${entry} default retry budget: ${scenario.name}`, t => check(t, entry, scenario));
}

test("public Planner start and resume retain one child/thread and one automatic continuation after clock rollback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-monotonic-planner-flow-"));
  const store = new WorkflowStore(directory);
  let wall = 1000, elapsed = 0, threadStarts = 0, children = 0, disposals = 0, continuations = 0, begins = 0, ends = 0;
  const wallMock = t.mock.method(Date, "now", () => wall);
  const elapsedMock = t.mock.method(performance, "now", () => elapsed);
  const parent = Session.create(SessionId("clock-owner"), [], { version: SESSION_FORMAT_VERSION,
    id: SessionId("clock-owner"), createdAt: wall, cwd: directory, isSeeded: false });
  const child = Session.create(SessionId("original-clock-child"), [], { version: SESSION_FORMAT_VERSION,
    id: SessionId("original-clock-child"), createdAt: wall, cwd: directory, isSeeded: false });
  const calls: Array<{ threadId: string; prompt: string }> = [];
  const gateway = {
    async startThread() { threadStarts++; return "original-clock-planner"; },
    async startTurn(threadId: string, options: Parameters<CodexGateway["startTurn"]>[1]): Promise<TurnWaitResult> {
      calls.push({ threadId, prompt: options.prompt });
      assert.ok(calls.length <= 3, "a clock rollback must never create an unbounded original retry sequence");
      const turnId = `original-turn-${calls.length}`;
      await options.onStarted?.({ threadId, turnId });
      return { kind: "completed", threadId, turnId, status: "failed", text: "", error: "503 Service Unavailable" };
    },
    async resumeThread() { throw new Error("Do not create or resume a substitute Planner"); },
    async normalizeInFork() { throw new Error("No readable result exists to normalize"); },
    async continueTurn() { throw new Error("No clarification question was asked"); },
    async startReview() { throw new Error("Only the original planning flow is under test"); },
    async interrupt() {},
    async unsubscribeThread() {},
    beginRound() { begins++; }, endRound() { ends++; },
    isThreadAvailable: () => true,
  } satisfies CodexGateway;
  const factory = { create: async () => {
    children++;
    return { id: child.id, session: child, progress() {}, finish() {}, failAttempt() {},
      beginContinuation() { continuations++; }, async dispose() { disposals++; } };
  } } as unknown as CodexChildSessionFactory;
  const manager = new WorkflowManager(store, gateway, config(directory, 50), undefined, undefined, undefined, {
    sleep: async () => { elapsed += 210; wall -= 500; },
  }, undefined, factory);
  const exec = () => ({ agent: { id: parent.id, session: parent }, signal: new AbortController().signal,
    deferContext() {} } as unknown as ToolRunContext);
  try {
    const waiting = await manager.start({ task: "Plan read-only inspection of the existing local configuration." }, exec());
    assert.equal(waiting.processState, "waiting");
    assert.equal(waiting.retryState?.awaitingContinuation, true);
    assert.equal(calls.length, 2, "the initial attempt and one short automatic continuation each spend their own original budget");
    assert.notEqual(calls[0]!.prompt, calls[1]!.prompt);
    assert.equal(continuations, 1);
    assert.equal((await manager.status(undefined, exec())).continuation.available, true);
    const resumed = await manager.resume(undefined, "Continue the unfinished original plan", exec());
    assert.equal(resumed.id, waiting.id); assert.equal(resumed.processState, "waiting");
    assert.equal(calls.length, 3, "manual resume cannot replenish the automatic continuation allowance");
    assert.equal(calls[2]!.prompt, "Continue the unfinished original plan");
    assert.equal(continuations, 2);
    assert(calls.every(call => call.threadId === "original-clock-planner"));
    assert.equal(threadStarts, 1); assert.equal(children, 1); assert.equal(disposals, 0);
    await manager.cancel(waiting.id, exec());
    assert.equal(disposals, 1); assert.equal(begins, 1); assert.equal(ends, 1);
  } finally {
    wallMock.mock.restore(); elapsedMock.mock.restore();
    try { await manager.stop(); }
    finally { store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});

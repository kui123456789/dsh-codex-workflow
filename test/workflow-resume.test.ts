import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";

const PLAN = [
  "# Goal", "Implement a safe health check without modifying the workspace.",
  "# Changes", "- Read the configuration and storage status through explicit read-only adapters.",
  "# Verification", "- Check valid, missing and invalid configuration and report deterministic diagnostics.",
  "# Risks", "- Avoid initializing a database during inspection; return a readable error instead.",
].join("\n");
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The implementation meets the approved requirements.";
type Stage = "planning" | "reviewing";

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const state = { released: false };
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return { promise, started, entered, state, release() { state.released = true; release(); } };
}

interface ScriptStep {
  fail?: boolean;
  timeout?: boolean;
  terminalError?: string;
  hold?: ReturnType<typeof gate>;
  abort?: AbortController;
  beforeStarted?: boolean;
}

/** Script only transport outcomes; all state transitions and SQLite writes are real. */
class ScriptedGateway implements CodexGateway {
  readonly threadStarts: Array<{ threadId: string; stage: Stage }> = [];
  readonly turnStarts: Array<{ threadId: string; stage: Stage; prompt: string; api: "review" | "turn" }> = [];
  readonly interrupted = gate();
  readonly releases: string[] = [];
  readonly scripts: Record<Stage, ScriptStep[]> = { planning: [], reviewing: [] };
  privateThreadStarts = 0;
  pins = 0;
  pinReleases = 0;
  private turnNumber = 0;

  beginRound(): void { this.pins += 1; }
  endRound(): void { this.pins -= 1; this.pinReleases += 1; }
  async startThread(options: Parameters<CodexGateway["startThread"]>[0]): Promise<string> {
    if (options.name?.startsWith("DSH Review Alignment")) return `alignment-thread-${++this.privateThreadStarts}`;
    return this.createThread("planning");
  }
  async startReviewerThread(): Promise<string> { return this.createThread("reviewing"); }
  private createThread(stage: Stage): string {
    const threadId = `${stage}-thread-${this.threadStarts.length + 1}`;
    this.threadStarts.push({ threadId, stage });
    return threadId;
  }
  async resumeThread(): Promise<void> {}
  async unsubscribeThread(threadId: string): Promise<void> { this.releases.push(threadId); }
  async interrupt(): Promise<void> { this.interrupted.entered(); }
  async continueTurn(): Promise<TurnWaitResult> { throw new Error("Unexpected clarification flow"); }

  async startTurn(threadId: string, options: Parameters<CodexGateway["startTurn"]>[1]): Promise<TurnWaitResult> {
    return this.run(threadId, options.planMode ? "planning" : "reviewing", options.prompt, options, "turn");
  }
  async startReview(options: Parameters<CodexGateway["startReview"]>[0]): Promise<{ threadId: string; result: TurnWaitResult }> {
    const prompt = String(options.target.instructions ?? "");
    return { threadId: options.threadId, result: await this.run(options.threadId, "reviewing", prompt, options, "review") };
  }
  private async run(threadId: string, stage: Stage, prompt: string,
    options: Pick<Parameters<CodexGateway["startTurn"]>[1], "onStarted" | "onProgress">,
    api: "review" | "turn"): Promise<TurnWaitResult> {
    const turnId = `visible-turn-${++this.turnNumber}`;
    this.turnStarts.push({ threadId, stage, prompt, api });
    const step = this.scripts[stage].shift() ?? {};
    if (!step.beforeStarted) await options.onStarted?.({ threadId, turnId });
    if (step.abort) {
      step.abort.abort(new Error("operation aborted"));
      throw new Error("operation aborted");
    }
    if (step.hold) {
      step.hold.entered();
      await step.hold.promise;
    }
    if (step.timeout) throw new Error(`Codex turn timed out: ${turnId}`);
    if (step.terminalError) return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed", error: step.terminalError };
    if (step.fail) return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    const text = stage === "planning" ? PLAN : REVIEW;
    options.onProgress?.({ kind: "message", itemId: turnId, text });
    return { kind: "completed", threadId, turnId, status: "completed", text };
  }
  async normalizeInFork(options: Parameters<CodexGateway["normalizeInFork"]>[0]): Promise<TurnWaitResult> {
    const text = options.prompt.includes("REVIEW AUTHORITY checker")
      ? JSON.stringify({ aligned: true, conflicts: [] })
      : options.prompt.startsWith("Convert the readable code review")
        ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified" })
        : JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] });
    return { kind: "completed", threadId: options.threadId, turnId: `private-turn-${++this.turnNumber}`, status: "completed", text };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-workflow-resume-"));
  await writeFile(join(directory, "changed.txt"), "verified change", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const gateway = new ScriptedGateway();
  const children: Session[] = [];
  const childSignals: AbortSignal[] = [];
  const disposals: string[] = [];
  let disposalError: Error | undefined;
  let provider: SubagentProvider;
  const childFactory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; signal: AbortSignal }) => {
    const session = Session.create(options.sessionId, [], {
      version: SESSION_FORMAT_VERSION, id: options.sessionId, createdAt: Date.now(), cwd: directory,
      parentSession: SessionId("owner"), origin: "subagent", delegationDepth: 1, isSeeded: false,
    });
    children.push(session);
    childSignals.push(options.signal);
    return { agent: { id: options.sessionId, session } as Agent, dispose: async () => {
      disposals.push(session.id);
      if (disposalError) {
        const error = disposalError;
        disposalError = undefined;
        throw error;
      }
    } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      const descriptor = snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label });
      return provider.start({ ...request, descriptor } as never);
    },
  } as never);
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "complex", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const exec = (sessionId = "owner", controller = new AbortController()): ToolRunContext => ({
    agent: { id: sessionId, session: Session.create(SessionId(sessionId), [], {
      version: SESSION_FORMAT_VERSION, id: SessionId(sessionId), createdAt: Date.now(), cwd: directory, isSeeded: false,
    }) },
    signal: controller.signal, deferContext() {},
  } as unknown as ToolRunContext);
  const wait = async (stage: Stage) => {
    gateway.scripts[stage].push({ fail: true }, { fail: true });
    const record = stage === "planning"
      ? await manager.start({ task: "Create a health check" }, exec())
      : await manager.reviewOnly({ task: "Review the health check", implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, exec());
    assert.equal(record.processState, "waiting");
    assert.equal(record.retryState?.stage, stage);
    assert.equal((await manager.status(undefined, exec())).reviewerActive, false, "a retained waiting handle is not an executing Reviewer");
    return record;
  };
  return { directory, store, gateway, children, childSignals, disposals, manager, exec, wait,
    failNextDisposal() { disposalError = new Error("simulated child cleanup failure"); },
    async close() {
      await manager.stop();
      childFactory.unregisterProvider();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const operation of ["start", "resume"] as const) {
  test(`Planner terminal ${operation} failure clears its active turn and omits finished-thread usage`, async () => {
    const f = await fixture();
    try {
      const waiting = operation === "resume" ? await f.wait("planning") : undefined;
      Object.assign(f.gateway, { getThreadTokenUsage: (threadId: string) => ({
        threadId, turnId: "terminal-turn",
        total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
        last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
      }) });
      f.gateway.scripts.planning.push({ terminalError: "approval denied" });
      await assert.rejects(operation === "start"
        ? f.manager.start({ task: "Create a health check" }, f.exec())
        : f.manager.resume(waiting!.id, "Continue", f.exec()), /approval denied/);
      const record = (await f.store.list())[0]!;
      const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
      assert.equal(runtime.activeTurns.has(record.id), false, "a completed terminal failure is no longer a cancellation target");
      assert.equal(runtime.recoverableRuns.has(record.id), false);
      const status = await f.manager.status(record.id, f.exec());
      assert.equal(status.phase, "failed");
      assert.deepEqual(status.continuation, { available: false, reason: "not_waiting" });
      assert.equal(status.tokenUsage, undefined, "finished-thread counters must not appear as current original-thread usage");
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(f.gateway.pins, 0);
      assert.equal(f.gateway.pinReleases, 1);
      assert.equal(f.children.length, 1);
      assert.equal(f.disposals.length, 1);
    } finally { await f.close(); }
  });
}

test("Reviewer terminal failure already clears its active turn and retains no continuation", async () => {
  const f = await fixture();
  try {
    f.gateway.scripts.reviewing.push({ terminalError: "approval denied" });
    await assert.rejects(f.manager.reviewOnly({ task: "Review the health check",
      implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, f.exec()), /approval denied/);
    const record = (await f.store.list())[0]!;
    const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    assert.equal(runtime.activeTurns.has(record.id), false);
    assert.equal(runtime.recoverableRuns.has(record.id), false);
    const status = await f.manager.status(record.id, f.exec());
    assert.equal(record.reviewFailureReason, "original_reviewer_unavailable");
    assert.deepEqual(status.continuation, { available: false, reason: "thread_unavailable" });
    assert.equal(status.tokenUsage, undefined);
    assert.equal(f.gateway.pins, 0);
    assert.equal(f.gateway.pinReleases, 1);
    await assert.rejects(f.manager.review(record.id, { implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, f.exec()),
      /original Reviewer is unavailable; unchanged evidence requires an explicitly requested independent review round/);
    assert.equal(f.gateway.threadStarts.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.disposals.length, 1);
    assert.deepEqual(f.gateway.releases, [f.gateway.threadStarts[0]!.threadId]);
  } finally { await f.close(); }
});

for (const stage of ["planning", "reviewing"] as const) {
  test(`${stage} model turn timeout continues once on the original thread and child`, async () => {
    const f = await fixture();
    try {
      f.gateway.scripts[stage].push({ timeout: true });
      const result = stage === "planning"
        ? await f.manager.start({ task: "Create a health check" }, f.exec())
        : await f.manager.reviewOnly({ task: "Review the health check", implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, f.exec());
      assert.equal(result.phase, stage === "planning" ? "executing" : "passed");
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(f.children.length, 1);
      assert.equal(f.gateway.turnStarts.length, 2);
      assert.equal(new Set(f.gateway.turnStarts.map((turn) => turn.threadId)).size, 1);
      assert.equal(f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length, 2);
      assert.equal(f.disposals.length, 1);
      assert.equal(f.gateway.pins, 0);
    } finally { await f.close(); }
  });

  test(`${stage} repeated model turn timeout waits and resumes the same original identities`, async () => {
    const f = await fixture();
    try {
      f.gateway.scripts[stage].push({ timeout: true }, { timeout: true });
      const waiting = stage === "planning"
        ? await f.manager.start({ task: "Create a health check" }, f.exec())
        : await f.manager.reviewOnly({ task: "Review the health check", implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, f.exec());
      assert.equal(waiting.processState, "waiting");
      assert.equal((await f.manager.status(undefined, f.exec())).continuation.available, true);
      const originalThread = f.gateway.threadStarts[0]!.threadId;
      const originalChild = f.children[0]!.id;
      assert.equal(f.disposals.length, 0);
      const resumed = await f.manager.resume(undefined, "Continue unfinished work", f.exec());
      assert.equal(resumed.id, waiting.id);
      assert.equal(resumed.phase, stage === "planning" ? "executing" : "passed");
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(f.gateway.turnStarts.length, 3);
      assert.ok(f.gateway.turnStarts.every((turn) => turn.threadId === originalThread));
      assert.deepEqual(f.children.map((child) => child.id), [originalChild]);
      assert.equal(f.disposals.length, 1);
      assert.equal(f.gateway.pins, 0);
      assert.equal(resumed.reviewCycles, stage === "planning" ? 0 : 1);
    } finally { await f.close(); }
  });
}

test("Reviewer resume rejects another DSH session before creating any backend turn", async () => {
  const f = await fixture();
  try {
    const waiting = await f.wait("reviewing");
    const before = await f.store.load(waiting.id);
    const calls = f.gateway.turnStarts.length;
    await assert.rejects(f.manager.resume(waiting.id, "Continue", f.exec("other")), /another DSH session/);
    assert.equal(f.gateway.turnStarts.length, calls);
    assert.deepEqual(await f.store.load(waiting.id), before);
    const resumed = await f.manager.resume(waiting.id, "Continue", f.exec());
    assert.equal(resumed.phase, "passed");
  } finally { await f.close(); }
});

test("Reviewer resume denies another session even while the owner's continuation is in flight", async () => {
  const f = await fixture();
  const hold = gate();
  try {
    const waiting = await f.wait("reviewing");
    f.gateway.scripts.reviewing.push({ hold });
    const resumed = f.manager.resume(waiting.id, "Continue", f.exec());
    const settled = Promise.allSettled([resumed]);
    await hold.started;
    const calls = f.gateway.turnStarts.length;
    await assert.rejects(f.manager.resume(waiting.id, "Continue", f.exec("other")), /another DSH session/);
    assert.equal(f.gateway.turnStarts.length, calls);
    hold.release();
    assert.equal((await settled)[0]?.status, "fulfilled");
  } finally { hold.release(); await f.close(); }
});

test("Reviewer rejects changed workspace evidence and releases the retained child, subscription and pin once", async () => {
  const f = await fixture();
  try {
    const waiting = await f.wait("reviewing");
    const calls = f.gateway.turnStarts.length;
    await writeFile(join(f.directory, "changed.txt"), "different implementation", "utf8");
    await assert.rejects(f.manager.resume(waiting.id, "Continue", f.exec()), /workspace changed/);
    assert.equal(f.gateway.turnStarts.length, calls, "do not continue an audit over different code");
    assert.equal(f.children.length, 1);
    assert.equal(f.disposals.length, 1);
    assert.deepEqual(f.gateway.releases, [f.gateway.threadStarts[0]!.threadId]);
    assert.equal(f.gateway.pinReleases, 1);
    assert.equal(f.gateway.pins, 0);
    assert.equal((await f.store.load(waiting.id))?.retryState, undefined);
  } finally { await f.close(); }
});

test("caller abort before Reviewer resume observation retains the exact original waiting recovery", async () => {
  const f = await fixture();
  const internal = f.manager as unknown as { runtime: WorkflowRuntimeState; reviewExecution: {
    ctx: { owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> };
  } };
  const readOwned = internal.reviewExecution.ctx.owned;
  try {
    const waiting = await f.wait("reviewing");
    const original = internal.runtime.recoverableRuns.get(waiting.id)!;
    const before = (await f.store.load(waiting.id))!;
    const turns = f.gateway.turnStarts.length;
    const child = f.children[0]!;
    const caller = new AbortController();
    let injected = false;
    internal.reviewExecution.ctx.owned = async (id, exec) => {
      const snapshot = await readOwned(id, exec);
      if (!injected && !internal.runtime.recoverableRuns.has(id)) {
        injected = true;
        caller.abort(new Error("operation aborted"));
      }
      return snapshot;
    };
    await assert.rejects(f.manager.resume(waiting.id, "Continue", f.exec("owner", caller)), /operation aborted/);
    assert.equal(injected, true, "abort occurs only after resume claims its existing handle, before observation begins");
    assert.deepEqual(await f.store.load(waiting.id), before, "an unstarted continuation leaves the original waiting record intact");
    assert.equal(internal.runtime.recoverableRuns.get(waiting.id), original);
    assert.equal(internal.runtime.codexChildSessions.get(waiting.id), original.child);
    assert.equal(f.gateway.turnStarts.length, turns);
    assert.equal(f.gateway.pins, 1);
    assert.equal(f.gateway.pinReleases, 0);
    assert.deepEqual(f.gateway.releases, []);
    assert.deepEqual(f.disposals, []);
    internal.reviewExecution.ctx.owned = readOwned;
    const completed = await f.manager.resume(waiting.id, "Continue", f.exec());
    assert.equal(completed.phase, "passed");
    assert.equal(completed.reviewCycles, 1);
    assert.equal(f.gateway.threadStarts.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.gateway.turnStarts.at(-1)?.threadId, original.threadId);
    assert.deepEqual(f.disposals, [child.id]);
    assert.equal(f.gateway.pins, 0);
  } finally { internal.reviewExecution.ctx.owned = readOwned; await f.close(); }
});

test("Reviewer resume releases its subscription and process pin even when child disposal throws", async () => {
  const f = await fixture();
  try {
    const waiting = await f.wait("reviewing");
    f.failNextDisposal();
    await assert.rejects(f.manager.resume(waiting.id, "Continue", f.exec()), /simulated child cleanup failure/);
    assert.equal((await f.store.load(waiting.id))?.phase, "passed", "the cleanup error does not replace an applied verdict");
    assert.equal(f.disposals.length, 1);
    assert.equal(f.gateway.privateThreadStarts, 1);
    assert.deepEqual(f.gateway.releases, ["alignment-thread-1", f.gateway.threadStarts[0]!.threadId]);
    assert.equal(f.gateway.pinReleases, 2);
    assert.equal(f.gateway.pins, 0, "a failed display cleanup cannot keep the App Server pinned");
  } finally { await f.close(); }
});

for (const stage of ["planning", "reviewing"] as const) {
  test(`${stage} cancellation winning the waiting commit cannot leak its child or retained pin`, async () => {
    const f = await fixture();
    const hold = gate();
    try {
      f.gateway.scripts[stage].push({ fail: true }, { fail: true, hold });
      const running = stage === "planning"
        ? f.manager.start({ task: "Create a health check" }, f.exec())
        : f.manager.reviewOnly({ task: "Review the health check", implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, f.exec());
      const settled = Promise.allSettled([running]);
      await hold.started;
      const record = await f.manager.status(undefined, f.exec());
      await f.manager.cancel(record.id, f.exec());
      hold.release();
      await settled;
      assert.equal((await f.store.load(record.id))?.phase, "cancelled");
      assert.equal(f.gateway.pins, 0);
      assert.equal(f.gateway.pinReleases, 1);
      assert.equal(f.disposals.length, 1);
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(f.gateway.releases.length, 1, "both terminal Planner and Reviewer calls release their original subscription");
    } finally { hold.release(); await f.close(); }
  });

  test(`${stage} resume without a workflow id resolves the current session's original workflow`, async () => {
    const f = await fixture();
    try {
      const waiting = await f.wait(stage);
      const result = await f.manager.resume(undefined, "Continue unfinished work", f.exec());
      assert.equal(result.id, waiting.id);
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(f.children.length, 1);
      assert.equal(f.gateway.turnStarts[0]?.threadId, f.gateway.turnStarts.at(-1)?.threadId);
      assert.equal(result.retryState, undefined);
    } finally { await f.close(); }
  });

  test(`${stage} concurrent resume admits exactly one backend turn and releases its pin once`, async () => {
    const f = await fixture();
    const hold = gate();
    try {
      const waiting = await f.wait(stage);
      const calls = f.gateway.turnStarts.length;
      const releases = f.gateway.pinReleases;
      const privateThreads = f.gateway.privateThreadStarts;
      f.gateway.scripts[stage].push({ hold });
      const first = f.manager.resume(waiting.id, "Continue the current task", f.exec());
      await hold.started;
      const second = f.manager.resume(waiting.id, "Continue the current task", f.exec());
      const settled = Promise.allSettled([first, second]);
      hold.release();
      const resumes = await settled;
      assert.equal(resumes[0]?.status, "fulfilled");
      assert.equal(f.gateway.turnStarts.length, calls + 1, "a concurrent caller must join or reject before another model turn starts");
      const auxiliaryLifetimes = f.gateway.privateThreadStarts - privateThreads;
      assert.equal(auxiliaryLifetimes, stage === "reviewing" ? 1 : 0);
      assert.equal(f.gateway.pinReleases, releases + 1 + auxiliaryLifetimes);
      assert.equal(f.gateway.pins, 0);
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(f.children.length, 1);
    } finally { hold.release(); await f.close(); }
  });

  test(`${stage} manual resume appends a continuation turn to the existing child and clears recovery state`, async () => {
    const f = await fixture();
    try {
      const waiting = await f.wait(stage);
      const child = f.children[0]!;
      const beforeTurns = child.snapshotEvents().filter((event) => event.type === "turn/start").length;
      const instruction = "Continue only the unfinished work in this same conversation.";
      const result = await f.manager.resume(waiting.id, instruction, f.exec());
      const after = child.snapshotEvents();
      assert.equal(after.filter((event) => event.type === "turn/start").length, beforeTurns + 1);
      const userEvents = after.filter((event) => event.type === "user/message");
      assert.match(JSON.stringify(userEvents.at(-1)?.data), /Continue only the unfinished work/);
      assert.equal(f.gateway.turnStarts.at(-1)?.prompt, instruction, "manual resume sends only the short continuation instruction");
      assert.equal(f.gateway.turnStarts.at(-1)?.api, "turn", "resume continues a turn rather than restarting a native review");
      assert.equal(f.gateway.turnStarts.filter((turn) => turn.api === "review").length, stage === "reviewing" ? 1 : 0);
      assert.equal(f.children.length, 1);
      assert.equal(f.gateway.threadStarts.length, 1);
      assert.equal(result.retryState, undefined);
      assert.equal(result.error, undefined);
      assert.equal(result.phase, stage === "planning" ? "executing" : "passed");
      assert.equal(result.reviewCycles, stage === "planning" ? 0 : 1);
    } finally { await f.close(); }
  });

  test(`${stage} a different continuation instruction cannot be silently merged into an active resume`, async () => {
    const f = await fixture();
    const hold = gate();
    try {
      const waiting = await f.wait(stage);
      f.gateway.scripts[stage].push({ hold });
      const first = f.manager.resume(waiting.id, "Continue the current task", f.exec());
      const settled = Promise.allSettled([first]);
      await hold.started;
      const calls = f.gateway.turnStarts.length;
      await assert.rejects(f.manager.resume(waiting.id, "Change the scope instead", f.exec()), /different instruction/);
      assert.equal(f.gateway.turnStarts.length, calls);
      hold.release();
      assert.equal((await settled)[0]?.status, "fulfilled");
    } finally { hold.release(); await f.close(); }
  });

  test(`${stage} stop waits for an admitted resume to settle and forbids later resume`, async () => {
    const f = await fixture();
    const hold = gate();
    try {
      const waiting = await f.wait(stage);
      f.gateway.scripts[stage].push({ hold });
      const resumed = f.manager.resume(waiting.id, "Continue", f.exec());
      const settledResume = Promise.allSettled([resumed]);
      await hold.started;
      const stopped = f.manager.stop().then(() => {
        assert.equal(hold.state.released, true, "stop must await the in-flight tool before completing cleanup");
      });
      const settledStop = Promise.allSettled([stopped]);
      await f.gateway.interrupted.started;
      // The underlying operation deliberately needs explicit settlement even after interrupt.
      await new Promise<void>((resolve) => setImmediate(resolve));
      hold.release();
      const stopResult = (await settledStop)[0]!;
      await settledResume;
      if (stopResult.status === "rejected") throw stopResult.reason;
      const calls = f.gateway.turnStarts.length;
      await assert.rejects(f.manager.resume(waiting.id, "Continue", f.exec()), /stopped|no in-process|stopping/i);
      assert.equal(f.gateway.turnStarts.length, calls);
      assert.equal(f.gateway.pins, 0);
      assert.equal(f.disposals.length, 1);
    } finally { hold.release(); await f.close(); }
  });

  test(`${stage} cancel during resume preserves an unrelated process pin`, async () => {
    const f = await fixture();
    const hold = gate();
    try {
      const waiting = await f.wait(stage);
      f.gateway.beginRound(); // A separate workflow still owns this pin.
      const releases = f.gateway.pinReleases;
      f.gateway.scripts[stage].push({ hold });
      const resumed = f.manager.resume(waiting.id, "Continue", f.exec());
      const settled = Promise.allSettled([resumed]);
      await hold.started;
      await f.manager.cancel(waiting.id, f.exec());
      hold.release();
      await settled;
      assert.equal((await f.store.load(waiting.id))?.phase, "cancelled");
      assert.equal(f.gateway.pinReleases, releases + 1, "cancel and resume cleanup must release the shared pin only once");
      assert.equal(f.gateway.pins, 1);
      assert.equal(f.disposals.length, 1);
      f.gateway.endRound();
    } finally { hold.release(); await f.close(); }
  });
}

for (const stage of ["planning", "reviewing"] as const) {
  for (const beforeStarted of [true, false]) {
    test(`${stage} abort ${beforeStarted ? "after thread creation" : "after onStarted"} remains discoverable by status without a workflow id`, async () => {
      const f = await fixture();
      try {
        const aborted = new AbortController();
        f.gateway.scripts[stage].push({ abort: aborted, beforeStarted });
        // A host may discard an aborted start's return value; recovery cannot depend on it.
        const start = stage === "planning"
          ? f.manager.start({ task: "Create a health check" }, f.exec("owner", aborted))
          : f.manager.reviewOnly({ task: "Review the health check", implementationSummary: "Read-only diagnostics", changedFiles: ["changed.txt"] }, f.exec("owner", aborted));
        await start.catch(() => undefined);
        const waiting = await f.manager.status(undefined, f.exec());
        assert.equal(waiting.processState, "waiting");
        assert.equal(waiting.retryState?.stage, stage);
        assert.equal(f.disposals.length, 0, "aborting the host tool retains the existing child");
        assert.equal(f.gateway.pins, 1);
        assert.equal(aborted.signal.aborted, true);
        assert.equal(f.childSignals[0]?.aborted, false, "the native child's lifetime is independent of the aborted host tool");
        const resumed = await f.manager.resume(waiting.id, "Continue", f.exec());
        assert.equal(resumed.phase, stage === "planning" ? "executing" : "passed");
        assert.equal(f.gateway.threadStarts.length, 1);
        assert.equal(f.children.length, 1);
        assert.equal(f.gateway.turnStarts[0]?.threadId, f.gateway.turnStarts.at(-1)?.threadId);
        assert.equal(f.gateway.pins, 0);
      } finally { await f.close(); }
    });
  }
}

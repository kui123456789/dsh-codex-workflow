import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewInput, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

function scope(record: WorkflowRecord) {
  return { id: record.id, dshSessionId: record.dshSessionId, cwd: record.cwd, task: record.task,
    mode: record.mode, origin: record.origin, createdAt: record.createdAt, reviewerModel: record.reviewerModel,
    reviewerEffort: record.reviewerEffort, questions: record.questions, assumptions: record.assumptions,
    planMarkdown: record.planMarkdown };
}

async function fixture(controls: { resolution?: ReturnType<typeof gate>; visible?: ReturnType<typeof gate>;
  duplicateVisible?: ReturnType<typeof gate> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-review-only-creation-admission-"));
  await writeFile(join(directory, "changed.txt"), "read-only configuration evidence", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const originalSave = store.save.bind(store);
  const threads: string[] = [];
  const modelCalls: string[] = [];
  const rawChildren: Session[] = [];
  const rawDisposals: string[] = [];
  const released: string[] = [];
  const deferred: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  let pins = 0;
  let resolverCalls = 0;
  const gateway: CodexGateway = {
    async resolveDefaultModel() {
      resolverCalls += 1;
      if (resolverCalls === 2) controls.resolution?.enter();
      await controls.resolution?.promise;
      return "resolved-creation-reviewer";
    },
    async startThread() { const id = `alignment-${threads.length + 1}`; threads.push(id); return id; },
    async startReviewerThread() { const id = `reviewer-${threads.length + 1}`; threads.push(id); return id; },
    async resumeThread() { throw new Error("Pre-admission failure has no original model thread"); },
    async startReview(options) {
      modelCalls.push("native");
      await options.onStarted?.({ threadId: options.threadId, turnId: "visible-review" });
      if (modelCalls.filter((stage) => stage === "native").length === 2) controls.duplicateVisible?.enter();
      controls.visible?.enter();
      await controls.visible?.promise;
      return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId,
        turnId: "visible-review", status: "completed",
        text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Configuration diagnostic is verified." } };
    },
    async normalizeInFork(options) {
      const alignment = options.prompt.includes("REVIEW AUTHORITY checker");
      modelCalls.push(alignment ? "alignment" : "conversion");
      await options.onStarted?.({ threadId: options.threadId, turnId: alignment ? "alignment" : "conversion" });
      return { kind: "completed", threadId: options.threadId, turnId: alignment ? "alignment" : "conversion", status: "completed",
        text: JSON.stringify(alignment ? { aligned: true, conflicts: [] }
          : { verdict: "pass", findings: [], testGaps: [], summary: "Configuration diagnostic is verified" }) };
    },
    async startTurn(): Promise<never> { throw new Error("No continuation or rewrite should be needed"); },
    async continueTurn(): Promise<never> { throw new Error("No original clarification exists"); },
    async interrupt() {},
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; },
  };
  const id = SessionId("review-only-creation-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const controller = new AbortController();
  const makeExec = (signal = new AbortController().signal) => ({ agent: parent, signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext);
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    rawChildren.push(session);
    return { agent: { id: session.id, session } as Agent, async dispose() { rawDisposals.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "unused-planner",
    reviewerModel: controls.resolution ? "" : "creation-reviewer", plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {},
    { get: (sessionId) => sessionId === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const input: ReviewInput = { implementationSummary: "Read-only configuration diagnostic implemented",
    changedFiles: ["changed.txt"], testResults: "Diagnostic input and output checked" };
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const start = () => track(manager.reviewOnly({ task: "Verify the local configuration diagnostic", ...input }, makeExec(controller.signal)));
  const assertFailure = async (before: WorkflowRecord, error: RegExp, durableDiagnostic = true) => {
    const records = await store.list();
    assert.equal(records.length, 1, "Pre-admission failure must keep its single original workflow");
    const current = records[0]!;
    assert.deepEqual(scope(current), scope(before));
    assert.deepEqual(threads, []);
    assert.deepEqual(modelCalls, []);
    assert.deepEqual(rawChildren, []);
    assert.deepEqual(rawDisposals, []);
    assert.deepEqual(released, []);
    assert.deepEqual(deferred, []);
    assert.equal(pins, 0);
    assert.equal(runtime.codexChildSessions.size, 0);
    assert.equal(runtime.activeTurns.size, 0);
    assert.equal(runtime.reviewHeartbeats.size, 0);
    assert.equal(runtime.recoverableRuns.size, 0);
    assert.equal(runtime.reviewFlights.size, 0);
    assert.equal(current.reviewCycles, 0);
    assert.equal(current.reviewAttempt ?? 0, 0);
    assert.equal(current.latestReview, undefined);
    assert.equal(current.latestReviewEvidence, undefined);
    if (!durableDiagnostic) assert.deepEqual(current, before,
      "A denied caller cannot change any field or revision protected by another manager's review lease");
    assert.equal(current.phase, "executing", "A durable workflow with no admitted Reviewer must permit an explicit same-id review");
    if (durableDiagnostic) {
      assert.equal(current.processState, "failed", "Pre-admission failure needs an explicit diagnostic without a terminal failed phase");
      assert.match(current.error ?? "", error);
    } else assert.notEqual(current.processState, "running", "The denied operation never started a Reviewer");
    assert.equal(current.retryState, undefined, "No thread exists to advertise as a continuation");
    const status = await manager.status(undefined, makeExec());
    assert.equal(status.id, before.id, "Status without a returned workflow id must still locate the durable workflow");
    assert.equal(status.phase, "executing");
    assert.equal(status.reviewerActive, false);
    assert.deepEqual(status.continuation, { available: false, reason: "not_waiting" });
    assert.deepEqual(await store.load(before.id), current, "Status must not turn an unstarted review into running progress");
    return current;
  };
  const retry = async (current: WorkflowRecord) => {
    const reviewed = await track(manager.review(current.id, input, makeExec()));
    assert.equal(reviewed.id, current.id);
    assert.deepEqual(scope(reviewed), scope(current));
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.reviewCycles, 1);
    assert.equal(reviewed.reviewAttempt, 1);
    assert.equal(reviewed.latestReview?.verdict, "pass");
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(modelCalls, ["native", "conversion", "alignment"]);
    assert.equal(rawChildren.length, 1);
    assert.deepEqual(rawDisposals, [rawChildren[0]!.id]);
    for (const thread of threads) assert.equal(released.filter((id) => id === thread).length, 1);
    assert.equal(pins, 0);
    assert.equal(runtime.codexChildSessions.size, 0);
    assert.equal(runtime.reviewHeartbeats.size, 0);
  };
  return { manager, store, originalSave, controller, start, assertFailure, retry, gateway, config, factory,
    parent, makeExec, input, track, threads, modelCalls, rawChildren, rawDisposals, runtime,
    get resolverCalls() { return resolverCalls; }, get pins() { return pins; },
    async close() {
      store.save = originalSave;
      await Promise.allSettled(tasks);
      await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("reviewOnly caller abort immediately after its real initial save preserves an addressable workflow for explicit review", async () => {
  const f = await fixture();
  const abort = new Error("caller aborted after durable review-only creation");
  let before: WorkflowRecord | undefined;
  f.store.save = async (record) => {
    await f.originalSave(record);
    before = await f.store.load(record.id);
    f.controller.abort(abort);
  };
  try {
    await assert.rejects(f.start(), (error) => error === abort, "The original caller abort must remain the returned diagnostic");
    assert.ok(before);
    const current = await f.assertFailure(before, /caller aborted after durable review-only creation/);
    await f.retry(current);
  } finally { await f.close(); }
});

test("reviewOnly denied by an actual competing review lease keeps its original workflow retryable without stealing the lease", async () => {
  const f = await fixture();
  const owner = "another-review-manager";
  let before: WorkflowRecord | undefined;
  let lease: { epoch: number; owner: string } | undefined;
  let resource: string | undefined;
  f.store.save = async (record) => {
    await f.originalSave(record);
    before = await f.store.load(record.id);
    resource = `review:${record.id}`;
    lease = f.store.coordinationHandle.acquireLease(resource, 60_000, owner);
    assert.ok(lease, "The other manager actually owns the freshly persisted workflow's review lease");
  };
  try {
    await assert.rejects(f.start(), /already has an admitted review in another manager/);
    assert.ok(before);
    assert.ok(lease);
    assert.ok(resource);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, lease.epoch, lease.owner), true,
      "Failed review-only admission cannot release a competing manager's lease");
    const current = await f.assertFailure(before, /already has an admitted review in another manager/, false);
    assert.equal(f.store.coordinationHandle.releaseLease(resource, lease.epoch, lease.owner), true);
    lease = undefined;
    await f.retry(current);
  } finally {
    if (lease && resource) f.store.coordinationHandle.releaseLease(resource, lease.epoch, lease.owner);
    await f.close();
  }
});

test("two managers resolving the same session's reviewOnly model admit one workflow and one native Reviewer", async () => {
  const resolution = gate();
  const visible = gate();
  const duplicateVisible = gate();
  const f = await fixture({ resolution, visible, duplicateVisible });
  const secondStore = new WorkflowStore(f.store.directory);
  const second = new WorkflowManager(secondStore, f.gateway, f.config, undefined, undefined, undefined, {},
    { get: (sessionId) => sessionId === f.parent.id ? f.parent : undefined }, f.factory);
  const firstTask = f.start();
  const secondTask = f.track(second.reviewOnly({ task: "Verify the local configuration diagnostic", ...f.input }, f.makeExec()));
  const observe = (task: Promise<WorkflowRecord>) => task.then(
    (value) => ({ status: "fulfilled", value } as const),
    (reason: unknown) => ({ status: "rejected", reason } as const));
  const firstOutcome = observe(firstTask);
  const secondOutcome = observe(secondTask);
  try {
    await Promise.race([resolution.entered, firstOutcome.then((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      throw new Error("The first review completed before both initial model resolutions were held");
    }), secondOutcome.then((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      throw new Error("The second review completed before both initial model resolutions were held");
    })]);
    assert.equal(f.resolverCalls, 2, "Both public calls passed their initial active-workflow check before awaiting model resolution");
    assert.deepEqual(await f.store.list(), [], "Neither call has saved its workflow before the resolver gate opens");
    resolution.release();
    await Promise.race([visible.entered, Promise.all([firstOutcome, secondOutcome]).then(() => {
      throw new Error("Both calls settled without one admitted native review");
    })]);
    const admission = await Promise.race([
      duplicateVisible.entered.then(() => ({ kind: "duplicate" } as const)),
      firstOutcome.then((outcome) => ({ kind: "settled", outcome } as const)),
      secondOutcome.then((outcome) => ({ kind: "settled", outcome } as const)),
    ]);
    const records = await f.store.list();
    assert.deepEqual({ records: records.length, children: f.rawChildren.length,
      reviewerThreads: f.threads.filter((id) => id.startsWith("reviewer-")).length,
      nativeTurns: f.modelCalls.filter((stage) => stage === "native").length }, {
      records: 1, children: 1, reviewerThreads: 1, nativeTurns: 1,
    }, "The creation lease must serialize the post-resolution check and save across managers");
    assert.equal(admission.kind, "settled", "The losing call must reject before creating another native Reviewer");
    if (admission.kind === "settled") {
      assert.equal(admission.outcome.status, "rejected");
      if (admission.outcome.status === "rejected") assert.match(String(admission.outcome.reason),
        /already has active Codex workflow|already creating a Codex workflow/);
    }
    assert.equal(records[0]!.dshSessionId, f.parent.id);
    assert.equal(records[0]!.reviewCycles, 0, "The admitted original model is still held and has applied no verdict");
    assert.equal(records[0]!.processState, "running");
    visible.release();
    const completed = await Promise.all([firstOutcome, secondOutcome]);
    assert.equal(completed.filter((outcome) => outcome.status === "rejected").length, 1);
    const accepted = completed.find((outcome) => outcome.status === "fulfilled");
    assert.ok(accepted && accepted.status === "fulfilled");
    assert.equal(accepted.value.id, records[0]!.id);
    assert.equal(accepted.value.phase, "passed");
    assert.equal(accepted.value.reviewCycles, 1);
    assert.equal((await f.store.list()).length, 1);
    assert.deepEqual(f.modelCalls, ["native", "conversion", "alignment"]);
    assert.deepEqual(f.rawDisposals, [f.rawChildren[0]!.id]);
    assert.equal(f.pins, 0);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(f.runtime.reviewHeartbeats.size, 0);
  } finally {
    resolution.release(); visible.release();
    await Promise.allSettled([firstTask, secondTask]);
    await second.stop(); secondStore.close(); await f.close();
  }
});

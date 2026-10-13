import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ReviewObservation } from "../src/application/review-observation.js";
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

async function fixture(firstCreation: "throw" | "hold" | "normal") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-foreground-review-startup-"));
  await writeFile(join(directory, "changed.txt"), "read-only verified configuration", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const creation = gate();
  const rawChildren: Session[] = [];
  const rawDisposals: string[] = [];
  const createdSnapshots: WorkflowRecord[] = [];
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const modelCalls: string[] = [];
  const released: string[] = [];
  const deferred: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  let childCreates = 0;
  let pins = 0;
  const gateway: CodexGateway = {
    async startThread() { const id = `private-${privateThreads.length + 1}`; privateThreads.push(id); return id; },
    async startReviewerThread() { const id = `reviewer-${reviewerThreads.length + 1}`; reviewerThreads.push(id); return id; },
    async resumeThread() { throw new Error("Startup failure has no original Reviewer to resume"); },
    async startReview(options) {
      modelCalls.push("native");
      await options.onStarted?.({ threadId: options.threadId, turnId: "visible-review" });
      return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId,
        turnId: "visible-review", status: "completed",
        text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Read-only configuration diagnostic is verified." } };
    },
    async normalizeInFork(options) {
      const alignment = options.prompt.includes("REVIEW AUTHORITY checker");
      modelCalls.push(alignment ? "alignment" : "conversion");
      await options.onStarted?.({ threadId: options.threadId, turnId: alignment ? "alignment" : "conversion" });
      return { kind: "completed", threadId: options.threadId, turnId: alignment ? "alignment" : "conversion", status: "completed",
        text: JSON.stringify(alignment ? { aligned: true, conflicts: [] }
          : { verdict: "pass", findings: [], testGaps: [], summary: "Read-only configuration diagnostic is verified" }) };
    },
    async startTurn(): Promise<never> { throw new Error("The aligned startup fixture must not need another visible turn"); },
    async continueTurn(): Promise<never> { throw new Error("Startup fixture has no clarification answers"); },
    async interrupt() {},
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; },
  };
  const id = SessionId("foreground-startup-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const controller = new AbortController();
  const makeExec = (signal = new AbortController().signal) => ({ agent: parent, signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext);
  const exec = makeExec(controller.signal);
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    childCreates += 1;
    const records = await store.list();
    assert.equal(records.length, 1, "Public reviewOnly must have persisted exactly one workflow before child creation");
    createdSnapshots.push(records[0]!);
    if (childCreates === 1 && firstCreation === "throw") throw new Error("injected native child creation failure");
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    rawChildren.push(session);
    if (childCreates === 1 && firstCreation === "hold") { creation.enter(); await creation.promise; }
    return { agent: { id: session.id, session } as Agent, async dispose() { rawDisposals.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "unused-planner",
    reviewerModel: "startup-reviewer", plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {},
    { get: (sessionId) => sessionId === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const input: ReviewInput = { implementationSummary: "Read-only local configuration diagnostic implemented",
    changedFiles: ["changed.txt"], testResults: "Configuration input and output checked" };
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const start = () => track(manager.reviewOnly({ task: "Verify read-only local configuration diagnostic", ...input }, exec));
  const assertNoModel = () => {
    assert.deepEqual(reviewerThreads, []);
    assert.deepEqual(privateThreads, []);
    assert.deepEqual(modelCalls, []);
    assert.deepEqual(released, []);
    assert.deepEqual(deferred, []);
    assert.equal(pins, 0);
    assert.equal(runtime.codexChildSessions.size, 0);
    assert.equal(runtime.activeTurns.size, 0);
    assert.equal(runtime.reviewHeartbeats.size, 0);
    assert.equal(runtime.recoverableRuns.size, 0);
    assert.equal(runtime.reviewFlights.size, 0);
  };
  const assertRetryable = async (before: WorkflowRecord, reason: RegExp) => {
    const records = await store.list();
    assert.equal(records.length, 1, "Failed startup cannot replace its persisted workflow");
    const current = records[0]!;
    assert.deepEqual(scope(current), scope(before));
    assert.equal(current.phase, "executing", "Failed reviewOnly startup must leave a phase admitted by public review");
    assert.equal(current.processState, "failed", "Startup failure must have an explicit retryable diagnostic");
    assert.match(current.error ?? "", reason);
    assert.equal(current.reviewCycles, 0);
    assert.equal(current.reviewAttempt ?? 0, 0, "A failed observation transaction did not start an attempt");
    assert.equal(current.latestReview, undefined);
    assert.equal(current.latestReviewEvidence, undefined);
    assert.equal(current.retryState, undefined, "No original Reviewer was started, so no thread recovery can be advertised");
    assert.equal(current.activeTurnId, undefined);
    assert.equal(current.reviewStartedAt, undefined);
    assertNoModel();
    return current;
  };
  const retry = async (record: WorkflowRecord) => {
    const reviewed = await track(manager.review(record.id, input, makeExec()));
    assert.equal(reviewed.id, record.id);
    assert.deepEqual(scope(reviewed), scope(record));
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.processState, "completed");
    assert.equal(reviewed.reviewCycles, 1);
    assert.equal(reviewed.reviewAttempt, 1);
    assert.equal(reviewed.latestReview?.verdict, "pass");
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(modelCalls, ["native", "conversion", "alignment"]);
    assert.equal(reviewerThreads.length, 1);
    assert.equal(runtime.codexChildSessions.size, 0);
    assert.equal(runtime.reviewHeartbeats.size, 0);
    assert.equal(pins, 0);
    for (const child of rawChildren) assert.equal(rawDisposals.filter((id) => id === child.id).length, 1);
    for (const thread of [...reviewerThreads, ...privateThreads]) assert.equal(released.filter((id) => id === thread).length, 1);
  };
  return { store, manager, runtime, start, retry, assertRetryable, createdSnapshots, rawChildren, rawDisposals,
    creation, controller,
    async close() {
      creation.release(); await Promise.allSettled(tasks);
      await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("public reviewOnly native child creation failure leaves its original workflow retryable without a Reviewer", async () => {
  const f = await fixture("throw");
  try {
    await assert.rejects(f.start(), /injected native child creation failure/);
    assert.deepEqual(f.rawChildren, []);
    assert.deepEqual(f.rawDisposals, []);
    const current = await f.assertRetryable(f.createdSnapshots[0]!, /injected native child creation failure/);
    await f.retry(current);
  } finally { await f.close(); }
});

test("public reviewOnly caller abort during raw native creation disposes the returned handle and admits same-workflow retry", async () => {
  const f = await fixture("hold");
  try {
    const pending = f.start();
    const settled = Promise.allSettled([pending]);
    await Promise.race([f.creation.entered, settled.then(([outcome]) => {
      if (outcome?.status === "rejected") throw outcome.reason;
      throw new Error("Review completed before its native child creation barrier");
    })]);
    const before = f.createdSnapshots[0]!;
    assert.equal(f.rawChildren.length, 1);
    const child = f.rawChildren[0]!;
    f.controller.abort(new Error("injected caller startup abort"));
    f.creation.release();
    const outcome = (await settled)[0]!;
    assert.equal(outcome.status, "rejected");
    assert.match(String(outcome.reason), /injected caller startup abort/);
    assert.deepEqual(f.rawDisposals, [child.id], "The handle returned after caller abort is disposed exactly once");
    const current = await f.assertRetryable(before, /injected caller startup abort/);
    await f.retry(current);
  } finally { f.creation.release(); await f.close(); }
});

test("public reviewOnly observation transaction failure rolls back progress and disposes its created native child before retry", async () => {
  const f = await fixture("normal");
  const observation = (f.manager as unknown as { reviewObservation: ReviewObservation }).reviewObservation;
  const originalBegin = observation.begin.bind(observation);
  const originalUpdate = f.store.update.bind(f.store);
  const barrier = gate();
  let insideBegin = false;
  let injected = false;
  let before: WorkflowRecord | undefined;
  let rolledBack: WorkflowRecord | undefined;
  observation.begin = async (...args) => {
    insideBegin = true;
    try { return await originalBegin(...args); }
    finally { insideBegin = false; }
  };
  f.store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, options?: Parameters<typeof originalUpdate>[2]) => {
    if (!insideBegin || injected) return originalUpdate(id, mutate, options);
    injected = true;
    before = await f.store.load(id);
    barrier.enter();
    await barrier.promise;
    try {
      return await originalUpdate<T>(id, (record) => {
        mutate(record);
        throw new Error("injected review observation transaction failure");
      }, options);
    } catch (error) { rolledBack = await f.store.load(id); throw error; }
  };
  try {
    const pending = f.start();
    const settled = Promise.allSettled([pending]);
    await Promise.race([barrier.entered, settled.then(([outcome]) => {
      if (outcome?.status === "rejected") throw outcome.reason;
      throw new Error("Review completed before its observation transaction barrier");
    })]);
    assert.ok(before);
    assert.equal(f.rawChildren.length, 1);
    const child = f.rawChildren[0]!;
    assert.equal(f.runtime.codexChildSessions.get(before.id)?.id, child.id);
    barrier.release();
    const outcome = (await settled)[0]!;
    assert.equal(outcome.status, "rejected");
    assert.match(String(outcome.reason), /injected review observation transaction failure/);
    assert.deepEqual(rolledBack, before, "The actual failed SQLite transaction rolls back every progress field and revision");
    assert.deepEqual(f.rawDisposals, [child.id]);
    const current = await f.assertRetryable(before, /injected review observation transaction failure/);
    await f.retry(current);
  } finally {
    barrier.release(); observation.begin = originalBegin; f.store.update = originalUpdate; await f.close();
  }
});

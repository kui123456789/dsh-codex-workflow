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
import { newRequestId, type BridgeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway, type ManagerLease } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture(point?: "lease_release" | "child_create") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-child-adoption-"));
  await writeFile(join(directory, "changed.txt"), "verified read-only diagnostic", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const barrier = gate();
  const callbacks: string[] = [];
  const modelThreads: string[] = [];
  const rawChildren: Session[] = [];
  const rawDisposals: string[] = [];
  const commands: BridgeCommand[] = [];
  const tasks: Promise<unknown>[] = [];
  const callback: CodexCallback = {
    async send(request) { callbacks.push(request.submissionId); return { kind: "verdict", verdict: {
      verdict: "pass", findings: [], testGaps: [], summary: "Approved diagnostic verified" } }; },
    cancel() {}, cancelSubmission() {}, async stop() {},
  };
  const gateway: CodexGateway = {
    async startThread() { const id = `alignment-${modelThreads.length + 1}`; modelThreads.push(id); return id; },
    async resumeThread() { throw new Error("No original thread should be resumed during child adoption"); },
    async startTurn(): Promise<never> { throw new Error("No model provider is part of this child adoption fixture"); },
    async startReview(): Promise<never> { throw new Error("Bridge reviews use the callback entry"); },
    async continueTurn(): Promise<never> { throw new Error("No native clarification in this child adoption fixture"); },
    async normalizeInFork(options) { return { kind: "completed", threadId: options.threadId, turnId: "alignment",
      status: "completed", text: JSON.stringify({ aligned: true, conflicts: [] }) }; },
    async interrupt() {}, async unsubscribeThread() {}, beginRound() {}, endRound() {},
  };
  const id = SessionId("bridge-child-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    rawChildren.push(session);
    if (point === "child_create" && rawChildren.length === 1) { barrier.enter(); await barrier.promise; }
    return { agent: { id: session.id, session } as Agent, async dispose() { rawDisposals.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {}, { get: (sessionId) => sessionId === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const internal = manager as unknown as { acquireWorkflowSubmitLease(workflowId: string): Promise<ManagerLease | undefined> };
  const acquire = internal.acquireWorkflowSubmitLease.bind(manager);
  if (point === "lease_release") {
    internal.acquireWorkflowSubmitLease = async (workflowId) => {
      const lease = await acquire(workflowId);
      assert.ok(lease);
      const release = lease.release.bind(lease);
      let held = false;
      lease.release = async () => {
        const released = await release();
        if (!held) { held = true; barrier.enter(); await barrier.promise; }
        return released;
      };
      return lease;
    };
  }
  const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: id },
    task: "Implement and review a read-only local diagnostic", planMarkdown: "<proposed_plan>\nInspect local health without changing user data.\n</proposed_plan>", assumptions: [] }, parent);
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const submit = () => track(manager.submit(record.id, { implementationSummary: "Read-only diagnostic implemented", changedFiles: ["changed.txt"] }, exec));
  const waitReceived = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const current = await store.load(record.id);
      assert.ok(current);
      if (current.submissionState === "received" && !current.submissionLeaseToken) return current;
      if (Date.now() > deadline) throw new Error(`Submission did not become received: ${current.submissionState}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { manager, store, record, parent, exec, directory, factory, runtime, barrier, callbacks, modelThreads, rawChildren,
    rawDisposals, commands, submit, waitReceived,
    async close() {
      barrier.release(); await Promise.allSettled(tasks);
      internal.acquireWorkflowSubmitLease = acquire;
      await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Bridge ownership changed after the actual submit-lease release cannot create a child or start callback", async () => {
  const f = await fixture("lease_release");
  try {
    const pending = f.submit();
    const settled = Promise.allSettled([pending]);
    await f.barrier.entered;
    const prepared = await f.store.load(f.record.id);
    assert.equal(prepared?.submissionState, "queued", "The submission CAS already committed before this gate");
    assert.ok(prepared.submissionId);
    assert.equal(f.rawChildren.length, 0);
    const changed = await f.store.update(f.record.id, (record) => {
      record.dshSessionId = "new-owner";
      record.task = "A changed approved task";
    });
    f.barrier.release();
    const outcome = (await settled)[0]!;
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    assert.deepEqual({ outcome: outcome.status, childCreates: f.rawChildren.length, callbacks: f.callbacks.length,
      modelThreads: f.modelThreads.length }, { outcome: "rejected", childCreates: 0, callbacks: 0, modelThreads: 0 },
    "A prepared snapshot cannot authorize a child after the current owner or task changed");
    assert.deepEqual(await f.store.load(f.record.id), changed.record, "Old ReviewObservation.begin and cleanup must not mutate the displaced row or revision");
    assert.equal(f.runtime.codexChildSessions.size, 0);
  } finally { await f.close(); }
});

test("a late native child cannot overwrite a replacement handle or observe a foreign submission", async () => {
  const f = await fixture("child_create");
  let replacement: Awaited<ReturnType<CodexChildSessionFactory["create"]>> | undefined;
  try {
    const pending = f.submit();
    const settled = Promise.allSettled([pending]);
    await f.barrier.entered;
    const originalChild = f.rawChildren[0]!;
    const changed = await f.store.update(f.record.id, (record) => {
      record.dshSessionId = "new-owner";
      record.submissionId = "replacement-submission";
    });
    replacement = await f.factory.create(f.parent, f.directory, "Replacement conversation", "Another admitted conversation", new AbortController().signal);
    f.runtime.codexChildSessions.set(f.record.id, replacement);
    f.barrier.release();
    const outcome = (await settled)[0]!;
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    assert.deepEqual({ outcome: outcome.status,
      replacementPreserved: f.runtime.codexChildSessions.get(f.record.id) === replacement,
      originalRawDisposals: f.rawDisposals.filter((id) => id === originalChild.id).length,
      replacementRawDisposals: f.rawDisposals.filter((id) => id === replacement!.id).length }, {
      outcome: "rejected", replacementPreserved: true, originalRawDisposals: 1, replacementRawDisposals: 0,
    }, "The unadmitted late child must be disposed without replacing or disposing the current conversation");
    assert.deepEqual(f.callbacks, []);
    assert.deepEqual(f.modelThreads, []);
    assert.equal(f.runtime.codexChildSessions.get(f.record.id), replacement, "Late adoption must preserve the actual replacement handle");
    assert.deepEqual(f.rawDisposals, [originalChild.id], "Only the unadmitted native Agent handle is disposed, exactly once");
    assert.deepEqual(await f.store.load(f.record.id), changed.record, "Old progress and failed-start cleanup cannot overwrite the foreign submission");
    assert.equal(f.commands.length, 0);
  } finally { f.barrier.release(); await f.close(); }
});

test("valid Bridge child adoption preserves native conversation ownership and stages one callback verdict", async () => {
  const f = await fixture();
  try {
    const submitted = await f.submit();
    const received = await f.waitReceived();
    assert.equal(submitted.dshSessionId, f.parent.id);
    assert.equal(received.submissionId, submitted.submissionId);
    assert.equal(f.rawChildren.length, 1);
    assert.deepEqual(f.callbacks, [submitted.submissionId]);
    assert.equal(f.rawChildren[0]!.header.parentSession, f.parent.id);
    assert.deepEqual(f.rawDisposals, [f.rawChildren[0]!.id]);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    const command = f.commands.find((value): value is SubmitVerdictCommand => value.kind === "submit_verdict");
    assert.ok(command);
    assert.deepEqual(command, received.stagedVerdict?.command);
    assert.equal((await f.manager.applyExternalVerdict(command)).reviewCycles, 1);
  } finally { await f.close(); }
});

test("Bridge review-start observation checks prepared ownership inside the actual transaction", async () => {
  const f = await fixture();
  const observation = gate();
  const originalUpdate = f.store.update.bind(f.store);
  const reviewObservation = (f.manager as unknown as { reviewObservation: ReviewObservation }).reviewObservation;
  const originalBegin = reviewObservation.begin.bind(reviewObservation);
  let insideBegin = false;
  let observationError: unknown;
  let delayed = false;
  reviewObservation.begin = async (...args) => {
    insideBegin = true;
    try { return await originalBegin(...args); }
    catch (error) { observationError = error; throw error; }
    finally { insideBegin = false; }
  };
  f.store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, options?: Parameters<typeof originalUpdate>[2]) => {
    // Hold before the transaction executes its guard, after the real child
    // exists and the asynchronous prepared-record check already completed.
    if (!delayed && insideBegin && id === f.record.id) {
      delayed = true;
      observation.enter();
      await observation.promise;
    }
    return originalUpdate<T>(id, mutate, options);
  };
  try {
    const pending = f.submit();
    const settled = Promise.allSettled([pending]);
    await Promise.race([observation.entered, settled.then(([outcome]) => {
      if (outcome?.status === "rejected") throw outcome.reason;
      throw new Error("Submission settled before the review observation transaction barrier");
    })]);
    assert.equal(f.rawChildren.length, 1);
    const child = f.rawChildren[0]!;
    assert.equal(f.runtime.codexChildSessions.get(f.record.id)?.id, child.id);
    const prepared = await f.store.load(f.record.id);
    assert.equal(prepared?.reviewAttempt, 0);
    assert.equal(prepared?.reviewStartedAt, undefined);
    const changed = await originalUpdate(f.record.id, (record) => {
      record.dshSessionId = "new-owner";
      record.task = "A changed task before observation commit";
    });
    observation.release();
    const outcome = (await settled)[0]!;
    assert.equal(outcome.status, "rejected");
    assert.match(String(observationError), /review startup no longer owns this scope/,
      "The actual observation transaction must reject its stale prepared ownership");
    assert.match(String(outcome.reason), /workflow belongs to another DSH session/,
      "Submission cleanup must preserve the changed owner's admission rejection");
    assert.deepEqual(await f.store.load(f.record.id), changed.record,
      "ReviewObservation.begin must reject the transaction without changing progress fields or revision");
    assert.deepEqual(f.callbacks, []);
    assert.deepEqual(f.modelThreads, []);
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.rawDisposals, [child.id]);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(f.runtime.reviewHeartbeats.size, 0, "A rejected review-start commit must not arm progress timers");
  } finally {
    observation.release(); f.store.update = originalUpdate; reviewObservation.begin = originalBegin; await f.close();
  }
});

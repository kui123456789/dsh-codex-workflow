import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ReviewObservation } from "../src/application/review-observation.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { BridgeStore } from "../src/bridge-store.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

test("a late revoked Bridge callback cannot change the replacement owner's completed progress, revision or review-end event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-review-progress-fence-"));
  await writeFile(join(directory, "changed.txt"), "v1 verified local evidence", "utf8");
  const storeA = new WorkflowStore(directory);
  const storeB = new WorkflowStore(directory);
  const queueA = new BridgeStore(directory);
  const queueB = new BridgeStore(directory);
  const callbackAEntered = gate();
  const callbackAResult = gate();
  const callbackACancelled = gate();
  const sentA: string[] = [];
  const sentB: string[] = [];
  const alignmentCalls: string[] = [];
  const released: string[] = [];
  const lateWrites: Array<{ stack: string; beforeRevision?: number; afterRevision?: number }> = [];
  let pins = 0;
  let captureLateWrites = false;
  const originalUpdate = storeA.update.bind(storeA);
  storeA.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, options?: Parameters<typeof originalUpdate>[2]) => {
    const before = captureLateWrites ? storeA.coordinationHandle.loadWorkflow(id) : undefined;
    const stack = captureLateWrites ? new Error("late callback write trace").stack ?? "" : "";
    const outcome = await originalUpdate(id, mutate, options);
    const after = before ? storeA.coordinationHandle.loadWorkflow(id) : undefined;
    if (before && after && before.revision !== after.revision) lateWrites.push({ stack,
      beforeRevision: before.revision, afterRevision: after.revision });
    return outcome;
  };
  const callbackA: CodexCallback = {
    async send(request) {
      sentA.push(request.submissionId);
      callbackAEntered.enter();
      // Model the external request's handle while the unref'ed lease watcher runs.
      let lifetime: NodeJS.Timeout | undefined;
      try {
        await Promise.race([callbackAResult.promise, new Promise<never>((_resolve, reject) => {
          lifetime = setTimeout(() => reject(new Error("Fake Bridge callback exceeded its fixture lifetime")), 10_000);
        })]);
      } finally { clearTimeout(lifetime); }
      return { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "A's superseded verdict" } };
    },
    cancel() {}, cancelSubmission() { callbackACancelled.enter(); }, async stop() { callbackAResult.release(); },
  };
  const callbackB: CodexCallback = {
    async send(request) {
      sentB.push(request.submissionId);
      return { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "B's accepted verdict" } };
    },
    cancel() {}, cancelSubmission() {}, async stop() {},
  };
  const gateway: CodexGateway = {
    async startThread() { return `alignment-${alignmentCalls.length + 1}`; },
    async normalizeInFork(options) {
      assert.match(options.prompt, /REVIEW AUTHORITY checker/);
      alignmentCalls.push(options.threadId);
      return { kind: "completed", threadId: options.threadId, turnId: "authority", status: "completed",
        text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async resumeThread(): Promise<never> { throw new Error("No model or recovered process belongs to this local fixture"); },
    async startTurn(): Promise<never> { throw new Error("Callbacks are local; no visible model may be started"); },
    async startReview(): Promise<never> { throw new Error("Callbacks are local; no visible model may be started"); },
    async continueTurn(): Promise<never> { throw new Error("No native clarification belongs to this fixture"); },
    async interrupt() {}, async unsubscribeThread(threadId) { released.push(threadId); },
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, leaseTtlMs: 10_000, storageDir: directory };
  const id = SessionId("bridge-progress-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const agents = { get: (sessionId: string) => sessionId === parent.id ? parent : undefined };
  const instanceA = new WorkflowManager(storeA, gateway, config, callbackA, queueA, undefined, {}, agents);
  const instanceB = new WorkflowManager(storeB, gateway, config, callbackB, queueB, undefined, {}, agents);
  const runtimeA = (instanceA as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const runtimeB = (instanceB as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  let submit: Promise<WorkflowRecord> | undefined;
  try {
    const bridge = await instanceA.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: parent.id },
      task: "Read-only configuration diagnostic", planMarkdown: "<proposed_plan>\nVerify valid and missing configuration.\n</proposed_plan>", assumptions: [] }, parent);
    submit = instanceA.submit(bridge.id, { implementationSummary: "Diagnostic implemented", changedFiles: ["changed.txt"] }, exec);
    void submit.catch(() => undefined);
    await submit;
    await callbackAEntered.entered;
    const original = await storeA.load(bridge.id);
    assert.ok(original?.submissionId);
    assert.ok(original.submissionLeaseToken);
    assert.ok(original.submissionLeaseEpoch !== undefined);
    const resource = `submission:${bridge.id}:${original.submissionId}`;
    assert.equal(storeA.coordinationHandle.isLeaseOwner(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true);
    assert.equal(storeA.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true,
      "The original live owner is actually revoked before B takes over");
    assert.equal(await instanceB.recoverCallbacks(), 1);
    await Promise.allSettled([...runtimeB.backgroundTasks]);
    await callbackACancelled.entered;
    const completed = await storeB.load(bridge.id);
    assert.ok(completed);
    assert.equal(completed.submissionState, "received");
    assert.equal(completed.stagedVerdict?.command.verdict.summary, "B's accepted verdict");
    assert.equal(completed.submissionLeaseToken, undefined, "B's actual background finalizer has released its lease fence");
    assert.deepEqual(sentA, [original.submissionId]);
    assert.deepEqual(sentB, [original.submissionId]);
    const durableBefore = storeB.coordinationHandle.loadWorkflow(bridge.id);
    const queueBefore = queueB.coordinationHandle.queueRow(completed.stagedVerdict!.command.requestId);
    assert.ok(queueBefore);
    assert.equal(queueBefore.status, "inbox");
    assert.equal(JSON.parse(queueBefore.commandJson).verdict.summary, "B's accepted verdict");
    const queueCountBefore = queueB.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get();
    assert.equal(Number(queueCountBefore?.count), 1);
    const eventsBefore = parent.session.snapshotEvents();
    const backendBefore = { alignmentCalls: [...alignmentCalls], released: [...released], pins };
    captureLateWrites = true;
    callbackAResult.release();
    await Promise.allSettled([...runtimeA.backgroundTasks]);
    const writeOrigins = lateWrites.map((entry) => entry.stack.split("\n").find((line) => line.includes("ReviewObservation.finish"))).filter(Boolean);
    assert.deepEqual(await storeB.load(bridge.id), completed,
      `A's late callback finalizer cannot change any completed B progress field or revision; observed late writers: ${writeOrigins.join("; ")}`);
    assert.deepEqual(storeB.coordinationHandle.loadWorkflow(bridge.id), durableBefore,
      "Even a no-op old-owner mutation must not commit a new durable revision");
    assert.deepEqual(lateWrites, [], "Revoked callbacks cannot publish progress through ReviewObservation.finish or lease cleanup");
    assert.deepEqual(parent.session.snapshotEvents(), eventsBefore,
      "A late old owner cannot publish an extra review-end event for B's completed attempt");
    assert.deepEqual(queueB.coordinationHandle.queueRow(completed.stagedVerdict!.command.requestId), queueBefore);
    assert.deepEqual(queueB.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get(), queueCountBefore);
    assert.deepEqual({ alignmentCalls, released, pins }, backendBefore);
    assert.equal(runtimeA.reviewHeartbeats.size, 0);
    assert.equal(runtimeB.reviewHeartbeats.size, 0);
  } finally {
    captureLateWrites = false; callbackAResult.release();
    if (submit) await Promise.allSettled([submit]);
    await instanceA.stop(); await instanceB.stop(); storeA.update = originalUpdate;
    queueA.close(); queueB.close(); storeA.close(); storeB.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bridge finalization checks actual SQL lease ownership inside its transaction even when the old record fence still matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-finish-transaction-fence-"));
  await writeFile(join(directory, "changed.txt"), "verified finalization evidence", "utf8");
  const store = new WorkflowStore(directory);
  const queue = new BridgeStore(directory);
  const finalization = gate();
  let cancellations = 0;
  let callbacks = 0;
  const callback: CodexCallback = {
    async send() {
      callbacks += 1;
      return { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "Original completed review" } };
    },
    cancel() {}, cancelSubmission() { cancellations += 1; }, async stop() {},
  };
  const gateway: CodexGateway = {
    async startThread() { return "private-finalization-alignment"; },
    async normalizeInFork(options) {
      assert.match(options.prompt, /REVIEW AUTHORITY checker/);
      return { kind: "completed", threadId: options.threadId, turnId: "alignment", status: "completed",
        text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async resumeThread(): Promise<never> { throw new Error("No original visible model is part of this fixture"); },
    async startTurn(): Promise<never> { throw new Error("No visible model is part of this fixture"); },
    async startReview(): Promise<never> { throw new Error("No visible model is part of this fixture"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification is part of this fixture"); },
    async interrupt() {}, async unsubscribeThread() {}, beginRound() {}, endRound() {},
  };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, leaseTtlMs: 10_000, storageDir: directory };
  const id = SessionId("bridge-finish-transaction-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const manager = new WorkflowManager(store, gateway, config, callback, queue, undefined, {},
    { get: (sessionId) => sessionId === parent.id ? parent : undefined });
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const observation = (manager as unknown as { reviewObservation: ReviewObservation }).reviewObservation;
  const originalFinish = observation.finish.bind(observation);
  const originalUpdate = store.update.bind(store);
  let insideFinish = false;
  let held = false;
  let finishGuardError: unknown;
  let submit: Promise<WorkflowRecord> | undefined;
  let resource: string | undefined;
  let replacement: { epoch: number; owner: string } | undefined;
  observation.finish = async (...args) => {
    assert.equal(typeof args[4], "function", "The real Bridge finalizer supplies its actual lease guard");
    insideFinish = true;
    try { return await originalFinish(...args); }
    finally { insideFinish = false; }
  };
  store.update = async <T>(workflowId: string, mutate: (record: WorkflowRecord) => T, options?: Parameters<typeof originalUpdate>[2]) => {
    if (!insideFinish || held) return originalUpdate(workflowId, mutate, options);
    held = true;
    finalization.enter();
    await finalization.promise;
    try { return await originalUpdate(workflowId, mutate, options); }
    catch (error) { finishGuardError = error; throw error; }
  };
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  try {
    const bridge = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: parent.id },
      task: "Verify local configuration", planMarkdown: "<proposed_plan>\nInspect current configuration.\n</proposed_plan>", assumptions: [] }, parent);
    submit = manager.submit(bridge.id, { implementationSummary: "Diagnostic verified", changedFiles: ["changed.txt"] }, exec);
    void submit.catch(() => undefined);
    await submit;
    await Promise.race([finalization.entered, Promise.allSettled([...runtime.backgroundTasks]).then(async () => {
      const settled = await store.load(bridge.id);
      throw new Error(`Callback settled before the actual finalization transaction barrier: ${settled?.submissionState}; ${settled?.submissionError ?? settled?.error ?? "no diagnostic"}`);
    })]);
    assert.equal(runtime.reviewHeartbeats.size, 0, "The original callback has already stopped its heartbeat before finalization");
    assert.equal(cancellations, 0, "No early lease-loss notification can explain this transaction refusal");
    const before = await store.load(bridge.id);
    assert.ok(before?.submissionId);
    assert.equal(before.submissionState, "received");
    assert.ok(before.submissionLeaseToken);
    assert.ok(before.submissionLeaseEpoch !== undefined);
    const durableBefore = store.coordinationHandle.loadWorkflow(bridge.id);
    const eventsBefore = parent.session.snapshotEvents();
    const queueBefore = queue.coordinationHandle.queueRow(before.stagedVerdict!.command.requestId);
    resource = `submission:${bridge.id}:${before.submissionId}`;
    assert.equal(store.coordinationHandle.releaseLease(resource, before.submissionLeaseEpoch, before.submissionLeaseToken), true);
    replacement = store.coordinationHandle.acquireLease(resource, 10_000, "replacement-manager-before-finish-commit");
    assert.ok(replacement);
    assert.ok(replacement.epoch > before.submissionLeaseEpoch);
    assert.deepEqual(await store.load(bridge.id), before,
      "The takeover changes only the actual SQL lease; the workflow's original token and epoch still match");
    finalization.release();
    await Promise.allSettled([...runtime.backgroundTasks]);
    assert.match(String(finishGuardError), /review finalization no longer owns this scope/,
      "The guard inside the actual SQLite mutation must refuse the old owner's final observation");
    assert.equal(cancellations, 0, "The stopped heartbeat did not supply an early leaseLost shortcut");
    assert.equal(store.coordinationHandle.isLeaseOwner(resource, replacement.epoch, replacement.owner), true,
      "The original owner's stale release cannot clear the replacement's actual lease");
    assert.deepEqual(await store.load(bridge.id), before,
      "The rejected finalizer and its later cleanup cannot change progress, fence fields, timestamps or revision");
    assert.deepEqual(store.coordinationHandle.loadWorkflow(bridge.id), durableBefore);
    assert.deepEqual(parent.session.snapshotEvents(), eventsBefore);
    assert.deepEqual(queue.coordinationHandle.queueRow(before.stagedVerdict!.command.requestId), queueBefore);
    assert.equal(callbacks, 1);
    assert.equal(Number(queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 1);
  } finally {
    finalization.release();
    if (submit) await Promise.allSettled([submit]);
    await manager.stop(); observation.finish = originalFinish; store.update = originalUpdate;
    if (resource && replacement) store.coordinationHandle.releaseLease(resource, replacement.epoch, replacement.owner);
    queue.close(); store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});

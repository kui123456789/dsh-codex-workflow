import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../../src/app-server-callback.js";
import type { WorkflowRuntimeState } from "../../src/application/workflow-runtime-state.js";
import { newRequestId } from "../../src/bridge-protocol.js";
import { BridgeStore } from "../../src/bridge-store.js";
import type { CodexCallbackRequest, CodexCallbackResult } from "../../src/codex-callback.js";
import { CodexChildSessionFactory } from "../../src/codex-child-session.js";
import { WorkflowStore } from "../../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../../src/types.js";
import { WorkflowManager, type ManagerLease } from "../../src/workflow.js";

export function sharedGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

export interface SharedReviewerStats {
  processId: number;
  visibleTurns: number;
  writerConflicts: number;
  active: Array<{ threadId: string; turnId: string }>;
  threadStarts: Array<{ threadId: string; method: string }>;
  turnStartRequests: Array<{ threadId: string; method: string; prompt?: string }>;
  interrupts: Array<{ threadId: string; turnId: string; mode: string }>;
}

export async function sharedWaitFor<T>(predicate: () => Promise<T | false | undefined> | T | false | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Shared Reviewer fixture did not reach ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const requireHost = createRequire(import.meta.url);
const loadHost = (name: string): Promise<any> => import(pathToFileURL(requireHost.resolve(name)).href);

async function observeTestOperation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const task = operation();
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    // The operation can synchronously abort while it is being admitted.
    if (signal.aborted) aborted();
    // Keep observing the original task after caller cancellation so a late
    // rejection is consumed; actual resource cleanup belongs to close().
    void task.then(value => {
      cleanup();
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { cleanup(); reject(error); });
  });
}

/** Real protocol client, dispatcher and native SubagentRuntime. Only the
 * upstream model protocol and the raw Agent creation port are local fixtures. */
export async function sharedReviewerFixture(options: { mode?: "active" | "retained"; task?: string; planMarkdown?: string; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const mode = options.mode ?? "active";
  const [cordis, sessions, projections, subagents] = await Promise.all([
    loadHost("@deepseek-ai/cordis"), loadHost("@deepseek-ai/dsh-session"),
    loadHost("@deepseek-ai/dsh-session-projection"), loadHost("@deepseek-ai/dsh-subagent"),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "dsh-shared-reviewer-ownership-"));
  await writeFile(join(directory, "changed.txt"), "verified original local diagnostic", "utf8");
  const store = new WorkflowStore(directory);
  const queue = new BridgeStore(directory);
  const ctx = new cordis.Context();
  await ctx.plugin(projections.SessionProjectionRegistry, {});
  await ctx.plugin(subagents.SubagentRuntime, {});
  const owner = sessions.SessionId("shared-native-reviewer-parent");
  const parentSession = sessions.Session.create(owner, [], { version: sessions.SESSION_FORMAT_VERSION,
    id: owner, createdAt: Date.now(), cwd: directory, isSeeded: false }) as Session;
  const parent = { id: owner, session: parentSession } as Agent;
  const children: Session[] = [];
  const rawDisposals: string[] = [];
  const childActions: Array<{ action: "finish" | "dispose"; reason?: string; stack: string }> = [];
  const factory = new CodexChildSessionFactory({ create: async (request: { sessionId: string; meta: object }) => {
    const session = sessions.Session.create(request.sessionId, [], { version: sessions.SESSION_FORMAT_VERSION,
      id: request.sessionId, createdAt: Date.now(), isSeeded: false, ...request.meta }) as Session;
    children.push(session);
    return { agent: { id: session.id, session, ctx: { emit() {} } } as unknown as Agent,
      async dispose() { rawDisposals.push(session.id); } };
  } } as never, ctx.subagents);
  const originalCreate = factory.create.bind(factory);
  factory.create = async (...args) => {
    const child = await originalCreate(...args);
    const finish = child.finish.bind(child);
    const dispose = child.dispose.bind(child);
    child.finish = (...finishArgs) => {
      childActions.push({ action: "finish", reason: finishArgs[1], stack: new Error("child finish trace").stack ?? "" });
      return finish(...finishArgs);
    };
    child.dispose = async () => {
      childActions.push({ action: "dispose", stack: new Error("child dispose trace").stack ?? "" });
      return dispose();
    };
    return child;
  };
  const protocol = fileURLToPath(new URL("./fake-turn-interruption-app-server.mjs", import.meta.url));
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [protocol, "--interrupt-mode", "confirmed", "--turn-mode", "active", "--active-visible-turns", mode === "retained" ? "3" : "1"],
    requestTimeoutMs: 30_000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const processPort = client as unknown as {
    child?: ChildProcess;
    request<T>(method: string, params: object): Promise<T>;
    requestRaw<T>(method: string, params: object, signal: AbortSignal | undefined, expectedProcess: ChildProcess): Promise<T>;
  };
  const request = processPort.request.bind(client);
  const control = (method: string, params: object = {}) => request<SharedReviewerStats>(method, params);
  const nativeOptions: Array<{ threadId: string; options: Parameters<CodexAppServerClient["startTurn"]>[1]; signal?: AbortSignal }> = [];
  const originalTurn = client.startTurn.bind(client);
  client.startTurn = (...args) => { nativeOptions.push({ threadId: args[0], options: args[1], signal: args[2] }); return originalTurn(...args); };
  const subscriptionsReleased: string[] = [];
  const originalUnsubscribe = client.unsubscribeThread.bind(client);
  client.unsubscribeThread = (...args) => { subscriptionsReleased.push(args[0]); return originalUnsubscribe(...args); };
  const dispatcher = new AppServerCodexCallbackDispatcher(client, { policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 } });
  const sends: Array<{ task: Promise<CodexCallbackResult>; request: CodexCallbackRequest; signal?: AbortSignal }> = [];
  const bSend = sharedGate();
  const originalSend = dispatcher.send.bind(dispatcher);
  dispatcher.send = (...args) => {
    const task = originalSend(...args);
    sends.push({ task, request: args[0], signal: args[1] });
    if (sends.length === 2) bSend.enter();
    return task;
  };
  const cancellations: Array<{ stack: string }> = [];
  const originalCancel = dispatcher.cancelSubmission.bind(dispatcher);
  dispatcher.cancelSubmission = (...args) => {
    cancellations.push({ stack: new Error("submission cancellation trace").stack ?? "" });
    return originalCancel(...args);
  };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 30_000, callbackMaxAttempts: 1, callbackRetryBaseMs: mode === "retained" ? 1 : 60_000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 30_000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000,
    leaseTtlMs: 60_000, storageDir: directory };
  const manager = new WorkflowManager(store, client, config, dispatcher, queue, undefined, {},
    { get: (id) => id === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const lossSeen = sharedGate();
  const lossRelease = sharedGate();
  const lossForwarded = sharedGate();
  let firstLease: ManagerLease | undefined;
  const leasePort = manager as unknown as { acquireSubmissionLease(workflowId: string, submissionId: string): Promise<ManagerLease | undefined> };
  const originalAcquire = leasePort.acquireSubmissionLease.bind(manager);
  leasePort.acquireSubmissionLease = async (...args) => {
    const lease = await originalAcquire(...args);
    if (lease && !firstLease) {
      firstLease = lease;
      if (mode === "active") {
        const originalHeartbeat = lease.heartbeat.bind(lease);
        lease.heartbeat = (period, onLost) => originalHeartbeat(Math.min(period, 100), onLost ? () => {
          // The real timer first observes a failed SQL renewal. Hold only its
          // original notification until B has actually joined the operation.
          lossSeen.enter();
          void lossRelease.promise.then(() => { onLost(); lossForwarded.enter(); });
        } : undefined);
      }
    }
    return lease;
  };
  const retryCommitted = sharedGate();
  const retryReturn = sharedGate();
  const originalUpdate = store.update.bind(store);
  let retryHeld = false;
  if (mode === "retained") store.update = async <T>(...args: Parameters<typeof originalUpdate<T>>) => {
    const outcome = await originalUpdate<T>(...args);
    if (!retryHeld && outcome.record.submissionState === "retrying" && outcome.record.submissionRetryAt !== undefined) {
      retryHeld = true; retryCommitted.enter(); await retryReturn.promise;
    }
    return outcome;
  };
  const exec = { agent: parent, signal: options.signal ?? new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  let phase = "fixture created";
  const step = <T>(label: string, operation: () => Promise<T>) => {
    phase = label;
    return observeTestOperation(operation, options.signal);
  };
  let record: WorkflowRecord | undefined;
  const start = async () => {
    record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: parent.id },
      task: options.task ?? "Verify read-only local diagnostic requirements",
      planMarkdown: options.planMarkdown ?? "<proposed_plan>\nVerify current configuration without changing user data.\n</proposed_plan>", assumptions: [] }, parent);
    await manager.submit(record.id, { implementationSummary: "Local diagnostic implemented", changedFiles: ["changed.txt"] }, exec);
    await sharedWaitFor(async () => {
      const stats = await control("fixture/stats");
      return stats.active.length === 1 && stats.turnStartRequests.length === 1 && stats;
    }, "one actual original active Reviewer");
    return record;
  };
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= Promise.resolve().then(async () => {
      lossRelease.release(); retryReturn.release();
      // Cleanup addresses only the original backend; request() would start a
      // fresh process when this fixture never ran a model or already retired it.
      const originalProcess = processPort.child;
      if (originalProcess) {
        await processPort.requestRaw("fixture/setInterruptMode", { mode: "confirmed" }, undefined, originalProcess).catch(() => undefined);
        await processPort.requestRaw("fixture/completeActive", {}, undefined, originalProcess).catch(() => undefined);
      }
      // Stop owns callback cancellation and joins its background work. Waiting
      // for that work first can strand the very process stop must interrupt.
      await manager.stop(); factory.unregisterProvider(); await client.stop(); await ctx.fiber.dispose();
      store.update = originalUpdate; leasePort.acquireSubmissionLease = originalAcquire;
      factory.create = originalCreate; dispatcher.send = originalSend; dispatcher.cancelSubmission = originalCancel;
      client.startTurn = originalTurn; client.unsubscribeThread = originalUnsubscribe;
      queue.close(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    return closePromise;
  };
  return { mode, directory, store, queue, ctx, client, control, manager, runtime, dispatcher, factory, parent, exec, start, step, close,
    children, rawDisposals, childActions, nativeOptions, subscriptionsReleased, sends, bSend, cancellations,
    lossSeen, lossRelease, lossForwarded, retryCommitted, retryReturn,
    get record() { return record; }, get firstLease() { return firstLease; }, get phase() { return phase; },
  };
}

/** A genuine retired original Reviewer, followed by public recovery that
 * proves the same submission cannot reconstruct its private resources. */
export async function unavailableSharedReviewer(f: Awaited<ReturnType<typeof sharedReviewerFixture>>) {
  const record = await f.step("original Reviewer startup", () => f.start());
  const initial = await f.step("original protocol statistics", () => f.control("fixture/stats"));
  const original = await f.step("original workflow load", () => f.store.load(record.id));
  assert.ok(original?.submissionId);
  assert.ok(original.submissionLeaseToken);
  assert.ok(original.submissionLeaseEpoch !== undefined);
  assert.equal(original.reviewerThreadOrigin, "app-server-ephemeral");
  assert.equal(f.store.coordinationHandle.releaseLease(`submission:${record.id}:${original.submissionId}`,
    original.submissionLeaseEpoch, original.submissionLeaseToken), true);
  await f.step("lease loss observation", () => f.lossSeen.entered);
  f.lossRelease.release();
  await f.step("lease loss forwarding", () => f.lossForwarded.entered);
  await f.step("original callback settlement", () => Promise.allSettled([...f.runtime.backgroundTasks]));
  assert.equal(f.runtime.codexChildSessions.size, 0);
  assert.equal(f.rawDisposals.length, 1);
  assert.equal(f.client.isThreadAvailable(initial.active[0]!.threadId), false);
  assert.equal(await f.step("original recovery refusal", () => f.manager.recoverCallbacks()), 1);
  await f.step("refused recovery settlement", () => Promise.allSettled([...f.runtime.backgroundTasks]));
  const failed = await f.step("refused workflow load", () => f.store.load(record.id));
  assert.ok(failed);
  assert.equal(failed.submissionState, "failed");
  assert.ok(failed.submissionError, "The actual original-resource refusal has a persisted diagnostic");
  assert.equal(failed.submissionReviewPending, undefined);
  assert.equal(failed.stagedVerdict, undefined);
  assert.equal(f.runtime.submissionReviewResults.size, 0);
  const stopped = await f.step("retired protocol statistics", () => f.control("fixture/stats"));
  assert.deepEqual(stopped.threadStarts, initial.threadStarts);
  assert.equal(stopped.turnStartRequests.length, initial.turnStartRequests.length);
  return { record, original, failed, initial, stopped };
}

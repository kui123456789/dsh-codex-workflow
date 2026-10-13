import type { CodexAppServerClient } from "./app-server.js";
import type { TokenUsageSnapshot } from "./usage-accounting.js";
import { parseReviewResult } from "./bridge-protocol.js";
import {
  CodexCallbackProcessError,
  CodexInvalidThreadError,
  CodexNoVerdictError,
  type CodexCallbackRequest,
  type CodexCallbackResult,
  type CodexCallbackPendingStartReceipt,
} from "./codex-callback.js";
import { REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import {
  normalizeBackoff,
  retryTransient,
  isRecoverableModelFailure,
  transientReason,
  TransientRetryExhaustedError,
  type BackoffHooks,
  type BackoffPolicy,
} from "./transient-retry.js";
import { reviewConversionPrompt } from "./workflow.js";
import { reviewDisplayError, reviewRewritePrompt } from "./review-contract.js";
import { CodexTurnInterruptionError } from "./turn-interruption.js";
import type { SubmissionReviewConsumer } from "./application/submission-review-consumer.js";
import type { ProcessInstanceIdentity } from "./types.js";
import { originalProcessTreeExited } from "./infrastructure/process-transport.js";
import { CodexTurnReceiptPendingError } from "./pending-turn-receipt.js";

type ReviewBaseline = Awaited<ReturnType<CodexAppServerClient["captureTurnBaseline"]>>;
type PendingReviewStep =
  | { kind: "visible"; baseline?: ReviewBaseline; continuation: number }
  | { kind: "rewrite"; baseline?: ReviewBaseline; originalText: string }
  | { kind: "conversion" };

interface ThreadClaim {
  threadId: string;
  threadOwner?: object;
}

interface ActiveReview extends ThreadClaim {
  turnId: string;
}

interface RetainedReviewer extends ThreadClaim {
  signature: string;
  /** The App Server Reviewer exists, but its durable DSH binding is not saved yet. */
  bindingPending?: boolean;
  /** Once a readable review exists, retry conversion without re-reviewing. */
  visibleText?: string;
  pendingStart?: CodexTurnReceiptPendingError;
  pendingStartIntent?: "cancel" | "terminal";
  pendingStep?: PendingReviewStep;
  interruptionTurnId?: string;
  terminalFailure?: Error;
  originalProcessId?: number;
  originalProcessIds?: readonly number[];
  originalProcessIdentities?: readonly ProcessInstanceIdentity[];
  cleanupFlight?: Promise<boolean>;
  release(): Promise<void>;
  operation?: SharedReviewOperation;
}

interface ReviewObserver {
  request: CodexCallbackRequest;
  signal?: AbortSignal;
  wait?: Promise<CodexCallbackResult>;
  detachSignal?(): void;
}

interface SharedReviewOperation {
  request: CodexCallbackRequest;
  observer: ReviewObserver;
  controller: AbortController;
  visibleStarted?: ActiveReview;
  thread?: ThreadClaim;
}

type ReviewObserverHook = "onThread" | "onOriginalThread" | "onThreadReleased" | "onStarted"
  | "onContinuation" | "onVisibleReview" | "onEphemeralStarted";

const CONTINUE_REVIEW = "上一轮 Reviewer 回合因可恢复的运行错误中断。请在当前会话继续完成原审查，沿用原任务范围和审查契约，不要重新开始或重复已完成的内容。";

function requestSignature(request: CodexCallbackRequest): string {
  return JSON.stringify([request.codexThreadId, request.cwd, request.prompt, request.task,
    request.planMarkdown, request.reviewerThreadId, request.ephemeral === true, request.model, request.effort]);
}

/** 1.1.3: the shared transient-retry policy for this dispatcher's CONTROL RPCs
 * (create / configure / resume of the visible Reviewer task). Optional: an
 * embedder that omits it gets the 1.1.1 defaults. */
export interface AppServerCallbackRetry {
  policy?: Partial<BackoffPolicy>;
  hooks?: BackoffHooks;
}

/**
 * App Server callback path for Codex-led workflows.
 *
 * Since 1.1.0 the review runs on a DEDICATED Reviewer task: the originating
 * Codex task is never resumed and never written to, so a foreign writer
 * holding it (Codex Desktop) cannot block the review. The readable verdict
 * reaches the originating task through the bridge relay, not through its
 * writer lock. Records that already carry a distinct reviewerThreadId keep
 * using that task.
 */
export class AppServerCodexCallbackDispatcher {
  readonly supportsConsumerOwnership = true as const;
  private readonly active = new Map<string, ActiveReview>();
  /** Claimed original Reviewer sources, kept through continuation and cleared by ownership cleanup. */
  private readonly originalThreads = new Map<string, ThreadClaim>();
  private readonly sends = new Set<Promise<unknown>>();
  /** Number of currently-running review turns per Reviewer thread. A thread is
   * only unsubscribed (and its plugin writer hold released) once its refcount
   * returns to zero, so a thread shared by a concurrent review is never
   * released under it, and a finished workflow never closes the App Server
   * another workflow is still using. */
  private readonly threadRefs = new Map<string, Map<object | undefined, number>>();
  /** Ephemeral callback Reviewer retained after one generic model failure so
   * the persistent submission retry can continue the same thread. */
  private readonly recoverableThreads = new Map<string, RetainedReviewer>();
  private readonly flights = new Map<string, { signature: string; task: Promise<CodexCallbackResult>; operation: SharedReviewOperation }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly preparing = new Set<string>();
  private readonly lostSubmissions = new Set<string>();
  /** Who requested an interrupt for a submission (keyed by
   * `workflowId:submissionId`): `cancel` (explicit user cancel),
   * `cancelSubmission` (lease lost), `stop` (plugin teardown). Consulted when a
   * Reviewer turn settles `interrupted` so the persisted reason is accurate. */
  private readonly interruptOrigins = new Map<string, string>();
  /** Cancellation LATchES. `cancelledWorkflows` is workflow-scoped and stays
   * set for the dispatcher's life; `cancelledByKey` is per-submission and
   * cleared when the send settles. Any turn that STARTS after its workflow or
   * submission was cancelled — including an ephemeral normalization fork that
   * only begins after the visible turn already completed — is interrupted
   * IMMEDIATELY, so a stale owner's forked turn can never occupy the Reviewer
   * writer after cancel/lease loss. */
  private readonly cancelledWorkflows = new Set<string>();
  private readonly cancelledByKey = new Map<string, true>();
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly retry: AppServerCallbackRetry = {},
  ) {}

  /** 1.1.3: the shared bounded backoff for a control RPC of this dispatcher. */
  private retryTransientControl<T>(
    operation: (attempt: number) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return retryTransient(
      operation,
      (error) => transientReason(errorMessage(error)),
      normalizeBackoff(this.retry.policy),
      this.retry.hooks ?? {},
      signal,
    );
  }

  /** 1.1.3: create the visible Reviewer task under the shared retry.
   * `thread/start` runs ONCE and every retry re-configures the SAME task, so a
   * flaky settings/name call cannot leak one orphan task per attempt; a spent
   * budget releases the task it created. */
  private async createReviewer(request: CodexCallbackRequest, signal?: AbortSignal): Promise<ThreadClaim> {
    if (!this.codex.startReviewerThread) throw new Error("codex gateway has no startReviewerThread");
    const options = {
      cwd: request.cwd,
      ...(request.reviewerName ? { name: request.reviewerName } : {}),
      ...(request.ephemeral ? { ephemeral: true } : {}),
    };
    const shell = this.codex.startReviewerThreadShell?.bind(this.codex);
    const configure = this.codex.configureReviewerThread?.bind(this.codex);
    if (!shell || !configure) {
      // Limited gateway: the creation is retried as ONE unit (its own failure
      // path already releases whatever it created).
      return this.retryTransientControl(async () => this.captureThread(await this.codex.startReviewerThread!(options, signal)), signal);
    }
    let thread: ThreadClaim | undefined;
    try {
      return await this.retryTransientControl(async () => {
        thread ??= this.captureThread(await shell(options, signal));
        if (!this.threadAvailable(thread)) throw new CodexInvalidThreadError("the original Reviewer creation process was lost; no replacement will be started");
        await configure(thread.threadId, { ...options, ...(thread.threadOwner ? { expectedOwner: thread.threadOwner } : {}) }, signal);
        if (!this.threadAvailable(thread)) throw new CodexInvalidThreadError("the original Reviewer creation process was lost; no replacement will be started");
        return thread;
      }, signal);
    } catch (error) {
      if (thread) await this.codex.unsubscribeThread(thread.threadId, undefined, thread.threadOwner).catch(() => undefined);
      throw error;
    }
  }

  /** 1.1.3: resume the Reviewer task under the shared retry — the writer lock a
   * user's open Codex Desktop task holds is temporary, never a terminal
   * failure. `thread/resume` is what ACQUIRES the subscription, so a failed
   * resume holds nothing that would need releasing. */
  private async resumeReviewer(threadId: string, cwd: string, signal?: AbortSignal): Promise<void> {
    await this.retryTransientControl(() => this.codex.resumeThread(threadId, cwd, signal), signal);
  }

  private captureThread(threadId: string): ThreadClaim {
    const threadOwner = this.codex.captureThreadOwner?.(threadId);
    if (typeof this.codex.captureThreadOwner === "function" && !threadOwner) {
      throw new CodexInvalidThreadError("the original Reviewer connection owner is unavailable; no replacement will be started");
    }
    return { threadId, ...(threadOwner ? { threadOwner } : {}) };
  }

  private threadAvailable(thread: ThreadClaim): boolean {
    return this.codex.isThreadAvailable?.(thread.threadId, thread.threadOwner) ?? true;
  }

  send(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult> {
    if (this.stopped) return Promise.reject(new Error("codex callback dispatcher is stopped"));
    const key = `${request.workflowId}:${request.submissionId}`;
    if (this.lostSubmissions.has(key) && !this.recoverableThreads.get(key)?.pendingStart) {
      return Promise.reject(new CodexInvalidThreadError("the original ephemeral Reviewer process was lost; submit a new review round"));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.isLatched(key, request.workflowId)) return Promise.resolve({ kind: "retryable_busy", reason: "cancelled by user (latch)" });
    const signature = requestSignature(request);
    const flight = this.flights.get(key);
    if (flight) {
      if (flight.signature !== signature) return Promise.reject(new CodexCallbackProcessError("submission already has a different review request"));
      if (!request.consumer) {
        if (flight.operation.observer.request.consumer) return Promise.reject(new CodexCallbackProcessError("original Reviewer requires its current consumer capability"));
        return flight.task;
      }
      try {
        if (flight.operation.controller.signal.aborted) throw new CodexCallbackProcessError("original Reviewer operation is already interrupted; wait for its cleanup");
        if (flight.operation.observer.request.consumer === request.consumer) {
          request.consumer.adopt();
          return flight.operation.observer.wait ?? flight.task;
        }
        this.adoptObserver(key, flight.operation, request, signal);
        const replay = this.replayObserver(key, flight.operation);
        return flight.operation.observer.wait = this.observeResult(flight.operation.observer, flight.task, replay);
      } catch (error) { return Promise.reject(error); }
    }
    const retained = this.recoverableThreads.get(key);
    if (request.originalReviewerRequired && !retained) {
      return Promise.reject(new CodexInvalidThreadError("original ephemeral Reviewer operation is unavailable in this process; no replacement will be created"));
    }
    if (retained && retained.signature !== signature) return Promise.reject(new CodexCallbackProcessError("retained submission has a different review request"));
    if (!request.consumer && retained?.operation?.observer.request.consumer) {
      return Promise.reject(new CodexCallbackProcessError("retained Reviewer requires its current consumer capability"));
    }
    const operation = retained?.operation ?? this.createOperation(request);
    const controller = new AbortController();
    operation.controller = controller;
    try { this.adoptObserver(key, operation, request, signal); }
    catch (error) { return Promise.reject(error); }
    this.controllers.set(key, controller);
    // Register before running: observers/onThread may call send reentrantly.
    const task = Promise.resolve().then(() => this.run(operation.request, controller.signal, operation)).then((result) => {
      if (!request.consumer && signal?.aborted) throw abortError(signal);
      return result;
    });
    this.flights.set(key, { signature, task, operation });
    this.sends.add(task);
    void task.finally(() => {
      this.sends.delete(task);
      if (this.flights.get(key)?.task === task) this.flights.delete(key);
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      if (operation.controller === controller) operation.observer.detachSignal?.();
    }).catch(() => undefined);
    return operation.observer.wait = request.consumer ? this.observeResult(operation.observer, task) : task;
  }

  private createOperation(initial: CodexCallbackRequest): SharedReviewOperation {
    const operation: SharedReviewOperation = { request: initial, observer: { request: initial }, controller: new AbortController() };
    // These functions are stable: the SDK may retain them in a running turn's
    // options while a valid successor adopts the same model operation.
    operation.request = { ...initial,
      onThread: (id) => this.invokeObserver(operation, "onThread", id),
      onOriginalThread: (id) => this.invokeObserver(operation, "onOriginalThread", id),
      onThreadReleased: (id) => this.invokeObserver(operation, "onThreadReleased", id),
      onStarted: (started) => {
        operation.visibleStarted = { ...started, threadOwner: operation.thread?.threadOwner };
        return this.invokeObserver(operation, "onStarted", started);
      },
      onProgress: (entry) => {
        const observer = operation.observer;
        if ((!operation.thread || this.threadAvailable(operation.thread))
          && (!observer.request.consumer || observer.request.consumer.isCurrent())) observer.request.onProgress?.(entry);
      },
      onContinuation: (text) => this.invokeObserver(operation, "onContinuation", text),
      onVisibleReview: (text) => this.invokeObserver(operation, "onVisibleReview", text),
      onEphemeralStarted: (started) => this.invokeObserver(operation, "onEphemeralStarted", started),
    };
    return operation;
  }

  private adoptObserver(key: string, operation: SharedReviewOperation, request: CodexCallbackRequest, signal?: AbortSignal): void {
    if (request.consumer) {
      if (request.consumer.key !== key) throw new CodexCallbackProcessError("review consumer belongs to a different submission");
      request.consumer.adopt();
    }
    operation.observer.detachSignal?.();
    const observer: ReviewObserver = { request, signal };
    operation.observer = observer;
    if (signal) {
      const controller = operation.controller;
      const onAbort = () => {
        if (operation.observer === observer && (!request.consumer || request.consumer.isCurrent())) {
          controller.abort(signal.reason);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      observer.detachSignal = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }
  }

  private observeResult(observer: ReviewObserver, task: Promise<CodexCallbackResult>, replay = Promise.resolve()): Promise<CodexCallbackResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: CodexCallbackResult | undefined, error?: unknown) => {
        if (settled) return;
        settled = true;
        observer.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = () => finish(undefined, abortError(observer.signal!));
      observer.signal?.addEventListener("abort", onAbort, { once: true });
      void Promise.all([task, replay]).then(([result]) => {
        if (observer.request.consumer && !observer.request.consumer.isCurrent()) {
          finish(undefined, new Error("original review consumer was superseded"));
        } else finish(result);
      }, (error) => finish(undefined, error));
      if (observer.signal?.aborted) onAbort();
    });
  }

  private async invokeObserver(operation: SharedReviewOperation, hook: ReviewObserverHook, ...args: any[]): Promise<void> {
    const observer = operation.observer;
    // Releasing the exact claimed thread also releases its metrics binding.
    // Child cleanup may already have closed the registration after cancellation.
    if (hook !== "onThreadReleased" && observer.request.consumer && !observer.request.consumer.isCurrent()) return;
    const callback = observer.request[hook] as ((...args: any[]) => Promise<void> | void) | undefined;
    try { await callback?.(...args); }
    catch (error) {
      // An awaited old hook can lose its lease during the handoff. Its refusal
      // must not fail the model operation already adopted by the new observer.
      if (operation.observer !== observer) return this.invokeObserver(operation, hook, ...args);
      throw error;
    }
  }

  private async replayObserver(key: string, operation: SharedReviewOperation): Promise<void> {
    const thread = this.originalThreads.get(key);
    if (thread && this.threadAvailable(thread)) await this.invokeObserver(operation, "onOriginalThread", thread.threadId, thread.threadOwner);
    const active = this.active.get(key);
    if (active && operation.visibleStarted?.threadId === active.threadId && operation.visibleStarted.turnId === active.turnId) {
      await this.invokeObserver(operation, "onStarted", { threadId: active.threadId, turnId: active.turnId });
    }
  }

  cancel(workflowId: string): void {
    if (this.stopped) return;
    // Latch the workflow BEFORE interrupting: a turn that starts later (e.g.
    // the ephemeral normalization fork, which only begins after the visible
    // turn completed) must still be interrupted immediately.
    this.cancelledWorkflows.add(workflowId);
    for (const [key, controller] of this.controllers) {
      if (key.startsWith(`${workflowId}:`) && (this.active.has(key) || this.preparing.has(key))) {
        controller.abort(new Error("cancelled by user"));
      }
    }
    for (const [key, review] of this.active) {
      if (key.startsWith(`${workflowId}:`)) {
        this.cancelledByKey.set(key, true);
        this.interruptOrigins.set(key, "cancelled by user");
        void this.codex.interrupt(review.threadId, review.turnId, undefined, review.threadOwner).catch(() => undefined);
      }
    }
    for (const [key, retained] of this.recoverableThreads) {
      if (key.startsWith(`${workflowId}:`)) {
        if (retained.pendingStart) retained.pendingStartIntent = "cancel";
        this.trackCleanup(this.releaseRetainedReviewer(key, retained));
      }
    }
  }

  cancelSubmission(workflowId: string, submissionId: string, consumer?: SubmissionReviewConsumer): void | Promise<void> {
    if (this.stopped) return;
    const key = `${workflowId}:${submissionId}`;
    const flight = this.flights.get(key);
    const retained = this.recoverableThreads.get(key);
    if (consumer) {
      const operation = flight?.operation ?? retained?.operation;
      if (!consumer.isCurrent() || operation?.observer.request.consumer !== consumer) return;
    }
    this.cancelledByKey.set(key, true);
    if (this.active.has(key) || this.preparing.has(key)) {
      this.controllers.get(key)?.abort(new Error("lease lost (callback taken over)"));
    }
    const review = this.active.get(key);
    if (review) {
      this.interruptOrigins.set(key, "lease lost (callback taken over)");
      void this.codex.interrupt(review.threadId, review.turnId, undefined, review.threadOwner).catch(() => undefined);
    }
    let retainedCleanup: Promise<void> | undefined;
    if (retained) {
      if (retained.pendingStart) retained.pendingStartIntent = "cancel";
      retainedCleanup = this.releaseRetainedReviewer(key, retained);
      this.trackCleanup(retainedCleanup);
    }
    return Promise.allSettled([...(flight ? [flight.task] : []), ...(retainedCleanup ? [retainedCleanup] : [])]).then(() => undefined);
  }

  /** Whether this workflow's callback run has been cancelled (any submission).
   * Used by the owner (WorkflowManager) to classify a latched cancellation. */
  isCancelled(workflowId: string): boolean {
    return this.cancelledWorkflows.has(workflowId);
  }

  /** The cancellation latch for the exact submission (workflow-level or
   * submission-level). A turn starting after the latch was set must never run. */
  private isLatched(key: string, workflowId: string): boolean {
    return this.stopped || this.cancelledWorkflows.has(workflowId) || this.cancelledByKey.has(key);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      await Promise.allSettled([...this.recoverableThreads].map(([key, retained]) => this.releaseRetainedReviewer(key, retained)));
      return;
    }
    this.stopped = true;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new Error("plugin teardown"));
    for (const [key, review] of this.active) {
      this.interruptOrigins.set(key, "plugin teardown");
      void this.codex.interrupt(review.threadId, review.turnId, undefined, review.threadOwner).catch(() => undefined);
    }
    await Promise.allSettled([...this.active.values()].map((review) =>
      this.codex.interrupt(review.threadId, review.turnId, undefined, review.threadOwner),
    ));
    await Promise.allSettled([...this.sends]);
    this.active.clear();
    for (const [key, retained] of this.recoverableThreads) {
      if (retained.pendingStart) retained.pendingStartIntent = "cancel";
      this.trackCleanup(this.releaseRetainedReviewer(key, retained));
    }
    await Promise.allSettled([...this.cleanups]);
    if (!this.recoverableThreads.size) {
      this.threadRefs.clear();
      this.originalThreads.clear();
    }
  }

  private trackCleanup(task: Promise<void>): void {
    this.cleanups.add(task);
    void task.finally(() => this.cleanups.delete(task)).catch(() => undefined);
  }

  private confirmRetainedInterruption(retained: RetainedReviewer): Promise<boolean> {
    if (retained.pendingStart) return this.confirmRetainedStart(retained);
    if (!retained.interruptionTurnId) return Promise.resolve(true);
    if (retained.cleanupFlight) return retained.cleanupFlight;
    const interruptionTurnId = retained.interruptionTurnId;
    const { threadId, threadOwner, originalProcessId, originalProcessIds, originalProcessIdentities } = retained;
    const ownsInterruption = () => retained.interruptionTurnId === interruptionTurnId && retained.threadId === threadId
      && retained.threadOwner === threadOwner && retained.originalProcessId === originalProcessId
      && retained.originalProcessIds === originalProcessIds && retained.originalProcessIdentities === originalProcessIdentities;
    const task = (async () => {
      if (!this.threadAvailable(retained)) {
        if (!await originalProcessTreeExited({ processId: originalProcessId, processIds: originalProcessIds,
          processIdentities: originalProcessIdentities })) return false;
        if (!ownsInterruption()) return false;
        retained.interruptionTurnId = undefined;
        return true;
      }
      try {
        await this.codex.interrupt(threadId, interruptionTurnId, undefined, threadOwner);
        if (!ownsInterruption()) return false;
        retained.interruptionTurnId = undefined;
        return true;
      } catch { return false; }
    })();
    retained.cleanupFlight = task;
    void task.finally(() => { if (retained.cleanupFlight === task) retained.cleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private confirmRetainedStart(retained: RetainedReviewer): Promise<boolean> {
    if (retained.cleanupFlight) return retained.cleanupFlight;
    const pendingStart = retained.pendingStart!;
    const { threadId, threadOwner } = retained;
    const task = (async () => {
      // cleanup() knows the original request, exact eventual pair and process
      // birth. Sending an interrupt without its returned pair proves nothing.
      const confirmed = await pendingStart.operation.cleanup().catch(() => false);
      if (!confirmed || retained.pendingStart !== pendingStart || retained.threadId !== threadId
        || retained.threadOwner !== threadOwner) return false;
      retained.pendingStart = undefined;
      retained.pendingStep = undefined;
      return true;
    })();
    retained.cleanupFlight = task;
    void task.finally(() => { if (retained.cleanupFlight === task) retained.cleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private async releaseRetainedReviewer(key: string, retained: RetainedReviewer): Promise<void> {
    if (!await this.confirmRetainedInterruption(retained)) return;
    if (this.recoverableThreads.get(key) !== retained) return;
    this.recoverableThreads.delete(key);
    await retained.release();
  }

  availableContinuation(workflowId: string): boolean {
    return [...this.recoverableThreads.entries()].some(([key, retained]) => key.startsWith(`${workflowId}:`)
      && !retained.terminalFailure && !retained.pendingStartIntent && !retained.interruptionTurnId
      && (!retained.pendingStart || retained.pendingStart.operation.status() === "ready")
      && this.threadAvailable(retained));
  }

  hasPendingStartReceipt(workflowId: string): boolean {
    return [...this.recoverableThreads.entries()].some(([key, retained]) => key.startsWith(`${workflowId}:`)
      && Boolean(retained.pendingStart));
  }

  getPendingStartReceipt(workflowId: string): CodexCallbackPendingStartReceipt | undefined {
    const pending = [...this.recoverableThreads.entries()].filter(([key, retained]) => key.startsWith(`${workflowId}:`)
      && retained.pendingStart);
    if (pending.length !== 1) return undefined;
    const retained = pending[0]![1];
    return Object.freeze({ pendingStart: retained.pendingStart!, executionOwner: retained,
      originalProcessId: retained.originalProcessId,
      originalProcessIds: retained.originalProcessIds,
      originalProcessIdentities: retained.originalProcessIdentities });
  }

  hasPendingTerminalCleanup(workflowId: string): boolean {
    return [...this.recoverableThreads.entries()].some(([key, retained]) => key.startsWith(`${workflowId}:`)
      && Boolean(retained.terminalFailure && (retained.interruptionTurnId || retained.pendingStart)));
  }

  hasPendingInterruption(workflowId: string): boolean {
    return [...this.recoverableThreads.entries()].some(([key, retained]) => key.startsWith(`${workflowId}:`)
      && Boolean(retained.interruptionTurnId || retained.pendingStart));
  }

  getPendingInterruption(workflowId: string): {
    originalProcessId?: number; originalProcessIds?: readonly number[];
    originalProcessIdentities?: readonly ProcessInstanceIdentity[];
  } | undefined {
    const pending = [...this.recoverableThreads.entries()].filter(([key, retained]) => key.startsWith(`${workflowId}:`)
      && (retained.interruptionTurnId || retained.pendingStart));
    if (pending.length !== 1) return undefined;
    const retained = pending[0]![1];
    return Object.freeze({ originalProcessId: retained.originalProcessId,
      originalProcessIds: retained.originalProcessIds && Object.freeze([...retained.originalProcessIds]),
      originalProcessIdentities: retained.originalProcessIdentities
        && Object.freeze(retained.originalProcessIdentities.map((identity) => Object.freeze({ ...identity }))) });
  }

  getPendingTerminalCleanup(workflowId: string): {
    terminalFailure: string; originalProcessId?: number; originalProcessIds?: readonly number[]; executionOwner: object;
    originalProcessIdentities?: readonly ProcessInstanceIdentity[];
    pendingStart?: CodexTurnReceiptPendingError;
  } | undefined {
    const pending = [...this.recoverableThreads.entries()].filter(([key, retained]) => key.startsWith(`${workflowId}:`)
      && retained.terminalFailure && (retained.interruptionTurnId || retained.pendingStart));
    if (pending.length !== 1) return undefined;
    const retained = pending[0]![1];
    return Object.freeze({ terminalFailure: retained.terminalFailure!.message,
      ...(retained.pendingStart ? { pendingStart: retained.pendingStart } : {}),
      executionOwner: retained,
      originalProcessId: retained.originalProcessId,
      originalProcessIds: retained.originalProcessIds && Object.freeze([...retained.originalProcessIds]),
      originalProcessIdentities: retained.originalProcessIdentities
        && Object.freeze(retained.originalProcessIdentities.map((identity) => Object.freeze({ ...identity }))) });
  }

  getOriginalThreadUsage(workflowId: string): TokenUsageSnapshot | undefined {
    if (this.stopped || this.cancelledWorkflows.has(workflowId)) return undefined;
    const threads = [...this.originalThreads.entries()]
      .filter(([key]) => key.startsWith(`${workflowId}:`) && !this.isLatched(key, workflowId))
      .map(([, thread]) => thread);
    const thread = threads[0];
    if (!thread || threads.some((candidate) => candidate.threadId !== thread.threadId || candidate.threadOwner !== thread.threadOwner)
      || !this.threadAvailable(thread)) return undefined;
    const threadId = thread.threadId;
    const usage = this.codex.getThreadTokenUsage?.(threadId);
    if (!usage || usage.threadId !== threadId) return undefined;
    return { ...usage, total: { ...usage.total }, last: { ...usage.last } };
  }

  private async run(request: CodexCallbackRequest, signal?: AbortSignal, operation?: SharedReviewOperation): Promise<CodexCallbackResult> {
    const key = `${request.workflowId}:${request.submissionId}`;
    let reviewerThreadId: string | undefined;
    let reviewerThreadOwner: object | undefined;
    let claimedThread: ThreadClaim | undefined;
    let activeRegistration: ActiveReview | undefined;
    let retainReviewer = false;
    const retained = this.recoverableThreads.get(key);
    let bindingPending = retained?.bindingPending === true;
    reviewerThreadOwner = retained?.threadOwner;
    if (!retained?.pendingStart) this.recoverableThreads.delete(key);
    let authoritativeText = retained?.visibleText;
    let validatedText = retained?.visibleText;
    let pendingStep: PendingReviewStep = retained?.pendingStep ?? { kind: "visible", continuation: 0 };
    let resumedResult: Awaited<ReturnType<CodexAppServerClient["startTurn"]>> | undefined;
    let releaseTask: Promise<void> | undefined;
    // True only once THIS invocation owns an App Server subscription to the task
    // carrying the review. A task created HERE is claimed by the creation itself
    // (1.1.5: it is never resumed); a PRE-EXISTING task is claimed by its resume,
    // so a failed resume can never release another review's hold.
    let claimed = false;
    // 1.1.6: pin the child for the whole round. The idle window must never fall
    // between creating the Reviewer and its first turn — the respawned process
    // does not know that thread and answers `thread not found`.
    if (!retained) this.codex.beginRound?.();
    const releaseOwned = retained?.release ?? (() => {
      if (releaseTask) return releaseTask;
      releaseTask = (async () => {
        if (claimedThread && this.originalThreads.get(key) === claimedThread) this.originalThreads.delete(key);
        try {
          if (reviewerThreadId && claimed) {
            try { await request.onThreadReleased?.(reviewerThreadId, reviewerThreadOwner); }
            catch { /* Usage observers own metric diagnostics; never retry the model. */ }
            if (claimedThread) await this.releaseThread(claimedThread);
          }
        } finally { this.codex.endRound?.(); }
      })();
      return releaseTask;
    });
    const ensureRunning = () => {
      signal?.throwIfAborted();
      if (this.isLatched(key, request.workflowId)) throw new Error("cancelled by user (latch)");
      if (reviewerThreadId && !this.threadAvailable({ threadId: reviewerThreadId, threadOwner: reviewerThreadOwner })) {
        this.lostSubmissions.add(key);
        throw new CodexInvalidThreadError("the original ephemeral Reviewer process was lost; no replacement will be started");
      }
    };
    const clearActive = () => {
      if (activeRegistration && this.active.get(key) === activeRegistration) this.active.delete(key);
      activeRegistration = undefined;
    };
    const registerActive = (started: { threadId: string; turnId: string }) => {
      const threadOwner = started.threadId === reviewerThreadId
        ? reviewerThreadOwner : this.codex.captureThreadOwner?.(started.threadId);
      activeRegistration = { ...started, ...(threadOwner ? { threadOwner } : {}) };
      this.active.set(key, activeRegistration);
      return threadOwner;
    };
    const waitInThread = (reason: string, interruptionTurnId?: string, callerAbort = false): CodexCallbackResult => {
      // A caller-only abort can end this send while the original remote turn
      // still needs cleanup. Workflow cancel/lease loss/stop keep priority.
      if (interruptionTurnId || callerAbort) {
        if (this.isLatched(key, request.workflowId)) throw new Error("cancelled by user (latch)");
      } else ensureRunning();
      if (request.ephemeral && reviewerThreadId && claimed && (interruptionTurnId || callerAbort || !signal?.aborted) && !this.isLatched(key, request.workflowId)
        && this.threadAvailable({ threadId: reviewerThreadId, threadOwner: reviewerThreadOwner })) {
        retainReviewer = true;
        this.recoverableThreads.set(key, { threadId: reviewerThreadId, threadOwner: reviewerThreadOwner, signature: requestSignature(request),
          ...(validatedText ? { visibleText: validatedText } : {}), release: releaseOwned,
          ...(operation ? { operation } : {}),
          ...(retained?.originalProcessId !== undefined ? { originalProcessId: retained.originalProcessId } : {}),
          ...(retained?.originalProcessIds ? { originalProcessIds: retained.originalProcessIds } : {}),
          ...(retained?.originalProcessIdentities ? { originalProcessIdentities: retained.originalProcessIdentities } : {}),
          ...(bindingPending ? { bindingPending: true } : {}),
          ...(interruptionTurnId ? { interruptionTurnId } : {}) });
      }
      return { kind: "retryable_busy", reason };
    };
    const waitForInterruption = (error: CodexTurnInterruptionError): CodexCallbackResult => {
      if (error.threadId !== reviewerThreadId) throw new CodexCallbackProcessError("interruption belongs to a different Reviewer thread; refusing to continue or replace the original");
      if (reviewerThreadOwner && error.originalThreadOwner && error.originalThreadOwner !== reviewerThreadOwner) {
        throw new CodexCallbackProcessError("interruption belongs to a different Reviewer connection owner; refusing to clean another execution");
      }
      if (request.ephemeral && reviewerThreadId && claimed) {
        const original = error.cause instanceof Error ? error.cause : error;
        const terminalFailure = error.cleanupOnly
          ? original instanceof CodexNoVerdictError || original instanceof CodexCallbackProcessError || original instanceof CodexInvalidThreadError
            ? original : new CodexCallbackProcessError(original.message)
          : retained?.terminalFailure;
        retainReviewer = true;
        this.recoverableThreads.set(key, { threadId: reviewerThreadId, threadOwner: reviewerThreadOwner ?? error.originalThreadOwner,
          signature: requestSignature(request),
          ...(validatedText ? { visibleText: validatedText } : {}), release: releaseOwned,
          ...(operation ? { operation } : {}), interruptionTurnId: error.turnId,
          originalProcessId: error.originalProcessId ?? retained?.originalProcessId,
          originalProcessIds: error.originalProcessIds ?? retained?.originalProcessIds,
          originalProcessIdentities: error.originalProcessIdentities ?? retained?.originalProcessIdentities,
          ...(terminalFailure ? { terminalFailure } : {}) });
      }
      return { kind: "retryable_busy", reason: "original Reviewer interruption is unconfirmed" };
    };
    const waitForStartReceipt = async (error: CodexTurnReceiptPendingError): Promise<CodexCallbackResult> => {
      if (!reviewerThreadId || !claimed) throw error;
      if (pendingStep.kind !== "conversion" || request.ephemeral) {
        if (error.operation.sourceThreadId !== reviewerThreadId
          || (reviewerThreadOwner && error.operation.sourceThreadOwner !== reviewerThreadOwner)) {
          throw new CodexCallbackProcessError("unconfirmed start belongs to another Reviewer execution; refusing to replace the original");
        }
      }
      const pending: RetainedReviewer = retained?.pendingStart?.operation === error.operation ? retained : {
        threadId: reviewerThreadId, threadOwner: reviewerThreadOwner,
        signature: requestSignature(request), release: releaseOwned,
        ...(operation ? { operation } : {}),
      };
      pending.pendingStart = error;
      pending.pendingStep = pendingStep;
      if (validatedText !== undefined) pending.visibleText = validatedText;
      if (this.isLatched(key, request.workflowId)) pending.pendingStartIntent = "cancel";
      // Publish ownership before process evidence I/O so cancel/stop cannot
      // release this subscription while its submitted start is still unknown.
      retainReviewer = true;
      this.recoverableThreads.set(key, pending);
      if (!pending.originalProcessIdentities) {
        const evidence = await error.operation.evidence().catch(() => undefined);
        if (evidence && pending.pendingStart === error && !pending.originalProcessIdentities) {
          pending.originalProcessId = evidence.processId;
          pending.originalProcessIds = evidence.processIds;
          pending.originalProcessIdentities = evidence.processIdentities;
        }
      }
      if (pending.pendingStartIntent === "cancel" || this.isLatched(key, request.workflowId)) {
        pending.pendingStartIntent = "cancel";
        await this.releaseRetainedReviewer(key, pending);
        return { kind: "retryable_busy", reason: "cancelled; original Reviewer start receipt cleanup is unconfirmed" };
      }
      const status = error.operation.status();
      if (status === "invalid" || status === "unavailable") {
        pending.pendingStartIntent = "terminal";
        pending.terminalFailure ??= new CodexInvalidThreadError("original Reviewer start receipt is invalid or unavailable; no replacement will be created");
      }
      return { kind: "retryable_busy", reason: status === "invalid"
        ? "original Reviewer start receipt is invalid; awaiting confirmed cleanup"
        : status === "unavailable" ? "original Reviewer start receipt is unavailable; awaiting original process exit"
          : "original Reviewer model start receipt is unconfirmed; waiting for its original reply" };
    };
    try {
      if (retained?.terminalFailure) {
        // This send owns only cleanup of the original terminal failure. It
        // does not revalidate evidence or create/continue a model operation.
        reviewerThreadId = retained.threadId;
        claimed = true;
        this.preparing.add(key);
        if (!await this.confirmRetainedInterruption(retained)) {
          retainReviewer = true;
          this.recoverableThreads.set(key, retained);
          return { kind: "retryable_busy", reason: "original Reviewer interruption is unconfirmed" };
        }
        if (this.recoverableThreads.get(key) === retained) this.recoverableThreads.delete(key);
        throw retained.terminalFailure;
      }
      ensureRunning();
      this.preparing.add(key);
      // New ephemeral rounds ignore any legacy persisted Reviewer id. This is
      // the guard that prevents the callback from ever resuming a Desktop task.
      const retainedThread = retained?.threadId;
      reviewerThreadId = retainedThread ?? (request.ephemeral ? undefined : request.reviewerThreadId);
      // Retained startup ownership exists before availability is checked.
      // A lost projection must enter original cleanup, never drop its pin
      // through the unclaimed-creation failure path.
      if (retainedThread) claimed = true;
      if (retainedThread && !this.threadAvailable(retained!)) {
        this.lostSubmissions.add(key);
        throw new CodexInvalidThreadError("the retained ephemeral Reviewer process was lost; its original thread cannot be resumed");
      }
      // 1.1.0: a review NEVER runs on the origin (source) task. A dedicated
      // Reviewer task is created instead, so an external writer holding the
      // user's Codex task (Codex Desktop keeps a writer lock on every thread
      // it has loaded) can never block the review with "already has an active
      // writer". The origin task stays untouched: the readable verdict reaches
      // it through the bridge (submission/verdict relay), not by taking its
      // writer.
      const created = !reviewerThreadId;
      // 1.1.3: creation AND resume run under the same bounded transient retry as
      // the DSH-led path. Since 1.1.2 the Reviewer task is visible in Codex
      // Desktop, so a user simply reading it makes Desktop hold its writer lock
      // and `thread/resume` fail with `already has an active writer` — a
      // temporary condition the 1.1.1 CLI path retried for up to 20 minutes. A
      // spent budget is mapped to `retryable_busy` (the submission then follows
      // the bounded callback retry + the periodic `recoverCallbacks` sweep)
      // instead of becoming a terminal callback failure.
      try {
        // 1.1.5: resume ONLY a PRE-EXISTING Reviewer. `thread/resume` paginates
        // the thread's history, and a task THIS invocation just created has a
        // registered rollout path whose file does not exist yet — the App Server
        // rejects that with `invalid paginated history lineage for <id>: missing
        // source rollout`, which made every bridge review fail on a fresh
        // Reviewer. Creation already leaves the task loaded under this client, so
        // the subscription is ours either way; the DSH-led path has always worked
        // exactly like this (its creation branch never resumes).
        if (!reviewerThreadId) {
          claimedThread = await this.createReviewer(request, signal);
          reviewerThreadId = claimedThread.threadId;
          reviewerThreadOwner = claimedThread.threadOwner;
        } else if (!retainedThread) {
          await this.resumeReviewer(reviewerThreadId, request.cwd, signal);
          claimedThread = this.captureThread(reviewerThreadId);
          reviewerThreadOwner = claimedThread.threadOwner;
        }
      } catch (error) {
        // A task THIS invocation just created is bound to nothing and owned by
        // nobody — release its hold instead of leaving an orphaned subscription
        // behind. A PRE-EXISTING Reviewer is deliberately NOT released: resume
        // is what claims the subscription, so a failed resume must never
        // decrement another review's hold.
        if (created && reviewerThreadId) await this.codex.unsubscribeThread(reviewerThreadId, undefined, reviewerThreadOwner).catch(() => undefined);
        if (error instanceof TransientRetryExhaustedError) {
          this.interruptOrigins.delete(key);
          return { kind: "retryable_busy", reason: error.reason };
        }
        throw error;
      }
      claimedThread ??= retained?.operation?.thread ?? this.originalThreads.get(key)
        ?? { threadId: reviewerThreadId, threadOwner: reviewerThreadOwner };
      if (!retainedThread) this.trackThreadRef(claimedThread, 1);
      claimed = true;
      this.originalThreads.set(key, claimedThread);
      if (operation) operation.thread = claimedThread;
      if (created) {
        // Persist the dedicated identity only after the resume succeeded. A
        // failed creation/resume leaves the record unbound and retryable
        // instead of storing a stale reviewer id.
        try { await request.onThread?.(reviewerThreadId, reviewerThreadOwner); }
        catch (error) {
          if (!request.ephemeral) throw error;
          bindingPending = true;
          retainReviewer = true;
          try { return waitInThread("Reviewer binding persistence failed; waiting for retry"); }
          catch (waitError) {
            // The binding may fail after cancel/stop or after the original
            // thread disappears. In those cases waitInThread cannot publish
            // a retained record, so the claimed Reviewer must be released
            // here instead of letting retainReviewer suppress cleanup.
            retainReviewer = false;
            await releaseOwned();
            throw waitError;
          }
        }
      }
      if (bindingPending) {
        try { await request.onThread?.(reviewerThreadId, reviewerThreadOwner); }
        catch (error) {
          retainReviewer = true;
          try { return waitInThread("Reviewer binding persistence failed; waiting for retry"); }
          catch (waitError) {
            retainReviewer = false;
            await releaseOwned();
            throw waitError;
          }
        }
        bindingPending = false;
      }
      if (!retainedThread) {
        try { await request.onOriginalThread?.(reviewerThreadId, reviewerThreadOwner); }
        catch { /* Metrics cannot replace an otherwise valid review result. */ }
      }
      ensureRunning();
      if (retained?.interruptionTurnId) {
        try { await this.codex.interrupt(reviewerThreadId, retained.interruptionTurnId, undefined, reviewerThreadOwner); }
        catch { return waitInThread("original Reviewer interruption is unconfirmed", retained.interruptionTurnId); }
        ensureRunning();
      }
      if (retained?.pendingStart) {
        const pending = retained.pendingStart;
        if (retained.pendingStartIntent || pending.operation.status() !== "ready") return waitForStartReceipt(pending);
        const recovered = await pending.operation.resume({
          ...(pendingStep.kind !== "conversion" ? { onProgress: request.onProgress } : {}),
          onStarted: async (started) => {
            if (started.threadId !== pending.operation.sourceThreadId) {
              throw new CodexCallbackProcessError("original start receipt returned a different Reviewer execution");
            }
            const threadOwner = registerActive(started);
            if (this.isLatched(key, request.workflowId)) {
              await this.codex.interrupt(started.threadId, started.turnId, undefined, threadOwner).catch(() => undefined);
              throw new Error("cancelled by user (latch)");
            }
            if (pendingStep.kind === "conversion") await request.onEphemeralStarted?.(started);
            else await request.onStarted?.(started);
          },
        }, signal);
        ensureRunning();
        resumedResult = recovered.result;
        retained.pendingStart = undefined;
        if (this.recoverableThreads.get(key) === retained) this.recoverableThreads.delete(key);
      }
      this.preparing.delete(key);

      // The VISIBLE Reviewer turn never carries an outputSchema: its readable
      // Markdown review (in the original task's language) is what Codex
      // Desktop keeps in the durable task history. The protocol-level pin
      // keeps the turn silent and non-collaborative. The PERSISTED-turn
      // baseline is captured BEFORE the turn starts: the appended
      // (newly-persisted) turn is later detected against these ids, because
      // the `turn/start` RPC id is NOT guaranteed to equal the persisted
      // `thread.turns[].id` (real App Server evidence).
      if (authoritativeText === undefined) {
      const pendingRewrite = pendingStep.kind === "rewrite" ? pendingStep : undefined;
      if (retained && !resumedResult) await request.onContinuation?.(CONTINUE_REVIEW);
      const visibleBaseline = resumedResult && pendingStep.kind === "visible" ? pendingStep.baseline : request.ephemeral || pendingRewrite
        ? undefined
        : await this.codex.captureTurnBaseline(reviewerThreadId, signal);
      const startVisibleTurn = (prompt: string) => this.codex.startTurn(reviewerThreadId!, {
        ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
        prompt,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        silentReview: true,
        onProgress: request.onProgress,
        onStarted: async (started) => {
          // Same 1.0.8 invariant as the DSH-led path, enforced BEFORE any
          // tracking: the App Server's reported review task must be the
          // workflow task we validated/resumed. A mismatched id (a second
          // visible task) is interrupted immediately and the submission stays
          // retryable — it can never enter the active map or the persisted
          // reviewerThreadId.
          if (started.threadId !== reviewerThreadId) {
            await this.codex.interrupt(started.threadId, started.turnId, undefined,
              this.codex.captureThreadOwner?.(started.threadId) ?? reviewerThreadOwner).catch(() => undefined);
            throw new Error(`review/start returned task ${started.threadId}, expected the workflow task ${reviewerThreadId}; refusing to track a second visible task`);
          }
          const threadOwner = registerActive(started);
          if (this.isLatched(key, request.workflowId)) {
            // Cancel won between turn/start and registration (visible -> fork
            // window): never let this turn run or occupy the Reviewer writer.
            await this.codex.interrupt(started.threadId, started.turnId, undefined, threadOwner).catch(() => undefined);
            throw new Error("cancelled by user (latch)");
          }
          await request.onStarted?.(started);
        },
      }, signal);
      let result: Awaited<ReturnType<CodexAppServerClient["startTurn"]>>;
      if (pendingRewrite) {
        authoritativeText = pendingRewrite.originalText;
      } else {
      for (let continuation = pendingStep.kind === "visible" ? pendingStep.continuation : 0; ; continuation += 1) {
        ensureRunning();
        if (continuation > 0 && !resumedResult) await request.onContinuation?.(CONTINUE_REVIEW);
        pendingStep = { kind: "visible", baseline: visibleBaseline, continuation };
        try {
          if (resumedResult) { result = resumedResult; resumedResult = undefined; }
          else result = await startVisibleTurn(continuation === 0 && !retained ? request.prompt : CONTINUE_REVIEW);
        } catch (error) {
          const detail = errorMessage(error);
          clearActive();
          if (error instanceof CodexTurnReceiptPendingError) throw error;
          if (signal?.aborted || this.isLatched(key, request.workflowId)) throw error;
          if (error instanceof CodexTurnInterruptionError) {
            return waitForInterruption(error);
          }
          if (continuation === 0 && isRecoverableModelFailure(detail)) continue;
          throw error;
        }
        if (result.kind === "completed" && result.status !== "completed") {
          const detail = `${result.error ?? ""} ${result.reason ?? "turn failed"}`;
          clearActive();
          if (continuation === 0 && isRecoverableModelFailure(detail)) continue;
        }
        break;
      }
      if (result.kind !== "completed") {
        throw new CodexNoVerdictError("reviewer unexpectedly requested user input");
      }
      if (result.status !== "completed") {
        if (result.status === "interrupted") {
          // Attribute WHY the turn was interrupted so the stuck-state
          // diagnostics and persistent recovery know the origin.
          const origin = this.interruptOrigins.get(key) ?? "interrupted turn (no origin recorded)";
          this.interruptOrigins.delete(key);
          return waitInThread(origin);
        }
        const detail = `reviewer turn ${result.turnId} failed${result.error ? `: ${result.error}` : ""}${result.reason ? ` (${result.reason})` : ""}`;
        // 1.1.2: this dispatcher is now the DEFAULT visible review path (the CLI
        // can only create `source='exec'` tasks, which Codex Desktop never
        // renders), so the 1.1.1 transient contract must hold here too: a
        // temporary upstream failure inside the turn (server_overloaded / at
        // capacity / 429 / 5xx / dropped stream / a writer held elsewhere) stays
        // RETRYABLE with the shared backoff instead of ending the submission as
        // a terminal callback failure. Only a genuinely non-transient failure
        // stays terminal.
        const failureReason = `${result.error ?? ""} ${result.reason ?? "turn failed"}`;
        const transient = transientReason(failureReason);
        if (transient) {
          this.interruptOrigins.delete(key);
          return waitInThread(transient);
        }
        if (isRecoverableModelFailure(failureReason)) {
          this.interruptOrigins.delete(key);
          return waitInThread("model failure; the same Reviewer session is waiting for continuation");
        }
        throw new CodexCallbackProcessError(detail);
      }
      // The visible turn has COMPLETED: it is no longer a valid interrupt
      // target. Remove it from the active map NOW, so a cancel arriving in
      // the visible->rewrite/read-back/fork window can never interrupt an
      // already-completed source-task turn — the cancellation LATch instead
      // stops every turn that starts afterwards (rewrite and fork both
      // re-register and check the latch in their onStarted).
      clearActive();
      if (this.isLatched(key, request.workflowId)) {
        // Cancelled in the window between the visible turn completing and the
        // fork starting: no conversion runs, the fork must never begin.
        return { kind: "retryable_busy", reason: "cancelled by user (latch)" };
      }
      // The SAME final visible contract as the DSH-led path, ENFORCED ON THE
      // PERSISTED HISTORY: the authoritative display text is what
      // `thread/read(includeTurns: true)` returns for the turn appended since
      // the pre-turn baseline — the streamed/`turn/completed` aggregation
      // (`result.text`) can differ from what Codex Desktop actually persists,
      // so it alone must never gate the contract. A missing/ambiguous
      // read-back is retryable
      // and NEVER falls back to the in-memory text. When the persisted native
      // review violates the contract, run ONE visible rewrite turn on the SAME
      // durable workflow task (no outputSchema, read-only/network disabled/
      // approval never enforced per turn, low effort, silent) that only
      // re-presents the SAME verdict/findings/test-gaps in the task's
      // language; its READ-BACK final message becomes the authoritative
      // conversion input, so a `pass` can never ride an English one-liner, a
      // section-less review or a read-back gap through.
      // The native review's AUTHORITY is the turn APPENDED to the persisted
      // history since the pre-turn baseline (never the RPC turn id — real App
      // Server evidence shows native review RPC turn ids that never appear in
      // the persisted rollout history). Missing/ambiguous -> retryable.
      const persistedNative = request.ephemeral
        ? { text: result.text ?? "" }
        : await this.codex.readAppendedTurnText(reviewerThreadId, visibleBaseline!, signal);
      if (!persistedNative) {
        this.interruptOrigins.delete(key);
        return { kind: "retryable_busy", reason: "persisted review read-back missing or ambiguous" };
      }
      authoritativeText = persistedNative.text;
      }
      const displayContext = { task: request.task ?? "", planMarkdown: request.planMarkdown };
      const displayError = reviewDisplayError(authoritativeText, displayContext);
      if (displayError) {
        if (authoritativeText.trim().length > 0) {
          // Baseline BEFORE the rewrite turn, exactly like the native turn.
          const rewriteBaseline = pendingRewrite ? pendingRewrite.baseline : request.ephemeral
            ? undefined
            : await this.codex.captureTurnBaseline(reviewerThreadId, signal);
          pendingStep = { kind: "rewrite", baseline: rewriteBaseline, originalText: authoritativeText };
          if (!resumedResult) await request.onContinuation?.("沿用原审查结论，在当前 Reviewer 会话修正可读展示，不重新审查工作区。");
          const rewrite = resumedResult ?? await this.codex.startTurn(reviewerThreadId, {
            ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
            prompt: reviewRewritePrompt(authoritativeText, displayContext),
            ...(request.model ? { model: request.model } : {}),
            effort: "low",
            silentReview: true,
            onProgress: request.onProgress,
            onStarted: async (started) => {
              const threadOwner = registerActive(started);
              if (this.isLatched(key, request.workflowId)) {
                // Cancel arrived between the visible turn and the rewrite start:
                // never let the rewrite turn run or occupy the Reviewer writer.
                await this.codex.interrupt(started.threadId, started.turnId, undefined, threadOwner).catch(() => undefined);
                throw new Error("cancelled by user (latch)");
              }
              // Same ownership contract as the visible turn: the persisted
              // reviewerTurnId moves to the rewrite turn (thread id unchanged).
              await request.onStarted?.(started);
            },
          }, signal);
          resumedResult = undefined;
          let rewrittenError: string | undefined;
          if (rewrite.kind !== "completed") {
            rewrittenError = "rewrite requested user input";
          } else if (rewrite.status !== "completed") {
            rewrittenError = rewrite.status === "interrupted"
              ? (this.interruptOrigins.get(key) ?? "rewrite interrupted (no origin recorded)")
              : `rewrite turn ${rewrite.status}`;
          } else {
            // The rewrite's AUTHORITY is its persisted history — the turn
            // APPENDED since the rewrite baseline — never the in-memory text.
            // A missing/ambiguous rewrite read-back is retryable too.
            const persistedRewrite = request.ephemeral
              ? { text: rewrite.text ?? "" }
              : await this.codex.readAppendedTurnText(reviewerThreadId, rewriteBaseline!, signal);
            if (!persistedRewrite) {
              rewrittenError = "persisted rewrite read-back missing or ambiguous";
            } else {
              rewrittenError = reviewDisplayError(persistedRewrite.text, displayContext);
              if (!rewrittenError) authoritativeText = persistedRewrite.text;
            }
          }
          if (rewrittenError) {
            // A display-violating review is never a terminal submission failure:
            // the DSH workflow stays retryable and no verdict (especially no
            // `pass`) can be derived from a review that violates the contract.
            this.interruptOrigins.delete(key);
            return { kind: "retryable_busy", reason: compactDiagnostic(`review violates the display contract: ${rewrittenError}`) };
          }
          // The rewrite turn has COMPLETED: remove it from the active map so
          // a cancel in the rewrite->fork window never interrupts it; the
          // fork's onStarted re-registers and latch-checks itself.
          clearActive();
        } else {
          // EMPTY visible review: nothing to re-present (a rewrite would have
          // to invent the review = a hidden re-review) — fail retryably.
          this.interruptOrigins.delete(key);
          return { kind: "retryable_busy", reason: "review violates the display contract: review is empty" };
        }
      }
      validatedText = authoritativeText;
      }

      // Structured conversion inside an EPHEMERAL fork of the workflow task:
      // read-only, SAME effective model (the configured/override model, or the
      // resolved server default — never a silent re-pick), effort low, review
      // output schema. The fork's thread/turn id is tracked as the active turn
      // for cancellation but is NEVER persisted, so reviewerThreadId keeps
      // pointing at the durable visible workflow task.
      ensureRunning();
      if (retained?.visibleText && !resumedResult) await request.onContinuation?.("继续完成上次审查结果的结构化校验，沿用原审查结果。");
      await request.onVisibleReview?.(authoritativeText);
      const effectiveModel = resumedResult ? undefined : request.model || await this.codex.resolveDefaultModel(signal) || undefined;
      const conversionOptions = {
        ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
        prompt: reviewConversionPrompt(authoritativeText, request.workflowId),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        effort: "low" as const,
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        conversion: true,
        onStarted: async (started: { threadId: string; turnId: string }) => {
          const threadOwner = registerActive(started);
          if (this.isLatched(key, request.workflowId)) {
            await this.codex.interrupt(started.threadId, started.turnId, undefined, threadOwner).catch(() => undefined);
            throw new Error("cancelled by user (latch)");
          }
          await request.onEphemeralStarted?.(started);
        },
      };
      pendingStep = { kind: "conversion" };
      const converted = resumedResult ?? (request.ephemeral
        ? await this.codex.startTurn(reviewerThreadId, conversionOptions, signal)
        : await this.codex.normalizeInFork({
          ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
          threadId: reviewerThreadId,
          cwd: request.cwd,
          prompt: conversionOptions.prompt,
          ...(effectiveModel ? { model: effectiveModel } : {}),
          outputSchema: conversionOptions.outputSchema,
          onStarted: conversionOptions.onStarted,
        }, signal));
      clearActive();
      // 1.0.7 failure semantics: the NORMALIZATION (ephemeral conversion)
      // missing/unsuccessful/invalid output is an infrastructure-class
      // failure — RETRYABLE with backoff, NEVER a terminal submission
      // failure/notice, and it consumes no review cycle. Only an invalid
      // source task (CodexInvalidThreadError) stays terminal.
      if (converted.kind !== "completed" || converted.status !== "completed") {
        const reason = converted.kind !== "completed"
          ? "conversion requested user input"
          : converted.status === "interrupted"
            ? (this.interruptOrigins.get(key) ?? "conversion interrupted (no origin recorded)")
            : `normalization turn ${converted.status}`;
        this.interruptOrigins.delete(key);
        return waitInThread(reason);
      }
      try {
        return { kind: "verdict", verdict: parseReviewResult(JSON.parse(converted.text)) };
      } catch (error) {
        return waitInThread("normalization output invalid");
      }
    } catch (error) {
      if (error instanceof CodexTurnReceiptPendingError) return waitForStartReceipt(error);
      if (retained?.pendingStart && !retained.pendingStart.operation.finished()) {
        if (!signal?.aborted && !this.isLatched(key, request.workflowId)) {
          retained.pendingStartIntent = "terminal";
          retained.terminalFailure = error instanceof CodexInvalidThreadError || error instanceof CodexNoVerdictError
            || error instanceof CodexCallbackProcessError ? error : new CodexCallbackProcessError(errorMessage(error));
        }
        return waitForStartReceipt(retained.pendingStart);
      }
      if (error instanceof CodexTurnInterruptionError) return waitForInterruption(error);
      // A latched cancellation (cancel raced a turn start) is retryable with
      // the attributed origin, never terminal.
      if (this.isLatched(key, request.workflowId)) {
        return { kind: "retryable_busy", reason: "cancelled by user (latch)" };
      }
      if (signal?.aborted) {
        if (request.ephemeral && reviewerThreadId && claimed
          && this.threadAvailable({ threadId: reviewerThreadId, threadOwner: reviewerThreadOwner })) {
          return waitInThread("caller wait interrupted; the original Reviewer is waiting for continuation", undefined, true);
        }
        throw abortError(signal);
      }
      if (
        error instanceof CodexInvalidThreadError
        || error instanceof CodexNoVerdictError
        || error instanceof CodexCallbackProcessError
      ) throw error;
      const message = errorMessage(error);
      if (/no rollout found for thread id/i.test(message)) {
        throw new CodexInvalidThreadError(`codex thread ${request.codexThreadId} does not exist`);
      }
      const transient = transientReason(message);
      if (transient) return waitInThread(transient);
      if (isRecoverableModelFailure(message)) {
        return waitInThread(/^Codex turn timed out:\s+\S+$/i.test(message.trim())
          ? "turn timeout" : "model failure; the same Reviewer session is waiting for continuation");
      }
      if (/returned task .*expected the workflow task/i.test(message)) {
        // The App Server reported a DIFFERENT review task through onStarted:
        // the rogue turn was interrupted before anything was tracked or
        // persisted. Like writer conflicts and timeouts this is an
        // infrastructure-class anomaly — retryable with backoff, never a
        // terminal submission failure and never a verdict.
        return { kind: "retryable_busy", reason: message };
      }
      throw new CodexCallbackProcessError(`reviewer failed: ${compactDiagnostic(message)}`);
    } finally {
      this.preparing.delete(key);
      clearActive();
      this.cancelledByKey.delete(key);
      // Idempotently release the plugin's App Server subscription on every
      // path: pass, changes_requested, terminal error, interrupt/cancel — but
      // only when THIS invocation acquired the claim. Unsubscribe unloads this
      // client subscription; it does not delete the persistent Desktop task.
      if (!retainReviewer) await releaseOwned();
    }
  }

  /** Whether a Reviewer turn for this workflow is currently registered as
   * running. Consulted by `codex_workflow_status` so `reviewerActive` reflects
   * a live turn, never a persisted-but-finished one (retry backoff, verdict
   * delivery, terminal states). */
  activeReview(workflowId: string): boolean {
    for (const [key, active] of this.active) {
      if (key.startsWith(`${workflowId}:`) && this.threadAvailable(active)) return true;
    }
    return false;
  }

  private trackThreadRef(thread: ThreadClaim, delta: number): void {
    const owners = this.threadRefs.get(thread.threadId) ?? new Map<object | undefined, number>();
    const next = (owners.get(thread.threadOwner) ?? 0) + delta;
    if (next <= 0) owners.delete(thread.threadOwner);
    else owners.set(thread.threadOwner, next);
    if (!owners.size) this.threadRefs.delete(thread.threadId);
    else this.threadRefs.set(thread.threadId, owners);
  }

  private async releaseThread(thread: ThreadClaim): Promise<void> {
    const owners = this.threadRefs.get(thread.threadId);
    const count = owners?.get(thread.threadOwner);
    if (count === undefined) return;
    const next = count - 1;
    if (next > 0) {
      owners!.set(thread.threadOwner, next);
      return;
    }
    owners!.delete(thread.threadOwner);
    if (!owners!.size) this.threadRefs.delete(thread.threadId);
    // Best-effort: a failed unsubscribe must never mask or alter the review
    // result. The App Server answers idempotently, so a duplicate (e.g. after
    // restart recovery) is a harmless `notSubscribed`.
    await this.codex.unsubscribeThread(thread.threadId, undefined, thread.threadOwner).catch(() => undefined);
  }
}

function compactDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_048);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

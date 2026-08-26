import type { CodexAppServerClient } from "./app-server.js";
import { parseReviewResult } from "./bridge-protocol.js";
import {
  CodexCallbackProcessError,
  CodexInvalidThreadError,
  CodexNoVerdictError,
  type CodexCallbackRequest,
  type CodexCallbackResult,
} from "./codex-callback.js";
import { REVIEW_OUTPUT_SCHEMA } from "./schemas.js";

interface ActiveReview {
  threadId: string;
  turnId: string;
}

/**
 * Production callback path for Codex-led workflows.
 *
 * The originating Codex Desktop task remains the immutable source. The first
 * review validates the source task read-only (`thread/read`, no turns), then
 * creates a brand-new durable Reviewer task (`thread/start`) that inherits none
 * of the source history or writer state — so Codex Desktop can keep the source
 * open and be its active writer without any conflict. Later review cycles
 * resume that same persisted Reviewer so review context is preserved without
 * ever mutating the source.
 */
export class AppServerCodexCallbackDispatcher {
  private readonly active = new Map<string, ActiveReview>();
  private readonly sends = new Set<Promise<unknown>>();
  /** Number of currently-running review turns per Reviewer thread. A thread is
   * only unsubscribed (and its plugin writer hold released) once its refcount
   * returns to zero, so a thread shared by a concurrent review is never
   * released under it, and a finished workflow never closes the App Server
   * another workflow is still using. */
  private readonly threadRefs = new Map<string, number>();
  /** Who requested an interrupt for a submission (keyed by
   * `workflowId:submissionId`): `cancel` (explicit user cancel),
   * `cancelSubmission` (lease lost), `stop` (plugin teardown). Consulted when a
   * Reviewer turn settles `interrupted` so the persisted reason is accurate. */
  private readonly interruptOrigins = new Map<string, string>();
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly codex: CodexAppServerClient) {}

  send(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult> {
    if (this.stopped) return Promise.reject(new Error("codex callback dispatcher is stopped"));
    const task = this.run(request, signal);
    this.sends.add(task);
    void task.finally(() => this.sends.delete(task)).catch(() => undefined);
    return task;
  }

  cancel(workflowId: string): void {
    if (this.stopped) return;
    for (const [key, review] of this.active) {
      if (key.startsWith(`${workflowId}:`)) {
        this.interruptOrigins.set(key, "cancelled by user");
        void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
      }
    }
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    if (this.stopped) return;
    const key = `${workflowId}:${submissionId}`;
    const review = this.active.get(key);
    if (review) {
      this.interruptOrigins.set(key, "lease lost (callback taken over)");
      void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    for (const [key, review] of this.active) {
      this.interruptOrigins.set(key, "plugin teardown");
      void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
    }
    await Promise.allSettled([...this.active.values()].map((review) =>
      this.codex.interrupt(review.threadId, review.turnId),
    ));
    await Promise.allSettled([...this.sends]);
    this.active.clear();
    this.threadRefs.clear();
  }

  private async run(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult> {
    const key = `${request.workflowId}:${request.submissionId}`;
    let reviewerThreadId: string | undefined;
    // True only once THIS invocation owns a live claim on the Reviewer thread.
    // In the resume path the claim is acquired only after resume succeeds, just
    // before a turn runs (so a pre-turn failure can never release another
    // active review's reference). In the fresh-create path the brand-new thread
    // is exclusively ours and the claim is acquired immediately after creation,
    // so even an `onThread`-persistence failure still releases it.
    let claimed = false;
    try {
      reviewerThreadId = request.reviewerThreadId;
      if (reviewerThreadId) {
        await this.codex.resumeThread(reviewerThreadId, request.cwd, signal);
      } else {
        // First review: validate the source task exists, then create a fresh
        // durable Reviewer that inherits nothing from the source history.
        // Setup failures inside startReviewerThread already unsubscribe the
        // half-configured thread; on success the thread is exclusively ours.
        await this.codex.validateSourceThread(request.codexThreadId, signal);
        reviewerThreadId = await this.codex.startReviewerThread({
          cwd: request.cwd,
          name: request.reviewerName ?? `DSH Reviewer ${request.workflowId}`,
          ...(request.model ? { model: request.model } : {}),
        }, signal);
        this.trackThreadRef(reviewerThreadId, 1);
        claimed = true;
        // A persistence/ownership failure after creation must still release the
        // freshly subscribed thread (handled by the finally below).
        await request.onThread?.(reviewerThreadId);
      }

      if (!claimed) {
        // Resume path: this run now owns one active turn on the Reviewer thread;
        // it is released in the finally below.
        this.trackThreadRef(reviewerThreadId, 1);
        claimed = true;
      }

      const result = await this.codex.startTurn(reviewerThreadId, {
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        // Protocol-level pin: silent, non-collaborative, single-verdict review.
        silentReview: true,
        onStarted: async (started) => {
          this.active.set(key, started);
          await request.onStarted?.(started);
        },
      }, signal);
      if (result.kind !== "completed") {
        throw new CodexNoVerdictError("reviewer unexpectedly requested user input");
      }
      if (result.status !== "completed") {
        if (result.status === "interrupted") {
          // Attribute WHY the turn was interrupted so the stuck-state
          // diagnostics and persistent recovery know the origin.
          const origin = this.interruptOrigins.get(key) ?? "interrupted turn (no origin recorded)";
          this.interruptOrigins.delete(key);
          return { kind: "retryable_busy", reason: origin };
        }
        throw new CodexCallbackProcessError(
          `reviewer turn ${result.turnId} failed${result.error ? `: ${result.error}` : ""}${result.reason ? ` (${result.reason})` : ""}`,
        );
      }
      // Only a successful turn ever reaches here; its text is the final
      // completed assistant output (see turnResult in app-server.ts).
      try {
        return { kind: "verdict", verdict: parseReviewResult(JSON.parse(result.text)) };
      } catch (error) {
        throw new CodexNoVerdictError(`reviewer returned an invalid verdict: ${errorMessage(error)}`);
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (
        error instanceof CodexInvalidThreadError
        || error instanceof CodexNoVerdictError
        || error instanceof CodexCallbackProcessError
      ) throw error;
      const message = errorMessage(error);
      if (/no rollout found for thread id/i.test(message)) {
        throw new CodexInvalidThreadError(`codex thread ${request.codexThreadId} does not exist`);
      }
      if (/Codex turn timed out|timed out/i.test(message)) {
        return { kind: "retryable_busy", reason: "turn timeout" };
      }
      if (/429 Too Many Requests|exceeded retry limit|rate limit/i.test(message)) {
        return { kind: "retryable_busy", reason: "rate limit" };
      }
      if (/already in use|already has an active writer/i.test(message)) {
        return { kind: "retryable_busy", reason: "active writer" };
      }
      throw new CodexCallbackProcessError(`reviewer failed: ${compactDiagnostic(message)}`);
    } finally {
      this.active.delete(key);
      // Idempotently release the plugin's claim on the Reviewer thread on every
      // path: pass, changes_requested, terminal error, interrupt/cancel — but
      // only when THIS invocation acquired the claim. The source task is never
      // tracked here and is never unsubscribed.
      if (reviewerThreadId && claimed) await this.releaseThread(reviewerThreadId);
    }
  }

  /** Whether a Reviewer turn for this workflow is currently registered as
   * running. Consulted by `codex_workflow_status` so `reviewerActive` reflects
   * a live turn, never a persisted-but-finished one (retry backoff, verdict
   * delivery, terminal states). */
  activeReview(workflowId: string): boolean {
    for (const key of this.active.keys()) {
      if (key.startsWith(`${workflowId}:`)) return true;
    }
    return false;
  }

  private trackThreadRef(threadId: string, delta: number): void {
    const next = (this.threadRefs.get(threadId) ?? 0) + delta;
    if (next <= 0) this.threadRefs.delete(threadId);
    else this.threadRefs.set(threadId, next);
  }

  private async releaseThread(threadId: string): Promise<void> {
    const next = (this.threadRefs.get(threadId) ?? 0) - 1;
    if (next > 0) {
      this.threadRefs.set(threadId, next);
      return;
    }
    this.threadRefs.delete(threadId);
    if (this.stopped) return;
    // Best-effort: a failed unsubscribe must never mask or alter the review
    // result. The App Server answers idempotently, so a duplicate (e.g. after
    // restart recovery) is a harmless `notSubscribed`.
    await this.codex.unsubscribeThread(threadId).catch(() => undefined);
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

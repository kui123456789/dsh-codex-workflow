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
import { reviewConversionPrompt } from "./workflow.js";
import { reviewDisplayError, reviewRewritePrompt } from "./review-contract.js";

interface ActiveReview {
  threadId: string;
  turnId: string;
}

/**
 * Production callback path for Codex-led workflows.
 *
 * The originating Codex Desktop task is the durable workflow task. The first
 * review validates it read-only (`thread/read`, no turns), then resumes that
 * SAME task and appends the visible review there. Later review cycles resume
 * the same persisted id. Old workflows that already have a distinct
 * reviewerThreadId keep using it for compatibility.
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
    // Latch the workflow BEFORE interrupting: a turn that starts later (e.g.
    // the ephemeral normalization fork, which only begins after the visible
    // turn completed) must still be interrupted immediately.
    this.cancelledWorkflows.add(workflowId);
    for (const [key, review] of this.active) {
      if (key.startsWith(`${workflowId}:`)) {
        this.cancelledByKey.set(key, true);
        this.interruptOrigins.set(key, "cancelled by user");
        void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
      }
    }
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    if (this.stopped) return;
    const key = `${workflowId}:${submissionId}`;
    this.cancelledByKey.set(key, true);
    const review = this.active.get(key);
    if (review) {
      this.interruptOrigins.set(key, "lease lost (callback taken over)");
      void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
    }
  }

  /** Whether this workflow's callback run has been cancelled (any submission).
   * Used by the owner (WorkflowManager) to classify a latched cancellation. */
  isCancelled(workflowId: string): boolean {
    return this.cancelledWorkflows.has(workflowId);
  }

  /** The cancellation latch for the exact submission (workflow-level or
   * submission-level). A turn starting after the latch was set must never run. */
  private isLatched(key: string, workflowId: string): boolean {
    return this.cancelledWorkflows.has(workflowId) || this.cancelledByKey.has(key);
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
    // True only once THIS invocation owns an App Server subscription to the
    // task carrying the review. The claim is acquired only after resume
    // succeeds, so a pre-turn failure cannot release another review's hold.
    let claimed = false;
    try {
      reviewerThreadId = request.reviewerThreadId;
      if (!reviewerThreadId) {
        // New workflow: review in the exact source task. A live writer conflict
        // is retried below; creating a second visible task is forbidden.
        await this.codex.validateSourceThread(request.codexThreadId, signal);
        reviewerThreadId = request.codexThreadId;
      }
      await this.codex.resumeThread(reviewerThreadId, request.cwd, signal);
      this.trackThreadRef(reviewerThreadId, 1);
      claimed = true;
      if (!request.reviewerThreadId) {
        // Persist the shared identity only after resume succeeds. A busy source
        // remains unbound and can be retried without a stale reviewer id.
        await request.onThread?.(reviewerThreadId);
      }

      // The VISIBLE Reviewer turn never carries an outputSchema: its readable
      // Markdown review (in the original task's language) is what Codex
      // Desktop keeps in the durable task history. The protocol-level pin
      // keeps the turn silent and non-collaborative. The PERSISTED-turn
      // baseline is captured BEFORE the turn starts: the appended
      // (newly-persisted) turn is later detected against these ids, because
      // the `turn/start` RPC id is NOT guaranteed to equal the persisted
      // `thread.turns[].id` (real App Server evidence).
      const visibleBaseline = await this.codex.captureTurnBaseline(reviewerThreadId, signal);
      const result = await this.codex.startTurn(reviewerThreadId, {
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        silentReview: true,
        onStarted: async (started) => {
          // Same 1.0.8 invariant as the DSH-led path, enforced BEFORE any
          // tracking: the App Server's reported review task must be the
          // workflow task we validated/resumed. A mismatched id (a second
          // visible task) is interrupted immediately and the submission stays
          // retryable — it can never enter the active map or the persisted
          // reviewerThreadId.
          if (started.threadId !== reviewerThreadId) {
            await this.codex.interrupt(started.threadId, started.turnId).catch(() => undefined);
            throw new Error(`review/start returned task ${started.threadId}, expected the workflow task ${reviewerThreadId}; refusing to track a second visible task`);
          }
          this.active.set(key, started);
          if (this.isLatched(key, request.workflowId)) {
            // Cancel won between turn/start and registration (visible -> fork
            // window): never let this turn run or occupy the Reviewer writer.
            await this.codex.interrupt(started.threadId, started.turnId).catch(() => undefined);
            throw new Error("cancelled by user (latch)");
          }
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
      // The visible turn has COMPLETED: it is no longer a valid interrupt
      // target. Remove it from the active map NOW, so a cancel arriving in
      // the visible->rewrite/read-back/fork window can never interrupt an
      // already-completed source-task turn — the cancellation LATch instead
      // stops every turn that starts afterwards (rewrite and fork both
      // re-register and check the latch in their onStarted).
      this.active.delete(key);
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
      const displayContext = { task: request.task ?? "", planMarkdown: request.planMarkdown };
      // The native review's AUTHORITY is the turn APPENDED to the persisted
      // history since the pre-turn baseline (never the RPC turn id — real App
      // Server evidence shows native review RPC turn ids that never appear in
      // the persisted rollout history). Missing/ambiguous -> retryable.
      const persistedNative = await this.codex.readAppendedTurnText(reviewerThreadId, visibleBaseline, signal);
      if (!persistedNative) {
        this.interruptOrigins.delete(key);
        return { kind: "retryable_busy", reason: "persisted review read-back missing or ambiguous" };
      }
      let authoritativeText = persistedNative.text;
      const displayError = reviewDisplayError(authoritativeText, displayContext);
      if (displayError) {
        if (authoritativeText.trim().length > 0) {
          // Baseline BEFORE the rewrite turn, exactly like the native turn.
          const rewriteBaseline = await this.codex.captureTurnBaseline(reviewerThreadId, signal);
          const rewrite = await this.codex.startTurn(reviewerThreadId, {
            prompt: reviewRewritePrompt(authoritativeText, displayContext),
            ...(request.model ? { model: request.model } : {}),
            effort: "low",
            silentReview: true,
            onStarted: async (started) => {
              this.active.set(key, started);
              if (this.isLatched(key, request.workflowId)) {
                // Cancel arrived between the visible turn and the rewrite start:
                // never let the rewrite turn run or occupy the Reviewer writer.
                await this.codex.interrupt(started.threadId, started.turnId).catch(() => undefined);
                throw new Error("cancelled by user (latch)");
              }
              // Same ownership contract as the visible turn: the persisted
              // reviewerTurnId moves to the rewrite turn (thread id unchanged).
              await request.onStarted?.(started);
            },
          }, signal);
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
            const persistedRewrite = await this.codex.readAppendedTurnText(reviewerThreadId, rewriteBaseline, signal);
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
          this.active.delete(key);
        } else {
          // EMPTY visible review: nothing to re-present (a rewrite would have
          // to invent the review = a hidden re-review) — fail retryably.
          this.interruptOrigins.delete(key);
          return { kind: "retryable_busy", reason: "review violates the display contract: review is empty" };
        }
      }

      // Structured conversion inside an EPHEMERAL fork of the workflow task:
      // read-only, SAME effective model (the configured/override model, or the
      // resolved server default — never a silent re-pick), effort low, review
      // output schema. The fork's thread/turn id is tracked as the active turn
      // for cancellation but is NEVER persisted, so reviewerThreadId keeps
      // pointing at the durable visible workflow task.
      const effectiveModel = request.model || await this.codex.resolveDefaultModel(signal) || undefined;
      const converted = await this.codex.normalizeInFork({
        threadId: reviewerThreadId,
        cwd: request.cwd,
        prompt: reviewConversionPrompt(authoritativeText, request.workflowId),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        onStarted: async (started) => {
          this.active.set(key, started);
          if (this.isLatched(key, request.workflowId)) {
            // Cancel arrived while the fork RPCs were in flight: interrupt the
            // freshly started ephemeral turn immediately.
            await this.codex.interrupt(started.threadId, started.turnId).catch(() => undefined);
            throw new Error("cancelled by user (latch)");
          }
          await request.onEphemeralStarted?.(started);
        },
      }, signal);
      this.active.delete(key);
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
        return { kind: "retryable_busy", reason };
      }
      try {
        return { kind: "verdict", verdict: parseReviewResult(JSON.parse(converted.text)) };
      } catch (error) {
        return { kind: "retryable_busy", reason: "normalization output invalid" };
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      // A latched cancellation (cancel raced a turn start) is retryable with
      // the attributed origin, never terminal.
      if (this.isLatched(key, request.workflowId)) {
        return { kind: "retryable_busy", reason: "cancelled by user (latch)" };
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
      if (/Codex turn timed out|timed out/i.test(message)) {
        return { kind: "retryable_busy", reason: "turn timeout" };
      }
      if (/429 Too Many Requests|exceeded retry limit|rate limit/i.test(message)) {
        return { kind: "retryable_busy", reason: "rate limit" };
      }
      if (/already in use|already has an active writer/i.test(message)) {
        return { kind: "retryable_busy", reason: "active writer" };
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
      this.active.delete(key);
      this.cancelledByKey.delete(key);
      // Idempotently release the plugin's App Server subscription on every
      // path: pass, changes_requested, terminal error, interrupt/cancel — but
      // only when THIS invocation acquired the claim. Unsubscribe unloads this
      // client subscription; it does not delete the persistent Desktop task.
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

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
      if (key.startsWith(`${workflowId}:`)) void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
    }
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    if (this.stopped) return;
    const review = this.active.get(`${workflowId}:${submissionId}`);
    if (review) void this.codex.interrupt(review.threadId, review.turnId).catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((review) =>
      this.codex.interrupt(review.threadId, review.turnId),
    ));
    await Promise.allSettled([...this.sends]);
    this.active.clear();
  }

  private async run(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult> {
    const key = `${request.workflowId}:${request.submissionId}`;
    try {
      let reviewerThreadId = request.reviewerThreadId;
      if (reviewerThreadId) {
        await this.codex.resumeThread(reviewerThreadId, request.cwd, signal);
      } else {
        // First review: validate the source task exists, then create a fresh
        // durable Reviewer that inherits nothing from the source history.
        await this.codex.validateSourceThread(request.codexThreadId, signal);
        reviewerThreadId = await this.codex.startReviewerThread({
          cwd: request.cwd,
          name: request.reviewerName ?? `DSH Reviewer ${request.workflowId}`,
          ...(request.model ? { model: request.model } : {}),
        }, signal);
        await request.onThread?.(reviewerThreadId);
      }

      const result = await this.codex.startTurn(reviewerThreadId, {
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        onStarted: async (started) => {
          this.active.set(key, started);
          await request.onStarted?.(started);
        },
      }, signal);
      if (result.kind !== "completed") {
        throw new CodexNoVerdictError("reviewer unexpectedly requested user input");
      }
      if (result.status !== "completed") {
        if (result.status === "interrupted") return { kind: "retryable_busy" };
        throw new CodexCallbackProcessError(
          `reviewer turn ${result.turnId} failed${result.error ? `: ${result.error}` : ""}`,
        );
      }
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
      if (/429 Too Many Requests|exceeded retry limit|rate limit|already in use|already has an active writer/i.test(message)) {
        return { kind: "retryable_busy" };
      }
      throw new CodexCallbackProcessError(`reviewer failed: ${compactDiagnostic(message)}`);
    } finally {
      this.active.delete(key);
    }
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

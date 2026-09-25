import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CoordinationStore } from "./coordination.js";
import {
  CodexCallbackProcessError,
  CodexInvalidThreadError,
  CodexNoVerdictError,
  type CodexCallbackRequest,
  type CodexCallbackResult,
} from "./codex-callback.js";
import {
  newRequestId,
  type BridgeCommand,
  type DispatchPlanCommand,
  type SubmissionNoticeCommand,
  type SubmitVerdictCommand,
} from "./bridge-protocol.js";
import { collectEvidence, isGitRepository } from "./evidence.js";
import { noticeSource } from "./message-source.js";
import { backoffDelayMs, compactDiagnostic, normalizeBackoff, retryTransient, transientReason, type BackoffPolicy } from "./transient-retry.js";
import {
  SILENT_REVIEW_PROMPT_BLOCK,
  reviewDisplayError,
  reviewRewritePrompt,
} from "./review-contract.js";
import {
  ALIGN_OUTPUT_SCHEMA,
  AUTHORITY_HIERARCHY,
  parseAlignment,
  reconciliationPreservationViolation,
  reviewAlignPrompt,
  reviewReconcilePrompt,
} from "./review-authority.js";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { WorkflowStore } from "./store.js";
import { LifecycleFlow } from "./application/lifecycle-flow.js";
import { PlannerFlow } from "./application/planner-flow.js";
import { PlannerExecution } from "./application/planner-execution.js";
import { ReviewFlow } from "./application/review-flow.js";
import { SubmissionFlow } from "./application/submission-flow.js";
import { ReviewerGateway } from "./application/app-server/reviewer-gateway.js";
import { ThreadGateway } from "./application/app-server/thread-gateway.js";
import { TurnGateway } from "./application/app-server/turn-gateway.js";
import { WorkflowRuntimeState } from "./application/workflow-runtime-state.js";
import { ReviewObservation } from "./application/review-observation.js";
import { ReviewExecution } from "./application/review-execution.js";
import { SubmissionExecution } from "./application/submission-execution.js";
import { LifecycleExecution } from "./application/lifecycle-execution.js";
import type {
  AlignmentOutcome,
  PersistedTurnBaseline,
  PlannerResult,
  ReviewConflict,
  ReviewConflictInfo,
  ReviewEvidence,
  ReviewInput,
  ReviewResult,
  SubmissionState,
  TurnNeedsInputResult,
  TurnWaitResult,
  WorkflowConfig,
  WorkflowPhase,
  WorkflowRecord,
} from "./types.js";
import type { CodexCliAuditGateway } from "./codex-cli-audit.js";
import type { CodexWorkflowSessionEvent } from "./review-events.js";

const execFileAsync = promisify(execFile);

export interface CodexGateway {
  startThread(options: { cwd: string; model?: string; name?: string; ephemeral?: boolean }, signal?: AbortSignal): Promise<string>;
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  startTurn(threadId: string, options: {
    prompt: string;
    model?: string;
    effort?: WorkflowConfig["plannerEffort"];
    outputSchema?: Record<string, unknown>;
    conversion?: boolean;
    planMode?: boolean;
    /** Pin the turn to the silent single-message review mode (non-collaborative
     * "default" mode with the silent-review developer instructions at protocol
     * level). Used by the DISPLAY-REWRITE turn on the durable Reviewer task:
     * it emits exactly one final message and can never start sub-tasks. */
    silentReview?: boolean;
    /** Reports the EFFECTIVE model the turn actually runs with (explicit
     * override or the collaboration-mode-resolved model), so callers can
     * persist it and reuse it for later turns and forks. */
    onModel?: (model: string) => void;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<TurnWaitResult>;
  continueTurn(
    pending: TurnNeedsInputResult,
    answers: Record<string, string[]>,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult>;
  startReview(options: {
    threadId: string;
    cwd: string;
    target: Record<string, unknown>;
    detached: boolean;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
  /** 1.1.2: set a thread's display name. Works on a thread that is NOT loaded,
   * so it never takes the writer lock. Optional: limited gateways may omit it. */
  nameThread?(threadId: string, name: string, signal?: AbortSignal): Promise<void>;
  interrupt(threadId: string, turnId: string, signal?: AbortSignal): Promise<void>;
  unsubscribeThread?(threadId: string, signal?: AbortSignal): Promise<unknown>;
  /** 1.1.6: pin the App Server child for the duration of a round, so the idle
   * window can never fall between creating a thread and its first turn (the
   * respawned process would answer `thread not found` for the new thread). */
  beginRound?(): void;
  /** Release a round pin (`beginRound`). */
  endRound?(): void;
  releaseThreadForExternal?(threadId: string, signal?: AbortSignal): Promise<void>;
  /** Structured conversion of a visible reply inside an EPHEMERAL fork of the
   * given persistent thread (`thread/fork` with `ephemeral: true` + one
   * read-only `turn/start` carrying the output schema). The fork is
   * unsubscribed exactly once on every ending path and its id must never be
   * persisted into plannerThreadId/reviewerThreadId. */
  normalizeInFork(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    model?: string;
    outputSchema: Record<string, unknown>;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<TurnWaitResult>;
  /** The App Server's default model selection (when present). Used to make the
   * reviewer model explicit even when nothing is configured, so visible
   * reviewer turns and their conversion forks always share one model. */
  resolveDefaultModel?(signal?: AbortSignal): Promise<string | undefined>;
  /** Create a fresh, durable, empty REVIEWER thread (never copying the source
   * chat history) with the readable review contract + full context as its
   * developer instructions (AUXILIARY channel only: a native review turn may
   * not reliably see thread-settings instructions), plus model/safety
   * settings. Since 1.1.0 this is the ONLY way a review task comes into
   * existence on this path: every review — planned, bridge or `review_only` —
   * runs on its own dedicated Reviewer thread and never resumes the Planner
   * or origin task. Verdict correctness never depends on the developer
   * instructions — the full per-round context AND the item-by-item coverage
   * gate ride the `review/start` custom target on every round. */
  startReviewerThread?(options: {
    cwd: string;
    name?: string;
    model?: string;
    developerInstructions?: string;
    ephemeral?: boolean;
  }, signal?: AbortSignal): Promise<string>;
  /** 1.1.3: `thread/start` alone (see `startReviewerThreadShell`). Optional:
   * when a gateway provides BOTH this and `configureReviewerThread`, the
   * manager retries a failed configuration on the SAME task instead of creating
   * one orphan task per attempt. */
  startReviewerThreadShell?(options: {
    cwd: string;
    name?: string;
    model?: string;
    developerInstructions?: string;
    ephemeral?: boolean;
  }, signal?: AbortSignal): Promise<string>;
  /** 1.1.3: settings + display name of an already created Reviewer task. */
  configureReviewerThread?(threadId: string, options: {
    cwd: string;
    name?: string;
    model?: string;
    developerInstructions?: string;
    ephemeral?: boolean;
  }, signal?: AbortSignal): Promise<void>;
  /** Refresh the per-round readable contract/context as developer instructions
   * on the durable Reviewer thread before a re-review runs. AUXILIARY channel
   * only: the `review/start` custom target carries the complete per-round
   * context (original task, approved plan, implementation summary, test
   * results, workspace evidence) plus the coverage gate on every path, Git
   * included — so verdict correctness never depends on this thread-settings
   * refresh reaching the model. */
  updateReviewerInstructions?(threadId: string, cwd: string, instructions: string, signal?: AbortSignal): Promise<void>;
  /** Capture the PERSISTED-turn baseline of a durable thread (`thread/read`,
   * `includeTurns: true`) BEFORE a visible review/rewrite turn starts: the
   * ids of the turns already in the history. The appended turn is later
   * detected against this set, because the RPC turn id of `review/start`/
   * `turn/start` is NOT guaranteed to equal the persisted `thread.turns[].id`
   * (real App Server evidence). */
  captureTurnBaseline?(threadId: string, signal?: AbortSignal): Promise<PersistedTurnBaseline>;
  /** Read the PERSISTED final visible output of the turn appended to a
   * durable thread since its baseline — the authoritative display text Codex
   * Desktop actually shows, which can differ from the streamed/`turn/
   * completed` aggregation in `TurnWaitResult.text`. Exactly one new
   * COMPLETED turn must have appeared: zero (missing) or several (ambiguous)
   * return `undefined`, and callers must treat that as a retryable failure —
   * NEVER fall back to the in-memory text. */
  readAppendedTurnText?(threadId: string, baseline: PersistedTurnBaseline, signal?: AbortSignal): Promise<{ text: string; itemType?: string } | undefined>;
}

export type { ReviewInput };

/**
 * 1.1.0 Reviewer ownership: a Reviewer task is ALWAYS a dedicated thread —
 * never the Planner task, never the bridge origin task.
 *
 * Older records bound the Reviewer to a SHARED task: `reviewerThreadId ===
 * plannerThreadId` for DSH-led planned workflows, `=== codexThreadId` for the
 * legacy App Server callback. Such an alias is treated here as UNBOUND, so the
 * next review lazily binds a dedicated Reviewer instead of resuming the shared
 * task. Resuming it is exactly what froze a real workflow: Codex Desktop keeps
 * a writer lock on every thread it has loaded, so a Planner/origin task that
 * the Desktop still holds made every review fail with
 * `thread-store conflict: thread <id> already has an active writer` — a lock
 * the plugin has no way to release. Records that already carry a dedicated
 * Reviewer id are unaffected and keep their task.
 */
/**
 * 1.1.1 retry criterion, shared by EVERY visible turn (planner, completion,
 * visible review, display rewrite, reconciliation).
 *
 * A turn is retryable ONLY when it ended NOT completed AND produced no visible
 * text — nothing was persisted that a retry could duplicate — and its diagnostic
 * is a TRANSIENT upstream condition. Terminal failures (invalid thread,
 * approval denial, schema/display-contract violation) are never retried: they
 * are returned unchanged so the caller classifies them.
 */
function transientTurnReason(outcome: TurnWaitResult): string | undefined {
  if (outcome.kind !== "completed") return undefined;
  const failedWithoutOutput = outcome.status !== "completed" && (outcome.text ?? "").trim().length === 0;
  return failedWithoutOutput ? transientReason(`${outcome.error ?? ""} ${outcome.reason ?? ""}`) : undefined;
}

/** Resumable Reviewer callback injected by the host. */
export interface CodexCallback {
  send(
    request: CodexCallbackRequest,
    signal?: AbortSignal,
  ): Promise<CodexCallbackResult>;
  cancel(workflowId: string): void;
  /** Cancel the exact Reviewer operation for one submission (lease-loss
   * fencing: an owner that lost its lease must cancel its own operation, never the new
   * owner's). */
  cancelSubmission(workflowId: string, submissionId: string): void;
  /** Whether a Reviewer turn is currently running for this workflow (live
   * execution only). Optional: when absent, status falls back to the DSH-led
   * reviewing phase. */
  activeReview?(workflowId: string): boolean;
  stop(): Promise<void>;
}

export class WorkflowManager {
  /** Compatibility facade. Public calls enter the application flows while
   * planner execution and review observation are owned by dedicated modules;
   * the remaining review/submission state machines stay behind this facade
   * until their ports can be moved without widening cancellation ownership. */
  private readonly plannerFlow: PlannerFlow;
  private readonly reviewFlow: ReviewFlow;
  private readonly submissionFlow: SubmissionFlow;
  private readonly lifecycleFlow: LifecycleFlow;
  private readonly reviewerGateway: ReviewerGateway;
  private readonly threadGateway: ThreadGateway;
  private readonly turnGateway: TurnGateway;
  private readonly plannerExecution: PlannerExecution;
  private readonly reviewObservation: ReviewObservation;
  private readonly reviewExecution: ReviewExecution;
  private readonly submissionExecution: SubmissionExecution;
  private readonly lifecycleExecution: LifecycleExecution;
  /** The only owner of in-process flow lifecycle state. */
  private readonly runtime = new WorkflowRuntimeState();
  /** Submission lease lifetime; heartbeats renew at ttl/3 while a callback
   * runs, so only crashed owners are ever taken over. */
  private readonly leaseTtlMs: number;
  /** Seams for the 1.1.1 transient-retry backoff. */
  private readonly retryNow: () => number;
  private readonly retrySleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly retryRandom: () => number;
  private readonly agents?: { get(id: string): Agent | undefined };
  constructor(
    private readonly store: WorkflowStore,
    private readonly codex: CodexGateway,
    private readonly config: WorkflowConfig,
    private readonly callback?: CodexCallback,
    private readonly bridgeQueue?: { enqueue(command: BridgeCommand): Promise<string> },
    private readonly audit?: CodexCliAuditGateway,
    /** 1.1.1 test seams for the transient-retry backoff (never wait for real
     * time in a test). Production passes nothing and uses real timers. */
    retryHooks: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; random?: () => number } = {},
    agents?: { get(id: string): Agent | undefined },
  ) {
    this.agents = agents;
    this.leaseTtlMs = config.leaseTtlMs ?? 60_000;
    this.retryNow = retryHooks.now ?? Date.now;
    this.retrySleep = retryHooks.sleep ?? ((ms, signal) => delay(ms, signal));
    this.retryRandom = retryHooks.random ?? Math.random;
    this.plannerFlow = new PlannerFlow({
      start: this.startInternal.bind(this),
      continue: this.continueInternal.bind(this),
      startExternalPlan: this.startExternalPlanInternal.bind(this),
      onTurnStopping: this.onTurnStoppingInternal.bind(this),
      decide: this.decideInternal.bind(this),
    });
    this.reviewFlow = new ReviewFlow({
      review: this.reviewInternal.bind(this),
      reviewOnly: this.reviewOnlyInternal.bind(this),
      applyExternalVerdict: this.applyExternalVerdictInternal.bind(this),
      assertVerdictStillValid: this.assertVerdictStillValidInternal.bind(this),
    });
    this.submissionFlow = new SubmissionFlow({
      submit: this.submitInternal.bind(this),
      recoverCallbacks: this.recoverCallbacksInternal.bind(this),
      commitVerdictDelivery: this.commitVerdictDeliveryInternal.bind(this),
      commitSubmissionNoticeDelivery: this.commitSubmissionNoticeDeliveryInternal.bind(this),
    });
    this.lifecycleFlow = new LifecycleFlow({
      status: this.statusInternal.bind(this),
      cancel: this.cancelInternal.bind(this),
      stop: this.stopInternal.bind(this),
    });
    this.reviewerGateway = new ReviewerGateway(this.codex);
    this.threadGateway = new ThreadGateway(this.codex);
    this.turnGateway = new TurnGateway(this.codex);
    this.reviewObservation = new ReviewObservation({
      store: this.store,
      runtime: this.runtime,
      heartbeatMs: config.reviewHeartbeatMs ?? 15_000,
      staleMs: config.reviewStaleMs ?? 60_000,
      isSubmissionActive: submissionActive,
      emit: (record, event) => this.emitSessionEvent(record, event),
    });
    this.plannerExecution = new PlannerExecution({
      store: this.store,
      config: this.config,
      pending: this.runtime.pending,
      requireAgent,
      acquireCreateLease: this.acquireWorkflowCreateLease.bind(this),
      assertNoActiveWorkflow: this.assertNoActiveWorkflow.bind(this),
      startThread: this.threadGateway.startThread.bind(this.threadGateway),
      resumeThread: this.threadGateway.resumeThread.bind(this.threadGateway),
      startTurnWithRetry: this.startTurnWithTransientRetry.bind(this),
      continueTurn: this.turnGateway.continueTurn.bind(this.turnGateway),
      registerActiveTurn: this.registerActiveTurn.bind(this),
      acceptPlannerOutcome: this.acceptPlannerOutcome.bind(this),
      owned: this.owned.bind(this),
      trackForeground: this.trackForeground.bind(this),
      plannerPrompt,
      resumedAnswerPrompt,
      threadName,
      errorMessage,
    });
    this.reviewExecution = new ReviewExecution({
      store: this.store,
      config: this.config,
      runtime: this.runtime,
      reviewObservation: this.reviewObservation,
      turnGateway: this.turnGateway,
      audit: this.audit,
      trackNoChange: this.trackNoChange.bind(this),
      createReviewerThread: this.createReviewerThread.bind(this),
      releaseUnboundReviewer: this.releaseUnboundReviewer.bind(this),
      reportCleanupNote: this.reportCleanupNote.bind(this),
      alignReview: this.alignReview.bind(this),
      reconcileReview: this.reconcileReview.bind(this),
      computeReviewOutcome: this.computeReviewOutcome.bind(this),
      registerActiveTurn: this.registerActiveTurn.bind(this),
      registerEphemeralTurn: this.registerEphemeralTurn.bind(this),
      startReviewWithTransientRetry: this.startReviewWithTransientRetry.bind(this),
      startTurnWithTransientRetry: this.startTurnWithTransientRetry.bind(this),
      releaseReviewerSubscription: this.releaseReviewerSubscription.bind(this),
      flushCleanupNotes: this.flushCleanupNotes.bind(this),
      errorMessage,
    });
    this.submissionExecution = new SubmissionExecution({
      store: this.store,
      config: this.config,
      runtime: this.runtime,
      callback: this.callback,
      bridgeQueue: this.bridgeQueue,
      reviewerGateway: this.reviewerGateway,
      reviewObservation: this.reviewObservation,
      leaseTtlMs: this.leaseTtlMs,
      boundedCleanup: this.boundedCleanup.bind(this),
      enqueueStagedVerdict: this.enqueueStagedVerdict.bind(this),
      enqueueSubmissionNotice: this.enqueueSubmissionNotice.bind(this),
      stageSubmissionFailure: this.stageSubmissionFailure.bind(this),
      reportCleanupNote: this.reportCleanupNote.bind(this),
      flushCleanupNotes: this.flushCleanupNotes.bind(this),
      alignReview: this.alignReview.bind(this),
      reconcileReview: this.reconcileReview.bind(this),
      errorMessage,
    });
    this.lifecycleExecution = new LifecycleExecution({
      store: this.store,
      runtime: this.runtime,
      reviewObservation: this.reviewObservation,
      turnGateway: this.turnGateway,
      callback: this.callback,
      requireAgent,
      submissionTaskKey: this.submissionTaskKey.bind(this),
    });
  }

  /** Compatibility view retained for the existing single-flight recovery test. */
  private get activeRecovery(): boolean { return this.runtime.activeRecovery; }
  /** Compatibility view retained for active-turn lifecycle assertions. */
  private get activeTurns() { return this.runtime.activeTurns; }

  // ---------------------------------------------------------------- facade
  // Public compatibility surface. New consumers use the flow objects above;
  // these methods keep the existing DSH tools, bridge runtime and npm API
  // stable while the implementation moves behind the application boundaries.
  start(args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] }, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.plannerFlow.start(args, exec);
  }

  continue(workflowId: string, answers: Record<string, string[]>, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.plannerFlow.continue(workflowId, answers, exec);
  }

  startExternalPlan(command: DispatchPlanCommand, agent: Agent): Promise<WorkflowRecord> {
    return this.plannerFlow.startExternalPlan(command, agent);
  }

  onTurnStopping(agent: Agent, turn: number): Promise<void> {
    return this.plannerFlow.onTurnStopping(agent, turn);
  }

  decide(workflowId: string, input: { decision: "accept" | "fix"; note?: string }, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.plannerFlow.decide(workflowId, input, exec);
  }

  review(workflowId: string, input: ReviewInput, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.reviewFlow.review(workflowId, input, exec);
  }

  reviewOnly(args: { task?: string; implementationSummary: string; changedFiles?: string[]; testResults?: string; reviewerModel?: string; reviewerEffort?: WorkflowConfig["reviewerEffort"] }, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.reviewFlow.reviewOnly(args, exec);
  }

  applyExternalVerdict(command: SubmitVerdictCommand): Promise<WorkflowRecord> {
    return this.reviewFlow.applyExternalVerdict(command);
  }

  assertVerdictStillValid(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }> {
    return this.reviewFlow.assertVerdictStillValid(command);
  }

  submit(workflowId: string, input: ReviewInput, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.submissionFlow.submit(workflowId, input, exec);
  }

  recoverCallbacks(): Promise<number> {
    return this.submissionFlow.recoverCallbacks();
  }

  commitVerdictDelivery(command: SubmitVerdictCommand): Promise<{ committed: boolean; record: WorkflowRecord }> {
    return this.submissionFlow.commitVerdictDelivery(command);
  }

  commitSubmissionNoticeDelivery(command: SubmissionNoticeCommand): Promise<{ committed: boolean; record: WorkflowRecord }> {
    return this.submissionFlow.commitSubmissionNoticeDelivery(command);
  }

  status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord & { reviewerActive: boolean }> {
    return this.lifecycleFlow.status(workflowId, exec);
  }

  cancel(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.lifecycleFlow.cancel(workflowId, exec);
  }

  stop(): Promise<void> {
    return this.lifecycleFlow.stop();
  }

  /** 1.1.1: the shared retry policy for TRANSIENT upstream failures. A config
   * object built without the retry fields is normalized here so an absent
   * budget can never turn the bounded retry into an endless loop. */
  private retryPolicy(): BackoffPolicy {
    return normalizeBackoff({
      baseMs: this.config.transientRetryBaseMs,
      maxMs: this.config.transientRetryMaxMs,
      budgetMs: this.config.transientRetryBudgetMs,
      jitterRatio: this.config.transientRetryJitterRatio,
    });
  }

  /**
   * Run ONE visible model turn, retrying ONLY transient upstream failures
   * (server_overloaded / at capacity / 429 / 5xx / dropped streams / a writer
   * held by another process) with the shared bounded backoff.
   *
   * Why this exists: an upstream `server_overloaded` reply used to surface as a
   * failed turn and the tool failed with it — the workflow stopped and a human
   * had to run the same call again. Capacity is temporary.
   *
   * Safety of the retry: it happens only for a turn that ended NOT completed
   * AND produced no visible text, i.e. one that persisted no plan, audit or
   * rewrite; re-running it cannot duplicate user-visible output. Cancellation
   * and teardown propagate through `signal`, and terminal failures (invalid
   * thread, approval denial, schema/display contract violations) are returned
   * unchanged for the caller to classify.
   */
  private async startTurnWithTransientRetry(
    threadId: string,
    options: Parameters<CodexGateway["startTurn"]>[1],
    signal?: AbortSignal,
  ): Promise<TurnWaitResult> {
    return this.retryTransientTurn(
      () => this.turnGateway.startTurn(threadId, options, signal),
      transientTurnReason,
      signal,
    );
  }

  /**
   * 1.1.2: the VISIBLE `review/start` turn gets the SAME treatment as every
   * other visible turn.
   *
   * The 1.1.1 CLI audit retried its visible review turn inside the tool
   * (`runWithTransientRetry`); when the visible turn moved to the App Server in
   * 1.1.2 that protection had to move with it, otherwise a transient
   * `server_overloaded` would fail the whole review round and force the user to
   * run the tool again — exactly the incident 1.1.1 fixed.
   */
  private async startReviewWithTransientRetry(
    options: Parameters<CodexGateway["startReview"]>[0],
    signal?: AbortSignal,
  ): Promise<{ threadId: string; result: TurnWaitResult }> {
    return this.retryTransientTurn(
      () => this.turnGateway.startReview(options, signal),
      (outcome) => transientTurnReason(outcome.result),
      signal,
    );
  }

  /** The shared 1.1.1 retry loop for one visible turn. */
  private async retryTransientTurn<T>(
    run: () => Promise<T>,
    retryableReason: (outcome: T) => string | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    const policy = this.retryPolicy();
    const deadline = this.retryNow() + policy.budgetMs;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await run();
      const reason = retryableReason(outcome);
      if (!reason || !(policy.budgetMs > 0)) return outcome;
      const delayMs = backoffDelayMs(attempt, policy, this.retryRandom);
      if (this.retryNow() + delayMs > deadline) return outcome;
      await this.retrySleep(delayMs, signal);
    }
  }

  /**
   * 1.1.3: the SAME bounded backoff for a CONTROL RPC (create / configure /
   * resume / settings refresh). Control RPCs THROW instead of returning a failed
   * turn, so they use `retryTransient` with the shared classification, policy
   * and cancellation seam; a terminal diagnostic is rethrown unchanged, and a
   * spent budget surfaces as `TransientRetryExhaustedError` (the caller maps it
   * to a RETRYABLE outcome — never a terminal failure).
   *
   * Why this exists: 1.1.2 made the Reviewer task visible in Codex Desktop, so a
   * user simply READING the review makes Desktop hold that task's writer lock.
   * `thread/resume` then fails with `already has an active writer`, which is
   * transient by nature (the lock disappears when the user closes the task) —
   * the 1.1.1 CLI path retried exactly this for up to 20 minutes, and the App
   * Server path must not be weaker.
   */
  private async retryTransientControl<T>(
    operation: (attempt: number) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return retryTransient(
      operation,
      (error) => transientReason(errorMessage(error)),
      this.retryPolicy(),
      { sleep: this.retrySleep, now: this.retryNow, random: this.retryRandom },
      signal,
    );
  }

  /**
   * 1.1.3: create the visible Reviewer task under the same bounded transient
   * retry. `thread/start` runs ONCE — every retry re-configures the SAME task
   * id — so a flaky settings/name call can never leak one orphan task per
   * attempt; a terminally failed creation releases the unbound task (it stays
   * in the Codex store, but nothing holds it).
   */
  private async createReviewerThread(
    options: { cwd: string; name: string; model?: string; developerInstructions?: string; workflowId?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    let threadId: string | undefined;
    try {
      return await this.retryTransientControl(async () => {
        threadId ??= await this.reviewerGateway.startShell({ ...options, ephemeral: true }, signal)
          ?? await this.reviewerGateway.start({ ...options, ephemeral: true }, signal);
        const configured = this.reviewerGateway.configure(threadId, options, signal);
        if (configured) await configured;
        return threadId;
      }, signal);
    } catch (error) {
      if (threadId) this.reportCleanupNote(options.workflowId, await this.releaseUnboundReviewer(threadId, signal));
      throw error;
    }
  }

  /** Resumable Codex callback used by bridge workflows; injected by the host. */
  get callbackDispatcher(): CodexCallback | undefined {
    return this.callback;
  }

  /** Teardown: block new sends, abort in-flight recovery (and its backoff
   * delays), await EVERY recovery-derived background task (recoverStagedVerdict
   * enqueue/commit, runSubmissionCallback chains), and finally kill + await
   * every callback operation. No late task may still be enqueueing, updating
   * the store or starting a review when stop() returns. Concurrent stop() calls
   * share ONE settle promise, so a second caller can never resolve before the
   * first has truly finished tearing down.
   */
  private stopInternal(): Promise<void> {
    return this.lifecycleExecution.stop();
  }
  /** Track every foreground tool flow so teardown can interrupt and await it
   * before stopping the App Server and closing the stores. Registered at the
   * method boundary so even a tool call that dies mid-flight is awaited. */
  private trackForeground<T>(task: Promise<T>): Promise<T> {
    this.runtime.foreground.add(task);
    void task.finally(() => {
      this.runtime.foreground.delete(task);
    }).catch(() => undefined);
    return task;
  }

  /** Track every manager-owned background task so teardown can await them
   * before closing the stores; late store/enqueue writes are impossible after
   * stop() returns. */
  private trackBackground(task: Promise<unknown>): void {
    this.runtime.backgroundTasks.add(task);
    void task.finally(() => {
      this.runtime.backgroundTasks.delete(task);
    }).catch(() => undefined);
  }

  private submissionTaskKey(workflowId: string, submissionId: string): string {
    return `${workflowId}:${submissionId}`;
  }

  private startSubmissionTask(
    workflowId: string,
    submissionId: string,
    prompt: string,
    seed: WorkflowRecord,
    lease: ManagerLease,
  ): void {
    const key = this.submissionTaskKey(workflowId, submissionId);
    const controller = new AbortController();
    this.runtime.submissionControllers.set(key, controller);
    const task = this.runSubmissionCallback(workflowId, submissionId, prompt, seed, controller.signal, lease)
      .catch(() => undefined)
      .finally(async () => {
        lease.stopHeartbeat();
        await lease.release().catch(() => undefined);
        await this.store.update(workflowId, (r) => {
          if (r.submissionId !== submissionId) return;
          if (r.submissionLeaseToken !== lease.owner) return;
          r.submissionLeaseToken = undefined;
          r.submissionLeaseEpoch = undefined;
          r.submissionLeaseUntil = undefined;
        }, { ignoreCancelled: true }).catch(() => undefined);
        if (this.runtime.submissionControllers.get(key) === controller) {
          this.runtime.submissionControllers.delete(key);
        }
      });
    this.trackBackground(task);
  }

  /** Foreground tool flow: tracked so teardown interrupts and awaits it. */
  private startInternal(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    return this.plannerExecution.start(args, exec);
  }

  /**
   * Apply a verdict bound to the exact originating Codex task and submission.
   * State-machine invariants:
   *  - The FIRST apply of an external verdict only ever moves `received` →
   *    `applied`. `verdict_ready` (verdict staged, enqueue not yet committed)
   *    is NOT applicable yet — the runtime retries until the enqueue commits.
   *  - While a staged verdict exists, any command whose request id differs
   *    from the staged identity is rejected terminally, no matter its arrival
   *    order (a conflicting manual verdict can never jump ahead of the
   *    expected one).
   *  - Replays of the SAME request id in applied/delivered are idempotent
   *    returns; the same submission with a DIFFERENT request id is rejected.
   *  - The verdict is bound to the evidence fingerprint captured at submit
   *    time; apply re-collects the current fingerprint and refuses (without
   *    applying anything) when the workspace changed or became unverifiable.
   *  - Legacy manual path (no staged verdict) applies from waiting_verdict.
   * The outcome (including refusal) is persisted in one atomic CAS update.
   */
  private async applyExternalVerdictInternal(command: SubmitVerdictCommand): Promise<WorkflowRecord> {
    const record = await this.store.load(command.workflowId);
    if (!record) throw new Error(`unknown workflow ${command.workflowId}`);
    if (record.origin !== "codex_bridge") {
      throw new Error(`workflow ${command.workflowId} is not a Codex-bridge workflow`);
    }
    if (record.codexThreadId !== command.codexThreadId) {
      throw new Error(`verdict thread mismatch: expected ${record.codexThreadId}, got ${command.codexThreadId}`);
    }
    if (command.dshSessionId !== undefined && record.dshSessionId !== command.dshSessionId) {
      // A forged/stale target must never let a wrong runtime apply first: the
      // declared session must equal the record's real one.
      throw new Error(
        `verdict session mismatch: workflow ${command.workflowId} belongs to session ${record.dshSessionId}, command answers ${command.dshSessionId}`,
      );
    }
    if (record.phase === "cancelled") return record;
    // Async evidence work happens OUTSIDE the store transaction (the CAS only
    // carries synchronous validation + writes).
    const evidence = await collectEvidence({
      cwd: record.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: record.pendingReviewRequest?.changedFiles,
    });
    const outcome = await this.store.update(command.workflowId, (r) => {
      // Idempotent replay of the SAME request identity (already applied and/or
      // delivered): return the record without touching it.
      if (r.appliedVerdictRequestId === command.requestId) return r;
      // The same submission already applied by a DIFFERENT request id: refuse.
      if (command.submissionId !== undefined && r.appliedVerdictSubmissionId === command.submissionId) {
        throw new Error(
          `verdict for workflow ${command.workflowId} already applied as request ${r.appliedVerdictRequestId}, command answers ${command.requestId}`,
        );
      }
      if (command.submissionId !== undefined && r.submissionId !== command.submissionId) {
        throw new Error(
          `stale submission: workflow ${command.workflowId} is on submission ${r.submissionId ?? "(none)"}, verdict answers ${command.submissionId}`,
        );
      }
      if (command.submissionId === undefined && r.submissionId && submissionActive(r.submissionState)) {
        throw new Error(`verdict for workflow ${command.workflowId} is missing its submission id`);
      }
      if (r.stagedVerdict) {
        // The expected identity must be applied; anything else is refused.
        if (r.stagedVerdict.command.requestId !== command.requestId) {
          throw new Error(
            `verdict for workflow ${command.workflowId} already staged as request ${r.stagedVerdict.command.requestId}, command answers ${command.requestId}`,
          );
        }
        if (r.submissionState === "verdict_ready") {
          // Staged but the enqueue has not committed yet: retryable, never
          // terminal — the pump must wait for `received`.
          throw new Error(`verdict for workflow ${command.workflowId} is not yet applicable: submission is still staging`);
        }
        if (r.submissionState !== "received") {
          throw new Error(`verdict cannot be applied to workflow ${command.workflowId} in submission state ${r.submissionState}`);
        }
      } else if (r.submissionState !== undefined
        && r.submissionState !== "waiting_verdict"
        && r.submissionState !== "received") {
        throw new Error(`verdict cannot be applied to workflow ${command.workflowId} in submission state ${r.submissionState}`);
      }
      if (!r.pendingReviewRequest) {
        throw new Error(`verdict for workflow ${command.workflowId} arrived before any submission`);
      }
      const submitted = r.latestReviewEvidence;
      if (!submitted?.fingerprint || !evidence.fingerprint) {
        // Unverifiable workspace: refuse to apply ANY verdict (a pass must
        // never ride an empty fingerprint).
        r.error = "workspace cannot be verified (insufficient evidence); the verdict was not applied — re-submit with observable changed files inside the workspace";
        r.latestReview = undefined;
        r.pendingReviewRequest = undefined;
        r.submissionState = "applied";
        r.appliedVerdictRequestId = command.requestId;
        r.appliedVerdictSubmissionId = command.submissionId ?? r.submissionId;
        r.appliedVerdictEvidenceFingerprint = undefined;
        r.stagedVerdict = undefined;
        r.submissionNotice = undefined;
        r.callbackState = "idle";
        r.processState = "failed";
        r.activeTurnId = undefined;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Review failed: workspace evidence was insufficient";
        this.resetDesktopOpenState(r, command.submissionId ?? r.submissionId);
        return r;
      }
      if (submitted.fingerprint !== evidence.fingerprint) {
        // The reviewer saw a different workspace: the old verdict must never
        // apply — not even "pass".
        r.error = "workspace changed since the review (evidence fingerprint mismatch); the verdict was not applied — make the changes and call codex_workflow_submit again for a fresh review";
        r.latestReview = undefined;
        r.pendingReviewRequest = undefined;
        r.submissionState = "applied";
        r.appliedVerdictRequestId = command.requestId;
        r.appliedVerdictSubmissionId = command.submissionId ?? r.submissionId;
        r.appliedVerdictEvidenceFingerprint = undefined;
        r.stagedVerdict = undefined;
        r.callbackState = "idle";
        r.processState = "failed";
        r.activeTurnId = undefined;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Review failed: workspace changed during delivery";
        this.resetDesktopOpenState(r, command.submissionId ?? r.submissionId);
        return r;
      }
      const result = applyReviewConsistency(command.verdict);
      r.latestReviewEvidence = evidence;
      this.trackNoChange(r, evidence);
      r.reviewCycles += 1; // a structured verdict is now applied: count the cycle
      const computed = this.computeReviewOutcome(r, result);
      r.latestReview = result;
      r.pendingReviewRequest = undefined;
      r.submissionState = "applied";
      r.appliedVerdictRequestId = command.requestId;
      r.appliedVerdictSubmissionId = command.submissionId ?? r.submissionId;
      // The fingerprint the applied verdict is valid against, kept until
      // delivery so a workspace change after apply invalidates the verdict.
      r.appliedVerdictEvidenceFingerprint = evidence.fingerprint;
      r.stagedVerdict = undefined;
      r.callbackState = "idle";
      r.phase = computed.phase;
      r.error = computed.error;
      r.noChangeReviewRounds = computed.noChangeReviewRounds ?? r.noChangeReviewRounds;
      r.processState = "completed";
      r.activeTurnId = undefined;
      r.lastProgressAt = new Date().toISOString();
      r.lastProgressMessage = "Review completed";
      if (r.reviewStartedAt) {
        const started = Date.parse(r.reviewStartedAt);
        if (Number.isFinite(started)) r.reviewElapsedMs = Math.max(0, Date.now() - started);
      }
      this.resetDesktopOpenState(r, command.submissionId ?? r.submissionId);
      return r;
    }, { ignoreCancelled: false });
    return outcome.record;
  }

  /**
   * Delivery-time re-verification (the PREPARE step): recompute the workspace
   * fingerprint BEFORE the outcome is relayed. If the workspace changed after
   * the verdict was applied (e.g. while the DSH session was offline), the
   * applied verdict — including a "pass" — is INVALIDATED: the workflow
   * returns to a safe executing state and the relay reports the invalidation.
   *
   * State discipline: invalidation marks the verdict as pending-invalidation
   * but does NOT write `delivered` — `submissionState` stays `applied` so the
   * runtime's pre-relay check accepts it and relays the (VOID) notice; the
   * durable `delivered` is committed only after the relay succeeds.
   * A cancelled workflow always short-circuits without touching state.
   */
  private async assertVerdictStillValidInternal(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }> {
    const loaded = await this.store.load(command.workflowId);
    if (!loaded) return { invalidated: false, record: loaded as unknown as WorkflowRecord };
    if (loaded.phase === "cancelled") return { invalidated: false, record: loaded };
    if (loaded.error && /workspace changed after the review/.test(loaded.error)) {
      // Already pending-invalidation: keep relaying the VOID notice verbatim.
      return { invalidated: true, record: loaded };
    }
    if (loaded.error && /was not applied|cannot be verified/.test(loaded.error)) {
      // Refused at apply time: relay the refusal as-is.
      return { invalidated: false, record: loaded };
    }
    if (!loaded.appliedVerdictEvidenceFingerprint) return { invalidated: false, record: loaded };
    if (loaded.submissionId !== command.submissionId) return { invalidated: false, record: loaded };
    const evidence = await collectEvidence({
      cwd: loaded.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: loaded.latestReviewEvidence?.changedFiles,
    });
    if (evidence.fingerprint && evidence.fingerprint === loaded.appliedVerdictEvidenceFingerprint) {
      return { invalidated: false, record: loaded };
    }
    // Invalidate: phase -> executing (from passed / waiting_review_decision;
    // blocked is a max-cycle terminal and is NOT regressed), error set,
    // fingerprint cleared, but submissionState stays `applied`
    // (pending-invalidation). Regressing `passed` and `waiting_review_decision`
    // to executing keeps the VOID guidance consistent with what the tools
    // accept: the owning session can call codex_workflow_submit again (submit
    // only accepts executing/fixing) for a fresh review — otherwise the
    // workflow would be permanently stuck.
    const outcome = await this.store.update(loaded.id, (r) => {
      if (r.phase === "cancelled") return;
      if (r.submissionId !== command.submissionId) return;
      if (r.phase === "passed" || r.phase === "waiting_review_decision") r.phase = "executing";
      r.error = "workspace changed after the review (evidence fingerprint mismatch); the applied verdict is void — call codex_workflow_submit again for a fresh review";
      r.latestReview = undefined;
      r.appliedVerdictEvidenceFingerprint = undefined;
      r.stagedVerdict = undefined;
    }, { ignoreCancelled: false });
    if (outcome.suppressed || outcome.record.phase === "cancelled") {
      return { invalidated: false, record: outcome.record };
    }
    return { invalidated: true, record: outcome.record };
  }

  /**
   * Commit the delivered state AFTER the relay succeeded. Returns whether the
   * exact CAS committed (`committed: true`) — the update is fenced on the
   * exact submission/request identity and only fires while the verdict is
   * still `applied` (or pending-invalidation). A cancel or a new submission
   * that won between prepare and commit suppresses the write (`committed:
   * false`), so the old verdict can never mark delivered over the new owner;
   * the caller must then ack the queue as cancelled/suppressed, never
   * delivered. Async work (fingerprint re-check) happens in
   * {@link assertVerdictStillValid} before this, never inside the
   * transaction.
   */
  private async commitVerdictDeliveryInternal(
    command: SubmitVerdictCommand,
  ): Promise<{ committed: boolean; record: WorkflowRecord }> {
    let changed = false;
    const outcome = await this.store.update(command.workflowId, (r) => {
      if (command.submissionId !== undefined && r.submissionId !== command.submissionId) return;
      if (r.appliedVerdictRequestId !== command.requestId) return;
      if (r.submissionState !== "applied") return;
      r.submissionState = "delivered";
      r.callbackState = "idle";
      changed = true;
    }, { ignoreCancelled: false });
    return { committed: !outcome.suppressed && changed, record: outcome.record };
  }

  /** Mark the current applied verdict for one best-effort desktop deep-link.
   * The opener runs only after the callback has released its App Server writer. */
  private resetDesktopOpenState(record: WorkflowRecord, submissionId: string | undefined): void {
    // Legacy/manual verdicts have no submission id; the verdict request id is
    // still a stable per-round identity for desktop-open deduplication.
    record.desktopOpenSubmissionId = submissionId ?? record.appliedVerdictRequestId;
    record.desktopOpenAttempts = 0;
    record.desktopOpenNextAt = undefined;
    record.desktopOpenError = undefined;
    // Reviewer audits now run in the backend CLI. Never schedule a Desktop
    // deep-link or retry after an audit; the user's current Desktop window
    // must remain untouched. The field stays for backward-compatible status.
    record.desktopOpenState = "disabled";
  }

  private async commitSubmissionNoticeDeliveryInternal(
    command: SubmissionNoticeCommand,
  ): Promise<{ committed: boolean; record: WorkflowRecord }> {
    let changed = false;
    const outcome = await this.store.update(command.workflowId, (r) => {
      if (r.dshSessionId !== command.dshSessionId) return;
      if (r.codexThreadId !== command.codexThreadId) return;
      if (r.submissionId !== command.submissionId) return;
      if (r.submissionNotice?.command.requestId !== command.requestId) return;
      if (r.submissionNotice.state !== "delivered") r.submissionNotice.state = "delivered";
      changed = true;
    }, { ignoreCancelled: true });
    return { committed: !outcome.suppressed && changed, record: outcome.record };
  }

  /**
   * Create a workflow from an external (Codex-led) dispatch: the plan arrives
   * through the bridge instead of the local Planner, so no planner thread is
   * ever created. The workflow is bound to the exact DSH session that will
   * execute it and to the originating Codex thread id for the later callback.
   *
   * Creation is atomic across processes: a session-scoped fenced lease
   * (`workflow-create:<sessionId>`) serializes creators, and the
   * active-workflow and bridge-request existence checks run INSIDE the lease.
   * Two processes dispatching the same request (or same session) therefore
   * yield exactly one workflow — the second caller returns the same record
   * idempotently or is rejected as already active; never two active
   * workflows.
   */
  private async startExternalPlanInternal(command: DispatchPlanCommand, agent: Agent): Promise<WorkflowRecord> {
    // Bounded wait for the session-scoped create lease so concurrent
    // creators of the SAME request converge idempotently instead of failing:
    // the loser waits, then re-checks byBridgeRequest and returns the record
    // the winner created.
    const lease = await this.acquireWorkflowCreateLease(agent.id);
    if (!lease) {
      throw new Error(`session ${agent.id} is already creating a Codex workflow`);
    }
    try {
      const existing = await this.store.byBridgeRequest(command.requestId);
      if (existing) return existing; // idempotent dispatch replay
      if (await this.store.activeForSession(agent.id)) {
        throw new Error(`session ${agent.id} already has an active Codex workflow`);
      }
      const now = new Date().toISOString();
      const record: WorkflowRecord = {
        schemaVersion: 1,
        id: randomUUID(),
        dshSessionId: agent.id,
        cwd: command.target.cwd,
        task: command.task,
        mode: "planned",
        origin: "codex_bridge",
        phase: "executing",
        createdAt: now,
        updatedAt: now,
        assumptions: command.assumptions,
        questions: [],
        reviewCycles: 0,
        noChangeReviewRounds: 0,
        callbackAttempts: 0,
        callbackState: "idle",
        codexThreadId: command.codexThreadId,
        bridgeRequestId: command.requestId,
        bridgeDeliveryState: "prepared",
        planMarkdown: ensurePlanBlock(command.planMarkdown),
      };
      await this.store.save(record);
      return record;
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  private continueInternal(
    workflowId: string,
    answers: Record<string, string[]>,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    return this.plannerExecution.continue(workflowId, answers, exec);
  }

  /** Foreground tool flow: tracked so teardown interrupts and awaits it. */
  private async reviewInternal(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be reviewed from phase ${record.phase}`);
    }
    if (record.mode !== "review_only") {
      if (!record.planMarkdown) throw new Error(`workflow ${workflowId} has no completed plan`);
    }
    return this.trackForeground(this.reviewOnce(workflowId, input, exec)) as Promise<WorkflowRecord>;
  }

  /**
   * DSH-side submission for Codex-bridge workflows. Every submission gets a
   * durable `submissionId`; at most one unfinished submission exists per
   * workflow. A workflow-scoped fenced lease is taken BEFORE the submissionId
   * is generated, so two processes can never create different active
   * submissions for the same workflow; the per-submission callback lease is
   * held (with heartbeats) for the whole callback lifecycle. Non-git
   * submissions must carry observable, cwd-contained changedFiles — an
   * unverifiable workspace is rejected outright. All state updates are
   * atomic revision-CAS writes conditional on the submission id.
   */
  private async submitInternal(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.origin !== "codex_bridge") {
      throw new Error(`workflow ${workflowId} is not a Codex-bridge workflow; use codex_workflow_review instead`);
    }
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be submitted from phase ${record.phase}`);
    }
    if (!record.codexThreadId) throw new Error(`workflow ${workflowId} has no Codex thread to resume`);
    if (!this.callback) throw new Error("Codex callback dispatcher is not available");

    const evidence = await collectEvidence({
      cwd: record.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: input.changedFiles,
    });
    // An unverifiable workspace must never enter the review pipeline: an
    // empty fingerprint would let a later "pass" ride on nothing.
    if (evidence.insufficient || !evidence.fingerprint) {
      throw new Error(
        "submit requires observable changed files inside the workspace: provide non-empty, cwd-contained, readable changedFiles (non-git workspace) or run inside a git repository",
      );
    }

    // Workflow-scoped lease BEFORE generating the submissionId: two processes
    // can never both create an active submission for the same workflow.
    const submitLease = await this.acquireWorkflowSubmitLease(workflowId);
    if (!submitLease) throw new Error(`workflow ${workflowId} is being submitted by another process`);
    let submissionId: string | undefined;
    let lease: ManagerLease | undefined;
    let leaseTransferred = false;
    let submitReleased = false;
    try {
      submissionId = randomUUID();
      lease = await this.acquireSubmissionLease(workflowId, submissionId);
      if (!lease) throw new Error(`submission ${submissionId} is claimed by another process`);
      const prepared = await this.store.update(workflowId, (r) => {
        if (r.submissionId && submissionActive(r.submissionState)) {
          throw new Error(`workflow ${workflowId} already has an active submission ${r.submissionId}`);
        }
        r.pendingReviewRequest = input;
        r.latestReviewEvidence = evidence;
        // reviewCycles is NOT incremented here: a review cycle only counts a
        // STRUCTURED VERDICT successfully received/applied, never an attempt
        // (busy/timeout/invalid-thread/infra failures keep the submission
        // retryable without consuming a cycle).
        r.submissionId = submissionId;
        r.submissionState = "queued";
        r.submissionAttempts = 0;
        r.submissionError = undefined;
        r.submissionRetryAt = undefined;
        r.submissionNotice = undefined;
        r.submissionLeaseToken = lease!.owner;
        r.submissionLeaseEpoch = lease!.epoch;
        r.submissionLeaseUntil = Date.now() + this.leaseTtlMs;
        r.callbackState = "queued"; // legacy mirror
        r.callbackError = undefined;
      }, { ignoreCancelled: false });
      if (prepared.suppressed) return prepared.record;
      // The workflow-scoped fence has done its job (one active submission is
      // now durably persisted); release it before the long callback runs.
      await submitLease.release();
      submitReleased = true;
      await this.reviewObservation.begin(workflowId, {
        enterReviewing: false,
        step: "reviewing",
        message: "Review queued; waiting for Reviewer",
      });
      const prompt = callbackPrompt(prepared.record, input, evidence);
      this.startSubmissionTask(workflowId, submissionId, prompt, prepared.record, lease);
      leaseTransferred = true;
      return prepared.record;
    } finally {
      if (lease && submissionId && !leaseTransferred) {
        lease.stopHeartbeat();
        await lease.release().catch(() => undefined);
        const leaseOwner = lease.owner;
        const sid = submissionId;
        // Clear the record-level lease fence so a later recovery round can
        // re-claim the (finished) submission without tripping on stale fields.
        await this.store.update(workflowId, (r) => {
          if (r.submissionId !== sid) return;
          if (r.submissionLeaseToken !== leaseOwner) return;
          r.submissionLeaseToken = undefined;
          r.submissionLeaseEpoch = undefined;
          r.submissionLeaseUntil = undefined;
        }, { ignoreCancelled: true }).catch(() => undefined);
      }
      if (!submitReleased) await submitLease.release().catch(() => undefined);
    }
  }

  /** Workflow-scoped fence: serializes submission creation per workflow. */
  private async acquireWorkflowSubmitLease(workflowId: string): Promise<ManagerLease | undefined> {
    return this.acquireLease(`submit:${workflowId}`);
  }

  /** Session-scoped creation fence with a bounded wait: two processes
   * dispatching for the same session briefly contend; the loser retries until
   * the winner releases, then proceeds to the (idempotent) byBridgeRequest /
   * active-for-session checks. */
  private async acquireWorkflowCreateLease(sessionId: string): Promise<ManagerLease | undefined> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const lease = await this.acquireLease(`workflow-create:${sessionId}`);
      if (lease) return lease;
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  private async acquireSubmissionLease(workflowId: string, submissionId: string): Promise<ManagerLease | undefined> {
    return this.acquireLease(`submission:${workflowId}:${submissionId}`);
  }

  private async acquireLease(resource: string): Promise<ManagerLease | undefined> {
    // Ensure the store's directory exists before opening the coordination
    // database (a fresh storage directory has no coord.sqlite yet).
    await this.store.init();
    const owner = `${process.pid}-${randomUUID()}`;
    const grant = this.store.coordinationHandle.acquireLease(resource, this.leaseTtlMs, owner);
    if (!grant) return undefined;
    return makeManagerLease(this.store.coordinationHandle, resource, grant.epoch, grant.owner, this.leaseTtlMs);
  }

  /**
   * One callback run for a submission: resume the workflow's review task, apply
   * the structured verdict or classify the failure, with bounded retry on
   * busy conditions. Verdict handling is a durable two-phase pipeline so a
   * crash can never lose the only valid verdict:
   *
   *   phase A: persist `verdict_ready` + `stagedVerdict` containing the FULL
   *            verdict command (requestId AND createdAt minted once, here) —
   *            atomic store write;
   *   phase B: idempotently enqueue that exact command (same requestId,
   *            createdAt, commandHash);
   *   phase C: commit `received` (the staged identity is KEPT until applied).
   *
   * A crash between A and B leaves `verdict_ready`; startup recovery
   * re-enqueues the exact staged command. Transient enqueue failures keep the
   * staged identity and retry — they never mark the submission failed; only
   * unrecoverable identity/schema errors do. Every write is a revision-CAS
   * conditional on the submission id and never moves a finished submission
   * backwards.
   */
  private runSubmissionCallback(
    workflowId: string,
    submissionId: string,
    prompt: string,
    seed: WorkflowRecord,
    signal?: AbortSignal,
    lease?: ManagerLease,
  ): Promise<WorkflowRecord> {
    return this.submissionExecution.run(workflowId, submissionId, prompt, seed, signal, lease);
  }

  /** Append UI-only workflow state to the owning DSH session. The event log is
   * the browser's durable source for the Codex right sidebar; failures here
   * never change the workflow verdict or tool result. */
  private emitSessionEvent(record: WorkflowRecord, event: CodexWorkflowSessionEvent): void {
    const agent = this.agents?.get(record.dshSessionId);
    if (!agent) return;
    try {
      agent.session.append(event.type, event.data as never);
    } catch {
      // A session can be disposing while a background callback settles. The
      // coordination record remains authoritative and will be shown on reload.
    }
  }
  private async stageSubmissionFailure(
    updateCurrent: (fn: (record: WorkflowRecord) => void) => Promise<WorkflowRecord>,
    workflowId: string,
    submissionId: string,
    message: string,
  ): Promise<WorkflowRecord> {
    return updateCurrent((r) => {
      r.submissionState = "failed";
      r.submissionError = message;
      r.submissionRetryAt = undefined;
      r.callbackState = "failed";
      if (!r.submissionNotice || r.submissionNotice.command.submissionId !== submissionId) {
        const command: SubmissionNoticeCommand = {
          version: 1,
          kind: "submission_notice",
          requestId: newRequestId(),
          createdAt: new Date().toISOString(),
          workflowId,
          submissionId,
          codexThreadId: r.codexThreadId!,
          dshSessionId: r.dshSessionId,
          level: "error",
          message: `Codex Reviewer 后台审查失败：${message}`,
        };
        r.submissionNotice = { command, state: "prepared" };
      }
    });
  }

  private async enqueueSubmissionNotice(
    workflowId: string,
    submissionId: string,
    record: WorkflowRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const notice = record.submissionNotice;
    if (!notice || notice.state === "delivered" || !this.bridgeQueue || this.runtime.stopped || signal?.aborted) return;
    try {
      await this.bridgeQueue.enqueue(notice.command);
      await this.store.update(workflowId, (r) => {
        if (r.submissionId !== submissionId) return;
        if (r.submissionNotice?.command.requestId !== notice.command.requestId) return;
        if (r.submissionNotice.state !== "delivered") r.submissionNotice.state = "enqueued";
      }, { ignoreCancelled: true });
    } catch {
      // The exact command remains prepared and is replayed by recovery.
    }
  }

  /**
   * Enqueue the staged verdict command with bounded in-place retry (no
   * callback respawn). TRANSIENT failures (queue busy, I/O) never mark the
   * submission failed: the staged identity stays and later recovery rounds
   * (or a plugin restart) keep re-enqueueing the exact same command. Only
   * clearly unrecoverable identity/schema errors terminate the submission.
   * Returns `"committed"` or the workflow record in its current state.
   */
  private async enqueueStagedVerdict(
    workflowId: string,
    submissionId: string,
    staged: WorkflowRecord,
    signal?: AbortSignal,
  ): Promise<WorkflowRecord | "committed"> {
    const stagedVerdict = staged.stagedVerdict;
    if (!stagedVerdict) return staged;
    for (let attempt = 1; ; attempt += 1) {
      if (this.runtime.stopped || signal?.aborted) return staged;
      try {
        await this.bridgeQueue!.enqueue(stagedVerdict.command);
        return "committed";
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isUnrecoverableEnqueueError(error)) {
          const failed = await this.store.update(workflowId, (r) => {
            if (r.submissionId !== submissionId) return;
            r.submissionState = "failed";
            r.submissionError = `verdict enqueue rejected: ${errorMessage(error)}`;
            r.callbackState = "failed";
            // The staged identity is kept for audit; recovery never re-enqueues
            // a failed submission.
          }, { ignoreCancelled: false });
          return failed.record;
        }
        if (attempt >= this.config.callbackMaxAttempts) {
          // Transient exhaustion: stay verdict_ready with the staged identity
          // intact; recovery re-enqueues on the next round or restart.
          await this.store.update(workflowId, (r) => {
            if (r.submissionId !== submissionId || r.submissionState !== "verdict_ready") return;
            r.submissionError = `verdict enqueue transient failure after ${attempt} attempts: ${errorMessage(error)}; recovery will retry`;
          }, { ignoreCancelled: false });
          return staged;
        }
        await delay(this.config.callbackRetryBaseMs * 2 ** (attempt - 1), signal);
      }
    }
  }

  /**
   * Plugin-start recovery: resume callbacks that were durably persisted but
   * never finished, using the persisted source/Reviewer task and submission ids.
   * Only queued/sending/retrying submissions are re-spawned (received means
   * the callback already finished and the verdict is queued); a `verdict_ready`
   * submission is NOT re-spawned — its staged verdict is re-enqueued with the
   * SAME request id (durable two-phase recovery). Cross-process exclusivity
   * comes from the submission lease; the per-process recovery set and the
   * atomic state claim deduplicate within one process. Attempts are only
   * incremented by an actual callback send, never by a recovery claim.
   *
   * Recovery is SINGLE-FLIGHT: there is exactly one active scheduling chain.
   * A concurrent second call while the first is still running returns 0
   * without touching the references, so a caller can never overwrite the
   * active run that stop() is about to abort/await (which would otherwise let
   * stop() return before the abandoned run finished writing).
   */
  private recoverCallbacksInternal(): Promise<number> {
    if (!this.callback) return Promise.resolve(0);
    if (this.runtime.stopped) return Promise.resolve(0); // teardown gate: nothing to recover, never touch a closing store
    if (this.runtime.activeRecovery) return Promise.resolve(0);
    this.runtime.activeRecovery = true;
    const chain = this.runRecovery(this.runtime.lifecycleController.signal);
    // Keep the chain for teardown without letting a failure escape start().
    this.runtime.recoveryChain = Promise.resolve(chain).then(() => undefined, () => undefined);
    return chain.finally(() => {
      this.runtime.activeRecovery = false;
    });
  }

  private async runRecovery(signal: AbortSignal): Promise<number> {
    let recovered = 0;
    for (const loaded of await this.store.list()) {
      if (signal.aborted || this.runtime.stopped) break;
      let record = loaded;
      if (record.origin !== "codex_bridge") continue;
      const submissionId = record.submissionId;
      if (!submissionId) continue;

      const notice = record.submissionNotice;
      if (notice && notice.state !== "delivered") {
        const noticeId = notice.command.requestId;
        if (!this.runtime.recoveringNotices.has(noticeId)) {
          this.runtime.recoveringNotices.add(noticeId);
          recovered += 1;
          this.trackBackground(
            this.enqueueSubmissionNotice(record.id, submissionId, record, signal)
              .finally(() => this.runtime.recoveringNotices.delete(noticeId)),
          );
        }
        if (record.submissionState === "failed") continue;
      }

      // 1.0.0 migration: early builds treated ordinary task contention as a
      // terminal submission, either after exhausting a bounded retry round or
      // when Codex reported the newer thread-store "active writer" wording.
      // Restore only these known contention shapes; invalid-thread/schema/
      // no-verdict and other process failures remain terminal.
      if (record.submissionState === "failed" && isRecoverableContentionFailure(record)) {
        const restored = await this.store.update(record.id, (r) => {
          if (
            r.submissionId !== submissionId
            || r.submissionState !== "failed"
            || !isRecoverableContentionFailure(r)
          ) return;
          r.submissionState = "retrying";
          r.submissionError = "codex thread contention detected; persistent recovery will retry";
          r.submissionRetryAt = 0;
          r.callbackState = "retrying";
        }, { ignoreCancelled: false });
        record = restored.record;
      }

      // Verdict obtained but never enqueued: durable two-phase recovery.
      if (record.submissionState === "verdict_ready" && record.stagedVerdict) {
        if (this.runtime.recovering.has(submissionId)) continue;
        this.runtime.recovering.add(submissionId);
        this.trackBackground(
          this.recoverStagedVerdict(record.id, submissionId, record, signal)
            .finally(() => this.runtime.recovering.delete(submissionId)),
        );
        continue;
      }

      if (!RECOVERABLE_STATES.has(record.submissionState as SubmissionState)) continue;
      if ((record.submissionRetryAt ?? 0) > Date.now()) continue;
      if (this.runtime.recovering.has(submissionId)) continue;
      // Cross-process claim gate: a live lease (another DSH process) means the
      // submission is being handled right now; only expired leases are taken.
      const lease = await this.acquireSubmissionLease(record.id, submissionId);
      if (!lease) continue;
      this.runtime.recovering.add(submissionId);
      const claimed = await this.store.update(record.id, (r) => {
        if (r.submissionId !== submissionId) return false;
        if (!RECOVERABLE_STATES.has(r.submissionState as SubmissionState)) return false;
        // The DB submission lease is the authoritative gate (only the true
        // owner holds it after an atomic acquire); stamp the record with the
        // fence so the running callback's writes stay bound to this owner.
        r.submissionState = "sending";
        r.submissionRetryAt = undefined;
        r.submissionLeaseToken = lease!.owner;
        r.submissionLeaseEpoch = lease!.epoch;
        r.submissionLeaseUntil = Date.now() + this.leaseTtlMs;
        r.callbackState = "sending";
        return true;
      }, { ignoreCancelled: false });
      if (claimed.suppressed || !claimed.result) {
        this.runtime.recovering.delete(submissionId);
        await lease.release().catch(() => undefined);
        continue; // another restarter won the atomic claim
      }
      recovered += 1;
      const seed = claimed.record;
      const input = seed.pendingReviewRequest;
      if (!input) {
        this.runtime.recovering.delete(submissionId);
        await lease.release().catch(() => undefined);
        await this.store.update(seed.id, (r) => {
          if (r.submissionId !== submissionId) return;
          r.submissionState = "failed";
          r.submissionError = "missing pending review request during recovery";
          r.callbackState = "failed";
        }, { ignoreCancelled: false });
        continue;
      }
      const prompt = callbackPrompt(seed, input, seed.latestReviewEvidence ?? await collectEvidence({
        cwd: seed.cwd,
        maxDiffBytes: this.config.reviewDiffMaxBytes,
        changedFiles: input.changedFiles,
      }));
      this.trackBackground(
        this.runSubmissionCallback(seed.id, submissionId, prompt, seed, signal, lease)
          .finally(() => {
            this.runtime.recovering.delete(submissionId);
            return (async () => {
              await lease.release().catch(() => undefined);
              // Clear the record-level lease fence after the callback finishes.
              await this.store.update(seed.id, (r) => {
                if (r.submissionId !== submissionId) return;
                if (r.submissionLeaseToken !== lease.owner) return;
                r.submissionLeaseToken = undefined;
                r.submissionLeaseEpoch = undefined;
                r.submissionLeaseUntil = undefined;
              }, { ignoreCancelled: true }).catch(() => undefined);
            })();
          }),
      );
    }
    return recovered;
  }

  /** Re-enqueue the staged verdict with its persisted FULL command (same
   * requestId, createdAt, commandHash — idempotent against the queue) and
   * commit `received`; never spawns a callback. Transient failures leave
   * verdict_ready for the next recovery round; the staged identity never
   * changes. */
  private async recoverStagedVerdict(
    workflowId: string,
    submissionId: string,
    seed: WorkflowRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const staged = seed.stagedVerdict!;
      const interim = await this.enqueueStagedVerdict(workflowId, submissionId, seed, signal);
      if (interim !== "committed") return;
      await this.store.update(workflowId, (r) => {
        if (r.submissionId !== submissionId || r.submissionState !== "verdict_ready") return;
        if (r.stagedVerdict?.command.requestId !== staged.command.requestId) return;
        r.submissionState = "received";
        r.callbackState = "idle";
      }, { ignoreCancelled: false });
    } catch {
      // Abort (teardown) or a store error: leave verdict_ready for the next
      // recovery round; the staged identity stays unchanged.
    }
  }

  /**
   * Review-only entry: unlike `start`, it never runs the Codex planner. A fresh
   * read-only source thread hosts the first detached reviewer; later rounds
   * reuse the persisted Reviewer task via the ordinary `review` tool. All
   * evidence, decision-gate, no-change and cycle-limit logic is shared.
   */
  /** Foreground tool flow: tracked so teardown interrupts and awaits it. */
  private async reviewOnlyInternal(
    args: {
      task?: string;
      implementationSummary: string;
      changedFiles?: string[];
      testResults?: string;
      reviewerModel?: string;
      reviewerEffort?: WorkflowConfig["reviewerEffort"];
    },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    await this.assertNoActiveWorkflow(agent.id);
    const cwd = agent.session.header.cwd ?? process.cwd();
    if (!(await isGitRepository(cwd)) && !(Array.isArray(args.changedFiles) && args.changedFiles.length > 0)) {
      throw new Error(
        "review-only in a non-git workspace requires changedFiles so the changes can be observed by the reviewer",
      );
    }
    const now = new Date().toISOString();
    // Persist the EFFECTIVE reviewer model/effort so the durable Reviewer
    // thread, the ephemeral normalization fork and every later repair round
    // all share the SAME model — the caller's override, the bundle config, or
    // the resolved server default when nothing is configured (never a silent
    // re-pick).
    const reviewerModel = args.reviewerModel
      || this.config.reviewerModel
      || await this.turnGateway.resolveDefaultModel?.(exec.signal)
      || undefined;
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      dshSessionId: agent.id,
      cwd,
      task: (args.task ?? "").trim(),
      mode: "review_only",
      phase: "reviewing",
      createdAt: now,
      updatedAt: now,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
      reviewerModel,
      reviewerEffort: args.reviewerEffort ?? this.config.reviewerEffort,
    };
    await this.store.save(record);
    return this.trackForeground(this.reviewOnce(record.id, {
      implementationSummary: args.implementationSummary,
      ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
      ...(args.testResults ? { testResults: args.testResults } : {}),
    }, exec)) as Promise<WorkflowRecord>;
  }

  private async decideInternal(
    workflowId: string,
    input: { decision: "accept" | "fix"; note?: string },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "waiting_review_decision") {
      throw new Error(`workflow ${workflowId} is not waiting for a review decision (phase ${record.phase})`);
    }
    const review = record.latestReview;
    if (!review) throw new Error(`workflow ${workflowId} has no review to decide on`);
    const nextAction = record.origin === "codex_bridge"
      ? "call codex_workflow_submit with workflowId " + workflowId + " again after fixing the improvements"
      : "call codex_workflow_review with workflowId " + workflowId + " again after fixing the improvements";
    const message = input.decision === "accept"
      ? `Codex review for workflow ${workflowId} was accepted by the user: the non-blocking improvements below are recorded as deliberately not fixed.\n${formatFindings(review)}`
      : `Codex review for workflow ${workflowId} has non-blocking findings to fix. Apply each improvement below, rerun relevant tests, then ${nextAction} before answering the user.\n${formatFindings(review)}`;
    const commit = await this.store.update(workflowId, (r) => {
      r.reviewDecision = {
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
        decidedAt: new Date().toISOString(),
      };
      r.noChangeReviewRounds = 0;
      r.phase = input.decision === "accept" ? "passed" : "fixing";
      r.error = undefined;
    }, { ignoreCancelled: false });
    if (commit.suppressed) return commit.record;
    exec.deferContext(pluginMessage(message));
    return commit.record;
  }

  private statusInternal(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord & { reviewerActive: boolean }> {
    return this.lifecycleExecution.status(workflowId, exec);
  }
  private cancelInternal(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.lifecycleExecution.cancel(workflowId, exec);
  }
  private async onTurnStoppingInternal(agent: Agent, turn: number): Promise<void> {
    const record = await this.store.activeForSession(agent.id);
    // waiting_review_decision must not be steered: the user (not the agent)
    // decides whether non-blocking findings get fixed.
    if (!record || (record.phase !== "executing" && record.phase !== "fixing")) return;
    if (submissionActive(record.submissionState)) return;
    // 1.0.10: after an UNRESOLVED review-contract conflict the workflow is not
    // waiting for code fixes — the authority alignment refused the review, so
    // never nudge DSH to "finish the fixes".
    if (record.error && /review(er)? contract (conflict|failure)/i.test(record.error)) return;
    const key = `${record.id}:${turn}`;
    if (this.runtime.nudgedTurns.has(key)) return;
    this.runtime.nudgedTurns.add(key);
    const action = record.origin === "codex_bridge"
      ? "call codex_workflow_submit with workflowId " + record.id + ", a concise implementation summary, changed files, and test results so the originating Codex task can review the result"
      : "call codex_workflow_review with workflowId " + record.id + ", a concise implementation summary, changed files, and test results before ending this turn";
    agent.steer(pluginMessage(
      record.phase === "executing"
        ? `Workflow ${record.id} is not complete: finish implementing the approved plan, run tests, then ${action}.`
        : `Workflow ${record.id} still has review findings: finish the fixes, rerun tests, then ${action}.`,
    ));
  }

  /**
   * Shared review pipeline used by both `review` and `reviewOnly`: capture
   * evidence, ensure the durable workflow task is available with the readable
   * contract + full context as AUXILIARY developer instructions, run the
   * visible review via the `review/start` CUSTOM target — Git and non-Git
   * alike — whose instructions carry the full per-round context (original
   * task, approved plan, implementation summary, changed files, test
   * results, workspace evidence), the review scope and the item-by-item
   * coverage gate, convert the readable review through an ephemeral fork,
   * and apply the blocking gate, no-change termination and cycle limits.
   * Every store write goes through the atomic update primitive; any write
   * that races a cancellation is suppressed and the cancelled record is
   * returned.
   */
  private reviewOnce(workflowId: string, input: ReviewInput, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.reviewExecution.run(workflowId, input, exec);
  }
  /** 1.1.2: release the App Server hold on a Reviewer task that could NOT be
   * bound to its workflow — the binding write was suppressed by a concurrent
   * cancel, or it failed. The task itself stays in the Codex store (a thread
   * cannot be deleted); only the plugin's own subscription/writer hold is
   * released, so a cancelled round cannot leave a task loaded under it. Always
   * best-effort: the caller's original outcome must never be masked. */
  private async releaseUnboundReviewer(threadId: string, signal?: AbortSignal): Promise<string | undefined> {
    // Cleanup is independent of the turn that failed or was cancelled: an
    // aborted business signal must never cancel the unsubscribe that releases
    // the writer hold.
    void signal;
    return this.releaseReviewerHold(threadId);
  }

  /** 1.1.4: surface a best-effort cleanup note on the round's progress channel.
   * A cleanup failure must never change an outcome, but it must also not vanish:
   * an operator has to be able to see that a hold may still be open. Notes are
   * BUFFERED here and flushed after the round's terminal observation write —
   * that write replaces `lastProgressMessage`, so a note written earlier would be
   * silently discarded. */
  private reportCleanupNote(workflowId: string | undefined, note: string | undefined): void {
    if (!workflowId || !note) return;
    const notes = this.runtime.cleanupNotes.get(workflowId) ?? [];
    notes.push(note);
    this.runtime.cleanupNotes.set(workflowId, notes);
  }

  /** Append every buffered cleanup note to the round's terminal progress message. */
  private async flushCleanupNotes(workflowId: string): Promise<void> {
    const notes = this.runtime.cleanupNotes.get(workflowId);
    if (!notes || notes.length === 0) return;
    this.runtime.cleanupNotes.delete(workflowId);
    await this.store.update(workflowId, (record) => {
      record.lastProgressMessage = [record.lastProgressMessage, ...notes].filter(Boolean).join(" — ");
      record.lastProgressAt = new Date().toISOString();
    }, { ignoreCancelled: true }).catch(() => undefined);
  }

  /** 1.1.4: release the subscription acquired by THIS DSH-led review round, so
   * the next round can never collide with the previous round's own hold.
   * @returns a compact note when the release could not be sent, so the caller can
   * surface it on the round's terminal message instead of swallowing it. */
  private async releaseReviewerSubscription(threadId: string): Promise<string | undefined> {
    return this.releaseReviewerHold(threadId);
  }

  /**
   * Release ONLY this plugin's own subscription on a Reviewer thread.
   *
   * `releaseThreadForExternal` is deliberately NEVER used here. That handoff ends
   * with an `idleShutdown()` which detaches the child, clears its turn
   * bookkeeping and closes its stdin, and it exists for exactly one purpose:
   * letting an external CLI process (`codex exec`) resume the thread. Calling it
   * at the end of a review round could therefore tear the SHARED App Server out
   * from under a concurrent operation (a bridge callback turn, a planner turn),
   * so a gateway without `unsubscribeThread` releases nothing instead.
   *
   * Best-effort and idempotent (`unsubscribed`, `notSubscribed` and `notLoaded`
   * are all success outcomes): a failed release never changes the workflow's
   * outcome and the next round releases again. The Reviewer task itself is never
   * deleted or archived — the review stays on it.
   *
   * @returns a compact diagnostic when the release could not be sent, else
   * `undefined`. The caller reports it on the round's terminal progress message,
   * so a hold that may still be open is never silent.
   */
  /**
   * Run a signal-free cleanup under its OWN deadline.
   *
   * Cleanup must not ride on the business signal — a cancelled round still has to
   * release its claim, and a cancelled submission still has to hand the thread
   * back before an external CLI resumes it — so the bound has to come from
   * somewhere else. Without one, a `thread/unsubscribe` (or an external handoff
   * that includes an idle shutdown) that never settles would wedge the caller:
   * the round's `finally`, and with it cancel/teardown.
   *
   * @param what - short label used in the returned note.
   * @param run - the cleanup; returning `undefined` means the gateway has no such
   * API, which is not a failure.
   * @returns a compact note when the cleanup failed or did not finish in time,
   * else `undefined`.
   */
  private async boundedCleanup(what: string, run: () => Promise<unknown> | undefined): Promise<string | undefined> {
    const timeoutMs = Math.max(250, this.config.reviewerReleaseTimeoutMs ?? 10_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = run();
      if (!operation) return undefined;
      // `unref` keeps a pending deadline from holding the process open.
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([operation.then(() => "done" as const), deadline]);
      return outcome === "timeout" ? `${what} timed out after ${timeoutMs}ms (best-effort)` : undefined;
    } catch (error) {
      return `${what} failed (best-effort): ${compactDiagnostic(error instanceof Error ? error.message : String(error), 200)}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async releaseReviewerHold(threadId: string): Promise<string | undefined> {
    return this.boundedCleanup("reviewer release", () => this.reviewerGateway.unsubscribe(threadId));
  }

  /** 1.0.10 Review Authority alignment: an INVISIBLE ephemeral fork of the
   * durable workflow task checks the normalized ReviewResult against the
   * authority hierarchy (same model, low effort). The prompt carries the
   * levels of that hierarchy the alignment must judge against: the original
   * task, the approved plan, the PREVIOUSLY APPLIED review (carried-forward
   * findings stay aligned unless a higher level contradicts them) and THIS
   * round's fix summary (`input`; the bridge path passes the persisted
   * `pendingReviewRequest`). The fork output is the INTERNAL alignment JSON
   * (never the public ReviewResult, never persisted, never the bridge
   * protocol). A fork/turn/parse failure throws, so the caller's retryable
   * phase handling applies: no cycle, no latestReview, no fix prompt. Used by
   * BOTH the DSH-led review round and the bridge submission callback — first
   * review and re-review alike. */
  private async alignReview(
    record: WorkflowRecord,
    result: ReviewResult,
    signal?: AbortSignal,
    input?: ReviewInput,
  ): Promise<AlignmentOutcome> {
    if (this.audit) {
      return this.audit.align({
        result,
        task: record.task,
        planMarkdown: record.planMarkdown,
        previousReview: record.latestReview,
        fixSummary: input?.implementationSummary,
        cwd: record.cwd,
        workflowId: record.id,
        submissionId: record.submissionId,
        model: record.reviewerModel || this.config.reviewerModel,
        prompt: reviewAlignPrompt(result, {
          workflowId: record.id,
          task: record.task,
          planMarkdown: record.planMarkdown,
          previousReview: record.latestReview,
          fixSummary: input?.implementationSummary,
        }),
      }, signal);
    }
    const model = record.reviewerModel
      || this.config.reviewerModel
      || await this.turnGateway.resolveDefaultModel?.(signal)
      || undefined;
    let normalized: TurnWaitResult;
    try {
      const threadId = await this.threadGateway.startThread({ cwd: record.cwd, model, name: `DSH Review Alignment: ${record.id}`, ephemeral: true }, signal);
      normalized = await this.turnGateway.normalizeInFork({
        threadId,
        prompt: reviewAlignPrompt(result, {
          workflowId: record.id,
          task: record.task,
          planMarkdown: record.planMarkdown,
          previousReview: record.latestReview,
          fixSummary: input?.implementationSummary,
        }),
        ...(model ? { model } : {}),
        cwd: record.cwd,
        outputSchema: ALIGN_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        // The alignment fork is ephemeral: its thread/turn pair is the exact
        // active cancel target WHILE it runs, but the fork id is never
        // persisted (reviewerThreadId keeps pointing at the durable task).
        onStarted: (started) => this.registerEphemeralTurn(record.id, started.threadId, started.turnId, "reviewer"),
      }, signal);
    } finally {
      // Every ending path — completion, cancel, timeout — drops the mapping so
      // a completed fork turn can never be interrupted by a later cancel.
      this.runtime.activeTurns.delete(record.id);
    }
    const after = await this.store.load(record.id);
    if (!after || after.phase === "cancelled") throw new Error("workflow cancelled during review authority alignment");
    if (normalized.kind !== "completed") throw new Error("review authority alignment unexpectedly requested user input");
    if (normalized.status !== "completed") {
      throw new Error(normalized.reason ?? `review authority alignment turn ${normalized.status}`);
    }
    return parseAlignment(normalized.text, result);
  }

  /** 1.0.10 ONE visible reconciliation turn on the SAME durable workflow task
   * when the alignment found conflicts: the Reviewer rewrites the COMPLETE
   * verdict per the authority hierarchy (readable Markdown, the same display
   * contract as any visible review, low effort, silent). The corrected
   * visible review is APPENDED to the task, read back from the PERSISTED
   * history like any visible turn, re-normalized in an ephemeral fork and
   * re-aligned. Returns the corrected ReviewResult when the re-alignment
   * ended aligned; `{ aligned: false }` when it did not. A turn/read-back/
   * normalization failure throws, so the caller's retryable phase handling
   * applies (no cycle, no latestReview). Shared by the DSH-led round and the
   * bridge submission callback. */
  private async reconcileReview(
    record: WorkflowRecord,
    result: ReviewResult,
    conflicts: ReviewConflict[],
    signal?: AbortSignal,
    input?: ReviewInput,
  ): Promise<{ aligned: true; result: ReviewResult } | { aligned: false }> {
    if (this.audit) {
      // Reconciliation is an independent ephemeral CLI turn. It never resumes
      // a Desktop task or the external bridge origin task.
      const corrected = await this.audit.reconcile({
        workflowId: record.id,
        submissionId: record.submissionId ?? `reconcile-${Date.now()}`,
        codexThreadId: "ephemeral",
        ephemeral: true,
        cwd: record.cwd,
        prompt: reviewReconcilePrompt(result, conflicts, {
          workflowId: record.id,
          task: record.task,
          planMarkdown: record.planMarkdown,
        }),
        task: record.task,
        planMarkdown: record.planMarkdown,
        ...(record.reviewerModel || this.config.reviewerModel ? { model: record.reviewerModel || this.config.reviewerModel } : {}),
        effort: record.reviewerEffort ?? this.config.reviewerEffort,
      }, signal);
      const preservationError = reconciliationPreservationViolation(result, conflicts, corrected.verdict);
      if (preservationError) throw new Error(`reconciled review violated entry preservation: ${preservationError}`);
      const recheck = await this.alignReview(record, corrected.verdict, signal, input);
      return recheck.aligned ? { aligned: true, result: corrected.verdict } : { aligned: false };
    }
    const model = record.reviewerModel || this.config.reviewerModel;
    const threadId = await this.threadGateway.startThread({ cwd: record.cwd, model, name: `DSH Review Reconciliation: ${record.id}`, ephemeral: true }, signal);
    let reconcile: TurnWaitResult;
    try {
      reconcile = await this.startTurnWithTransientRetry(threadId, {
        prompt: reviewReconcilePrompt(result, conflicts, {
          workflowId: record.id,
          task: record.task,
          planMarkdown: record.planMarkdown,
        }),
        ...(model ? { model } : {}),
        effort: "low",
        conversion: false,
        // The reconciliation is a VISIBLE turn on the same durable thread:
        // silent, non-collaborative, one final message — and the exact active
        // cancel/teardown target while it runs.
        silentReview: true,
        onStarted: (started) => this.registerActiveTurn(record.id, started.threadId, started.turnId, "reviewer", true),
      }, signal);
    } finally {
      this.runtime.activeTurns.delete(record.id);
    }
    const after = await this.store.load(record.id);
    if (!after || after.phase === "cancelled") throw new Error("workflow cancelled during review reconciliation");
    if (reconcile.kind !== "completed") throw new Error("review reconciliation unexpectedly requested user input");
    if (reconcile.status !== "completed") {
      throw new Error(reconcile.status === "interrupted"
        ? "review reconciliation turn interrupted"
        : (reconcile.reason ?? `review reconciliation turn ${reconcile.status}`));
    }
    const visibleText = reconcile.text ?? "";
    const displayError = reviewDisplayError(visibleText, after);
    if (displayError) throw new Error(`reconciled review violates the display contract: ${displayError}`);
    let corrected: TurnWaitResult;
    try {
      corrected = await this.turnGateway.normalizeInFork({
        prompt: reviewConversionPrompt(visibleText, after.id),
        threadId,
        cwd: after.cwd,
        ...(model ? { model } : {}),
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        onStarted: (started) => this.registerEphemeralTurn(after.id, started.threadId, started.turnId, "reviewer"),
      }, signal);
    } finally {
      this.runtime.activeTurns.delete(after.id);
    }
    if (corrected.kind !== "completed") throw new Error("review reconciliation normalization unexpectedly requested user input");
    if (corrected.status !== "completed") {
      throw new Error(corrected.reason ?? `review reconciliation normalization turn ${corrected.status}`);
    }
    const correctedResult = applyReviewConsistency(parseReview(corrected.text));
    // The rewrite may ONLY drop the aligned-conflict entries: every other
    // finding/test gap of the original review must survive EXACTLY
    // (severity/blocking/title/body/file/line, test-gap text). A
    // reconciliation that silently swallows a real, aligned review entry is
    // neither a verdict nor a conflict — it is a hardened failure the caller
    // treats as retryable infrastructure (no cycle, no latestReview, no fix
    // prompt).
    const preservationError = reconciliationPreservationViolation(result, conflicts, correctedResult);
    if (preservationError) {
      throw new Error(`reconciled review violated entry preservation: ${preservationError}`);
    }
    const recheck = await this.alignReview(after, correctedResult, signal, input);
    return recheck.aligned ? { aligned: true, result: correctedResult } : { aligned: false };
  }

  /**
   * Persist a freshly started VISIBLE turn as the active turn of its kind
   * (and track it in-process as the exact active thread/turn pair for
   * cancellation). If the workflow was cancelled in the meantime the write is
   * suppressed (the record is never resurrected) and the turn we just obtained
   * is interrupted.
   */
  private async registerActiveTurn(
    workflowId: string,
    threadId: string,
    turnId: string,
    kind: "planner" | "reviewer",
    ephemeral = false,
  ): Promise<void> {
    this.runtime.activeTurns.set(workflowId, { threadId, turnId, kind, ephemeral });
    const outcome = await this.store.update(workflowId, (r) => {
      if (kind === "planner" && !ephemeral) {
        r.plannerThreadId = threadId;
        r.plannerTurnId = turnId;
      } else if (kind === "reviewer" && !ephemeral) {
        r.reviewerThreadId = threadId;
        r.reviewerTurnId = turnId;
        if (r.processState === "running") {
          r.activeTurnId = turnId;
          r.lastProgressAt = new Date().toISOString();
          r.lastProgressMessage = "Reviewer turn is running";
        }
      } else if (kind === "reviewer" && r.processState === "running") {
        r.activeTurnId = turnId;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Reviewer turn is running";
      }
    }, { ignoreCancelled: false });
    if (outcome.suppressed) {
      // Cancelled while the turn was being registered: kill the turn we just
      // started, never the record.
      this.runtime.activeTurns.delete(workflowId);
      await this.turnGateway.interrupt(threadId, turnId).catch(() => undefined);
    }
  }

  /**
   * Track a freshly started EPHEMERAL conversion-fork turn as the exact active
   * thread/turn pair for cancellation. NEVER persisted: the fork id must not
   * land in plannerThreadId/reviewerThreadId (the durable ids keep pointing at
   * the visible tasks Codex Desktop shows). If the workflow was cancelled in
   * the meantime, the fork turn we just obtained is interrupted.
   */
  private async registerEphemeralTurn(
    workflowId: string,
    threadId: string,
    turnId: string,
    kind: "planner" | "reviewer",
  ): Promise<void> {
    this.runtime.activeTurns.set(workflowId, { threadId, turnId, kind, ephemeral: true });
    const record = await this.store.load(workflowId);
    if (record?.processState === "running" && kind === "reviewer") {
      await this.reviewObservation.mark(workflowId, undefined, "Reviewer conversion turn is running", turnId);
    }
    if (!record || record.phase === "cancelled") {
      this.runtime.activeTurns.delete(workflowId);
      await this.turnGateway.interrupt(threadId, turnId).catch(() => undefined);
    }
  }

  private trackNoChange(record: WorkflowRecord, evidence: ReviewEvidence): void {
    record.latestReviewEvidence = evidence;
    if (evidence.insufficient || !evidence.fingerprint) {
      // Unobservable rounds must not chain across themselves: clear the chain
      // so a later return to an old fingerprint is treated as fresh progress.
      record.noChangeReviewRounds = 0;
      record.previousReviewFingerprint = undefined;
      return;
    }
    if (record.previousReviewFingerprint !== undefined && evidence.fingerprint === record.previousReviewFingerprint) {
      record.noChangeReviewRounds = (record.noChangeReviewRounds ?? 0) + 1;
    } else {
      record.noChangeReviewRounds = 0;
    }
    record.previousReviewFingerprint = evidence.fingerprint;
  }

  /** Pure outcome computation: no store writes and no side effects. */
  private computeReviewOutcome(record: WorkflowRecord, result: ReviewResult): ReviewOutcome {
    const hasBlocking = result.findings.some((finding) => finding.blocking) || result.testGaps.length > 0;
    if (result.verdict === "pass") {
      return {
        phase: "passed",
        noChangeReviewRounds: 0,
        message: `Codex Reviewer passed workflow ${record.id}. Report the verified implementation and tests to the user.`,
      };
    }
    if (!hasBlocking) {
      // Non-blocking only: stop automatic repair and let the user decide.
      return {
        phase: "waiting_review_decision",
        noChangeReviewRounds: 0,
        message: `Codex Reviewer found only non-blocking improvements for workflow ${record.id}. Present each item below to the user and wait for their choice, then call codex_workflow_decide with workflowId ${record.id} and decision "accept" (ship as-is) or "fix" (repair first).\n${formatFindings(result)}`,
      };
    }
    if ((record.noChangeReviewRounds ?? 0) >= this.config.maxNoChangeReviewRounds) {
      return {
        phase: "blocked",
        noChangeReviewRounds: record.noChangeReviewRounds,
        error: `workspace produced no verifiable change for ${record.noChangeReviewRounds} consecutive review round(s) while the Codex Reviewer kept requesting blocking changes`,
        message: `Codex Reviewer still requests changes for workflow ${record.id}, but the workspace has not changed since the previous review (fingerprint identical). Stopping automatic repair and clearing the active turn. Report that no verifiable workspace change was made and show the remaining findings:\n${formatFindings(result)}`,
      };
    }
    if (record.reviewCycles >= this.config.maxReviewCycles) {
      return {
        phase: "blocked",
        noChangeReviewRounds: record.noChangeReviewRounds,
        error: `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles`,
        message: `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles. Stop automatic repair and report the remaining findings:\n${formatFindings(result)}`,
      };
    }
    return {
      phase: "fixing",
      noChangeReviewRounds: record.noChangeReviewRounds,
      message: `Codex Reviewer requested changes for workflow ${record.id}. Fix every finding below in this same DSH session, rerun relevant tests, then call codex_workflow_review again before answering the user.\n${formatFindings(result)}`,
    };
  }

  /**
   * Accept the visible Planner turn outcome and derive the structured
   * PlannerResult:
   *
   * - `needs_input` (native clarification request) is used directly — the turn
   *   is still open and `continue` answers it.
   * - Any COMPLETED visible reply — the complete plan, a numbered-question
   *   fallback or a readable failure explanation — is converted into the
   *   enforced PlannerResult JSON by an EPHEMERAL fork of the Planner task
   *   (`normalizeInFork`). The fork runs read-only with the planner output
   *   schema, the SAME model as the visible turn and effort `low`; its id is
   *   never persisted (plannerThreadId keeps pointing at the durable task
   *   Codex Desktop shows).
   * - READY is only accepted when the CURRENT visible reply itself is a
   *   complete, decision-complete plan. A reply that merely confirms or
   *   acknowledges ("已确认…后续将规划…"), promises to plan later, or is a
   *   short summary is NEVER injected: if the conversion nevertheless said
   *   ready for such a reply, the plugin runs ONE controlled completion turn
   *   on the SAME persistent Planner task (a normal visible Plan-mode turn,
   *   reusing the same task id) and re-converts; only a genuinely complete
   *   plan from one of the two replies enters executing — otherwise the
   *   workflow FAILS without writing planMarkdown. No plan is ever
   *   fabricated or padded from earlier history.
   *
   * Planner normalization failure is terminal for the workflow: the raw
   * visible Markdown is NEVER accepted as a plan — the record is failed with
   * the diagnostic. Reviewer normalization failures, by contrast, fall back to
   * a retryable phase (see reviewOnce).
   */
  private async acceptPlannerOutcome(
    workflowId: string,
    outcome: TurnWaitResult,
    exec: ToolRunContext,
    model?: string,
    cwd?: string,
  ): Promise<WorkflowRecord> {
    if (outcome.kind === "needs_input") {
      this.runtime.pending.set(workflowId, outcome);
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "waiting_input";
        r.questions = outcome.request.questions;
        r.pendingInput = { turnId: outcome.turnId, itemId: outcome.request.itemId };
        if (model) r.plannerModel = model;
      }, { ignoreCancelled: false });
      if (!commit.suppressed) this.emitSessionEvent(commit.record, {
        type: "dsh-codex-workflow/plan-updated",
        data: { workflowId, status: "waiting_input", questions: commit.record.questions, assumptions: commit.record.assumptions },
      });
      return commit.record;
    }
    this.runtime.pending.delete(workflowId);
    if (outcome.status !== "completed") throw new Error(outcome.error ?? `planner turn ${outcome.status}`);
    // Visible-reply contract (HARD conditions, independent of the final item
    // type — a Plan-mode turn may legitimately complete as a `plan` item on
    // the first generation and as an `agentMessage` item after a native
    // clarification/continue; both are readable Markdown in Desktop):
    //  - the visible text must be non-empty (no fake/short filler accepted);
    //  - it must not BE the raw structured JSON envelope (status/planMarkdown).
    if (!outcome.text || !outcome.text.trim()) {
      return this.failPlannerNormalization(workflowId, "planner visible reply is empty");
    }
    if (isPlannerJsonEnvelope(outcome.text)) {
      return this.failPlannerNormalization(workflowId, "planner visible reply leaked the structured JSON envelope");
    }
    // A cancel that won while the visible turn was running ends here: never
    // create a conversion fork for a cancelled workflow.
    const beforeFork = await this.store.load(workflowId);
    if (!beforeFork || beforeFork.phase === "cancelled") return beforeFork!;
    // One ephemeral conversion of a visible reply; every failure path FAILS
    // the workflow terminally and never writes a plan.
    const convert = async (visibleText: string): Promise<PlannerResult | WorkflowRecord> => {
      let normalized: TurnWaitResult;
      try {
        normalized = await this.turnGateway.normalizeInFork({
          threadId: outcome.threadId,
          cwd: cwd ?? process.cwd(),
          prompt: plannerConvertPrompt(visibleText),
          ...(model ? { model } : {}),
          outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
          onStarted: (started) => this.registerEphemeralTurn(workflowId, started.threadId, started.turnId, "planner"),
        }, exec.signal);
      } catch (error) {
        return this.failPlannerNormalization(workflowId, errorMessage(error));
      } finally {
        this.runtime.activeTurns.delete(workflowId);
      }
      if (normalized.kind !== "completed" || normalized.status !== "completed") {
        return this.failPlannerNormalization(
          workflowId,
          normalized.kind === "needs_input"
            ? "planner normalization unexpectedly requested user input"
            : `planner normalization turn ${normalized.status}`,
        );
      }
      try {
        return parsePlanner(normalized.text);
      } catch (error) {
        return this.failPlannerNormalization(workflowId, `planner normalization returned an invalid result: ${errorMessage(error)}`);
      }
    };
    let visibleText = outcome.text;
    let converted = await convert(visibleText);
    if (isWorkflowRecord(converted)) return converted;
    let result = converted;
    // The conversion said ready, but the CURRENT visible reply itself is not a
    // complete plan (confirmation/acknowledgement, promise-to-plan-later,
    // short summary): never inject it. Run ONE controlled completion turn on
    // the SAME persistent Planner task, then re-convert; the second reply is
    // judged by the same gate.
    if (result.status === "ready" && result.planMarkdown?.trim() && !isPlausibleCompletePlan(visibleText)) {
      let completion: TurnWaitResult;
      try {
        completion = await this.startTurnWithTransientRetry(outcome.threadId, {
          prompt: plannerCompletionPrompt(visibleText),
          ...(model ? { model } : {}),
          effort: this.config.plannerEffort,
          planMode: true,
          onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "planner", true),
        }, exec.signal);
      } finally {
        // EVERY ending path — completion, cancel, timeout, onStarted
        // persistence failure, process error — must drop the active-turn
        // mapping, so a stale completed/failed turn can never be interrupted
        // by a later cancel.
        this.runtime.activeTurns.delete(workflowId);
      }
      if (completion.kind === "needs_input") {
        // The completion turn asked for user input: fall back to the normal
        // waiting_input machinery (user answers via codex_workflow_continue).
        this.runtime.pending.set(workflowId, completion);
        const commit = await this.store.update(workflowId, (r) => {
          r.phase = "waiting_input";
          r.questions = completion.request.questions;
          r.pendingInput = { turnId: completion.turnId, itemId: completion.request.itemId };
          if (model) r.plannerModel = model;
        }, { ignoreCancelled: false });
        if (!commit.suppressed) this.emitSessionEvent(commit.record, {
          type: "dsh-codex-workflow/plan-updated",
          data: { workflowId, status: "waiting_input", questions: commit.record.questions, assumptions: commit.record.assumptions },
        });
        return commit.record;
      }
      if (completion.status !== "completed") {
        throw new Error(completion.error ?? `planner completion turn ${completion.status}`);
      }
      if (!completion.text || !completion.text.trim() || isPlannerJsonEnvelope(completion.text)) {
        return this.failPlannerNormalization(workflowId, "planner completion reply is empty or a JSON envelope");
      }
      visibleText = completion.text;
      converted = await convert(visibleText);
      if (isWorkflowRecord(converted)) return converted;
      result = converted;
      // The completion turn's reply is judged by the SAME hard gate: a still
      // incomplete reply can never become a plan.
      if (result.status === "ready" && !isPlausibleCompletePlan(visibleText)) {
        return this.failPlannerNormalization(
          workflowId,
          "planner visible reply is not a complete plan (confirmation/acknowledgement or too short); the completion turn did not produce a plan either",
        );
      }
    }
    if (result.status === "needs_input") {
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "waiting_input";
        r.questions = result.questions;
        r.assumptions = result.assumptions;
        if (model) r.plannerModel = model;
      }, { ignoreCancelled: false });
      if (!commit.suppressed) this.emitSessionEvent(commit.record, {
        type: "dsh-codex-workflow/plan-updated",
        data: { workflowId, status: "waiting_input", questions: commit.record.questions, assumptions: commit.record.assumptions },
      });
      return commit.record;
    }
    if (result.status === "ready" && result.planMarkdown?.trim()) {
      // itemType is an audit/test field, NOT a ready gate: a ready plan may
      // come from a `plan` item OR from an `agentMessage` item (native
      // clarification/continue paths); the hard conditions above already
      // guaranteed an non-empty, envelope-free, complete visible reply, and
      // the ephemeral normalization verified this is a ready plan.
      const planMarkdown = ensurePlanBlock(result.planMarkdown);
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "executing";
        r.planMarkdown = planMarkdown;
        r.assumptions = result.assumptions;
        r.questions = [];
        r.pendingInput = undefined;
        if (model) r.plannerModel = model;
      }, { ignoreCancelled: false });
      if (!commit.suppressed) this.emitSessionEvent(commit.record, {
        type: "dsh-codex-workflow/plan-updated",
        data: { workflowId, status: "ready", planMarkdown, questions: [], assumptions: commit.record.assumptions },
      });
      if (!commit.suppressed) exec.deferContext(pluginMessage(executionPrompt(commit.record)));
      return commit.record;
    }
    // Explicit failed status (or a ready that lost its plan text): never write
    // planMarkdown, never enter executing.
    const commit = await this.store.update(workflowId, (r) => {
      r.phase = "failed";
      r.error = result.message ?? "Codex planner did not return a usable plan";
    }, { ignoreCancelled: false });
    if (!commit.suppressed) this.emitSessionEvent(commit.record, {
      type: "dsh-codex-workflow/plan-updated",
      data: { workflowId, status: "failed", questions: commit.record.questions, assumptions: commit.record.assumptions, message: commit.record.error },
    });
    return commit.record;
  }

  /** Planner normalization failure is TERMINAL for the workflow: the readable
   * visible reply is never accepted as a plan. The record is failed with the
   * diagnostic; `start`/`continue` propagate so the caller sees the failure. */
  private async failPlannerNormalization(workflowId: string, message: string): Promise<WorkflowRecord> {
    const failed = await this.store.update(workflowId, (r) => {
      if (r.phase === "cancelled") return;
      r.phase = "failed";
      r.error = message;
    }, { ignoreCancelled: false });
    if (failed.suppressed) return failed.record;
    throw new Error(message);
  }

  private async owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.store.load(workflowId);
    if (!record) throw new Error(`unknown workflow ${workflowId}`);
    if (record.dshSessionId !== requireAgent(exec).id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  private async assertNoActiveWorkflow(sessionId: string): Promise<void> {
    const active = await this.store.activeForSession(sessionId);
    if (active) {
      throw new Error(`session already has active Codex workflow ${active.id} (${active.phase}); continue it or query codex_workflow_status instead of starting another`);
    }
  }
}

interface ReviewOutcome {
  phase: WorkflowPhase;
  error?: string;
  message?: string;
  noChangeReviewRounds?: number;
}

export function plannerPrompt(task: string): string {
  return `You are the planning gate in a DSH-controlled coding workflow. Inspect the current workspace read-only and produce a decision-complete implementation plan for the task below. Do not edit files. Ask user questions only when a missing product decision makes a safe plan impossible.

Do not invent constraints the user did not state. In particular, DO NOT strengthen a requirement like "tests must cover A and B" into an exact test-COUNT restriction ("exactly two tests") unless the user explicitly limited the count. Any verification method the task names — automated tests, static checks, or real command verification — is acceptable evidence for a requirement; keep the planned verification as close to the task's own wording as possible.

Your visible reply stays in Codex Desktop as a single complete, readable Markdown plan (goal, changes, files, verification) in the same language as the task; Codex renders Plan-mode output as a plan item. Do NOT output JSON.
- When you need clarification, ask through the native input request whenever possible; if that is unavailable, reply ONLY with clear numbered questions, one per line (1. ... 2. ...), and nothing else.
- When you cannot produce a plan, reply with a readable explanation of why.

TASK:
${task}`;
}

function resumedAnswerPrompt(answers: Record<string, string[]>): string {
  return `Continue the existing plan using these user answers, then reply exactly like the first planning turn did: a single complete, readable Markdown plan in the same language as the original task, or only numbered follow-up questions, or a readable failure explanation. Never JSON.\n${JSON.stringify(answers, null, 2)}`;
}

/** Conversion prompt for the EPHEMERAL fork of the Planner task: turns the
 * visible plan (the persisted Plan-mode plan item / agentMessage) into the
 * enforced PlannerResult JSON. Runs read-only with the planner output schema,
 * so the fork emits exactly the structured result and nothing is ever written
 * into the visible task history.
 *
 * READY is STRICTLY the current visible reply ITSELF being a complete,
 * executable, decision-complete plan — never inferred from earlier history,
 * never a confirmation/acknowledgement, a promise to plan later, a short
 * summary or an answer-only reply. The plugin independently re-checks the
 * same gate via `isPlausibleCompletePlan` (see acceptPlannerOutcome). */
function plannerConvertPrompt(rawReply: string): string {
  return `Convert the planner's visible reply below into the required JSON result. Output ONLY the JSON object matching the enforced output schema:
- status "ready" ONLY when the visible reply ITSELF is a complete, executable, decision-complete plan (goal, changes, files, verification). Do NOT infer readiness from earlier history or from questions/answers: a reply that only confirms or acknowledges ("已确认…，后续将规划…"), promises to plan later, is a short summary, or merely answers earlier questions is NOT ready.
- Only numbered questions -> status "needs_input" with one question entry per numbered item.
- A readable failure explanation, or a confirmation/acknowledgement without an actual plan -> status "failed" with a clear message.
- Preserve every assumption stated in the reply.

Planner visible reply:
${rawReply}`;
}

/** Minimum length below which a visible reply cannot plausibly BE a complete
 * decision-complete plan. A confirmation/acknowledgement typically ends here
 * (real sample: 77 Chinese characters). */
const MIN_READY_PLAN_CHARS = 120;

/** "The visible reply ITSELF is a complete plan" heuristic: non-trivial length
 * plus at least one structured plan marker (markdown heading / bullet /
 * numbered line). Confirmations and promises ("已确认部署目标…后续规划将…")
 * fail it even when the conversion said ready. The heuristic NEVER fabricates
 * a plan: its only effect is either one controlled completion turn on the same
 * persistent Planner task, or a terminal failure without planMarkdown. */
function isPlausibleCompletePlan(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_READY_PLAN_CHARS) return false;
  return /(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d{1,2}[.、)][ \t])/m.test(trimmed);
}

/** Prompt for the ONE controlled completion turn on the SAME persistent
 * Planner task when the visible reply was not a complete plan: it demands the
 * actual plan now, never an acknowledgement or a promise. */
function plannerCompletionPrompt(previousReply: string): string {
  return `The planner's previous visible reply did not contain the actual plan — it only confirmed, acknowledged or summarized:
---
${previousReply}
---
Now produce the COMPLETE decision-complete plan as your ONLY final visible message (goal, changes, files, verification), in the same language as the task. Do NOT acknowledge this instruction, do NOT promise to plan later, do NOT output JSON — write the plan now.`;
}

/** Discriminator for the planner conversion helper results (a suppressed
 * cancelled/failed record vs a converted PlannerResult). */
function isWorkflowRecord(value: unknown): value is WorkflowRecord {
  return Boolean(value) && typeof (value as WorkflowRecord).phase === "string" && typeof (value as PlannerResult).status !== "string";
}

export function executionPrompt(record: WorkflowRecord): string {
  const submit = record.origin === "codex_bridge"
    ? `call codex_workflow_submit with workflowId ${record.id}, a concise implementation summary, changed files, and test results so the originating Codex task can review the result`
    : `call codex_workflow_review with workflowId ${record.id}, a concise implementation summary, changed files, and test results before answering the user`;
  return `Codex planning is complete for workflow ${record.id}. Implement the approved plan below in ${record.cwd}. You are the only mutation-capable executor: use normal DSH tools and approvals, keep scope faithful to the plan, run relevant verification, and then ${submit}.\n\n${record.planMarkdown}`;
}

/** Shared readable review context for EVERY review path (DSH-led visible
 * review AND the background Reviewer callback): workflow identity, original
 * task, approved plan, implementation summary, changed files, test results,
 * and the captured workspace evidence (status, bounded diff, truncation
 * notice). Git and non-Git workspaces get the SAME contract. */
export function reviewContextBlock(record: WorkflowRecord, input: ReviewInput, evidence: ReviewEvidence): string {
  const submission = record.origin === "codex_bridge"
    ? `SUBMISSION: ${record.submissionId ?? "(unknown)"}\n`
    : "";
  return `WORKFLOW: ${record.id}
${submission}CWD: ${record.cwd}
REVIEW CYCLE: ${record.reviewCycles}

ORIGINAL TASK:
${record.task || "(no explicit task — review the current changes)"}

${record.planMarkdown ? `APPROVED PLAN:\n${record.planMarkdown}\n\n` : ""}${record.latestReview ? `PREVIOUS APPLIED REVIEW (the findings DSH was asked to fix; the implementation summary below describes what changed since):
${formatFindings(record.latestReview)}
` : ""}IMPLEMENTATION SUMMARY (this round's changes since the previous review):
${input.implementationSummary}

CHANGED FILES:
${(input.changedFiles ?? []).join("\n") || "not supplied"}

TEST RESULTS:
${input.testResults ?? "not supplied"}

WORKSPACE EVIDENCE (kind: ${evidence.kind}):
${evidence.status || "(empty)"}
${evidence.diffTruncated ? `[diff truncated by evidence collection, observed ${evidence.diffBytes} bytes; the full diff was too large to embed]` : `[full observed diff, ${evidence.diffBytes} bytes]`}
${evidence.diff}`;
}

/** The readable visible-output contract shared by every review path: the
 * reviewer's final message is a silent, readable Markdown review in the SAME
 * language as the original task — never JSON (the structured verdict comes
 * from the ephemeral conversion fork). */
function visibleReviewContract(record: WorkflowRecord): string {
  return `${SILENT_REVIEW_PROMPT_BLOCK}

Reply in the same language as the original task. Your visible reply is what stays in Codex Desktop, so write it as readable Markdown with these sections, and NOT as JSON:
VERDICT: pass | changes_requested
FINDINGS: one entry per finding with severity, blocking (yes/no), title, body, and the concrete file:line reference when available
TEST GAPS: one per line, or "none"
SUMMARY: a short readable summary`;
}

/** Developer-instructions version of the review contract (includes the full
 * per-round context). Injected into the durable Reviewer thread at creation
 * and refreshed before every re-review as an AUXILIARY channel only — a
 * native `review/start` turn may not reliably see hidden thread-settings
 * instructions, so the complete context and the coverage gate always ride
 * the custom target's instructions on every path (Git included). */
export function reviewContractInstructions(record: WorkflowRecord, input: ReviewInput, evidence: ReviewEvidence): string {
  return `${visibleReviewContract(record)}

${reviewContextBlock(record, input, evidence)}`;
}

/** The correctness-and-bounds rule shared by EVERY review path (the DSH-led
 * `review/start` custom target AND the background Reviewer callback). The
 * reviewer must independently observe the changes under review and check
 * EVERY explicit requirement of ORIGINAL TASK / APPROVED PLAN one by one.
 * Since 1.0.10 the verification evidence of a requirement follows the method
 * the task/plan names (automated tests, static checks or real command
 * verification); ordinary scope, test-count, dependency and
 * verification-method conflicts resolve in the plan's favor, and only a
 * REPRODUCIBLE critical/high defect may override the plan's ordinary bounds. */
export function reviewRequirementGate(record: WorkflowRecord, git: boolean): string {
  const scope = git
    ? "Your review target is the CURRENT uncommitted workspace changes: staged, unstaged AND untracked files in this git repository. Independently confirm the exact changes with read-only `git status` and `git diff` (including `git diff --cached`) instead of trusting this summary."
    : "Your review target is the changed files listed under CHANGED FILES below. Independently read those files in the workspace (read-only) instead of trusting this summary.";
  const planRequirement = record.planMarkdown
    ? "Check EVERY explicit requirement in ORIGINAL TASK and APPROVED PLAN above, one by one, against the changes you observed."
    : "Check EVERY explicit requirement in ORIGINAL TASK above, one by one, against the changes you observed.";
  return `REVIEW SCOPE:
${scope}
${AUTHORITY_HIERARCHY}
ITEM-BY-ITEM COVERAGE:
- ${planRequirement}
- Every explicit requirement must be IMPLEMENTED in the observed changes; a missing implementation is a blocking finding.
- Verification evidence follows the method the ORIGINAL TASK / APPROVED PLAN names: automated tests, STATIC CHECKS and REAL COMMAND verification are ALL formal evidence. Missing automated tests alone are blocking ONLY when the task/plan explicitly requires an automated test for the item or a concrete regression risk is demonstrated with reproducible code evidence; otherwise record them as non-blocking or accept the plan's own verification method.
- Never demand changes that exceed the ORIGINAL TASK / APPROVED PLAN's explicit file count, test count, scope, dependency limits or manual acceptance method.
- VERDICT: pass is allowed when every explicit requirement has implementation evidence (code) plus verification evidence of the kind the task/plan requires.`;
}

/** Instructions for the VISIBLE DSH-led review turn (`review/start` custom
 * target) in EVERY workspace — Git and non-Git alike. The custom target
 * carries the full per-round context (original task, approved plan,
 * implementation summary, changed files, test results, workspace evidence),
 * the review scope and the item-by-item coverage gate directly into the
 * review turn, so verdict correctness never depends on hidden
 * thread-settings developer instructions. In Git repositories the scope pins
 * the review to the current staged/unstaged/untracked changes and requires
 * an independent read-only `git status`/`git diff` check. */
export function reviewInstructions(record: WorkflowRecord, input: ReviewInput, evidence: ReviewEvidence, git: boolean): string {
  return `Review the current workspace read-only. Focus on correctness, regressions, security, and missing tests. Do not edit files. ${visibleReviewContract(record)}

${reviewRequirementGate(record, git)}
${reviewContextBlock(record, input, evidence)}`;
}

/** Conversion prompt for the EPHEMERAL fork of the Reviewer task: turns the
 * visible readable review into the enforced verdict JSON. Runs read-only with
 * the review output schema. The raw review preserves concrete file/line
 * references, so the structured findings keep them. */
export function reviewConversionPrompt(rawReview: string, workflowId: string): string {
  return `Convert the readable code review below into the required JSON schema. Output ONLY the JSON object matching the enforced output schema:
- verdict: pass only when there are no actionable correctness, regression, security, or material test findings.
- For every finding set blocking to true only when it must be fixed before delivery: critical and high findings block by default; medium and low findings block only when they create an actual correctness, regression, security, or delivery-required test gap.
- Every entry in testGaps counts as blocking.
- Preserve concrete file and line references from the review.
- Keep the review's summary as summary (same language as the original task).

Workflow: ${workflowId}
Raw review:
${rawReview}`;
}

/** Prompt used for a visible background review appended to the originating
 * workflow task (or to a legacy/review-only Reviewer task). It stays read-only;
 * the structured verdict is derived later in an ephemeral fork and applied
 * outside the sandbox. The reviewer never writes the bridge queue itself.
 *
 * The full bounded evidence diff is embedded verbatim (already capped at
 * `reviewDiffMaxBytes` by evidence collection), and a truncation notice is
 * always shown whenever the diff was cut. The reviewer is explicitly allowed
 * to run READ-ONLY inspection commands and read files to see the parts beyond
 * the embedded evidence — but never to write/modify anything, create threads,
 * call DSH tools or the bridge CLI. */
function callbackPrompt(record: WorkflowRecord, input: ReviewInput, evidence: ReviewEvidence): string {
  return `You are the independent reviewer for a DSH-executed coding workflow. Review the implementation below against the original plan. Stay read-only: do not edit files, do not create replacement threads, and do not call any dsh tools. ${visibleReviewContract(record)}

${reviewRequirementGate(record, evidence.kind === "git")}
${reviewContextBlock(record, input, evidence)}

You MAY run read-only inspection commands (for example \`git diff\`, \`git status\`, \`git show\`, reading any file under the workspace) to review parts of the workspace not fully covered above — the sandbox runs read-only and makes this safe. You MUST NOT write or modify any file, run anything that mutates the workspace, create a replacement thread, call any dsh tool, or invoke the bridge CLI.

The structured verdict is derived from this review automatically by the plugin; never write JSON to disk or to any other channel.`;
}

const SUBMISSION_ACTIVE = new Set<SubmissionState>(["queued", "sending", "waiting_verdict", "retrying", "verdict_ready", "received"]);
const SUBMISSION_TERMINAL = new Set<SubmissionState>(["applied", "delivered", "failed"]);
const RECOVERABLE_STATES = new Set<SubmissionState>(["queued", "sending", "retrying"]);

export function callbackRecoveryDelay(baseMs: number, attemptsThisRound: number): number {
  return Math.min(5 * 60 * 1000, baseMs * 2 ** Math.min(attemptsThisRound, 8));
}

function isRecoverableContentionFailure(record: WorkflowRecord): boolean {
  return record.origin === "codex_bridge"
    && record.submissionState === "failed"
    && Boolean(record.pendingReviewRequest)
    && (
      /^codex thread busy after \d+ attempts$/.test(record.submissionError ?? "")
      || /already has an active writer/i.test(record.submissionError ?? "")
    );
}

function submissionActive(state: SubmissionState | undefined): boolean {
  return state !== undefined && SUBMISSION_ACTIVE.has(state);
}

export function submissionTerminal(state: SubmissionState | undefined): boolean {
  return state !== undefined && SUBMISSION_TERMINAL.has(state);
}

/** Fenced lease handle over the SQLite coordination store: every renew and
 * release is a conditional UPDATE on epoch+owner, so once another process
 * takes over the lease, the old owner's renew/release change 0 rows and are
 * no-ops. The heartbeat renews the lease for long callback runs; when a renew
 * returns false (changes=0, ownership lost) the onLost hook fires so the
 * owner can abort its child and stop writing state. */
export interface ManagerLease {
  readonly owner: string;
  readonly epoch: number;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
  heartbeat(periodMs: number, onLost?: () => void): void;
  stopHeartbeat(): void;
}

function makeManagerLease(
  coordination: CoordinationStore,
  resource: string,
  epoch: number,
  owner: string,
  ttlMs: number,
): ManagerLease {
  let heartbeatTimer: NodeJS.Timeout | undefined;
  return {
    owner,
    epoch,
    renew: () => Promise.resolve(coordination.renewLease(resource, epoch, owner, ttlMs)),
    release: () => Promise.resolve(coordination.releaseLease(resource, epoch, owner)),
    heartbeat: (periodMs: number, onLost?: () => void) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        const ok = coordination.renewLease(resource, epoch, owner, ttlMs);
        if (!ok) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
          onLost?.();
        }
      }, Math.max(100, periodMs));
      heartbeatTimer.unref();
    },
    stopHeartbeat: () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    },
  };
}

/** Transient enqueue failures (queue busy, I/O) keep the staged verdict
 * recoverable; only unrecoverable identity/schema errors terminate it. */
function isUnrecoverableEnqueueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already queued with a different command|already received a different command|invalid bridge command|invalid bridge request id|unsupported version/i.test(message);
}

/** True when the text IS the raw structured planner JSON envelope that must
 * never appear in a visible reply (has both `status` and `planMarkdown`).
 * Readable Markdown, JSON error payloads and plain JSON noise are not. */
function isPlannerJsonEnvelope(text: string): boolean {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed.startsWith("{")) return false;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return "status" in record && "planMarkdown" in record;
    }
  } catch {
    // not JSON — readable text
  }
  return false;
}

function parsePlanner(text: string): PlannerResult {
  const value = parseJsonObject(text);
  const status = value.status;
  if (status !== "ready" && status !== "needs_input" && status !== "failed") throw new Error("invalid planner status");
  return {
    status,
    ...(typeof value.planMarkdown === "string" ? { planMarkdown: value.planMarkdown } : {}),
    questions: Array.isArray(value.questions) ? value.questions.map(parsePlannerQuestion) : [],
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.filter((item): item is string => typeof item === "string") : [],
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

export function parseReview(text: string): ReviewResult {
  const value = parseJsonObject(text);
  if (value.verdict !== "pass" && value.verdict !== "changes_requested") throw new Error("invalid review verdict");
  return {
    verdict: value.verdict,
    findings: Array.isArray(value.findings) ? value.findings.map(parseReviewFinding) : [],
    testGaps: Array.isArray(value.testGaps) ? value.testGaps.filter((item): item is string => typeof item === "string") : [],
    summary: typeof value.summary === "string" ? value.summary : "",
  };
}

/**
 * Enforce the cross-field invariant between verdict and content so a
 * structurally valid but semantically contradictory JSON result never lets a
 * blocking problem ship: a "pass" carrying findings/testGaps is demoted to
 * changes_requested (the blocking/non-blocking gate then applies), while a
 * changes_requested with nothing actionable is rejected outright.
 */
export function applyReviewConsistency(result: ReviewResult): ReviewResult {
  const hasContent = result.findings.length > 0 || result.testGaps.length > 0;
  if (result.verdict === "pass" && hasContent) {
    return { ...result, verdict: "changes_requested" };
  }
  if (result.verdict === "changes_requested" && !hasContent) {
    throw new Error("invalid review result: changes_requested without findings or test gaps");
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned non-object JSON");
  return value as Record<string, unknown>;
}

function parsePlannerQuestion(value: unknown): PlannerResult["questions"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid planner question");
  const question = value as Record<string, unknown>;
  if (typeof question.id !== "string" || typeof question.question !== "string") throw new Error("invalid planner question");
  return {
    id: question.id,
    header: typeof question.header === "string" ? question.header : "Codex question",
    question: question.question,
    ...(Array.isArray(question.options) ? {
      options: question.options.flatMap((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return [];
        const entry = option as Record<string, unknown>;
        return typeof entry.label === "string" ? [{
          label: entry.label,
          ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
        }] : [];
      }),
    } : {}),
    allowOther: question.allowOther === true,
    secret: question.secret === true,
  };
}

function parseReviewFinding(value: unknown): ReviewResult["findings"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid review finding");
  const finding = value as Record<string, unknown>;
  if (!isSeverity(finding.severity) || typeof finding.blocking !== "boolean"
    || typeof finding.title !== "string" || typeof finding.body !== "string") {
    throw new Error("invalid review finding");
  }
  return {
    severity: finding.severity,
    blocking: finding.blocking,
    title: finding.title,
    body: finding.body,
    ...(typeof finding.file === "string" && finding.file ? { file: finding.file } : {}),
    ...(Number.isInteger(finding.line) ? { line: finding.line as number } : {}),
  };
}

function isSeverity(value: unknown): value is ReviewResult["findings"][number]["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function ensurePlanBlock(plan: string): string {
  const trimmed = plan.trim();
  return trimmed.includes("<proposed_plan>") ? trimmed : `<proposed_plan>\n${trimmed}\n</proposed_plan>`;
}

export function formatFindings(review: ReviewResult): string {
  const findings = review.findings.map((finding, index) => {
    const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
    const blocking = finding.blocking ? ", blocking" : "";
    return `${index + 1}. [${finding.severity}${blocking}] ${finding.title}${location}: ${finding.body}`;
  });
  return [...findings, ...review.testGaps.map((gap) => `Test gap: ${gap}`)].join("\n") || review.summary;
}

export function pluginMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: noticeSource("Codex workflow continuation"),
  });
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error("Codex workflow tools require a live DSH agent session");
  return exec.agent;
}

function threadName(prefix: string, text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return `${prefix}: ${compact.slice(0, 72)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

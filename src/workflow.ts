import { randomUUID } from "node:crypto";
import { WorkflowReviewAdmission } from "./application/workflow-review-admission.js";
import { assertReviewerRecovery } from "./application/reviewer-run-identity.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CoordinationStore } from "./coordination.js";
import {
  type CodexCallbackRequest,
  type CodexCallbackResult,
  type CodexCallbackPendingStartReceipt,
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
import { backoffDelayMs, compactDiagnostic, isRecoverableModelFailure, normalizeBackoff, retryClockNow, retryTransient, transientReason, type BackoffPolicy } from "./transient-retry.js";
import {
  SILENT_REVIEW_PROMPT_BLOCK,
  reviewDisplayError,
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
import { assertPlannerRun, assertPlannerRunIdentity, type PlannerRunIdentity } from "./application/planner-run-identity.js";
import { assertPlannerRunCheckpoint, PlannerStageModelError, type PlannerRunCheckpoint } from "./application/planner-run-checkpoint.js";
import { CodexTurnInterruptionError } from "./turn-interruption.js";
import { CodexTurnReceiptPendingError, type PendingTurnReceiptOperation } from "./pending-turn-receipt.js";
import { submissionReviewIdentity } from "./application/submission-review-checkpoint.js";
import { assertSubmissionReviewRound, bridgeReviewUnavailableReason, originalBridgeResourceUnavailable, unavailableReviewerInstruction } from "./application/submission-recovery-policy.js";
import { ReviewFlow } from "./application/review-flow.js";
import { SubmissionFlow } from "./application/submission-flow.js";
import { ReviewerGateway } from "./application/app-server/reviewer-gateway.js";
import { ThreadGateway } from "./application/app-server/thread-gateway.js";
import { TurnGateway } from "./application/app-server/turn-gateway.js";
import { WorkflowRuntimeState, type RecoverableWorkflowRun, type RetainedAuxiliaryTurn, type ReviewerRunSettings } from "./application/workflow-runtime-state.js";
import { TerminalCleanupGuard, terminalCleanupTarget, terminalProcessTreeExited } from "./application/terminal-cleanup-guard.js";
import { originalProcessTreeExited } from "./infrastructure/process-transport.js";
import { ReviewObservation } from "./application/review-observation.js";
import { ReviewExecution } from "./application/review-execution.js";
import { auxiliaryConfirmationKey, ForegroundReviewStageError, type ForegroundReconciliationRecovery } from "./application/foreground-review-checkpoint.js";
import { SubmissionExecution } from "./application/submission-execution.js";
import type { SubmissionReviewConsumer } from "./application/submission-review-consumer.js";
import { LifecycleExecution } from "./application/lifecycle-execution.js";
import type {
  AlignmentOutcome,
  ProcessInstanceIdentity,
  PersistedTurnBaseline,
  PlannerResult,
  ReviewConflict,
  ReviewEvidence,
  ReviewInput,
  ReviewRequestInput,
  ReviewResult,
  SubmissionState,
  SubmitInput,
  TurnNeedsInputResult,
  TurnWaitResult,
  WorkflowConfig,
  WorkflowPhase,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowTerminalCleanupMarker,
} from "./types.js";
import type { CodexCliAuditGateway } from "./codex-cli-audit.js";
import type { CodexWorkflowSessionEvent } from "./review-events.js";
import type { AppServerLiveEvent } from "./app-server.js";
import type { TokenUsageSnapshot } from "./usage-accounting.js";
import { WorkflowUsageObserver } from "./application/workflow-usage-observer.js";
import { LiveRelay } from "./application/live-relay.js";
import { CodexChildSessionFactory, type CodexChildSessionHandle } from "./codex-child-session.js";

export interface CodexGateway {
  /** Observe the current process-local thread registry without starting RPCs. */
  isThreadAvailable?(threadId: string, expectedOwner?: object): boolean;
  /** Capture this registration and its transport; never serialize this owner. */
  captureThreadOwner?(threadId: string): object | undefined;
  /** Server-reported counters only; never starts an RPC or estimates usage. */
  getThreadTokenUsage?(threadId: string): TokenUsageSnapshot | undefined;
  /** Observe measured snapshots; the listener never initiates model calls. */
  onTokenUsage?(listener: (snapshot: TokenUsageSnapshot) => void): () => void;
  startThread(options: { cwd: string; model?: string; name?: string; ephemeral?: boolean }, signal?: AbortSignal): Promise<string>;
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  startTurn(threadId: string, options: {
    expectedOwner?: object;
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
    onProgress?: (entry: AppServerLiveEvent) => void;
  }, signal?: AbortSignal): Promise<TurnWaitResult>;
  continueTurn(
    pending: TurnNeedsInputResult,
    answers: Record<string, string[]>,
    signal?: AbortSignal,
    onProgress?: (entry: AppServerLiveEvent) => void,
    expectedOwner?: object,
  ): Promise<TurnWaitResult>;
  startReview(options: {
    expectedOwner?: object;
    threadId: string;
    cwd: string;
    target: Record<string, unknown>;
    detached: boolean;
    model?: string;
    effort?: WorkflowConfig["reviewerEffort"];
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
    onProgress?: (entry: AppServerLiveEvent) => void;
  }, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
  /** 1.1.2: set a thread's display name. Works on a thread that is NOT loaded,
   * so it never takes the writer lock. Optional: limited gateways may omit it. */
  nameThread?(threadId: string, name: string, signal?: AbortSignal): Promise<void>;
  interrupt(threadId: string, turnId: string, signal?: AbortSignal, expectedOwner?: object): Promise<void>;
  unsubscribeThread?(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<unknown>;
  /** 1.1.6: pin the App Server child for the duration of a round, so the idle
   * window can never fall between creating a thread and its first turn (the
   * respawned process would answer `thread not found` for the new thread). */
  beginRound?(): void;
  /** Release a round pin (`beginRound`). */
  endRound?(): void;
  releaseThreadForExternal?(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<void>;
  /** Structured conversion of a visible reply inside an EPHEMERAL fork of the
   * given persistent thread (`thread/fork` with `ephemeral: true` + one
   * read-only `turn/start` carrying the output schema). The fork is
   * unsubscribed exactly once on every ending path and its id must never be
   * persisted into plannerThreadId/reviewerThreadId. */
  normalizeInFork(options: {
    expectedOwner?: object;
    threadId: string;
    cwd: string;
    prompt: string;
    model?: string;
    outputSchema: Record<string, unknown>;
    sourceEphemeral?: boolean;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<TurnWaitResult>;
  /** Structured conversion directly on an ephemeral source thread. */
  normalizeInThread?(options: {
    expectedOwner?: object;
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
  /** This adapter adopts consumers only after validating the original request
   * and fences cancellation, hooks and caller signals to the current consumer. */
  readonly supportsConsumerOwnership?: true;
  send(
    request: CodexCallbackRequest,
    signal?: AbortSignal,
  ): Promise<CodexCallbackResult>;
  cancel(workflowId: string): void;
  /** Cancel the exact Reviewer operation for one submission (lease-loss
   * fencing: an owner that lost its lease must cancel its own operation, never the new
   * owner's). */
  cancelSubmission(workflowId: string, submissionId: string, consumer?: SubmissionReviewConsumer): void | Promise<void>;
  /** Whether a Reviewer turn is currently running for this workflow (live
   * execution only). Optional: when absent, status falls back to the DSH-led
   * reviewing phase. */
  activeReview?(workflowId: string): boolean;
  availableContinuation?(workflowId: string): boolean;
  hasPendingStartReceipt?(workflowId: string): boolean;
  getPendingStartReceipt?(workflowId: string): CodexCallbackPendingStartReceipt | undefined;
  hasPendingTerminalCleanup?(workflowId: string): boolean;
  hasPendingInterruption?(workflowId: string): boolean;
  getPendingInterruption?(workflowId: string): { originalProcessId?: number; originalProcessIds?: readonly number[];
    originalProcessIdentities?: readonly ProcessInstanceIdentity[] } | undefined;
  getPendingTerminalCleanup?(workflowId: string): { terminalFailure: string; originalProcessId?: number; originalProcessIds?: readonly number[];
    originalProcessIdentities?: readonly ProcessInstanceIdentity[]; executionOwner?: object } | undefined;
  /** Current callback Reviewer counters; observation never opens a thread. */
  getOriginalThreadUsage?(workflowId: string): TokenUsageSnapshot | undefined;
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
  private readonly reviewAdmission = new WorkflowReviewAdmission();
  private readonly usageObserver: WorkflowUsageObserver;
  private readonly terminalCleanupGuard: TerminalCleanupGuard;
  private readonly callbackCleanupGuards = new Map<string, { marker: WorkflowTerminalCleanupMarker; owner: object;
    submissionId?: string; operation?: PendingTurnReceiptOperation }>();
  /** Submission lease lifetime; heartbeats renew at ttl/3 while a callback
   * runs, so only crashed owners are ever taken over. */
  private readonly leaseTtlMs: number;
  /** Seams for the 1.1.1 transient-retry backoff. */
  private readonly retryNow: () => number;
  private readonly retrySleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly retryRandom: () => number;
  private readonly agents?: { get(id: string): Agent | undefined };
  private readonly codexChildFactory?: CodexChildSessionFactory;
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
    codexChildFactory?: CodexChildSessionFactory,
  ) {
    // Usage writes only observed counters through the raw store. They cannot
    // inherit a review's verdict-write authority or resurrect its phase.
    this.usageObserver = new WorkflowUsageObserver(store, codex);
    this.terminalCleanupGuard = new TerminalCleanupGuard(store);
    this.store = this.reviewAdmission.protect(store);
    this.agents = agents;
    this.codexChildFactory = codexChildFactory;
    this.leaseTtlMs = config.leaseTtlMs ?? 60_000;
    this.retryNow = retryHooks.now ?? retryClockNow;
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
      inputRuns: this.runtime.plannerInputs,
      isThreadAvailable: this.turnGateway.isThreadAvailable.bind(this.turnGateway),
      captureThreadOwner: this.codex.captureThreadOwner?.bind(this.codex),
      interruptPlannerTurn: async (threadId, turnId, owner) => {
        if (!this.originalThreadAvailable(threadId, owner)) return false;
        return (await this.boundedCleanup("Planner native input interruption",
          () => this.turnGateway.interrupt(threadId, turnId, undefined, owner))) === undefined;
      },
      confirmPlannerTerminalCleanup: this.confirmTerminalCleanup.bind(this),
      requireAgent,
      acquireCreateLease: this.acquireWorkflowCreateLease.bind(this),
      assertNoActiveWorkflow: this.assertNoActiveWorkflow.bind(this),
      startThread: this.threadGateway.startThread.bind(this.threadGateway),
      bindUsage: (workflowId, threadId, model, expected, owner) => this.usageObserver.bind(workflowId, threadId, "planning", model, expected, owner),
      releasePlannerThread: (threadId, owner) => this.releaseUnboundReviewer(threadId, undefined, owner),
      resumeThread: this.threadGateway.resumeThread.bind(this.threadGateway),
      startTurnWithRetry: this.startTurnWithTransientRetry.bind(this),
      continueTurn: this.turnGateway.continueTurn.bind(this.turnGateway),
      registerActiveTurn: this.registerActiveTurn.bind(this),
      clearActiveTurn: (workflowId) => { this.runtime.activeTurns.delete(workflowId); },
      acceptPlannerOutcome: this.acceptPlannerOutcome.bind(this),
      owned: this.owned.bind(this),
      resumeWorkflow: (workflowId, exec) => this.resume(workflowId, undefined, exec),
      trackForeground: this.trackForeground.bind(this),
      plannerPrompt,
      canCachePlannerText: (text) => Boolean(text?.trim()) && !isPlannerJsonEnvelope(text),
      resumedAnswerPrompt,
      threadName,
      errorMessage,
      createLiveRelay: this.createLiveRelay.bind(this),
      planStarted: (record, childSessionId) => this.emitSessionEvent(record, { type: "dsh-codex-workflow/plan-updated",
        data: { workflowId: record.id, ...(childSessionId ? { childSessionId } : {}), status: "planning", processState: "running", questions: [], assumptions: [] } }),
      planStateChanged: (record, childSessionId) => {
        if (record.phase === "cancelled" || this.runtime.stopped) return;
        const status = record.phase === "failed" || record.retryState?.terminalFailure ? "failed"
          : record.phase === "waiting_input" ? "waiting_input" : "planning";
        this.emitSessionEvent(record, { type: "dsh-codex-workflow/plan-updated", data: {
          workflowId: record.id, status, ...(childSessionId ? { childSessionId } : {}),
          questions: record.questions, assumptions: record.assumptions,
          ...(record.error ? { message: record.error } : {}),
        } });
      },
      createChildSession: this.createCodexChildSession.bind(this),
      disposeChildSession: this.disposeCodexChildSession.bind(this),
      beginRound: this.turnGateway.beginRound.bind(this.turnGateway),
      endRound: this.turnGateway.endRound.bind(this.turnGateway),
      getRecoverableRun: (workflowId) => this.runtime.recoverableRuns.get(workflowId),
      setRecoverableRun: this.setRecoverableRun.bind(this),

      clearRecoverableRun: this.clearRecoverableRun.bind(this),
      isStopping: () => this.runtime.stopped,
      planFailed: (record) => this.emitSessionEvent(record, { type: "dsh-codex-workflow/plan-updated",
        data: { workflowId: record.id, status: "failed", questions: record.questions, assumptions: record.assumptions,
          message: record.error } }),
    });
    this.reviewExecution = new ReviewExecution({
      store: this.store,
      config: this.config,
      runtime: this.runtime,
      reviewObservation: this.reviewObservation,
      turnGateway: this.turnGateway,
      audit: this.audit,
      trackNoChange: this.trackNoChange.bind(this),
      readFinalEvidence: (options) => collectEvidence(options),
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
      owned: this.owned.bind(this),
      errorMessage,
      createLiveRelay: this.createLiveRelay.bind(this),
      createChildSession: this.createCodexChildSessionWithLabel.bind(this),
      disposeChildSession: this.disposeCodexChildSession.bind(this),
      getRecoverableRun: (workflowId) => this.runtime.recoverableRuns.get(workflowId),
      captureThreadOwner: this.codex.captureThreadOwner?.bind(this.codex),
      interruptReviewerTurn: async (threadId, turnId, owner) => {
        this.reviewAdmission.assertOwned();
        if (!this.originalThreadAvailable(threadId, owner)) return false;
        return (await this.boundedCleanup("Reviewer turn interruption", () => this.turnGateway.interrupt(threadId, turnId, undefined, owner))) === undefined;
      },
      confirmAuxiliaryTurns: this.confirmAuxiliaryTurns.bind(this),
      confirmReviewerTerminalCleanup: this.confirmTerminalCleanup.bind(this),
      isTerminalCleanupConfirmed: (record) => record.retryState?.terminalCleanup?.sessionId === record.dshSessionId
        && this.terminalCleanupGuard.isConfirmed(record.id, record.retryState.terminalCleanup),
      setRecoverableRun: this.setRecoverableRun.bind(this),

      clearRecoverableRun: this.clearRecoverableRun.bind(this),
      isStopping: () => this.runtime.stopped,
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
      assertAuxiliaryTurnsEnded: this.assertAuxiliaryTurnsEnded.bind(this),
      isSubmissionLeaseOwner: (workflowId, submissionId, lease) => this.store.coordinationHandle
        .isLeaseOwner(`submission:${workflowId}:${submissionId}`, lease.epoch, lease.owner),
      errorMessage,
      createLiveRelay: this.createLiveRelay.bind(this),
      disposeChildSession: this.disposeCodexChildSession.bind(this),
      bindUsage: (workflowId, threadId, stage, model, owner) => this.usageObserver.bind(workflowId, threadId, stage, model, undefined, owner),
      releaseUsage: (workflowId, threadId, owner) => this.usageObserver.releaseOwned(threadId, owner, workflowId),
      retainCallbackCleanup: this.retainCallbackCleanup.bind(this),
      releaseCallbackCleanup: this.releaseCallbackCleanup.bind(this),
    });
    this.lifecycleExecution = new LifecycleExecution({
      store: this.store,
      runtime: this.runtime,
      captureThreadOwner: this.codex.captureThreadOwner?.bind(this.codex),
      isPlannerStarting: (id) => this.plannerExecution.isStarting(id),
      confirmTerminalCleanup: this.confirmTerminalCleanup.bind(this),
      releaseTerminalCleanupGuard: (id, marker) => marker
        ? this.terminalCleanupGuard.release(id, marker) : this.releaseCallbackCleanup(id),
      retainCallbackCleanup: this.retainCallbackCleanup.bind(this),
      reviewObservation: this.reviewObservation,
      turnGateway: this.turnGateway,
      releaseRetainedThread: (threadId, owner) => this.releaseUnboundReviewer(threadId, undefined, owner),
      interruptRetainedTurn: (threadId, turnId, owner) => this.boundedCleanup("Planner input interruption",
        () => this.turnGateway.interrupt(threadId, turnId, undefined, owner)),
      cleanupAuxiliaryTurns: this.cleanupAuxiliaryTurns.bind(this),
      flushUsage: this.usageObserver.flush.bind(this.usageObserver),
      stopUsage: this.usageObserver.stop.bind(this.usageObserver),
      usagePersistenceError: this.usageObserver.getPersistenceError.bind(this.usageObserver),
      readReviewEvidence: (record, recovery) => collectEvidence({
        cwd: record.cwd,
        maxDiffBytes: this.config.reviewDiffMaxBytes,
        changedFiles: recovery.input?.changedFiles,
      }),
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
    return this.withObservedUsage(this.plannerFlow.start(args, exec), exec);
  }

  async continue(workflowId: string, answers: Record<string, string[]>, exec: ToolRunContext): Promise<WorkflowRecord> {
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    exec.signal.throwIfAborted();
    const record = await this.owned(workflowId, exec);
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    const submitted = Object.fromEntries(Object.keys(answers).sort().map((id) => [id, [...answers[id]!]]));
    const identity = JSON.stringify(submitted);
    const flight = this.runtime.inputFlights.get(workflowId);
    if (flight) {
      if (this.runtime.inputAnswers.get(workflowId) !== identity) {
        throw new Error(`workflow ${workflowId} is already answering different planner input; wait for it to finish`);
      }
      return flight;
    }
    // The legacy failure branch still delegates to the shared resume admission.
    if (record.phase !== "waiting_input") {
      return this.withObservedUsage(this.plannerFlow.continue(workflowId, submitted, exec), exec);
    }
    const input = this.runtime.plannerInputs.get(workflowId);
    if (!input) throw new Error(`workflow ${workflowId} has no in-process original Planner clarification; no replacement will be started`);
    if (!this.originalThreadAvailable(input.threadId, input.threadOwner)) {
      throw new Error(`workflow ${workflowId} has lost its original Planner thread; no replacement will be started`);
    }
    assertPlannerRun(input.plannerIdentity, record, "waiting_input");
    const controller = new AbortController();
    const signal = AbortSignal.any([exec.signal, controller.signal, this.runtime.lifecycleController.signal]);
    const inputExec = Object.assign(Object.create(exec), { signal }) as ToolRunContext;
    const task = this.withObservedUsage(Promise.resolve().then(() => this.plannerFlow.continue(workflowId, submitted, inputExec)), exec);
    this.runtime.inputControllers.set(workflowId, controller);
    this.runtime.inputAnswers.set(workflowId, identity);
    this.runtime.inputFlights.set(workflowId, task);
    void task.finally(() => {
      if (this.runtime.inputFlights.get(workflowId) === task) this.runtime.inputFlights.delete(workflowId);
      if (this.runtime.inputControllers.get(workflowId) === controller) this.runtime.inputControllers.delete(workflowId);
      if (!this.runtime.inputFlights.has(workflowId)) this.runtime.inputAnswers.delete(workflowId);
    }).catch(() => undefined);
    return task;
  }

  async resume(workflowId: string | undefined, instruction: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord> {
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    const owner = requireAgent(exec).id;
    const retainedId = [...this.runtime.recoverableRuns].find(([, run]) => (run.terminalFailure || run.pendingStart)
      && (run.plannerIdentity?.dshSessionId ?? run.reviewerIdentity?.dshSessionId) === owner)?.[0];
    const id = workflowId ?? (await this.store.activeForSession(owner))?.id ?? retainedId;
    if (!id) throw new Error("no active Codex workflow for this session");
    // Authorize before joining a flight: another session must never receive its
    // result or mutate the retained Reviewer even if it knows the workflow id.
    const originalRecovery = this.runtime.recoverableRuns.get(id);
    const cleanupOnly = Boolean(originalRecovery?.terminalFailure && originalRecovery.state.awaitingCleanup
      || originalRecovery?.pendingStart && originalRecovery.pendingStartIntent);
    const originalOwner = originalRecovery?.plannerIdentity?.dshSessionId ?? originalRecovery?.reviewerIdentity?.dshSessionId;
    if (cleanupOnly && originalOwner !== owner) throw new Error("workflow belongs to another DSH session");
    const record = cleanupOnly ? await this.store.load(id) : await this.owned(id, exec);
    if (!record) throw new Error(`unknown workflow ${id}`);
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    if (record.phase === "cancelled" && !cleanupOnly) throw new Error(`workflow ${id} is cancelled`);
    const requestInstruction = instruction ?? "";
    const flight = this.runtime.resumeFlights.get(id);
    if (flight) {
      if (this.runtime.resumeInstructions.get(id) !== requestInstruction) {
        throw new Error(`workflow ${id} is already continuing with a different instruction; wait for it to finish`);
      }
      return flight;
    }
    const recovery = this.runtime.recoverableRuns.get(id);
    if (!recovery || !cleanupOnly && (record.processState !== "waiting" || !record.retryState?.awaitingContinuation)) {
      throw new Error(`workflow ${id} has no in-process continuation; restart cannot recover its ephemeral thread`);
    }
    if (!cleanupOnly && !this.originalThreadAvailable(recovery.threadId, recovery.threadOwner)) {
      throw new Error(`workflow ${id} has lost its original ephemeral thread; no replacement will be started`);
    }
    if (!cleanupOnly && recovery.state.stage === "planning") {
      if (!recovery.plannerIdentity) throw new Error("original Planner identity is unavailable; no replacement will be started");
      assertPlannerRun(recovery.plannerIdentity, record);
    } else if (!cleanupOnly) {
      if (!recovery.reviewerIdentity) throw new Error("original Reviewer identity is unavailable; no replacement will be started");
      if (!recovery.reviewerSettings) throw new Error("original Reviewer settings are unavailable; no replacement will be started");
      assertReviewerRecovery(recovery.reviewerIdentity, record);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([exec.signal, controller.signal, this.runtime.lifecycleController.signal]);
    const resumeExec = Object.assign(Object.create(exec), { signal }) as ToolRunContext;
    this.runtime.resumeControllers.set(id, controller);
    this.runtime.resumeInstructions.set(id, requestInstruction);
    const task = this.withObservedUsage(Promise.resolve().then(() => recovery.state.stage === "planning"
      ? this.plannerExecution.resume(id, instruction ?? "请在当前会话中继续完成原任务，不要重新开始。", resumeExec)
      : this.resumeReviewerWithAdmission(id, instruction ?? "请在当前 Reviewer 会话中继续完成本轮审查，不要创建新的 Reviewer。", resumeExec, controller)), exec);
    this.runtime.resumeFlights.set(id, task);
    this.trackForeground(task);
    void task.finally(() => {
      if (this.runtime.resumeFlights.get(id) === task) this.runtime.resumeFlights.delete(id);
      if (this.runtime.resumeControllers.get(id) === controller) this.runtime.resumeControllers.delete(id);
      if (!this.runtime.resumeFlights.has(id)) this.runtime.resumeInstructions.delete(id);
    }).catch(() => undefined);
    return task;
  }

  /** Original-thread continuation has the same cross-manager write authority
   * as a new review. An admitted review's recovery reuses its existing fence. */
  private async resumeReviewerWithAdmission(workflowId: string, instruction: string,
    exec: ToolRunContext, controller: AbortController): Promise<WorkflowRecord> {
    exec.signal.throwIfAborted();
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    if (this.reviewAdmission.owns(workflowId)) return this.reviewExecution.resume(workflowId, instruction, exec);
    const resource = `review:${workflowId}`;
    const lease = await this.acquireLease(resource);
    if (!lease) throw new Error(`workflow ${workflowId} already has an admitted review in another manager`);
    lease.heartbeat(this.leaseTtlMs / 3, () => controller.abort(new Error(`workflow ${workflowId} lost its review admission lease`)));
    try {
      return await this.reviewAdmission.run(workflowId, resource, lease, this.store.coordinationHandle, controller, async () => {
        exec.signal.throwIfAborted();
        if (this.runtime.stopped) throw new Error("workflow manager is stopped");
        this.reviewAdmission.assertOwned();
        return this.reviewExecution.resume(workflowId, instruction, exec);
      });
    } finally {
      lease.stopHeartbeat();
      await lease.release().catch(() => undefined);
    }
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

  review(workflowId: string, input: ReviewRequestInput, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.withObservedUsage(this.reviewFlow.review(workflowId, input, exec), exec);
  }

  reviewOnly(args: { task?: string; implementationSummary: string; changedFiles?: string[]; testResults?: string; reviewerModel?: string; reviewerEffort?: WorkflowConfig["reviewerEffort"] }, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.withObservedUsage(this.reviewFlow.reviewOnly(args, exec), exec);
  }

  /** Finish metering after flow cleanup without changing its business result. */
  private withObservedUsage(task: Promise<WorkflowRecord>, exec: ToolRunContext): Promise<WorkflowRecord> {
    const callerSessionId = requireAgent(exec).id;
    return this.trackForeground(task.then(async (record) => {
      if (record.dshSessionId !== callerSessionId) throw new Error("workflow belongs to another DSH session");
      await this.usageObserver.flush(record.id);
      // A provider may send usage after the business commit but before release.
      // Keep the operation's phase/result; refresh only this owner's counters.
      const latest = await this.store.load(record.id).catch(() => undefined);
      if (!latest?.observedUsage || latest.dshSessionId !== record.dshSessionId) return record;
      return { ...record, observedUsage: latest.observedUsage };
    }));
  }

  applyExternalVerdict(command: SubmitVerdictCommand): Promise<WorkflowRecord> {
    return this.reviewFlow.applyExternalVerdict(command);
  }

  assertVerdictStillValid(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }> {
    return this.reviewFlow.assertVerdictStillValid(command);
  }

  submit(workflowId: string, input: SubmitInput, exec: ToolRunContext): Promise<WorkflowRecord> {
    const signal = AbortSignal.any([exec.signal, this.runtime.lifecycleController.signal]);
    const submissionExec = Object.assign(Object.create(exec), { signal }) as ToolRunContext;
    return this.trackForeground(this.submissionFlow.submit(workflowId, input, submissionExec));
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

  status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowStatus> {
    return this.reviewAdmission.without(() => this.lifecycleFlow.status(workflowId, exec));
  }

  cancel(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.reviewAdmission.without(() => this.lifecycleFlow.cancel(workflowId, exec));
  }

  stop(): Promise<void> {
    return this.reviewAdmission.without(() => this.lifecycleFlow.stop());
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
    beforeAttempt?: () => Promise<void>,
  ): Promise<TurnWaitResult> {
    return this.retryTransientTurn(
      async () => {
        if (beforeAttempt) await beforeAttempt();
        this.reviewAdmission.assertOwned();
        return this.turnGateway.startTurn(threadId, options, signal);
      },
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
      () => { this.reviewAdmission.assertOwned(); return this.turnGateway.startReview(options, signal); },
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
      signal?.throwIfAborted();
      if (this.retryNow() >= deadline) return outcome;
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
    let threadOwner: object | undefined;
    try {
      return await this.retryTransientControl(async () => {
        this.reviewAdmission.assertOwned();
        if (!threadId) {
          threadId = await this.reviewerGateway.startShell({ ...options, ephemeral: true }, signal)
            ?? await this.reviewerGateway.start({ ...options, ephemeral: true }, signal);
          threadOwner = this.codex.captureThreadOwner?.(threadId);
        }
        if (!this.originalThreadAvailable(threadId, threadOwner)) throw new Error("original Reviewer creation transport is unavailable");
        const configured = this.reviewerGateway.configure(threadId, { ...options, ...(threadOwner ? { expectedOwner: threadOwner } : {}) }, signal);
        if (configured) await configured;
        if (options.workflowId) await this.usageObserver.bind(options.workflowId, threadId, "reviewing", options.model, undefined, threadOwner);
        if (!this.originalThreadAvailable(threadId, threadOwner)) throw new Error("original Reviewer creation transport is unavailable");
        return threadId;
      }, signal);
    } catch (error) {
      if (threadId) this.reportCleanupNote(options.workflowId, await this.releaseUnboundReviewer(threadId, signal, threadOwner));
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
    queuedHeartbeat?: NodeJS.Timeout,
  ): void {
    const key = this.submissionTaskKey(workflowId, submissionId);
    const controller = new AbortController();
    this.runtime.submissionControllers.set(key, controller);
    const task = this.runSubmissionCallback(workflowId, submissionId, prompt, seed, controller.signal, lease)
      .catch(() => undefined)
      .finally(async () => {
        this.reviewObservation.stopHeartbeat(workflowId, queuedHeartbeat);
        await this.releaseSubmissionFence(workflowId, submissionId, seed, lease);
        if (this.runtime.submissionControllers.get(key) === controller) {
          this.runtime.submissionControllers.delete(key);
        }
      });
    this.trackBackground(task);
  }

  private async releaseSubmissionFence(workflowId: string, submissionId: string, seed: WorkflowRecord, lease: ManagerLease): Promise<void> {
    lease.stopHeartbeat();
    if (!await lease.release().catch(() => false)) return;
    await this.store.update(workflowId, (record) => {
      const released = this.store.coordinationHandle.leaseInfo(`submission:${workflowId}:${submissionId}`);
      // Release preserves the epoch row. A later acquire increments it, so a
      // successor claiming between release and this transaction fences us out.
      if (!released || released.epoch !== lease.epoch || released.owner !== "" || released.leaseUntil !== 0
        || record.submissionId !== submissionId || record.submissionLeaseToken !== lease.owner
        || record.submissionLeaseEpoch !== lease.epoch || record.dshSessionId !== seed.dshSessionId
        || record.cwd !== seed.cwd || record.createdAt !== seed.createdAt || record.task !== seed.task
        || record.mode !== seed.mode || record.origin !== seed.origin || record.codexThreadId !== seed.codexThreadId
        || record.reviewerModel !== seed.reviewerModel || record.reviewerEffort !== seed.reviewerEffort) {
        throw new Error("submission lease cleanup no longer owns this record or released generation");
      }
      record.submissionLeaseToken = undefined;
      record.submissionLeaseEpoch = undefined;
      record.submissionLeaseUntil = undefined;
    }, { ignoreCancelled: true }).catch(() => undefined);
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
    const sessionId = agent.id;
    const lease = await this.acquireWorkflowCreateLease(sessionId);
    if (!lease) {
      throw new Error(`session ${agent.id} is already creating a Codex workflow`);
    }
    try {
      const existing = await this.store.byBridgeRequest(command.requestId);
      if (existing) return existing; // idempotent dispatch replay
      await this.assertNoActiveWorkflow(sessionId);
      if (!await lease.renew()) throw new Error(`session ${sessionId} lost its workflow creation lease`);
      if (this.runtime.stopped) throw new Error("workflow manager is stopped");
      if (agent.id !== sessionId) throw new Error("workflow creation session owner changed during cleanup admission");
      const now = new Date().toISOString();
      const record: WorkflowRecord = {
        schemaVersion: 1,
        id: randomUUID(),
        dshSessionId: sessionId,
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

  private async continueInternal(
    workflowId: string,
    answers: Record<string, string[]>,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.processState === "waiting" && record.retryState?.stage === "planning") {
      return this.resume(workflowId, undefined, exec);
    }
    return this.plannerExecution.continue(workflowId, answers, exec);
  }

  /** Foreground tool flow: tracked so teardown interrupts and awaits it. */
  private async reviewInternal(
    workflowId: string,
    input: ReviewRequestInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    return this.admitReview(workflowId, input, exec);
  }

  private async admitReview(workflowId: string, input: ReviewRequestInput, exec: ToolRunContext, initialRecord?: WorkflowRecord): Promise<WorkflowRecord> {
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    if (input.newReviewRound !== undefined && typeof input.newReviewRound !== "boolean") {
      throw new Error("newReviewRound must be a boolean");
    }
    const newReviewRound = input.newReviewRound === true;
    // Ownership must be checked before a duplicate joins an admitted result.
    let target = await this.owned(workflowId, exec);
    const targetBeforeCleanup = target;
    await this.terminalCleanupGuard.assertAvailable(undefined, workflowId);
    target = await this.owned(workflowId, exec);
    this.assertReviewScope(targetBeforeCleanup, target);
    const scope = initialRecord ?? target;
    this.assertReviewScope(scope, target);
    if (target.phase === "cancelled") return target;
    if ((target.reviewAttempt ?? 0) !== (scope.reviewAttempt ?? 0)) throw new Error(`workflow ${workflowId} changed its original review attempt`);
    if (target.origin === "codex_bridge") {
      throw new Error(`workflow ${workflowId} is a Codex-bridge workflow; use codex_workflow_submit and its original background review instead of starting a foreground Reviewer`);
    }
    if (!this.runtime.recoverableRuns.get(workflowId)?.reviewCheckpoint) this.assertAuxiliaryTurnsEnded(workflowId);
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    exec.signal.throwIfAborted();
    const request: ReviewInput = {
      implementationSummary: input.implementationSummary,
      ...(input.changedFiles ? { changedFiles: [...input.changedFiles] } : {}),
      ...(input.testResults !== undefined ? { testResults: input.testResults } : {}),
    };
    const materialIdentity = JSON.stringify(request);
    const identity = JSON.stringify({ material: request, newReviewRound });
    const existing = this.runtime.reviewFlights.get(workflowId);
    if (existing) {
      if (this.runtime.reviewInputs.get(workflowId) !== identity) {
        throw new Error(`workflow ${workflowId} already has an admitted review with different input`);
      }
      return existing;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([exec.signal, controller.signal, this.runtime.lifecycleController.signal]);
    const reviewExec = Object.assign(Object.create(exec), { signal }) as ToolRunContext;
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const resource = `review:${workflowId}`;
      const lease = await this.acquireLease(resource);
      if (!lease) throw new Error(`workflow ${workflowId} already has an admitted review in another manager`);
      lease.heartbeat(this.leaseTtlMs / 3, () => controller.abort(new Error(`workflow ${workflowId} lost its review admission lease`)));
      try {
        return await this.reviewAdmission.run(workflowId, resource, lease, this.store.coordinationHandle, controller, async () => {
          let record = await this.owned(workflowId, reviewExec);
          this.assertReviewScope(scope, record);
          if (record.phase === "cancelled") return record;
          if ((record.reviewAttempt ?? 0) !== (scope.reviewAttempt ?? 0)) throw new Error(`workflow ${workflowId} changed its original review attempt`);
          signal.throwIfAborted();
          if (this.runtime.stopped) throw new Error("workflow manager is stopped");
          this.reviewAdmission.assertOwned();
          if (record.origin === "codex_bridge") {
            throw new Error(`workflow ${workflowId} is a Codex-bridge workflow; use codex_workflow_submit and its original background review instead of starting a foreground Reviewer`);
          }
          if (!this.runtime.recoverableRuns.get(workflowId)?.reviewCheckpoint) this.assertAuxiliaryTurnsEnded(workflowId);
          if ((record.retryState?.stage === "reviewing" && record.processState === "waiting")
            || record.reviewFailureReason !== undefined) {
            const freshRound = await this.reviewExecution.prepareNewReviewAfterWorkspaceChange(workflowId, reviewExec, newReviewRound);
            if (freshRound) {
              record = await this.owned(workflowId, reviewExec);
              this.assertReviewScope(scope, record);
              if (record.phase === "cancelled") return record;
              signal.throwIfAborted();
              this.reviewAdmission.assertOwned();
            } else {
              if (record.reviewFailureReason) {
                throw new Error(`${record.reviewFailureReason === "review_contract_conflict" ? "Reviewer contract remains unresolved" : "original Reviewer is unavailable"}; unchanged evidence requires an explicitly requested independent review round`);
              }
              const recovery = this.runtime.recoverableRuns.get(workflowId);
              if (recovery?.input && JSON.stringify({
                implementationSummary: recovery.input.implementationSummary,
                ...(recovery.input.changedFiles ? { changedFiles: [...recovery.input.changedFiles] } : {}),
                ...(recovery.input.testResults !== undefined ? { testResults: recovery.input.testResults } : {}),
              }) !== materialIdentity) throw new Error(`workflow ${workflowId} has a waiting Reviewer with different input; resume the original review`);
              return this.resume(workflowId, undefined, reviewExec);
            }
          }
          if (record.phase !== "executing" && record.phase !== "fixing") {
            throw new Error(`workflow ${workflowId} cannot be reviewed from phase ${record.phase}`);
          }
          if (record.reviewCycles >= this.config.maxReviewCycles) {
            throw new Error(`workflow ${workflowId} reached its review cycle limit of ${this.config.maxReviewCycles}`);
          }
          if (record.mode !== "review_only" && !record.planMarkdown) throw new Error(`workflow ${workflowId} has no completed plan`);
          return this.reviewOnce(workflowId, request, reviewExec, scope);
        });
      } finally {
        lease.stopHeartbeat();
        await lease.release().catch(() => undefined);
      }
    });
    this.runtime.reviewInputs.set(workflowId, identity);
    this.runtime.reviewControllers.set(workflowId, controller);
    this.runtime.reviewFlights.set(workflowId, task);
    this.trackForeground(task);
    void task.finally(() => {
      if (this.runtime.reviewFlights.get(workflowId) === task) this.runtime.reviewFlights.delete(workflowId);
      if (this.runtime.reviewControllers.get(workflowId) === controller) this.runtime.reviewControllers.delete(workflowId);
      if (!this.runtime.reviewFlights.has(workflowId)) this.runtime.reviewInputs.delete(workflowId);
    }).catch(() => undefined);
    return task;
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
    input: SubmitInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    if (input.newReviewRound !== undefined && typeof input.newReviewRound !== "boolean") {
      throw new Error("newReviewRound must be a boolean");
    }
    const newReviewRound = input.newReviewRound === true;
    const request: ReviewInput = structuredClone({ implementationSummary: input.implementationSummary,
      ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}),
      ...(input.testResults !== undefined ? { testResults: input.testResults } : {}) });
    const record = await this.owned(workflowId, exec);
    if (record.origin !== "codex_bridge") {
      throw new Error(`workflow ${workflowId} is not a Codex-bridge workflow; use codex_workflow_review instead`);
    }
    await this.terminalCleanupGuard.assertAvailable(undefined, workflowId);
    const recordAfterCleanup = await this.owned(workflowId, exec);
    if (submissionReviewIdentity(recordAfterCleanup, "") !== submissionReviewIdentity(record, "")) {
      throw new Error(`workflow ${workflowId} changed before submission admission`);
    }
    if (this.callback?.hasPendingTerminalCleanup?.(workflowId)) {
      throw new Error("original terminal Reviewer cleanup is pending; retry the original submission cleanup before a new round");
    }
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be submitted from phase ${record.phase}`);
    }
    if (!record.codexThreadId) throw new Error(`workflow ${workflowId} has no Codex thread to resume`);
    if (!this.callback) throw new Error("Codex callback dispatcher is not available");
    const identity = submissionReviewIdentity(record, "");
    const unavailable = originalBridgeResourceUnavailable(record);
    const assertAdmission = (current: WorkflowRecord): void => {
      if (current.dshSessionId !== record.dshSessionId) throw new Error("workflow belongs to another DSH session");
      if (current.origin !== "codex_bridge") throw new Error(`workflow ${workflowId} is not a Codex-bridge workflow`);
      if (current.phase !== "executing" && current.phase !== "fixing") {
        throw new Error(`workflow ${workflowId} cannot be submitted from phase ${current.phase}`);
      }
      if (current.submissionId && submissionActive(current.submissionState)) {
        throw new Error(`workflow ${workflowId} already has an active submission ${current.submissionId}`);
      }
      if (submissionReviewIdentity(current, "") !== identity) throw new Error("workflow submission context changed during evidence admission");
      if (originalBridgeResourceUnavailable(current) !== unavailable
        || (unavailable && (current.submissionCallbackReason !== record.submissionCallbackReason
          || current.submissionError !== record.submissionError))) {
        throw new Error("workflow original Reviewer recovery state changed during submission admission");
      }
      if (this.runtime.stopped) throw new Error("workflow manager is stopped");
      exec.signal.throwIfAborted();
    };
    assertAdmission(record);

    const evidence = await collectEvidence({
      cwd: record.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: request.changedFiles,
    });
    assertAdmission(await this.owned(workflowId, exec));
    // An unverifiable workspace must never enter the review pipeline: an
    // empty fingerprint would let a later "pass" ride on nothing.
    if (evidence.insufficient || !evidence.fingerprint) {
      throw new Error(
        "submit requires observable changed files inside the workspace: provide non-empty, cwd-contained, readable changedFiles (non-git workspace) or run inside a git repository",
      );
    }
    // A different requested file selection is new scope, not proof that the
    // original reviewed workspace changed. Re-observe the original selection
    // before allowing an automatic new business round after resource loss.
    const recoveryEvidence = unavailable && !newReviewRound && record.pendingReviewRequest
      ? await collectEvidence({ cwd: record.cwd, maxDiffBytes: this.config.reviewDiffMaxBytes,
        changedFiles: record.pendingReviewRequest.changedFiles }) : evidence;
    assertAdmission(await this.owned(workflowId, exec));
    assertSubmissionReviewRound(record, recoveryEvidence, newReviewRound);

    // Workflow-scoped lease BEFORE generating the submissionId: two processes
    // can never both create an active submission for the same workflow.
    const submitLease = await this.acquireWorkflowSubmitLease(workflowId);
    if (!submitLease) throw new Error(`workflow ${workflowId} is being submitted by another process`);
    let submissionId: string | undefined;
    let lease: ManagerLease | undefined;
    let leaseTransferred = false;
    let submitReleased = false;
    let child: CodexChildSessionHandle | undefined;
    let queuedHeartbeat: NodeJS.Timeout | undefined;
    try {
      assertAdmission(await this.owned(workflowId, exec));
      submissionId = randomUUID();
      lease = await this.acquireSubmissionLease(workflowId, submissionId);
      if (!lease) throw new Error(`submission ${submissionId} is claimed by another process`);
      const prepared = await this.store.update(workflowId, (r) => {
        assertAdmission(r);
        assertSubmissionReviewRound(r, recoveryEvidence, newReviewRound);
        r.pendingReviewRequest = request;
        r.latestReviewEvidence = evidence;
        // reviewCycles is NOT incremented here: a review cycle only counts a
        // STRUCTURED VERDICT successfully received/applied, never an attempt
        // (busy/timeout/invalid-thread/infra failures keep the submission
        // retryable without consuming a cycle).
        r.submissionId = submissionId;
        r.submissionState = "queued";
        r.submissionAttempts = 0;
        r.submissionReviewPending = undefined;
        r.submissionError = undefined;
        r.submissionCallbackReason = undefined;
        r.submissionRetryAt = undefined;
        r.submissionNotice = undefined;
        r.submissionLeaseToken = lease!.owner;
        r.submissionLeaseEpoch = lease!.epoch;
        r.submissionLeaseUntil = Date.now() + this.leaseTtlMs;
        r.callbackState = "queued"; // legacy mirror
        r.callbackError = undefined;
      }, { ignoreCancelled: false });
      if (prepared.suppressed) return prepared.record;
      const preparedIdentity = submissionReviewIdentity(prepared.record, "");
      const startupController = new AbortController();
      const startupSignal = AbortSignal.any([this.runtime.lifecycleController.signal, startupController.signal]);
      // A durable submission outlives the caller's tool wait. Teardown,
      // explicit cancellation and lease loss still prevent model startup.
      const startupExec = Object.assign(Object.create(exec), { signal: startupSignal }) as ToolRunContext;
      const canAdopt = (current: WorkflowRecord): boolean => !this.runtime.stopped && !startupSignal.aborted
        && current.phase !== "cancelled" && current.submissionState === "queued"
        && current.submissionId === submissionId && current.submissionLeaseToken === lease!.owner
        && current.submissionLeaseEpoch === lease!.epoch && submissionReviewIdentity(current, "") === preparedIdentity
        && this.store.coordinationHandle.isLeaseOwner(`submission:${workflowId}:${submissionId}`, lease!.epoch, lease!.owner);
      const assertPrepared = async (): Promise<void> => {
        const current = await this.owned(workflowId, startupExec);
        if (!canAdopt(current)) throw new Error("prepared submission no longer owns child startup");
      };
      lease.heartbeat(this.leaseTtlMs / 3, () => startupController.abort(new Error("submission startup lease was lost")));
      // The workflow-scoped fence has done its job (one active submission is
      // now durably persisted); release it before the long callback runs.
      await submitLease.release();
      submitReleased = true;
      await assertPrepared();
      child = await this.createCodexChildSessionWithLabel(prepared.record, startupExec, `Codex Reviewer · ${workflowId}`, assertPrepared);
      await assertPrepared();
      const observing = await this.reviewObservation.begin(workflowId, {
        enterReviewing: false,
        step: "reviewing",
        message: "Review queued; waiting for Reviewer",
        childSessionId: child?.id,
        guard: canAdopt,
      });
      if (observing.suppressed) return observing.record;
      queuedHeartbeat = this.reviewObservation.startHeartbeat(workflowId, canAdopt);
      await assertPrepared();
      const prompt = callbackPrompt(prepared.record, request, evidence);
      this.startSubmissionTask(workflowId, submissionId, prompt, observing.record, lease, queuedHeartbeat);
      leaseTransferred = true;
      return prepared.record;
    } catch (error) {
      const current = await this.owned(workflowId, exec);
      if (current.phase === "cancelled") return current;
      throw error;
    } finally {
      try {
        if (!leaseTransferred && child) {
          try { child.finish("Codex child startup was not admitted.", "aborted"); }
          finally { await this.disposeCodexChildSession(workflowId, child); }
        }
      } finally {
        try {
          if (!leaseTransferred) this.reviewObservation.stopHeartbeat(workflowId, queuedHeartbeat);
          if (lease && submissionId && !leaseTransferred) {
            lease.stopHeartbeat();
            await lease.release().catch(() => undefined);
            const leaseOwner = lease.owner;
            const sid = submissionId;
            // Clear only this startup's record fence; cleanup failure cannot
            // strand either acquired lease or mutate a replacement's record.
            await this.store.update(workflowId, (r) => {
              if (r.submissionId !== sid || r.submissionLeaseToken !== leaseOwner
                || r.submissionLeaseEpoch !== lease!.epoch || r.dshSessionId !== record.dshSessionId
                || r.cwd !== record.cwd || r.createdAt !== record.createdAt) throw new Error("unadmitted submission cleanup no longer owns this record");
              r.submissionLeaseToken = undefined;
              r.submissionLeaseEpoch = undefined;
              r.submissionLeaseUntil = undefined;
            }, { ignoreCancelled: true }).catch(() => undefined);
          }
        } finally {
          if (!submitReleased) await submitLease.release().catch(() => undefined);
        }
      }
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
      // DSH 0.1.7 host compatibility patch accepts this marker for
      // informational plugin events, so older readers can skip them safely.
      const append = agent.session.append as unknown as (
        type: string,
        data: unknown,
        options: { ignorable: true },
      ) => unknown;
      const data = event.type === "dsh-codex-workflow/plan-updated" ? { ...event.data,
        processState: event.data.processState ?? (event.data.status === "planning" ? record.processState ?? "running"
          : event.data.status === "failed" && record.processState === "waiting" ? "waiting"
            : ({ planning: "running", waiting_input: "waiting", ready: "completed", failed: "failed" } as const)[event.data.status]) }
        : event.data;
      if (this.codexChildFactory?.usesExternalUiState) {
        // V4 accepts only the host's released event vocabulary. Keep plugin UI
        // state in our own database so a cold host can always reopen its log.
        this.store.appendUiEvent(record.dshSessionId, { ...event, data } as CodexWorkflowSessionEvent);
      } else {
        append.call(agent.session, event.type, data, { ignorable: true });
      }
    } catch {
      // A session can be disposing while a background callback settles. The
      // coordination record remains authoritative and will be shown on reload.
    }
  }
  private createLiveRelay(record: WorkflowRecord, stage: "planning" | "reviewing", reviewId?: string, canPublish?: () => boolean): LiveRelay {
    return new LiveRelay(record.id, stage, reviewId, (event) => {
      if (!canPublish || canPublish()) this.emitSessionEvent(record, event);
    });
  }

  private async createCodexChildSession(record: WorkflowRecord, exec: ToolRunContext): Promise<CodexChildSessionHandle | undefined> {
    return this.createCodexChildSessionWithLabel(record, exec, `Codex Planner · ${record.id}`);
  }

  private async createCodexChildSessionWithLabel(record: WorkflowRecord, exec: ToolRunContext, label: string,
    assertAdoption?: () => Promise<void>): Promise<CodexChildSessionHandle | undefined> {
    this.reviewAdmission.assertOwned();
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    exec.signal.throwIfAborted();
    if (assertAdoption) await assertAdoption();
    if (!this.codexChildFactory) return undefined;
    const parent = requireAgent(exec);
    const previous = this.runtime.codexChildSessions.get(record.id);
    // A retained conversation outlives one tool call. Its owning manager,
    // cancel path and execution cleanup determine the child's lifetime.
    const child = await this.codexChildFactory.create(parent, record.cwd, label, record.task, this.runtime.lifecycleController.signal);
    try {
      if (this.runtime.stopped) throw new Error("workflow manager is stopped");
      exec.signal.throwIfAborted();
      this.reviewAdmission.assertOwned();
      if (assertAdoption) await assertAdoption();
      if (this.runtime.codexChildSessions.get(record.id) !== previous) throw new Error("Codex child ownership changed during creation");
      this.runtime.codexChildSessions.set(record.id, child);
      return child;
    } catch (error) {
      try { child.finish("Codex child startup was not admitted.", "aborted"); }
      finally { await this.disposeCodexChildSession(record.id, child); }
      throw error;
    }
  }

  private async disposeCodexChildSession(workflowId: string, child: CodexChildSessionHandle | undefined): Promise<void> {
    if (!child || this.runtime.disposingChildren.has(child)) return;
    this.runtime.disposingChildren.add(child);
    if (this.runtime.codexChildSessions.get(workflowId) === child) this.runtime.codexChildSessions.delete(workflowId);
    await child.dispose();
  }
  private async stageSubmissionFailure(
    updateCurrent: (fn: (record: WorkflowRecord) => void) => Promise<WorkflowRecord>,
    workflowId: string,
    submissionId: string,
    message: string,
    reason?: string,
  ): Promise<WorkflowRecord> {
    return updateCurrent((r) => {
      r.submissionState = "failed";
      r.submissionReviewPending = undefined;
      r.submissionError = message;
      r.submissionCallbackReason = reason;
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
            return this.releaseSubmissionFence(seed.id, submissionId, seed, lease);
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
   * Review-only entry persists a retryable workflow before review admission;
   * it never runs a Planner. New rounds and original-thread continuation use
   * the same evidence, decision, no-change and cycle-limit pipeline as review.
   */
  /** Foreground tool flow: tracked so teardown interrupts and awaits it. */
  private async reviewOnlyInternal(
    args: Parameters<WorkflowManager["reviewOnly"]>[0],
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    const signal = AbortSignal.any([exec.signal, this.runtime.lifecycleController.signal]);
    const reviewExec = Object.assign(Object.create(exec), { signal }) as ToolRunContext;
    return this.trackForeground(Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.createReviewOnly(args, reviewExec);
    }));
  }

  private async createReviewOnly(args: Parameters<WorkflowManager["reviewOnly"]>[0], exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    const sessionId = agent.id;
    await this.assertNoActiveWorkflow(sessionId);
    exec.signal.throwIfAborted();
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
    exec.signal.throwIfAborted();
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      dshSessionId: sessionId,
      cwd,
      task: (args.task ?? "").trim(),
      mode: "review_only",
      // Reviewing begins only after actual execution owns its observation.
      phase: "executing",
      createdAt: now,
      updatedAt: now,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
      reviewerModel,
      reviewerEffort: args.reviewerEffort ?? this.config.reviewerEffort,
    };
    try {
      const createLease = await this.acquireWorkflowCreateLease(sessionId);
      if (!createLease) throw new Error(`session ${agent.id} is already creating a Codex workflow`);
      try {
        exec.signal.throwIfAborted();
        if (this.runtime.stopped) throw new Error("workflow manager is stopped");
        await this.assertNoActiveWorkflow(sessionId);
        if (!await createLease.renew()) throw new Error(`session ${sessionId} lost its workflow creation lease`);
        exec.signal.throwIfAborted();
        if (this.runtime.stopped) throw new Error("workflow manager is stopped");
        if (requireAgent(exec).id !== sessionId) throw new Error("workflow creation session owner changed during cleanup admission");
        await this.store.save(record);
      } finally { await createLease.release().catch(() => undefined); }
      return await this.admitReview(record.id, {
        implementationSummary: args.implementationSummary,
        ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
        ...(args.testResults ? { testResults: args.testResults } : {}),
      }, exec, record);
    } catch (error) {
      return this.finalizeReviewOnlyCreation(record, error);
    }
  }

  /** Finalize only an unadmitted creation, never another manager's review. */
  private async finalizeReviewOnlyCreation(expected: WorkflowRecord, error: unknown): Promise<WorkflowRecord> {
    const latest = await this.store.load(expected.id);
    if (!latest) throw error;
    this.assertReviewScope(expected, latest);
    if (latest.phase === "cancelled") return latest;
    if (latest.phase !== "executing" || latest.reviewAttempt || latest.processState) throw error;
    const resource = `review:${expected.id}`;
    const lease = await this.acquireLease(resource);
    // The admission loser cannot write or release the winner's state/lease.
    if (!lease) throw error;
    try {
      const outcome = await this.store.update(expected.id, (record) => {
        if (!this.store.coordinationHandle.isLeaseOwner(resource, lease.epoch, lease.owner)) throw error;
        this.assertReviewScope(expected, record);
        if (record.phase !== "executing" || record.reviewAttempt || record.processState) throw error;
        record.processState = "failed";
        record.error = errorMessage(error);
        record.lastProgressAt = new Date().toISOString();
        record.lastProgressMessage = "Review admission failed; retry this workflow explicitly";
      }, { ignoreCancelled: false });
      this.assertReviewScope(expected, outcome.record);
      if (outcome.suppressed) return outcome.record;
    } finally { await lease.release().catch(() => undefined); }
    throw error;
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

  private statusInternal(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowStatus> {
    return this.lifecycleExecution.status(workflowId, exec);
  }
  private cancelInternal(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    return this.lifecycleExecution.cancel(workflowId, exec);
  }
  private async onTurnStoppingInternal(agent: Agent, turn: number): Promise<void> {
    if (this.runtime.stopped) return;
    const record = await this.store.activeForSession(agent.id);
    if (this.runtime.stopped || !record || record.dshSessionId !== agent.id) return;
    // Turn-stop observes state; it never takes authority from an old snapshot.
    // Check the real row synchronously after the asynchronous session lookup.
    if (this.store.coordinationHandle.loadWorkflow(record.id)?.revision !== record.revision) return;
    if (record.processState === "running" || this.runtime.activeTurns.has(record.id)
      || this.runtime.resumeFlights.has(record.id) || this.runtime.inputFlights.has(record.id)
      || this.runtime.reviewFlights.has(record.id) || this.callback?.activeReview?.(record.id)
      || [...this.runtime.auxiliaryTurns.values()].some((entry) => entry.workflowId === record.id)) return;
    if (submissionActive(record.submissionState)) return;
    let message: string;
    if (record.retryState?.awaitingCleanup) {
      message = `Workflow ${record.id} terminated with ${record.retryState.terminalFailure ?? record.error ?? "its original error"}, but the original turn cleanup is unconfirmed. Query codex_workflow_status, then use codex_workflow_resume only to retry that original cleanup. No model continuation is permitted; keep the original child/thread and report the primary error after confirmation. Do not create a replacement or author a substitute plan/review.`;
    } else if (record.retryState?.awaitingStartReceipt) {
      message = `Workflow ${record.id} retains its original submitted ${record.retryState.stage === "planning" ? "Planner" : "Reviewer"} request. Query codex_workflow_status with that workflowId. For start_receipt_pending, wait for the original reply or use codex_workflow_resume only to inspect that retained operation without resending turn/start or review/start. A genuine reply makes it possible to reattach the same original turn. For start_receipt_invalid, resume may only confirm original cleanup; it cannot start a replacement. For running, wait for the existing operation. Report any lost original handle precisely. Keep the original child conversation and thread; do not author a substitute plan/review in the parent session.`;
    } else if (originalBridgeResourceUnavailable(record)) {
      message = unavailableReviewerInstruction(record.id, bridgeReviewUnavailableReason(record));
    } else if (record.processState === "waiting" && record.retryState?.awaitingContinuation
      && ((record.phase === "planning" && record.retryState.stage === "planning")
        || (["executing", "fixing"].includes(record.phase) && record.retryState.stage === "reviewing"))) {
      // The model round is unfinished; parent implementation cannot replace it.
      message = `Workflow ${record.id} is waiting for its original ${record.retryState.stage === "planning" ? "Planner" : "Reviewer"}. Call codex_workflow_status with workflowId ${record.id}. If continuation.available is true, call codex_workflow_resume on that same workflow with a short continuation instruction. For interruption_unconfirmed, resume may retry cleanup of the original turn before any model continuation. For running, wait for the existing operation; otherwise report the exact unavailable reason. Keep the original child conversation and thread; do not start a replacement or author a substitute plan/review in the parent session.`;
    } else if (record.reviewFailureReason === "review_contract_conflict") {
      message = `Workflow ${record.id} has an unresolved Reviewer contract conflict, with no accepted findings to implement. Query codex_workflow_status and report the conflict. Do not repeat unchanged material or author a substitute review. Verified changes permit a new business review; unchanged evidence requires an explicit user-requested independent review through newReviewRound=true.`;
    } else if (record.reviewFailureReason === "original_reviewer_unavailable") {
      message = `Workflow ${record.id} cannot continue its original Reviewer. Query codex_workflow_status and report its exact unavailable reason. Do not automatically repeat unchanged material, reimplement the completed work, create another review-only workflow or author a substitute review in the parent. A verified change in the original workspace scope permits a new business review; use newReviewRound=true for unchanged evidence only when the user explicitly requests an independent review.`;
    } else {
      // Clarification and review decisions remain user-owned waiting states.
      if (record.phase !== "executing" && record.phase !== "fixing") return;
      // A contract failure did not accept findings requiring code changes.
      if (record.error && /review(er)? contract (conflict|failure)/i.test(record.error)) return;
      const action = record.origin === "codex_bridge"
        ? "call codex_workflow_submit with workflowId " + record.id + ", a concise implementation summary, changed files, and test results so the originating Codex task can review the result"
        : "call codex_workflow_review with workflowId " + record.id + ", a concise implementation summary, changed files, and test results before ending this turn";
      message = record.mode === "review_only" && record.phase === "executing"
        ? `Review-only workflow ${record.id} still needs its independent review: ${action}. Use the existing implementation and review scope; do not invent implementation work, create a new workflow or replace the review with a parent-authored result.`
        : record.phase === "executing"
          ? `Workflow ${record.id} is not complete: finish implementing the approved plan, run tests, then ${action}.`
          : `Workflow ${record.id} still has review findings: finish the fixes, rerun tests, then ${action}.`;
    }
    const key = `${record.id}:${turn}`;
    if (this.runtime.nudgedTurns.has(key)) return;
    this.runtime.nudgedTurns.add(key);
    agent.steer(pluginMessage(message));
  }

  /**
   * Shared review pipeline used by both `review` and `reviewOnly`: capture
   * evidence, ensure the durable workflow task is available with the readable
   * contract + full context as AUXILIARY developer instructions, run the
   * visible review via the `review/start` CUSTOM target — Git and non-Git
   * alike — whose instructions carry the full per-round context (original
   * task, approved plan, implementation summary, changed files, test
   * results, workspace evidence), the review scope and the item-by-item
   * coverage gate, convert the readable review through a private conversion turn (in-place for ephemeral sources),
   * and apply the blocking gate, no-change termination and cycle limits.
   * Every store write goes through the atomic update primitive; any write
   * that races a cancellation is suppressed and the cancelled record is
   * returned.
   */
  private reviewOnce(workflowId: string, input: ReviewInput, exec: ToolRunContext, scope?: WorkflowRecord): Promise<WorkflowRecord> {
    return this.reviewExecution.run(workflowId, input, exec, undefined, undefined, scope);
  }
  /** 1.1.2: release the App Server hold on a Reviewer task that could NOT be
   * bound to its workflow — the binding write was suppressed by a concurrent
   * cancel, or it failed. The task itself stays in the Codex store (a thread
   * cannot be deleted); only the plugin's own subscription/writer hold is
   * released, so a cancelled round cannot leave a task loaded under it. Always
   * best-effort: the caller's original outcome must never be masked. */
  private async releaseUnboundReviewer(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<string | undefined> {
    // Cleanup is independent of the turn that failed or was cancelled: an
    // aborted business signal must never cancel the unsubscribe that releases
    // the writer hold.
    void signal;
    return this.releaseReviewerHold(threadId, expectedOwner);
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
  private async flushCleanupNotes(workflowId: string,
    expected?: { dshSessionId: string; reviewAttempt?: number; cwd: string; evidenceFingerprint?: string },
    guard?: (record: WorkflowRecord) => boolean): Promise<void> {
    const notes = this.runtime.cleanupNotes.get(workflowId);
    if (!notes || notes.length === 0) return;
    this.runtime.cleanupNotes.delete(workflowId);
    await this.store.update(workflowId, (record) => {
      if (guard && !guard(record)) throw new Error("review cleanup no longer owns this scope");
      if (expected && (record.dshSessionId !== expected.dshSessionId || record.reviewAttempt !== expected.reviewAttempt
        || record.cwd !== expected.cwd || (expected.evidenceFingerprint !== undefined
          && record.latestReviewEvidence?.fingerprint !== expected.evidenceFingerprint))) {
        throw new Error("review ownership changed before cleanup observation");
      }
      record.lastProgressMessage = [record.lastProgressMessage, ...notes].filter(Boolean).join(" — ");
      record.lastProgressAt = new Date().toISOString();
    }, { ignoreCancelled: true }).catch(() => undefined);
  }

  /** 1.1.4: release the subscription acquired by THIS DSH-led review round, so
   * the next round can never collide with the previous round's own hold.
   * @returns a compact note when the release could not be sent, so the caller can
   * surface it on the round's terminal message instead of swallowing it. */
  private async releaseReviewerSubscription(threadId: string, expectedOwner?: object): Promise<string | undefined> {
    return this.releaseReviewerHold(threadId, expectedOwner);
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

  private originalThreadAvailable(threadId: string, owner?: object): boolean {
    if (this.codex.captureThreadOwner && !owner) return false;
    return this.turnGateway.isThreadAvailable(threadId, owner);
  }

  private async releaseReviewerHold(threadId: string, expectedOwner?: object): Promise<string | undefined> {
    await this.usageObserver.releaseOwned(threadId, expectedOwner);
    if (this.codex.captureThreadOwner && !expectedOwner) return;
    return this.boundedCleanup("reviewer release", () => this.reviewerGateway.unsubscribe(threadId, undefined, expectedOwner));
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
    settings?: ReviewerRunSettings,
    progressGuard?: (record: WorkflowRecord) => boolean,
  ): Promise<AlignmentOutcome> {
    const alignWithCli = async (): Promise<AlignmentOutcome> => {
      await this.assertReviewProgress(record.id, progressGuard);
      if (!this.audit) throw new Error("CLI alignment requested but the CLI audit gateway is unavailable");
      return this.audit.align({
        result,
        task: record.task,
        planMarkdown: record.planMarkdown,
        previousReview: record.latestReview,
        fixSummary: input?.implementationSummary,
        cwd: record.cwd,
        workflowId: record.id,
        submissionId: record.submissionId,
        model: settings ? settings.model : record.reviewerModel || this.config.reviewerModel,
        prompt: reviewAlignPrompt(result, {
          workflowId: record.id,
          task: record.task,
          planMarkdown: record.planMarkdown,
          previousReview: record.latestReview,
          fixSummary: input?.implementationSummary,
        }),
      }, signal).catch((error) => {
        throw record.origin === "codex_bridge" ? error : new ForegroundReviewStageError("alignment", error, { modelCall: true });
      });
    };
    if (this.config.conversionTransport === "cli") return alignWithCli();
    try {
      const model = settings ? settings.model : record.reviewerModel
      || this.config.reviewerModel
      || await this.turnGateway.resolveDefaultModel?.(signal)
      || undefined;
    const normalized = await this.withAuxiliaryReviewThread(record, model, "Alignment", signal, (threadId, threadOwner) => {
      const pending = this.runtime.recoverableRuns.get(record.id)?.pendingStart;
      const onStarted = (started: { threadId: string; turnId: string }) => this.registerEphemeralTurn(
        record.id, started.threadId, started.turnId, "reviewer", undefined, progressGuard, threadOwner);
      return pending instanceof AuxiliaryStartReceiptPendingError && pending.purpose === "Alignment"
        ? pending.operation.resume({ onStarted }, signal).then((original) => original.result)
        : this.turnGateway.normalizeInFork({
        threadId,
        ...(threadOwner ? { expectedOwner: threadOwner } : {}),
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
        sourceEphemeral: true,
        // The alignment fork is ephemeral: its thread/turn pair is the exact
        // active cancel target WHILE it runs, but the fork id is never
        // persisted (reviewerThreadId keeps pointing at the durable task).
        onStarted,
       }, signal).catch((error) => {
         throw record.origin === "codex_bridge" ? error : new ForegroundReviewStageError("alignment", error, { modelCall: true });
       });
     }, progressGuard);
    const after = await this.store.load(record.id);
    if (!after || after.phase === "cancelled") throw new Error("workflow cancelled during review authority alignment");
    if (normalized.kind !== "completed") throw new Error("review authority alignment unexpectedly requested user input");
    if (normalized.status !== "completed") {
      const error = new Error(`${normalized.reason ?? `review authority alignment turn ${normalized.status}`}${normalized.error ? `: ${normalized.error}` : ""}`);
       throw record.origin === "codex_bridge" ? error : new ForegroundReviewStageError("alignment", error, { modelCall: true });
    }
      return parseAlignment(normalized.text, result);
    } catch (error) {
      if (error instanceof CodexTurnInterruptionError || error instanceof CodexTurnReceiptPendingError || error instanceof ForegroundReviewStageError) throw error;
      if (signal?.aborted) throw error;
      if (record.origin !== "codex_bridge") throw error;
      if ((this.config.conversionFallback ?? "cli") !== "cli" || !this.audit) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      await this.reviewObservation.mark(record.id, "review_alignment", `App Server alignment failed; using CLI fallback (${detail})`, null, progressGuard);
      return alignWithCli();
    }
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
    settings?: ReviewerRunSettings,
    progressGuard?: (record: WorkflowRecord) => boolean,
    recovery?: ForegroundReconciliationRecovery,
  ): Promise<{ aligned: true; result: ReviewResult } | { aligned: false }> {
    const model = settings ? settings.model : record.reviewerModel || this.config.reviewerModel;
    const cached = recovery?.checkpoint;
    if (cached?.verdict) {
      await this.assertReviewProgress(record.id, progressGuard);
      const preservationError = reconciliationPreservationViolation(result, conflicts, cached.verdict);
      if (preservationError) throw new Error(`reconciled review violated entry preservation: ${preservationError}`);
      const recheck = cached.alignment ?? await this.alignReview(record, cached.verdict, signal, input, settings, progressGuard);
      await this.assertReviewProgress(record.id, progressGuard);
      recovery!.capture({ ...cached, alignment: recheck });
      return recheck.aligned ? { aligned: true, result: cached.verdict } : { aligned: false };
    }
    if (this.config.conversionTransport === "cli" && !this.audit) {
      throw new Error("CLI reconciliation requested but the CLI audit gateway is unavailable");
    }
    if (this.config.conversionTransport === "cli" && this.audit) {
      await this.assertReviewProgress(record.id, progressGuard);
      // Reconciliation is an independent ephemeral CLI turn. It never resumes
      // a Desktop task or the external bridge origin task.
      let corrected = recovery?.checkpoint?.verdict
        ? { verdict: recovery.checkpoint.verdict, visibleText: recovery.checkpoint.readableText ?? "" }
        : undefined;
      if (!corrected) corrected = await this.audit.reconcile({
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
        ...(model ? { model } : {}),
        effort: settings ? settings.effort : record.reviewerEffort ?? this.config.reviewerEffort,
      }, signal, recovery ? {
        visibleText: recovery.checkpoint?.readableText,
        captureVisibleText: async (readableText) => {
          await this.assertReviewProgress(record.id, progressGuard);
          recovery.capture({ ...recovery.checkpoint, readableText });
        },
      } : undefined).catch((error) => { throw recovery ? new ForegroundReviewStageError("reconciliation", error, { modelCall: true }) : error; });
      await this.assertReviewProgress(record.id, progressGuard);
      recovery?.capture({ ...recovery.checkpoint, readableText: corrected.visibleText, verdict: corrected.verdict });
      const preservationError = reconciliationPreservationViolation(result, conflicts, corrected.verdict);
      if (preservationError) throw new Error(`reconciled review violated entry preservation: ${preservationError}`);
      const recheck = recovery?.checkpoint?.alignment ?? await this.alignReview(record, corrected.verdict, signal, input, settings, progressGuard);
      await this.assertReviewProgress(record.id, progressGuard);
      recovery?.capture({ readableText: corrected.visibleText, verdict: corrected.verdict, alignment: recheck });
      return recheck.aligned ? { aligned: true, result: corrected.verdict } : { aligned: false };
    }
    return this.withAuxiliaryReviewThread(record, model, "Reconciliation", signal, async (threadId, threadOwner) => {
    let reconcile: TurnWaitResult;
    const saved = recovery?.checkpoint;
    if (saved?.readableText) reconcile = { kind: "completed", status: "completed", threadId, turnId: "", text: saved.readableText };
    else {
    try {
      const pending = this.runtime.recoverableRuns.get(record.id)?.pendingStart;
      const onStarted = (started: { threadId: string; turnId: string }) => this.registerEphemeralTurn(
        record.id, started.threadId, started.turnId, "reviewer", undefined, progressGuard, threadOwner);
      reconcile = await (pending instanceof AuxiliaryStartReceiptPendingError && pending.purpose === "Reconciliation"
        ? pending.operation.resume({ onStarted }, signal).then((original) => original.result)
        : this.startTurnWithTransientRetry(threadId, {
      ...(threadOwner ? { expectedOwner: threadOwner } : {}),
        prompt: reviewReconcilePrompt(result, conflicts, {
          workflowId: record.id,
          task: record.task,
          planMarkdown: record.planMarkdown,
        }),
        ...(model ? { model } : {}),
        effort: "low",
        conversion: false,
        // The private seed uses readable output for reconciliation, then
        // normalization. Its exact pair is internal, not original Reviewer usage.
        silentReview: true,
        onStarted,
      }, signal, progressGuard ? () => this.assertReviewProgress(record.id, progressGuard) : undefined))
         .catch((error) => { throw recovery ? new ForegroundReviewStageError("reconciliation", error, { modelCall: true }) : error; });
    } finally {
      if (this.runtime.activeTurns.get(record.id)?.threadId === threadId) this.runtime.activeTurns.delete(record.id);
    }
    }
    const after = await this.store.load(record.id);
    if (!after || after.phase === "cancelled") throw new Error("workflow cancelled during review reconciliation");
    if (progressGuard && !progressGuard(after)) throw new Error("review progress ownership changed before reconciliation conversion");
    if (reconcile.kind !== "completed") throw new Error("review reconciliation unexpectedly requested user input");
    if (reconcile.status !== "completed") {
      const error = new Error(reconcile.status === "interrupted"
        ? "review reconciliation turn interrupted"
        : `${reconcile.reason ?? `review reconciliation turn ${reconcile.status}`}${reconcile.error ? `: ${reconcile.error}` : ""}`);
       throw recovery ? new ForegroundReviewStageError("reconciliation", error, { modelCall: true }) : error;
    }
    const visibleText = reconcile.text ?? "";
    const displayError = reviewDisplayError(visibleText, after);
    if (displayError) throw new Error(`reconciled review violates the display contract: ${displayError}`);
    await this.assertReviewProgress(record.id, progressGuard);
    recovery?.capture({ ...saved, readableText: visibleText });
    let correctedResult: ReviewResult | undefined = saved?.verdict;
    if (!correctedResult) {
    let corrected: TurnWaitResult;
    try {
      const pending = this.runtime.recoverableRuns.get(record.id)?.pendingStart;
      const onStarted = (started: { threadId: string; turnId: string }) => this.registerEphemeralTurn(
        after.id, started.threadId, started.turnId, "reviewer", undefined, progressGuard, threadOwner);
      corrected = await (pending instanceof AuxiliaryStartReceiptPendingError && pending.purpose === "Reconciliation"
        && Boolean(saved?.readableText)
        ? pending.operation.resume({ onStarted }, signal).then((original) => original.result)
        : this.turnGateway.normalizeInFork({
        prompt: reviewConversionPrompt(visibleText, after.id),
        threadId,
        ...(threadOwner ? { expectedOwner: threadOwner } : {}),
        cwd: after.cwd,
        ...(model ? { model } : {}),
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        sourceEphemeral: true,
        onStarted,
      }, signal)).catch((error) => { throw recovery ? new ForegroundReviewStageError("reconciliation", error, { modelCall: true }) : error; });
    } finally {
      if (this.runtime.activeTurns.get(after.id)?.threadId === threadId) this.runtime.activeTurns.delete(after.id);
    }
    if (corrected.kind !== "completed") throw new Error("review reconciliation normalization unexpectedly requested user input");
    if (corrected.status !== "completed") {
      const error = new Error(`${corrected.reason ?? `review reconciliation normalization turn ${corrected.status}`}${corrected.error ? `: ${corrected.error}` : ""}`);
       throw recovery ? new ForegroundReviewStageError("reconciliation", error, { modelCall: true }) : error;
    }
    correctedResult = applyReviewConsistency(parseReview(corrected.text));
    await this.assertReviewProgress(record.id, progressGuard);
    recovery?.capture({ ...saved, readableText: visibleText, verdict: correctedResult });
    }
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
    const recheck = saved?.alignment ?? await this.alignReview(after, correctedResult, signal, input, settings, progressGuard);
    await this.assertReviewProgress(record.id, progressGuard);
    recovery?.capture({ readableText: visibleText, verdict: correctedResult, alignment: recheck });
    return recheck.aligned ? { aligned: true, result: correctedResult } : { aligned: false };
    }, progressGuard);
  }

  private async assertReviewProgress(workflowId: string, guard?: (record: WorkflowRecord) => boolean): Promise<void> {
    if (!guard) return;
    const current = await this.store.load(workflowId);
    if (!current || !guard(current)) throw new Error("review progress ownership changed; no nested model will be started");
  }

  /** The creator owns each private seed through every conversion/recheck step. */
  private async withAuxiliaryReviewThread<T>(record: WorkflowRecord, model: string | undefined,
    purpose: "Alignment" | "Reconciliation", signal: AbortSignal | undefined,
    work: (threadId: string, threadOwner?: object) => Promise<T>, progressGuard?: (record: WorkflowRecord) => boolean): Promise<T> {
    this.assertAuxiliaryTurnsEnded(record.id);
    // Bridge callbacks have already released the visible Reviewer's pin.
    // Keep this seed alive across creation, model waits and retry backoff.
    const pending = this.runtime.recoverableRuns.get(record.id)?.pendingStart;
    const original = pending instanceof AuxiliaryStartReceiptPendingError && pending.purpose === purpose ? pending : undefined;
    if (!original) this.turnGateway.beginRound();
    let threadId: string | undefined;
    let threadOwner: object | undefined;
    let transferred = false;
    let released = false;
    const releaseSeed = original?.releaseSeed ?? (async () => {
      if (released) return;
      released = true;
      try { if (threadId) this.reportCleanupNote(record.id, await this.releaseUnboundReviewer(threadId, undefined, threadOwner)); }
      finally { this.turnGateway.endRound(); }
    });
    try {
      await this.assertReviewProgress(record.id, progressGuard);
      threadId = original?.operation.sourceThreadId ?? await this.threadGateway.startThread({ cwd: record.cwd, model,
        name: `DSH Review ${purpose}: ${record.id}`, ephemeral: true }, signal);
      threadOwner = original?.operation.sourceThreadOwner ?? this.codex.captureThreadOwner?.(threadId);
      await this.assertReviewProgress(record.id, progressGuard);
      return await work(threadId, threadOwner);
    }
    catch (error) {
      const pendingError = error instanceof CodexTurnReceiptPendingError ? error
        : error instanceof ForegroundReviewStageError && error.original instanceof CodexTurnReceiptPendingError ? error.original : undefined;
      if (pendingError && threadId === pendingError.operation.sourceThreadId) {
        transferred = true;
        const retained = original && (pendingError === original || pendingError.operation === original.baseOperation)
          ? original : new AuxiliaryStartReceiptPendingError(pendingError, purpose, releaseSeed);
        throw error instanceof ForegroundReviewStageError
          ? new ForegroundReviewStageError(error.stage, retained, { modelCall: error.modelCall }) : retained;
      }
      const interruption = error instanceof ForegroundReviewStageError ? error.interruption
        : error instanceof CodexTurnInterruptionError ? error : undefined;
      if (threadId && interruption && interruption.threadId === threadId) {
        // Keep the independently owned pair and process pin until termination
        // is confirmed. It cannot become the original Reviewer's recovery handle.
        const retained: RetainedAuxiliaryTurn = { workflowId: record.id, threadId, threadOwner: threadOwner ?? interruption.originalThreadOwner, turnId: interruption.turnId,
          originalProcessId: interruption.originalProcessId, originalProcessIds: interruption.originalProcessIds,
          originalProcessIdentities: interruption.originalProcessIdentities };
        this.runtime.auxiliaryTurns.set(threadId, retained);
        this.runtime.auxiliaryInterruptionOwners.set(interruption, retained);
        transferred = true;
        await this.cleanupAuxiliaryTurn(retained);
      }
      throw error;
    }
    finally {
      if (threadId && this.runtime.activeTurns.get(record.id)?.threadId === threadId) this.runtime.activeTurns.delete(record.id);
      if (!transferred) {
        await releaseSeed();
      }
    }
  }

  private assertAuxiliaryTurnsEnded(workflowId: string): void {
    const turn = [...this.runtime.auxiliaryTurns.values()].find((turn) => turn.workflowId === workflowId);
    if (turn) {
      throw new CodexTurnInterruptionError(new Error(`workflow ${workflowId} has an unconfirmed private review turn; cancel or stop to retry its original cleanup before another review`),
        turn.threadId, turn.turnId);
    }
  }

  private async cleanupAuxiliaryTurns(workflowId?: string): Promise<void> {
    await Promise.allSettled([...this.runtime.auxiliaryTurns.values()]
      .filter((turn) => workflowId === undefined || turn.workflowId === workflowId)
      .map((turn) => this.cleanupAuxiliaryTurn(turn)));
  }

  private async confirmAuxiliaryTurns(workflowId: string, expected?: { threadId: string; turnId: string },
    expectedOwner?: RetainedAuxiliaryTurn): Promise<boolean> {
    this.reviewAdmission.assertOwned();
    if (expected) {
      const turn = expectedOwner ?? this.runtime.auxiliaryTurns.get(expected.threadId);
      if (!turn || turn.workflowId !== workflowId || turn.threadId !== expected.threadId || turn.turnId !== expected.turnId) return false;
      if (this.runtime.auxiliaryConfirmations.has(turn)) return true;
      if (this.runtime.auxiliaryTurns.get(turn.threadId) !== turn) return false;
      await this.cleanupAuxiliaryTurn(turn);
      this.reviewAdmission.assertOwned();
      return this.runtime.auxiliaryConfirmations.has(turn);
    }
    const turns = [...this.runtime.auxiliaryTurns.values()].filter((turn) => turn.workflowId === workflowId);
    await Promise.all(turns.map((turn) => this.cleanupAuxiliaryTurn(turn)));
    this.reviewAdmission.assertOwned();
    return turns.every((turn) => this.runtime.auxiliaryConfirmations.has(turn));
  }

  private cleanupAuxiliaryTurn(turn: RetainedAuxiliaryTurn): Promise<void> {
    if (turn.cleanupFlight) return turn.cleanupFlight;
    const task = Promise.resolve().then(async () => {
      if (this.runtime.auxiliaryTurns.get(turn.threadId) !== turn) return;
      const { threadId, turnId, threadOwner, originalProcessId, originalProcessIds, originalProcessIdentities } = turn;
      if (this.originalThreadAvailable(threadId, threadOwner)) {
        const note = await this.boundedCleanup("private review interruption unconfirmed",
          () => this.turnGateway.interrupt(threadId, turnId, undefined, threadOwner));
        if (note) { this.reportCleanupNote(turn.workflowId, note); return; }
      } else {
        const exited = await originalProcessTreeExited({ processId: originalProcessId, processIds: originalProcessIds,
          processIdentities: originalProcessIdentities });
        if (!exited) {
          this.reportCleanupNote(turn.workflowId, "Private review process exit is unconfirmed; original cleanup ownership retained");
          return;
        }
      }
      if (turn.threadId !== threadId || turn.turnId !== turnId || turn.threadOwner !== threadOwner
        || turn.originalProcessId !== originalProcessId || turn.originalProcessIds !== originalProcessIds
        || turn.originalProcessIdentities !== originalProcessIdentities) return;
      // A late ACK belongs to this owner even if the address was reused.
      this.runtime.auxiliaryConfirmations.add(turn);
      if (this.runtime.auxiliaryTurns.get(turn.threadId) !== turn) {
        this.turnGateway.endRound();
        return;
      }
      this.runtime.auxiliaryTurns.delete(turn.threadId);
      try { this.reportCleanupNote(turn.workflowId, await this.releaseUnboundReviewer(turn.threadId, undefined, turn.threadOwner)); }
      finally { this.turnGateway.endRound(); }
    });
    turn.cleanupFlight = task;
    void task.finally(() => { if (turn.cleanupFlight === task) turn.cleanupFlight = undefined; }).catch(() => undefined);
    return task;
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
    expectedPlanner?: PlannerRunIdentity,
    threadOwner?: object,
  ): Promise<void> {
    threadOwner ??= this.codex.captureThreadOwner?.(threadId);
    await this.usageObserver.bind(workflowId, threadId, kind === "planner" ? "planning" : "reviewing", undefined, undefined, threadOwner);
    this.runtime.activeTurns.set(workflowId, { threadId, threadOwner, turnId, kind, ephemeral });
    const outcome = await this.store.update(workflowId, (r) => {
      if (expectedPlanner) assertPlannerRun(expectedPlanner, r);
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
    expectedPlanner?: PlannerRunIdentity,
    progressGuard?: (record: WorkflowRecord) => boolean,
    threadOwner?: object,
  ): Promise<void> {
    threadOwner ??= this.codex.captureThreadOwner?.(threadId);
    try { await this.assertReviewProgress(workflowId, progressGuard); }
    catch (error) { await this.turnGateway.interrupt(threadId, turnId, undefined, threadOwner).catch(() => undefined); throw error; }
    this.runtime.activeTurns.set(workflowId, { threadId, threadOwner, turnId, kind, ephemeral: true, internal: true });
    const record = await this.store.load(workflowId);
    if (expectedPlanner && record?.phase !== "cancelled") assertPlannerRun(expectedPlanner, record);
    if (record?.processState === "running" && kind === "reviewer") {
      try { await this.reviewObservation.mark(workflowId, undefined, "Reviewer conversion turn is running", turnId, progressGuard); }
      catch (error) {
        if (this.runtime.activeTurns.get(workflowId)?.threadId === threadId) this.runtime.activeTurns.delete(workflowId);
        await this.turnGateway.interrupt(threadId, turnId, undefined, threadOwner).catch(() => undefined);
        throw error;
      }
    }
    if (!record || record.phase === "cancelled") {
      this.runtime.activeTurns.delete(workflowId);
      await this.turnGateway.interrupt(threadId, turnId, undefined, threadOwner).catch(() => undefined);
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
   *   enforced PlannerResult JSON on the original ephemeral Planner thread
   *   (`normalizeInFork` with `sourceEphemeral:true`). Conversion is read-only,
   *   uses the visible model and private `low` effort, and has no Desktop task.
   * - READY is only accepted when the CURRENT visible reply itself is a
   *   complete, decision-complete plan. A reply that merely confirms or
   *   acknowledges ("已确认…后续将规划…"), promises to plan later, or is a
   *   short summary is NEVER injected: if the conversion nevertheless said
   *   ready for such a reply, the plugin runs ONE controlled completion turn
   *   on the SAME ephemeral Planner thread (a normal visible Plan-mode turn,
   *   reusing the same task id) and re-converts; only a genuinely complete
   *   plan from one of the two replies enters executing — otherwise the
   *   workflow FAILS without writing planMarkdown. No plan is ever
   *   fabricated or padded from earlier history.
   *
   * Only validated successful stages are cached in the original live run.
   * Recoverable model errors retry the failed stage within its shared budget;
   * schema/display failures remain terminal. Raw Markdown never authorizes
   * execution without a validated structured result and the visible-plan gate.
   */
  private async acceptPlannerOutcome(
    workflowId: string,
    outcome: TurnWaitResult,
    exec: ToolRunContext,
    model: string | undefined,
    cwd: string,
    expected: PlannerRunIdentity,
    checkpoint?: PlannerRunCheckpoint,
  ): Promise<WorkflowRecord> {
    if (checkpoint) {
      model = checkpoint.settings.model;
      cwd = checkpoint.identity.cwd;
      if (checkpoint.outcome && checkpoint.nextStep !== "visible") outcome = checkpoint.outcome;
      if (outcome.threadId !== checkpoint.threadId) throw new Error("Planner outcome belongs to a different checkpoint thread");
    }
    const initial = await this.currentPlannerRun(expected, exec, checkpoint);
    if (initial.phase === "cancelled") return initial;
    await this.usageObserver.bind(workflowId, outcome.threadId, "planning", model, expected);
    const afterUsage = await this.currentPlannerRun(expected, exec, checkpoint);
    if (afterUsage.phase === "cancelled") return afterUsage;
    if (outcome.kind === "needs_input") {
      const commit = await this.store.update(workflowId, (r) => {
        this.assertPlannerCommit(expected, r, exec, checkpoint);
        r.phase = "waiting_input";
        r.retryState = undefined;
        r.processState = undefined;
        r.error = undefined;
        r.questions = outcome.request.questions;
        r.pendingInput = { turnId: outcome.turnId, itemId: outcome.request.itemId };
        if (model) r.plannerModel = model;
      }, { ignoreCancelled: false });
      if (!commit.suppressed) this.runtime.pending.set(workflowId, outcome);
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
      return this.failPlannerNormalization(workflowId, "planner visible reply is empty", expected, exec, checkpoint);
    }
    if (isPlannerJsonEnvelope(outcome.text)) {
      return this.failPlannerNormalization(workflowId, "planner visible reply leaked the structured JSON envelope", expected, exec, checkpoint);
    }
    if (checkpoint && checkpoint.nextStep === "visible") {
      checkpoint.outcome = outcome;
      checkpoint.visibleText = outcome.text;
      checkpoint.converted = undefined;
      checkpoint.nextStep = "conversion";
      checkpoint.continuation = undefined;
    }
    // A cancel that won while the visible turn was running ends here: never
    // create a conversion fork for a cancelled workflow.
    const beforeFork = await this.currentPlannerRun(expected, exec, checkpoint);
    if (beforeFork.phase === "cancelled") return beforeFork;
    // Private structured conversion never accepts raw text as a result.
    // Only classified model failures continue the original unfinished stage.
    const convert = async (visibleText: string): Promise<PlannerResult | WorkflowRecord> => {
      const stage = checkpoint?.nextStep === "corrected_conversion" ? "corrected_conversion" : "conversion";
      const beforeConversion = await this.currentPlannerRun(expected, exec, checkpoint);
      if (beforeConversion.phase === "cancelled") return beforeConversion;
      let normalized: TurnWaitResult;
      try {
        const onStarted = (started: { threadId: string; turnId: string }) => this.registerEphemeralTurn(
          workflowId, started.threadId, started.turnId, "planner", expected, undefined, checkpoint?.threadOwner);
        normalized = checkpoint?.pendingStart
          ? (await checkpoint.pendingStart.operation.resume({ onStarted }, exec.signal)).result
          : await this.turnGateway.normalizeInFork({
          ...(checkpoint?.threadOwner ? { expectedOwner: checkpoint.threadOwner } : {}),
          threadId: outcome.threadId,
          cwd,
          prompt: checkpoint?.continuation?.step === stage
            ? `${checkpoint.continuation.instruction}\n请只继续本会话已经完成规划的结构化转换，依据原可读规划与转换规则，输出符合当前 Schema 的完整 JSON；不要重新规划或重述原任务。`
            : plannerConvertPrompt(visibleText),
          ...(model ? { model } : {}),
          outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
          sourceEphemeral: true,
          onStarted,
        }, exec.signal);
        await this.finishPendingPlannerReceipt(workflowId, checkpoint);
      } catch (error) {
        if (error instanceof CodexTurnReceiptPendingError) throw error;
        if (error instanceof CodexTurnInterruptionError) throw error;
        if (checkpoint && !exec.signal.aborted && isRecoverableModelFailure(error)) {
          throw new PlannerStageModelError(errorMessage(error), stage);
        }
        return this.failPlannerNormalization(workflowId, errorMessage(error), expected, exec, checkpoint);
      } finally {
        this.runtime.activeTurns.delete(workflowId);
      }
      if (normalized.threadId !== outcome.threadId) {
        return this.failPlannerNormalization(workflowId, "planner normalization returned a different original thread", expected, exec, checkpoint);
      }
      if (normalized.kind !== "completed" || normalized.status !== "completed") {
        if (checkpoint && normalized.kind === "completed" && !normalized.text?.trim()) {
          const detail = `${normalized.reason ?? "turn failed"}${normalized.error ? `: ${normalized.error}` : ""}`;
          if (isRecoverableModelFailure(detail)) throw new PlannerStageModelError(detail, stage);
        }
        return this.failPlannerNormalization(
          workflowId,
          normalized.kind === "needs_input"
            ? "planner normalization unexpectedly requested user input"
            : normalized.error ?? normalized.reason ?? `planner normalization turn ${normalized.status}`, expected, exec, checkpoint,
        );
      }
      let parsed: PlannerResult;
      try { parsed = parsePlanner(normalized.text); }
      catch (error) {
        return this.failPlannerNormalization(workflowId, `planner normalization returned an invalid result: ${errorMessage(error)}`, expected, exec, checkpoint);
      }
      // An already returned successful receipt survives caller cancellation.
      // Cached output is still unusable until the original scope and commit
      // guards pass; it cannot authorize a cancelled or displaced workflow.
      if (checkpoint) {
        checkpoint.converted = parsed;
        checkpoint.nextStep = "finalizing";
        checkpoint.continuation = undefined;
      }
      const afterConversion = await this.currentPlannerRun(expected, exec, checkpoint);
      if (afterConversion.phase === "cancelled") return afterConversion;
      return parsed;
    };
    let visibleText = checkpoint?.visibleText ?? outcome.text;
    let converted = checkpoint?.converted ?? await convert(visibleText);
    if (isWorkflowRecord(converted)) return converted;
    let result = converted;
    // The conversion said ready, but the CURRENT visible reply itself is not a
    // complete plan (confirmation/acknowledgement, promise-to-plan-later,
    // short summary): never inject it. Run ONE controlled completion turn on
    // the SAME persistent Planner task, then re-convert; the second reply is
    // judged by the same gate.
    if (result.status === "ready" && result.planMarkdown?.trim() && !isPlausibleCompletePlan(visibleText)) {
      if (checkpoint?.completionUsed && checkpoint.nextStep !== "completion") {
        return this.failPlannerNormalization(workflowId,
          "planner visible reply is not a complete plan (confirmation/acknowledgement or too short); the completion turn did not produce a plan either", expected, exec, checkpoint);
      }
      const beforeCompletion = await this.currentPlannerRun(expected, exec, checkpoint);
      if (beforeCompletion.phase === "cancelled") return beforeCompletion;
      if (checkpoint) {
        checkpoint.nextStep = "completion";
        checkpoint.completionUsed = true;
      }
      const completionPrompt = checkpoint?.continuation?.step === "completion"
        ? `${checkpoint.continuation.instruction}\n请继续本会话尚未完成的规划补全，直接给出完整、可执行的规划，不要重述原任务或已确认的问题。`
        : plannerCompletionPrompt(visibleText);
      checkpoint?.child?.beginContinuation(completionPrompt);
      let completion: TurnWaitResult;
      try {
        const onStarted = async (started: { threadId: string; turnId: string }) => {
          if (started.threadId !== outcome.threadId) {
            await this.turnGateway.interrupt(started.threadId, started.turnId).catch(() => undefined);
            throw new Error("Planner completion returned a different original thread; refusing a replacement");
          }
          await this.registerActiveTurn(workflowId, started.threadId, started.turnId, "planner", true, expected, checkpoint?.threadOwner);
        };
        completion = checkpoint?.pendingStart
          ? (await checkpoint.pendingStart.operation.resume({ onStarted, onProgress: checkpoint.onProgress }, exec.signal)).result
          : await this.startTurnWithTransientRetry(outcome.threadId, {
          ...(checkpoint?.threadOwner ? { expectedOwner: checkpoint.threadOwner } : {}),
          prompt: completionPrompt,
          ...(model ? { model } : {}),
          effort: checkpoint?.settings.effort ?? beforeFork.plannerEffort ?? this.config.plannerEffort,
          planMode: true,
          onProgress: checkpoint?.onProgress,
          onModel: checkpoint ? (resolved) => {
            model = resolved;
            checkpoint.settings = Object.freeze({ model: resolved, effort: checkpoint.settings.effort });
          } : undefined,
          onStarted,
        }, exec.signal);
        await this.finishPendingPlannerReceipt(workflowId, checkpoint);
      } catch (error) {
        if (error instanceof CodexTurnReceiptPendingError) throw error;
        if (error instanceof CodexTurnInterruptionError) throw error;
        if (checkpoint && !exec.signal.aborted && isRecoverableModelFailure(error)) {
          throw new PlannerStageModelError(errorMessage(error), "completion");
        }
        throw error;
      } finally {
        // EVERY ending path — completion, cancel, timeout, onStarted
        // persistence failure, process error — must drop the active-turn
        // mapping, so a stale completed/failed turn can never be interrupted
        // by a later cancel.
        this.runtime.activeTurns.delete(workflowId);
      }
      if (checkpoint && completion.threadId === outcome.threadId && completion.kind === "completed"
        && completion.status === "completed" && completion.text?.trim() && !isPlannerJsonEnvelope(completion.text)) {
        checkpoint.outcome = completion;
        checkpoint.visibleText = completion.text;
        checkpoint.converted = undefined;
        checkpoint.nextStep = "corrected_conversion";
        checkpoint.continuation = undefined;
      }
      const afterCompletion = await this.currentPlannerRun(expected, exec, checkpoint);
      if (afterCompletion.phase === "cancelled") return afterCompletion;
      if (completion.threadId !== outcome.threadId) throw new Error("Planner completion result belongs to a different original thread");
      if (completion.kind === "needs_input") {
        // The completion turn asked for user input: fall back to the normal
        // waiting_input machinery (user answers via codex_workflow_continue).
        const commit = await this.store.update(workflowId, (r) => {
          this.assertPlannerCommit(expected, r, exec, checkpoint);
          r.phase = "waiting_input";
          r.retryState = undefined;
          r.processState = undefined;
          r.error = undefined;
          r.questions = completion.request.questions;
          r.pendingInput = { turnId: completion.turnId, itemId: completion.request.itemId };
          if (model) r.plannerModel = model;
        }, { ignoreCancelled: false });
        if (!commit.suppressed) this.runtime.pending.set(workflowId, completion);
        if (!commit.suppressed) this.emitSessionEvent(commit.record, {
          type: "dsh-codex-workflow/plan-updated",
          data: { workflowId, status: "waiting_input", questions: commit.record.questions, assumptions: commit.record.assumptions },
        });
        if (!commit.suppressed && checkpoint) {
          checkpoint.outcome = completion;
          checkpoint.visibleText = completion.request.questions.map((question) => question.question).join("\n\n");
          checkpoint.converted = undefined;
          checkpoint.nextStep = "visible";
          checkpoint.continuation = undefined;
        }
        return commit.record;
      }
      if (completion.status !== "completed") {
        const detail = `${completion.reason ?? "turn failed"}${completion.error ? `: ${completion.error}` : ""}`;
        if (checkpoint && !completion.text?.trim() && isRecoverableModelFailure(detail)) {
          throw new PlannerStageModelError(detail, "completion");
        }
        throw new Error(completion.error ?? `planner completion turn ${completion.status}`);
      }
      if (!completion.text || !completion.text.trim() || isPlannerJsonEnvelope(completion.text)) {
        return this.failPlannerNormalization(workflowId, "planner completion reply is empty or a JSON envelope", expected, exec, checkpoint);
      }
      visibleText = completion.text;
      if (checkpoint) {
        checkpoint.outcome = completion;
        checkpoint.visibleText = completion.text;
        checkpoint.converted = undefined;
        checkpoint.nextStep = "corrected_conversion";
        checkpoint.continuation = undefined;
      }
      converted = await convert(visibleText);
      if (isWorkflowRecord(converted)) return converted;
      result = converted;
      // The completion turn's reply is judged by the SAME hard gate: a still
      // incomplete reply can never become a plan.
      if (result.status === "ready" && !isPlausibleCompletePlan(visibleText)) {
        return this.failPlannerNormalization(
          workflowId,
          "planner visible reply is not a complete plan (confirmation/acknowledgement or too short); the completion turn did not produce a plan either", expected, exec, checkpoint,
        );
      }
    }
    if (result.status === "needs_input") {
      const commit = await this.store.update(workflowId, (r) => {
        this.assertPlannerCommit(expected, r, exec, checkpoint);
        r.phase = "waiting_input";
        r.retryState = undefined;
        r.processState = undefined;
        r.error = undefined;
        r.questions = result.questions;
        r.pendingInput = undefined;
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
        this.assertPlannerCommit(expected, r, exec, checkpoint);
        r.phase = "executing";
        r.retryState = undefined;
        r.processState = undefined;
        r.error = undefined;
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
      this.assertPlannerCommit(expected, r, exec, checkpoint);
      r.phase = "failed";
      r.error = result.message ?? "Codex planner did not return a usable plan";
    }, { ignoreCancelled: false });
    if (!commit.suppressed) this.emitSessionEvent(commit.record, {
      type: "dsh-codex-workflow/plan-updated",
      data: { workflowId, status: "failed", questions: commit.record.questions, assumptions: commit.record.assumptions, message: commit.record.error },
    });
    return commit.record;
  }

  /** Reject invalid or unrecoverable normalization without accepting raw text.
   * Known recoverable model-call failures are handled before this terminal path. */
  private async failPlannerNormalization(workflowId: string, message: string, expected: PlannerRunIdentity,
    exec: ToolRunContext, checkpoint?: PlannerRunCheckpoint): Promise<WorkflowRecord> {
    const failed = await this.store.update(workflowId, (r) => {
      this.assertPlannerCommit(expected, r, exec, checkpoint);
      r.phase = "failed";
      r.error = message;
    }, { ignoreCancelled: false });
    if (failed.suppressed) return failed.record;
    this.emitSessionEvent(failed.record, { type: "dsh-codex-workflow/plan-updated",
      data: { workflowId, status: "failed", questions: failed.record.questions,
        assumptions: failed.record.assumptions, message } });
    throw new Error(message);
  }

  private assertPlannerCommit(expected: PlannerRunIdentity, current: WorkflowRecord, exec: ToolRunContext,
    checkpoint?: PlannerRunCheckpoint): void {
    exec.signal.throwIfAborted();
    if (this.runtime.stopped) throw new Error("workflow manager is stopped");
    assertPlannerRun(expected, current);
    if (checkpoint) assertPlannerRunCheckpoint(checkpoint, current);
  }

  private async currentPlannerRun(expected: PlannerRunIdentity, exec: ToolRunContext,
    checkpoint?: PlannerRunCheckpoint): Promise<WorkflowRecord> {
    const current = await this.store.load(expected.id);
    assertPlannerRunIdentity(expected, current);
    if (current?.phase === "cancelled") return current;
    this.assertPlannerCommit(expected, current!, exec, checkpoint);
    return current!;
  }

  private async owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.store.load(workflowId);
    if (!record) throw new Error(`unknown workflow ${workflowId}`);
    if (record.dshSessionId !== requireAgent(exec).id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  private assertReviewScope(expected: WorkflowRecord, current: WorkflowRecord): void {
    if (current.id !== expected.id || current.dshSessionId !== expected.dshSessionId || current.cwd !== expected.cwd
      || current.task !== expected.task || current.createdAt !== expected.createdAt || current.mode !== expected.mode
      || current.reviewerModel !== expected.reviewerModel || current.reviewerEffort !== expected.reviewerEffort
      || current.planMarkdown !== expected.planMarkdown) {
      throw new Error(`workflow ${expected.id} changed its original review scope`);
    }
  }

  private async assertNoActiveWorkflow(sessionId: string): Promise<void> {
    await this.store.init();
    const assertOriginalCleanupAvailable = () => {
      if (this.runtime.stopped) throw new Error("workflow manager is stopped");
      if ([...this.runtime.recoverableRuns.values()].some((run) => run.terminalFailure
        && (run.plannerIdentity?.dshSessionId ?? run.reviewerIdentity?.dshSessionId) === sessionId)) {
        throw new Error("original terminal cleanup is unconfirmed; no replacement will be started");
      }
    };
    assertOriginalCleanupAvailable();
    await this.terminalCleanupGuard.assertAvailable(sessionId);
    assertOriginalCleanupAvailable();
    const active = await this.store.activeForSession(sessionId);
    assertOriginalCleanupAvailable();
    if (active) {
      throw new Error(`session already has active Codex workflow ${active.id} (${active.phase}); continue it or query codex_workflow_status instead of starting another`);
    }
  }

  private async retainCallbackCleanup(workflowId: string, record: WorkflowRecord): Promise<void> {
    const pending = this.callback?.getPendingTerminalCleanup?.(workflowId);
    const startup = this.callback?.getPendingStartReceipt?.(workflowId);
    if (!pending && !startup && this.callback?.hasPendingTerminalCleanup?.(workflowId) !== true) return;
    // Observer abort can settle before the producer finishes its census. Wait
    // for that original evidence before freezing the cleanup generation.
    const evidence = startup && await startup.pendingStart.operation.evidence().catch(() => undefined);
    if (startup && this.callback?.getPendingStartReceipt?.(workflowId)?.executionOwner !== startup.executionOwner) return;
    const held = this.callbackCleanupGuards.get(workflowId);
    const owner = startup?.executionOwner ?? pending?.executionOwner ?? (held && held.submissionId === record.submissionId ? held.owner : {});
    if (held && held.owner !== owner && held.operation?.finished()) {
      // A later stage owns a distinct original request. Retire only the
      // completed predecessor's exact guard, then admit the new generation.
      this.terminalCleanupGuard.release(workflowId, held.marker);
      if (!this.terminalCleanupGuard.isConfirmed(workflowId, held.marker)) {
        throw new Error("original callback cleanup guard generation changed");
      }
      this.callbackCleanupGuards.delete(workflowId);
    }
    const marker = this.terminalCleanupGuard.retain(workflowId, {
      ...(pending ? { terminalFailure: pending.terminalFailure } : startup
        ? { state: { awaitingStartReceipt: true } } : { terminalFailure: record.submissionError ?? "Original rejected Reviewer cleanup is unconfirmed" }),
      reviewerIdentity: { dshSessionId: record.dshSessionId },
      originalProcessId: evidence?.processId ?? startup?.originalProcessId ?? pending?.originalProcessId,
      originalProcessIds: evidence?.processIds ?? startup?.originalProcessIds ?? pending?.originalProcessIds,
      originalProcessIdentities: evidence?.processIdentities ?? startup?.originalProcessIdentities ?? pending?.originalProcessIdentities,
    }, owner);
    if (!marker) return;
    this.callbackCleanupGuards.set(workflowId, { marker, owner, submissionId: record.submissionId,
      ...(startup ? { operation: startup.pendingStart.operation } : {}) });
    if (startup) await this.store.update(workflowId, (r) => {
      if (r.dshSessionId !== record.dshSessionId || r.submissionId !== record.submissionId
        || r.cwd !== record.cwd || r.task !== record.task || r.createdAt !== record.createdAt
        || r.submissionLeaseToken !== record.submissionLeaseToken || r.submissionLeaseEpoch !== record.submissionLeaseEpoch
        || this.callback?.getPendingStartReceipt?.(workflowId)?.executionOwner !== owner) {
        throw new Error("original callback start receipt no longer owns this workflow marker");
      }
      r.retryState = { stage: "reviewing", reason: startup.pendingStart.message, attempts: 1,
        awaitingContinuation: r.phase !== "cancelled", awaitingStartReceipt: true, terminalCleanup: marker };
      r.processState = "waiting";
    }, { ignoreCancelled: true }).catch(() => undefined);
  }

  private async releaseCallbackCleanup(workflowId: string, record?: WorkflowRecord): Promise<void> {
    const held = this.callbackCleanupGuards.get(workflowId);
    if (!held || (record && held.submissionId !== record.submissionId)) return;
    this.terminalCleanupGuard.release(workflowId, held.marker);
    if (this.callbackCleanupGuards.get(workflowId) === held) this.callbackCleanupGuards.delete(workflowId);
    if (!this.terminalCleanupGuard.isConfirmed(workflowId, held.marker)) return;
    await this.store.update(workflowId, (r) => {
      const marker = r.retryState?.terminalCleanup;
      if (r.dshSessionId !== held.marker.sessionId || r.submissionId !== held.submissionId
        || !r.retryState?.awaitingStartReceipt || marker?.token !== held.marker.token
        || marker.epoch !== held.marker.epoch || marker.sessionId !== held.marker.sessionId) {
        throw new Error("original callback cleanup no longer owns this workflow marker");
      }
      r.retryState = undefined;
      if (r.phase === "cancelled") r.processState = "cancelled";
    }, { ignoreCancelled: true }).catch(() => undefined);
  }

  private async confirmTerminalCleanup(workflowId: string, run: RecoverableWorkflowRun): Promise<boolean> {
    if (run.pendingStart) {
      const original = run.pendingStart.operation;
      if (run.terminalCleanupFlight) return run.terminalCleanupFlight;
      const task = Promise.resolve().then(async () => {
        const confirmed = await original.cleanup();
        if (run.pendingStart?.operation !== original) return false;
        if (confirmed) this.terminalCleanupGuard.release(workflowId, run.state.terminalCleanup);
        return confirmed;
      });
      run.terminalCleanupFlight = task;
      void task.finally(() => { if (run.terminalCleanupFlight === task) run.terminalCleanupFlight = undefined; }).catch(() => undefined);
      return task;
    }
    if (!run.terminalFailure || !run.state.awaitingCleanup) return false;
    const target = terminalCleanupTarget(run);
    if (!target) return false;
    const key = auxiliaryConfirmationKey(workflowId, target);
    const targetOwner = run.cleanupThreadOwner ?? run.threadOwner;
    const { originalProcessId, originalProcessIds, originalProcessIdentities } = run;
    if (this.runtime.terminalConfirmations.get(run)?.has(key)) return true;
    if (run.terminalCleanupFlight) return run.terminalCleanupFlight;
    const task = Promise.resolve().then(async () => {
      let confirmed = false;
      if (this.originalThreadAvailable(target.threadId, targetOwner)) {
        confirmed = (await this.boundedCleanup("original terminal turn interruption",
          () => this.turnGateway.interrupt(target.threadId, target.turnId, undefined, targetOwner))) === undefined;
      } else {
        confirmed = await terminalProcessTreeExited({ processId: originalProcessId, processIds: originalProcessIds,
          processIdentities: originalProcessIdentities });
      }
      const currentTarget = terminalCleanupTarget(run);
      if (!currentTarget || auxiliaryConfirmationKey(workflowId, currentTarget) !== key
        || (run.cleanupThreadOwner ?? run.threadOwner) !== targetOwner
        || run.originalProcessId !== originalProcessId || run.originalProcessIds !== originalProcessIds
        || run.originalProcessIdentities !== originalProcessIdentities) return false;
      if (confirmed) {
        const confirmations = this.runtime.terminalConfirmations.get(run) ?? new Set<string>();
        confirmations.add(key);
        this.runtime.terminalConfirmations.set(run, confirmations);
        if (this.runtime.recoverableRuns.get(workflowId) === run && target.threadId !== run.threadId) {
          await this.releaseUnboundReviewer(target.threadId, undefined, run.cleanupThreadOwner ?? run.threadOwner);
        }
      }
      return confirmed;
    });
    run.terminalCleanupFlight = task;
    void task.finally(() => { if (run.terminalCleanupFlight === task) run.terminalCleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private setRecoverableRun(workflowId: string, run: RecoverableWorkflowRun): void {
    const previous = this.runtime.recoverableRuns.get(workflowId);
    if (previous?.pendingStart && previous !== run) {
      if (previous.pendingStart.operation.finished()) this.clearRecoverableRun(workflowId);
      else {
        // A newly known terminal pair still belongs to the original receipt
        // guard; it cannot borrow or replace another process generation.
        if (run.pendingStart && run.pendingStart.operation !== previous.pendingStart.operation) {
          throw new Error("Original model start receipt owner changed; no replacement will be used");
        }
        const pendingStart = previous.pendingStart;
        const marker = previous.state.terminalCleanup;
        const evidence = { originalProcessId: previous.originalProcessId, originalProcessIds: previous.originalProcessIds,
          originalProcessIdentities: previous.originalProcessIdentities };
        Object.assign(previous, run, evidence, { pendingStart });
        if (marker) previous.state.terminalCleanup = marker;
        run = previous;
      }
    }
    const marker = this.terminalCleanupGuard.retain(workflowId, run);
    if (marker) run.state.terminalCleanup = marker;
    this.runtime.activeTurns.delete(workflowId);
    this.runtime.recoverableRuns.set(workflowId, run);
  }

  private clearRecoverableRun(workflowId: string): void {
    const run = this.runtime.recoverableRuns.get(workflowId);
    if (run?.pendingStart) {
      if (!run.pendingStart.operation.finished()
        && !this.terminalCleanupGuard.isConfirmed(workflowId, run.state.terminalCleanup)) return;
      if (run.pendingStart.operation.finished()) this.terminalCleanupGuard.release(workflowId, run.state.terminalCleanup);
      this.terminalCleanupGuard.release(workflowId, run.state.terminalCleanup);
    }
    const target = run && terminalCleanupTarget(run);
    if (run?.terminalFailure && target && this.runtime.terminalConfirmations.get(run)?.has(auxiliaryConfirmationKey(workflowId, target))) {
      this.terminalCleanupGuard.release(workflowId, run.state.terminalCleanup);
    }
    this.runtime.recoverableRuns.delete(workflowId);
  }

  private async finishPendingPlannerReceipt(workflowId: string, checkpoint?: PlannerRunCheckpoint): Promise<void> {
    const pending = checkpoint?.pendingStart;
    if (!pending) return;
    checkpoint.pendingStart = undefined;
    const run = this.runtime.recoverableRuns.get(workflowId);
    if (run?.pendingStart?.operation === pending.operation && pending.operation.finished()) {
      await this.confirmTerminalCleanup(workflowId, run);
      this.clearRecoverableRun(workflowId);
    }
  }
}

class AuxiliaryStartReceiptPendingError extends CodexTurnReceiptPendingError {
  readonly baseOperation: PendingTurnReceiptOperation;
  constructor(original: CodexTurnReceiptPendingError, readonly purpose: "Alignment" | "Reconciliation",
    readonly releaseSeed: () => Promise<void>) {
    const base = original.operation;
    const operation: PendingTurnReceiptOperation = Object.freeze({
      sourceThreadId: base.sourceThreadId, sourceThreadOwner: base.sourceThreadOwner,
      status: () => base.status(), finished: () => base.finished(), evidence: () => base.evidence(),
      resume: (callbacks: Parameters<PendingTurnReceiptOperation["resume"]>[0], signal?: AbortSignal) => base.resume(callbacks, signal),
      cleanup: async (signal?: AbortSignal) => {
        if (!await base.cleanup(signal)) return false;
        await releaseSeed(); return true;
      },
    });
    super(original.cause instanceof Error ? original.cause : original, operation);
    this.baseOperation = original instanceof AuxiliaryStartReceiptPendingError ? original.baseOperation : base;
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

The plugin displays your visible reply in the current DSH child Session and its Codex Review right sidebar. Write a single complete, readable Markdown plan (goal, changes, files, verification) in the same language as the task; Plan-mode output is rendered as a plan item. Do NOT output JSON.
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
function visibleReviewContract(): string {
  return `${SILENT_REVIEW_PROMPT_BLOCK}

Reply in the same language as the original task. The plugin displays your visible reply in the current DSH child Session and its Codex Review right sidebar, so write readable Markdown with these sections, and NOT as JSON:
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
  return `${visibleReviewContract()}

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
- If the ORIGINAL TASK or APPROVED PLAN explicitly forbids an action (for example file writes, new tests, dependency changes or network access), do not report the absence of that forbidden action as a finding or test gap; treat the constraint as satisfied.
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
  return `Review the current workspace read-only. Focus on correctness, regressions, security, and missing tests. Do not edit files. ${visibleReviewContract()}

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
  return `You are the independent reviewer for a DSH-executed coding workflow. Review the implementation below against the original plan. Stay read-only: do not edit files, do not create replacement threads, and do not call any dsh tools. ${visibleReviewContract()}

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
      || (transientReason(record.submissionError) !== undefined
        && /already has an active writer/i.test(record.submissionError ?? ""))
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
        // A thrown storage error leaves renewal unconfirmed just like a
        // rejected fence. Retire this observation and notify its owner;
        // letting it escape the timer would terminate the entire host.
        let ok = false;
        try { ok = coordination.renewLease(resource, epoch, owner, ttlMs); }
        catch { /* original ownership cannot be confirmed */ }
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

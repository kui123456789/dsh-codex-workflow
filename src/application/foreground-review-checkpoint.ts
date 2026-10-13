import { CodexTurnInterruptionError } from "../turn-interruption.js";
import { CodexCallbackProcessError } from "../codex-callback.js";
import { isRecoverableModelFailure, isTerminalModelFailure } from "../transient-retry.js";
import type { AlignmentOutcome, ReviewConflictInfo, ReviewEvidence, ReviewInput, ReviewResult, WorkflowRecord } from "../types.js";
import type { RecoverableWorkflowRun, ReviewerRunSettings } from "./workflow-runtime-state.js";

export type ForegroundReviewStage = "conversion" | "alignment" | "reconciliation" | "finalizing";

export function auxiliaryConfirmationKey(workflowId: string, pair: { threadId: string; turnId: string }): string {
  return JSON.stringify([workflowId, pair.threadId, pair.turnId]);
}

/** Reliable changed evidence permanently invalidates the completed old verdict. */
export class TypedForegroundReviewEvidenceChangedError extends Error {}

/** A read did not produce reliable evidence; retry the read without new models. */
export class ForegroundReviewEvidenceUnavailableError extends Error {
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "ForegroundReviewEvidenceUnavailableError";
  }
}

/** Completed reconciliation parts never spend their one readable rewrite twice. */
export interface ForegroundReconciliationCheckpoint {
  readableText?: string;
  verdict?: ReviewResult;
  alignment?: AlignmentOutcome;
}

export interface ForegroundReconciliationRecovery {
  checkpoint?: ForegroundReconciliationCheckpoint;
  capture(next: ForegroundReconciliationCheckpoint): void;
}

/** Output belongs to the original process-local scope, never to a later record. */
export interface ForegroundReviewCheckpoint {
  readonly scope: string;
  readonly input: ReviewInput;
  readonly evidence: ReviewEvidence;
  readonly settings: ReviewerRunSettings;
  readonly readableText: string;
  readonly nextStep: ForegroundReviewStage;
  readonly automaticContinuations: 0 | 1;
  readonly verdict?: ReviewResult;
  readonly alignment?: AlignmentOutcome;
  readonly reconciliation?: ForegroundReconciliationCheckpoint;
  readonly applied?: ReviewResult;
  readonly conflictInfo?: ReviewConflictInfo;
}

/** Only model-call failures use this type; parse/display/identity errors do not. */
export class ForegroundReviewStageError extends Error {
  readonly interruption?: CodexTurnInterruptionError;
  readonly recoverable: boolean;
  readonly modelCall: boolean;
  constructor(readonly stage: ForegroundReviewStage, readonly original: unknown,
    options: { interruptionConfirmed?: boolean; modelCall?: boolean } = {}) {
    super(options.interruptionConfirmed && original instanceof CodexTurnInterruptionError && original.cause instanceof Error
      ? original.cause.message : original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "ForegroundReviewStageError";
    this.interruption = !options.interruptionConfirmed && original instanceof CodexTurnInterruptionError ? original : undefined;
    this.modelCall = options.modelCall === true;
    this.recoverable = original instanceof CodexTurnInterruptionError && !original.cleanupOnly
      || (this.modelCall && !isTerminalModelFailure(this.message) && (isRecoverableModelFailure(this.message)
        || original instanceof CodexCallbackProcessError && original.recoverableModelFailure === true));
  }
}

export function foregroundReviewCheckpointScope(record: WorkflowRecord): string {
  return JSON.stringify([record.id, record.dshSessionId, record.cwd, record.task, record.createdAt,
    record.mode, record.planMarkdown, record.latestReview, record.reviewCycles,
    record.reviewerModel, record.reviewerEffort, record.reviewContractFailures, record.latestReviewConflict]);
}

function material(input: ReviewInput): string {
  return JSON.stringify([input.implementationSummary, input.changedFiles, input.testResults]);
}

export function captureForegroundReviewCheckpoint(record: WorkflowRecord, input: ReviewInput,
  evidence: ReviewEvidence, settings: ReviewerRunSettings, readableText: string,
  automaticContinuations: 0 | 1): ForegroundReviewCheckpoint {
  return Object.freeze({ scope: foregroundReviewCheckpointScope(record), input: structuredClone(input), evidence: structuredClone(evidence),
    settings: Object.freeze({ ...settings }), readableText, nextStep: "conversion", automaticContinuations });
}

export function assertForegroundReviewCheckpoint(checkpoint: ForegroundReviewCheckpoint, record: WorkflowRecord,
  recovery: Pick<RecoverableWorkflowRun, "input" | "evidence" | "reviewerSettings">): void {
  if (checkpoint.scope !== foregroundReviewCheckpointScope(record) || !recovery.input || material(checkpoint.input) !== material(recovery.input)
    || !recovery.reviewerSettings || checkpoint.settings.model !== recovery.reviewerSettings.model
    || checkpoint.settings.effort !== recovery.reviewerSettings.effort
    || !checkpoint.evidence.fingerprint || checkpoint.evidence.insufficient
    || !recovery.evidence?.fingerprint || recovery.evidence.insufficient
    || checkpoint.evidence.kind !== recovery.evidence.kind
    || checkpoint.evidence.fingerprint !== recovery.evidence.fingerprint
    || JSON.stringify(checkpoint.evidence.changedFiles) !== JSON.stringify(recovery.evidence.changedFiles)
    || record.latestReviewEvidence?.kind !== checkpoint.evidence.kind
    || record.latestReviewEvidence.fingerprint !== checkpoint.evidence.fingerprint
    || record.latestReviewEvidence.insufficient
    || JSON.stringify(record.latestReviewEvidence.changedFiles) !== JSON.stringify(checkpoint.evidence.changedFiles)) {
    throw new Error("original completed Reviewer checkpoint lost its scope, input, settings or evidence; no replacement will be started");
  }
  if (!checkpoint.readableText.trim() || !["conversion", "alignment", "reconciliation", "finalizing"].includes(checkpoint.nextStep)
    || (record.processState === "waiting" && record.retryState?.reviewCheckpoint
      && record.retryState.reviewCheckpoint.nextStep !== checkpoint.nextStep)
    || (checkpoint.automaticContinuations !== 0 && checkpoint.automaticContinuations !== 1)
    || (checkpoint.nextStep !== "conversion" && !checkpoint.verdict)
    || (checkpoint.nextStep === "reconciliation" && !checkpoint.alignment)) {
    throw new Error("original completed Reviewer checkpoint is incomplete; no replacement will be started");
  }
}

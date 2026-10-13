import type { AppServerLiveEvent } from "../app-server.js";
import type { CodexChildSessionHandle } from "../codex-child-session.js";
import type { PlannerResult, ReasoningEffort, TurnWaitResult, WorkflowRecord } from "../types.js";
import type { CodexTurnInterruptionError } from "../turn-interruption.js";
import type { CodexTurnReceiptPendingError } from "../pending-turn-receipt.js";
import { assertPlannerRunIdentity, plannerRunIdentity, type PlannerRunIdentity } from "./planner-run-identity.js";

export type PlannerRunStep = "visible" | "conversion" | "completion" | "corrected_conversion" | "finalizing";

/** An omitted model is an admitted choice, rather than a later config lookup. */
export interface PlannerRunSettings {
  readonly model?: string;
  readonly effort: ReasoningEffort;
}

/** Completed output stays with the original live Planner, never a stored marker. */
export interface PlannerRunCheckpoint {
  readonly identity: PlannerRunIdentity;
  readonly scope: string;
  readonly threadId: string;
  /** Process-local execution capability; a reused textual id is not this thread. */
  readonly threadOwner?: object;
  readonly admittedModel?: string;
  readonly admittedEffort?: ReasoningEffort;
  /** Only a pre-checkpoint live handle may capture missing legacy defaults. */
  legacySettingsPending?: boolean;
  settings: PlannerRunSettings;
  nextStep: PlannerRunStep;
  outcome?: TurnWaitResult;
  visibleText?: string;
  converted?: PlannerResult;
  completionUsed: boolean;
  automaticContinuations: 0 | 1;
  continuation?: { step: PlannerRunStep; instruction: string };
  readonly child?: CodexChildSessionHandle;
  onProgress?: (entry: AppServerLiveEvent) => void;
  /** The submitted original model operation, never a replacement prompt. */
  pendingStart?: CodexTurnReceiptPendingError;
}

/** Only a known model-call failure may retry a completed Planner stage. */
export class PlannerStageModelError extends Error {
  constructor(message: string, readonly stage: PlannerRunStep, readonly interruption?: CodexTurnInterruptionError) {
    super(message, interruption ? { cause: interruption } : undefined);
    this.name = "PlannerStageModelError";
  }
}

export function plannerCheckpointScope(record: WorkflowRecord): string {
  return JSON.stringify([record.id, record.dshSessionId, record.cwd, record.task, record.createdAt,
    record.mode ?? "planned", record.planMarkdown, record.latestReview, record.reviewCycles ?? 0,
    record.reviewContractFailures ?? 0, record.latestReviewConflict]);
}

export function capturePlannerRunCheckpoint(record: WorkflowRecord, threadId: string,
  settings: PlannerRunSettings, child?: CodexChildSessionHandle, threadOwner?: object): PlannerRunCheckpoint {
  return { identity: plannerRunIdentity(record), scope: plannerCheckpointScope(record), threadId, threadOwner,
    ...(record.plannerModel ? { admittedModel: record.plannerModel } : {}),
    ...(record.plannerEffort ? { admittedEffort: record.plannerEffort } : {}),
    settings: Object.freeze({ ...settings }), nextStep: "visible", completionUsed: false,
    automaticContinuations: 0, ...(child ? { child } : {}) };
}

export function assertPlannerRunCheckpoint(checkpoint: PlannerRunCheckpoint, record: WorkflowRecord): void {
  assertPlannerRunIdentity(checkpoint.identity, record);
  const parked = !checkpoint.legacySettingsPending && (record.processState === "waiting" || record.phase === "waiting_input");
  if (checkpoint.scope !== plannerCheckpointScope(record) || !checkpoint.threadId
    || (record.plannerModel !== checkpoint.settings.model && (parked || record.plannerModel !== checkpoint.admittedModel))
    || (record.plannerEffort !== checkpoint.settings.effort && (parked || record.plannerEffort !== checkpoint.admittedEffort))
    || !["visible", "conversion", "completion", "corrected_conversion", "finalizing"].includes(checkpoint.nextStep)
    || (checkpoint.automaticContinuations !== 0 && checkpoint.automaticContinuations !== 1)
    || (record.processState === "waiting" && record.retryState?.plannerCheckpoint
      && record.retryState.plannerCheckpoint.nextStep !== checkpoint.nextStep)
    || (checkpoint.nextStep !== "visible" && (!checkpoint.outcome || checkpoint.outcome.kind !== "completed"
      || checkpoint.outcome.status !== "completed" || checkpoint.outcome.threadId !== checkpoint.threadId
      || !checkpoint.visibleText?.trim()))
    || (checkpoint.nextStep === "finalizing" && !checkpoint.converted)) {
    throw new Error("original Planner checkpoint lost its scope or completed stage; no replacement will be started");
  }
}

/** Clarification starts fresh artifacts while preserving the original run budget. */
export function resetPlannerCheckpointForAnswers(checkpoint: PlannerRunCheckpoint): void {
  checkpoint.nextStep = "visible";
  checkpoint.outcome = undefined;
  checkpoint.visibleText = undefined;
  checkpoint.converted = undefined;
  checkpoint.completionUsed = false;
  checkpoint.continuation = undefined;
}

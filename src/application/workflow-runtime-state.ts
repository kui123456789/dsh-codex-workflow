import type { ProcessInstanceIdentity, ReasoningEffort, TurnNeedsInputResult, WorkflowRecord } from "../types.js";
import type { CodexChildSessionHandle } from "../codex-child-session.js";
import type { ReviewInput, ReviewEvidence, WorkflowRetryState } from "../types.js";
import type { PlannerRunIdentity } from "./planner-run-identity.js";
import type { ReviewerRunIdentity } from "./reviewer-run-identity.js";
import type { SubmissionReviewCheckpoint } from "./submission-review-checkpoint.js";
import type { ForegroundReviewCheckpoint } from "./foreground-review-checkpoint.js";
import type { PlannerRunCheckpoint } from "./planner-run-checkpoint.js";
import type { CodexTurnReceiptPendingError } from "../pending-turn-receipt.js";

export interface ActiveWorkflowTurn {
  threadId: string;
  threadOwner?: object;
  turnId: string;
  kind: "planner" | "reviewer";
  ephemeral: boolean;
  /** Private conversion/alignment forks are not the original visible thread. */
  internal?: boolean;
}

export interface RecoverableWorkflowRun {
  state: WorkflowRetryState;
  threadId: string;
  /** Original SDK registration and transport; never rebuilt from a text ID. */
  threadOwner?: object;
  child?: CodexChildSessionHandle;
  input?: ReviewInput;
  evidence?: ReviewEvidence;
  /** Short submitted clarification answers retained for an interrupted reply. */
  answersPrompt?: string;
  /** Original immutable Planner scope, never rebuilt from a changed record. */
  plannerIdentity?: PlannerRunIdentity;
  /** Successful Planner stages and the budget belong to its original process. */
  plannerCheckpoint?: PlannerRunCheckpoint;
  /** Immutable original review scope plus the currently waiting attempt. */
  reviewerIdentity?: ReviewerRunIdentity;
  /** Effective native turn choices, including an intentionally omitted model. */
  reviewerSettings?: ReviewerRunSettings;
  /** Finished readable/structured stages in the original Reviewer process. */
  reviewCheckpoint?: ForegroundReviewCheckpoint;
  /** One automatic continuation budget for the whole business review round. */
  automaticContinuations?: 0 | 1;
  /** Original server turn whose interruption has not been confirmed. */
  interruptionTurnId?: string;
  /** Original contract/registration failure retained while cleanup is pending. */
  terminalFailure?: string;
  /** Original submitted operation retained after its observer ended. */
  pendingStart?: CodexTurnReceiptPendingError;
  pendingStartIntent?: "cancel" | "terminal";
  /** Native input owns this run's child and pin after receipt adoption. */
  metadataOnly?: boolean;
  /** Lifecycle claimed this pending start's round after real cleanup proof. */
  receiptCleanupClaimed?: boolean;
  originalProcessId?: number;
  originalProcessIds?: readonly number[];
  originalProcessIdentities?: readonly ProcessInstanceIdentity[];
  cleanupTarget?: { threadId: string; turnId: string };
  cleanupThreadOwner?: object;
  terminalCleanupFlight?: Promise<boolean>;
  /** An unconfirmed private pair is not the original visible Reviewer turn. */
  auxiliaryInterruption?: { threadId: string; turnId: string };
  /** The original private execution, including after its map entry is removed. */
  auxiliaryInterruptionOwner?: RetainedAuxiliaryTurn;
}

export interface ReviewerRunSettings {
  readonly model?: string;
  readonly effort: ReasoningEffort;
}

export interface PlannerInputRun {
  plannerIdentity: PlannerRunIdentity;
  threadId: string;
  threadOwner?: object;
  child?: CodexChildSessionHandle;
  /** Clarification answers keep the same workflow continuation budget. */
  plannerCheckpoint?: PlannerRunCheckpoint;
  /** Present only for a confirmed native request in the original open turn. */
  pending?: TurnNeedsInputResult;
}

/** A private model turn awaiting termination, never a visible continuation. */
export interface RetainedAuxiliaryTurn {
  workflowId: string;
  threadId: string;
  threadOwner?: object;
  turnId: string;
  originalProcessId?: number;
  originalProcessIds?: readonly number[];
  originalProcessIdentities?: readonly ProcessInstanceIdentity[];
  cleanupFlight?: Promise<void>;
}

/** Mutable in-process lifecycle state shared by the application flows. */
export class WorkflowRuntimeState {
  readonly pending = new Map<string, TurnNeedsInputResult>();
  readonly nudgedTurns = new Set<string>();
  readonly recovering = new Set<string>();
  readonly recoveringNotices = new Set<string>();
  readonly activeTurns = new Map<string, ActiveWorkflowTurn>();
  readonly auxiliaryTurns = new Map<string, RetainedAuxiliaryTurn>();
  /** Confirmation belongs to the actual execution, never a reusable address. */
  readonly auxiliaryConfirmations = new WeakSet<RetainedAuxiliaryTurn>();
  readonly auxiliaryInterruptionOwners = new WeakMap<object, RetainedAuxiliaryTurn>();
  readonly terminalConfirmations = new WeakMap<RecoverableWorkflowRun, Set<string>>();
  readonly submissionReviewResults = new Map<string, SubmissionReviewCheckpoint>();
  readonly foreground = new Set<Promise<unknown>>();
  readonly backgroundTasks = new Set<Promise<unknown>>();
  readonly submissionControllers = new Map<string, AbortController>();
  readonly reviewHeartbeats = new Map<string, NodeJS.Timeout>();
  readonly cleanupNotes = new Map<string, string[]>();
  readonly codexChildSessions = new Map<string, CodexChildSessionHandle>();
  /** Cleanup claims survive map removal without retaining finished children. */
  readonly disposingChildren = new WeakSet<CodexChildSessionHandle>();
  /** Process-local continuation handles for ephemeral Planner/Reviewer runs. */
  readonly recoverableRuns = new Map<string, RecoverableWorkflowRun>();
  readonly plannerInputs = new Map<string, PlannerInputRun>();
  readonly inputFlights = new Map<string, Promise<WorkflowRecord>>();
  readonly inputAnswers = new Map<string, string>();
  readonly inputControllers = new Map<string, AbortController>();
  /** One admitted continuation per workflow; lifecycle owns its cancellation. */
  readonly resumeFlights = new Map<string, Promise<WorkflowRecord>>();
  readonly resumeControllers = new Map<string, AbortController>();
  readonly resumeInstructions = new Map<string, string>();
  /** One admitted foreground business review per workflow. */
  readonly reviewFlights = new Map<string, Promise<WorkflowRecord>>();
  readonly reviewInputs = new Map<string, string>();
  readonly reviewControllers = new Map<string, AbortController>();
  stopped = false;
  stopPromise?: Promise<void>;
  readonly lifecycleController = new AbortController();
  recoveryChain?: Promise<void>;
  activeRecovery = false;
}

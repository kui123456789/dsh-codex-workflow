import type { SubmitVerdictCommand } from "./bridge-protocol.js";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type WorkflowMode = "planned" | "review_only";

/** How the workflow was started: by this DSH session (legacy tools) or by the
 * Codex-led bridge. Old records default to "dsh". */
export type WorkflowOrigin = "dsh" | "codex_bridge";

/** Durable state of the callback that forks/resumes the independent Reviewer. */
export type CallbackState = "idle" | "queued" | "sending" | "waiting_verdict" | "retrying" | "failed";

/** Per-submission lifecycle inside a bridge workflow. */
export type SubmissionState =
  | "queued"         // submit persisted, callback not yet spawned
  | "sending"        // callback child is running
  | "waiting_verdict" // callback finished, verdict not yet received (legacy)
  | "retrying"       // callback hit a retryable condition, backing off
  | "verdict_ready"  // verdict obtained and staged in the record; enqueue pending
  | "received"       // structured verdict received and queued for application
  | "applied"        // verdict applied to the workflow (outcome persisted)
  | "delivered"      // outcome relayed to the original DSH session
  | "failed";        // terminal callback/verdict failure; workflow stays intact

export interface ReviewInput {
  implementationSummary: string;
  changedFiles?: string[];
  testResults?: string;
}

export type WorkflowPhase =
  | "planning"
  | "waiting_input"
  | "executing"
  | "reviewing"
  | "fixing"
  | "waiting_review_decision"
  | "passed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface PlannerQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  allowOther: boolean;
  secret: boolean;
}

export interface PlannerResult {
  status: "ready" | "needs_input" | "failed";
  planMarkdown?: string;
  questions: PlannerQuestion[];
  assumptions: string[];
  message?: string;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  blocking: boolean;
  title: string;
  body: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  verdict: "pass" | "changes_requested";
  findings: ReviewFinding[];
  testGaps: string[];
  summary: string;
}

/**
 * Auditable evidence of what the workspace looked like when a review ran.
 * `kind: "git"` evidence comes from `git status --porcelain=v1` plus the full
 * `git diff HEAD` stream; `kind: "files"` evidence hashes the files listed in
 * `changedFiles` without a git repository. `fingerprint` is a stable SHA-256
 * covering both the status summary and the full (untruncated) diff/content so
 * that staged, unstaged, deleted, renamed and untracked changes all move it.
 */
export interface ReviewEvidence {
  kind: "git" | "files";
  changedFiles: string[];
  status: string;
  diff: string;
  diffTruncated: boolean;
  diffBytes: number;
  fingerprint: string;
  fileHashes: Array<{ path: string; sha256: string }>;
  missingFiles: string[];
  rejectedPaths: string[];
  /** True when there was no reliable way to observe workspace changes (e.g. no
   * git repository and no changedFiles); no-change detection is disabled then. */
  insufficient: boolean;
}

export interface ReviewDecision {
  decision: "accept" | "fix";
  note?: string;
  decidedAt: string;
}

export interface WorkflowRecord {
  schemaVersion: 1;
  id: string;
  /** Monotonic write counter used by the SQLite revision-CAS; every persisted
   * write bumps it. Optional for records written by older versions. */
  revision?: number;
  dshSessionId: string;
  cwd: string;
  task: string;
  /** Optional for records written by older versions; defaults to "planned". */
  mode?: WorkflowMode;
  phase: WorkflowPhase;
  createdAt: string;
  updatedAt: string;
  plannerThreadId?: string;
  plannerTurnId?: string;
  /** Read-only source thread that hosted the first detached review (review-only
   * workflows); kept for diagnostics and restart recovery. */
  sourceThreadId?: string;
  reviewerThreadId?: string;
  reviewerTurnId?: string;
  /** Effective reviewer model/effort, persisted so review-only overrides
   * survive into later repair rounds. Optional for old records. */
  reviewerModel?: string;
  reviewerEffort?: ReasoningEffort;
  planMarkdown?: string;
  assumptions: string[];
  questions: PlannerQuestion[];
  pendingInput?: {
    turnId: string;
    itemId: string;
  };
  reviewCycles: number;
  /** Optional for records written by older versions; defaults to 0. */
  noChangeReviewRounds?: number;
  latestReview?: ReviewResult;
  latestReviewEvidence?: ReviewEvidence;
  previousReviewFingerprint?: string;
  reviewDecision?: ReviewDecision;
  error?: string;
  /** Bridge-originated workflows: the external Codex task this workflow is
   * bound to and the queue request that started it. Optional for old records. */
  origin?: WorkflowOrigin;
  codexThreadId?: string;
  bridgeRequestId?: string;
  /** Delivery progress of a bridge dispatch: `prepared` after the workflow
   * exists, `delivered` after the followup was sent. Used as an idempotency
   * checkpoint so crash replays never duplicate a workflow. */
  bridgeDeliveryState?: "prepared" | "delivered";
  callbackState?: CallbackState;
  callbackAttempts?: number;
  callbackError?: string;
  /** The last DSH submission awaiting the Codex verdict callback. */
  pendingReviewRequest?: ReviewInput;
  /** Identity and durable state of the current submission. One unfinished
   * submission per workflow; every callback/verdict update is conditional on
   * this id so stale cycles and late verdicts can never apply. */
  submissionId?: string;
  submissionState?: SubmissionState;
  submissionAttempts?: number;
  submissionError?: string;
  /** Earliest wall-clock time at which the persistent callback recovery loop
   * may start another bounded retry round after the Codex task was busy. */
  submissionRetryAt?: number;
  /** Idempotency checkpoint for verdict application/replay. */
  appliedVerdictRequestId?: string;
  appliedVerdictSubmissionId?: string;
  /** The workspace fingerprint the applied verdict was verified against. Kept
   * until delivery so a workspace change after apply (e.g. while the DSH
   * session is offline) invalidates the verdict before it is reported. */
  appliedVerdictEvidenceFingerprint?: string;
  /** Durable two-phase verdict pipeline: the FULL verdict command (identity +
   * payload, including requestId and createdAt) is staged here BEFORE it is
   * enqueued, so a crash between staging and enqueueing is recovered by
   * re-enqueueing the exact same command — identical requestId, createdAt and
   * commandHash — never by minting a new one. The staged identity is kept
   * until the verdict is APPLIED, so a manual verdict answering the same
   * submission with a different request id is refused while the expected
   * verdict is pending. */
  stagedVerdict?: {
    command: SubmitVerdictCommand;
    createdAt: string;
  };
  /** Fenced submission callback lease: the random owner token/epoch and
   * expiry of the process currently running (or last running) the Reviewer
   * callback. Recovery and re-claims verify these, so an old owner
   * can never interfere with a new owner's claim and a live callback is never
   * double-spawned. */
  submissionLeaseToken?: string;
  submissionLeaseEpoch?: number;
  submissionLeaseUntil?: number;
}

export interface WorkflowConfig {
  codexCommand: string;
  plannerModel: string;
  reviewerModel: string;
  plannerEffort: ReasoningEffort;
  reviewerEffort: ReasoningEffort;
  maxReviewCycles: number;
  maxNoChangeReviewRounds: number;
  reviewDiffMaxBytes: number;
  bridgePollMs: number;
  bridgeMaxPayloadBytes: number;
  callbackTimeoutMs: number;
  callbackMaxAttempts: number;
  callbackRetryBaseMs: number;
  /** Lease lifetime for submission callback claims (ms); heartbeats renew at
   * ttl/3 while a callback runs. Default 60000. */
  leaseTtlMs?: number;
  turnTimeoutMs: number;
  idleProcessMs: number;
  storageDir: string;
}

export interface TurnQuestionRequest {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: PlannerQuestion[];
}

export interface TurnCompleteResult {
  kind: "completed";
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  text: string;
  error?: string;
}

export interface TurnNeedsInputResult {
  kind: "needs_input";
  threadId: string;
  turnId: string;
  request: TurnQuestionRequest;
}

export type TurnWaitResult = TurnCompleteResult | TurnNeedsInputResult;

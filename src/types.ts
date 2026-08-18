export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type WorkflowMode = "planned" | "review_only";

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
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type WorkflowPhase =
  | "planning"
  | "waiting_input"
  | "executing"
  | "reviewing"
  | "fixing"
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

export interface WorkflowRecord {
  schemaVersion: 1;
  id: string;
  dshSessionId: string;
  cwd: string;
  task: string;
  phase: WorkflowPhase;
  createdAt: string;
  updatedAt: string;
  plannerThreadId?: string;
  plannerTurnId?: string;
  reviewerThreadId?: string;
  reviewerTurnId?: string;
  planMarkdown?: string;
  assumptions: string[];
  questions: PlannerQuestion[];
  pendingInput?: {
    turnId: string;
    itemId: string;
  };
  reviewCycles: number;
  latestReview?: ReviewResult;
  error?: string;
}

export interface WorkflowConfig {
  codexCommand: string;
  plannerModel: string;
  reviewerModel: string;
  plannerEffort: ReasoningEffort;
  reviewerEffort: ReasoningEffort;
  maxReviewCycles: number;
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

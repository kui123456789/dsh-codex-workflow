import type { ProcessIdentity, ProcessTree } from "./process.js";

export type WorkflowPhase = "planning" | "waiting_input" | "executing" | "reviewing" | "fixing" | "waiting_review_decision" | "passed" | "blocked" | "failed" | "cancelled";
export interface ReviewEvidence {
  kind: "git" | "files";
  baseRevision?: string;
  changedFiles: string[];
  status: string;
  diff: string;
  diffTruncated: boolean;
  diffBytes: number;
  fingerprint: string;
  fileHashes: Array<{ path: string; sha256: string }>;
  missingFiles: string[];
  rejectedPaths: string[];
  insufficient: boolean;
}
export interface PlannerResult {
  status: "ready" | "needs_input" | "failed";
  planMarkdown: string;
  questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }>; allowOther: boolean; secret: boolean }>;
  assumptions: string[];
  message: string;
}
export interface ReviewResult {
  verdict: "pass" | "changes_requested";
  findings: Array<{ severity: "critical" | "high" | "medium" | "low"; blocking: boolean; title: string; body: string; file: string | null; line: number | null }>;
  testGaps: string[];
  summary: string;
}
export interface Settings {
  plannerModel?: string;
  reviewerModel?: string;
  plannerEffort?: string;
  reviewerEffort?: string;
  turnTimeoutMs: number;
  transientRetryBudgetMs: number;
  maxReviewCycles: number;
  maxNoChangeReviewRounds: number;
}
export interface ReviewInput { implementationSummary: string; changedFiles?: string[]; testResults?: string }
export interface Operation {
  id: string;
  stage: "planning" | "reviewing";
  input: Record<string, unknown>;
  threadId?: string;
  worker?: ProcessIdentity;
  tree?: ProcessTree;
  startedAt: number;
  finished: boolean;
  spawnRequested: boolean;
  evidence?: ReviewEvidence;
  failureReason?: string;
  recoverable?: boolean;
  cleanupConfirmed?: boolean;
}
export interface WorkflowRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  cwd: string;
  task: string;
  requestKey: string;
  mode: "planned" | "review_only";
  phase: WorkflowPhase;
  processState: "running" | "waiting" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  settings: Settings;
  codexCommand: string;
  codexArgs: string[];
  plannerThreadId?: string;
  reviewerThreadId?: string;
  plan?: PlannerResult;
  review?: ReviewResult;
  evidence?: ReviewEvidence;
  reviewInput?: ReviewInput;
  reviewCycles: number;
  noChangeReviewRounds: number;
  previousFingerprint?: string;
  operation?: Operation;
  error?: string;
  decision?: "accept" | "fix";
}

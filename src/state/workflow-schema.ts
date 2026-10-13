import type { WorkflowRecord, WorkflowTerminalCleanupMarker } from "../types.js";
import { isCompleteProcessIdentityEvidence } from "../infrastructure/process-transport.js";

type JsonObject = Record<string, unknown>;

export interface WorkflowRecordV2 {
  schemaVersion: 2;
  identity: JsonObject;
  planning: JsonObject;
  execution: JsonObject;
  review: JsonObject;
  submission: JsonObject;
  bridge: JsonObject;
  desktop: JsonObject;
  extensions: JsonObject;
}

const GROUPS: Record<Exclude<keyof WorkflowRecordV2, "schemaVersion">, readonly string[]> = {
  identity: ["id", "revision", "dshSessionId", "cwd", "createdAt", "updatedAt", "mode", "origin"],
  planning: ["task", "plannerThreadId", "plannerTurnId", "plannerModel", "plannerEffort", "sourceThreadId", "planMarkdown", "assumptions", "questions", "pendingInput"],
  execution: ["phase", "processState", "retryState", "reviewFailureReason", "observedUsage", "reviewStartedAt", "lastProgressAt", "activeTurnId", "reviewAttempt", "reviewElapsedMs", "reviewPhaseTimings", "lastProgressMessage", "error"],
  review: ["reviewerThreadId", "reviewerThreadOrigin", "reviewerTurnId", "reviewerModel", "reviewerEffort", "reviewCycles", "reviewStep", "noChangeReviewRounds", "reviewContractFailures", "latestReviewConflict", "latestReview", "latestReviewEvidence", "previousReviewFingerprint", "reviewDecision"],
  submission: ["pendingReviewRequest", "submissionId", "submissionState", "submissionAttempts", "submissionReviewPending", "submissionError", "submissionCallbackReason", "submissionRetryAt", "appliedVerdictRequestId", "appliedVerdictSubmissionId", "appliedVerdictEvidenceFingerprint", "stagedVerdict", "submissionNotice", "submissionLeaseToken", "submissionLeaseEpoch", "submissionLeaseUntil"],
  bridge: ["codexThreadId", "bridgeRequestId", "bridgeDeliveryState", "callbackState", "callbackAttempts", "callbackError"],
  desktop: ["desktopOpenState", "desktopOpenSubmissionId", "desktopOpenAttempts", "desktopOpenNextAt", "desktopOpenError"],
  extensions: [],
};

const groupByKey = new Map<string, keyof WorkflowRecordV2>();
for (const [group, keys] of Object.entries(GROUPS) as Array<[keyof WorkflowRecordV2, readonly string[]]>) {
  for (const key of keys) groupByKey.set(key, group);
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

const RETRY_STAGES = new Set(["planning", "reviewing"]);
const PLANNER_CHECKPOINT_STEPS = new Set(["visible", "conversion", "completion", "corrected_conversion", "finalizing"]);
const REVIEW_CHECKPOINT_STEPS = new Set(["conversion", "alignment", "reconciliation", "finalizing"]);

/**
 * Validate the persisted portion of a process-local continuation checkpoint.
 *
 * Older rows may contain only interruption evidence, so fields introduced by
 * later recovery iterations remain optional here. When present, however, a
 * field must have the exact shape expected by the runtime. A malformed retry
 * marker must fail closed at the storage boundary; otherwise status/resume
 * could mistake corrupt data for permission to continue an unrelated turn.
 */
function validateRetryState(record: JsonObject): JsonObject {
  if (record.retryState === undefined) return record;
  if (!record.retryState || typeof record.retryState !== "object" || Array.isArray(record.retryState)) {
    throw new Error("invalid workflow retry state");
  }
  const retry = record.retryState as JsonObject;
  if (retry.stage !== undefined && (typeof retry.stage !== "string" || !RETRY_STAGES.has(retry.stage))) {
    throw new Error("invalid workflow retry stage");
  }
  if (retry.reason !== undefined && typeof retry.reason !== "string") {
    throw new Error("invalid workflow retry reason");
  }
  if (retry.attempts !== undefined
    && (!Number.isSafeInteger(retry.attempts) || Number(retry.attempts) < 1)) {
    throw new Error("invalid workflow retry attempts");
  }
  for (const field of ["awaitingContinuation", "awaitingStartReceipt", "awaitingCleanup"] as const) {
    if (retry[field] !== undefined && typeof retry[field] !== "boolean") {
      throw new Error(`invalid workflow retry ${field} marker`);
    }
  }
  if (retry.terminalFailure !== undefined && typeof retry.terminalFailure !== "string") {
    throw new Error("invalid workflow retry terminal failure");
  }
  const plannerCheckpoint = retry.plannerCheckpoint;
  if (plannerCheckpoint !== undefined) {
    if (!plannerCheckpoint || typeof plannerCheckpoint !== "object" || Array.isArray(plannerCheckpoint)
      || typeof (plannerCheckpoint as JsonObject).nextStep !== "string"
      || !PLANNER_CHECKPOINT_STEPS.has((plannerCheckpoint as JsonObject).nextStep as string)) {
      throw new Error("invalid Planner retry checkpoint");
    }
  }
  const reviewCheckpoint = retry.reviewCheckpoint;
  if (reviewCheckpoint !== undefined) {
    if (!reviewCheckpoint || typeof reviewCheckpoint !== "object" || Array.isArray(reviewCheckpoint)
      || typeof (reviewCheckpoint as JsonObject).nextStep !== "string"
      || !REVIEW_CHECKPOINT_STEPS.has((reviewCheckpoint as JsonObject).nextStep as string)) {
      throw new Error("invalid Reviewer retry checkpoint");
    }
  }
  return record;
}

export function isWorkflowTerminalCleanupMarker(value: unknown): value is WorkflowTerminalCleanupMarker {
  const marker = object(value);
  return typeof marker.token === "string" && marker.token.length > 0 && marker.token.trim() === marker.token
    && typeof marker.sessionId === "string" && marker.sessionId.length > 0 && marker.sessionId.trim() === marker.sessionId
    && typeof marker.epoch === "number" && Number.isSafeInteger(marker.epoch) && marker.epoch > 0;
}

function validateTerminalCleanup(record: JsonObject): JsonObject {
  validateRetryState(record);
  const retry = object(record.retryState);
  if (retry.awaitingStartReceipt !== undefined) {
    if (typeof retry.awaitingStartReceipt !== "boolean") throw new Error("invalid awaiting start receipt marker");
    if (["pendingStart", "operation", "requestId", "requestToken", "sourceThreadId", "sourceThreadOwner", "threadId", "turnId"]
      .some((key) => retry[key] !== undefined)) throw new Error("start receipt handles must remain process-local");
  }
  const marker = retry.terminalCleanup;
  if (marker !== undefined && !isWorkflowTerminalCleanupMarker(marker)) {
    throw new Error("invalid terminal cleanup generation marker");
  }
  const interruption = object(retry.interruption);
  if (interruption.processIdentities !== undefined && !isCompleteProcessIdentityEvidence(interruption)) {
    throw new Error("invalid original process identity evidence");
  }
  return record;
}

/** Convert the old flat record into the versioned nested envelope. */
export function serializeWorkflowRecord(record: WorkflowRecord): string {
  validateTerminalCleanup(record as unknown as JsonObject);
  const groups: Record<string, JsonObject> = {
    identity: {}, planning: {}, execution: {}, review: {}, submission: {}, bridge: {}, desktop: {}, extensions: {},
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === "schemaVersion") continue;
    const group = groupByKey.get(key) ?? "extensions";
    groups[group]![key] = value;
  }
  const envelope: WorkflowRecordV2 = {
    schemaVersion: 2,
    identity: groups.identity!,
    planning: groups.planning!,
    execution: groups.execution!,
    review: groups.review!,
    submission: groups.submission!,
    bridge: groups.bridge!,
    desktop: groups.desktop!,
    extensions: groups.extensions!,
  };
  return JSON.stringify(envelope);
}

/** Decode v1 or v2 storage into the flat compatibility record used by flows. */
export function deserializeWorkflowRecord(raw: unknown): JsonObject {
  const value = object(raw);
  const version = value.schemaVersion;
  if (version === 2) {
    const flat: JsonObject = { schemaVersion: 1 };
    for (const group of Object.keys(GROUPS)) Object.assign(flat, object(value[group]));
    return validateTerminalCleanup(flat);
  }
  if (version === 1 || version === undefined) return validateTerminalCleanup({ ...value, schemaVersion: 1 });
  throw new Error(`unsupported workflow schemaVersion ${String(version)}`);
}

/** Pure v1 -> v2 migration. Applying it twice returns the same envelope. */
export function migrateWorkflowRecord(raw: unknown): WorkflowRecordV2 {
  const value = object(raw);
  if (value.schemaVersion === 2) {
    deserializeWorkflowRecord(value);
    return value as unknown as WorkflowRecordV2;
  }
  const flat = deserializeWorkflowRecord(value) as unknown as WorkflowRecord;
  return JSON.parse(serializeWorkflowRecord(flat)) as WorkflowRecordV2;
}

/** Read a raw coordination row without exposing the storage envelope. */
export function parseWorkflowJson(recordJson: string): JsonObject {
  return deserializeWorkflowRecord(JSON.parse(recordJson));
}

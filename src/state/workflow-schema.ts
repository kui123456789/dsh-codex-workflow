import type { WorkflowRecord } from "../types.js";

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
  planning: ["task", "plannerThreadId", "plannerTurnId", "plannerModel", "sourceThreadId", "planMarkdown", "assumptions", "questions", "pendingInput"],
  execution: ["phase", "processState", "reviewStartedAt", "lastProgressAt", "activeTurnId", "reviewAttempt", "reviewElapsedMs", "reviewPhaseTimings", "lastProgressMessage", "error"],
  review: ["reviewerThreadId", "reviewerThreadOrigin", "reviewerTurnId", "reviewerModel", "reviewerEffort", "reviewCycles", "reviewStep", "noChangeReviewRounds", "reviewContractFailures", "latestReviewConflict", "latestReview", "latestReviewEvidence", "previousReviewFingerprint", "reviewDecision"],
  submission: ["pendingReviewRequest", "submissionId", "submissionState", "submissionAttempts", "submissionError", "submissionCallbackReason", "submissionRetryAt", "appliedVerdictRequestId", "appliedVerdictSubmissionId", "appliedVerdictEvidenceFingerprint", "stagedVerdict", "submissionNotice", "submissionLeaseToken", "submissionLeaseEpoch", "submissionLeaseUntil"],
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

/** Convert the old flat record into the versioned nested envelope. */
export function serializeWorkflowRecord(record: WorkflowRecord): string {
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
    return flat;
  }
  if (version === 1 || version === undefined) return { ...value, schemaVersion: 1 };
  throw new Error(`unsupported workflow schemaVersion ${String(version)}`);
}

/** Pure v1 -> v2 migration. Applying it twice returns the same envelope. */
export function migrateWorkflowRecord(raw: unknown): WorkflowRecordV2 {
  const value = object(raw);
  if (value.schemaVersion === 2) return value as unknown as WorkflowRecordV2;
  const flat = deserializeWorkflowRecord(value) as unknown as WorkflowRecord;
  return JSON.parse(serializeWorkflowRecord(flat)) as WorkflowRecordV2;
}

/** Read a raw coordination row without exposing the storage envelope. */
export function parseWorkflowJson(recordJson: string): JsonObject {
  return deserializeWorkflowRecord(JSON.parse(recordJson));
}

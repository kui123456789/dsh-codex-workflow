import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ReviewResult } from "./types.js";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_MAX_PAYLOAD_BYTES = 1024 * 1024;

export type BridgeCommand = DispatchPlanCommand | SubmitVerdictCommand | SubmissionNoticeCommand | DesktopControlCommand;

export interface DispatchPlanCommand {
  version: 1;
  kind: "dispatch_plan";
  requestId: string;
  createdAt: string;
  codexThreadId: string;
  target: { dshSessionId?: string; cwd: string };
  task: string;
  planMarkdown: string;
  assumptions: string[];
}

export interface SubmitVerdictCommand {
  version: 1;
  kind: "submit_verdict";
  requestId: string;
  createdAt: string;
  workflowId: string;
  codexThreadId: string;
  /** The submission this verdict answers; missing means the legacy manual
   * `respond` path, which is only accepted when the workflow has no active
   * submission. */
  submissionId?: string;
  /** The DSH session that owns the workflow (written by producers so the
   * right runtime routes/claims the verdict). Optional for legacy commands. */
  dshSessionId?: string;
  verdict: ReviewResult;
}

export interface SubmissionNoticeCommand {
  version: 1;
  kind: "submission_notice";
  requestId: string;
  createdAt: string;
  workflowId: string;
  submissionId: string;
  codexThreadId: string;
  dshSessionId: string;
  level: "error";
  message: string;
}

/** Lifecycle commands handled inside the existing Desktop, never a second host. */
export interface DesktopControlCommand {
  version: 1;
  kind: "desktop_control";
  requestId: string;
  createdAt: string;
  codexThreadId: string;
  target: { cwd: string; dshSessionId?: string };
  action: "ensure_session" | "read_session" | "followup" | "cancel" | "result";
  preset?: string;
  workflowId?: string;
  message?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const VERDICTS = new Set(["pass", "changes_requested"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(label: string): never {
  throw new Error(`invalid bridge command: ${label}`);
}

function requireString(value: unknown, label: string, nonEmpty: boolean): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (nonEmpty && value.length === 0) fail(`${label} must not be empty`);
  return value;
}

function requireUuid(value: unknown, label: string): string {
  const text = requireString(value, label, true);
  if (!UUID_RE.test(text)) fail(`${label} must be a UUID`);
  return text;
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireString(value, label, true);
  if (Number.isNaN(Date.parse(text))) fail(`${label} must be an ISO timestamp`);
  return text;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${label} must be an array of strings`);
  }
  return value;
}

function parseTarget(value: unknown): { dshSessionId?: string; cwd: string } {
  if (!isPlainObject(value)) fail("target must be an object");
  const cwd = requireString(value.cwd, "target.cwd", true);
  const cwdPath = cwd.replace(/\//g, "\\");
  if (!posix.isAbsolute(cwd) && !/^[a-zA-Z]:\\/.test(cwdPath)) fail("target.cwd must be an absolute path");
  const result: { dshSessionId?: string; cwd: string } = { cwd };
  if (value.dshSessionId !== undefined) {
    result.dshSessionId = requireString(value.dshSessionId, "target.dshSessionId", true);
  }
  for (const key of Object.keys(value)) {
    if (key !== "cwd" && key !== "dshSessionId") fail(`unknown target field ${key}`);
  }
  return result;
}

export function parseReviewResult(value: unknown): ReviewResult {
  if (!isPlainObject(value)) fail("verdict must be an object");
  const verdict = value.verdict;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) fail("verdict must be pass or changes_requested");
  if (!Array.isArray(value.findings)) fail("verdict.findings must be an array");
  const findings = value.findings.map((item) => {
    if (!isPlainObject(item)) fail("finding must be an object");
    const severity = item.severity;
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) fail("finding severity is invalid");
    if (typeof item.blocking !== "boolean") fail("finding blocking must be a boolean");
    const title = requireString(item.title, "finding.title", true);
    const body = requireString(item.body, "finding.body", true);
    const result: ReviewResult["findings"][number] = {
      severity: severity as ReviewResult["findings"][number]["severity"],
      blocking: item.blocking,
      title,
      body,
    };
    if (item.file !== undefined && item.file !== null) result.file = requireString(item.file, "finding.file", false);
    if (item.line !== undefined && item.line !== null) {
      if (typeof item.line !== "number" || !Number.isInteger(item.line)) fail("finding.line must be an integer");
      result.line = item.line;
    }
    for (const key of Object.keys(item)) {
      if (!["severity", "blocking", "title", "body", "file", "line"].includes(key)) {
        fail(`unknown finding field ${key}`);
      }
    }
    return result;
  });
  const testGaps = requireStringArray(value.testGaps, "verdict.testGaps");
  const summary = requireString(value.summary, "verdict.summary", false);
  for (const key of Object.keys(value)) {
    if (!["verdict", "findings", "testGaps", "summary"].includes(key)) fail(`unknown verdict field ${key}`);
  }
  return { verdict: verdict as ReviewResult["verdict"], findings, testGaps, summary };
}

export function parseDispatchPlanCommand(value: unknown): DispatchPlanCommand {
  if (!isPlainObject(value)) fail("dispatch_plan must be an object");
  if (value.version !== BRIDGE_PROTOCOL_VERSION) fail("unsupported version");
  if (value.kind !== "dispatch_plan") fail("kind must be dispatch_plan");
  const command: DispatchPlanCommand = {
    version: 1,
    kind: "dispatch_plan",
    requestId: requireUuid(value.requestId, "requestId"),
    createdAt: requireIsoDate(value.createdAt, "createdAt"),
    codexThreadId: requireUuid(value.codexThreadId, "codexThreadId"),
    target: parseTarget(value.target),
    task: requireString(value.task, "task", true),
    planMarkdown: requireString(value.planMarkdown, "planMarkdown", true),
    assumptions: requireStringArray(value.assumptions, "assumptions"),
  };
  for (const key of Object.keys(value)) {
    if (!["version", "kind", "requestId", "createdAt", "codexThreadId", "target", "task", "planMarkdown", "assumptions"].includes(key)) {
      fail(`unknown dispatch_plan field ${key}`);
    }
  }
  return command;
}

export function parseSubmitVerdictCommand(value: unknown): SubmitVerdictCommand {
  if (!isPlainObject(value)) fail("submit_verdict must be an object");
  if (value.version !== BRIDGE_PROTOCOL_VERSION) fail("unsupported version");
  if (value.kind !== "submit_verdict") fail("kind must be submit_verdict");
  const command: SubmitVerdictCommand = {
    version: 1,
    kind: "submit_verdict",
    requestId: requireUuid(value.requestId, "requestId"),
    createdAt: requireIsoDate(value.createdAt, "createdAt"),
    workflowId: requireString(value.workflowId, "workflowId", true),
    codexThreadId: requireUuid(value.codexThreadId, "codexThreadId"),
    ...(value.submissionId !== undefined
      ? { submissionId: requireUuid(value.submissionId, "submissionId") }
      : {}),
    ...(value.dshSessionId !== undefined
      ? { dshSessionId: requireString(value.dshSessionId, "dshSessionId", true) }
      : {}),
    verdict: parseReviewResult(value.verdict),
  };
  for (const key of Object.keys(value)) {
    if (!["version", "kind", "requestId", "createdAt", "workflowId", "codexThreadId", "submissionId", "dshSessionId", "verdict"].includes(key)) {
      fail(`unknown submit_verdict field ${key}`);
    }
  }
  return command;
}

export function parseSubmissionNoticeCommand(value: unknown): SubmissionNoticeCommand {
  if (!isPlainObject(value)) fail("submission_notice must be an object");
  if (value.version !== BRIDGE_PROTOCOL_VERSION) fail("unsupported version");
  if (value.kind !== "submission_notice") fail("kind must be submission_notice");
  if (value.level !== "error") fail("level must be error");
  const command: SubmissionNoticeCommand = {
    version: 1,
    kind: "submission_notice",
    requestId: requireUuid(value.requestId, "requestId"),
    createdAt: requireIsoDate(value.createdAt, "createdAt"),
    workflowId: requireString(value.workflowId, "workflowId", true),
    submissionId: requireUuid(value.submissionId, "submissionId"),
    codexThreadId: requireUuid(value.codexThreadId, "codexThreadId"),
    dshSessionId: requireString(value.dshSessionId, "dshSessionId", true),
    level: "error",
    message: requireString(value.message, "message", true),
  };
  for (const key of Object.keys(value)) {
    if (!["version", "kind", "requestId", "createdAt", "workflowId", "submissionId", "codexThreadId", "dshSessionId", "level", "message"].includes(key)) {
      fail(`unknown submission_notice field ${key}`);
    }
  }
  return command;
}

export function parseDesktopControlCommand(value: unknown): DesktopControlCommand {
  if (!isPlainObject(value)) fail("desktop_control must be an object");
  if (value.version !== 1 || value.kind !== "desktop_control") fail("invalid desktop_control envelope");
  const action = value.action;
  if (action !== "ensure_session" && action !== "read_session" && action !== "followup" && action !== "cancel" && action !== "result") fail("unknown desktop action");
  const command: DesktopControlCommand = {
    version: 1, kind: "desktop_control", action,
    requestId: requireUuid(value.requestId, "requestId"),
    createdAt: requireIsoDate(value.createdAt, "createdAt"),
    codexThreadId: requireUuid(value.codexThreadId, "codexThreadId"),
    target: parseTarget(value.target),
  };
  if (action === "ensure_session" || action === "read_session") {
    command.preset = requireString(value.preset, "preset", true);
    if (command.target.dshSessionId) fail("dedicated session identity is derived from source/cwd/preset");
    if (value.workflowId !== undefined || value.message !== undefined) fail("unexpected session control payload");
  } else {
    command.workflowId = requireUuid(value.workflowId, "workflowId");
    if (value.preset !== undefined) fail("unexpected workflow preset");
    if (action === "followup") command.message = requireString(value.message, "message", true);
    else if (value.message !== undefined) fail("unexpected workflow message");
  }
  for (const key of Object.keys(value)) {
    if (!["version", "kind", "requestId", "createdAt", "codexThreadId", "target", "action", "preset", "workflowId", "message"].includes(key)) fail(`unknown desktop_control field ${key}`);
  }
  return command;
}

export function parseBridgeCommand(value: unknown): BridgeCommand {
  if (!isPlainObject(value)) fail("command must be an object");
  if (value.version !== BRIDGE_PROTOCOL_VERSION) fail("unsupported version");
  if (value.kind === "desktop_control") return parseDesktopControlCommand(value);
  if (value.kind === "dispatch_plan") return parseDispatchPlanCommand(value);
  if (value.kind === "submit_verdict") return parseSubmitVerdictCommand(value);
  if (value.kind === "submission_notice") return parseSubmissionNoticeCommand(value);
  fail(`unknown kind ${String(value.kind)}`);
}

export function encodeBridgeCommand(command: BridgeCommand, maxBytes = BRIDGE_MAX_PAYLOAD_BYTES): string {
  const text = JSON.stringify(command);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`bridge command payload exceeds ${maxBytes} bytes`);
  }
  return text;
}

export function newRequestId(): string {
  return randomUUID();
}

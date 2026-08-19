import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  encodeBridgeCommand,
  newRequestId,
  parseBridgeCommand,
  parseDispatchPlanCommand,
  parseSubmissionNoticeCommand,
  parseSubmitVerdictCommand,
  type DispatchPlanCommand,
  type SubmissionNoticeCommand,
  type SubmitVerdictCommand,
} from "../src/bridge-protocol.js";

const uuid = () => newRequestId();

function dispatchPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "dispatch_plan",
    requestId: uuid(),
    createdAt: "2026-08-18T08:00:00.000Z",
    codexThreadId: uuid(),
    target: { cwd: "C:\\Users\\张三\\project with spaces" },
    task: "实现一个搜索功能",
    planMarkdown: "<proposed_plan>\n步骤一：修改 src/search.ts\n步骤二：补充测试\n</proposed_plan>",
    assumptions: ["测试环境可用"],
    ...overrides,
  };
}

function verdict(): Record<string, unknown> {
  return {
    verdict: "changes_requested",
    findings: [
      { severity: "high", blocking: true, title: "缺陷", body: "需要修复", file: "src/a.ts", line: 10 },
      { severity: "low", blocking: false, title: "改进", body: "可优化", file: null, line: null },
    ],
    testGaps: ["补充单元测试"],
    summary: "总体通过，有少量问题",
  };
}

function submitVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "submit_verdict",
    requestId: uuid(),
    createdAt: "2026-08-18T09:00:00.000Z",
    workflowId: "wf-abc-123",
    codexThreadId: uuid(),
    verdict: verdict(),
    ...overrides,
  };
}

function submissionNotice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "submission_notice",
    requestId: uuid(),
    createdAt: "2026-08-19T09:00:00.000Z",
    workflowId: "wf-abc-123",
    submissionId: uuid(),
    codexThreadId: uuid(),
    dshSessionId: "session-1",
    level: "error",
    message: "Codex Reviewer failed: source task is invalid",
    ...overrides,
  };
}

test("parses a valid Chinese dispatch plan with a Windows cwd", () => {
  const command = parseBridgeCommand(dispatchPlan()) as DispatchPlanCommand;
  assert.equal(command.kind, "dispatch_plan");
  assert.equal(command.version, 1);
  assert.match(command.task, /搜索/);
  assert.match(command.planMarkdown, /proposed_plan/);
  assert.match(command.target.cwd, /^C:\\Users\\张三\\project with spaces$/);
  assert.deepEqual(command.assumptions, ["测试环境可用"]);
  assert.ok(/^[0-9a-f-]{36}$/i.test(command.requestId));
  assert.ok(/^[0-9a-f-]{36}$/i.test(command.codexThreadId));
});

test("parses a valid verdict with an explicit dshSessionId target", () => {
  const dispatch = parseDispatchPlanCommand(dispatchPlan({ target: { cwd: "D:\\work", dshSessionId: "session-1" } }));
  assert.equal(dispatch.target.dshSessionId, "session-1");
  const command = parseBridgeCommand(submitVerdict()) as SubmitVerdictCommand;
  assert.equal(command.kind, "submit_verdict");
  assert.equal(command.verdict.verdict, "changes_requested");
  assert.equal(command.verdict.findings[0]?.blocking, true);
  assert.equal(command.verdict.findings[0]?.file, "src/a.ts");
  assert.equal(command.verdict.findings[1]?.line, undefined);
});

test("parses a durable terminal submission notice", () => {
  const command = parseBridgeCommand(submissionNotice()) as SubmissionNoticeCommand;
  assert.equal(command.kind, "submission_notice");
  assert.equal(command.level, "error");
  assert.match(command.message, /Reviewer failed/);
  assert.deepEqual(parseSubmissionNoticeCommand(command), command);
});

test("rejects unknown top-level and nested fields", () => {
  assert.throws(() => parseBridgeCommand(dispatchPlan({ extra: 1 })), /unknown dispatch_plan field extra/);
  assert.throws(() => parseBridgeCommand(submitVerdict({ extra: 1 })), /unknown submit_verdict field extra/);
  assert.throws(() => parseBridgeCommand(submissionNotice({ extra: 1 })), /unknown submission_notice field extra/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ target: { cwd: "C:\\x", bogus: true } })), /unknown target field bogus/);
  assert.throws(() => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), extra: 1 } })), /unknown verdict field extra/);
});

test("rejects missing fields and non-plain objects", () => {
  const { task: _task, ...noTask } = dispatchPlan();
  assert.throws(() => parseBridgeCommand(noTask), /task must be a string/);
  assert.throws(() => parseBridgeCommand(null), /must be an object/);
  assert.throws(() => parseBridgeCommand([1, 2]), /must be an object/);
  assert.throws(() => parseBridgeCommand("text"), /must be an object/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ planMarkdown: "" })), /planMarkdown must not be empty/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ task: "" })), /task must not be empty/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ target: { cwd: "relative/path" } })), /absolute Windows path/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ target: {} })), /target\.cwd/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ requestId: "not-a-uuid" })), /must be a UUID/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ codexThreadId: "nope" })), /must be a UUID/);
  assert.throws(() => parseBridgeCommand(dispatchPlan({ createdAt: "yesterday" })), /ISO timestamp/);
});

test("rejects invalid review severity, blocking and content values", () => {
  assert.throws(
    () => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), verdict: "maybe" } })),
    /verdict must be pass or changes_requested/,
  );
  assert.throws(
    () => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), findings: [{ severity: "fatal", blocking: true, title: "t", body: "b" }] } })),
    /severity is invalid/,
  );
  assert.throws(
    () => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), findings: [{ severity: "high", blocking: "yes", title: "t", body: "b" }] } })),
    /blocking must be a boolean/,
  );
  assert.throws(
    () => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), findings: [{ severity: "high", blocking: true, title: "", body: "b" }] } })),
    /title must not be empty/,
  );
  assert.throws(
    () => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), findings: [{ severity: "high", blocking: true, title: "t", body: "b", line: 1.5 }] } })),
    /line must be an integer/,
  );
  assert.throws(
    () => parseBridgeCommand(submitVerdict({ verdict: { ...verdict(), testGaps: "not-an-array" } })),
    /testGaps must be an array/,
  );
});

test("rejects oversized payloads on encode", () => {
  const big = dispatchPlan({ task: "x".repeat(BRIDGE_MAX_PAYLOAD_BYTES) });
  const command = parseDispatchPlanCommand(big);
  assert.throws(() => encodeBridgeCommand(command, BRIDGE_MAX_PAYLOAD_BYTES), /exceeds .* bytes/);
});

test("encode and parse round-trip a plan and a verdict", () => {
  const plan = parseDispatchPlanCommand(dispatchPlan());
  const planJson = encodeBridgeCommand(plan);
  assert.deepEqual(parseBridgeCommand(JSON.parse(planJson)), plan);

  const submit = parseSubmitVerdictCommand(submitVerdict());
  const submitJson = encodeBridgeCommand(submit);
  assert.deepEqual(parseBridgeCommand(JSON.parse(submitJson)), submit);

  const notice = parseSubmissionNoticeCommand(submissionNotice());
  const noticeJson = encodeBridgeCommand(notice);
  assert.deepEqual(parseBridgeCommand(JSON.parse(noticeJson)), notice);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import {
  newRequestId,
  type BridgeCommand,
  type SubmissionNoticeCommand,
  type SubmitVerdictCommand,
} from "../src/bridge-protocol.js";
import type { CodexCallbackResult } from "../src/codex-callback.js";
import { WorkflowStore } from "../src/store.js";
import {
  ALIGN_OUTPUT_SCHEMA,
  AUTHORITY_HIERARCHY,
  parseAlignment,
  reconciliationPreservationViolation,
  reviewAlignPrompt,
  reviewReconcilePrompt,
  type ReviewConflictEntry,
} from "../src/review-authority.js";
import type {
  PersistedTurnBaseline,
  ReviewResult,
  TurnNeedsInputResult,
  TurnWaitResult,
  WorkflowConfig,
  WorkflowRecord,
} from "../src/types.js";
import {
  WorkflowManager,
  type CodexCallback,
  type CodexGateway,
  plannerPrompt,
  reviewRequirementGate,
} from "../src/workflow.js";

// ---------------------------------------------------------------- fixtures

const config: WorkflowConfig = {
  codexCommand: "codex",
  autoTriggerMode: "complex",
  plannerModel: "",
  reviewerModel: "",
  plannerEffort: "high",
  reviewerEffort: "high",
  maxReviewCycles: 3,
  maxNoChangeReviewRounds: 1,
  reviewDiffMaxBytes: 65536,
  bridgePollMs: 1000,
  bridgeMaxPayloadBytes: 1048576,
  callbackTimeoutMs: 10_000,
  callbackMaxAttempts: 3,
  callbackRetryBaseMs: 200,
  turnTimeoutMs: 10_000,
  idleProcessMs: 0,
  terminalRelayTimeoutMs: 60_000,
  storageDir: "",
};

function manager(
  directory: string,
  gateway = new AuthorityGateway(),
  callback?: CodexCallback,
  queue?: { enqueue(command: BridgeCommand): Promise<string> },
): WorkflowManager {
  return new WorkflowManager(new WorkflowStore(directory), gateway, { ...config, storageDir: directory }, callback, queue);
}

function fakeExec(sessionId: string, cwd: string, deferred: unknown[]): ToolRunContext {
  return {
    agent: { id: sessionId, session: { header: { cwd } } },
    signal: new AbortController().signal,
    deferContext: (message: unknown) => deferred.push(message),
  } as unknown as ToolRunContext;
}

/** Extract the text of a deferred plugin message (the UserMessage object the
 * manager defers) for text assertions. */
function deferredText(message: unknown): string {
  if (!message || typeof message !== "object") return String(message);
  const content = (message as { content?: Array<{ text?: string }> }).content;
  const text = content?.map((entry) => entry.text ?? "").join("\n") ?? "";
  return text || String(message);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rmClosed(directory: string): Promise<void> {
  closeCoordinationStoresForDirectory(directory);
  await rm(directory, { recursive: true, force: true });
}

const DEFAULT_PLANNER_REPLY = [
  "# Goal",
  "实现安全的读写模块：输入校验、错误处理与单元测试。",
  "# Changes",
  "- src/index.ts：新增公共 API 与原子写入",
  "- src/errors.ts：稳定错误码",
  "- test/safe-file-store.test.ts：覆盖边界与失败路径",
  "# Verification",
  "- pnpm typecheck && pnpm test",
].join("\n");

const DEFAULT_RAW_REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 符合计划，测试通过";

/** A raw CHANGES_REQUESTED review whose finding violates the approved plan's
 * exact test-count/verification bounds (the 1.0.10 demo-smoke scenario). */
const RAW_OVERREACH_REVIEW = [
  "VERDICT: changes_requested",
  "FINDINGS: 1. [high, blocking] 必须把测试扩到 7 条: 已批准计划写明了恰好两条用例，但空字符串、纯空白与 CLI 行为还没有自动化回归断言：请补 greet('')、'\\t ' 与进程级 CLI 测试",
  "TEST GAPS: 缺少空字符串/空白字符串/CLI 的自动化回归测试",
  "SUMMARY: 覆盖不足，需要更多自动测试",
].join("\n");

const RAW_RECONCILED_REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 按权威层级修正：计划以真实命令验证 CLI，测试恰为两条，通过";

const ALIGN_CONFLICT = {
  aligned: false,
  conflicts: [
    {
      kind: "finding",
      index: 0,
      reason: "要求超出批准计划明确范围：计划限定恰好两条 node:test 用例并以真实命令验证 CLI",
      violated: "approved plan: exactly two test cases + real command verification (+ 恰好三条文件)",
      highSeverityException: false,
    },
    {
      kind: "testGap",
      index: 0,
      reason: "把计划指定的真实命令验证擅自升级为额外自动化测试要求",
      violated: "approved plan: CLI uses real command verification and exact test-count constraint",
      highSeverityException: false,
    },
  ],
};

const DEFAULT_ALIGN = { aligned: true, conflicts: [] };

/** Minimal fake: enough of the Codex gateway for the DSH-led review pipeline
 * and the authority path (alignment fork + reconciliation turn), routed by
 * prompt content so the canned outputs are deterministic. */
class AuthorityGateway implements CodexGateway {
  plannerReplies: string[] = [];
  plannerResults: Record<string, unknown>[] = [];
  rawReviewReplies: string[] = [];
  /** Normalized ReviewResult JSON, consumed by "Convert the readable code
   * review" forks (first the native review, then the reconciliation's). */
  reviewResults: ReviewResult[] = [];
  /** Alignment JSON, consumed by "REVIEW AUTHORITY checker" forks (first the
   * native alignment, then the re-alignment after reconciliation). */
  alignResults: Array<{ aligned: boolean; conflicts?: unknown[] }> = [];
  reconcileReplies: string[] = [];
  /** Visible reconciliation turns, recorded verbatim (thread + prompt). */
  reconcileCalls: Array<{ threadId: string; prompt: string }> = [];
  /** Number of alignment forks served ("REVIEW AUTHORITY checker" prompts). */
  alignServed = 0;
  /** Alignment fork prompts, recorded verbatim (asserted for the hierarchy
   * levels the prompt must carry: task/plan/previous review/fix summary). */
  alignPrompts: string[] = [];
  /** Number of reconciliation turns served. */
  reconcileServed = 0;
  /** The review/start custom target instructions (verbatim). */
  reviewTargets: string[] = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  private history = new Map<string, Array<{ id: string; text: string }>>();
  private counter = 0;

  async startThread(options: { cwd: string; name: string }): Promise<string> {
    return options.name.startsWith("DSH Review") ? "reviewer-thread" : "planner-thread";
  }

  async resumeThread(): Promise<void> {}

  async startReviewerThread(): Promise<string> {
    return "reviewer-thread";
  }

  async updateReviewerInstructions(): Promise<void> {}

  async resolveDefaultModel(): Promise<string | undefined> {
    return "fake-default-model";
  }

  private append(threadId: string, text: string): void {
    this.counter += 1;
    const history = this.history.get(threadId) ?? [];
    history.push({ id: `rollout-${this.counter}`, text });
    this.history.set(threadId, history);
  }

  async captureTurnBaseline(threadId: string): Promise<PersistedTurnBaseline> {
    return { ids: (this.history.get(threadId) ?? []).map((turn) => turn.id) };
  }

  async readAppendedTurnText(threadId: string, baseline: PersistedTurnBaseline): Promise<{ text: string } | undefined> {
    const before = new Set(baseline.ids);
    const added = (this.history.get(threadId) ?? []).filter((turn) => !before.has(turn.id));
    return added.length === 1 ? { text: added[0]!.text } : undefined;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
  }

  async startTurn(threadId: string, options: {
    prompt?: string;
    model?: string;
    effort?: string;
    outputSchema?: Record<string, unknown>;
    planMode?: boolean;
    silentReview?: boolean;
    onModel?: (model: string) => void;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }): Promise<TurnWaitResult> {
    if (options.silentReview) {
      // In this suite the only silent visible turn is the reconciliation turn
      // (all raw reviews are display-compliant, so no rewrite turn runs).
      const prompt = options.prompt ?? "";
      assert.match(prompt, /CONFLICTING ENTRIES/, "the silent visible turn must be the reconciliation turn");
      this.reconcileCalls.push({ threadId, prompt });
      this.reconcileServed += 1;
      const reply = this.reconcileReplies.shift() ?? RAW_RECONCILED_REVIEW;
      await options.onStarted?.({ threadId, turnId: `reconcile-${this.reconcileCalls.length}` });
      this.append(threadId, reply);
      return { kind: "completed", threadId, turnId: "reconcile-1", status: "completed", text: reply };
    }
    // Visible planner turn (only used to reach executing via start()).
    const reply = this.plannerReplies.shift() ?? DEFAULT_PLANNER_REPLY;
    options.onModel?.(options.model ?? "mode-model");
    if (options.onStarted) await options.onStarted({ threadId, turnId: "planner-turn-1" });
    return { kind: "completed", threadId, turnId: "planner-turn-1", status: "completed", text: reply };
  }

  async continueTurn(pending: TurnNeedsInputResult, _answers: Record<string, string[]>): Promise<TurnWaitResult> {
    return { kind: "completed", threadId: pending.threadId, turnId: pending.turnId, status: "completed", text: this.plannerReplies.shift() ?? DEFAULT_PLANNER_REPLY };
  }

  async normalizeInFork(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    model?: string;
    outputSchema?: Record<string, unknown>;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }): Promise<TurnWaitResult> {
    await options.onStarted?.({ threadId: "fork-thread", turnId: "fork-turn" });
    const prompt = options.prompt ?? "";
    if (prompt.includes("REVIEW AUTHORITY checker")) {
      this.alignServed += 1;
      this.alignPrompts.push(prompt);
      const next = this.alignResults.shift() ?? DEFAULT_ALIGN;
      return { kind: "completed", threadId: "fork-thread", turnId: "fork-turn", status: "completed", text: JSON.stringify(next) };
    }
    if (prompt.includes("Convert the readable code review")) {
      const review = this.reviewResults.shift() ?? { verdict: "pass", findings: [], testGaps: [], summary: "pass" };
      return { kind: "completed", threadId: "fork-thread", turnId: "fork-turn", status: "completed", text: JSON.stringify(review) };
    }
    return { kind: "completed", threadId: "fork-thread", turnId: "fork-turn", status: "completed", text: JSON.stringify(this.plannerResults.shift() ?? {
      status: "ready",
      planMarkdown: "<proposed_plan>\n实现安全读写模块\n</proposed_plan>",
      questions: [],
      assumptions: [],
    }) };
  }

  async startReview(options: {
    threadId: string;
    cwd: string;
    detached: boolean;
    target: { type: string; instructions?: string };
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }): Promise<{ threadId: string; result: TurnWaitResult }> {
    this.reviewTargets.push(options.target.instructions ?? "");
    if (options.onStarted) await options.onStarted({ threadId: options.threadId, turnId: "review-turn-1" });
    const raw = this.rawReviewReplies.shift() ?? DEFAULT_RAW_REVIEW;
    this.append(options.threadId, raw);
    return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId, turnId: "review-turn-1", status: "completed", text: raw } };
  }
}

/** Deterministic callback double for bridge submissions: hands a canned
 * verdict back and mirrors the real dispatcher's ownership callbacks. */
class QueueCallback implements CodexCallback {
  results: CodexCallbackResult[] = [];
  requests: Array<{ workflowId: string; submissionId: string; codexThreadId: string }> = [];

  async send(request: {
    workflowId: string;
    submissionId: string;
    codexThreadId: string;
    cwd: string;
    prompt: string;
    onThread?: (threadId: string) => Promise<void> | void;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
    onEphemeralStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }): Promise<CodexCallbackResult> {
    this.requests.push({ workflowId: request.workflowId, submissionId: request.submissionId, codexThreadId: request.codexThreadId });
    await request.onThread?.(request.codexThreadId);
    await request.onStarted?.({ threadId: request.codexThreadId, turnId: "review-turn-bg" });
    await request.onEphemeralStarted?.({ threadId: "fork-thread", turnId: "fork-turn" });
    const next = this.results.shift();
    if (next) return next;
    return { kind: "retryable_busy", reason: "no canned result" };
  }

  cancel(): void {}

  cancelSubmission(): void {}

  async stop(): Promise<void> {}
}

function fakeBridgeQueue(): {
  enqueue: (command: BridgeCommand) => Promise<string>;
  commands: SubmitVerdictCommand[];
  notices: SubmissionNoticeCommand[];
} {
  const commands: SubmitVerdictCommand[] = [];
  const notices: SubmissionNoticeCommand[] = [];
  return {
    commands,
    notices,
    enqueue: async (command) => {
      if (command.kind === "submit_verdict") commands.push(command);
      if (command.kind === "submission_notice") notices.push(command);
      return command.requestId;
    },
  };
}

const overreachingVerdict: ReviewResult = {
  verdict: "changes_requested",
  findings: [{
    severity: "high",
    blocking: true,
    title: "必须把测试扩到 7 条",
    body: "计划写明了恰好两条用例，但空字符串、纯空白与 CLI 行为缺少自动化回归断言",
    file: "demo-smoke/test/hello.test.mjs",
    line: 18,
  }],
  testGaps: ["缺少空字符串/空白字符串/CLI 的自动化回归测试"],
  summary: "覆盖不足，需要更多自动测试",
};

const passVerdict: ReviewResult = { verdict: "pass", findings: [], testGaps: [], summary: "按权威层级修正后通过" };

// ---------------------------------------------------------------- units

test("planner contract: never strengthen coverage language into an exact test-count limit", () => {
  const prompt = plannerPrompt("实现搜索功能，测试覆盖查询与空输入。");
  assert.match(prompt, /Do not invent constraints the user did not state/);
  assert.match(prompt, /exact test-COUNT restriction/);
  assert.match(prompt, /exactly two tests/);
  assert.match(prompt, /automated tests, static checks, or real command verification/);
});

test("review requirement gate follows the authority hierarchy and the plan's verification method", () => {
  const record = {
    id: "wf-1",
    task: "demo-smoke",
    planMarkdown: "<proposed_plan>…恰好两条 node:test 用例，CLI 用真实命令验证…</proposed_plan>",
  };
  const gate = reviewRequirementGate(record as never, false);
  assert.match(gate, /AUTHORITY HIERARCHY/);
  assert.match(gate, /REAL COMMAND verification/);
  assert.match(gate, /STATIC CHECKS/);
  assert.match(gate, /explicit file count, test count, scope, dependency limits/);
  assert.ok(!/BOTH an implementation AND a regression test/.test(gate), "the absolute code+test rule is gone");
  assert.ok(!/regression test of every explicit requirement/.test(gate));
});

test("align prompt carries the authority hierarchy, the task and the structured review", () => {
  const prompt = reviewAlignPrompt(passVerdict, { workflowId: "wf-1", task: "任务", planMarkdown: "计划" });
  assert.match(prompt, /REVIEW AUTHORITY checker/);
  assert.match(prompt, /AUTHORITY HIERARCHY/);
  assert.match(prompt, /wf-1/);
  assert.match(prompt, /ORIGINAL TASK/);
  assert.match(prompt, /"verdict"/);
});

test("reconcile prompt lists the conflicts and demands one final readable review with the four sections", () => {
  const prompt = reviewReconcilePrompt(overreachingVerdict, ALIGN_CONFLICT.conflicts as never, {
    workflowId: "wf-1",
    task: "任务",
    planMarkdown: "计划",
  });
  assert.match(prompt, /CONFLICTING ENTRIES/);
  assert.match(prompt, /finding #0/);
  assert.match(prompt, /violates: approved plan/);
  assert.match(prompt, /VERDICT: pass \| changes_requested/);
  assert.match(prompt, /Do NOT re-review/);
});

test("parseAlignment accepts aligned and conflict shapes and rejects malformed output", () => {
  assert.deepEqual(parseAlignment(JSON.stringify(DEFAULT_ALIGN), passVerdict), DEFAULT_ALIGN);
  const parsed = parseAlignment(JSON.stringify(ALIGN_CONFLICT), overreachingVerdict);
  assert.equal(parsed.aligned, false);
  assert.equal(parsed.conflicts.length, 2);
  assert.equal(parsed.conflicts[0]!.kind, "finding");
  assert.equal(parsed.conflicts[0]!.index, 0);
  assert.equal(parsed.conflicts[0]!.highSeverityException, false);
  assert.throws(
    () => parseAlignment(JSON.stringify({ aligned: false, conflicts: [{ kind: "bogus", index: 0 }] }), overreachingVerdict),
    /invalid conflict (entry|kind)|at least one conflict/,
  );
  assert.throws(() => parseAlignment('{"conflicts":[]}', passVerdict), /missing aligned/);
  assert.throws(() => parseAlignment("not json", passVerdict), SyntaxError);
});

test("parseAlignment rejects contradictory states and out-of-range conflict indexes", () => {
  assert.throws(
    () => parseAlignment(JSON.stringify({ ...DEFAULT_ALIGN, conflicts: ALIGN_CONFLICT.conflicts }), overreachingVerdict),
    /aligned=true.*conflicts/i,
  );
  assert.throws(
    () => parseAlignment(JSON.stringify({ aligned: false, conflicts: [] }), overreachingVerdict),
    /aligned=false.*conflict/i,
  );
  assert.throws(
    () => parseAlignment(JSON.stringify({
      aligned: false,
      conflicts: [{ ...ALIGN_CONFLICT.conflicts[0], index: 99 }],
    }), overreachingVerdict),
    /out of range/i,
  );
  assert.throws(
    () => parseAlignment(JSON.stringify({
      aligned: false,
      conflicts: [{ kind: "testGap", index: 99, reason: "bad", violated: "plan", highSeverityException: false }],
    }), overreachingVerdict),
    /out of range/i,
  );
});

test("the internal align schema carries aligned + conflicts and never changes the public review schema surface", () => {
  assert.deepEqual([...ALIGN_OUTPUT_SCHEMA.required], ["aligned", "conflicts"]);
  assert.equal(AUTHORITY_HIERARCHY.includes("data-corruption"), true);
});

// ---------------------------------------------------------------- pipeline

async function plannedWorkflow(instance: WorkflowManager, sessionId: string, directory: string, task: string): Promise<{ record: WorkflowRecord; deferred: unknown[] }> {
  const deferred: unknown[] = [];
  const exec = fakeExec(sessionId, directory, deferred);
  const record = await instance.start({ task }, exec);
  assert.equal(record.phase, "executing");
  return { record, deferred };
}

test("aligned review applies normally: one cycle, contract-failure streak reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-aligned-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-aa", directory, "任务");
    const after = await instance.review(record.id, { implementationSummary: "done" }, fakeExec("session-aa", directory, deferred));
    assert.equal(after.phase, "passed");
    assert.equal(after.reviewCycles, 1);
    assert.equal(after.reviewContractFailures, 0);
    assert.equal(after.latestReview?.verdict, "pass");
    assert.equal(after.latestReviewConflict, undefined);
    assert.equal(gateway.alignServed, 1, "one alignment fork ran on the aligned path");
    assert.equal(gateway.reconcileServed, 0);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("conflict + reconciled aligned applies the CORRECTED verdict in ONE business cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-reconciled-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-ar", directory, "任务");
    gateway.rawReviewReplies = [RAW_OVERREACH_REVIEW];
    gateway.reviewResults = [overreachingVerdict, passVerdict];
    gateway.alignResults = [ALIGN_CONFLICT, DEFAULT_ALIGN];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    const after = await instance.review(record.id, { implementationSummary: "done" }, fakeExec("session-ar", directory, deferred));
    assert.equal(after.phase, "passed");
    assert.equal(after.reviewCycles, 1, "reconciliation + re-alignment still count ONE business cycle");
    assert.equal(after.reviewContractFailures, 0, "an aligned review resets the streak");
    assert.equal(after.latestReview?.verdict, "pass", "the corrected verdict is what got applied");
    assert.ok(after.latestReviewConflict, "the conflict is recorded for status");
    assert.equal(after.latestReviewConflict!.reconciled, true);
    assert.equal(after.latestReviewConflict!.resolved, true);
    assert.equal(gateway.reconcileServed, 1);
    // The reconciliation ran on the SAME durable task (the workflow planner task).
    assert.equal(gateway.reconcileCalls[0]!.threadId, after.plannerThreadId);
    assert.match(gateway.reconcileCalls[0]!.prompt, /finding #0/);
    assert.match(gateway.reconcileCalls[0]!.prompt, /approved plan: exactly two test cases/);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("unresolved conflict restores the prior phase: no latestReview, no cycle, no fix prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-conflict-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-ac", directory, "任务");
    gateway.rawReviewReplies = [RAW_OVERREACH_REVIEW];
    gateway.reviewResults = [overreachingVerdict, overreachingVerdict];
    gateway.alignResults = [ALIGN_CONFLICT, ALIGN_CONFLICT];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    const after = await instance.review(record.id, { implementationSummary: "done" }, fakeExec("session-ac", directory, deferred));
    assert.equal(after.phase, "executing", "pre-review phase restored — never fixing");
    assert.equal(after.reviewCycles, 0, "no consumed cycle");
    assert.equal(after.latestReview, undefined, "no latestReview for a refused review");
    assert.equal(after.reviewContractFailures, 1);
    assert.match(after.error ?? "", /contract conflict/);
    assert.ok(after.latestReviewConflict && !after.latestReviewConflict.resolved);
    assert.ok(deferred.some((message) => /Codex planning is complete/.test(deferredText(message))), "the plan relay message is present");
    assert.ok(!deferred.some((message) => /Fix every finding|finish the fixes|requested changes/.test(deferredText(message))),
      "no fix instruction was injected for a contract conflict");
    assert.equal(gateway.reconcileServed, 1, "exactly ONE auto-correction attempt");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("two consecutive unresolved conflicts BLOCK the workflow without consuming business cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-blocked-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-ab", directory, "任务");
    for (let round = 1; round <= 2; round += 1) {
      gateway.rawReviewReplies = [RAW_OVERREACH_REVIEW];
      gateway.reviewResults = [overreachingVerdict, overreachingVerdict];
      gateway.alignResults = [ALIGN_CONFLICT, ALIGN_CONFLICT];
      gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
      const after = await instance.review(record.id, { implementationSummary: `fix round ${round}` }, fakeExec("session-ab", directory, deferred));
      if (round === 1) {
        assert.equal(after.phase, "executing");
        assert.equal(after.reviewContractFailures, 1);
      } else {
        assert.equal(after.phase, "blocked");
        assert.equal(after.reviewContractFailures, 2);
        assert.match(after.error ?? "", /contract failure/);
      }
      assert.equal(after.reviewCycles, 0, "contract conflicts never consume business cycles");
      assert.equal(after.latestReview, undefined);
    }
    assert.ok(deferred.some((message) => /REVIEWER CONTRACT FAILURE/.test(deferredText(message))), "the blocked path reports the contract failure");
    assert.ok(!deferred.some((message) => /Fix every finding/.test(deferredText(message))), "never a fix instruction");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("demo-smoke regression: overreaching automated-test demand is refused and reconciled on the SAME task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-demo-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const deferred: unknown[] = [];
    const planned = await instance.start({ task: "新建 demo-smoke：三个文件、恰好两条 node:test 用例，CLI 以真实命令验证；不装依赖；不要过度设计" }, fakeExec("session-ad", directory, deferred));
    gateway.rawReviewReplies = [RAW_OVERREACH_REVIEW];
    gateway.reviewResults = [overreachingVerdict, passVerdict];
    gateway.alignResults = [ALIGN_CONFLICT, DEFAULT_ALIGN];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    const after = await instance.review(planned!.id, { implementationSummary: "三个文件已创建，npm test 全绿，CLI 真实输出已验证" }, fakeExec("session-ad", directory, deferred));
    assert.equal(after.phase, "passed", "the plan-conformant implementation passes without adding tests");
    assert.equal(after.reviewCycles, 1);
    assert.equal(after.latestReview?.verdict, "pass");
    assert.equal(gateway.reconcileCalls[0]!.threadId, after.plannerThreadId, "reconciliation reused the SAME durable task");
    assert.ok(deferred.some((message) => /passed workflow/.test(deferredText(message))));
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

// ---------------------------------------------------------------- bridge path

async function bridgeWorkflow(instance: WorkflowManager, sessionId: string, directory: string): Promise<WorkflowRecord> {
  const exec = fakeExec(sessionId, directory, []);
  await writeFile(join(directory, "changed.txt"), "v1", "utf8");
  return instance.startExternalPlan({
    version: 1,
    kind: "dispatch_plan",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    codexThreadId: newRequestId(),
    target: { cwd: directory, dshSessionId: sessionId },
    task: "Bridge 任务",
    planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
    assumptions: [],
  }, exec.agent!);
}

test("bridge path: unresolved conflict fails the submission WITHOUT staging a verdict or a fix prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-bridge-conflict-"));
  const gateway = new AuthorityGateway();
  const callback = new QueueCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, gateway, callback, queue);
  try {
    const exec = fakeExec("session-bc", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-bc", directory);
    callback.results = [{ kind: "verdict", verdict: overreachingVerdict }];
    gateway.reviewResults = [overreachingVerdict, overreachingVerdict]; // the reconciliation remains conflicted and must not stage a verdict
    gateway.alignResults = [ALIGN_CONFLICT, ALIGN_CONFLICT];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    assert.equal(submitted.submissionState, "queued");
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "failed");
    const after = (await store.load(bridge.id))!;
    assert.equal(queue.commands.length, 0, "a conflicting verdict is never staged/enqueued");
    assert.equal(queue.notices.length, 1, "the contract-failure diagnostic is delivered (never a fix prompt)");
    assert.match(queue.notices[0]!.message, /无需修改代码/);
    assert.equal(after.reviewCycles, 0);
    assert.equal(after.latestReview, undefined);
    assert.equal(after.reviewContractFailures, 1);
    assert.equal(after.phase, "executing", "restored, not fixing");
    assert.match(after.error ?? "", /contract conflict/);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("bridge path: reconciled aligned verdict is staged with the CORRECTED result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-bridge-ok-"));
  const gateway = new AuthorityGateway();
  const callback = new QueueCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, gateway, callback, queue);
  try {
    const exec = fakeExec("session-bo", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-bo", directory);
    callback.results = [{ kind: "verdict", verdict: overreachingVerdict }];
    gateway.reviewResults = [passVerdict, passVerdict];
    gateway.alignResults = [ALIGN_CONFLICT, DEFAULT_ALIGN];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    assert.equal(submitted.submissionState, "queued");
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "received");
    const after = (await store.load(bridge.id))!;
    assert.equal(queue.commands.length, 1, "the corrected verdict is staged");
    assert.equal(queue.commands[0]!.verdict.verdict, "pass");
    assert.ok(after.latestReviewConflict && after.latestReviewConflict.resolved, "the corrected round records the auto-correction");
    assert.equal(after.reviewContractFailures, 0);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

// ------------------------------------------------------- contract gaps (2nd review)

test("align prompt carries the PREVIOUSLY APPLIED review and this round's fix summary (level 4)", () => {
  const previous: ReviewResult = {
    verdict: "changes_requested",
    findings: [{ severity: "high", blocking: true, title: "必须修 A", body: "上一轮要求", file: "src/a.ts", line: 3 }],
    testGaps: [],
    summary: "上一轮意见",
  };
  const prompt = reviewAlignPrompt(passVerdict, {
    workflowId: "wf-1",
    task: "任务",
    planMarkdown: "计划",
    previousReview: previous,
    fixSummary: "本轮修复了 A",
  });
  assert.match(prompt, /PREVIOUSLY APPLIED REVIEW \(level 4/);
  assert.match(prompt, /必须修 A/, "the carried-forward finding is quoted verbatim");
  assert.match(prompt, /THIS ROUND'S DSH FIX SUMMARY/);
  assert.match(prompt, /本轮修复了 A/);
  assert.match(prompt, /stay aligned unless a HIGHER level contradicts them/);
});

test("DSH-led: a legitimately CARRIED-FORWARD finding stays aligned across repair rounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-carried-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-cc", directory, "任务：修复 X 并保证两条测试");
    // Round 1: the reviewer requires a fix; no conflict -> applied -> fixing.
    gateway.rawReviewReplies = [RAW_OVERREACH_REVIEW];
    gateway.reviewResults = [overreachingVerdict];
    gateway.alignResults = [DEFAULT_ALIGN];
    const round1 = await instance.review(record.id, { implementationSummary: "第一轮实现" }, fakeExec("session-cc", directory, deferred));
    assert.equal(round1.phase, "fixing");
    assert.equal(round1.reviewCycles, 1);
    assert.ok(round1.latestReview, "the carried finding is now the previously APPLIED review");
    assert.equal(gateway.alignPrompts[0]!.includes("PREVIOUSLY APPLIED REVIEW"), false, "round 1 has no previous review yet");
    // Round 2: the reviewer RESTATES the same finding (carried forward) while
    // DSH fixed it; the alignment prompt must carry level 4 (previous review +
    // this round's fix summary) so the model can judge it aligned — a generic
    // conflict misjudgment would block the legitimate repair loop.
    gateway.rawReviewReplies = [RAW_OVERREACH_REVIEW];
    gateway.reviewResults = [overreachingVerdict];
    gateway.alignResults = [DEFAULT_ALIGN];
    const round2 = await instance.review(record.id, { implementationSummary: "第二轮修复：已补上计划要求的实现并跑真实命令验证" }, fakeExec("session-cc", directory, deferred));
    assert.equal(round2.phase, "fixing");
    assert.equal(round2.reviewCycles, 2);
    assert.equal(round2.reviewContractFailures, 0);
    const round2Align = gateway.alignPrompts[1] ?? "";
    assert.match(round2Align, /PREVIOUSLY APPLIED REVIEW \(level 4/);
    assert.match(round2Align, /必须把测试扩到 7 条/, "the carried finding is quoted for the alignment");
    assert.match(round2Align, /THIS ROUND'S DSH FIX SUMMARY/);
    assert.match(round2Align, /第二轮修复/, "this round's implementation summary is quoted (fix summary)");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("bridge: conflict -> aligned -> conflict stays at ONE failure and never blocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-streak-"));
  const gateway = new AuthorityGateway();
  const callback = new QueueCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, gateway, callback, queue);
  try {
    const exec = fakeExec("session-st", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-st", directory);
    const store = new WorkflowStore(directory);
    const fixVerdict: ReviewResult = {
      verdict: "changes_requested",
      findings: [{ severity: "high", blocking: true, title: "需要修", body: "真实缺陷", file: "src/a.ts", line: 4 }],
      testGaps: [],
      summary: "请修复",
    };
    // Submission 1: unresolved conflict -> failures = 1, never staged.
    callback.results = [{ kind: "verdict", verdict: overreachingVerdict }];
    gateway.reviewResults = [overreachingVerdict, overreachingVerdict];
    gateway.alignResults = [ALIGN_CONFLICT, ALIGN_CONFLICT];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    await instance.submit(bridge.id, { implementationSummary: "done 1", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "failed");
    let after = (await store.load(bridge.id))!;
    assert.equal(after.reviewContractFailures, 1);
    assert.equal(queue.commands.length, 0);
    // Submission 2: an ALIGNED verdict resets the streak at staging time.
    callback.results = [{ kind: "verdict", verdict: fixVerdict }];
    gateway.alignResults = [DEFAULT_ALIGN];
    await instance.submit(bridge.id, { implementationSummary: "done 2", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "received");
    after = (await store.load(bridge.id))!;
    assert.equal(after.reviewContractFailures, 0, "an aligned bridge verdict clears the streak");
    assert.equal(queue.commands.length, 1);
    // Apply the staged verdict through the real outcome policy (simulated pump).
    const applied = await instance.applyExternalVerdict(queue.commands[0]!);
    assert.equal(applied.phase, "fixing");
    // Submission 3: ANOTHER unresolved conflict must count failures = 1 again
    // (non-consecutive), NOT 2 — the workflow must not be blocked.
    callback.results = [{ kind: "verdict", verdict: overreachingVerdict }];
    gateway.reviewResults = [overreachingVerdict, overreachingVerdict];
    gateway.alignResults = [ALIGN_CONFLICT, ALIGN_CONFLICT];
    gateway.reconcileReplies = [RAW_RECONCILED_REVIEW];
    await instance.submit(bridge.id, { implementationSummary: "done 3", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "failed");
    after = (await store.load(bridge.id))!;
    assert.equal(after.reviewContractFailures, 1, "non-consecutive conflicts never accumulate to the two-strike block");
    assert.notEqual(after.phase, "blocked", "the workflow must not be blocked by a non-consecutive conflict");
    assert.equal(after.phase, "fixing");
    assert.equal(after.reviewCycles, 1, "only the applied aligned round consumed a cycle");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

// ------------------------------------------------ reconciliation preservation (3rd review)

/** A mixed review: a REAL non-conflicting high blocking finding plus an
 * overreaching (conflict-listed) test gap. */
const mixedVerdict: ReviewResult = {
  verdict: "changes_requested",
  findings: [{
    severity: "high",
    blocking: true,
    title: "真实缺陷：空指针",
    body: "src/hello.mjs:7 对 null 输入未防护",
    file: "src/hello.mjs",
    line: 7,
  }],
  testGaps: ["缺少 CLI 自动化回归测试（计划以真实命令验证，属越界）"],
  summary: "混合意见",
};

const MIXED_ALIGN_CONFLICT = {
  aligned: false,
  conflicts: [{
    kind: "testGap",
    index: 0,
    reason: "计划以真实命令验证 CLI，自动化测试要求越界",
    violated: "approved plan: real command verification",
    highSeverityException: false,
  }],
};

const RAW_MIXED_REVIEW = [
  "VERDICT: changes_requested",
  "FINDINGS: 1. [high, blocking] 真实缺陷：空指针: src/hello.mjs:7 对 null 输入未防护",
  "TEST GAPS: 缺少 CLI 自动化回归测试（计划以真实命令验证，属越界）",
  "SUMMARY: 混合意见",
].join("\n");

/** A corrupted re-normalized verdict that silently drops the REAL finding. */
const corruptVerdict: ReviewResult = { verdict: "pass", findings: [], testGaps: [], summary: "重写后通过" };

/** A corrupted reconciliation reply that silently drops the REAL finding. */
const RAW_CORRUPT_RECONCILED_REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 重写后通过";

/** A faithful reconciliation reply that keeps the non-conflicting finding. */
const RAW_FAITHFUL_RECONCILED_REVIEW = [
  "VERDICT: changes_requested",
  "FINDINGS: 1. [high, blocking] 真实缺陷：空指针: src/hello.mjs:7 对 null 输入未防护",
  "TEST GAPS: none",
  "SUMMARY: 已按权威层级删除越界测试要求",
].join("\n");

test("preservation check: every non-conflicting finding/test gap must survive the rewrite EXACTLY", () => {
  const conflicted: ReviewConflictEntry[] = [{ kind: "testGap", index: 0, reason: "r", violated: "v", highSeverityException: false }];
  // Faithful rewrite (drop only the conflicted gap): no violation.
  const faithful: ReviewResult = {
    verdict: "changes_requested",
    findings: [...mixedVerdict.findings],
    testGaps: [],
    summary: "ok",
  };
  assert.equal(reconciliationPreservationViolation(mixedVerdict, conflicted, faithful), undefined);
  // Dropping the real finding is a violation.
  const dropped: ReviewResult = { verdict: "pass", findings: [], testGaps: [], summary: "ok" };
  assert.match(reconciliationPreservationViolation(mixedVerdict, conflicted, dropped) ?? "", /dropped a non-conflicting finding "真实缺陷：空指针"/);
  // Field-level tampering is a violation (blocking flipped).
  const tampered: ReviewResult = {
    verdict: "changes_requested",
    findings: [{ ...mixedVerdict.findings[0]!, blocking: false }],
    testGaps: [],
    summary: "ok",
  };
  assert.match(reconciliationPreservationViolation(mixedVerdict, conflicted, tampered) ?? "", /dropped a non-conflicting finding/);
  // Dropping a non-conflicting test gap is a violation.
  const gapOriginal: ReviewResult = { verdict: "changes_requested", findings: [], testGaps: ["gap-a", "gap-b"], summary: "" };
  const gapConflicts: ReviewConflictEntry[] = [{ kind: "testGap", index: 1, reason: "r", violated: "v", highSeverityException: false }];
  const gapDropped: ReviewResult = { verdict: "changes_requested", findings: [], testGaps: [], summary: "" };
  assert.match(reconciliationPreservationViolation(gapOriginal, gapConflicts, gapDropped) ?? "", /dropped a non-conflicting test gap "gap-a"/);
});

test("reconciliation prompt carries an explicit verbatim preservation manifest", () => {
  const conflicts: ReviewConflictEntry[] = [{ kind: "testGap", index: 0, reason: "r", violated: "v", highSeverityException: false }];
  const prompt = reviewReconcilePrompt(mixedVerdict, conflicts, { workflowId: "wf-manifest", task: "任务" });
  assert.match(prompt, /PRESERVATION MANIFEST.*NON-CONFLICTING FINDINGS/);
  assert.ok(prompt.includes(JSON.stringify(mixedVerdict.findings[0])), "all finding fields are embedded verbatim");
  assert.match(prompt, /AUTHORITY-CONFLICTING SOURCE ENTRIES/);
  assert.ok(prompt.includes(JSON.stringify(mixedVerdict.testGaps[0])), "the conflicting source gap is identified verbatim");
  assert.match(prompt, /do not summarize, rewrite, merge, split, omit/i);
  assert.match(prompt, /COMPLETE four-section review/);
});

test("preservation check rejects duplicate-count changes and unauthorized additions", () => {
  const gapConflict: ReviewConflictEntry[] = [{ kind: "testGap", index: 0, reason: "r", violated: "v", highSeverityException: false }];
  const duplicatedFinding: ReviewResult = {
    verdict: "changes_requested",
    findings: [mixedVerdict.findings[0]!, mixedVerdict.findings[0]!],
    testGaps: [],
    summary: "duplicate",
  };
  assert.match(reconciliationPreservationViolation(mixedVerdict, gapConflict, duplicatedFinding) ?? "", /unauthorized finding/);

  const duplicateGapOriginal: ReviewResult = { verdict: "changes_requested", findings: [], testGaps: ["keep", "remove"], summary: "" };
  const duplicateGapConflict: ReviewConflictEntry[] = [{ kind: "testGap", index: 1, reason: "r", violated: "v", highSeverityException: false }];
  const duplicatedGap: ReviewResult = { verdict: "changes_requested", findings: [], testGaps: ["keep", "keep"], summary: "" };
  assert.match(reconciliationPreservationViolation(duplicateGapOriginal, duplicateGapConflict, duplicatedGap) ?? "", /unauthorized test gap/);

  const findingConflict: ReviewConflictEntry[] = [{ kind: "finding", index: 0, reason: "r", violated: "v", highSeverityException: false }];
  const unauthorizedFinding: ReviewResult = {
    verdict: "changes_requested",
    findings: [{ ...mixedVerdict.findings[0]!, title: "全新且无来源的 finding", file: "src/new.ts", line: 99 }],
    testGaps: [...mixedVerdict.testGaps],
    summary: "new",
  };
  assert.match(reconciliationPreservationViolation(mixedVerdict, findingConflict, unauthorizedFinding) ?? "", /unauthorized finding/);
});

test("DSH-led: a reconciliation that DROPS a real non-conflicting finding is a hardened failure (retryable, no cycle, no verdict)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-preserve-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-pv", directory, "任务");
    gateway.rawReviewReplies = [RAW_MIXED_REVIEW];
    gateway.reviewResults = [mixedVerdict, corruptVerdict];
    gateway.alignResults = [MIXED_ALIGN_CONFLICT, DEFAULT_ALIGN];
    gateway.reconcileReplies = [RAW_CORRUPT_RECONCILED_REVIEW];
    await assert.rejects(
      instance.review(record.id, { implementationSummary: "已实现" }, fakeExec("session-pv", directory, deferred)),
      /dropped a non-conflicting finding/,
    );
    const after = (await new WorkflowStore(directory).load(record.id))!;
    // The corrupt reconcile must NOT apply: pre-review phase restored, no
    // latestReview, no cycle, no fix instruction.
    assert.equal(after.phase, "executing", "retryable phase restored — the corrupt verdict never applied");
    assert.equal(after.reviewCycles, 0);
    assert.equal(after.latestReview, undefined);
    assert.match(after.error ?? "", /dropped a non-conflicting finding/);
    assert.equal(gateway.reconcileServed, 1, "exactly ONE auto-correction attempt ran");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("DSH-led: a FAITHFUL reconciliation keeps the real finding and applies in ONE cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-preserve-ok-"));
  const gateway = new AuthorityGateway();
  const instance = manager(directory, gateway);
  try {
    const { record, deferred } = await plannedWorkflow(instance, "session-pvo", directory, "任务");
    gateway.rawReviewReplies = [RAW_MIXED_REVIEW];
    gateway.reviewResults = [mixedVerdict, mixedVerdict];
    gateway.alignResults = [MIXED_ALIGN_CONFLICT, DEFAULT_ALIGN];
    gateway.reconcileReplies = [RAW_FAITHFUL_RECONCILED_REVIEW];
    const after = await instance.review(record.id, { implementationSummary: "已实现" }, fakeExec("session-pvo", directory, deferred));
    assert.equal(after.phase, "fixing", "the preserved blocking finding keeps the repair loop");
    assert.equal(after.reviewCycles, 1);
    assert.equal(after.latestReview?.findings.length, 1);
    assert.equal(after.latestReview?.findings[0]!.title, "真实缺陷：空指针");
    assert.equal(after.latestReview?.findings[0]!.blocking, true);
    assert.equal(after.latestReview?.findings[0]!.line, 7);
    assert.ok(after.latestReviewConflict?.resolved, "the reconciliation is recorded as auto-corrected");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("bridge: a corrupt reconciliation result keeps the submission RETRYABLE with the concrete reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-preserve-bridge-"));
  const gateway = new AuthorityGateway();
  const callback = new QueueCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, gateway, callback, queue);
  try {
    const exec = fakeExec("session-pvb", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-pvb", directory);
    // The callback keeps answering with the mixed verdict so every retry
    // exercises the same authority path; the reconciliation's re-normalization
    // consumes the FIRST review-result entry (the corrupt one).
    callback.results = [
      { kind: "verdict", verdict: mixedVerdict },
      { kind: "verdict", verdict: mixedVerdict },
      { kind: "verdict", verdict: mixedVerdict },
    ];
    gateway.reviewResults = [corruptVerdict, corruptVerdict];
    gateway.alignResults = [MIXED_ALIGN_CONFLICT, DEFAULT_ALIGN];
    gateway.reconcileReplies = [RAW_CORRUPT_RECONCILED_REVIEW];
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "retrying");
    const after = (await store.load(bridge.id))!;
    assert.equal(queue.commands.length, 0, "the corrupt verdict was never staged");
    assert.match(after.submissionCallbackReason ?? "", /violated entry preservation/);
    assert.match(after.submissionError ?? "", /dropped a non-conflicting finding/);
    assert.equal(after.reviewCycles, 0);
    assert.equal(after.latestReview, undefined);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

// ------------------------------------- authority semantic matrix (4th review)

/** The approved plan's authority semantics, pinned at the CONTRACT level: the
 * alignment/review prompts must encode every matrix rule (M1-M5) so the
 * model-driven judgement has the exact plan semantics, and the surrounding
 * state machine must behave per the plan for each scenario. */
test("authority semantic matrix: contract text encodes M1-M5 rules", () => {
  // M1: CLI real-command verification must NOT be escalated into automated
  // test demands (conflicts for the alignment, forbidden for the Reviewer).
  const align = reviewAlignPrompt(passVerdict, { workflowId: "w", task: "t" });
  assert.match(align, /demands for automated tests of behavior the task\/plan verifies by real command runs or static checks, are conflicts/);
  assert.match(align, /the verification method the plan named — automated tests, static checks, or real command verification/);
  const gate = reviewRequirementGate({ id: "w", task: "t", planMarkdown: "<proposed_plan>p</proposed_plan>" } as never, false);
  assert.match(gate, /REAL COMMAND verification are ALL formal evidence/);
  assert.match(gate, /Missing automated tests alone are blocking ONLY when/);
  // M2: static checks / real command evidence satisfy file list + package.json
  // style requirements.
  assert.match(gate, /STATIC CHECKS/);
  assert.match(gate, /accept the plan's own verification method/);
  // M4: ONLY reproducible critical/high defects may cross the plan's bounds —
  // with concrete code evidence; generic suspicion is never evidence (M5).
  assert.match(align, /generic suspicion is never evidence/);
  assert.match(align, /REPRODUCIBLE critical\/high defect with concrete code evidence/);
  assert.match(gate, /level-1 exception may override ordinary scope\/test-count limits ONLY with concrete reproducible evidence/);
  // M5: generic quality suggestions never override plan bounds.
  assert.match(align, /Generic quality suggestions, and demands for automated tests of behavior the task\/plan verifies by real command runs or static checks, are conflicts/);
});

test("authority semantic matrix M3: a plan-mandated regression test missing stays aligned/blocking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-m3-"));
  const gateway = new AuthorityGateway();
  const callback = new QueueCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, gateway, callback, queue);
  try {
    const exec = fakeExec("session-m3", directory, []);
    await writeFile(join(directory, "changed.txt"), "v1", "utf8");
    const bridge = await instance.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: directory, dshSessionId: "session-m3" },
      task: "实现排序功能；PLAN 明确要求：必须为排序提供回归测试",
      planMarkdown: "<proposed_plan>\n实现 sort 模块；计划明确要求必须提供 main 逻辑的回归测试（缺少即为不合格）\n</proposed_plan>",
      assumptions: [],
    }, exec.agent!);
    const missingTestVerdict: ReviewResult = {
      verdict: "changes_requested",
      findings: [{ severity: "high", blocking: true, title: "计划明确要求的回归测试缺失", body: "计划要求为排序提供回归测试，但未实现", file: "src/sort.ts", line: 5 }],
      testGaps: [],
      summary: "按计划要求补测试",
    };
    callback.results = [{ kind: "verdict", verdict: missingTestVerdict }];
    gateway.alignResults = [DEFAULT_ALIGN];
    await instance.submit(bridge.id, { implementationSummary: "实现排序", changedFiles: ["changed.txt"] }, exec);
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "received");
    const after = (await store.load(bridge.id))!;
    assert.equal(queue.commands.length, 1);
    assert.equal(queue.commands[0]!.verdict.verdict, "changes_requested", "the plan-mandated test gap stays blocking");
    const applied = await instance.applyExternalVerdict(queue.commands[0]!);
    assert.equal(applied.phase, "fixing", "plan-mandated regression-test gap keeps the repair loop (aligned/blocking)");
    assert.equal(applied.reviewContractFailures, 0, "an aligned verdict never counts a conflict");
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("authority semantic matrix M4: a HIGH defect with concrete code evidence crosses the plan's ordinary bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-authority-m4-"));
  const gateway = new AuthorityGateway();
  const callback = new QueueCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, gateway, callback, queue);
  try {
    const exec = fakeExec("session-m4", directory, []);
    await writeFile(join(directory, "changed.txt"), "v1", "utf8");
    const bridge = await instance.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: directory, dshSessionId: "session-m4" },
      task: "实现余额扣减；计划限定只改两个文件",
      planMarkdown: "<proposed_plan>\n实现余额扣减，文件范围限定 src/account.ts 与 test/account.test.ts\n</proposed_plan>",
      assumptions: [],
    }, exec.agent!);
    // The finding demands a fix OUTSIDE the plan's file scope, but it is a
    // REPRODUCIBLE high-severity data-corruption defect with concrete
    // file:line evidence — the level-1 exception the authority must honor.
    const concreteDefect: ReviewResult = {
      verdict: "changes_requested",
      findings: [{
        severity: "high",
        blocking: true,
        title: "并发扣减可致余额为负（数据损坏）",
        body: "src/account.ts:12 的 read-modify-write 竞态：两个并发扣减均读到余额 100 后各写 50，终态错误；具体复现：Promise.all 并发发起两次扣减 50",
        file: "src/account.ts",
        line: 12,
      }],
      testGaps: [],
      summary: "修复并发竞态",
    };
    callback.results = [{ kind: "verdict", verdict: concreteDefect }];
    gateway.alignResults = [DEFAULT_ALIGN];
    await instance.submit(bridge.id, { implementationSummary: "实现扣减", changedFiles: ["changed.txt"] }, exec);
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(bridge.id))?.submissionState === "received");
    const after = (await store.load(bridge.id))!;
    assert.equal(queue.commands.length, 1);
    const applied = await instance.applyExternalVerdict(queue.commands[0]!);
    assert.equal(applied.phase, "fixing", "the reproducible high defect crosses the plan's file-scope bound (level-1 exception)");
    assert.equal(applied.latestReview?.findings[0]!.severity, "high");
    assert.equal(applied.reviewContractFailures, 0);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

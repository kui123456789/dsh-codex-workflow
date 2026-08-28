import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import { newRequestId, type BridgeCommand, type SubmissionNoticeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import {
  CodexCallbackProcessError,
  CodexInvalidThreadError,
  CodexNoVerdictError,
  type CodexCallbackResult,
} from "../src/codex-callback.js";
import { WorkflowStore } from "../src/store.js";
import { PLANNER_OUTPUT_SCHEMA } from "../src/schemas.js";
import type { PersistedTurnBaseline, ReviewResult, TurnNeedsInputResult, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway } from "../src/workflow.js";

interface ReviewStartCall {
  threadId: string;
  detached: boolean;
}

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

function deferredGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

class FakeGateway implements CodexGateway {
  reviewResults: ReviewResult[] = [];
  reviewThreads: string[] = [];
  reviewStarts: ReviewStartCall[] = [];
  /** review/start targets, recorded verbatim (1.0.7: EVERY path — Git and
   * non-Git alike — sends a custom target whose instructions carry the full
   * per-round context + review scope + item-by-item coverage gate; the native
   * uncommittedChanges target is never sent). */
  reviewTargets: Array<{ type: string; instructions?: string }> = [];
  threadCalls: Array<{ name: string; model?: string }> = [];
  /** Durable Reviewer thread creations (startReviewerThread). */
  reviewerThreadCalls: Array<{ name: string; model?: string; developerInstructions?: string }> = [];
  /** Per-round developer-instruction refreshes on re-reviews. */
  instructionCalls: Array<{ threadId: string; instructions: string }> = [];
  /** Visible persistent turns (startTurn). */
  turnCalls: Array<{ model?: string; effort?: string; schema?: Record<string, unknown> }> = [];
  /** Ephemeral conversion forks (normalizeInFork). */
  forkCalls: Array<{ threadId: string; model?: string; effort?: string; schema?: Record<string, unknown>; prompt?: string }> = [];
  /** Visible planner replies, consumed by startTurn (default: a complete
   * plan-like reply that passes the plugin's ready-plan gate). */
  plannerReplies: string[] = [];
  /** Raw texts of the VISIBLE native reviews returned by startReview,
   * consumed in order (default: a display-contract-compliant review). */
  rawReviewReplies: string[] = [];
  /** Visible replies of the DISPLAY-REWRITE turn (a visible non-plan
   * startTurn with silentReview), consumed in order (default: a
   * display-contract-compliant review). */
  rewriteReplies: string[] = [];
  /** Display-rewrite turns, recorded verbatim. */
  rewriteCalls: Array<{ threadId: string; model?: string; effort?: string; schema?: Record<string, unknown>; prompt?: string }> = [];
  /** Held after onStarted for the DISPLAY-REWRITE turn (rewrite pending). */
  rewriteGate?: DeferredGate;
  /** PERSISTED read-back text per RPC turn id (the display truth): overrides
   * the streamed text for display-contract tests; default = the streamed text. */
  readbackPersisted: Map<string, string> = new Map();
  /** RPC turn ids whose persisted turn is MISSING (missing/ambiguous
   * read-back: the server never persisted a rollout for the turn). */
  readbackMissing: Set<string> = new Set();
  /** Ids of the PERSISTED turns appended by the fake, which DELIBERATELY
   * differ from the RPC turn ids (real App Server evidence: the native
   * review/start RPC turn id never appears in the persisted rollout history).
   * Read-back must locate them via the baseline, never by id equality. */
  persistedReadbackIds: string[] = [];
  /** PERSISTED turn history per thread (rollout store the fake would have). */
  private persistedHistory: Map<string, Array<{ id: string; text: string }>> = new Map();
  private persistedCounter = 0;
  /** Structured planner results, consumed by normalizeInFork (default: ready). */
  plannerResults: Record<string, unknown>[] = [];
  /** 1.0.10 review-authority alignment results, consumed by the
   * "REVIEW AUTHORITY checker" fork prompt (default: aligned with no
   * conflicts, so the 300+ existing review flows keep their behavior). */
  alignResults: Array<{ aligned: boolean; conflicts?: unknown[] }> = [];
  /** Native first-turn clarification (when set, startTurn returns it instead of
   * a completed visible reply). */
  initialNeedsInput?: TurnNeedsInputResult;
  /** Queue of results for continueTurn (native re-clarifications or a final
   * completed visible reply). */
  continueResults: TurnWaitResult[] = [];
  /** Every continueTurn call's answers (all questions of that round). */
  continueAnswers: Array<Record<string, string[]>> = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  /** Held before onStarted fires for review/start (ids known, not persisted). */
  beforeReviewOnStarted?: DeferredGate;
  /** Held after onStarted for review/start (review pending). */
  reviewGate?: DeferredGate;
  /** Held after onStarted for a VISIBLE planner turn (planner pending). */
  turnGate?: DeferredGate;
  /** Held after onStarted for the planner COMPLETION turn (2nd+ startTurn). */
  completionGate?: DeferredGate;
  /** Held after onStarted for an EPHEMERAL conversion fork turn. */
  forkGate?: DeferredGate;
  private normalizeReview = false;
  private forkCount = 0;
  private startTurnCount = 0;

  async startThread(options: { cwd: string; name: string; model?: string }): Promise<string> {
    this.threadCalls.push({ name: options.name, ...(options.model ? { model: options.model } : {}) });
    return options.name.startsWith("DSH Review") ? "source-thread" : "planner-thread";
  }

  async resumeThread(threadId: string): Promise<void> {
    this.resumeCalls.push(threadId);
  }

  /** Thread ids resumed by the manager (start/continue/review flows). */
  resumeCalls: string[] = [];

  async startReviewerThread(options: { cwd: string; name: string; model?: string; developerInstructions?: string }): Promise<string> {
    this.reviewerThreadCalls.push({
      name: options.name,
      ...(options.model ? { model: options.model } : {}),
      ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
    });
    return "reviewer-thread";
  }

  async updateReviewerInstructions(threadId: string, cwd: string, instructions: string): Promise<void> {
    this.instructionCalls.push({ threadId, instructions });
  }

  async resolveDefaultModel(): Promise<string | undefined> {
    return "fake-default-model";
  }

  async startTurn(threadId: string, options?: { prompt?: string; model?: string; effort?: string; outputSchema?: Record<string, unknown>; planMode?: boolean; silentReview?: boolean; onModel?: (model: string) => void; onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<TurnWaitResult> {
    this.turnCalls.push({
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.effort ? { effort: options.effort } : {}),
      ...(options?.outputSchema ? { schema: options.outputSchema } : {}),
    });
    if (options?.silentReview) {
      // 1.0.7 DISPLAY-REWRITE turn: a visible (no schema) turn on the SAME
      // durable Reviewer task at low effort, holding the rewrite gate.
      this.rewriteCalls.push({
        threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.outputSchema ? { schema: options.outputSchema } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
      });
      const rewriteTurnId = "rewrite-turn-1";
      if (options.onStarted) {
        try {
          await options.onStarted({ threadId, turnId: rewriteTurnId });
        } catch (error) {
          await this.interrupt(threadId, rewriteTurnId).catch(() => undefined);
          throw error;
        }
      }
      if (this.rewriteGate) await this.rewriteGate.promise;
      const rewriteText = this.rewriteReplies.shift() ?? DEFAULT_RAW_REVIEW;
      this.appendPersistedTurn(threadId, "rewrite-turn-1", rewriteText);
      return { kind: "completed", threadId, turnId: "rewrite-turn-1", status: "completed", text: rewriteText };
    }
    // Distinct visible planner turn ids so tests can tell the completion turn
    // (2nd+ startTurn) apart from the first planning turn.
    this.startTurnCount += 1;
    const turnId = options?.planMode ? `planner-turn-${this.startTurnCount}` : "planner-turn-1";
    // Mirror the client: report the effective model (explicit or the Plan
    // collaboration mode's model) so the manager can persist and reuse it.
    options?.onModel?.(options.model ?? "mode-model");
    if (options?.onStarted) {
      try {
        await options.onStarted({ threadId, turnId });
      } catch (error) {
        await this.interrupt(threadId, turnId).catch(() => undefined);
        throw error;
      }
    }
    if (this.initialNeedsInput) {
      const paused = this.initialNeedsInput;
      this.initialNeedsInput = undefined;
      return paused;
    }
    if (this.turnGate && this.startTurnCount === 1) await this.turnGate.promise;
    else if (this.completionGate && this.startTurnCount > 1) await this.completionGate.promise;
    // 1.0.7: the VISIBLE planner turn replies with readable Markdown, never JSON.
    // The default must pass the plugin's ready-plan gate (complete plan text
    // with structured markers) so ordinary test flows never trigger the
    // completion-turn path unexpectedly.
    return completed(threadId, this.plannerReplies.shift()
      ?? DEFAULT_PLANNER_REPLY);
  }

  async continueTurn(pending: TurnNeedsInputResult, answers: Record<string, string[]>): Promise<TurnWaitResult> {
    this.continueAnswers.push(answers);
    const next = this.continueResults.shift();
    if (next) return next;
    return completed(pending.threadId, this.plannerReplies.shift()
      ?? "<proposed_plan>\nImplement the feature\n</proposed_plan>");
  }

  async normalizeInFork(options: { threadId: string; cwd?: string; prompt?: string; model?: string; effort?: string; outputSchema?: Record<string, unknown>; onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<TurnWaitResult> {
    this.forkCount += 1;
    const forkThreadId = `fork-thread-${this.forkCount}`;
    const forkTurnId = `fork-turn-${this.forkCount}`;
    this.forkCalls.push({
      threadId: options.threadId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.outputSchema ? { schema: options.outputSchema } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    });
    if (options.onStarted) {
      try {
        await options.onStarted({ threadId: forkThreadId, turnId: forkTurnId });
      } catch (error) {
        await this.interrupt(forkThreadId, forkTurnId).catch(() => undefined);
        throw error;
      }
    }
    if (this.forkGate) await this.forkGate.promise;
    // 1.0.10 REVIEW AUTHORITY alignment fork: internal JSON, defaults to
    // aligned so existing review flows are unaffected unless a test feeds
    // conflicts.
    if ((options.prompt ?? "").includes("REVIEW AUTHORITY checker")) {
      const next = this.alignResults.shift() ?? { aligned: true, conflicts: [] };
      return completed(forkThreadId, JSON.stringify(next));
    }
    if (this.normalizeReview) {
      this.normalizeReview = false;
      const review = this.reviewResults.shift() ?? { verdict: "pass", findings: [], testGaps: [], summary: "pass" };
      return completed(forkThreadId, JSON.stringify(review));
    }
    return completed(forkThreadId, JSON.stringify(this.plannerResults.shift() ?? {
      status: "ready",
      planMarkdown: "<proposed_plan>\nImplement the feature\n</proposed_plan>",
      questions: [],
      assumptions: ["Tests are available"],
    }));
  }

  async startReview(options: { threadId: string; cwd: string; detached: boolean; target: { type: string; instructions?: string }; onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<{ threadId: string; result: TurnWaitResult }> {
    const threadId = options.detached ? "reviewer-thread" : options.threadId;
    this.reviewThreads.push(threadId);
    this.reviewStarts.push({ threadId: options.threadId, detached: options.detached });
    this.reviewTargets.push({
      type: options.target.type,
      ...(options.target.instructions ? { instructions: options.target.instructions } : {}),
    });
    this.normalizeReview = true;
    if (this.beforeReviewOnStarted) await this.beforeReviewOnStarted.promise;
    if (options.onStarted) {
      try {
        await options.onStarted({ threadId, turnId: "review-turn-1" });
      } catch (error) {
        // Mirror the app-server: a failed registration interrupts the new turn.
        await this.interrupt(threadId, "review-turn-1").catch(() => undefined);
        throw error;
      }
    }
    if (this.reviewGate) await this.reviewGate.promise;
    // The raw native review text: display-contract compliant by default (four
    // readable sections AND Chinese text, so neither English nor Chinese tasks
    // spuriously trigger the rewrite turn); tests inject violations explicitly.
    const rawText = this.rawReviewReplies.shift() ?? DEFAULT_RAW_REVIEW;
    // The PERSISTED side gets its OWN id (never equal to the RPC turn id).
    this.appendPersistedTurn(threadId, "review-turn-1", rawText);
    return { threadId, result: { kind: "completed", threadId, turnId: "review-turn-1", status: "completed", text: rawText } };
  }

  /** Parse the RPC (streamed) side of a completed visible turn: record the
   * PERSISTED rollout side with a deliberately DIFFERENT id (real App Server:
   * RPC turn id != persisted thread.turns[].id). */
  private appendPersistedTurn(threadId: string, rpcTurnId: string, streamedText: string): void {
    if (this.readbackMissing.has(rpcTurnId)) return; // the server never persisted it
    this.persistedCounter += 1;
    const persistedId = `rollout-turn-${this.persistedCounter}`;
    this.persistedReadbackIds.push(persistedId);
    const history = this.persistedHistory.get(threadId) ?? [];
    history.push({ id: persistedId, text: this.readbackPersisted.get(rpcTurnId) ?? streamedText });
    this.persistedHistory.set(threadId, history);
  }

  /** Capture the PERSISTED-turn baseline BEFORE a visible turn starts. */
  async captureTurnBaseline(threadId: string): Promise<PersistedTurnBaseline> {
    return { ids: (this.persistedHistory.get(threadId) ?? []).map((turn) => turn.id) };
  }

  /** Read the PERSISTED final visible output of the turn appended since the
   * baseline. Exactly one new persisted turn must exist (zero = missing, more
   * than one = ambiguous/concurrent writer); otherwise `undefined`. The
   * RPC turn id is never used for lookup — only the baseline id set. */
  async readAppendedTurnText(threadId: string, baseline: PersistedTurnBaseline): Promise<{ text: string; itemType?: string } | undefined> {
    const before = new Set(baseline.ids);
    const existing = this.persistedHistory.get(threadId) ?? [];
    const added = existing.filter((turn) => !before.has(turn.id));
    if (added.length !== 1) return undefined;
    return { text: added[0]!.text };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
  }

  /** Prompt of the LAST EPHEMERAL CONVERSION fork ("Convert the readable code
   * review"); the 1.0.10 review-authority alignment fork (which carries the
   * structured verdict, never the readable review text) is skipped. */
  lastConversionPrompt(): string | undefined {
    for (let index = this.forkCalls.length - 1; index >= 0; index -= 1) {
      const prompt = this.forkCalls[index]?.prompt ?? "";
      if (prompt.startsWith("Convert the readable code review")) return prompt;
    }
    return undefined;
  }
}

const blockingFinding = {
  severity: "high" as const,
  blocking: true,
  title: "Bug",
  body: "Fix it",
  file: "src/a.ts",
  line: 10,
};

/** Default VISIBLE planner reply: a complete decision-complete plan (>120
 * chars with structured markers) that legitimately passes the ready-plan gate,
 * so default flows never trigger the completion-turn path. The converted
 * plannerMarkdown (from `plannerResults`) stays independent of this text. */
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

/** The exact real-world confirmation/acknowledgement sample the independent
 * review flagged: it is NOT a plan and must never be injected as ready. */
const ACK_ONLY_REPLY = "已确认部署目标：**局域网部署**。后续规划将以局域网内的服务端部署为基准，重点考虑身份认证、访问控制、传输加密、并发读写、审计日志、密钥管理和网络边界。";

/** Default VISIBLE native review text: display-contract compliant for BOTH
 * English and Chinese tasks (four readable sections AND Chinese text), so
 * ordinary flows never trigger the display-rewrite turn. */
const DEFAULT_RAW_REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 符合计划，测试通过";

const nonBlockingFinding = {
  severity: "medium" as const,
  blocking: false,
  title: "Nit",
  body: "Could be cleaner",
};

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

function manager(directory: string, gateway = new FakeGateway(), overrides: Partial<WorkflowConfig> = {}, callback?: CodexCallback, bridgeQueue?: { enqueue(command: BridgeCommand): Promise<string> }) {
  return new WorkflowManager(new WorkflowStore(directory), gateway, { ...config, ...overrides, storageDir: directory }, callback, bridgeQueue);
}

/** Deterministic callback double: queue results; record every resume request. */
class FakeCallback implements CodexCallback {
  results: Array<CodexCallbackResult | Error> = [];
  requests: Array<{ workflowId: string; submissionId: string; codexThreadId: string; cwd: string; prompt: string }> = [];
  cancelledWorkflows: string[] = [];
  cancelledSubmissions: string[] = [];
  stopped = false;
  /** Controls what activeReview() reports (the dispatcher's live-turn signal). */
  activeReviewTurns = false;

  async send(request: { workflowId: string; submissionId: string; codexThreadId: string; cwd: string; prompt: string }): Promise<CodexCallbackResult> {
    this.requests.push(request);
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "pass" } };
  }

  cancel(workflowId: string): void {
    this.cancelledWorkflows.push(workflowId);
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    this.cancelledSubmissions.push(`${workflowId}:${submissionId}`);
  }

  activeReview(): boolean {
    return this.activeReviewTurns;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class GatedCallback extends FakeCallback {
  readonly gate = deferredGate();
  observedSignal?: AbortSignal;

  override async send(
    request: { workflowId: string; submissionId: string; codexThreadId: string; cwd: string; prompt: string },
    signal?: AbortSignal,
  ): Promise<CodexCallbackResult> {
    this.requests.push(request);
    this.observedSignal = signal;
    await this.gate.promise;
    return { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "pass" } };
  }
}

test("runs plan, repair, and review in the original DSH session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-manager-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "Needs repair" },
      { verdict: "pass", findings: [], testGaps: [], summary: "Verified" },
    ];
    const managerInstance = manager(directory, gateway);
    const deferred: unknown[] = [];
    const exec = fakeExec("session-original", directory, deferred);
    const planned = await managerInstance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    assert.equal(planned.dshSessionId, "session-original");
    assert.equal(planned.mode, "planned");
    const first = await managerInstance.review(planned.id, { implementationSummary: "Implemented", testResults: "pass" }, exec);
    assert.equal(first.phase, "fixing");
    assert.equal(first.reviewerThreadId, "planner-thread");
    const second = await managerInstance.review(planned.id, { implementationSummary: "Fixed", testResults: "pass" }, exec);
    assert.equal(second.phase, "passed");
    // Planned workflows append every review to the original Planner task. No
    // second visible Reviewer task is created; both rounds refresh the review
    // contract on the shared task.
    assert.equal(gateway.reviewerThreadCalls.length, 0);
    assert.equal(gateway.instructionCalls.length, 2);
    assert.deepEqual(gateway.reviewThreads, ["planner-thread", "planner-thread"]);
    assert.deepEqual(gateway.reviewStarts[0], { threadId: "planner-thread", detached: false });
    assert.deepEqual(gateway.reviewStarts[1], { threadId: "planner-thread", detached: false });
    assert.ok(deferred.length >= 3);
  } finally {
    await rmClosed(directory);
  }
});

test("1.0.7: persistent planner turns carry NO outputSchema; the plan comes from an ephemeral fork conversion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-planner-"));
  try {
    const gateway = new FakeGateway();
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-planner", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    // One VISIBLE planner turn: readable Markdown, no outputSchema, plan mode.
    assert.equal(gateway.turnCalls.length, 1);
    assert.equal(gateway.turnCalls[0]?.schema, undefined, "the visible planner turn must never carry an output schema");
    // One EPHEMERAL fork conversion on the SAME planner thread with the schema.
    assert.equal(gateway.forkCalls.length, 1);
    assert.equal(gateway.forkCalls[0]?.threadId, "planner-thread", "the fork is created from the persistent planner task");
    assert.deepEqual(gateway.forkCalls[0]?.schema, PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>);
    // Conversion effort "low" is enforced inside the app-server client (see
    // app-server.test.ts); the manager-level fork carries the schema only.
    // The plan on the record came from the CONVERSION, not the raw Markdown.
    assert.equal(planned.planMarkdown, "<proposed_plan>\nImplement the feature\n</proposed_plan>");
    // No JSON envelope ever reached the persisted thread: the visible reply
    // was plain Markdown.
    assert.equal(gateway.turnCalls.length, 1);
  } finally {
    await rmClosed(directory);
  }
});

test("1.0.7: a numbered-questions visible reply converts to waiting_input, and continue reuses the SAME planner task with a fresh fork conversion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-continue-"));
  try {
    const gateway = new FakeGateway();
    gateway.plannerReplies.push("1. Which scope?\n2. Which language?");
    gateway.plannerResults.push({
      status: "needs_input",
      questions: [
        { id: "scope", header: "Scope", question: "Which scope?", options: [], allowOther: false, secret: false },
        { id: "lang", header: "Language", question: "Which language?", options: [], allowOther: false, secret: false },
      ],
      assumptions: [],
      message: "",
    });
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-continue", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "waiting_input");
    assert.equal(planned.questions.length, 2);

    gateway.plannerReplies.push([
      "# Goal",
      "Build in TypeScript 并交付完整计划",
      "# Changes",
      "- src/main.ts：以 TypeScript 实现功能",
      "- test/main.test.ts：补齐单元测试",
      "# Verification",
      "- pnpm typecheck && pnpm test",
    ].join("\n"));
    gateway.plannerResults.push({
      status: "ready",
      planMarkdown: "# Goal\nBuild in TypeScript 并交付完整计划\n# Changes\n- src/main.ts：以 TypeScript 实现功能\n- test/main.test.ts：补齐单元测试\n# Verification\n- pnpm typecheck && pnpm test",
      questions: [],
      assumptions: [],
    });
    const continued = await instance.continue(planned.id, { scope: ["Focused"], lang: ["TypeScript"] }, exec);
    assert.equal(continued.phase, "executing");
    assert.match(continued.planMarkdown ?? "", /Build in TypeScript/);
    // The continuation reuses the SAME persistent planner task and converts
    // its reply with a NEW ephemeral fork (one fork per visible reply).
    assert.equal(gateway.turnCalls.length, 2);
    assert.equal(gateway.turnCalls[0]?.schema, undefined);
    assert.equal(gateway.turnCalls[1]?.schema, undefined);
    assert.equal(gateway.forkCalls.length, 2, "each visible reply is converted separately");
    assert.ok(gateway.forkCalls.every((call) => call.threadId === "planner-thread"), "continue never creates a replacement planner task");
  } finally {
    await rmClosed(directory);
  }
});

/** Problem 2 regression: the real-world confirmation/acknowledgement reply must
 * NEVER be injected as a ready plan. The plugin runs ONE controlled completion
 * turn on the SAME persistent Planner task; when THAT reply is a complete
 * plan, executing uses the completion's plan — never the acknowledgement. */
test("a completion turn cleans up its active-turn mapping on EVERY path: cancel during it never resurrects or injects a plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-completion-cancel-"));
  try {
    const gateway = new FakeGateway();
    gateway.plannerReplies.push(ACK_ONLY_REPLY); // turn 1 = ack -> gate fails -> completion turn
    gateway.completionGate = deferredGate();
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-compcancel", directory, []);
    const pendingStart = instance.start({ task: "Build it" }, exec);
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.list()).length > 0);
    const record = (await store.list())[0]!;
    // The completion turn (planner-turn-2) is registered and held: cancel must
    // interrupt it through the active-turn mapping.
    await waitFor(async () => gateway.turnCalls.length === 2);
    const cancelled = await instance.cancel(record.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.ok(gateway.interrupts.some((entry) => entry.threadId === "planner-thread" && entry.turnId === "planner-turn-2"),
      "cancel interrupted the completion turn while it was the active turn");
    gateway.completionGate.release();
    const settled = await pendingStart;
    assert.equal(settled.phase, "cancelled", "the workflow is never resurrected by the settling completion path");
    const after = await store.load(record.id);
    assert.equal(after?.phase, "cancelled");
    assert.equal(after?.planMarkdown, undefined, "no plan was injected by the cancelled completion path");
    // The try/finally cleanup removed the stale active-turn mapping: a later
    // cancel falls back to persisted ids and can never hit a dead ephemeral
    // mapping.
    assert.equal((instance as unknown as { activeTurns: Map<string, unknown> }).activeTurns.has(record.id), false,
      "the completion turn's active mapping was cleaned on the cancel path");
    const again = await instance.cancel(record.id, exec);
    assert.equal(again.phase, "cancelled");
  } finally {
    await rmClosed(directory);
  }
});

test("a confirmation-only planner reply never becomes ready: a controlled completion turn on the SAME task recovers it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-ack-complete-"));
  try {
    const gateway = new FakeGateway();
    // First visible reply = the flagged acknowledgement; the completion turn
    // falls back to the fake's complete default plan.
    gateway.plannerReplies.push(ACK_ONLY_REPLY);
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-ack", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing", "the completion turn recovered the workflow");
    // The acknowledgement itself never became the plan.
    assert.match(planned.planMarkdown ?? "", /Implement the feature/);
    assert.ok(!/局域网部署/.test(planned.planMarkdown ?? ""), "the acknowledgement text was never injected as the plan");
    // One visible ack turn + one visible completion turn on the SAME task;
    // two ephemeral conversions (one per visible reply).
    assert.equal(gateway.turnCalls.length, 2, "an acknowledgement triggers exactly ONE completion turn");
    assert.equal(gateway.forkCalls.length, 2, "each visible reply is converted separately");
    assert.ok(gateway.forkCalls.every((call) => call.threadId === "planner-thread"));
  } finally {
    await rmClosed(directory);
  }
});

test("a confirmation reply followed by another weak reply FAILS without planMarkdown or executing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-ack-fail-"));
  try {
    const gateway = new FakeGateway();
    gateway.plannerReplies.push(ACK_ONLY_REPLY, ACK_ONLY_REPLY);
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-ackfail", directory, []);
    await assert.rejects(instance.start({ task: "Build it" }, exec), /not a complete plan/);
    const records = await new WorkflowStore(directory).list();
    assert.equal(records[0]?.phase, "failed", "two weak replies never produce executing");
    assert.equal(records[0]?.planMarkdown, undefined, "no planMarkdown was ever written");
    assert.equal(gateway.forkCalls.length, 2, "both weak replies were converted (and both rejected)");
  } finally {
    await rmClosed(directory);
  }
});

test("a complete Chinese plan is ready directly with no completion turn; needs_input never triggers one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-plan-gate-"));
  try {
    // Direct ready: a complete plan-like Chinese reply passes the gate with a
    // single conversion and no completion turn.
    const gatewayReady = new FakeGateway();
    gatewayReady.plannerReplies.push(DEFAULT_PLANNER_REPLY);
    const instanceReady = manager(directory, gatewayReady);
    const ready = await instanceReady.start({ task: "Build it" }, fakeExec("session-107-gate-a", directory, []));
    assert.equal(ready.phase, "executing");
    assert.equal(gatewayReady.turnCalls.length, 1, "a complete plan does NOT trigger the completion turn");
    assert.equal(gatewayReady.forkCalls.length, 1);

    // needs_input (numbered-questions fallback) continues to work untouched.
    const gatewayInput = new FakeGateway();
    gatewayInput.plannerReplies.push("1. Which scope?\n2. Which language?");
    gatewayInput.plannerResults.push({
      status: "needs_input",
      questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [], allowOther: false, secret: false }],
      assumptions: [],
      message: "",
    });
    const instanceInput = manager(join(directory, "legacy"), gatewayInput);
    const pending = await instanceInput.start({ task: "Build it" }, fakeExec("session-107-gate-b", directory, []));
    assert.equal(pending.phase, "waiting_input");
    assert.equal(gatewayInput.turnCalls.length, 1, "a needs_input reply never triggers the completion turn");
    assert.equal(gatewayInput.forkCalls.length, 1);
  } finally {
    await rmClosed(directory);
  }
});

/** Production `codex_workflow_continue` must handle CONSECUTIVE native
 * clarifications: each continue answers ONE round; the workflow stays on the
 * waiting_input state machine with the fresh questions until a genuinely
 * completed visible reply converts. */
test("consecutive native clarifications: continue answers one round at a time and the final reply converts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-consecutive-input-"));
  try {
    const gateway = new FakeGateway();
    gateway.initialNeedsInput = needsInput("q1", "第一个问题？");
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-consecutive", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "waiting_input");
    assert.equal(planned.questions[0]?.question, "第一个问题？");

    // Round 2: the model asks AGAIN (consecutive clarification) — the second
    // continue answers it and stays waiting_input with the new questions.
    gateway.continueResults.push(needsInput("q2", "第二个问题？"));
    const again = await instance.continue(planned.id, { q1: ["答案一"] }, exec);
    assert.equal(again.phase, "waiting_input", "a second native clarification keeps the workflow on waiting_input");
    assert.equal(again.questions[0]?.question, "第二个问题？");
    assert.ok(again.pendingInput, "pendingInput keeps tracking the open turn across consecutive clarifications");
    assert.deepEqual(gateway.continueAnswers[0], { q1: ["答案一"] }, "round 1 answered all of its questions");

    // Round 3: a genuinely completed visible reply (a complete plan, long enough
    // to pass the ready-plan gate) → ephemeral conversion.
    const finalPlan = [
      "# Goal",
      "完成最终计划并保证决策完备",
      "# Changes",
      "- 改造 planner 验收流程：补充确认语回归与补全 turn 路径",
      "- 增加单元测试覆盖 needs_input 与 ready 分支",
      "# Verification",
      "- pnpm typecheck",
      "- pnpm test 全部通过",
    ].join("\n");
    gateway.continueResults.push(completed("planner-thread", finalPlan));
    gateway.plannerResults.push({ status: "ready", planMarkdown: finalPlan, questions: [], assumptions: [] });
    const done = await instance.continue(planned.id, { q2: ["答案二"] }, exec);
    assert.equal(done.phase, "executing");
    assert.deepEqual(gateway.continueAnswers[1], { q2: ["答案二"] }, "round 2 answered all of its questions");
    // Only the FINAL completed reply was converted; clarifications never fork.
    assert.equal(gateway.forkCalls.length, 1, "each completed visible reply converts separately; clarifications do not");
    assert.equal(gateway.forkCalls[0]?.threadId, "planner-thread", "continue reuses the SAME planner task");
    assert.match(done.planMarkdown ?? "", /完成最终计划/);
  } finally {
    await rmClosed(directory);
  }
});

test("1.0.7: a readable failure reply converts to a failed workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-planner-failed-"));
  try {
    const gateway = new FakeGateway();
    gateway.plannerReplies.push("I cannot plan this: no API credentials are available in this environment.");
    gateway.plannerResults.push({ status: "failed", questions: [], assumptions: [], message: "no API credentials" });
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-107-pfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "failed");
    assert.match(planned.error ?? "", /no API credentials/);
    assert.equal(gateway.turnCalls.length, 1, "a failure conversion goes straight to failed, no completion turn");
  } finally {
    await rmClosed(directory);
  }
});

/** itemType is an audit field, NOT a ready gate: in a Plan-mode context a
 * ready plan may come from a `plan` item OR an `agentMessage` item (native
 * clarification/continue path). The empty-text and JSON-envelope gates are
 * what protect the ready path. */
test("a ready plan from an agentMessage visible reply (Plan-mode context) still reaches executing via normalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-agmsg-ready-"));
  try {
    const gateway = new FakeGateway();
    const tagged = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startTurn") {
          return async (threadId: string, options?: Parameters<FakeGateway["startTurn"]>[1]) => {
            const result = await target.startTurn(threadId, options);
            if (result.kind === "completed") return { ...result, itemType: "agentMessage" };
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, tagged);
    const exec = fakeExec("session-107-agmsg", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing", "ready from an agentMessage visible reply is accepted through the ephemeral normalization");
    assert.equal(planned.planMarkdown, "<proposed_plan>\nImplement the feature\n</proposed_plan>");
  } finally {
    await rmClosed(directory);
  }
});

/** The visible-reply contract: an EMPTY visible reply or a raw structured
 * JSON envelope fails the workflow BEFORE any conversion fork runs — no fake
 * plan, no leaked envelope, and no short-message acceptance. */
test("empty or JSON-envelope visible planner replies fail before any conversion fork", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-clean-reply-"));
  try {
    // Empty visible reply.
    const gatewayEmpty = new FakeGateway();
    const empty = new Proxy(gatewayEmpty, {
      get(target, property, receiver) {
        if (property === "startTurn") {
          return async (threadId: string, options?: Parameters<FakeGateway["startTurn"]>[1]) => {
            const result = await target.startTurn(threadId, options);
            if (result.kind === "completed") return { ...result, text: "   " };
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instanceEmpty = manager(directory, empty);
    await assert.rejects(instanceEmpty.start({ task: "Build it" }, fakeExec("session-107-clean-a", directory, [])), /empty/);
    const recordsA = await new WorkflowStore(directory).list();
    assert.equal(recordsA[0]?.phase, "failed");
    assert.equal(recordsA[0]?.planMarkdown, undefined);
    assert.equal(empty.forkCalls.length, 0, "an empty visible reply must never reach the conversion fork");

    // Raw JSON envelope visible reply (the old 1.0.6-style output), in its own
    // temp dir so store cleanup on Windows is unambiguous.
    const directoryEnv = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-clean-env-"));
    try {
      const gatewayEnv = new FakeGateway();
      const envelope = new Proxy(gatewayEnv, {
        get(target, property, receiver) {
          if (property === "startTurn") {
            return async (threadId: string, options?: Parameters<FakeGateway["startTurn"]>[1]) => {
              const result = await target.startTurn(threadId, options);
              if (result.kind === "completed") {
                return { ...result, text: JSON.stringify({ status: "ready", planMarkdown: "<proposed_plan>\nx\n</proposed_plan>", questions: [], assumptions: [] }) };
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FakeGateway;
      const instanceEnv = manager(directoryEnv, envelope);
      await assert.rejects(instanceEnv.start({ task: "Build it" }, fakeExec("session-107-clean-b", directory, [])), /JSON envelope/);
      const recordsB = await new WorkflowStore(directoryEnv).list();
      assert.equal(recordsB[0]?.phase, "failed");
      assert.equal(envelope.forkCalls.length, 0, "a leaked JSON envelope must never reach the conversion fork");
    } finally {
      await rmClosed(directoryEnv);
    }
  } finally {
    await rmClosed(directory);
  }
});

test("1.0.7: planner normalization failure FAILS the workflow and never accepts the raw Markdown as a plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-planner-normfail-"));
  try {
    const gateway = new FakeGateway();
    const failing = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "normalizeInFork") return async () => { throw new Error("conversion exploded"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, failing);
    const exec = fakeExec("session-107-pnormfail", directory, []);
    await assert.rejects(instance.start({ task: "Build it" }, exec), /conversion exploded/);
    const records = await new WorkflowStore(directory).list();
    assert.equal(records[0]?.phase, "failed", "planner normalization failure is terminal");
    assert.equal(records[0]?.planMarkdown, undefined, "the raw visible Markdown is never accepted as a plan");
    assert.match(records[0]?.error ?? "", /conversion exploded/);

    // An invalid converted result is equally terminal (in a fresh directory so
    // record ordering is unambiguous).
    const directory2 = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-pnormfail2-"));
    try {
      const gateway2 = new FakeGateway();
      gateway2.plannerResults.push({ status: "bogus" });
      const instance2 = manager(directory2, gateway2);
      await assert.rejects(instance2.start({ task: "Build it" }, fakeExec("session-107-pnormfail2", directory2, [])), /invalid planner status/);
      const records2 = await new WorkflowStore(directory2).list();
      assert.equal(records2[0]?.phase, "failed");
      assert.match(records2[0]?.error ?? "", /invalid planner status/);
    } finally {
      await rmClosed(directory2);
    }
  } finally {
    await rmClosed(directory);
  }
});

test("1.0.7: reviewer normalization (fork) failure falls back to a retryable phase and consumes NO review cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-107-reviewer-normfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    let failFork = true;
    const flaky = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "normalizeInFork") {
          return async (options: Parameters<FakeGateway["normalizeInFork"]>[0]) => {
            if (failFork) throw new Error("fork unavailable");
            return target.normalizeInFork(options);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, flaky);
    const exec = fakeExec("session-107-rnormfail", directory, []);
    // The PLANNER conversion must succeed; only the REVIEWER fork fails.
    failFork = false;
    const planned = await instance.start({ task: "Build it" }, exec);
    failFork = true;
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec),
      /fork unavailable/,
    );
    let record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "reviewer conversion failure is retryable, never failed");
    assert.equal(record.reviewCycles, 0, "conversion failure consumes no review cycle");
    assert.match(record.error ?? "", /fork unavailable/);

    // The next review once the fork works again applies normally as cycle 1.
    failFork = false;
    const reviewed = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["changed.txt"] }, exec);
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.reviewCycles, 1);
    record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.latestReview?.verdict, "pass");
  } finally {
    await rmClosed(directory);
  }
});

/** Defect 1: a FAILED/INTERRUPTED visible review turn must never reach the
 * conversion, never parse residual text and never consume a cycle — the
 * workflow falls back to its original executing/fixing phase. */
test("a failed visible review turn is retryable: no conversion, no cycle, back to the original phase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-review-turn-failed-"));
  try {
    const gateway = new FakeGateway();
    const flaky = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startReview") {
          return async (options: Parameters<FakeGateway["startReview"]>[0]) => {
            const result = await target.startReview(options);
            return {
              threadId: result.threadId,
              result: { kind: "completed", threadId: result.threadId, turnId: "review-turn-1", status: "failed", reason: "turn failed" },
            };
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, flaky);
    const exec = fakeExec("session-reviewturnfailed", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    // Fork #1 was the planner conversion; after a failed review turn, NO
    // review conversion fork may ever run.
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec),
      /turn failed/,
    );
    assert.equal(gateway.forkCalls.length, 1, "the conversion fork must never run for a failed review turn");
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "recovers to the original retryable phase");
    assert.equal(record.reviewCycles, 0, "no review cycle consumed");
    assert.equal(record.latestReview, undefined, "residual text was never parsed or applied");
  } finally {
    await rmClosed(directory);
  }
});

/** Defect 1: an interrupted normalization fork similarly falls back retryable
 * with zero cycles. */
test("an interrupted normalization fork falls back retryable and consumes no cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-fork-interrupted-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    let interruptFork = false;
    const flaky = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "normalizeInFork") {
          return async (options: Parameters<FakeGateway["normalizeInFork"]>[0]) => {
            if (interruptFork) {
              return { kind: "completed", threadId: "fork-thread-9", turnId: "fork-turn-9", status: "interrupted", reason: "interrupted" } as TurnWaitResult;
            }
            return target.normalizeInFork(options);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, flaky);
    const exec = fakeExec("session-forkinterrupted", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    interruptFork = true;
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec),
      /interrupted/,
    );
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "recovers to the original retryable phase");
    assert.equal(record.reviewCycles, 0);
    assert.equal(record.latestReview, undefined);
  } finally {
    await rmClosed(directory);
  }
});

/** Constraint + acceptance defect: Git reviews send the SAME custom target as
 * non-Git with the full Chinese context (task/plan/summary/files/tests/
 * evidence/workflow identity) PLUS the git review scope AND the item-by-item
 * coverage gate — verdict correctness must never depend on hidden
 * thread-settings developer instructions (a native review turn may not
 * reliably see them). */
test("Git reviews send a custom target with the full Chinese context, git scope and coverage gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-git-zh-"));
  try {
    const repo = join(directory, "repo");
    await mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-git-zh", repo, []);
    const planned = await instance.start({ task: "实现用户登录功能" }, exec);
    assert.equal(planned.phase, "executing");
    await instance.review(planned.id, {
      implementationSummary: "实现了登录接口",
      changedFiles: ["src/login.ts"],
      testResults: "全部测试通过",
    }, exec);

    // Protocol-level: the Git review target is CUSTOM — the native
    // uncommittedChanges target is never sent (it carries no instructions of
    // its own and a native review turn may not see hidden thread settings
    // either).
    assert.equal(gateway.reviewTargets[0]?.type, "custom");
    assert.ok(
      gateway.reviewTargets.every((target) => target.type !== "uncommittedChanges"),
      "the Git path never sends the native uncommittedChanges target",
    );
    const instructions = gateway.reviewTargets[0]?.instructions ?? "";
    assert.match(instructions, /实现用户登录功能/, "original task in the custom target instructions");
    assert.match(instructions, /APPROVED PLAN:\n<proposed_plan>\nImplement the feature/);
    assert.match(instructions, /实现了登录接口/, "implementation summary");
    assert.match(instructions, /src\/login\.ts/, "changed files");
    assert.match(instructions, /全部测试通过/, "test results");
    assert.match(instructions, new RegExp(`WORKFLOW: ${planned.id}`), "workflow identity");
    assert.match(instructions, /WORKSPACE EVIDENCE \(kind: git\)/, "captured evidence");
    assert.match(instructions, /VERDICT: pass \| changes_requested/, "readable output contract");
    assert.match(instructions, /same language as the original task/, "language following");
    // Git scope: the review targets the current staged/unstaged/untracked
    // changes and must independently check git status/diff.
    assert.match(instructions, /staged, unstaged AND untracked/, "the git scope pins the review target");
    assert.match(instructions, /git status/);
    assert.match(instructions, /git diff/);
    // Item-by-item coverage gate (1.0.10): missing implementation is
    // blocking; verification evidence follows the plan's own method;
    // the authority hierarchy bounds scope/test-count demands.
    assert.match(instructions, /ITEM-BY-ITEM COVERAGE:/);
    assert.match(instructions, /EVERY explicit requirement in ORIGINAL TASK and APPROVED PLAN/);
    assert.match(instructions, /must be IMPLEMENTED in the observed changes/);
    assert.match(instructions, /REAL COMMAND verification/);
    assert.match(instructions, /Never demand changes that exceed the ORIGINAL TASK \/ APPROVED PLAN/);
    assert.ok(!/uncommittedChanges/.test(instructions), "the instructions never leak the native target type");
    // The developer-instructions channel stays populated as an AUXILIARY
    // refresh (same context), but the target above is what the verdict runs on.
    const developer = gateway.instructionCalls[0]?.instructions ?? "";
    assert.match(developer, /实现用户登录功能/, "same context via the auxiliary thread developer instructions");
    assert.equal(gateway.reviewerThreadCalls.length, 0, "planned review creates no second visible task");
  } finally {
    await rmClosed(directory);
  }
});

/** review_only + Git + Chinese: the same contract without any planner. */
test("review_only on a Git repo sends a custom target with the full context and gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-git-ro-zh-"));
  try {
    const repo = join(directory, "repo");
    await mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-git-ro-zh", repo, []);
    const started = await instance.reviewOnly({
      task: "优化本次改动",
      implementationSummary: "重构了模块边界",
      changedFiles: ["src/mod.ts"],
      testResults: "用例全绿",
    }, exec);
    assert.equal(started.phase, "passed");
    assert.equal(gateway.reviewTargets[0]?.type, "custom", "review_only on Git also uses the custom target");
    const instructions = gateway.reviewTargets[0]?.instructions ?? "";
    assert.match(instructions, /优化本次改动/, "review_only task context rides the custom target");
    assert.match(instructions, /重构了模块边界/);
    assert.match(instructions, /用例全绿/);
    assert.match(instructions, /WORKSPACE EVIDENCE \(kind: git\)/);
    assert.match(instructions, /staged, unstaged AND untracked/, "git scope in the custom target");
    assert.match(instructions, /ITEM-BY-ITEM COVERAGE:/, "coverage gate in the custom target");
    assert.equal(gateway.threadCalls.length, 0, "review_only on Git never creates an empty source thread");
  } finally {
    await rmClosed(directory);
  }
});

/** Non-Git reviews keep the custom target carrying the same full context +
 * the coverage gate (no git scope, though). */
test("non-Git reviews send a custom target with the full readable context and gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-nongit-ctx-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-nongit-ctx", directory, []);
    const planned = await instance.start({ task: "增加搜索接口" }, exec);
    await instance.review(planned.id, {
      implementationSummary: "完成了搜索",
      changedFiles: ["src/search.ts"],
      testResults: "通过",
    }, exec);
    assert.equal(gateway.reviewTargets[0]?.type, "custom");
    const instructions = gateway.reviewTargets[0]?.instructions ?? "";
    assert.match(instructions, /增加搜索接口/);
    assert.match(instructions, /WORKSPACE EVIDENCE/);
    assert.match(instructions, /ITEM-BY-ITEM COVERAGE:/, "the coverage gate rides the custom target on non-Git too");
    assert.match(instructions, /EVERY explicit requirement in ORIGINAL TASK and APPROVED PLAN/);
    assert.match(instructions, /VERDICT: pass is allowed when every explicit requirement has implementation evidence \(code\) plus verification evidence of the kind the task\/plan requires/);
    assert.ok(!/git status/.test(instructions), "non-Git instructions never claim a git scope");
    assert.ok(!/untracked/.test(instructions), "non-Git instructions never mention untracked files");
    // The developer-instructions channel is populated identically (auxiliary).
    const developer = gateway.instructionCalls[0]?.instructions ?? "";
    assert.match(developer, /增加搜索接口/, "same context via the auxiliary thread developer instructions too");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: a Chinese task whose raw native review is an English
 * one-liner (the exact acceptance defect: verdict pass, no sections, no
 * Chinese) triggers ONE visible rewrite turn on the SAME durable Reviewer —
 * low effort, no schema, silent — and the rewrite turn's final message
 * becomes the authoritative text sent to the ephemeral conversion. */
test("a Chinese task with an English one-line review triggers one visible rewrite on the SAME Reviewer; the corrected text drives the conversion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-enone-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation strips sync and all 11 tests pass."];
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试全部通过"];
    gateway.reviewResults = [
      { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-enone", directory, []);
    const planned = await instance.start({ task: "实现用户登录功能" }, exec);
    const reviewed = await instance.review(planned.id, {
      implementationSummary: "实现了登录接口",
      changedFiles: ["src/login.ts"],
      testResults: "全部测试通过",
    }, exec);
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.reviewCycles, 1);

    // ONE display-rewrite turn on the SAME durable Reviewer at low effort:
    // visible (no schema) and silent.
    assert.equal(gateway.rewriteCalls.length, 1, "the English one-liner triggers exactly one rewrite turn");
    assert.equal(gateway.rewriteCalls[0]?.threadId, "planner-thread", "the rewrite runs on the shared workflow task");
    assert.equal(gateway.rewriteCalls[0]?.effort, "low", "the rewrite runs at low effort");
    assert.equal(gateway.rewriteCalls[0]?.schema, undefined, "the rewrite turn is visible and never carries the JSON schema");
    assert.equal(gateway.rewriteCalls[0]?.model, "fake-default-model", "the rewrite reuses the same effective reviewer model");
    assert.equal(gateway.reviewerThreadCalls.length, 0, "no second Reviewer task is ever created");
    // The rewrite turn is the registered ACTIVE visible turn (cancel target).
    assert.ok(gateway.turnCalls.some((call) => call.schema === undefined), "the rewrite is a normal visible turn");

    // The AUTHORITATIVE text for the ephemeral conversion is the corrected
    // rewrite — never the English one-liner.
    const conversionPrompt = gateway.lastConversionPrompt() ?? "";
    assert.match(conversionPrompt, /VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试全部通过/, "the conversion consumes the corrected authoritative text");
    assert.ok(!conversionPrompt.includes("strips sync"), "the English one-liner never reaches the conversion");
    // The conversion fork still runs on the durable Reviewer thread id.
    assert.equal(gateway.forkCalls.at(-1)?.threadId, "planner-thread");
    // The SAME Reviewer id was used for the rewrite: one durable thread total.
    assert.equal(gateway.reviewerThreadCalls.length, 0, "the Planner task is reused across the rewrite");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: a single paragraph that merely CONTAINS every section
 * keyword (结论/问题/测试/总结…) without actual section lines must NOT satisfy
 * the contract — the fixed readable audit format (VERDICT / FINDINGS / TEST
 * GAPS / SUMMARY as section lines) is enforced; such a review is rewritten. */
test("a paragraph containing all section keywords but no section lines triggers the display rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-paragraph-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["结论是通过，没有问题，测试已经完成，总结如下：一切正常。"];
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划"];
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-paragraph", directory, []);
    const planned = await instance.start({ task: "增加搜索接口" }, exec);
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec);
    assert.equal(first.phase, "passed");
    assert.equal(gateway.rewriteCalls.length, 1, "a keyword-stuffed paragraph is not a sectioned review");

    // Markdown-decorated section LINES are still recognized (headings, bold,
    // bullets), so a legitimate formatted review never gets rewritten.
    const gateway2 = new FakeGateway();
    gateway2.rawReviewReplies = ["# 审查结果\n- **问题**：无\n- **测试缺口**：无\n**总结**：实现符合计划"];
    gateway2.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance2 = manager(join(directory, "legacy"), gateway2);
    const planned2 = await instance2.start({ task: "实现搜索功能" }, fakeExec("session-display-decorated", directory, []));
    const second = await instance2.review(planned2.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, fakeExec("session-display-decorated", directory, []));
    assert.equal(second.phase, "passed");
    assert.equal(gateway2.rewriteCalls.length, 0, "decorated section lines satisfy the anchored contract");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: an English/Chinese review missing the required sections
 * (four parts: verdict, findings, test gaps, summary) is rewritten; a raw
 * structured JSON envelope is rewritten too — JSON never survives in the
 * visible history path. */
test("reviews missing sections or leaking a JSON envelope trigger the display rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-sections-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The implementation is fine."];
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划"];
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-sections", directory, []);
    const planned = await instance.start({ task: "增加搜索接口" }, exec);
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec);
    assert.equal(first.phase, "passed");
    assert.equal(gateway.rewriteCalls.length, 1, "a section-less review triggers the rewrite");
    assert.match(gateway.lastConversionPrompt() ?? "", /SUMMARY: 实现符合计划/, "the corrected text drives the conversion");

    // A raw JSON verdict envelope is never accepted as a visible review.
    const gateway2 = new FakeGateway();
    gateway2.rawReviewReplies = [JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" })];
    gateway2.rewriteReplies = ["结论：通过\n发现：无\n测试缺口：无\n总结：实现符合计划"];
    gateway2.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance2 = manager(directory, gateway2);
    const planned2 = await instance2.start({ task: "增加搜索接口" }, fakeExec("session-display-envelope", directory, []));
    const second = await instance2.review(planned2.id, { implementationSummary: "two", changedFiles: ["a.ts"] }, fakeExec("session-display-envelope", directory, []));
    assert.equal(second.phase, "passed");
    assert.equal(gateway2.rewriteCalls.length, 1, "a JSON envelope raw review triggers the rewrite");
    assert.match(gateway2.lastConversionPrompt() ?? "", /结论：通过/, "the rewritten Chinese Markdown drives the conversion");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: a genuinely compliant Chinese review NEVER triggers the
 * extra rewrite turn — the raw text is used directly. */
test("a compliant Chinese review never triggers the display rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-ok-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = [
      "结论：通过\n发现：无\n测试缺口：无\n总结：实现符合计划，测试全部通过",
    ];
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-ok", directory, []);
    const planned = await instance.start({ task: "实现用户登录功能" }, exec);
    const reviewed = await instance.review(planned.id, {
      implementationSummary: "实现了登录接口",
      changedFiles: ["src/login.ts"],
      testResults: "全部测试通过",
    }, exec);
    assert.equal(reviewed.phase, "passed");
    assert.equal(gateway.rewriteCalls.length, 0, "a compliant Chinese review never triggers the rewrite");
    assert.match(gateway.lastConversionPrompt() ?? "", /结论：通过/, "the raw compliant review is the authoritative text");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: when the rewrite STILL violates the contract, the
 * workflow returns to its retryable phase — no latestReview, no cycle — and
 * a later conforming round applies normally. */
test("a rewrite that still violates the display contract is retryable and consumes no cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-stillbad-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation works."];
    gateway.rewriteReplies = ["still just an English sentence without any sections"];
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-stillbad", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec),
      /corrected review still violates the display contract/,
    );
    let record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "a display-contract failure is retryable, never failed");
    assert.equal(record.reviewCycles, 0, "no review cycle consumed");
    assert.equal(record.latestReview, undefined, "no verdict was written");
    assert.match(record.error ?? "", /display contract/);

    // The next round with a conforming rewrite applies normally as cycle 1.
    gateway.rawReviewReplies.push("The uncommitted implementation works.");
    gateway.rewriteReplies.push("VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试通过");
    const reviewed = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["a.ts"] }, exec);
    assert.equal(reviewed.phase, "passed");
    record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.reviewCycles, 1);
    assert.equal(record.latestReview?.verdict, "pass");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: cancel during the rewrite turn interrupts EXACTLY that
 * visible turn (thread id unchanged, turn id = the rewrite turn) and the
 * workflow stays cancelled — never resurrected. */
test("cancel during the display rewrite interrupts exactly the rewrite turn and never resurrects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-cancel-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation passes."];
    gateway.rewriteGate = deferredGate();
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试通过"];
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-cancel", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec);
    await waitFor(() => gateway.rewriteCalls.length === 1 && gateway.rewriteGate !== undefined);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.ok(
      gateway.interrupts.some((entry) => entry.threadId === "planner-thread" && entry.turnId === "rewrite-turn-1"),
      "cancel interrupts the rewrite turn on the SAME Reviewer thread",
    );
    assert.equal(gateway.reviewerThreadCalls.length, 0, "no second Reviewer is ever created");
    gateway.rewriteGate.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled", "the settling rewrite path never resurrects the workflow");
    const after = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(after.phase, "cancelled");
    assert.equal(after.latestReview, undefined, "no verdict was written by the cancelled round");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: an interrupted/failed rewrite turn (timeout class) is
 * retryable and consumes no cycle — the workflow falls back to executing. */
test("an interrupted display rewrite turn is retryable with zero cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-int-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation passes."];
    const flaky = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startTurn") {
          return async (threadId: string, options: { silentReview?: boolean } | undefined) => {
            if (options?.silentReview) {
              return { kind: "completed", threadId, turnId: "rewrite-turn-1", status: "interrupted", reason: "interrupted" } as TurnWaitResult;
            }
            return target.startTurn(threadId, options as Parameters<FakeGateway["startTurn"]>[1]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, flaky);
    const exec = fakeExec("session-display-int", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec),
      /review rewrite turn interrupted/,
    );
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "an interrupted rewrite is retryable");
    assert.equal(record.reviewCycles, 0);
    assert.equal(record.latestReview, undefined);
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract: plugin teardown (stop) while the rewrite turn is
 * running interrupts exactly that turn through the active-turn mapping and
 * stop() still settles once the turn completes. */
test("teardown interrupts an in-flight display rewrite turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-stop-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation passes."];
    gateway.rewriteGate = deferredGate();
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试通过"];
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-stop", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec);
    await waitFor(() => gateway.rewriteCalls.length === 1);
    const stopping = instance.stop();
    // Teardown interrupts the ACTIVE visible turn — the rewrite on the SAME
    // durable Reviewer thread — while it is still held by the gate.
    await waitFor(() => gateway.interrupts.some((entry) => entry.threadId === "planner-thread" && entry.turnId === "rewrite-turn-1"));
    gateway.rewriteGate.release();
    await pendingReview;
    await stopping;
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract, PERSISTED READ-BACK is the authority: the streamed/
 * completion-event text looks fully compliant, but the thread/read persisted
 * text of the round lacks the four sections (the exact acceptance defect:
 * Chinese prose + "Full review comments" with no VERDICT/FINDINGS/TEST
 * GAPS/SUMMARY). The rewrite must trigger off the PERSISTED text — on the
 * SAME Reviewer — and its persisted final message must drive the conversion. */
test("persisted read-back is the display authority: compliant streamed but violating persisted text triggers the same-Reviewer rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-readback-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = [DEFAULT_RAW_REVIEW]; // streamed: compliant
    // Persisted (thread/read) round-1 text: Chinese prose, NO four sections.
    gateway.readbackPersisted.set("review-turn-1", "Full review comments：实现存在若干问题，需调整后再合入。");
    gateway.rewriteReplies = ["VERDICT: changes_requested\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现需调整，测试需补齐"];
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-readback", directory, []);
    const planned = await instance.start({ task: "扩展normalizeWindowsPath" }, exec);
    const reviewed = await instance.review(planned.id, {
      implementationSummary: "扩展了路径归一化",
      changedFiles: ["src/path.ts"],
      testResults: "测试通过",
    }, exec);
    assert.equal(reviewed.phase, "fixing");
    assert.equal(gateway.rewriteCalls.length, 1, "the VIOLATING PERSISTED text triggers exactly one rewrite");
    assert.equal(gateway.rewriteCalls[0]?.threadId, "planner-thread", "the rewrite runs on the shared workflow task");
    // The PERSISTED rollout ids deliberately differ from the RPC turn ids
    // (real App Server evidence): read-back must locate the appended turn via
    // the baseline id set, never by RPC-id equality.
    assert.ok(gateway.persistedReadbackIds.length >= 1, "the fake persisted at least one rollout turn");
    assert.ok(!gateway.persistedReadbackIds.includes("review-turn-1"), "the persisted review rollout id differs from the RPC turn id");
    assert.ok(!gateway.persistedReadbackIds.includes("rewrite-turn-1"), "the persisted rewrite rollout id differs from the RPC turn id");
    // The rewrite prompt carries the PERSISTED (violating) text — NOT the
    // compliant streamed one — proving the display authority is the history.
    const rewritePrompt = gateway.rewriteCalls[0]?.prompt ?? "";
    assert.match(rewritePrompt, /Full review comments/, "the rewrite input is the PERSISTED violating text");
    assert.ok(!rewritePrompt.includes(DEFAULT_RAW_REVIEW), "the compliant streamed text is never the rewrite input");
    const conversionPrompt = gateway.lastConversionPrompt() ?? "";
    assert.match(conversionPrompt, /实现需调整，测试需补齐/, "the rewrite's PERSISTED final message drives the conversion");
    assert.equal(gateway.reviewerThreadCalls.length, 0, "no second Reviewer task is ever created");
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract, persisted read-back: a MISSING/ambiguous read-back of
 * the native review is retryable — zero cycle, no latestReview, and never a
 * silent fallback to the in-memory streamed text (fail-open forbidden). */
test("a missing persisted read-back of the native review is retryable with zero cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-readback-missing-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = [DEFAULT_RAW_REVIEW]; // streamed: compliant
    gateway.readbackMissing.add("review-turn-1"); // thread/read: no such turn
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-readback-missing", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec),
      /persisted review read-back missing or ambiguous/,
    );
    assert.equal(gateway.forkCalls.length, 1, "only the planner conversion ran; NO review conversion");
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "a missing read-back is retryable, never failed");
    assert.equal(record.reviewCycles, 0, "no review cycle consumed");
    assert.equal(record.latestReview, undefined, "no verdict was written from the in-memory text (no fail-open)");
    assert.match(record.error ?? "", /read-back missing or ambiguous/);
    // The next round with an available read-back applies normally.
    gateway.readbackMissing.delete("review-turn-1");
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const reviewed = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["a.ts"] }, exec);
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.reviewCycles, 1);
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract, persisted read-back of the REWRITE: a still-violating
 * persisted rewrite text is retryable with zero cycles (the reverse case). */
test("a persisted rewrite read-back that still violates the contract is retryable with zero cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-rb-rewrite-bad-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation works."];
    gateway.readbackPersisted.set("review-turn-1", "The uncommitted implementation works."); // violating
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 已修正"];
    // The rewrite STREAMED text is compliant, but its PERSISTED text is not.
    gateway.readbackPersisted.set("rewrite-turn-1", "rewritten text is still an English sentence without sections");
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-rb-rewrite-bad", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec),
      /corrected review still violates the display contract/,
    );
    assert.equal(gateway.rewriteCalls.length, 1, "the rewrite ran exactly once");
    assert.equal(gateway.forkCalls.length, 1, "the planner conversion only — NO review conversion ran");
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "a still-violating persisted rewrite is retryable");
    assert.equal(record.reviewCycles, 0);
    assert.equal(record.latestReview, undefined);
    assert.match(record.error ?? "", /display contract/);
  } finally {
    await rmClosed(directory);
  }
});

/** Display contract, persisted read-back of the REWRITE: a missing/ambiguous
 * rewrite read-back is likewise retryable — never an acceptance of the
 * streamed rewrite text. */
test("a missing persisted read-back of the rewrite is retryable with zero cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-display-rb-rewrite-missing-"));
  try {
    const gateway = new FakeGateway();
    gateway.rawReviewReplies = ["The uncommitted implementation works."];
    gateway.readbackPersisted.set("review-turn-1", "The uncommitted implementation works."); // violating
    gateway.rewriteReplies = ["VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 已修正"];
    gateway.readbackMissing.add("rewrite-turn-1"); // rewrite persisted turn absent
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-display-rb-rewrite-missing", directory, []);
    const planned = await instance.start({ task: "实现搜索功能" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec),
      /persisted rewrite read-back missing or ambiguous/,
    );
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing");
    assert.equal(record.reviewCycles, 0);
    assert.equal(record.latestReview, undefined);
    assert.match(record.error ?? "", /persisted rewrite read-back missing or ambiguous/);
  } finally {
    await rmClosed(directory);
  }
});

/** Defect 5: the EFFECTIVE planner model (override or Plan-mode-resolved) is
 * persisted and reused by continue/restart and every conversion fork. */
test("the effective planner model is persisted and reused by the conversion fork (override)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-planner-model-"));
  try {
    const gateway = new FakeGateway();
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-planner-model", directory, []);
    const planned = await instance.start({ task: "Build it", plannerModel: "planner-override-model" }, exec);
    assert.equal(planned.phase, "executing");
    assert.equal(planned.plannerModel, "planner-override-model", "the effective model is persisted");
    assert.equal(gateway.turnCalls[0]?.model, "planner-override-model", "the visible turn uses it");
    assert.equal(gateway.forkCalls[0]?.model, "planner-override-model", "the conversion fork reuses the SAME model");
  } finally {
    await rmClosed(directory);
  }
});

test("the Plan-mode-resolved model (no explicit model) is captured, persisted and reused by the fork", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-planner-model-auto-"));
  try {
    const gateway = new FakeGateway();
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-planner-model-auto", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    // No explicit model anywhere: the Plan collaboration mode's model was
    // captured via onModel and persisted — the fork must NOT fall back to a
    // different default.
    assert.equal(planned.plannerModel, "mode-model");
    assert.equal(gateway.forkCalls[0]?.model, "mode-model", "the fork reuses the captured Plan-mode model");
  } finally {
    await rmClosed(directory);
  }
});

test("clarification continues reuse the persisted effective planner model and refresh the fork model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-planner-model-continue-"));
  try {
    const gateway = new FakeGateway();
    gateway.plannerReplies.push("1. Which scope?");
    gateway.plannerResults.push({
      status: "needs_input",
      questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [], allowOther: false, secret: false }],
      assumptions: [],
      message: "",
    });
    const instance = manager(directory, gateway, { plannerModel: "cfg-model" });
    const exec = fakeExec("session-planner-model-continue", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "waiting_input");
    assert.equal(planned.plannerModel, "cfg-model", "the effective model survives the clarification pause");
    gateway.plannerReplies.push("<proposed_plan>\nDone\n</proposed_plan>");
    gateway.plannerResults.push({ status: "ready", planMarkdown: "<proposed_plan>\nDone\n</proposed_plan>", questions: [], assumptions: [] });
    const continued = await instance.continue(planned.id, { scope: ["Focused"] }, exec);
    assert.equal(continued.phase, "executing");
    assert.equal(gateway.turnCalls[1]?.model, "cfg-model", "continue reuses the persisted effective model");
    assert.equal(gateway.forkCalls[1]?.model, "cfg-model", "the continue conversion fork reuses the SAME model");
  } finally {
    await rmClosed(directory);
  }
});

test("restart (new manager) continues with the persisted effective planner model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-planner-model-restart-"));
  try {
    const gateway = new FakeGateway();
    gateway.plannerReplies.push("1. Which scope?");
    gateway.plannerResults.push({
      status: "needs_input",
      questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [], allowOther: false, secret: false }],
      assumptions: [],
      message: "",
    });
    const first = manager(directory, gateway, { plannerModel: "restart-model" });
    const exec = fakeExec("session-restart-model", directory, []);
    const planned = await first.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "waiting_input");
    await first.stop();

    // A FRESH manager (simulated restart) continues WITHOUT config help: the
    // persisted effective model must still drive the visible turn and the fork.
    const freshGateway = new FakeGateway();
    freshGateway.plannerReplies.push("<proposed_plan>\nDone\n</proposed_plan>");
    freshGateway.plannerResults.push({ status: "ready", planMarkdown: "<proposed_plan>\nDone\n</proposed_plan>", questions: [], assumptions: [] });
    const second = manager(directory, freshGateway, { plannerModel: "" });
    const continued = await second.continue(planned.id, { scope: ["Focused"] }, fakeExec("session-restart-model", directory, []));
    assert.equal(continued.phase, "executing");
    assert.equal(continued.plannerModel, "restart-model", "the persisted model survives the restart");
    assert.equal(freshGateway.turnCalls[0]?.model, "restart-model", "the resumed visible turn uses the persisted model");
    assert.equal(freshGateway.forkCalls[0]?.model, "restart-model", "the resumed conversion fork uses the persisted model");
    await second.stop();
  } finally {
    await rmClosed(directory);
  }
});

/** Defect 5 (reviewer): with nothing configured, the resolver's server default
 * becomes the EXPLICIT reviewer model — thread creation, forks and re-reviews
 * all share it. */
test("the reviewer model is explicit even when nothing is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-reviewer-model-auto-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-reviewer-model-auto", directory, []);
    const started = await instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec);
    assert.equal(started.reviewerModel, "fake-default-model", "the resolved server default is persisted explicitly");
    assert.equal(gateway.reviewerThreadCalls[0]?.model, "fake-default-model", "the durable Reviewer thread uses it");
    assert.equal(gateway.forkCalls[0]?.model, "fake-default-model", "the conversion fork reuses the SAME model");
    await instance.review(started.id, { implementationSummary: "Fixed" }, exec);
    // Each review round adds an invisible 1.0.10 review-authority alignment
    // fork that reuses the SAME model: 2 forks (conversion + alignment) per
    // round across the first review and the re-review.
    assert.deepEqual(
      gateway.forkCalls.map((call) => call.model),
      ["fake-default-model", "fake-default-model", "fake-default-model", "fake-default-model"],
    );
  } finally {
    await rmClosed(directory);
  }
});

/** Defect 4: teardown interrupts the ACTIVE foreground turn (ephemeral
 * normalization fork) and AWAITS the foreground tool flow before settling —
 * nothing may later write into a closed store. */
test("teardown during normalization interrupts the fork and awaits the foreground flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-teardown-fork-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-teardown-fork", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const forkGate = deferredGate();
    gateway.forkGate = forkGate;
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => gateway.forkCalls.length === 2);
    const store = new WorkflowStore(directory);
    const stopPromise = instance.stop();
    let stopDone = false;
    stopPromise.then(() => { stopDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(stopDone, false, "teardown must not settle while the foreground normalization is in flight");
    // The active ephemeral fork turn was interrupted exactly by teardown.
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "fork-thread-2" && entry.turnId === "fork-turn-2",
    ), "teardown interrupts the actual active fork turn");
    forkGate.release();
    await Promise.all([stopPromise, pendingReview.catch(() => undefined)]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The store outlives the teardown (it closes only AFTER manager.stop
    // settled): the foreground flow wrote nothing into a closed store.
    const record = await store.load(planned.id);
    assert.ok(record, "store still readable after teardown (never closed mid-flow)");
  } finally {
    await rmClosed(directory);
  }
});

test("status reports reviewerActive from a live Reviewer turn, not persisted states", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-status-"));
  try {
    const gateway = new FakeGateway();
    const callback = new FakeCallback();
    const managerInstance = manager(directory, gateway, {}, callback);
    const exec = fakeExec("session-status", directory, []);
    const planned = await managerInstance.start({ task: "Build it" }, exec);
    const idle = await managerInstance.status(planned.id, exec);
    assert.equal(idle.reviewerActive, false, "no Reviewer turn is running before any review");

    // Even with a persisted reviewerTurnId and a "delivering" submission state,
    // no LIVE turn exists: reviewerActive must stay false (a historical turn
    // that already completed and was unsubscribed is NOT active).
    const store = new WorkflowStore(directory);
    await store.update(planned.id, (r) => {
      r.origin = "codex_bridge";
      r.codexThreadId = "source-task";
      r.submissionId = "sub-delivery";
      r.submissionState = "verdict_ready";
      r.reviewerThreadId = "reviewer-thread";
      r.reviewerTurnId = "reviewer-turn-old";
    });
    const delivering = await managerInstance.status(planned.id, exec);
    assert.equal(delivering.reviewerActive, false, "a finished callback in verdict_ready is not an active Reviewer");

    // The dispatcher reports a live turn -> reviewerActive true.
    callback.activeReviewTurns = true;
    const inFlight = await managerInstance.status(planned.id, exec);
    assert.equal(inFlight.reviewerActive, true);

    // The turn settles -> false again.
    callback.activeReviewTurns = false;
    const terminal = await managerInstance.status(planned.id, exec);
    assert.equal(terminal.reviewerActive, false);
  } finally {
    await rmClosed(directory);
  }
});

test("status reports reviewerActive during a DSH-led reviewing phase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-status2-"));
  try {
    const gateway = new FakeGateway();
    const managerInstance = manager(directory, gateway); // no callback injected
    const exec = fakeExec("session-status2", directory, []);
    const planned = await managerInstance.start({ task: "Build it" }, exec);
    const store = new WorkflowStore(directory);
    await store.update(planned.id, (r) => {
      r.phase = "reviewing";
      r.reviewerThreadId = "reviewer-thread";
      r.reviewerTurnId = "reviewer-turn-x";
    });
    const during = await managerInstance.status(planned.id, exec);
    assert.equal(during.reviewerActive, true);
    await store.update(planned.id, (r) => { r.phase = "passed"; });
    const after = await managerInstance.status(planned.id, exec);
    assert.equal(after.reviewerActive, false);
  } finally {
    await rmClosed(directory);
  }
});

test("blocks after the configured third failed review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-limit-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = Array.from({ length: 3 }, () => ({
      verdict: "changes_requested" as const,
      findings: [{ ...blockingFinding, title: "Still wrong", body: "Retry" }],
      testGaps: [],
      summary: "No",
    }));
    const managerInstance = manager(directory, gateway);
    const exec = fakeExec("session-limit", directory, []);
    const planned = await managerInstance.start({ task: "Build it" }, exec);
    await managerInstance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    await managerInstance.review(planned.id, { implementationSummary: "two", changedFiles: ["changed.txt"] }, exec);
    const final = await managerInstance.review(planned.id, { implementationSummary: "three" }, exec);
    assert.equal(final.phase, "blocked");
    assert.equal(final.reviewCycles, 3);
  } finally {
    await rmClosed(directory);
  }
});

test("blocking findings enter the automatic repair loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-blocking-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: ["missing tests"], summary: "Fix" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-blocking", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const reviewed = await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    assert.equal(reviewed.phase, "fixing");
  } finally {
    await rmClosed(directory);
  }
});

test("test gaps alone count as blocking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-testgaps-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [], testGaps: ["add unit tests for the fix"], summary: "Tests" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-testgaps", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const reviewed = await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    assert.equal(reviewed.phase, "fixing");
  } finally {
    await rmClosed(directory);
  }
});

test("non-blocking findings stop at the review decision gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-gate-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits only" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-gate", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const reviewed = await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    assert.equal(reviewed.phase, "waiting_review_decision");
    assert.equal(reviewed.reviewCycles, 1);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "again" }, exec),
      /cannot be reviewed from phase waiting_review_decision/,
    );
    await assert.rejects(
      instance.decide(planned.id, { decision: "accept" }, fakeExec("other-session", directory, [])),
      /belongs to another DSH session/,
    );
  } finally {
    await rmClosed(directory);
  }
});

test("accept at the decision gate ships the workflow with findings recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-accept-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-accept", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    const decided = await instance.decide(planned.id, { decision: "accept", note: "nitpick only" }, exec);
    assert.equal(decided.phase, "passed");
    assert.equal(decided.reviewDecision?.decision, "accept");
    assert.equal(decided.reviewDecision?.note, "nitpick only");
    assert.ok(decided.latestReview?.findings[0]?.blocking === false);
  } finally {
    await rmClosed(directory);
  }
});

test("fix at the decision gate enters the repair loop and can pass later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-fix-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits" },
      { verdict: "pass", findings: [], testGaps: [], summary: "Good" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-fix", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    const decided = await instance.decide(planned.id, { decision: "fix" }, exec);
    assert.equal(decided.phase, "fixing");
    assert.equal(decided.reviewDecision?.decision, "fix");
    const repaired = await instance.review(planned.id, { implementationSummary: "Fixed nits" }, exec);
    assert.equal(repaired.phase, "passed");
  } finally {
    await rmClosed(directory);
  }
});

test("blocks a blocking re-review when the workspace did not change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-nochange-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-nochange", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, exec);
    assert.equal(first.phase, "fixing");
    assert.equal(first.noChangeReviewRounds, 0);
    assert.ok(first.latestReviewEvidence?.fingerprint);
    const second = await instance.review(planned.id, { implementationSummary: "two (no changes)", changedFiles: ["a.txt"] }, exec);
    assert.equal(second.phase, "blocked");
    assert.equal(second.noChangeReviewRounds, 1);
    assert.match(second.error ?? "", /no verifiable change/);
  } finally {
    await rmClosed(directory);
  }
});

test("an actual workspace change resets the no-change counter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-reset-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-reset", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, exec);
    await writeFile(file, "v2", "utf8");
    const second = await instance.review(planned.id, { implementationSummary: "two (fixed)", changedFiles: ["a.txt"] }, exec);
    assert.equal(second.phase, "fixing");
    assert.equal(second.noChangeReviewRounds, 0);
    const third = await instance.review(planned.id, { implementationSummary: "three", changedFiles: ["a.txt"] }, exec);
    assert.equal(third.phase, "blocked");
    assert.equal(third.noChangeReviewRounds, 1);
    assert.match(third.error ?? "", /no verifiable change/);
  } finally {
    await rmClosed(directory);
  }
});

test("pass and non-blocking reviews are never blocked by identical fingerprints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-passnoc-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");

    const passGateway = new FakeGateway();
    passGateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const passInstance = manager(directory, passGateway);
    const passExec = fakeExec("session-passnoc-a", directory, []);
    const passPlanned = await passInstance.start({ task: "Build it" }, passExec);
    await passInstance.review(passPlanned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, passExec);
    const passed = await passInstance.review(passPlanned.id, { implementationSummary: "two", changedFiles: ["a.txt"] }, passExec);
    assert.equal(passed.phase, "passed");

    const gateGateway = new FakeGateway();
    gateGateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits" },
    ];
    const gateInstance = manager(directory, gateGateway);
    const gateExec = fakeExec("session-passnoc-b", directory, []);
    const gatePlanned = await gateInstance.start({ task: "Build it" }, gateExec);
    await gateInstance.review(gatePlanned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, gateExec);
    const gated = await gateInstance.review(gatePlanned.id, { implementationSummary: "two", changedFiles: ["a.txt"] }, gateExec);
    assert.equal(gated.phase, "waiting_review_decision");
  } finally {
    await rmClosed(directory);
  }
});

test("insufficient evidence disables no-change detection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-insufficient-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-insufficient", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    // No changedFiles in a non-git workspace: nothing verifiable, no false block.
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    assert.equal(first.phase, "fixing");
    assert.ok(first.latestReviewEvidence?.insufficient);
    const second = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["changed.txt"] }, exec);
    assert.equal(second.phase, "fixing");
    assert.equal(second.noChangeReviewRounds, 0);
  } finally {
    await rmClosed(directory);
  }
});

test("review-only skips the planner and reuses the single durable Reviewer on re-review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-reviewonly-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-reviewonly", directory, []);
    const started = await instance.reviewOnly({
      task: "Polish existing changes",
      implementationSummary: "Changed src",
      changedFiles: ["src/a.ts"],
      testResults: "pass",
    }, exec);
    assert.equal(started.mode, "review_only");
    assert.equal(started.phase, "fixing");
    assert.equal(started.reviewerThreadId, "reviewer-thread");
    assert.ok(!gateway.threadCalls.some((call) => call.name.startsWith("DSH Plan")));
    assert.ok(!gateway.threadCalls.some((call) => call.name.startsWith("DSH Review")), "no separate empty source thread is created");
    assert.equal(gateway.reviewerThreadCalls.length, 1);
    assert.deepEqual(gateway.reviewStarts[0], { threadId: "reviewer-thread", detached: false });

    const reReviewed = await instance.review(started.id, { implementationSummary: "Fixed" }, exec);
    assert.equal(reReviewed.phase, "passed");
    // The SAME durable Reviewer id is reused (one creation, one refresh).
    assert.equal(gateway.reviewerThreadCalls.length, 1, "re-review never creates a second Reviewer");
    assert.equal(gateway.instructionCalls.length, 1, "the re-review refreshes the per-round developer instructions");
    assert.deepEqual(gateway.reviewThreads, ["reviewer-thread", "reviewer-thread"]);
    assert.deepEqual(gateway.reviewStarts[1], { threadId: "reviewer-thread", detached: false });
  } finally {
    await rmClosed(directory);
  }
});

test("review-only enforces single active workflow per session and supports cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-own-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-own", directory, []);
    const started = await instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec);
    await assert.rejects(instance.start({ task: "Second" }, exec), /already has active Codex workflow/);
    await assert.rejects(
      instance.reviewOnly({ implementationSummary: "Other" }, fakeExec("session-own", directory, [])),
      /already has active Codex workflow/,
    );
    await assert.rejects(
      instance.status(started.id, fakeExec("session-other", directory, [])),
      /belongs to another DSH session/,
    );
    const cancelled = await instance.cancel(started.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    // After cancellation a new workflow may start.
    const fresh = await instance.start({ task: "Second" }, exec);
    assert.equal(fresh.phase, "executing");
  } finally {
    await rmClosed(directory);
  }
});

test("concurrent planned starts create exactly one workflow and one Planner task per session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-auto-start-race-"));
  try {
    const gatewayA = new FakeGateway();
    const gatewayB = new FakeGateway();
    const managerA = manager(directory, gatewayA);
    const managerB = manager(directory, gatewayB);
    const exec = fakeExec("session-auto-race", directory, []);
    const results = await Promise.allSettled([
      managerA.start({ task: "Complex task A" }, exec),
      managerB.start({ task: "Complex task B" }, exec),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<WorkflowRecord> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /active Codex workflow|already creating/);
    assert.equal(gatewayA.threadCalls.length + gatewayB.threadCalls.length, 1, "only the winning start creates a Planner task");
    const store = new WorkflowStore(directory);
    assert.equal((await store.list()).filter((record) => record.dshSessionId === "session-auto-race").length, 1);
    store.close();
  } finally {
    await rmClosed(directory);
  }
});

test("different DSH sessions can autonomously start independent planned workflows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-auto-start-sessions-"));
  try {
    const gatewayA = new FakeGateway();
    const gatewayB = new FakeGateway();
    const [first, second] = await Promise.all([
      manager(directory, gatewayA).start({ task: "Complex task A" }, fakeExec("session-auto-a", directory, [])),
      manager(directory, gatewayB).start({ task: "Complex task B" }, fakeExec("session-auto-b", directory, [])),
    ]);
    assert.notEqual(first.id, second.id);
    assert.equal(first.dshSessionId, "session-auto-a");
    assert.equal(second.dshSessionId, "session-auto-b");
    assert.equal(gatewayA.threadCalls.length, 1);
    assert.equal(gatewayB.threadCalls.length, 1);
  } finally {
    await rmClosed(directory);
  }
});

test("review-only reviewer-thread creation failure is retryable and records the error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rofail-"));
  try {
    const gateway = new FakeGateway();
    const failing = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startReviewerThread") return async () => { throw new Error("boom"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, failing);
    const exec = fakeExec("session-rofail", directory, []);
    await assert.rejects(instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec), /boom/);
    const records = await new WorkflowStore(directory).list();
    assert.equal(records[0]?.mode, "review_only");
    // Infrastructure-class failure: NOT terminal — the workflow stays
    // retryable with the diagnostic (no cycle consumed).
    assert.equal(records[0]?.phase, "executing");
    assert.equal(records[0]?.reviewCycles, 0);
    assert.ok(records[0]?.error);
  } finally {
    await rmClosed(directory);
  }
});

test("unobservable rounds break the fingerprint chain and are never blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-chain-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const gateway = new FakeGateway();
    gateway.reviewResults = Array.from({ length: 3 }, () => ({
      verdict: "changes_requested" as const,
      findings: [blockingFinding],
      testGaps: [],
      summary: "No",
    }));
    const instance = manager(directory, gateway, { maxNoChangeReviewRounds: 1, maxReviewCycles: 5 });
    const exec = fakeExec("session-chain", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, exec);
    assert.equal(first.phase, "fixing");
    assert.ok(first.previousReviewFingerprint);
    // All-missing round: unverifiable, clears the fingerprint chain.
    const unobservable = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["missing.txt"] }, exec);
    assert.equal(unobservable.phase, "fixing");
    assert.equal(unobservable.noChangeReviewRounds, 0);
    assert.equal(unobservable.previousReviewFingerprint, undefined);
    // Returning to the old fingerprint after an unobservable round is fresh progress.
    const third = await instance.review(planned.id, { implementationSummary: "three", changedFiles: ["a.txt"] }, exec);
    assert.equal(third.phase, "fixing");
    assert.equal(third.noChangeReviewRounds, 0);
  } finally {
    await rmClosed(directory);
  }
});

test("a pass verdict carrying actionable content is demoted to changes_requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-passcontent-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "pass", findings: [blockingFinding], testGaps: [], summary: "pass but has a finding" },
      { verdict: "pass", findings: [], testGaps: ["missing unit tests"], summary: "pass but test gaps" },
      { verdict: "pass", findings: [nonBlockingFinding], testGaps: [], summary: "pass but nits" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-passcontent", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const blocking = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    assert.equal(blocking.phase, "fixing");
    const testGaps = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["changed.txt"] }, exec);
    assert.equal(testGaps.phase, "fixing");
    const nits = await instance.review(planned.id, { implementationSummary: "three" }, exec);
    assert.equal(nits.phase, "waiting_review_decision");
  } finally {
    await rmClosed(directory);
  }
});

test("an empty changes_requested verdict is an invalid review: retryable, no cycle consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-emptyverdict-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [], testGaps: [], summary: "nothing to say" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-emptyverdict", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec),
      /changes_requested without findings or test gaps/,
    );
    const records = await new WorkflowStore(directory).list();
    // An invalid protocol result is infrastructure-ish: the workflow returns to
    // its retryable phase and consumes no review cycle (a later valid review
    // still works).
    assert.equal(records[0]?.phase, "executing");
    assert.equal(records[0]?.reviewCycles, 0);
    assert.ok(records[0]?.error);
  } finally {
    await rmClosed(directory);
  }
});

test("review-only honours reviewer model and effort overrides across repair rounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rooverride-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-rooverride", directory, []);
    const started = await instance.reviewOnly({
      implementationSummary: "Changed",
      changedFiles: ["src/a.ts"],
      reviewerModel: "override-model",
      reviewerEffort: "low",
    }, exec);
    assert.equal(started.reviewerModel, "override-model");
    assert.equal(started.reviewerEffort, "low");
    // The durable Reviewer THREAD carries the override; the EPHEMERAL
    // conversion forks reuse the SAME model (effort "low" is enforced inside
    // the app-server client, see app-server.test.ts).
    assert.equal(gateway.reviewerThreadCalls[0]?.model, "override-model");
    // The invisible 1.0.10 authority-alignment fork reuses the SAME model.
    assert.deepEqual(gateway.forkCalls.map((call) => call.model), ["override-model", "override-model"]);
    await instance.review(started.id, { implementationSummary: "Fixed" }, exec);
    assert.deepEqual(
      gateway.forkCalls.map((call) => call.model),
      ["override-model", "override-model", "override-model", "override-model"],
    );
  } finally {
    await rmClosed(directory);
  }
});

test("review-only without changedFiles is rejected in a non-git workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rogitchanged-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-rogitchanged", directory, []);
    await assert.rejects(
      instance.reviewOnly({ implementationSummary: "Changed" }, exec),
      /requires changedFiles/,
    );
    // Rejected before record creation: nothing persisted, no active workflow.
    assert.equal((await new WorkflowStore(directory).list()).length, 0);
    const next = await instance.reviewOnly({ implementationSummary: "Changed with files", changedFiles: ["a.txt"] }, exec);
    assert.equal(next.phase, "fixing");
  } finally {
    await rmClosed(directory);
  }
});

test("cancel interrupts a still-running review and is not overwritten when it settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-activereview-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    let release!: () => void;
    gateway.reviewGate = {
      promise: new Promise<void>((resolve) => { release = resolve; }),
      release: () => release(),
    };
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-activereview", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    // The reviewer ids must be persisted while the review is still running.
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(planned.id))?.reviewerThreadId === "planner-thread");
    const during = await store.load(planned.id);
    assert.equal(during?.reviewerThreadId, "planner-thread");
    assert.equal(during?.reviewerTurnId, "review-turn-1");
    assert.equal(during?.phase, "reviewing");
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.deepEqual(gateway.interrupts, [{ threadId: "planner-thread", turnId: "review-turn-1" }]);
    release();
    const settled = await pendingReview;
    // The settling review must not overwrite the cancelled phase.
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
  } finally {
    await rmClosed(directory);
  }
});

test("review-only persists its Reviewer thread id for recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-sourcethread-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-sourcethread", directory, []);
    const started = await instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec);
    assert.equal(started.sourceThreadId, undefined, "no separate empty source thread is created anymore");
    assert.equal(started.reviewerThreadId, "reviewer-thread", "the durable Reviewer id is persisted for recovery");
  } finally {
    await rmClosed(directory);
  }
});

test("review-only Reviewer thread creation failure keeps a retryable record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-sourcethreadfail-"));
  try {
    const gateway = new FakeGateway();
    const failing = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startReviewerThread") return async () => { throw new Error("no thread"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, failing);
    const exec = fakeExec("session-sourcethreadfail", directory, []);
    await assert.rejects(instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec), /no thread/);
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.list()).length === 1);
    const records = await store.list();
    assert.equal(records[0]?.phase, "executing", "thread creation failure is retryable, never terminal");
    assert.equal(records[0]?.reviewerThreadId, undefined);
    assert.equal(records[0]?.reviewCycles, 0);
  } finally {
    await rmClosed(directory);
  }
});

/** Test seam: holds the next store load so a cancel can win the race between a
 * final cancelled check and the outcome commit. */
class GatedStore extends WorkflowStore {
  holdNextLoad = false;
  loadGate?: DeferredGate;

  override async load(id: string): Promise<WorkflowRecord | undefined> {
    if (this.holdNextLoad) {
      this.holdNextLoad = false;
      if (this.loadGate) await this.loadGate.promise;
    }
    return super.load(id);
  }
}

/** Test seam: fails the Nth update call so turn registration can be made to throw. */
class FlakyStore extends WorkflowStore {
  updateCount = 0;
  failAtUpdate?: number;

  override async update<T>(
    id: string,
    fn: (record: WorkflowRecord) => T,
    opts: { ignoreCancelled?: boolean } = {},
  ) {
    this.updateCount += 1;
    if (this.failAtUpdate === this.updateCount) {
      throw new Error("store write failed");
    }
    return super.update(id, fn, opts);
  }
}

test("a failing turn registration fails the workflow and interrupts the new turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-regfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const store = new FlakyStore(directory);
    const instance = new WorkflowManager(store, gateway, { ...config, storageDir: directory });
    const exec = fakeExec("session-regfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    // start() used one update; the third review update is the raw-review turn
    // registration (entering, evidence, registerActiveTurn).
    // start() used several updates; the FOURTH review-scoped update is the
    // raw-review turn registration (entering, evidence, reviewer-thread
    // persist, registerActiveTurn) — registerActiveTurn is what must fail.
    store.failAtUpdate = store.updateCount + 4;
    await assert.rejects(instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec), /store write failed/);
    const records = await store.list();
    // An infrastructure failure returns the workflow to its RETRYABLE phase and
    // records the error — it must not become failed, so a later review can run.
    assert.equal(records[0]?.phase, "executing");
    assert.ok(records[0]?.error);
    // The just-started reviewer turn was interrupted, mirroring the app-server.
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "planner-thread" && entry.turnId === "review-turn-1",
    ));
    // The workflow stays ACTIVE (retryable) after an infrastructure failure.
    const active = await store.activeForSession("session-regfail");
    assert.equal(active?.id, planned.id, "the workflow remains active so a later review can retry");
  } finally {
    await rmClosed(directory);
  }
});

test("cancel before the reviewer ids are persisted: onStarted never resurrects and interrupts the new turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-beforeonstarted-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const beforeOnStarted = deferredGate();
    gateway.beforeReviewOnStarted = beforeOnStarted;
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-beforeonstarted", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const store = new WorkflowStore(directory);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await store.load(planned.id))?.phase === "reviewing" && gateway.reviewStarts.length === 1);
    // The durable Reviewer THREAD is already persisted (created before the
    // review runs); the review TURN is not registered yet: cancel wins first.
    const before = await store.load(planned.id);
    assert.equal(before?.reviewerThreadId, "planner-thread");
    assert.equal(before?.reviewerTurnId, undefined);
    assert.equal(before?.plannerTurnId, "planner-turn-1");
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    // 1.0.8: with the shared-task layout the persisted ids cannot prove a
    // LIVE turn — the completed Planner turn (planner-turn-1) must NEVER
    // receive an interrupt, and no interrupt may be sent at all while the
    // review turn has not registered yet (the genuinely running turn is
    // covered by the active-turn map / suppressed-registration interrupt).
    assert.equal(gateway.interrupts.length, 0, "cancel before registration interrupts nothing");
    beforeOnStarted.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    // The turn obtained after cancellation was interrupted, not resurrected.
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "planner-thread" && entry.turnId === "review-turn-1",
    ));
    assert.ok(!gateway.interrupts.some(
      (entry) => entry.threadId === "planner-thread" && entry.turnId === "planner-turn-1",
    ), "the completed Planner turn is never interrupted");
  } finally {
    await rmClosed(directory);
  }
});

/** 1.0.8 invariant, REAL order: the App Server reports the review task id
 * through `startReview.onStarted` — a mismatched id therefore reaches the
 * callback BEFORE any return value is inspected. The review must be rejected
 * (retryable, no verdict, no cycle) and neither the persisted
 * reviewerThreadId, the active-turn map nor the conversion fork may ever see
 * the rogue id — a second visible task can never be silently persisted. */
test("review/start reporting a different task id IN onStarted is rejected; neither state nor fork sees the rogue id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rogue-review-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const rogue = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startReview") {
          return async (options: Parameters<FakeGateway["startReview"]>[0]) => {
            const inner = await target.startReview({
              ...options,
              // The REAL App Server reports the id it actually review/start-ed
              // through onStarted; here that id is a DIFFERENT task from the
              // very first callback (the true order — not a tampered return).
              onStarted: async (started) => {
                await options.onStarted?.({ threadId: "rogue-thread", turnId: started.turnId });
              },
            });
            return { threadId: "rogue-thread", result: inner.result };
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, rogue);
    const exec = fakeExec("session-rogue-review", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec),
      /returned task rogue-thread/,
    );
    const record = (await new WorkflowStore(directory).load(planned.id))!;
    assert.equal(record.phase, "executing", "a mismatched review/start task is retryable, never applied");
    assert.equal(record.reviewCycles, 0, "no review cycle consumed");
    assert.equal(record.latestReview, undefined, "no verdict was written");
    // The rogue id was NEVER persisted (the guard runs before any store write)
    // and never became an active cancel target — it was interrupted instead.
    assert.equal(record.reviewerThreadId, "planner-thread", "the persisted workflow task id is NEVER overwritten");
    assert.equal(record.reviewerTurnId, undefined, "no reviewer turn was ever persisted");
    assert.ok(
      gateway.interrupts.some((i) => i.threadId === "rogue-thread"),
      "the rogue turn was interrupted immediately instead of being tracked",
    );
    assert.equal(gateway.reviewerThreadCalls.length, 0, "no second visible task was ever created");
    assert.equal(gateway.forkCalls.length, 1, "only the planner conversion ran — no review conversion ever started");
  } finally {
    await rmClosed(directory);
  }
});

/** 1.0.8 backward compatibility at the WORKFLOW level: a planned record that
 * already persists a DISTINCT reviewerThreadId (pre-1.0.8 layout) keeps
 * resuming that old task — no migration, no replacement, no new task. */
test("planned workflow with a legacy distinct reviewerThreadId keeps using that old task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-legacy-reviewer-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [{ verdict: "pass", findings: [], testGaps: [], summary: "ok" }];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-legacy-reviewer", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    // Simulate a pre-1.0.8 record: a separate Reviewer task was already bound.
    const store = new WorkflowStore(directory);
    const seeded = await store.update(planned.id, (r) => {
      r.reviewerThreadId = "legacy-reviewer";
      r.reviewerTurnId = "legacy-turn-9";
    }, { ignoreCancelled: false });
    assert.ok(!seeded.suppressed, "legacy ids persisted");
    const reviewed = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.ts"] }, exec);
    assert.equal(reviewed.phase, "passed");
    assert.equal(gateway.reviewerThreadCalls.length, 0, "the legacy task is reused, never replaced by a new one");
    assert.ok(gateway.resumeCalls.includes("legacy-reviewer"), "the legacy reviewer task is resumed");
    assert.deepEqual(gateway.reviewStarts.at(-1), { threadId: "legacy-reviewer", detached: false }, "the review runs on the legacy task");
    const record = (await store.load(planned.id))!;
    assert.equal(record.reviewerThreadId, "legacy-reviewer", "the persisted legacy id is not migrated");
  } finally {
    await rmClosed(directory);
  }
});

test("cancel during the conversion fork interrupts the FORK turn and never overwrites the persisted Reviewer id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-normalizecancel-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-normalizecancel", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const forkGate = deferredGate();
    gateway.forkGate = forkGate;
    const store = new WorkflowStore(directory);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    // Fork #1 was the planner conversion inside start(); fork #2 is the
    // REVIEW conversion that is now the active turn.
    await waitFor(async () => gateway.forkCalls.length === 2);
    const during = await store.load(planned.id);
    // The ephemeral conversion fork is the active turn, but its id must NEVER
    // land in reviewerThreadId/reviewerTurnId — the durable ids keep pointing
    // at the visible Reviewer task.
    assert.equal(during?.reviewerThreadId, "planner-thread");
    assert.equal(during?.reviewerTurnId, "review-turn-1");
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    // Cancel interrupts the EXACT active turn: the ephemeral review FORK
    // thread/turn pair (fork #2; fork #1 was the planner conversion), never a
    // mispaired persistent thread with a fork turn id.
    assert.deepEqual(gateway.interrupts, [{ threadId: "fork-thread-2", turnId: "fork-turn-2" }]);
    forkGate.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
  } finally {
    await rmClosed(directory);
  }
});

test("cancel between the final check and the outcome commit: no overwrite, no outcome message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-latecancel-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const store = new GatedStore(directory);
    const instance = new WorkflowManager(store, gateway, { ...config, storageDir: directory });
    const exec = fakeExec("session-latecancel", directory, []);
    const deferred: unknown[] = [];
    const execWithDeferred = fakeExec("session-latecancel", directory, deferred);
    const planned = await instance.start({ task: "Build it" }, exec);
    const forkGate = deferredGate();
    gateway.forkGate = forkGate;
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, execWithDeferred);
    // Fork #1 was the planner conversion; fork #2 is the review conversion.
    await waitFor(async () => gateway.forkCalls.length === 2);
    const loadGate = deferredGate();
    store.holdNextLoad = true;
    store.loadGate = loadGate;
    forkGate.release();
    // Wait until the after-normalize load is actually held at the gate.
    await waitFor(() => store.holdNextLoad === false);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    loadGate.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    // No outcome message may be injected after the cancellation.
    assert.ok(!deferred.some((message) => JSON.stringify(message).includes("Codex Reviewer passed")));
  } finally {
    await rmClosed(directory);
  }
});

test("cancel while the planner turn is running interrupts the planner turn and ends start cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-plancancel-"));
  try {
    const gateway = new FakeGateway();
    const turnGate = deferredGate();
    gateway.turnGate = turnGate;
    const instance = manager(directory, gateway);
    const store = new WorkflowStore(directory);
    const exec = fakeExec("session-plancancel", directory, []);
    const pendingStart = instance.start({ task: "Build it" }, exec);
    await waitFor(async () => (await store.list()).length > 0);
    const record = (await store.list())[0]!;
    await waitFor(async () => (await store.load(record.id))?.plannerTurnId === "planner-turn-1");
    const cancelled = await instance.cancel(record.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.deepEqual(gateway.interrupts, [{ threadId: "planner-thread", turnId: "planner-turn-1" }]);
    turnGate.release();
    const settled = await pendingStart;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(record.id))?.phase, "cancelled");
  } finally {
    await rmClosed(directory);
  }
});

test("interrupt failures never un-cancel a workflow or leave it active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-intfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.interrupt = async () => { throw new Error("interrupt failed"); };
    const instance = manager(directory, gateway);
    const store = new WorkflowStore(directory);
    const exec = fakeExec("session-intfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    assert.equal(await store.activeForSession("session-intfail"), undefined);
    const fresh = await instance.start({ task: "Second" }, exec);
    assert.equal(fresh.phase, "executing");
  } finally {
    await rmClosed(directory);
  }
});

test("onStarted interrupt failure after cancellation still leaves the record cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-onstartedfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const beforeOnStarted = deferredGate();
    gateway.beforeReviewOnStarted = beforeOnStarted;
    let interruptThrows = false;
    gateway.interrupt = async (threadId: string, turnId: string) => {
      gateway.interrupts.push({ threadId, turnId });
      if (interruptThrows) throw new Error("interrupt failed");
    };
    const instance = manager(directory, gateway);
    const store = new WorkflowStore(directory);
    const exec = fakeExec("session-onstartedfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => gateway.reviewStarts.length === 1);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    interruptThrows = true;
    beforeOnStarted.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "planner-thread" && entry.turnId === "review-turn-1",
    ));
  } finally {
    await rmClosed(directory);
  }
});

test("submit rejects non-bridge workflows and terminal phases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-"));
  try {
    const callback = new FakeCallback();
    const instance = manager(directory, new FakeGateway(), {}, callback);
    const exec = fakeExec("session-submit", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await assert.rejects(
      instance.submit(planned.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec),
      /not a Codex-bridge workflow/,
    );
    assert.equal(callback.requests.length, 0);

    const bridge = await instance.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: directory, dshSessionId: "session-bridge-owner" },
      task: "Bridge task",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    }, fakeExec("session-bridge-owner", directory, []).agent!);
    assert.equal(bridge.phase, "executing");
    await assert.rejects(
      instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, fakeExec("other-session", directory, [])),
      /belongs to another DSH session/,
    );
  } finally {
    await rmClosed(directory);
  }
});

async function bridgeWorkflow(instance: WorkflowManager, sessionId: string, directory: string, codexThreadId: string) {
  const exec = fakeExec(sessionId, directory, []);
  // Non-git tests need an observable changed file in the workspace.
  await changedFile(directory);
  return instance.startExternalPlan({
    version: 1,
    kind: "dispatch_plan",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    codexThreadId,
    target: { cwd: directory, dshSessionId: sessionId },
    task: "Bridge task",
    planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
    assumptions: [],
  }, exec.agent!);
}

/** Ensure the workspace has an observable changed file for non-git submits. */
async function changedFile(directory: string): Promise<void> {
  await writeFile(join(directory, "changed.txt"), "v1", "utf8");
}

function fakeBridgeQueue(): {
  enqueue: (command: BridgeCommand) => Promise<string>;
  commands: SubmitVerdictCommand[];
  notices: SubmissionNoticeCommand[];
  allCommands: BridgeCommand[];
} {
  const commands: SubmitVerdictCommand[] = [];
  const notices: SubmissionNoticeCommand[] = [];
  const allCommands: BridgeCommand[] = [];
  return {
    commands,
    notices,
    allCommands,
    enqueue: async (command) => {
      allCommands.push(command);
      if (command.kind === "submit_verdict") commands.push(command);
      if (command.kind === "submission_notice") notices.push(command);
      return command.requestId;
    },
  };
}

test("submit returns before Reviewer completion and ignores the ended tool signal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-background-"));
  const callback = new GatedCallback();
  const queue = fakeBridgeQueue();
  const instance = manager(directory, new FakeGateway(), {}, callback, queue);
  try {
    const controller = new AbortController();
    const exec = {
      ...fakeExec("session-submit-background", directory, []),
      signal: controller.signal,
    } as ToolRunContext;
    const bridge = await bridgeWorkflow(instance, "session-submit-background", directory, newRequestId());

    const submitted = await Promise.race([
      instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("submit blocked on Reviewer")), 2_000)),
    ]);

    assert.equal(submitted.submissionState, "queued");
    await waitFor(() => callback.requests.length === 1);
    controller.abort();
    assert.equal(callback.observedSignal?.aborted, false, "Reviewer uses a manager-owned signal");

    callback.gate.release();
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    assert.equal(queue.commands.length, 1);
  } finally {
    callback.gate.release();
    await instance.stop();
    await rmClosed(directory);
  }
});

test("submit persists a submission, resumes the exact thread and enqueues the structured verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-ok-"));
  try {
    const callback = new FakeCallback();
    const queue = fakeBridgeQueue();
    const instance = manager(directory, new FakeGateway(), {}, callback, queue);
    const exec = fakeExec("session-submit-ok", directory, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-submit-ok", directory, codexThreadId);
    await instance.submit(bridge.id, {
      implementationSummary: "Implemented",
      changedFiles: ["changed.txt"],
      testResults: "all pass",
    }, exec);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(submitted.phase, "executing");
    assert.ok(submitted.submissionId);
    assert.equal(submitted.submissionState, "received");
    assert.equal(submitted.reviewCycles, 0, "a cycle is only counted once the verdict is APPLIED, not on submit");
    assert.equal(submitted.pendingReviewRequest?.implementationSummary, "Implemented");
    assert.ok(submitted.latestReviewEvidence);
    assert.equal(callback.requests.length, 1);
    assert.equal(callback.requests[0]!.codexThreadId, codexThreadId);
    assert.equal(callback.requests[0]!.submissionId, submitted.submissionId);
    // The prompt no longer tells the reviewer to run the bridge CLI.
    assert.ok(!/dsh-codex-workflow respond/.test(callback.requests[0]!.prompt));
    assert.match(callback.requests[0]!.prompt, /SUBMISSION:/);
    // The structured verdict was enqueued by the plugin, not the child.
    assert.equal(queue.commands.length, 1);
    const verdict = queue.commands[0]!;
    assert.equal(verdict.submissionId, submitted.submissionId);
    assert.equal(verdict.codexThreadId, codexThreadId);
    assert.equal(verdict.verdict.verdict, "pass");
  } finally {
    await rmClosed(directory);
  }
});

test("submit rejects a second active submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-once-"));
  try {
    const callback = new FakeCallback();
    const instance = manager(directory, new FakeGateway(), {}, callback, fakeBridgeQueue());
    const exec = fakeExec("session-submit-once", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-submit-once", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "one", changedFiles: ["changed.txt"] }, exec);
    await assert.rejects(
      instance.submit(bridge.id, { implementationSummary: "two", changedFiles: ["changed.txt"] }, exec),
      /already has an active submission/,
    );
  } finally {
    await rmClosed(directory);
  }
});

test("submit keeps a busy Codex task durably retryable after each bounded attempt round", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-busy-"));
  try {
    const callback = new FakeCallback();
    callback.results = [
      { kind: "retryable_busy", reason: "test busy" },
      { kind: "retryable_busy", reason: "test busy" },
      { kind: "retryable_busy", reason: "test busy" },
    ];
    const instance = manager(
      directory,
      new FakeGateway(),
      { callbackMaxAttempts: 3, callbackRetryBaseMs: 100 },
      callback,
    );
    const exec = fakeExec("session-submit-busy", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-submit-busy", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "retrying" && record.submissionAttempts === 3;
    });
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(submitted.submissionState, "retrying");
    assert.equal(submitted.submissionAttempts, 3);
    assert.match(submitted.submissionError ?? "", /busy after 3 attempts in this round/);
    assert.ok((submitted.submissionRetryAt ?? 0) > Date.now(), "a future recovery round is scheduled");
    assert.equal(callback.requests.length, 3);
    assert.equal(submitted.phase, "executing", "the DSH workflow stays intact");
  } finally {
    await rmClosed(directory);
  }
});

test("an interrupted turn persists retrying + retryAt with its reason, and recovery auto-continues to the verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-interrupted-recover-"));
  try {
    const callback = new FakeCallback();
    callback.results = [
      { kind: "retryable_busy", reason: "interrupted turn" },
      { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "recovered pass" } },
    ];
    const instance = manager(
      directory,
      new FakeGateway(),
      { callbackMaxAttempts: 1, callbackRetryBaseMs: 200 },
      callback,
      { enqueue: async () => "committed" },
    );
    const exec = fakeExec("session-interrupted-recover", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-interrupted-recover", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);

    // The interrupted turn must be persisted as retrying with a future retryAt
    // and an attributed reason — NEVER left stuck at sending/queued.
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "retrying"
        && (record.submissionRetryAt ?? 0) > Date.now()
        && record.submissionCallbackReason === "interrupted turn";
    });
    const retrying = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.match(retrying.submissionError ?? "", /interrupted turn/);
    assert.equal(callback.requests.length, 1);

    // Let the persisted backoff window elapse: recovery must then re-claim the
    // submission and run it to a verdict on its own.
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return (record?.submissionRetryAt ?? 0) <= Date.now();
    });
    const recovered = await instance.recoverCallbacks();
    assert.ok(recovered >= 1);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const done = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(done.submissionState, "received");
    assert.equal(done.submissionCallbackReason, "interrupted turn");
    assert.equal(callback.requests.length, 2, "recovery spawns the next attempt on the same submission");
    assert.equal(callback.requests[0]?.codexThreadId, callback.requests[1]?.codexThreadId, "the same source task id is reused");
    assert.deepEqual(done.stagedVerdict?.command.verdict?.verdict, "pass");
  } finally {
    await rmClosed(directory);
  }
});

test("submit treats invalid threads, missing verdicts and CLI failures as terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-invalid-"));
  try {
    const callback = new FakeCallback();
    callback.results = [new CodexInvalidThreadError("codex thread x does not exist")];
    const instance = manager(directory, new FakeGateway(), {}, callback);
    const exec = fakeExec("session-submit-invalid", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-submit-invalid", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "failed");
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(submitted.submissionState, "failed");
    assert.match(submitted.submissionError ?? "", /does not exist/);

    const callback2 = new FakeCallback();
    callback2.results = [new CodexNoVerdictError("no final agent message found in the review output")];
    const instance2 = manager(directory, new FakeGateway(), {}, callback2);
    const bridge2 = await bridgeWorkflow(instance2, "session-submit-noverdict", directory, newRequestId());
    const exec2 = fakeExec("session-submit-noverdict", directory, []);
    await instance2.submit(bridge2.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec2);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge2.id))?.submissionState === "failed");
    const submitted2 = (await new WorkflowStore(directory).load(bridge2.id))!;
    assert.equal(submitted2.submissionState, "failed");
    assert.match(submitted2.submissionError ?? "", /no final agent message/);

    const callback3 = new FakeCallback();
    callback3.results = [new CodexCallbackProcessError("codex callback exited with code 1: invalid CLI configuration")];
    const instance3 = manager(directory, new FakeGateway(), {}, callback3);
    const bridge3 = await bridgeWorkflow(instance3, "session-submit-process-error", directory, newRequestId());
    const exec3 = fakeExec("session-submit-process-error", directory, []);
    await instance3.submit(bridge3.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec3);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge3.id))?.submissionState === "failed");
    const submitted3 = (await new WorkflowStore(directory).load(bridge3.id))!;
    assert.equal(submitted3.submissionState, "failed");
    assert.match(submitted3.submissionError ?? "", /invalid CLI configuration/);
  } finally {
    await rmClosed(directory);
  }
});

test("terminal callback errors stage and enqueue one durable submission notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-notice-"));
  const callback = new FakeCallback();
  callback.results = [new CodexInvalidThreadError("codex source task does not exist")];
  const queue = fakeBridgeQueue();
  const instance = manager(directory, new FakeGateway(), {}, callback, queue);
  try {
    const exec = fakeExec("session-submit-notice", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-submit-notice", directory, newRequestId());
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "failed");

    const failed = await new WorkflowStore(directory).load(bridge.id);
    assert.ok(failed?.submissionNotice);
    assert.equal(failed.submissionNotice.state, "enqueued");
    assert.equal(failed.submissionNotice.command.submissionId, submitted.submissionId);
    assert.match(failed.submissionNotice.command.message, /does not exist/);
    assert.equal(queue.notices.length, 1);
    assert.equal(queue.notices[0]!.requestId, failed.submissionNotice.command.requestId);
  } finally {
    await instance.stop();
    await rmClosed(directory);
  }
});

test("restart recovery re-enqueues the exact persisted submission notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-submit-notice-recovery-"));
  const callback = new FakeCallback();
  callback.results = [new CodexNoVerdictError("review produced no verdict")];
  const rejectingQueue = { enqueue: async (_command: BridgeCommand): Promise<string> => { throw new Error("queue unavailable"); } };
  const first = manager(directory, new FakeGateway(), {}, callback, rejectingQueue);
  let second: WorkflowManager | undefined;
  try {
    const exec = fakeExec("session-submit-notice-recovery", directory, []);
    const bridge = await bridgeWorkflow(first, "session-submit-notice-recovery", directory, newRequestId());
    await first.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "failed");
    const before = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(before?.submissionNotice?.state, "prepared");
    const requestId = before!.submissionNotice!.command.requestId;
    await first.stop();

    const queue = fakeBridgeQueue();
    second = manager(directory, new FakeGateway(), {}, new FakeCallback(), queue);
    assert.equal(await second.recoverCallbacks(), 1);
    await waitFor(() => queue.notices.length === 1);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionNotice?.state === "enqueued");
    const replayed = queue.notices[0];
    assert.equal(replayed?.requestId, requestId);
    assert.equal((await new WorkflowStore(directory).load(bridge.id))?.submissionNotice?.state, "enqueued");
  } finally {
    await second?.stop();
    await first.stop();
    await rmClosed(directory);
  }
});

test("applyExternalVerdict reuses the outcome policy: pass, fixing, gate and no-change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdict-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const instance = manager(directory, new FakeGateway(), { maxNoChangeReviewRounds: 1, maxReviewCycles: 2 }, new FakeCallback());
    const codexThreadId = newRequestId();
    const makeBridge = async (sessionId: string) => {
      const exec = fakeExec(sessionId, directory, []);
      const record = await bridgeWorkflow(instance, sessionId, directory, codexThreadId);
      const submitted = await instance.submit(record.id, { implementationSummary: "done", changedFiles: ["a.txt"] }, exec);
      return { record, submissionId: submitted.submissionId! };
    };
    const blockingVerdict = (summary: string, submissionId: string, workflowId: string) => ({
      version: 1 as const,
      kind: "submit_verdict" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      workflowId,
      codexThreadId,
      submissionId,
      verdict: {
        verdict: "changes_requested" as const,
        findings: [{ severity: "high" as const, blocking: true, title: "Fix", body: summary }],
        testGaps: [] as string[],
        summary,
      },
    });

    const passing = await makeBridge("session-v-pass");
    const passVerdict = { ...blockingVerdict("x", passing.submissionId, passing.record.id), verdict: { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" } };
    assert.equal((await instance.applyExternalVerdict(passVerdict)).phase, "passed");

    const fixing = await makeBridge("session-v-fix");
    assert.equal((await instance.applyExternalVerdict(blockingVerdict("fix me", fixing.submissionId, fixing.record.id))).phase, "fixing");

    const gated = await makeBridge("session-v-gate");
    const gateVerdict = { ...blockingVerdict("nit", gated.submissionId, gated.record.id), verdict: {
      verdict: "changes_requested" as const,
      findings: [{ severity: "medium" as const, blocking: false, title: "Nit", body: "n" }],
      testGaps: [],
      summary: "nits",
    } };
    assert.equal((await instance.applyExternalVerdict(gateVerdict)).phase, "waiting_review_decision");

    const noChange = await makeBridge("session-v-nochange");
    assert.equal((await instance.applyExternalVerdict(blockingVerdict("round one", noChange.submissionId, noChange.record.id))).phase, "fixing");
    // Cycle 2: DSH submits again (new submission), workspace unchanged.
    const exec2 = fakeExec("session-v-nochange", directory, []);
    const resubmitted = await instance.submit(noChange.record.id, { implementationSummary: "same state", changedFiles: ["a.txt"] }, exec2);
    assert.notEqual(resubmitted.submissionId, noChange.submissionId);
    const blocked = await instance.applyExternalVerdict(blockingVerdict("round two", resubmitted.submissionId!, noChange.record.id));
    assert.equal(blocked.phase, "blocked");
    assert.match(blocked.error ?? "", /no verifiable change/);
  } finally {
    await rmClosed(directory);
  }
});

test("applyExternalVerdict rejects unknown workflows, thread mismatch, stale and missing submissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdict-reject-"));
  try {
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback());
    const exec = fakeExec("session-verdict-reject", directory, []);
    const codexThreadId = newRequestId();
    const record = await bridgeWorkflow(instance, "session-verdict-reject", directory, codexThreadId);
    const submitted = await instance.submit(record.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    const submissionId = submitted.submissionId!;
    const base = {
      version: 1 as const,
      kind: "submit_verdict" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      workflowId: record.id,
      codexThreadId,
      submissionId,
      verdict: { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" },
    };
    await assert.rejects(instance.applyExternalVerdict({ ...base, codexThreadId: newRequestId() }), /thread mismatch/);
    await assert.rejects(instance.applyExternalVerdict({ ...base, workflowId: "wf-ghost" }), /unknown workflow/);
    await assert.rejects(
      instance.applyExternalVerdict({ ...base, submissionId: newRequestId() }),
      /stale submission/,
    );
    await assert.rejects(
      instance.applyExternalVerdict({ ...base, submissionId: undefined }),
      /missing its submission id/,
    );

    // Never submitted: rejected before any submission.
    const fresh = await bridgeWorkflow(instance, "session-verdict-fresh", directory, codexThreadId);
    await assert.rejects(instance.applyExternalVerdict({ ...base, workflowId: fresh.id, submissionId: undefined, codexThreadId }), /before any submission/);
  } finally {
    await rmClosed(directory);
  }
});

test("the same submission verdict replays idempotently even after the phase moved on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdict-replay-"));
  try {
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback());
    const exec = fakeExec("session-v-replay", directory, []);
    const codexThreadId = newRequestId();
    const record = await bridgeWorkflow(instance, "session-v-replay", directory, codexThreadId);
    const submitted = await instance.submit(record.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    const command = {
      version: 1 as const,
      kind: "submit_verdict" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      workflowId: record.id,
      codexThreadId,
      submissionId: submitted.submissionId!,
      verdict: { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" },
    };
    const applied = await instance.applyExternalVerdict(command);
    assert.equal(applied.phase, "passed");
    // Replay of the SAME request id: idempotent, not an error.
    const replayed = await instance.applyExternalVerdict(command);
    assert.equal(replayed.phase, "passed");
    // The same submission with a DIFFERENT request id is refused: only the
    // expected identity may ever apply.
    await assert.rejects(
      instance.applyExternalVerdict({ ...command, requestId: newRequestId() }),
      /already applied as request/,
    );
  } finally {
    await rmClosed(directory);
  }
});

test("a late verdict on a cancelled workflow is idempotent and never resurrects it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdict-cancel-"));
  try {
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback());
    const exec = fakeExec("session-verdict-cancel", directory, []);
    const codexThreadId = newRequestId();
    const record = await bridgeWorkflow(instance, "session-verdict-cancel", directory, codexThreadId);
    const submitted = await instance.submit(record.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await instance.cancel(record.id, exec);
    const result = await instance.applyExternalVerdict({
      version: 1,
      kind: "submit_verdict",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      workflowId: record.id,
      codexThreadId,
      submissionId: submitted.submissionId!,
      verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    });
    assert.equal(result.phase, "cancelled");
    assert.equal((await new WorkflowStore(directory).load(record.id))?.phase, "cancelled");
  } finally {
    await rmClosed(directory);
  }
});

test("recoverCallbacks resumes persisted submissions exactly once with bounded attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-recover-"));
  try {
    const callback = new FakeCallback();
    callback.results = [{ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } }];
    const instance = manager(directory, new FakeGateway(), {}, callback, fakeBridgeQueue());
    const exec = fakeExec("session-recover", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-recover", directory, newRequestId());

    // Simulate a crash right after persist: queued submission, no callback ran.
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    assert.equal(callback.requests.length, 1); // the live submit already ran

    // Reset to the pre-spawn state: submission queued, attempts 0.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "queued";
      r.submissionAttempts = 0;
    });
    callback.requests.length = 0;
    callback.results.push({ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });

    // Two concurrent restarters: exactly one spawn.
    const [first, second] = await Promise.all([instance.recoverCallbacks(), instance.recoverCallbacks()]);
    assert.equal(first + second, 1);
    await waitFor(async () => callback.requests.length === 1);
    assert.equal(callback.requests[0]!.submissionId, submitted.submissionId);
    // Wait for the fire-and-forget recovery chain to finish its writes.
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");

    // Migrate an early-1.0.0 busy-exhaustion record back into persistent
    // recovery. A high lifetime attempt count must not prevent a new round.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "failed";
      r.submissionAttempts = 5;
      r.submissionError = "codex thread busy after 5 attempts";
      r.callbackState = "failed";
      r.stagedVerdict = undefined;
    });
    callback.results.push({ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "recovered legacy busy" } });
    const recovered = await instance.recoverCallbacks();
    assert.equal(recovered, 1);
    await waitFor(async () => callback.requests.length === 2);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const recoveredRecord = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(recoveredRecord?.submissionAttempts, 6, "lifetime attempts remain an audit trail");

    // Recover the newer Codex thread-store contention wording too. Other
    // explicit process failures stay terminal.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "failed";
      r.submissionAttempts = 6;
      r.submissionError = `codex callback exited with code 1: thread-store conflict: thread ${r.codexThreadId} already has an active writer`;
      r.callbackState = "failed";
      r.stagedVerdict = undefined;
    });
    callback.results.push({ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "recovered active writer" } });
    assert.equal(await instance.recoverCallbacks(), 1);
    await waitFor(async () => callback.requests.length === 3);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const activeWriterRecord = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(activeWriterRecord?.submissionAttempts, 7);
  } finally {
    await rmRetry(directory);
  }
});

/** Finding 3: infrastructure failures never consume a review cycle; the first
 * APPLIED verdict is still cycle 1 for both the bridge submit path and the
 * DSH review path. */
test("callback infrastructure failures do not consume a review cycle; first applied verdict is cycle 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-cycles-"));
  try {
    // Bridge submit path: three busy failures, then a real pass applies.
    const callback = new FakeCallback();
    callback.results.push({ kind: "retryable_busy", reason: "test busy" });
    callback.results.push({ kind: "retryable_busy", reason: "test busy" });
    callback.results.push({ kind: "retryable_busy", reason: "test busy" });
    const queue = fakeBridgeQueue();
    const instance = manager(directory, new FakeGateway(), { callbackMaxAttempts: 3, callbackRetryBaseMs: 30 }, callback, queue);
    const exec = fakeExec("session-cycles", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-cycles", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "try 1", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "retrying" && !record.submissionLeaseToken;
    });
    const retrying = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(retrying.submissionState, "retrying", "busy exhaustion keeps the same submission active");
    assert.equal(retrying.reviewCycles, 0, "infrastructure failures consume no cycle");
    assert.equal(retrying.phase, "executing", "the workflow stays retryable");
    await new WorkflowStore(directory).update(bridge.id, (r) => { r.submissionRetryAt = 0; });
    callback.results.push({ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });
    assert.equal(await instance.recoverCallbacks(), 1);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const submitted = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(submitted?.reviewCycles, 0, "still zero until the verdict is applied");
    // The first APPLIED verdict is cycle 1.
    const applied = await instance.applyExternalVerdict(queue.commands[0]!);
    assert.equal(applied.reviewCycles, 1, "first applied verdict is cycle 1");
  } finally {
    await rmClosed(directory);
  }
});

test("a legacy DSH review consumes exactly one cycle per applied review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-cycles-review-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [{ verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "no" }];
    const instance = manager(directory, gateway, {}, new FakeCallback());
    const exec = fakeExec("session-cycles-review", directory, []);
    const planned = await instance.start({ task: "Fix it" }, exec);
    assert.equal(planned.phase, "executing");
    assert.equal(planned.reviewCycles, 0, "starting a workflow consumes no cycle");
    const reviewed = await instance.review(planned.id, { implementationSummary: "work", changedFiles: ["changed.txt"] }, exec);
    assert.equal(reviewed.phase, "fixing");
    assert.equal(reviewed.reviewCycles, 1, "one applied review = one cycle");
    // Another round: cycle 2.
    gateway.reviewResults = [{ verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "no" }];
    const second = await instance.review(planned.id, { implementationSummary: "more", changedFiles: ["changed.txt"] }, exec);
    assert.equal(second.reviewCycles, 2);
  } finally {
    await rmClosed(directory);
  }
});

async function rmClosed(path: string): Promise<void> {
  closeCoordinationStoresForDirectory(join(path, "legacy"));
  closeCoordinationStoresForDirectory(path);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(path, { recursive: true, force: true });
}

async function rmRetry(path: string): Promise<void> {
  await rmClosed(path);
}

test("cancel kills the active callback child and terminates the submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-cancel-child-"));
  try {
    const callback = new FakeCallback();
    const instance = manager(directory, new FakeGateway(), {}, callback);
    const exec = fakeExec("session-cancel-child", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-cancel-child", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await instance.cancel(bridge.id, exec);
    assert.deepEqual(callback.cancelledWorkflows, [bridge.id]);
    const record = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(record?.phase, "cancelled");
    assert.equal(record?.submissionState, "failed");
  } finally {
    await rmClosed(directory);
  }
});

test("onTurnStopping steers bridge workflows to submit and legacy workflows to review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-turnstop-"));
  try {
    const instance = manager(directory, new FakeGateway());
    const exec = fakeExec("session-turnstop", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-turnstop", directory, newRequestId());
    const steers: string[] = [];
    const agent = {
      id: "session-turnstop",
      session: { header: { cwd: directory } },
      steer: (message: { content: Array<{ text?: string }> }) => {
        steers.push(message.content[0]?.text ?? "");
      },
    } as never as import("@deepseek-ai/dsh-agent").Agent;
    await instance.onTurnStopping(agent, 1);
    assert.equal(steers.length, 1);
    assert.match(steers[0]!, /codex_workflow_submit/);
    assert.ok(!/codex_workflow_review/.test(steers[0]!));

    const legacy = await instance.start({ task: "Legacy" }, fakeExec("session-turnstop-legacy", directory, []));
    assert.equal(legacy.phase, "executing");
    const legacyAgent = {
      id: "session-turnstop-legacy",
      session: { header: { cwd: directory } },
      steer: (message: { content: Array<{ text?: string }> }) => {
        steers.push(message.content[0]?.text ?? "");
      },
    } as never as import("@deepseek-ai/dsh-agent").Agent;
    await instance.onTurnStopping(legacyAgent, 2);
    assert.equal(steers.length, 2);
    assert.match(steers[1]!, /codex_workflow_review/);
  } finally {
    await rmClosed(directory);
  }
});

test("onTurnStopping does not request a duplicate submit while background review is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-turnstop-active-"));
  const callback = new GatedCallback();
  const instance = manager(directory, new FakeGateway(), {}, callback, fakeBridgeQueue());
  try {
    const exec = fakeExec("session-turnstop-active", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-turnstop-active", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    const steers: string[] = [];
    const agent = {
      id: "session-turnstop-active",
      session: { header: { cwd: directory } },
      steer: (message: { content: Array<{ text?: string }> }) => steers.push(message.content[0]?.text ?? ""),
    } as never as import("@deepseek-ai/dsh-agent").Agent;

    await instance.onTurnStopping(agent, 1);

    assert.deepEqual(steers, []);
  } finally {
    callback.gate.release();
    await instance.stop();
    await rmClosed(directory);
  }
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

/** A crash between verdict staging (verdict_ready) and enqueue must be
 * recovered by re-enqueueing the EXACT staged command (same requestId,
 * createdAt, commandHash) — never a new identity — and must never respawn
 * the callback. The staged identity survives `received` and is only cleared
 * once the verdict is APPLIED. */
test("verdict_ready recovery re-enqueues the exact staged command and keeps its identity until applied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdictready-"));
  try {
    const callback = new FakeCallback();
    const queue = fakeBridgeQueue();
    const instance = manager(directory, new FakeGateway(), {}, callback, queue);
    const exec = fakeExec("session-vr", directory, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-vr", directory, codexThreadId);
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(submitted.submissionState, "received");
    // Simulate the crash after phase A (staged) before phase B/C: the staged
    // command is the one the queue must see, verbatim.
    const stagedRequestId = newRequestId();
    const stagedCommand: import("../src/bridge-protocol.js").SubmitVerdictCommand = {
      version: 1,
      kind: "submit_verdict",
      requestId: stagedRequestId,
      createdAt: "2026-08-18T00:00:00.000Z",
      workflowId: bridge.id,
      codexThreadId,
      submissionId: submitted.submissionId!,
      verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    };
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "verdict_ready";
      r.stagedVerdict = { command: stagedCommand, createdAt: stagedCommand.createdAt };
    });
    queue.commands.length = 0;
    callback.requests.length = 0;

    const recovered = await instance.recoverCallbacks();
    assert.equal(recovered, 0, "verdict_ready recovery is not a callback spawn");
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    assert.equal(callback.requests.length, 0, "verdict_ready recovery never respawns the callback");
    assert.equal(queue.commands.length, 1);
    // The re-enqueued command is byte-for-byte the staged one: same requestId,
    // createdAt, verdict payload — hence the same commandHash.
    assert.deepEqual(queue.commands[0], stagedCommand, "recovery re-enqueues the EXACT staged command");
    assert.equal(queue.commands[0]!.createdAt, stagedCommand.createdAt);
    // The staged identity is KEPT through received: a conflicting manual
    // verdict cannot jump ahead of the expected one.
    const receivedRecord = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(receivedRecord?.stagedVerdict?.command.requestId, stagedRequestId, "identity kept until applied");
    // Repeated recovery cannot mint a second, different identity.
    const again = await instance.recoverCallbacks();
    assert.equal(again, 0);
    assert.equal(queue.commands.length, 1);
    // Applying the expected identity clears the staged verdict.
    await instance.applyExternalVerdict(stagedCommand);
    const applied = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(applied?.phase, "passed");
    assert.equal(applied?.stagedVerdict, undefined, "staged identity cleared after apply");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rmRetry(directory);
  }
});

test("first apply only from received: verdict_ready is not applicable and conflicting request ids are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdictready-reject-"));
  try {
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback(), fakeBridgeQueue());
    const exec = fakeExec("session-vrr", directory, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-vrr", directory, codexThreadId);
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    const stagedRequestId = newRequestId();
    const stagedCommand: import("../src/bridge-protocol.js").SubmitVerdictCommand = {
      version: 1,
      kind: "submit_verdict",
      requestId: stagedRequestId,
      createdAt: "2026-08-18T00:00:00.000Z",
      workflowId: bridge.id,
      codexThreadId,
      submissionId: submitted.submissionId!,
      verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    };
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "verdict_ready";
      r.stagedVerdict = { command: stagedCommand, createdAt: stagedCommand.createdAt };
    });
    const base = {
      version: 1 as const,
      kind: "submit_verdict" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      workflowId: bridge.id,
      codexThreadId,
      submissionId: submitted.submissionId!,
      verdict: { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" },
    };
    // A different request id answering the same staged submission is refused.
    await assert.rejects(instance.applyExternalVerdict(base), /already staged/);
    // verdict_ready is NOT applicable even for the expected identity: the
    // first apply must wait for the enqueue commit (received).
    await assert.rejects(
      instance.applyExternalVerdict({ ...base, requestId: stagedRequestId }),
      /not yet applicable/,
    );
    const midState = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(midState?.submissionState, "verdict_ready");
    assert.equal(midState?.stagedVerdict?.command.requestId, stagedRequestId);

    // Phase C commits received (identity kept). Now the expected identity
    // applies — and a conflicting request id arriving FIRST still cannot
    // steal the apply.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      if (r.stagedVerdict?.command.requestId !== stagedRequestId) return;
      r.submissionState = "received";
      r.callbackState = "idle";
    });
    await assert.rejects(
      instance.applyExternalVerdict({ ...base, requestId: newRequestId() }),
      /already staged/,
      "a conflicting request id cannot jump ahead of the expected one",
    );
    assert.equal((await instance.applyExternalVerdict({ ...base, requestId: stagedRequestId })).phase, "passed");
    const applied = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(applied?.submissionState, "applied");
    assert.equal(applied?.stagedVerdict, undefined);
    // Replay of the SAME request id is idempotent; a DIFFERENT request id for
    // the same submission is refused after apply too.
    assert.equal((await instance.applyExternalVerdict({ ...base, requestId: stagedRequestId })).phase, "passed");
    await assert.rejects(
      instance.applyExternalVerdict({ ...base, requestId: newRequestId() }),
      /already applied as request/,
    );
  } finally {
    await rmRetry(directory);
  }
});

/** P1-3: the verdict is bound to the evidence fingerprint captured at submit
 * time. If the workspace changed since, an old "pass" must NEVER apply — not
 * even via the block/gate policy — and a fresh submit repairs the flow. */
test("a pass verdict is refused when the workspace changed since the review (git)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdict-changed-git-"));
  try {
    // The reviewed workspace is a nested repo; the workflow store lives OUTSIDE
    // it, so the plugin's own record files never pollute the git fingerprint.
    const repo = join(directory, "repo");
    await mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    const queue = fakeBridgeQueue();
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback(), queue);
    const exec = fakeExec("session-vcg", repo, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-vcg", repo, codexThreadId);
    const submitted = await instance.submit(bridge.id, { implementationSummary: "v1", changedFiles: ["changed.txt"] }, exec);
    await waitFor(() => queue.commands.length === 1);
    assert.ok(submitted.latestReviewEvidence?.fingerprint);
    // The automatic callback staged the exact verdict command; apply uses THAT
    // original command (same requestId/createdAt/hash), never a new one.
    const stagedCommand = queue.commands[0]!;

    // Workspace changes AFTER the review, before the verdict arrives.
    await writeFile(join(repo, "a.txt"), "v2-changed", "utf8");
    const refused = await instance.applyExternalVerdict(stagedCommand);
    assert.notEqual(refused.phase, "passed", "changed workspace must never apply a stale pass");
    assert.equal(refused.phase, "executing");
    assert.match(refused.error ?? "", /workspace changed since the review/);
    assert.equal(refused.latestReview, undefined, "the stale verdict and findings are void");

    // A fresh submit over the new state binds new evidence and passes.
    const resubmitted = await instance.submit(bridge.id, { implementationSummary: "v2", changedFiles: ["changed.txt"] }, exec);
    await waitFor(() => queue.commands.length === 2);
    assert.notEqual(resubmitted.submissionId, submitted.submissionId);
    const passed = await instance.applyExternalVerdict(queue.commands[1]!);
    assert.equal(passed.phase, "passed");
  } finally {
    await rmRetry(directory);
  }
});

test("a pass verdict is refused when the workspace changed since the review (non-git)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-verdict-changed-files-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const queue = fakeBridgeQueue();
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback(), queue);
    const exec = fakeExec("session-vcf", directory, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-vcf", directory, codexThreadId);
    const submitted = await instance.submit(bridge.id, { implementationSummary: "v1", changedFiles: ["a.txt"] }, exec);
    await waitFor(() => queue.commands.length === 1);
    assert.ok(submitted.latestReviewEvidence?.fingerprint);
    const stagedCommand = queue.commands[0]!;

    await writeFile(file, "v2-changed", "utf8");
    const refused = await instance.applyExternalVerdict(stagedCommand);
    assert.notEqual(refused.phase, "passed");
    assert.match(refused.error ?? "", /workspace changed since the review/);

    const resubmitted = await instance.submit(bridge.id, { implementationSummary: "v2", changedFiles: ["a.txt"] }, exec);
    await waitFor(() => queue.commands.length === 2);
    const passed = await instance.applyExternalVerdict(queue.commands[1]!);
    assert.equal(passed.phase, "passed");
  } finally {
    await rmRetry(directory);
  }
});

/** P1-4: the decision-gate fix prompt must point bridge workflows at
 * codex_workflow_submit, never codex_workflow_review. */
test("decide(fix) steers bridge workflows to submit and legacy workflows to review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-decide-origin-"));
  try {
    // Bridge workflow: the automatic callback produces a NON-BLOCKING
    // changes_requested verdict which reaches waiting_review_decision.
    const queue = fakeBridgeQueue();
    const callback = new FakeCallback();
    callback.results = [{
      kind: "verdict" as const,
      verdict: { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "nits" },
    }];
    const instance = manager(directory, new FakeGateway(), {}, callback, queue);
    const bridgeExec = fakeExec("session-decide-bridge", directory, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-decide-bridge", directory, codexThreadId);
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, bridgeExec);
    await waitFor(() => queue.commands.length === 1);
    const stagedCommand = queue.commands[0]!;
    assert.equal(stagedCommand.verdict.verdict, "changes_requested");
    const bridgeDeferred: unknown[] = [];
    const applied = await instance.applyExternalVerdict(stagedCommand);
    assert.equal(applied.phase, "waiting_review_decision");
    const decided = await instance.decide(bridge.id, { decision: "fix" }, fakeExec("session-decide-bridge", directory, bridgeDeferred));
    assert.equal(decided.phase, "fixing");
    const bridgeText = JSON.stringify(bridgeDeferred.map((m) => (m as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""));
    assert.match(bridgeText, /codex_workflow_submit/);
    assert.ok(!/codex_workflow_review/.test(bridgeText), "bridge fix prompt must not name the review tool");

    // Legacy workflow: review tool is still the right next step.
    const legacyGateway = new FakeGateway();
    legacyGateway.reviewResults = [{ verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "nits" }];
    const legacy = manager(join(directory, "legacy"), legacyGateway, {}, new FakeCallback(), fakeBridgeQueue());
    const planned = await legacy.start({ task: "Legacy" }, fakeExec("session-decide-legacy", directory, []));
    await legacy.review(planned.id, { implementationSummary: "Impl" }, fakeExec("session-decide-legacy", directory, []));
    const legacyDeferred: unknown[] = [];
    await legacy.decide(planned.id, { decision: "fix" }, fakeExec("session-decide-legacy", directory, legacyDeferred));
    const legacyText = JSON.stringify(legacyDeferred.map((m) => (m as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""));
    assert.match(legacyText, /codex_workflow_review/);
  } finally {
    await rmRetry(directory);
  }
});

/** P1-6: the submission lease is the cross-process claim gate — two manager
 * instances over one store can never double-spawn a callback for the same
 * submission, a live lease is never taken, and an expired lease is. */
test("two managers over one store spawn exactly one callback via the submission lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-lease-"));
  try {
    const setup = manager(directory, new FakeGateway(), {}, new FakeCallback(), fakeBridgeQueue());
    const exec = fakeExec("session-lease", directory, []);
    const bridge = await bridgeWorkflow(setup, "session-lease", directory, newRequestId());
    const submitted = await setup.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    await setup.stop();

    // Simulate a crash right after persist: queued submission, attempts 0.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "queued";
      r.submissionAttempts = 0;
    });
    const callbackA = new FakeCallback();
    const callbackB = new FakeCallback();
    const managerA = manager(directory, new FakeGateway(), {}, callbackA, fakeBridgeQueue());
    const managerB = manager(directory, new FakeGateway(), {}, callbackB, fakeBridgeQueue());
    const [a, b] = await Promise.all([managerA.recoverCallbacks(), managerB.recoverCallbacks()]);
    assert.equal(a + b, 1, "exactly one manager wins the claim");
    await waitFor(async () => callbackA.requests.length + callbackB.requests.length === 1);
    assert.equal(callbackA.requests.length + callbackB.requests.length, 1, "exactly one child spawned");
    assert.ok(callbackA.requests[0]?.submissionId === submitted.submissionId
      || callbackB.requests[0]?.submissionId === submitted.submissionId);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rmRetry(directory);
  }
});

test("a live submission lease blocks recovery; an expired lease is taken over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-lease-expiry-"));
  try {
    const instance = manager(directory, new FakeGateway(), {}, new FakeCallback(), fakeBridgeQueue());
    const exec = fakeExec("session-lease-exp", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-lease-exp", directory, newRequestId());
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    await instance.stop();
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "queued";
      r.submissionAttempts = 0;
    });
    const coordination = new WorkflowStore(directory).coordinationHandle;
    const resource = `submission:${bridge.id}:${submitted.submissionId}`;

    // Live lease (another process): recovery must skip it entirely.
    const grant = coordination.acquireLease(resource, 60_000, "other-process");
    assert.ok(grant, "other process holds the lease");
    const blocked = new FakeCallback();
    const blocker = manager(directory, new FakeGateway(), {}, blocked, fakeBridgeQueue());
    assert.equal(await blocker.recoverCallbacks(), 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(blocked.requests.length, 0, "a live lease must not be stolen");

    // The owner releases (or crashes — lease then expires): recovery takes over.
    assert.equal(coordination.releaseLease(resource, grant!.epoch, grant!.owner), true);
    const taker = new FakeCallback();
    const takerMgr = manager(directory, new FakeGateway(), {}, taker, fakeBridgeQueue());
    assert.equal(await takerMgr.recoverCallbacks(), 1);
    await waitFor(async () => taker.requests.length === 1);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rmRetry(directory);
  }
});

/** P2: attempts are counted once per REAL spawn — a recovery claim must not
 * consume an extra attempt on top of the actual callback run. */
test("recovery counts exactly one attempt per real callback spawn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-attempts-"));
  try {
    const callback = new FakeCallback();
    callback.results = [{ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } }];
    const instance = manager(directory, new FakeGateway(), {}, callback, fakeBridgeQueue());
    const exec = fakeExec("session-attempts", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-attempts", directory, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(submitted.submissionAttempts, 1, "one live spawn = one attempt");
    assert.equal(callback.requests.length, 1);

    // Crash after the first real send: persisted attempts stay at 1.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "queued";
    });
    callback.results.push({ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });
    callback.requests.length = 0;
    assert.equal(await instance.recoverCallbacks(), 1);
    await waitFor(async () => callback.requests.length === 1);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const finalRecord = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(finalRecord?.submissionAttempts, 2, "recovery spawn = exactly one more attempt");
    assert.equal(callback.requests.length, 1);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rmRetry(directory);
  }
});

/** P0-B (round 3): workflow creation is atomic per session/request — two
 * overlapping creators for the same request yield exactly one workflow and
 * the same idempotent record; the same session cannot get two active
 * workflows. */
test("concurrent dispatch of the same request yields exactly one workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-create-atomic-"));
  try {
    const agent = fakeExec("session-create", directory, []).agent!;
    const shared = new WorkflowStore(directory);
    const managerA = new WorkflowManager(shared, new FakeGateway(), { ...config, storageDir: directory });
    const managerB = new WorkflowManager(new WorkflowStore(directory), new FakeGateway(), { ...config, storageDir: directory });
    const command = {
      version: 1 as const,
      kind: "dispatch_plan" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: directory, dshSessionId: "session-create" },
      task: "Concurrent dispatch",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    };
    const [a, b] = await Promise.all([
      managerA.startExternalPlan(command, agent),
      managerB.startExternalPlan(command, agent),
    ]);
    assert.equal(a.id, b.id, "both creators return the SAME workflow");
    const active = await shared.activeForSession("session-create");
    assert.equal(active?.id, a.id);
    const all = await shared.list();
    assert.equal(all.filter((r) => r.dshSessionId === "session-create" && r.bridgeRequestId === command.requestId).length, 1);
  } finally {
    await rmRetry(directory);
  }
});

test("concurrent dispatch of different requests on one session leaves exactly one active workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-create-session-"));
  try {
    const agent = fakeExec("session-create-2", directory, []).agent!;
    const shared = new WorkflowStore(directory);
    const managerA = new WorkflowManager(shared, new FakeGateway(), { ...config, storageDir: directory });
    const managerB = new WorkflowManager(new WorkflowStore(directory), new FakeGateway(), { ...config, storageDir: directory });
    const makeCommand = () => ({
      version: 1 as const,
      kind: "dispatch_plan" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: directory, dshSessionId: "session-create-2" },
      task: "Race",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    });
    const [a, b] = await Promise.allSettled([
      managerA.startExternalPlan(makeCommand(), agent),
      managerB.startExternalPlan(makeCommand(), agent),
    ]);
    const fulfilled = [a, b].filter((r): r is PromiseFulfilledResult<import("../src/types.js").WorkflowRecord> => r.status === "fulfilled");
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one creator creates");
    assert.ok(rejected.length === 1, "the other is rejected (already active or creating)");
    assert.match(String(rejected[0]!.reason), /active Codex workflow|already creating/);
    const active = await shared.activeForSession("session-create-2");
    assert.equal(active?.id, fulfilled[0]!.value.id);
    assert.equal((await shared.list()).filter((r) => r.dshSessionId === "session-create-2").length, 1);
  } finally {
    await rmRetry(directory);
  }
});

/** A-lost-lease fencing: after B takes over A's submission lease, A's late
 * callback result must never write state or enqueue a verdict. */
test("a callback owner that lost its lease cannot write or enqueue a verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-leaselost-"));
  try {
    // A SHARED queue is injected into both owners, so the queue's content is
    // the single observable truth: only the new owner's staged command may
    // ever appear.
    const sharedQueue = fakeBridgeQueue();
    const callbackA = new DeferredCallback();
    callbackA.deferredVerdict = { verdict: "pass", findings: [], testGaps: [], summary: "A-verdict" };
    const instanceA = manager(directory, new FakeGateway(), { leaseTtlMs: 300 }, callbackA, sharedQueue);
    const exec = fakeExec("session-leaselost", directory, []);
    const bridge = await bridgeWorkflow(instanceA, "session-leaselost", directory, newRequestId());

    const pendingSubmit = instanceA.submit(bridge.id, { implementationSummary: "A", changedFiles: ["changed.txt"] }, exec);
    // Wait until A's callback child is in flight (its deferred send pending).
    await waitFor(async () => callbackA.sentRequests.length === 1);

    // B (another process/manager) takes over A's now-abandoned submission lease.
    const callbackB = new FakeCallback();
    callbackB.results.push({ kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "B-verdict" } });
    const instanceB = manager(directory, new FakeGateway(), { leaseTtlMs: 300 }, callbackB, sharedQueue);
    const coordination = new WorkflowStore(directory).coordinationHandle;
    const record = await new WorkflowStore(directory).load(bridge.id);
    const resource = `submission:${bridge.id}:${record!.submissionId}`;
    // Simulate A's lease being gone (expired/taken): clear the lease row.
    if (record!.submissionLeaseToken && record!.submissionLeaseEpoch !== undefined) {
      coordination.releaseLease(resource, record!.submissionLeaseEpoch, record!.submissionLeaseToken);
    }
    assert.equal(await instanceB.recoverCallbacks(), 1);
    // B completes the pipeline (verdict staged + enqueued + received).
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");

    // A's heartbeat detects the loss (renew changes 0 rows) and kills its child.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(callbackA.cancelledSubmissions.includes(`${bridge.id}:${record!.submissionId}`),
      "A kills its own callback child after losing the lease");

    // A's late callback result arrives: it must NOT write or enqueue anything.
    callbackA.releaseDeferred();
    await pendingSubmit;
    const after = await new WorkflowStore(directory).load(bridge.id);
    assert.equal(after?.submissionState, "received", "A did not regress the state");
    assert.equal(after?.appliedVerdictRequestId, undefined, "A did not apply");
    // Shared-persistent-queue semantics: exactly the NEW owner's command exists.
    assert.equal(sharedQueue.commands.length, 1, "only B's verdict ever entered the shared queue");
    for (const command of sharedQueue.commands) {
      assert.equal(command.verdict.summary, "B-verdict", "only the NEW owner enqueues");
      assert.equal(command.submissionId, record!.submissionId);
      assert.equal(command.requestId, after?.stagedVerdict?.command.requestId);
    }
    assert.equal(after?.stagedVerdict?.command.verdict.summary, "B-verdict");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rmRetry(directory);
  }
});

/** [#1 review] The reviewer gets the FULL bounded diff (no silent 8KB clip)
 * when it fits, and is explicitly allowed read-only inspection commands. */
test("callback embeds the full bounded diff and allows read-only inspection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-bigdiff-"));
  try {
    const repo = join(directory, "repo");
    await mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    // A diff comfortably between 8KB (the old silent clip) and 64KB (embed bound).
    const big = Array.from({ length: 1200 }, (_, i) =>
      `line-${String(i).padStart(5, "0")} a reasonably long line of change content`,
    ).join("\n");
    assert.ok(big.length > 8000, "the diff must exceed the former 8KB clip");
    assert.ok(big.length < 65536);
    await writeFile(join(repo, "a.txt"), big, "utf8");

    const callback = new FakeCallback();
    const instance = manager(directory, new FakeGateway(), {}, callback, fakeBridgeQueue());
    const exec = fakeExec("session-bigdiff", repo, []);
    const bridge = await bridgeWorkflow(instance, "session-bigdiff", repo, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "big change", changedFiles: ["changed.txt"] }, exec);
    await waitFor(() => callback.requests.length === 1);
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
    const submitted = (await new WorkflowStore(directory).load(bridge.id))!;
    assert.equal(submitted.submissionState, "received");
    const prompt = callback.requests[0]!.prompt;
    // The full diff is embedded — a line far beyond byte 8000 is present.
    assert.ok(prompt.includes("line-01199"), "the full bounded diff is embedded, not clipped at 8KB");
    assert.match(prompt, /\[full observed diff, \d+ bytes\]/);
    // Read-only inspection is allowed; the hard "Do not run any command" ban is gone.
    assert.match(prompt, /read-only inspection commands/);
    assert.match(prompt, /MUST NOT write or modify any file/);
    assert.ok(!/Do not run any command/.test(prompt), "the reviewer may run read-only inspection commands");
    // The background prompt carries the SAME item-by-item coverage gate (and
    // the git scope) as the DSH-led custom target.
    assert.match(prompt, /ITEM-BY-ITEM COVERAGE:/, "the callback prompt carries the coverage gate");
    assert.match(prompt, /staged, unstaged AND untracked/, "git scope in the callback prompt");
    assert.match(prompt, /git status/, "independent git status check in the callback prompt");
    assert.match(prompt, /must be IMPLEMENTED in the observed changes/);
    assert.match(prompt, /REAL COMMAND verification/);
    assert.match(prompt, /Never demand changes that exceed the ORIGINAL TASK \/ APPROVED PLAN/);
  } finally {
    await rmRetry(directory);
  }
});

/** [#1 review] When evidence collection had to truncate the diff, the reviewer
 * is explicitly told and still allowed read-only inspection of the workspace. */
test("callback tells the reviewer the diff was truncated and still allows read-only inspection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-hugediff-"));
  try {
    const repo = join(directory, "repo");
    await mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    const huge = Array.from({ length: 5000 }, (_, i) => `r${i}-${"y".repeat(24)}`).join("\n");
    assert.ok(Buffer.byteLength(huge, "utf8") > 65536, "well beyond the embed bound");
    await writeFile(join(repo, "a.txt"), huge, "utf8");

    const callback = new FakeCallback();
    const instance = manager(directory, new FakeGateway(), {}, callback, fakeBridgeQueue());
    const exec = fakeExec("session-hugediff", repo, []);
    const bridge = await bridgeWorkflow(instance, "session-hugediff", repo, newRequestId());
    await instance.submit(bridge.id, { implementationSummary: "huge change", changedFiles: ["changed.txt"] }, exec);
    await waitFor(() => callback.requests.length === 1);
    const prompt = callback.requests[0]!.prompt;
    assert.match(
      prompt,
      /\[diff truncated by evidence collection, observed \d+ bytes; the full diff was too large to embed\]/,
      "the reviewer is told it is truncated",
    );
    assert.match(prompt, /read-only inspection commands/, "and allowed to inspect the rest itself");
    assert.match(prompt, /MUST NOT write or modify any file/);
    assert.match(prompt, /ITEM-BY-ITEM COVERAGE:/, "the truncated-diff callback still carries the coverage gate");
    assert.match(prompt, /must be IMPLEMENTED in the observed changes/);
    assert.match(prompt, /REAL COMMAND verification/);
  } finally {
    await rmRetry(directory);
  }
});

/** Accessible callback whose send blocks until released; rejects on abort. */
class AbortableCallback implements CodexCallback {
  results: Array<CodexCallbackResult | Error> = [];
  requests: Array<{ workflowId: string; submissionId: string }> = [];
  sendCalls = 0;
  cancelledWorkflows: string[] = [];
  cancelledSubmissions: string[] = [];
  stopped = false;
  private releaseFn?: () => void;

  async send(request: { workflowId: string; submissionId: string; codexThreadId: string; cwd: string; prompt: string }, signal?: AbortSignal): Promise<CodexCallbackResult> {
    this.requests.push(request);
    this.sendCalls += 1;
    await new Promise<void>((resolve, reject) => {
      this.releaseFn = resolve;
      signal?.addEventListener("abort", () => reject(new Error("callback aborted")), { once: true });
    });
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "pass" } };
  }

  release(): void {
    this.releaseFn?.();
    this.releaseFn = undefined;
  }

  cancel(workflowId: string): void {
    this.cancelledWorkflows.push(workflowId);
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    this.cancelledSubmissions.push(`${workflowId}:${submissionId}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/** [#3 teardown] stop() awaits every recovery-derived background task; once it
 * returns there can be no further enqueue, store update or callback spawn. */
test("stop() awaits recovery-derived background tasks; nothing writes afterwards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-stopbg-"));
  try {
    // Setup: a normal submit creates the submission.
    const setupCb = new FakeCallback();
    const setupManager = manager(directory, new FakeGateway(), {}, setupCb, fakeBridgeQueue());
    const exec = fakeExec("session-stopbg", directory, []);
    const bridge = await bridgeWorkflow(setupManager, "session-stopbg", directory, newRequestId());
    await setupManager.submit(bridge.id, { implementationSummary: "bg", changedFiles: ["changed.txt"] }, exec);
    await waitFor(async () => {
      const record = await new WorkflowStore(directory).load(bridge.id);
      return record?.submissionState === "received" && !record.submissionLeaseToken;
    });
    await setupManager.stop();
    // Simulate a crash: the submission is recoverable again.
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionState = "queued";
      r.submissionAttempts = 0;
      r.pendingReviewRequest = { implementationSummary: "bg", changedFiles: ["changed.txt"] };
    });

    // Recovery with an abortable callback; the derived task blocks on send.
    const queueB = fakeBridgeQueue();
    const cb = new AbortableCallback();
    const instanceB = manager(directory, new FakeGateway(), { leaseTtlMs: 30_000 }, cb, queueB);
    const recovered = await instanceB.recoverCallbacks();
    assert.equal(recovered, 1);
    await waitFor(async () => cb.sendCalls === 1);

    // stop() must abort and await that in-flight derived task before returning.
    await instanceB.stop();
    assert.equal(cb.stopped, true, "callback dispatcher stopped");
    // No further writes after stop returns — the task was awaited. Snapshot the
    // record (including its revision) at stop-return and require it to be
    // byte-identical later: no late store update may happen.
    const snapshot = await new WorkflowStore(directory).load(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const later = await new WorkflowStore(directory).load(bridge.id);
    assert.deepEqual(later, snapshot, "the record is unchanged after stop() returned");
    assert.equal(cb.sendCalls, 1, "no callback respawn after stop");
    assert.equal(queueB.commands.length, 0, "no verdict enqueued by the aborted task");
    assert.notEqual(snapshot?.submissionState, "received", "the aborted task never committed received");
  } finally {
    await rmRetry(directory);
  }
});

/** Finding 6: concurrent stop() calls share ONE settle promise — the second
 * caller never resolves before the first has truly finished tearing down. */
test("concurrent manager.stop() share one settle promise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-stopconc-"));
  try {
    const cb = new DeferredCallback();
    cb.deferredVerdict = { verdict: "pass", findings: [], testGaps: [], summary: "ok" };
    const instance = manager(directory, new FakeGateway(), { leaseTtlMs: 30_000 }, cb, fakeBridgeQueue());
    const exec = fakeExec("session-stopconc", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-stopconc", directory, newRequestId());
    // Persist a recoverable (queued) submission directly; a recovery then
    // spawns a derived callback task that blocks on the deferred gate (it
    // ignores the abort, so stop() must wait for the release).
    const submissionId = newRequestId();
    await new WorkflowStore(directory).update(bridge.id, (r) => {
      r.submissionId = submissionId;
      r.submissionState = "queued";
      r.submissionAttempts = 0;
      r.callbackState = "queued";
      r.pendingReviewRequest = { implementationSummary: "done", changedFiles: ["changed.txt"] };
    });
    const recovered = await instance.recoverCallbacks();
    assert.equal(recovered, 1);
    // The background task may or may not have reached its send by now (not a
    // contract); wait until the deferred callback is parked before stopping.
    await waitFor(async () => cb.sentRequests.length === 1);

    const first = instance.stop();
    let secondDone = false;
    const second = instance.stop();
    second.then(() => { secondDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondDone, false, "the second stop must not resolve before the first settles");
    cb.releaseDeferred();
    await Promise.all([first, second]);
    assert.equal(secondDone, true);
  } finally {
    await rmClosed(directory);
  }
});

test("review infra failures keep the workflow retryable; first applied verdict is still cycle 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-cycles-revfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "no" },
      { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    ];
    const instance = manager(directory, gateway, {}, new FakeCallback());
    const exec = fakeExec("session-revfail", directory, []);
    const planned = await instance.start({ task: "Do it" }, exec);
    assert.equal(planned.phase, "executing");
    // Three consecutive reviewer-infrastructure failures.
    let infraFailures = 3;
    const realStartReview = gateway.startReview.bind(gateway);
    gateway.startReview = async (opts) => {
      if (infraFailures > 0) {
        infraFailures -= 1;
        throw new Error("app-server restarting");
      }
      return realStartReview(opts);
    };
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        instance.review(planned.id, { implementationSummary: `try ${i}`, changedFiles: ["changed.txt"] }, exec),
        /app-server restarting/,
      );
      const r = await new WorkflowStore(directory).load(planned.id);
      assert.equal(r?.phase, "executing", `stays retryable after infra failure ${i + 1}`);
      assert.equal(r?.reviewCycles, 0, "infra failure consumed no cycle");
      assert.ok(r?.error, "the error is recorded for diagnosis");
    }
    assert.equal(infraFailures, 0);
    // The FOURTH review is the first real verdict: it must be cycle 1.
    const reviewed = await instance.review(planned.id, { implementationSummary: "real", changedFiles: ["changed.txt"] }, exec);
    assert.equal(reviewed.reviewCycles, 1, "first applied verdict is cycle 1 after three infra failures");
    assert.equal(reviewed.phase, "fixing");
    void gateway;
  } finally {
    await rmClosed(directory);
  }
});

/** Finding 1: invalidating a waiting_review_decision verdict must return the
 * workflow to executing (cleared latestReview), so the VOID guidance (submit
 * again) matches the tool's phase gate and another submit succeeds. */
test("invalidating a waiting_review_decision verdict returns to executing and allows resubmit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-inv-wrd-"));
  try {
    const queue = fakeBridgeQueue();
    const callback = new FakeCallback();
    callback.results = [{
      kind: "verdict" as const,
      verdict: { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "nits" },
    }];
    const instance = manager(directory, new FakeGateway(), {}, callback, queue);
    const exec = fakeExec("session-inv-wrd", directory, []);
    const codexThreadId = newRequestId();
    const bridge = await bridgeWorkflow(instance, "session-inv-wrd", directory, codexThreadId);
    const submitted = await instance.submit(bridge.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    assert.equal(submitted.phase, "executing", "submit queues the verdict but does not change the phase");
    await waitFor(() => queue.commands.length === 1);
    const stagedCommand = queue.commands[0]!;
    assert.ok(stagedCommand.dshSessionId === "session-inv-wrd", "staged verdict carries the workflow session");
    const applied = await instance.applyExternalVerdict(stagedCommand);
    assert.equal(applied.phase, "waiting_review_decision", "non-blocking changes_requested reaches waiting_review_decision");
    assert.ok((await new WorkflowStore(directory).load(bridge.id))?.latestReview, "the decision-gate review is present");
    // The workspace changes before (prepare → relay): the verdict is void.
    await writeFile(join(directory, "changed.txt"), "changed after the review\n", "utf8");
    const inv = await instance.assertVerdictStillValid(stagedCommand);
    assert.equal(inv.invalidated, true);
    assert.equal(inv.record.phase, "executing", "waiting_review_decision invalidates back to executing");
    assert.equal(inv.record.latestReview, undefined, "latestReview is cleared");
    assert.equal(inv.record.appliedVerdictEvidenceFingerprint, undefined);
    // The VOID guidance (call codex_workflow_submit again) now matches the
    // phase gate: a fresh submit succeeds.
    const resub = await instance.submit(bridge.id, { implementationSummary: "fresh", changedFiles: ["changed.txt"] }, exec);
    assert.equal(resub.phase, "executing");
    assert.equal(resub.submissionState, "queued", "a fresh submission starts in the background after invalidation");
    await waitFor(async () => (await new WorkflowStore(directory).load(bridge.id))?.submissionState === "received");
  } finally {
    await rmClosed(directory);
  }
});

/** A WorkflowStore whose list() can be ARM-ed to park on a gate — used to make
 * the single-flight recovery deterministic (see Finding 2 below). Nothing is
 * gated until `holdNextList` is set, so setup (startExternalPlan etc.) runs
 * normally. */
class ListGateStore extends WorkflowStore {
  holdNextList = false;
  listGate?: DeferredGate;
  override async list(): Promise<WorkflowRecord[]> {
    if (this.holdNextList) {
      this.holdNextList = false;
      if (this.listGate) await this.listGate.promise;
    }
    return super.list();
  }
}

/** Finding 2: recovery is single-flight; stop() must abort + await the ONE
 * active run and only then finish — a concurrent recoverCallbacks() must never
 * overwrite the chain stop() is waiting on. */
test("concurrent recoverCallbacks are single-flight; stop awaits the active run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-singleflight-"));
  try {
    const queue = fakeBridgeQueue();
    const callback = new AbortableCallback();
    const gate = deferredGate();
    const store = new ListGateStore(directory);
    const instance = new WorkflowManager(store, new FakeGateway(), { ...config, storageDir: directory }, callback, queue);
    const exec = fakeExec("session-singleflight", directory, []);
    const bridge = await bridgeWorkflow(instance, "session-singleflight", directory, newRequestId());
    // Persist a recoverable submission directly.
    const submissionId = newRequestId();
    await store.update(bridge.id, (r) => {
      r.submissionId = submissionId;
      r.submissionState = "queued";
      r.submissionAttempts = 0;
      r.callbackState = "queued";
      r.pendingReviewRequest = { implementationSummary: "done", changedFiles: ["changed.txt"] };
    });

    // First recovery parks on the gated list() BEFORE running recovery; the
    // activeRecovery flag is already set by then. The gate is armed now that
    // setup (which also lists) is complete.
    store.holdNextList = true;
    store.listGate = gate;
    const p1 = instance.recoverCallbacks();
    await waitFor(async () => instance["activeRecovery"] === true);
    // A concurrent second recovery must be a no-op (single-flight).
    const p2 = instance.recoverCallbacks();
    assert.equal(await p2, 0, "concurrent second recovery returns 0 without overwriting the active run");

    // stop() must abort AND await the single active run (parked on the gate),
    // so it must NOT finish before the gate is released.
    const stopPromise = instance.stop();
    let stopDone = false;
    stopPromise.then(() => { stopDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(stopDone, false, "stop must not return while the active recovery is still parked");
    assert.equal(callback.sendCalls, 0, "nothing was spawned while parked");
    gate.release();
    await Promise.all([p1, stopPromise]);
    assert.equal(stopDone, true);
    // The aborted recovery wrote nothing: record unchanged, no callback spawn.
    assert.equal(callback.sendCalls, 0, "no callback was spawned by the aborted recovery");
    const snapshot = await store.load(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = await store.load(bridge.id);
    assert.deepEqual(later, snapshot, "record (incl. revision) does not change after stop() returned");
    assert.equal(snapshot?.submissionState, "queued", "record untouched by the aborted recovery");
    void exec;
  } finally {
    await rmClosed(directory);
  }
});

/** Deterministic callback whose send can be parked and released later. */
class DeferredCallback implements CodexCallback {
  deferredVerdict?: ReviewResult;
  sentRequests: Array<{ workflowId: string; submissionId: string }> = [];
  cancelledSubmissions: string[] = [];
  cancelledWorkflows: string[] = [];
  stopped = false;
  private releaseFn?: () => void;

  async send(request: { workflowId: string; submissionId: string; codexThreadId: string; cwd: string; prompt: string }): Promise<CodexCallbackResult> {
    this.sentRequests.push(request);
    await new Promise<void>((resolve) => { this.releaseFn = resolve; });
    return { kind: "verdict", verdict: this.deferredVerdict! };
  }

  releaseDeferred(): void {
    this.releaseFn?.();
    this.releaseFn = undefined;
  }

  cancel(workflowId: string): void {
    this.cancelledWorkflows.push(workflowId);
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    this.cancelledSubmissions.push(`${workflowId}:${submissionId}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function completed(threadId: string, text: string): TurnWaitResult {
  return { kind: "completed", threadId, turnId: `turn-${Math.random()}`, status: "completed", text };
}

let needsInputCounter = 0;

/** Native requestUserInput result (first-turn or a consecutive re-clarification). */
function needsInput(id: string, question: string): TurnNeedsInputResult {
  needsInputCounter += 1;
  const turnId = `input-turn-${needsInputCounter}`;
  return {
    kind: "needs_input",
    threadId: "planner-thread",
    turnId,
    request: {
      requestId: needsInputCounter,
      threadId: "planner-thread",
      turnId,
      itemId: `item-${needsInputCounter}`,
      questions: [{ id, header: "Question", question, options: [], allowOther: false, secret: false }],
    },
  };
}

function fakeExec(sessionId: string, cwd: string, deferred: unknown[]): ToolRunContext {
  return {
    agent: { id: sessionId, session: { header: { cwd } } },
    signal: new AbortController().signal,
    deferContext: (message: unknown) => deferred.push(message),
  } as unknown as ToolRunContext;
}

/** Create a real git repository with one committed file, so git evidence can
 * observe workspace changes via porcelain status + diff fingerprints. */
async function initGitRepo(directory: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await writeFile(join(directory, "a.txt"), "v1", "utf8");
  await run("git", ["init", "-q"], { cwd: directory });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await run("git", ["config", "user.name", "Test"], { cwd: directory });
  await run("git", ["add", "-A"], { cwd: directory });
  await run("git", ["commit", "-q", "-m", "initial"], { cwd: directory });
}

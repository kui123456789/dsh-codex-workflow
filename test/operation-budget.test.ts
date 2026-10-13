import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexCliAuditGateway } from "../src/codex-cli-audit.js";
import { WorkflowStore } from "../src/store.js";
import { createWorkflowTools, MAX_SERIAL_RPCS, PLANNER_MAX_TURNS, reviewToolTimeout } from "../src/tools.js";
import type { TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const PLAN = [
  "# Goal", "Implement safe health inspection with explicit failures and useful diagnostics.",
  "# Changes", "- Read configuration and integrity through existing adapters, preserving persistence ownership and cancellation rules.",
  "# Verification", "- Check success, malformed configuration and unavailable storage deterministically.",
  "# Risks", "- Never initialize or mutate an existing inspection database; report unavailable state clearly.",
].join("\n");

test("the start tool deadline covers three real transient budgets before a complete plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-operation-budget-"));
  const store = new WorkflowStore(join(directory, "storage"));
  let elapsedMs = 0;
  let promptPhase = 0;
  let phaseCalls = 0;
  let previousPrompt: string | undefined;
  let threadStarts = 0;
  let conversions = 0;
  const turns: Array<{ threadId: string; phase: number; prompt: string }> = [];
  const gateway: CodexGateway = {
    async startThread() { threadStarts += 1; return "original-planner-thread"; },
    async resumeThread() { throw new Error("A new Planner must not be resumed"); },
    async startTurn(threadId, options): Promise<TurnWaitResult> {
      if (options.prompt !== previousPrompt) {
        previousPrompt = options.prompt;
        promptPhase += 1;
        phaseCalls = 0;
      }
      phaseCalls += 1;
      turns.push({ threadId, phase: promptPhase, prompt: options.prompt });
      const turnId = `model-turn-${turns.length}`;
      await options.onStarted?.({ threadId, turnId });
      // Exhaust the first wait at its deadline, then complete the original
      // continuation and completion phases just inside their own budgets.
      if (promptPhase === 1 || phaseCalls < 2) return {
        kind: "completed", threadId, turnId, status: "failed", text: "",
        error: "server_overloaded", reason: "turn failed",
      };
      return { kind: "completed", threadId, turnId, status: "completed",
        text: promptPhase === 2 ? "I will plan later." : PLAN };
    },
    async normalizeInFork(options) {
      conversions += 1;
      return { kind: "completed", threadId: options.threadId, turnId: `conversion-${conversions}`,
        status: "completed", text: JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
    },
    async continueTurn() { throw new Error("Unexpected clarification"); },
    async startReview() { throw new Error("Unexpected review"); },
    async interrupt() {},
  };
  // All values lie inside the live plugin's configuration clamps. Virtual time
  // preserves the actual retry loop while avoiding thirty minutes of waiting.
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 10_000, callbackMaxAttempts: 1, callbackRetryBaseMs: 200,
    transientRetryBaseMs: 300_000, transientRetryMaxMs: 300_000,
    transientRetryBudgetMs: 600_000, transientRetryJitterRatio: 0,
    turnTimeoutMs: 10_000, rpcTimeoutMs: 5000, idleProcessMs: 0,
    terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {
    now: () => elapsedMs, sleep: async (ms) => {
      assert.equal(ms, 300_000, "The original configured backoff is unchanged");
      // Timer delivery can overshoot its requested delay. Only the first
      // exhausted phase may wake at the deadline without starting more work.
      elapsedMs += config.transientRetryBudgetMs! - (promptPhase === 1 ? 0 : 1);
    }, random: () => 0.5,
  });
  const exec = { agent: { id: "budget-owner", session: { header: { cwd: directory } } },
    signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  try {
    const tool = createWorkflowTools(manager, config).find((candidate) => candidate.name === "codex_workflow_start")!;
    const result = await manager.start({ task: "Create a safe health check" }, exec);
    assert.equal(result.phase, "executing");
    assert.equal(threadStarts, 1);
    assert.equal(conversions, 2);
    assert.equal(turns.length, 5, "Expired wake-ups cannot add model attempts");
    assert.deepEqual([1, 2, 3].map((phase) => turns.filter((turn) => turn.phase === phase).length), [1, 2, 2]);
    assert.ok(turns.every((turn) => turn.threadId === "original-planner-thread"));
    assert.equal(elapsedMs, 1_799_998);
    const oldTwoBudgetDeadline = PLANNER_MAX_TURNS * config.turnTimeoutMs
      + MAX_SERIAL_RPCS * config.rpcTimeoutMs! + 2 * config.transientRetryBudgetMs + 15_000;
    assert.ok(elapsedMs > oldTwoBudgetDeadline, "this feasible path exceeded the previous host deadline");
    assert.ok(tool.timeoutMs! >= elapsedMs, "the host deadline must cover every serial retry budget");
  } finally {
    await manager.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const transport of ["cli", "app-server"] as const) {
  test(transport === "cli"
    ? "cli review deadline includes explicit CLI timeouts after near-deadline App Server attempts"
    : "app-server foreground conversion failure never switches silently to CLI or another Reviewer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-operation-budget-"));
    await writeFile(join(directory, "changed.txt"), "health implementation", "utf8");
    const store = new WorkflowStore(join(directory, "storage"));
    let elapsedMs = 0;
    let appServerConversions = 0;
    let privateThreads = 0;
    const reviewerThreads: string[] = [];
    const auditCalls: string[] = [];
    const config: WorkflowConfig = {
      codexCommand: "codex", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
      plannerEffort: "high", reviewerEffort: "high", conversionTransport: transport, conversionFallback: "cli",
      maxReviewCycles: 3, maxNoChangeReviewRounds: 1, reviewDiffMaxBytes: 65536,
      bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
      callbackTimeoutMs: 1_800_000, callbackMaxAttempts: 1, callbackRetryBaseMs: 200,
      transientRetryBaseMs: 200, transientRetryMaxMs: 200, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
      turnTimeoutMs: 10_000, rpcTimeoutMs: 5000, idleProcessMs: 0,
      terminalRelayTimeoutMs: 1000, storageDir: store.directory,
    };
    const verdict = { verdict: "pass" as const, findings: [], testGaps: [], summary: "Requirements verified" };
    const audit: CodexCliAuditGateway = {
      async createReview() { throw new Error("The visible review runs through App Server"); },
      async review() { throw new Error("The visible review runs through App Server"); },
      async normalize() {
        auditCalls.push("normalize");
        elapsedMs += config.callbackTimeoutMs - 1;
        return verdict;
      },
      async align() {
        auditCalls.push("align");
        elapsedMs += config.callbackTimeoutMs - 1;
        return { aligned: true, conflicts: [] };
      },
      async reconcile() { throw new Error("A passing review needs no reconciliation"); },
      cancel() {},
      cancelSubmission() {},
      async stop() {},
    };
    const gateway: CodexGateway = {
      async startThread() { return `alignment-${++privateThreads}`; },
      async startReviewerThread() {
        const threadId = `original-reviewer-${reviewerThreads.length + 1}`;
        reviewerThreads.push(threadId);
        return threadId;
      },
      async resumeThread() {},
      async unsubscribeThread() {},
      async startReview(options) {
        elapsedMs += config.turnTimeoutMs - 1;
        await options.onStarted?.({ threadId: options.threadId, turnId: "visible-review" });
        return { threadId: options.threadId, result: { kind: "completed", status: "completed",
          threadId: options.threadId, turnId: "visible-review",
          text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Requirements verified." } };
      },
      async normalizeInFork() {
        appServerConversions += 1;
        elapsedMs += config.turnTimeoutMs - 1;
        throw new Error("App Server conversion unavailable");
      },
      async startTurn() { throw new Error("A passing review needs no rewrite"); },
      async continueTurn() { throw new Error("Unexpected clarification"); },
      async interrupt() {},
    };
    const manager = new WorkflowManager(store, gateway, config, undefined, undefined, audit, {
      now: () => elapsedMs, sleep: async (ms) => { elapsedMs += ms; },
    });
    const exec = { agent: { id: "cli-budget-owner", session: { header: { cwd: directory } } },
      signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
    try {
      const input = { implementationSummary: "Added health diagnostics", changedFiles: ["changed.txt"] };
      if (transport === "app-server") {
        await assert.rejects(manager.reviewOnly({ task: "Review the health implementation", ...input }, exec),
          /App Server conversion unavailable/);
        const record = (await store.list())[0]!;
        assert.equal(record.processState, "failed");
        assert.equal(record.reviewFailureReason, "original_reviewer_unavailable");
        assert.equal(record.reviewCycles, 0);
        assert.equal(record.latestReview, undefined);
        assert.deepEqual((await manager.status(record.id, exec)).continuation,
          { available: false, reason: "thread_unavailable" });
        await assert.rejects(manager.review(record.id, input, exec),
          /original Reviewer is unavailable; unchanged evidence requires an explicitly requested independent review round/);
        assert.equal(reviewerThreads.length, 1, "unchanged material cannot replace the failed original Reviewer");
        assert.equal(appServerConversions, 1);
        assert.deepEqual(auditCalls, [], "foreground ignores hidden CLI fallback even when conversionFallback is cli");
        assert.equal(privateThreads, 0);
        await assert.rejects(manager.review(record.id, { ...input, newReviewRound: true }, exec),
          /App Server conversion unavailable/);
        assert.equal(reviewerThreads.length, 2, "only an explicit independent review round admits another Reviewer");
        assert.equal(new Set(reviewerThreads).size, 2);
        assert.equal(appServerConversions, 2);
        assert.deepEqual(auditCalls, []);
        assert.equal((await store.load(record.id))!.reviewCycles, 0);
        return;
      }
      const result = await manager.reviewOnly({ task: "Review the health implementation", ...input }, exec);
      assert.equal(result.phase, "passed");
      assert.deepEqual(auditCalls, ["normalize", "align"], "this real pass path uses two independent CLI timeouts");
      assert.equal(appServerConversions, 0);
      const expectedElapsed = 2 * (config.callbackTimeoutMs - 1)
        + (1 + appServerConversions) * (config.turnTimeoutMs - 1);
      assert.equal(elapsedMs, expectedElapsed);
      assert.ok(elapsedMs > reviewToolTimeout(config.turnTimeoutMs, config.rpcTimeoutMs!, 0),
        "the old App Server-only formula cannot cover this supported CLI path");
      const tool = createWorkflowTools(manager, config).find((candidate) => candidate.name === "codex_workflow_review_only")!;
      assert.ok(tool.timeoutMs! >= elapsedMs, "the visible App Server turn and explicitly selected CLI work consume additive time");
    } finally {
      await manager.stop();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

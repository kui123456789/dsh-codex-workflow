import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createWorkflowTools } from "../src/tools.js";
import { mergeWorkflowObservedUsage, type WorkflowUsageSource } from "../src/workflow-usage.js";
import type { WorkflowConfig } from "../src/types.js";
import type { WorkflowManager } from "../src/workflow.js";

function fixture(count = 11) {
  const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 5,
    outputTokens: 20, reasoningOutputTokens: 6 };
  const sources: WorkflowUsageSource[] = Array.from({ length: count }, (_, index) => ({
    sourceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    stage: index === 0 ? "planning" : "reviewing", model: "test-model", total: { ...counts }, last: { ...counts }, modelContextWindow: 128000,
  }));
  return {
    schemaVersion: 1, id: "fixture-workflow", dshSessionId: "fixture-session", cwd: "C:/synthetic-workspace",
    task: "增加只读健康检查命令，保留失败恢复机制", mode: "planned", phase: "executing",
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
    planMarkdown: "# 目标\n增加健康检查。\n# 改动\n读取配置并报告 SQLite 状态。\n# 验证\n验证缺失和正常配置。",
    assumptions: [], questions: [], reviewCycles: 0,
    latestReview: { verdict: "pass", findings: [], testGaps: [], summary: "符合当前要求" },
    latestReviewEvidence: { kind: "files", changedFiles: ["implementation.txt"], status: "fixture", diff: "fixture diff",
      diffTruncated: false, diffBytes: 12, fingerprint: "synthetic-fingerprint",
      fileHashes: [{ path: "implementation.txt", sha256: "0".repeat(64) }], missingFiles: [], rejectedPaths: [], insufficient: false },
    continuation: { available: false, reason: "not_waiting" }, reviewerActive: false,
    observedUsage: mergeWorkflowObservedUsage(undefined, sources),
  };
}

async function runtime(value: unknown) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  let calls = 0;
  const manager = {
    status: async () => { calls += 1; return value; },
    start: async () => { calls += 1; return value; },
    cancel: async () => { calls += 1; return value; },
  } as unknown as WorkflowManager;
  const definitions = createWorkflowTools(manager, { turnTimeoutMs: 1_000, transientRetryBudgetMs: 0 } as WorkflowConfig);
  for (const definition of definitions) ctx.tools.register(definition);
  let call = 0;
  const execute = (name: string, args = {}) => ctx.tools.execute({ callId: ToolCallId(`render-${++call}`),
    name, arguments: args, signal: new AbortController().signal });
  return { ctx, execute, calls: () => calls };
}

function contentValue(result: Awaited<ReturnType<ToolRuntime["execute"]>>) {
  assert.equal(result.isError, false, JSON.stringify(result));
  const text = result.content.find((block) => block.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text);
}

test("real DSH ToolRuntime keeps full canonical usage while rendering a default source summary", async () => {
  const value = fixture();
  const before = structuredClone(value);
  const r = await runtime(value);
  try {
    const result = await r.execute("codex_workflow_status");
    const rendered = contentValue(result);
    assert.equal(rendered.observedUsage.sources, undefined, "ordinary status must not repeat the entire source history");
    assert.equal(rendered.observedUsage.sourceCount, 11);
    assert.equal(rendered.observedUsage.sourcesIncluded, false);
    assert.deepEqual(rendered.observedUsage.summary, value.observedUsage.summary);
    assert.deepEqual(result.value, before, "programmatic consumers still receive the complete canonical ledger");
    assert.deepEqual(value, before, "rendering never mutates the manager's result");
    assert.deepEqual({ ...rendered, observedUsage: undefined }, { ...before, observedUsage: undefined });
  } finally { await r.ctx.fiber.dispose(); }
});

test("status detail opt-in returns the full model source list without changing canonical data", async () => {
  const value = fixture();
  const r = await runtime(value);
  try {
    for (const flag of [false, true]) {
      const result = await r.execute("codex_workflow_status", { includeUsageSources: flag });
      const rendered = contentValue(result);
      assert.equal(rendered.observedUsage.sources?.length, flag ? 11 : undefined);
      assert.deepEqual(result.value, value);
    }
  } finally { await r.ctx.fiber.dispose(); }
});

test("ordinary control tool output preserves the complete plan while compacting only usage display", async () => {
  const value = fixture();
  const r = await runtime(value);
  try {
    const result = await r.execute("codex_workflow_start", { task: value.task });
    const rendered = contentValue(result);
    assert.equal(rendered.planMarkdown, value.planMarkdown);
    assert.deepEqual(rendered.latestReview, value.latestReview);
    assert.deepEqual(rendered.latestReviewEvidence, value.latestReviewEvidence);
    assert.equal(rendered.observedUsage.sources, undefined);
    assert.deepEqual(result.value, value);
  } finally { await r.ctx.fiber.dispose(); }
});

test("a tool policy hook failure remains a failure without rendering or exposing canonical usage", async () => {
  const value = fixture();
  const r = await runtime(value);
  try {
    r.ctx.on("tools/pre-execute", async () => { throw new Error("policy hook failed"); });
    const result = await r.execute("codex_workflow_status");
    assert.equal(result.isError, true);
    assert.equal(result.value, undefined);
    assert.equal(r.calls(), 0);
    assert.equal(JSON.stringify(result.content).includes("00000000-0000-4000-8000"), false);
    assert.deepEqual(value, fixture());
  } finally { await r.ctx.fiber.dispose(); }
});

test("render byte growth from one to eleven sources excludes repeated history without changing business data", async (t) => {
  const results: Array<{ sourceCount: number; detailBytes: number; summaryBytes: number }> = [];
  for (const count of [1, 11]) {
    const value = fixture(count);
    const r = await runtime(value);
    try {
      const result = await r.execute("codex_workflow_status");
      const rendered = contentValue(result);
      results.push({ sourceCount: count, detailBytes: Buffer.byteLength(JSON.stringify(value, null, 2), "utf8"),
        summaryBytes: Buffer.byteLength(JSON.stringify(rendered, null, 2), "utf8") });
      assert.deepEqual({ ...rendered, observedUsage: undefined }, { ...value, observedUsage: undefined });
    } finally { await r.ctx.fiber.dispose(); }
  }
  assert.ok(results[1]!.detailBytes - results[0]!.detailBytes > 5_000);
  assert.ok(results[1]!.summaryBytes - results[0]!.summaryBytes < 100);
  assert.ok(results.every((result) => result.summaryBytes < result.detailBytes));
  t.diagnostic(JSON.stringify({ encoding: "utf8", measurement: "rendered bytes, not model tokens or fees", results }));
});

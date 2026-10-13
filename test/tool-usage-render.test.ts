import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkflowToolResult } from "../src/tool-usage-render.js";

function record() {
  return {
    id: "workflow", task: "Implement the health command", phase: "executing",
    planMarkdown: "# Goal\nInspect local storage without initialization.",
    questions: [{ id: "choice", question: "Which checks are required?" }], assumptions: ["read-only inspection"],
    latestReview: { verdict: "changes_requested", findings: [{ title: "Missing check", body: "Inspect the absent file case." }] },
    latestReviewEvidence: { diff: "complete existing evidence", fingerprint: "fixture" },
    error: "turn failed", continuation: { available: true }, backgroundReview: true,
    submissionId: "submission", submissionState: "retrying", reviewDecision: { decision: "fix" },
    observedUsage: {
      version: 1, source: "app_server", scope: "observed_original_threads",
      sources: [{ sourceId: "opaque-source", stage: "reviewing", anomalies: ["counter_regression"], modelMixed: true }],
      summary: { observedSources: 1, missingSources: 1, partialSources: 1, anomalousSources: 1,
        total: { inputTokens: 100 }, overflowCounters: ["totalTokens"] },
    },
  };
}

test("compact usage display preserves every business field and all summary diagnostics", () => {
  const value = record();
  const before = structuredClone(value);
  Object.freeze(value.observedUsage.sources[0]);
  Object.freeze(value.observedUsage.sources);
  Object.freeze(value.observedUsage.summary);
  Object.freeze(value.observedUsage);
  Object.freeze(value);
  const rendered = formatWorkflowToolResult(value) as ReturnType<typeof record> & {
    observedUsage: { sourceCount: number; sourcesIncluded: boolean };
  };
  assert.deepEqual({ ...rendered, observedUsage: undefined }, { ...before, observedUsage: undefined });
  assert.deepEqual(rendered.observedUsage, {
    version: 1, source: "app_server", scope: "observed_original_threads", summary: before.observedUsage.summary,
    sourceCount: 1, sourcesIncluded: false,
  });
  assert.deepEqual(value, before);
});

test("explicit usage detail returns the complete canonical source history unchanged", () => {
  const value = record();
  assert.strictEqual(formatWorkflowToolResult(value, true), value);
  assert.equal(value.observedUsage.sources[0]?.modelMixed, true);
  assert.deepEqual(value.observedUsage.sources[0]?.anomalies, ["counter_regression"]);
});

test("unsupported or absent usage shapes remain untouched", () => {
  const usage = record().observedUsage;
  for (const value of [undefined, null, "error", [], {}, { phase: "failed", error: "lookup failed" },
    { observedUsage: null }, { observedUsage: { ...usage, version: 2 } },
    { observedUsage: { ...usage, source: "cli" } }, { observedUsage: { ...usage, scope: "another_scope" } },
    { observedUsage: { ...usage, sources: {} } }, { observedUsage: { ...usage, summary: undefined } },
    { observedUsage: { ...usage, summary: [] } }]) {
    assert.strictEqual(formatWorkflowToolResult(value), value);
  }
});

test("an empty source list does not invent token totals", () => {
  const value = { observedUsage: { version: 1, source: "app_server", scope: "observed_original_threads", sources: [],
    summary: { observedSources: 0, missingSources: 0, partialSources: 0, anomalousSources: 0 } } };
  const rendered = formatWorkflowToolResult(value) as { observedUsage: { sourceCount: number; summary: { total?: unknown } } };
  assert.equal(rendered.observedUsage.sourceCount, 0);
  assert.equal(rendered.observedUsage.summary.total, undefined);
  assert.equal(value.observedUsage.sources.length, 0);
});

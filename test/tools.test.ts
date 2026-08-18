import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTools } from "../src/tools.js";
import type { WorkflowConfig } from "../src/types.js";

const base: WorkflowConfig = {
  codexCommand: "codex",
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
  leaseTtlMs: 60_000,
  turnTimeoutMs: 60_000,
  idleProcessMs: 0,
  storageDir: "",
};

function timeoutOf(config: WorkflowConfig, name: string): number {
  return createWorkflowTools({} as never, config).find((tool) => tool.name === name)!.timeoutMs ?? 0;
}

test("submit timeout covers ALL callback attempts plus both backoff rounds", () => {
  // 30-minute callback with 3 attempts and meaningful backoff.
  const config = { ...base, callbackTimeoutMs: 30 * 60 * 1000, callbackMaxAttempts: 3, callbackRetryBaseMs: 5 * 60 * 1000 };
  const toolTimeout = timeoutOf(config, "codex_workflow_submit");
  const backoffSum = config.callbackRetryBaseMs * (2 ** (config.callbackMaxAttempts - 1) - 1); // 1 + 2 = 3 * base
  // Callback retries incur the backoff sum AND the post-verdict enqueue stage
  // can retry with the SAME backoff sum again.
  const fullBudget = config.callbackTimeoutMs * config.callbackMaxAttempts + backoffSum + backoffSum;
  assert.ok(
    toolTimeout >= fullBudget,
    `submit timeout ${toolTimeout} must cover all attempts + BOTH backoff rounds (${fullBudget})`,
  );
  assert.ok(toolTimeout >= config.callbackTimeoutMs * 2, "must at least cover the second attempt");
});

test("review timeout covers two serial turns (review + normalize)", () => {
  const config = { ...base, turnTimeoutMs: 30 * 60 * 1000 };
  const toolTimeout = timeoutOf(config, "codex_workflow_review");
  assert.ok(toolTimeout >= 2 * config.turnTimeoutMs, `review timeout ${toolTimeout} must cover two turns (${2 * config.turnTimeoutMs})`);
  const reviewOnly = timeoutOf(config, "codex_workflow_review_only");
  assert.ok(reviewOnly >= 2 * config.turnTimeoutMs, "review_only must also cover two turns");
});

test("start/continue timeouts cover one turn", () => {
  const config = { ...base, turnTimeoutMs: 30 * 60 * 1000 };
  assert.ok(timeoutOf(config, "codex_workflow_start") >= config.turnTimeoutMs);
  assert.ok(timeoutOf(config, "codex_workflow_continue") >= config.turnTimeoutMs);
});

test("timeouts stay finite and override the old fixed 10-minute cap", () => {
  const config = { ...base, callbackTimeoutMs: 30 * 60 * 1000, turnTimeoutMs: 30 * 60 * 1000 };
  for (const name of ["codex_workflow_submit", "codex_workflow_review", "codex_workflow_start"]) {
    const value = timeoutOf(config, name);
    assert.ok(Number.isFinite(value) && value > 0, `${name} timeout is finite positive`);
    assert.ok(value >= 10 * 60 * 1000, `${name} is no longer capped at 10 minutes`);
  }
});

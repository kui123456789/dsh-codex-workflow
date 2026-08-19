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
  terminalRelayTimeoutMs: 60_000,
  storageDir: "",
};

function timeoutOf(config: WorkflowConfig, name: string): number {
  return createWorkflowTools({} as never, config).find((tool) => tool.name === name)!.timeoutMs ?? 0;
}

test("submit timeout only covers synchronous validation and persistence", () => {
  const config = { ...base, callbackTimeoutMs: 30 * 60 * 1000, callbackMaxAttempts: 3, callbackRetryBaseMs: 5 * 60 * 1000 };
  const toolTimeout = timeoutOf(config, "codex_workflow_submit");
  assert.equal(toolTimeout, 60_000);
});

test("submit output tells DSH that review continues in the background", async () => {
  const record = {
    schemaVersion: 1,
    id: "workflow-1",
    dshSessionId: "session-1",
    cwd: "C:\\work",
    task: "task",
    phase: "executing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assumptions: [],
    questions: [],
    reviewCycles: 0,
    submissionState: "queued",
  };
  const manager = { submit: async () => record };
  const tool = createWorkflowTools(manager as never, base).find((candidate) => candidate.name === "codex_workflow_submit")!;
  let concluded = 0;
  const output = await (tool.execute as never as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
    { workflowId: "workflow-1", implementationSummary: "done" },
    { concludeTurn: () => { concluded += 1; } },
  );
  assert.equal(output.backgroundReview, true);
  assert.match(String(output.statusMessage), /后台运行/);
  assert.equal(output.submissionState, "queued");
  assert.equal(concluded, 1);
});

test("submit concludes the DSH turn only after durable submission succeeds", async () => {
  const manager = { submit: async () => { throw new Error("persistence failed"); } };
  const tool = createWorkflowTools(manager as never, base).find((candidate) => candidate.name === "codex_workflow_submit")!;
  let concluded = 0;
  await assert.rejects(
    (tool.execute as never as (args: unknown, exec: unknown) => Promise<unknown>)(
      { workflowId: "workflow-1", implementationSummary: "done" },
      { concludeTurn: () => { concluded += 1; } },
    ),
    /persistence failed/,
  );
  assert.equal(concluded, 0);
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

test("long-running Codex tools keep extended timeouts while submit stays immediate", () => {
  const config = { ...base, callbackTimeoutMs: 30 * 60 * 1000, turnTimeoutMs: 30 * 60 * 1000 };
  for (const name of ["codex_workflow_review", "codex_workflow_start"]) {
    const value = timeoutOf(config, name);
    assert.ok(Number.isFinite(value) && value > 0, `${name} timeout is finite positive`);
    assert.ok(value >= 10 * 60 * 1000, `${name} is no longer capped at 10 minutes`);
  }
  assert.equal(timeoutOf(config, "codex_workflow_submit"), 60_000);
});

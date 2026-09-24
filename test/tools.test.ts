import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTools, MAX_SERIAL_RPCS, PLANNER_MAX_TURNS, REVIEW_MAX_TURNS, reviewToolTimeout, startToolTimeout } from "../src/tools.js";
import { APPENDED_READBACK_TIMEOUT_MS } from "../src/app-server.js";
import type { WorkflowConfig } from "../src/types.js";

const base: WorkflowConfig = {
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
  // 1.1.1 fast-but-real transient retry bounds (tests must not wait seconds).
  transientRetryBaseMs: 1,
  transientRetryMaxMs: 5,
  transientRetryBudgetMs: 1_000,
  transientRetryJitterRatio: 0,
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

test("review timeout covers the seven-turn worst path (review + rewrite + conversion + alignment + reconciliation + re-conversion + re-alignment)", () => {
  const config = { ...base, turnTimeoutMs: 30 * 60 * 1000 };
  const toolTimeout = timeoutOf(config, "codex_workflow_review");
  assert.ok(toolTimeout >= REVIEW_MAX_TURNS * config.turnTimeoutMs, `review timeout ${toolTimeout} must cover ${REVIEW_MAX_TURNS} turns (${REVIEW_MAX_TURNS * config.turnTimeoutMs})`);
  const reviewOnly = timeoutOf(config, "codex_workflow_review_only");
  assert.ok(reviewOnly >= REVIEW_MAX_TURNS * config.turnTimeoutMs, "review_only must also cover the seven-turn worst path");
});

test("start/continue timeouts cover the four-turn planner worst path", () => {
  const config = { ...base, turnTimeoutMs: 30 * 60 * 1000 };
  assert.ok(timeoutOf(config, "codex_workflow_start") >= PLANNER_MAX_TURNS * config.turnTimeoutMs);
  assert.ok(timeoutOf(config, "codex_workflow_continue") >= PLANNER_MAX_TURNS * config.turnTimeoutMs);
});

/** 1.1.0 tool-description regression: `codex_workflow_review` must describe the
 * DEDICATED-Reviewer lifecycle — a review always runs on the workflow's own
 * Reviewer task and never on the Planner task or the Codex origin task. */
test("codex_workflow_review description reflects the dedicated Reviewer task", () => {
  const tools = createWorkflowTools({} as never, base);
  const review = tools.find((tool) => tool.name === "codex_workflow_review")!;
  const description = review.description ?? "";
  assert.match(description, /dedicated Reviewer task/, "reviews run on the workflow's dedicated Reviewer task");
  assert.match(description, /never on the Planner task/, "the Planner task is never a review target");
  assert.match(description, /origin task/, "the Codex origin task is never a review target");
  assert.match(description, /reuse the same dedicated Reviewer task/, "re-reviews reuse the same dedicated Reviewer task");
  const reviewOnly = tools.find((tool) => tool.name === "codex_workflow_review_only")!;
  assert.ok(!/(existing Planner task|to this workflow's existing Codex task)/i.test(reviewOnly.description ?? ""),
    "review_only must not claim a Planner task");
});

test("codex_workflow_start description authorizes autonomous pre-change planning and forbids duplicate starts", () => {
  const start = createWorkflowTools({} as never, base).find((tool) => tool.name === "codex_workflow_start")!;
  const description = start.description ?? "";
  assert.match(description, /autonomously/i);
  assert.match(description, /before making changes/i);
  assert.match(description, /at most once per task\/session/i);
  assert.match(description, /existing Codex task/i);
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

/** Review finding: the budgets must cover the WORST-CASE serial paths — the
 * Planner can run FOUR turns (visible plan + conversion fork + completion turn
 * + second conversion fork) when the first visible reply is not a complete
 * plan, and the reviewer can run SEVEN turns (native review + display rewrite
 * + conversion fork + authority-alignment fork + reconciliation turn + second
 * conversion fork + second alignment fork) when the 1.0.10 authority path
 * finds a conflict. MAX_SERIAL_RPCS must also cover the extra control RPCs of
 * those paths (collaborationMode/list, turn/start, thread/read baselines and
 * read-backs, thread/fork, thread/unsubscribe per extra turn). */
test("start budget provably covers the planner FOUR-turn worst path and its control RPCs", () => {
  const turn = 30 * 60 * 1000;
  const rpc = 60_000;
  const margin = 15_000;
  const retry = base.transientRetryBudgetMs;
  assert.equal(PLANNER_MAX_TURNS, 4, "visible + conversion + completion + conversion");
  assert.equal(startToolTimeout(turn, rpc, retry), saturatedTotal(turn * PLANNER_MAX_TURNS, MAX_SERIAL_RPCS * rpc, 2 * retry, margin));
  // Host never pre-empts the completion/rewrite/cleanup paths either — and
  // since 1.1.1 the budget also covers the transient-retry allowance, so a
  // backing-off turn can never be cut off by the host.
  assert.ok(startToolTimeout(turn, rpc, retry) >= PLANNER_MAX_TURNS * turn + MAX_SERIAL_RPCS * rpc + 2 * retry + margin);
  const config = { ...base, turnTimeoutMs: turn, rpcTimeoutMs: rpc };
  assert.equal(timeoutOf(config, "codex_workflow_start"), startToolTimeout(turn, rpc, retry));
  assert.equal(timeoutOf(config, "codex_workflow_continue"), startToolTimeout(turn, rpc, retry));
  // At the production-aligned 600 s turn ceiling with the 60 s rpc cap, the
  // four-turn + RPC budget stays above 600 s and is never capped at 10 min.
  const prod = { ...base, turnTimeoutMs: 600_000, rpcTimeoutMs: 60_000 };
  assert.ok(timeoutOf(prod, "codex_workflow_start") >= 4 * 600_000);
  assert.ok(timeoutOf(prod, "codex_workflow_start") >= 2 * prod.transientRetryBudgetMs, "the retry allowance is inside the budget");
});

test("review budget provably covers the reviewer SEVEN-turn worst path and its control RPCs", () => {
  const turn = 30 * 60 * 1000;
  const rpc = 60_000;
  const margin = 15_000;
  const retry = base.transientRetryBudgetMs;
  assert.equal(REVIEW_MAX_TURNS, 7, "native + rewrite + conversion + alignment + reconciliation + re-conversion + re-alignment");
  // The review budget also reserves ONE bounded persisted-read-back window
  // per readable turn (the native review, the display rewrite and the
  // reconciliation turn) plus the 1.1.1 transient-retry allowance.
  assert.equal(
    reviewToolTimeout(turn, rpc, retry),
    saturatedTotal(turn * REVIEW_MAX_TURNS, MAX_SERIAL_RPCS * rpc, 2 * retry, 3 * APPENDED_READBACK_TIMEOUT_MS, margin),
  );
  assert.ok(reviewToolTimeout(turn, rpc, retry) >= REVIEW_MAX_TURNS * turn + MAX_SERIAL_RPCS * rpc + 2 * retry + 3 * APPENDED_READBACK_TIMEOUT_MS + margin);
  const config = { ...base, turnTimeoutMs: turn, rpcTimeoutMs: rpc };
  assert.equal(timeoutOf(config, "codex_workflow_review"), reviewToolTimeout(turn, rpc, retry));
  assert.equal(timeoutOf(config, "codex_workflow_review_only"), reviewToolTimeout(turn, rpc, retry));
  const prod = { ...base, turnTimeoutMs: 600_000, rpcTimeoutMs: 60_000 };
  assert.ok(timeoutOf(prod, "codex_workflow_review") >= 7 * 600_000);
  assert.ok(timeoutOf(prod, "codex_workflow_review") >= 2 * prod.transientRetryBudgetMs, "the retry allowance is inside the budget");
});

test("the derived rpc timeout (no explicit config) tightens the budgets the same way", () => {
  const turn = 10 * 60 * 1000;
  const derived = Math.min(turn, 60_000);
  const retry = base.transientRetryBudgetMs;
  const config = { ...base, turnTimeoutMs: turn };
  assert.equal(timeoutOf(config, "codex_workflow_start"), startToolTimeout(turn, derived, retry));
  assert.equal(timeoutOf(config, "codex_workflow_review"), reviewToolTimeout(turn, derived, retry));
});

function saturatedTotal(...values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

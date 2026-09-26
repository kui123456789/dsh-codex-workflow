import assert from "node:assert/strict";
import test from "node:test";
import { applyCodexWorkflowProjection, codexWorkflowProjectionDefinition } from "../src/review-events.js";
import { LiveRelay } from "../src/application/live-relay.js";

test("Planner and Reviewer live events survive projection replay and final outcomes", () => {
  let state = codexWorkflowProjectionDefinition.init();
  const apply = (type: string, data: unknown) => {
    state = applyCodexWorkflowProjection(state, { type, data, seq: 1 } as never);
  };
  apply("dsh-codex-workflow/plan-updated", { workflowId: "wf", status: "planning", questions: [], assumptions: [] });
  apply("dsh-codex-workflow/live", { workflowId: "wf", stage: "planning", at: "now", entries: [
    { kind: "plan", itemId: "p1", text: "第一步" }, { kind: "plan", itemId: "p1", text: "：检查" },
    { kind: "tool", itemId: "t1", text: "命令 · git status" },
  ] });
  assert.equal(state.plan?.status, "planning");
  assert.equal(state.plan?.live?.[0]?.text, "第一步：检查");
  apply("dsh-codex-workflow/plan-updated", { workflowId: "wf", status: "ready", planMarkdown: "正式计划", questions: [], assumptions: [] });
  assert.equal(state.plan?.live?.[0]?.text, "第一步：检查");
  apply("dsh-codex-workflow/review-start", { workflowId: "wf", reviewId: "wf:1", attempt: 1, startedAt: "now", mode: "planned" });
  apply("dsh-codex-workflow/live", { workflowId: "wf", stage: "reviewing", reviewId: "wf:1", at: "now", entries: [
    { kind: "message", itemId: "r1", text: "检查中" },
  ] });
  assert.equal(state.activeReview?.live?.[0]?.text, "检查中");
  apply("dsh-codex-workflow/review-end", { workflowId: "wf", reviewId: "wf:1", processState: "completed", finishedAt: "later", visibleText: "通过" });
  assert.equal(state.reviews[0]?.live?.[0]?.text, "检查中");
  assert.equal(state.reviews[0]?.visibleText, "通过");
  apply("dsh-codex-workflow/plan-updated", { workflowId: "wf-next", status: "planning", questions: [], assumptions: [] });
  assert.equal(state.plan?.workflowId, "wf-next");
  assert.deepEqual(state.reviews, [], "a new plan is not hidden behind the previous workflow's review");
});

test("live relay batches display events and flushes before terminal state", () => {
  const events: Array<{ type: string; data: { entries: Array<{ text: string }> } }> = [];
  const relay = new LiveRelay("wf", "planning", undefined, (event) => events.push(event as never));
  relay.onProgress({ kind: "plan", itemId: "p1", text: "计划增量" });
  assert.equal(events.length, 0, "small deltas are batched");
  relay.close();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "dsh-codex-workflow/live");
  assert.equal(events[0]?.data.entries[0]?.text, "计划增量");
});

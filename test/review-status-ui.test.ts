import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { applyCodexWorkflowProjection, codexWorkflowProjectionDefinition, type CodexWorkflowProjection } from "../src/review-events.js";
import type { WorkflowProcessState } from "../src/types.js";

type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "children" in value) return text((value as Node).children);
  return "";
}
function statuses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(statuses);
  if (!value || typeof value !== "object" || !("children" in value)) return [];
  const node = value as Node;
  return node.props?.role === "status" ? [text(node)] : statuses(node.children);
}
function render(projection: CodexWorkflowProjection) {
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  let body: ((props: unknown) => unknown) | undefined;
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown =>
    typeof type === "function" ? type({ ...props, children }) : { type, props, children };
  runInNewContext(readFileSync(join(process.cwd(), "src/client.js"), "utf8"), { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(entry: { factory(require: (name: string) => unknown): typeof plugin }) {
      plugin = entry.factory(() => ({ createElement: h,
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
        useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined,
        useState: (initial: unknown) => [initial, () => undefined] }));
    } } },
  });
  assert.ok(plugin);
  const face = { getSnapshot: () => projection, subscribe: () => () => undefined };
  const dispose = plugin.apply({ sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (definition: { name?: string }, component: (props: unknown) => unknown) => {
        if (definition.name === "sidebar.right.pane.tab") body = component;
        return () => undefined;
      } },
    sidebarRight: { mounted: { getSnapshot: () => "parent", subscribe: () => () => undefined },
      openResource: () => undefined, openTab: () => undefined },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) } });
  try {
    assert.ok(body);
    const tree = body({ projectionFace: face, useTabInfo: () => ({}) });
    return { status: statuses(tree), content: text(tree) };
  } finally { dispose(); }
}
function reviewState(processState: WorkflowProcessState) {
  let state = codexWorkflowProjectionDefinition.init();
  state = applyCodexWorkflowProjection(state, { type: "dsh-codex-workflow/review-start", seq: SessionSeq(0), time: 1,
    data: { workflowId: "wf", reviewId: "wf:1", childSessionId: "original-reviewer", attempt: 1,
      startedAt: "2026-10-09T00:00:00Z", mode: "review_only" } });
  state = applyCodexWorkflowProjection(state, { type: "dsh-codex-workflow/review-end", seq: SessionSeq(1), time: 2,
    data: { workflowId: "wf", reviewId: "wf:1", processState, finishedAt: "2026-10-09T00:00:01Z" } });
  assert.equal(state.failure, null);
  assert.equal(state.activeReview, null, "real end projection moves the original review into history");
  return state;
}
function review(processState: WorkflowProcessState): CodexWorkflowProjection {
  return codexWorkflowProjectionDefinition.wire.view(reviewState(processState));
}
function nextReview(processState: WorkflowProcessState, message?: string, priorState: WorkflowProcessState = "completed"): CodexWorkflowProjection {
  let state = reviewState(priorState);
  state = applyCodexWorkflowProjection(state, { type: "dsh-codex-workflow/review-start", seq: SessionSeq(2), time: 3,
    data: { workflowId: "wf", reviewId: "wf:2", childSessionId: priorState === "waiting" ? "original-reviewer" : "next-reviewer", attempt: 2,
      startedAt: "2026-10-09T00:00:02Z", mode: "review_only" } });
  const common = { workflowId: "wf", reviewId: "wf:2", processState };
  state = processState === "completed"
    ? applyCodexWorkflowProjection(state, { type: "dsh-codex-workflow/review-end", seq: SessionSeq(3), time: 4,
      data: { ...common, finishedAt: "2026-10-09T00:00:03Z" } })
    : applyCodexWorkflowProjection(state, { type: "dsh-codex-workflow/review-progress", seq: SessionSeq(3), time: 4,
      data: { ...common, message, at: "2026-10-09T00:00:03Z" } });
  assert.equal(state.failure, null);
  return codexWorkflowProjectionDefinition.wire.view(state);
}

for (const [state, label] of [
  ["waiting", "审查已暂停"], ["failed", "审查失败"], ["cancelled", "审查已取消"],
  ["stale", "审查进度暂未更新"], ["completed", "最近审查已完成"],
] as const) {
  test(`saved ${state} review uses its real state instead of inferring completion from history`, () => {
    assert.deepEqual(render(review(state)).status, [label]);
  });
}

test("a running review keeps its own progress message", () => {
  assert.deepEqual(render(nextReview("running", "正在核对当前工作区")).status, ["正在核对当前工作区"]);
});

test("an active waiting review cannot be presented as running by an old progress message", () => {
  assert.deepEqual(render(nextReview("waiting", "正在检查文件")).status, ["审查已暂停"]);
});

for (const [state, label] of [["planning", "Codex 正在规划"], ["waiting_input", "规划等待用户回答"],
  ["failed", "规划失败"], ["ready", "规划已完成"]] as const) {
  test(`Planner ${state} is shown before any review exists`, () => {
    const stateValue = applyCodexWorkflowProjection(codexWorkflowProjectionDefinition.init(), {
      type: "dsh-codex-workflow/plan-updated", seq: SessionSeq(0), time: 1,
      data: { workflowId: "wf", status: state, questions: [], assumptions: [] },
    });
    assert.equal(stateValue.failure, null);
    assert.deepEqual(render(codexWorkflowProjectionDefinition.wire.view(stateValue)).status, [label]);
  });
}

test("an empty workflow still waits for review", () => {
  assert.deepEqual(render(codexWorkflowProjectionDefinition.wire.view(codexWorkflowProjectionDefinition.init())).status, ["等待审查"]);
});

test("a resumed model attempt is labelled as an attempt rather than a new business review round", () => {
  const rendered = render(nextReview("completed", undefined, "waiting"));
  assert.match(rendered.content, /第 1 次尝试/);
  assert.match(rendered.content, /第 2 次尝试/);
  assert.doesNotMatch(rendered.content, /第 2 轮/);
});

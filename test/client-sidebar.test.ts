import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("planner projection opens Codex Review in the mounted DSH session", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  const calls: Array<{ sessionId: string; kind: string }> = [];
  let notifyMounted: (() => void) | undefined;
  let notifyProjection: (() => void) | undefined;
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  const face = { getSnapshot: () => projection, subscribe: (listener: () => void) => { notifyProjection = listener; return () => undefined; } };
  const ctx = {
    sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: () => () => undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => "session-1", subscribe: (listener: () => void) => { notifyMounted = listener; return () => undefined; } },
      openTabIn: (sessionId: string, kind: string) => calls.push({ sessionId, kind }),
    },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  };
  plugin.apply(ctx);
  assert.deepEqual(calls, [{ sessionId: "session-1", kind: "codex-review" }]);
  notifyProjection?.();
  notifyMounted?.();
  assert.equal(calls.length, 1, "ordinary projection updates do not reopen the tab");
});

test("sidebar body renders Planner and Reviewer activity while they are running", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
    if (typeof type === "function") return type({ ...props, children });
    return { type, props, children };
  };
  runInNewContext(source, { window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
    plugin = entry.factory(() => ({ createElement: h, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));
  } } } });
  assert.ok(plugin);
  let body: ((props: unknown) => unknown) | undefined;
  const projection = { currentWorkflowId: "wf", plan: { workflowId: "wf", status: "planning", questions: [], assumptions: [],
    live: [{ kind: "plan", itemId: "p1", text: "正在生成计划" }] },
    activeReview: { workflowId: "wf", reviewId: "wf:1", attempt: 1, processState: "running", message: "审查中",
      live: [{ kind: "message", itemId: "r1", text: "正在检查改动" }] },
    reviews: [{ workflowId: "wf", reviewId: "wf:1", attempt: 1, processState: "running",
      live: [{ kind: "message", itemId: "r1", text: "正在检查改动" }] }] };
  const face = { getSnapshot: () => projection, subscribe: () => () => undefined };
  const ctx = { sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (_definition: unknown, component: (props: unknown) => unknown) => { body ??= component; return () => undefined; } },
    sidebarRight: { mounted: { getSnapshot: () => "session-1", subscribe: () => () => undefined }, openTabIn: () => undefined },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) } };
  plugin.apply(ctx);
  assert.ok(body);
  const rendered = JSON.stringify(body({ projectionFace: face, useTabInfo: () => ({}) }));
  assert.match(rendered, /正在生成计划/);
  assert.match(rendered, /正在检查改动/);
});

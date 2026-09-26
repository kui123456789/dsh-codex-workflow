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
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", status: "ready", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
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

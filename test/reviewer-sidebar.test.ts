import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

type Review = { workflowId: string; reviewId: string; childSessionId?: string; processState: string };
type Projection = { currentWorkflowId: string; plan: { childSessionId: string } | null;
  activeReview: Review | null; reviews: Review[] };

function mount(initial: Projection) {
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  let projection = initial;
  let notify: (() => void) | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(entry: { factory(require: (name: string) => unknown): typeof plugin }) {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  const calls: Array<{ type: "native" | "fallback"; address?: string }> = [];
  const face = { getSnapshot: () => projection, subscribe(listener: () => void) {
    notify = listener;
    return () => undefined;
  } };
  const dispose = plugin.apply({
    sidebarRightTabs: { register: () => () => undefined }, slots: { inject: () => () => undefined },
    sidebarRight: { mounted: { getSnapshot: () => "parent", subscribe: () => () => undefined },
      openResource: (address: string) => calls.push({ type: "native", address }),
      openTab: () => calls.push({ type: "fallback" }) },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  });
  return { calls, dispose, update(value: Projection) { projection = value; notify?.(); } };
}

const review: Review = { workflowId: "wf", reviewId: "wf:1", childSessionId: "reviewer-1", processState: "running" };
const empty: Projection = { currentWorkflowId: "wf", plan: null, activeReview: null, reviews: [] };

for (const processState of ["waiting", "completed"]) {
  test(`Reviewer ${processState} projection keeps the original native tab instead of opening the summary`, (t) => {
    const ui = mount({ ...empty, activeReview: review, reviews: [review] });
    t.after(ui.dispose);
    ui.update({ ...empty, reviews: [{ ...review, processState }] });
    assert.deepEqual(ui.calls.map(call => call.type), ["native"]);
    assert.match(ui.calls[0]!.address!, /\/reviewer-1\?parent=parent&mode=one-shot$/);
  });
}

test("completed Reviewer replay opens its original child before an older Planner", (t) => {
  const ui = mount({ ...empty, plan: { childSessionId: "old-planner" }, reviews: [{ ...review, processState: "completed" }] });
  t.after(ui.dispose);
  assert.deepEqual(ui.calls.map(call => call.type), ["native"]);
  assert.match(ui.calls[0]!.address!, /\/reviewer-1\?/);
});

test("a new business review opens its new child while retained review updates do not reopen tabs", (t) => {
  const completed = { ...empty, reviews: [{ ...review, processState: "completed" }] };
  const ui = mount(completed);
  t.after(ui.dispose);
  ui.update(completed);
  ui.update({ ...empty, activeReview: { ...review, reviewId: "wf:2", childSessionId: "reviewer-2" }, reviews: [review] });
  assert.deepEqual(ui.calls.map(call => call.type), ["native", "native"]);
  assert.match(ui.calls[0]!.address!, /\/reviewer-1\?/);
  assert.match(ui.calls[1]!.address!, /\/reviewer-2\?/);
});

test("an old childless Reviewer record still opens the summary fallback", (t) => {
  const { childSessionId: _child, ...legacy } = review;
  const ui = mount({ ...empty, reviews: [legacy] });
  t.after(ui.dispose);
  assert.deepEqual(ui.calls.map(call => call.type), ["fallback"]);
});

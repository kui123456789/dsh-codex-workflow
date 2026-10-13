import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

type Projection = { currentWorkflowId: string | null; plan: { status: string; processState?: string; questions: unknown[]; assumptions: string[] } | null;
  activeReview: null; reviews: unknown[] };
type Face = { getSnapshot(): Projection | null | undefined; subscribe(callback: () => void): () => void };
type Tree = { props?: Record<string, unknown>; children: unknown[] };
function words(tree: unknown): string {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(words).join("");
  return tree && typeof tree === "object" && "children" in tree ? words((tree as Tree).children) : "";
}
function mount() {
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  let body: ((props: unknown) => unknown) | undefined;
  let subscription: (() => void) | undefined;
  let previousSubscribe: unknown;
  const result = { notifications: 0, reads: [] as unknown[], serverReads: [] as unknown[] };
  const h = (type: unknown, props: unknown, ...children: unknown[]): unknown =>
    typeof type === "function" ? type({ ...(props as object), children }) : { type, props, children };
  const path = join(process.cwd(), "src/client.js");
  runInNewContext(readFileSync(path, "utf8"), { setTimeout, clearTimeout, window: { __ModuleLoader__: { load(entry: {
    factory(require: (name: string) => unknown): typeof plugin;
  }) { plugin = entry.factory(() => ({ createElement: h,
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, read: () => unknown, serverRead: () => unknown) {
      if (previousSubscribe !== subscribe) {
        subscription?.(); subscription = subscribe(() => { result.notifications++; }); previousSubscribe = subscribe;
      }
      result.reads = [read(), read(), read()]; result.serverReads = [serverRead(), serverRead()];
      return result.reads[0];
    }, useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined,
    useState: (initial: unknown) => [initial, () => undefined] })); } } } });
  assert.ok(plugin);
  const dispose = plugin.apply({ sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (def: { name?: string }, component: (props: unknown) => unknown) => {
        if (def.name === "sidebar.right.pane.tab") body = component;
        return () => undefined;
      } }, sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => undefined } },
    sessions: { binding: () => undefined } });
  return { result, render(face?: Face) { assert.ok(body); return words(body({ projectionFace: face, useTabInfo: () => ({}) })); },
    close() { subscription?.(); dispose(); } };
}
const empty = (): Projection => ({ currentWorkflowId: null, plan: null, activeReview: null, reviews: [] });

for (const missing of [undefined, null]) test(`a pending ${String(missing)} projection displays loading without empty results`, (t) => {
  const ui = mount(); t.after(ui.close);
  const content = ui.render({ getSnapshot: () => missing, subscribe: () => () => undefined });
  assert.match(content, /正在加载工作流状态/);
  assert.doesNotMatch(content, /暂无审查结果|最近审查已完成|等待审查/);
  assert(ui.result.reads.every(row => Object.is(row, ui.result.reads[0])));
});

test("an absent face has one stable snapshot for client and server reads", (t) => {
  const ui = mount(); t.after(ui.close);
  assert.match(ui.render(), /正在加载工作流状态/);
  const original = ui.result.reads[0];
  assert([...ui.result.reads, ...ui.result.serverReads].every(row => Object.is(row, original)));
  ui.render();
  assert.equal(ui.result.reads[0], original);
});

test("a loaded empty projection is ordinary waiting rather than loading", (t) => {
  const ui = mount(); t.after(ui.close);
  const projection = empty();
  const content = ui.render({ getSnapshot: () => projection, subscribe: () => () => undefined });
  assert.match(content, /等待审查/); assert.doesNotMatch(content, /正在加载工作流状态/);
  assert(ui.result.reads.every(row => row === projection));
});

test("original store notifications move loading to pause, running and completed without changing subscription", (t) => {
  const ui = mount(); t.after(ui.close);
  let snapshot: Projection | undefined;
  const listeners = new Set<() => void>();
  let subscriptions = 0, releases = 0;
  const face = { getSnapshot: () => snapshot, subscribe(listener: () => void) {
    subscriptions++; listeners.add(listener); return () => { listeners.delete(listener); releases++; };
  } };
  assert.match(ui.render(face), /正在加载工作流状态/);
  for (const [processState, label] of [["waiting", "规划已暂停"], ["running", "Codex 正在规划"], ["completed", "规划已完成"]]) {
    snapshot = { ...empty(), currentWorkflowId: "original", plan: { status: processState === "completed" ? "ready" : "planning",
      processState, questions: [], assumptions: [] } };
    for (const listener of listeners) listener();
    assert.match(ui.render(face), new RegExp(label!));
    assert(ui.result.reads.every(row => row === snapshot));
  }
  assert.equal(ui.result.notifications, 3); assert.equal(subscriptions, 1); assert.equal(releases, 0);
});

test("snapshot reads preserve their projection face receiver", (t) => {
  const ui = mount(); t.after(ui.close);
  const projection = empty();
  const face = { value: projection, getSnapshot() { return this.value; }, subscribe: () => () => undefined };
  assert.match(ui.render(face), /等待审查/);
  assert.equal(ui.result.reads[0], projection);
});

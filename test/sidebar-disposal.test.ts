import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

type Projection = ReturnType<typeof projection>;
function projection(childSessionId: string) {
  return { currentWorkflowId: "workflow", plan: { workflowId: "workflow", childSessionId,
    status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
}

function source<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const counts = { reads: 0, subscribed: 0, released: 0 };
  return {
    counts,
    getSnapshot: () => { counts.reads++; return value; },
    subscribe: (listener: () => void) => {
      counts.subscribed++; listeners.add(listener);
      return () => { counts.released++; listeners.delete(listener); };
    },
    set(next: T) { value = next; },
    // The installed Host notifier snapshots its observers before dispatch.
    // Removing one during an earlier callback cannot withdraw that snapshot.
    notify() { for (const listener of [...listeners]) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

function fixture() {
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  runInNewContext(readFileSync(join(process.cwd(), "src/client.js"), "utf8"), {
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    window: { __ModuleLoader__: { load(entry: { factory(require: (id: string) => unknown): typeof plugin }) {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  const mounted = source<string | undefined>("parent-a");
  const a = source<Projection>(projection("child-a"));
  const b = source<Projection>(projection("child-b"));
  const resources: string[] = [];
  const counts = { bindings: 0, registrationsReleased: 0, openAttempts: 0 };
  let bindingAvailable = true, openFails = false;
  const ctx = {
    sidebarRightTabs: { register: () => () => { counts.registrationsReleased++; } },
    slots: { inject: () => () => { counts.registrationsReleased++; } },
    sidebarRight: {
      mounted,
      openResource(address: string) {
        counts.openAttempts++;
        if (openFails) throw new Error("seat not mounted");
        resources.push(address);
      },
    },
    sessions: { binding(sessionId: string) {
      counts.bindings++;
      return bindingAvailable ? { session: { projections: { faceOf: () => sessionId === "parent-a" ? a : b } } } : undefined;
    } },
  };
  let dispose: (() => void) | undefined;
  return { mounted, a, b, counts, resources, timers,
    setBindingAvailable(value: boolean) { bindingAvailable = value; },
    setOpenFails(value: boolean) { openFails = value; },
    start() { dispose = plugin!.apply(ctx); },
    dispose() { dispose?.(); },
  };
}

test("a captured projection notification cannot reopen the sidebar after plugin disposal", (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.a.subscribe(() => f.dispose());
  f.start();
  assert.equal(f.resources.length, 1);
  f.a.set(projection("child-late"));
  f.a.notify();
  assert.equal(f.resources.length, 1, "the already captured scan must not open another child");
  assert.equal(f.timers.size, 0);
});

test("a captured mounted notification cannot subscribe to the next session after disposal", (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.mounted.subscribe(() => f.dispose());
  f.start();
  f.mounted.set("parent-b");
  f.mounted.notify();
  assert.equal(f.b.counts.subscribed, 0, "retired client must not acquire a new projection observer");
  assert.equal(f.b.listenerCount, 0);
  assert.equal(f.resources.length, 1);
});

for (const kind of ["binding", "open"] as const) {
  test(`a captured ${kind} retry callback cannot restart discovery after disposal`, (t) => {
    const f = fixture(); t.after(() => f.dispose());
    if (kind === "binding") f.setBindingAvailable(false);
    else f.setOpenFails(true);
    f.start();
    assert.equal(f.timers.size, 1);
    const callback = [...f.timers.values()][0]!;
    f.dispose();
    const before = { ...f.counts };
    callback();
    assert.deepEqual(f.counts, before, "an already queued callback cannot access the retired host context");
    assert.equal(f.timers.size, 0, "retired retries cannot rearm timers");
  });

  test(`a live ${kind} retry still discovers and opens the original child`, (t) => {
    const f = fixture(); t.after(() => f.dispose());
    if (kind === "binding") f.setBindingAvailable(false);
    else f.setOpenFails(true);
    f.start();
    const [id, callback] = [...f.timers.entries()][0]!;
    f.timers.delete(id);
    f.setBindingAvailable(true); f.setOpenFails(false);
    callback();
    assert.equal(f.resources.length, 1);
    assert.match(f.resources[0]!, /session\/child-a\?parent=parent-a/);
    assert.equal(f.a.counts.subscribed, 1);
    assert.equal(f.timers.size, 0);
  });
}

test("session switches release each projection observer once and plugin disposal is idempotent", () => {
  const f = fixture();
  f.start();
  f.mounted.set("parent-b"); f.mounted.notify();
  assert.equal(f.a.counts.released, 1);
  assert.equal(f.b.counts.subscribed, 1);
  f.dispose(); f.dispose();
  assert.equal(f.b.counts.released, 1);
  assert.equal(f.mounted.counts.released, 1);
  assert.equal(f.counts.registrationsReleased, 4);
  assert.equal(f.a.listenerCount + f.b.listenerCount + f.mounted.listenerCount, 0);
});

test("live projection updates and session switches still open their original child exactly once", (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.start(); f.a.notify(); f.mounted.notify();
  assert.equal(f.resources.length, 1);
  f.a.set(projection("child-a-next")); f.a.notify();
  f.mounted.set("parent-b"); f.mounted.notify(); f.b.notify();
  assert.equal(f.resources.length, 3);
  assert.match(f.resources[1]!, /session\/child-a-next\?parent=parent-a/);
  assert.match(f.resources[2]!, /session\/child-b\?parent=parent-b/);
  assert.equal(f.a.counts.subscribed, 1);
  assert.equal(f.b.counts.subscribed, 1);
});

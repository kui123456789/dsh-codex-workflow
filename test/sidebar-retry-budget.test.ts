import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";

function fixture(t: TestContext, native = true) {
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  const timers = new Map<number, () => void>(), warnings: string[] = [], addresses: string[] = [];
  let id = 0, clock = 0, attempts = 0, failing = true, parent = "parent";
  let notify: (() => void) | undefined;
  let notifyMounted: (() => void) | undefined;
  let projection = { currentWorkflowId: "original-workflow", plan: { workflowId: "original-workflow", childSessionId: native ? "original-child" : undefined,
    status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  runInNewContext(readFileSync(join(process.cwd(), "src/client.js"), "utf8"), {
    Date: { now: () => clock }, setTimeout(callback: () => void) { const next = ++id; timers.set(next, callback); return next; },
    clearTimeout(handle: number) { timers.delete(handle); }, console: { warn(message: string) { warnings.push(message); } },
    window: { __ModuleLoader__: { load(entry: { factory(require: (id: string) => unknown): typeof plugin }) {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  const open = (address: string) => { attempts++; addresses.push(address); if (failing) throw new Error("seat not mounted"); };
  const face = { getSnapshot: () => projection, subscribe(listener: () => void) { notify = listener; return () => { notify = undefined; }; } };
  const dispose = plugin.apply({ sidebarRightTabs: { register: () => () => undefined }, slots: { inject: () => () => undefined },
    sidebarRight: { mounted: { getSnapshot: () => parent, subscribe: (listener: () => void) => {
      notifyMounted = listener; return () => { notifyMounted = undefined; };
    } },
      ...(native ? { openResource: open } : {}), openTab: (_kind: string, options: { params: { workflowId: string } }) => open(options.params.workflowId) },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) } });
  t.after(dispose);
  const tick = () => { const pair = [...timers.entries()][0]; assert.ok(pair, "the existing retry timer must remain bounded");
    timers.delete(pair[0]); pair[1](); };
  return { timers, warnings, addresses, dispose, tick,
    get attempts() { return attempts; }, notify() { notify?.(); }, at(value: number) { clock = value; },
    parent(value: string) { parent = value; notifyMounted?.(); },
    succeed() { failing = false; }, target(value: string) { projection = { ...projection,
      currentWorkflowId: value, plan: { ...projection.plan, workflowId: value, childSessionId: native ? value : undefined } }; },
  };
}

for (const native of [true, false]) {
  const surface = native ? "native child" : "summary fallback";
  test(`${surface} retry exhaustion remains final under later projection notifications`, t => {
    const f = fixture(t, native);
    assert.equal(f.attempts, 1);
    for (let index = 0; index < 8; index++) f.tick();
    assert.equal(f.attempts, 9, "one initial open plus at most eight existing retries");
    assert.equal(f.timers.size, 0);
    for (let index = 0; index < 20; index++) f.notify();
    assert.equal(f.attempts, 9, "ordinary model progress cannot replenish an exhausted sidebar retry allowance");
    assert.equal(f.timers.size, 0);
    assert.equal(f.warnings.filter(value => value.includes("giving up sidebar open")).length, 1);
  });

  test(`${surface} a late timer cannot issue another open after its original retry window`, t => {
    const f = fixture(t, native);
    f.at(15_000); f.tick();
    assert.equal(f.attempts, 1, "deadline must be checked before another host resource acquisition");
    assert.equal(f.timers.size, 0);
    f.notify(); assert.equal(f.attempts, 1);
  });

  test(`${surface} a distinct target has its own retry allowance after previous exhaustion`, t => {
    const f = fixture(t, native);
    for (let index = 0; index < 8; index++) f.tick();
    f.target("distinct-original-target"); f.succeed(); f.notify();
    assert.equal(f.attempts, 10);
    assert.ok(f.addresses.at(-1)?.includes("distinct-original-target"));
    assert.equal(f.timers.size, 0);
  });

  test(`${surface} ordinary successful retry still opens the same target once`, t => {
    const f = fixture(t, native);
    f.succeed(); f.tick(); f.notify();
    assert.equal(f.attempts, 2);
    assert.equal(f.addresses[0], f.addresses[1]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.warnings.filter(value => value.includes("giving up sidebar open")).length, 0);
  });

  test(`${surface} disposal clears retries and retained callbacks cannot reopen resources`, t => {
    const f = fixture(t, native);
    const callback = [...f.timers.values()][0]!;
    f.dispose(); callback(); f.notify();
    assert.equal(f.attempts, 1); assert.equal(f.timers.size, 0);
  });

  test(`${surface} intermediate progress consumes the same existing allowance without adding timers`, t => {
    const f = fixture(t, native);
    for (let index = 0; index < 8; index++) {
      assert.equal(f.timers.size, 1); f.notify();
    }
    assert.equal(f.attempts, 9); assert.equal(f.timers.size, 0);
    f.notify(); assert.equal(f.attempts, 9);
  });

  test(`${surface} returning from another target cannot replenish the exhausted original key`, t => {
    const f = fixture(t, native);
    for (let index = 0; index < 8; index++) f.tick();
    f.target("next-target"); f.succeed(); f.notify();
    assert.equal(f.attempts, 10);
    f.target(native ? "original-child" : "original-workflow"); f.notify();
    assert.equal(f.attempts, 10, "target changes must retain the original target's exhausted allowance");
    assert.equal(f.timers.size, 0);
  });

  test(`${surface} another parent has its own key while returning to the first parent remains exhausted`, t => {
    const f = fixture(t, native);
    for (let index = 0; index < 8; index++) f.tick();
    f.succeed(); f.parent("another-parent");
    assert.equal(f.attempts, 10);
    f.parent("parent");
    assert.equal(f.attempts, 10, "remounting the original parent does not grant another automatic attempt");
    assert.equal(f.timers.size, 0);
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { WorkflowUsageObserver } from "../src/application/workflow-usage-observer.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowRecord } from "../src/types.js";
import type { TokenUsageSnapshot } from "../src/usage-accounting.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-usage-thread-owner-"));
  const store = new WorkflowStore(directory);
  const now = new Date().toISOString();
  const record: WorkflowRecord = { schemaVersion: 1, id: "usage-original-A", dshSessionId: "usage-parent", cwd: directory,
    task: "Observe original-thread usage", mode: "planned", phase: "executing", createdAt: now, updatedAt: now,
    questions: [], assumptions: [], reviewCycles: 0, noChangeReviewRounds: 0 };
  await store.save(record);
  const ownerA = Object.freeze({ generation: "A" });
  const ownerB = Object.freeze({ generation: "B" });
  let currentOwner: object | undefined = ownerA;
  let currentSnapshot: TokenUsageSnapshot | undefined;
  const listeners = new Set<(snapshot: TokenUsageSnapshot) => void>();
  // The actual observer and SQLite are used. This narrow producer supplies
  // server-reported cumulative snapshots; actual SDK ownership is tested elsewhere.
  const gateway = {
    captureThreadOwner() { return currentOwner; },
    getThreadTokenUsage() { return currentSnapshot; },
    onTokenUsage(listener: (snapshot: TokenUsageSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const observer = new WorkflowUsageObserver(store, gateway);
  const emit = (totalTokens: number) => {
    const count = { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    currentSnapshot = { threadId: "same-thread-address", turnId: "same-turn-address", total: count, last: count };
    for (const listener of listeners) listener(currentSnapshot);
  };
  const saved = async (id = record.id) => (await store.load(id))!.observedUsage!;
  return { store, record, observer, ownerA, ownerB, emit, saved,
    replaceOwner(owner: object | undefined) { currentOwner = owner; currentSnapshot = undefined; },
    async close() {
      await observer.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    } };
}

test("new-generation same-address counters cannot contaminate an original workflow source", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "same-thread-address", "planning", "model-A", undefined, f.ownerA);
    f.emit(100); await f.observer.flush();
    const original = await f.saved();
    assert.equal(original.summary.total?.totalTokens, 100);
    f.replaceOwner(f.ownerB);
    f.emit(900); await f.observer.flush();
    assert.deepEqual(await f.saved(), original, "B's cumulative snapshot is not part of the admitted A source");
  } finally { await f.close(); }
});

test("an independent same-workflow owner receives its own source and stale release cannot remove it", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "same-thread-address", "reviewing", "model-A", undefined, f.ownerA);
    f.emit(100); await f.observer.flush();
    const originalSource = (await f.saved()).sources[0]!.sourceId;
    f.replaceOwner(f.ownerB); f.emit(200);
    await f.observer.bind(f.record.id, "same-thread-address", "reviewing", "model-A", undefined, f.ownerB);
    const replaced = await f.saved();
    assert.equal(replaced.sources.length, 2, "A and B are independently admitted accounting sources despite reused text");
    assert.equal(replaced.sources[0]!.sourceId, originalSource);
    assert.equal(replaced.sources[0]!.total?.totalTokens, 100);
    assert.equal(replaced.sources[1]!.total?.totalTokens, 200);
    assert.equal(replaced.summary.total?.totalTokens, 300);
    await f.observer.releaseOwned("same-thread-address", f.ownerA, f.record.id);
    f.emit(350); await f.observer.flush();
    const after = await f.saved();
    assert.equal(after.sources.length, 2);
    assert.equal(after.sources[0]!.total?.totalTokens, 100);
    assert.equal(after.sources[1]!.total?.totalTokens, 350);
    assert.equal(after.summary.total?.totalTokens, 450);
  } finally { await f.close(); }
});

test("stale release for A cannot delete B's same-address binding in another workflow", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "same-thread-address", "planning", "model-A", undefined, f.ownerA);
    f.emit(100); await f.observer.flush();
    const original = await f.saved();
    const b = { ...f.record, id: "usage-original-B", task: "Observe independent B usage" };
    await f.store.save(b);
    f.replaceOwner(f.ownerB); f.emit(200);
    await f.observer.bind(b.id, "same-thread-address", "planning", "model-B", undefined, f.ownerB);
    await f.observer.releaseOwned("same-thread-address", f.ownerA, f.record.id);
    f.emit(400); await f.observer.flush();
    assert.deepEqual(await f.saved(), original);
    const observedB = await f.saved(b.id);
    assert.equal(observedB.sources.length, 1);
    assert.equal(observedB.summary.total?.totalTokens, 400);
    assert.equal(observedB.sources[0]!.model, "model-B");
  } finally { await f.close(); }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { WorkflowUsageObserver, type WorkflowUsageGateway } from "../src/application/workflow-usage-observer.js";
import { WorkflowStore } from "../src/store.js";
import type { TokenUsageSnapshot } from "../src/usage-accounting.js";
import type { WorkflowRecord } from "../src/types.js";
import { sharedGate } from "./fixtures/bridge-shared-reviewer-fixture.js";

const threadId = "the-same-public-thread";
const snapshot = (totalTokens: number): TokenUsageSnapshot => {
  const counters = { totalTokens, inputTokens: totalTokens - 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 };
  return { threadId, turnId: "the-same-public-turn", total: counters, last: counters };
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-usage-binding-owner-"));
  const store = new WorkflowStore(directory);
  const owners = { A: {}, B: {}, C: {} };
  let owner: object = owners.A;
  let usage = snapshot(100);
  let listener: ((snapshot: TokenUsageSnapshot) => void) | undefined;
  const gateway: WorkflowUsageGateway = { captureThreadOwner: () => owner,
    getThreadTokenUsage: () => usage,
    onTokenUsage: (callback) => { listener = callback; return () => { listener = undefined; }; } };
  const observer = new WorkflowUsageObserver(store, gateway);
  for (const id of ["wf-original", "wf-current"]) {
    const now = new Date().toISOString();
    await store.save({ schemaVersion: 1, id, dshSessionId: "session-usage", cwd: directory, task: id,
      mode: "planned", phase: "executing", createdAt: now, updatedAt: now,
      assumptions: [], questions: [], reviewCycles: 0 } satisfies WorkflowRecord);
  }
  const select = (next: object, total: number) => { owner = next; usage = snapshot(total); };
  const emit = (total: number) => { usage = snapshot(total); listener?.(usage); };
  return { observer, store, owners, select, emit,
    async close() { await observer.stop(); store.close(); assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true }); } };
}

test("usage late A binding cannot retire an already registered B source at the same address", async () => {
  const f = await fixture();
  try {
    await f.observer.bind("wf-original", threadId, "reviewing", "model-A", undefined, f.owners.A);
    f.select(f.owners.B, 900);
    await f.observer.bind("wf-current", threadId, "reviewing", "model-B", undefined, f.owners.B);
    const original = f.store.coordinationHandle.loadWorkflow("wf-original");
    let rejected: unknown;
    await f.observer.bind("wf-original", threadId, "reviewing", "model-A", undefined, f.owners.A)
      .catch((error: unknown) => { rejected = error; });
    f.emit(1000);
    await f.observer.flush();
    assert.equal((await f.store.load("wf-original"))?.observedUsage?.summary.total?.totalTokens, 100);
    const updated = (await f.store.load("wf-current"))?.observedUsage;
    assert.equal(updated?.summary.total?.totalTokens, 1000);
    assert.equal(updated?.sources.length, 1);
    assert.equal(updated?.sources[0]?.model, "model-B");
    assert.ok(rejected instanceof Error);
    assert.match(rejected.message, /original.*owner|transport.*owner|usage.*owner.*unavailable/i);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow("wf-original"), original);
  } finally { await f.close(); }
});

test("usage B binding awaiting retired-source drain cannot alter a same-workflow C takeover", async () => {
  const f = await fixture();
  const gate = sharedGate();
  const port = f.observer as unknown as { drain(workflowId: string): Promise<void> };
  const originalDrain = port.drain.bind(f.observer);
  let held = false;
  try {
    await f.observer.bind("wf-original", threadId, "reviewing", "model-A", undefined, f.owners.A);
    port.drain = async (workflowId) => {
      const task = originalDrain(workflowId);
      if (!held) { held = true; gate.enter(); await gate.promise; }
      await task;
    };
    f.select(f.owners.B, 900);
    const bindingB = f.observer.bind("wf-current", threadId, "reviewing", "model-B", undefined, f.owners.B);
    void bindingB.catch(() => undefined);
    await gate.entered;
    f.select(f.owners.C, 2000);
    await f.observer.bind("wf-current", threadId, "reviewing", "model-C", undefined, f.owners.C);
    const current = f.store.coordinationHandle.loadWorkflow("wf-current");
    gate.release();
    let rejected: unknown;
    await bindingB.catch((error: unknown) => { rejected = error; });
    assert.equal((await f.store.load("wf-current"))?.observedUsage?.sources[0]?.model, "model-C",
      "The late B bind must preserve C's effective model rather than mark it mixed");
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow("wf-current"), current,
      "A stale B completion cannot mix its model into C's already registered accounting source");
    f.emit(2100);
    await f.observer.flush("wf-current");
    const updated = (await f.store.load("wf-current"))?.observedUsage;
    assert.equal(updated?.summary.total?.totalTokens, 2100);
    assert.equal(updated?.sources.length, 1);
    assert.equal(updated?.sources[0]?.model, "model-C");
    assert.equal(updated?.sources[0]?.modelMixed, undefined);
    assert.ok(rejected instanceof Error);
    assert.match(rejected.message, /original.*owner|transport.*owner|usage.*owner.*unavailable/i);
  } finally { gate.release(); port.drain = originalDrain; await f.close(); }
});

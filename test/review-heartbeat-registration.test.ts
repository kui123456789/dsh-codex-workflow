import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ReviewObservation } from "../src/application/review-observation.js";
import { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowRecord } from "../src/types.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-review-heartbeat-registration-"));
  const store = new WorkflowStore(directory);
  const runtime = new WorkflowRuntimeState();
  const oldTime = new Date(Date.now() - 100_000).toISOString();
  const record: WorkflowRecord = { schemaVersion: 1, id: "heartbeat-workflow", dshSessionId: "heartbeat-parent",
    cwd: directory, task: "Verify the original running review", phase: "reviewing", processState: "running",
    assumptions: [], questions: [], reviewCycles: 0,
    reviewAttempt: 1, reviewStartedAt: oldTime, lastProgressAt: oldTime, createdAt: oldTime, updatedAt: oldTime };
  await store.save(record);
  const events: unknown[] = [];
  const observation = new ReviewObservation({ store, runtime, heartbeatMs: 60_000, staleMs: 1_000,
    isSubmissionActive: () => false, emit: (_record, event) => events.push(event) });
  const original = await store.load(record.id);
  assert.ok(original);
  const timer = (attempt: number) => {
    observation.startHeartbeat(record.id, (current) => current.reviewAttempt === attempt);
    const value = runtime.reviewHeartbeats.get(record.id);
    assert.ok(value);
    return value;
  };
  return { directory, store, runtime, observation, events, original, timer, async close() {
    for (const value of runtime.reviewHeartbeats.values()) clearInterval(value);
    runtime.reviewHeartbeats.clear();
    store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true });
  } };
}

test("a displaced heartbeat registration cannot replace the current review's timer", async () => {
  const f = await fixture();
  try {
    f.timer(1);
    await f.store.update(f.original.id, (record) => { record.reviewAttempt = 2; });
    const successor = f.timer(2);
    const before = f.store.coordinationHandle.loadWorkflow(f.original.id);
    assert.throws(() => f.observation.startHeartbeat(f.original.id, (record) => record.reviewAttempt === 1),
      /ownership|scope|admission/);
    assert.equal(f.runtime.reviewHeartbeats.get(f.original.id), successor);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(f.original.id), before);
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});

test("a rejected review finish cannot stop the successor's running heartbeat", async () => {
  const f = await fixture();
  try {
    const oldTimer = f.timer(1);
    await f.store.update(f.original.id, (record) => { record.reviewAttempt = 2; });
    const successor = f.timer(2);
    const before = f.store.coordinationHandle.loadWorkflow(f.original.id);
    await f.observation.finish(f.original.id, undefined, undefined,
      { dshSessionId: f.original.dshSessionId, reviewAttempt: 1, cwd: f.directory },
      (record) => record.reviewAttempt === 1, oldTimer);
    assert.equal(f.runtime.reviewHeartbeats.get(f.original.id), successor);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(f.original.id), before);
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});

for (const refreshTimestamp of [true, false]) {
  test(`a delayed stale probe preserves the successor heartbeat and revision (${refreshTimestamp ? "new timestamp" : "same timestamp"})`, async () => {
    const f = await fixture();
    const held = gate();
    const originalUpdate = f.store.update.bind(f.store);
    let stale: Promise<WorkflowRecord> | undefined;
    try {
      f.timer(1);
      f.store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, options?: { ignoreCancelled?: boolean }) => {
        held.enter();
        await held.promise;
        return originalUpdate(id, mutate, options);
      };
      stale = f.observation.refreshStale(f.original);
      await held.entered;
      await originalUpdate(f.original.id, (record) => {
        record.reviewAttempt = 2;
        if (refreshTimestamp) record.lastProgressAt = new Date().toISOString();
      });
      const successor = f.timer(2);
      const before = f.store.coordinationHandle.loadWorkflow(f.original.id);
      const current = await f.store.load(f.original.id);
      assert.ok(current);
      held.release();
      assert.deepEqual(await stale, current);
      assert.equal(f.runtime.reviewHeartbeats.get(f.original.id), successor);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(f.original.id), before);
      assert.deepEqual(f.events, []);
    } finally {
      held.release();
      await stale?.catch(() => undefined);
      f.store.update = originalUpdate;
      await f.close();
    }
  });
}

test("a current stale review commits once and releases its own heartbeat", async () => {
  const f = await fixture();
  try {
    f.timer(1);
    const stale = await f.observation.refreshStale(f.original);
    assert.equal(stale.processState, "stale");
    assert.equal(stale.reviewAttempt, 1);
    assert.equal(stale.revision, (f.original.revision ?? 0) + 1);
    assert.equal(f.runtime.reviewHeartbeats.size, 0);
  } finally { await f.close(); }
});

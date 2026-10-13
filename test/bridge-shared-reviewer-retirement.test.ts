import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { BridgeStore } from "../src/bridge-store.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";
import { sharedReviewerFixture, type SharedReviewerStats } from "./fixtures/bridge-shared-reviewer-fixture.js";

async function retireOriginal(f: Awaited<ReturnType<typeof sharedReviewerFixture>>) {
  const record = await f.start();
  const originalStats = await f.control("fixture/stats");
  const active = originalStats.active[0];
  assert.ok(active);
  const original = await f.store.load(record.id);
  assert.ok(original?.submissionId);
  assert.ok(original.submissionLeaseToken);
  assert.ok(original.submissionLeaseEpoch !== undefined);
  assert.equal(original.reviewerThreadOrigin, "app-server-ephemeral");
  assert.equal(f.store.coordinationHandle.releaseLease(`submission:${record.id}:${original.submissionId}`,
    original.submissionLeaseEpoch, original.submissionLeaseToken), true);
  await f.lossSeen.entered;
  f.lossRelease.release();
  await f.lossForwarded.entered;
  await Promise.allSettled([...f.runtime.backgroundTasks]);
  const stopped = await f.control("fixture/stats");
  assert.equal(stopped.active.length, 0);
  assert.equal(stopped.visibleTurns, 1);
  assert.equal(f.runtime.codexChildSessions.has(record.id), false);
  assert.equal(f.rawDisposals.length, 1);
  assert.equal(f.subscriptionsReleased.filter((id) => id === active.threadId).length, 1);
  assert.equal(f.client.isThreadAvailable(active.threadId), false);
  return { record, originalStats, stopped };
}

test("background recovery cannot replace a retired original Reviewer in the same process", { timeout: 30_000 }, async () => {
  const f = await sharedReviewerFixture();
  try {
    const { record, stopped } = await retireOriginal(f);
    await f.manager.recoverCallbacks();
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const after = await f.control("fixture/stats");
    assert.equal(after.visibleTurns, stopped.visibleTurns, "Recovery must not start another readable model after its original resources were retired");
    assert.deepEqual(after.threadStarts, stopped.threadStarts, "A missing consumer registration is not permission to create a replacement Reviewer");
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 1);
    const result = await f.store.load(record.id);
    assert.match(`${result?.submissionError ?? ""} ${result?.error ?? ""}`, /original|unavailable|retired|lost|process/i);
    assert.equal(result?.reviewCycles, 0);
    assert.equal(result?.stagedVerdict, undefined);
  } finally { await f.close(); }
});

test("a fresh callback process reports the old ephemeral Reviewer unavailable without rebuilding it", { timeout: 90_000 }, async () => {
  const f = await sharedReviewerFixture();
  const store = new WorkflowStore(f.directory);
  const queue = new BridgeStore(f.directory);
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url)),
      "--interrupt-mode", "confirmed", "--turn-mode", "active", "--active-visible-turns", "0"],
    requestTimeoutMs: 30_000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const dispatcher = new AppServerCodexCallbackDispatcher(client, { policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 } });
  const config = (f.manager as unknown as { config: WorkflowConfig }).config;
  const fresh = new WorkflowManager(store, client, config, dispatcher, queue, undefined, {},
    { get: (id) => id === f.parent.id ? f.parent : undefined }, f.factory);
  try {
    const { record, originalStats } = await retireOriginal(f);
    await f.manager.stop();
    await fresh.recoverCallbacks();
    const runtime = (fresh as unknown as { runtime: { backgroundTasks: Set<Promise<unknown>> } }).runtime;
    await Promise.allSettled([...runtime.backgroundTasks]);
    const request = (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(client);
    const after = await request<SharedReviewerStats>("fixture/stats", {});
    assert.notEqual(after.processId, originalStats.processId, "The replacement gateway is a real distinct local App Server process");
    assert.equal(after.visibleTurns, 0, "An old ephemeral record cannot reconstruct the original model operation in a fresh process");
    assert.deepEqual(after.threadStarts, []);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 1);
    const result = await store.load(record.id);
    assert.match(`${result?.submissionError ?? ""} ${result?.error ?? ""}`, /original|unavailable|retired|lost|process/i);
    assert.equal(result?.reviewCycles, 0);
    assert.equal(result?.stagedVerdict, undefined);
  } finally { await fresh.stop(); await client.stop(); queue.close(); store.close(); await f.close(); }
});

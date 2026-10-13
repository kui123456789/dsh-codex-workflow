import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TerminalCleanupGuard } from "../src/application/terminal-cleanup-guard.js";
import { CodexAppServerClient } from "../src/app-server.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowTerminalCleanupMarker } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The original local diagnostic was verified.";
const input = { implementationSummary: "Verified read-only local diagnostics", changedFiles: ["changed.txt"], testResults: "Local checks passed" };

async function nativeFixture() {
  const f = await sharedReviewerFixture();
  const options = (f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number } }).options;
  options.args = [protocol, "--interrupt-mode", "failed"];
  options.rpcTimeoutMs = 15_000;
  let ends = 0;
  const originalEndRound = f.client.endRound.bind(f.client);
  f.client.endRound = () => { ends += 1; originalEndRound(); };
  return { ...f, get ends() { return ends; }, async close() {
    await f.control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
    await f.close();
    f.client.endRound = originalEndRound;
  } };
}

test("terminal cleanup lifecycle old ACK preserves a successor marker with the same scope and primary error", async () => {
  const f = await nativeFixture();
  try {
    await f.control("fixture/configure", { responses: { status: [{ kind: "needs_input" }] } });
    const first = await f.manager.start({ task: "Plan read-only local configuration diagnostics" }, f.exec);
    assert.equal(first.retryState?.awaitingCleanup, true);
    const original = f.runtime.recoverableRuns.get(first.id);
    assert.ok(original?.terminalFailure);
    const child = original.child;
    assert.ok(child);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.active.length, 1);
    const pair = stats.active[0]!;
    await f.control("fixture/setInterruptMode", { mode: "held" });
    const stopping = f.manager.stop();
    await sharedWaitFor(async () => {
      const current = await f.control("fixture/stats");
      return current.interrupts.length === stats.interrupts.length + 1 && current;
    }, "original cleanup ACK held before generation replacement");
    assert.deepEqual(f.rawDisposals, []);
    const resource = `terminal-cleanup:${first.dshSessionId}:${first.id}`;
    const prior = f.store.coordinationHandle.leaseInfo(resource);
    assert.ok(prior);
    const oldDescriptor = JSON.parse(prior.owner) as Record<string, unknown>;
    f.store.coordinationHandle.db.prepare("UPDATE leases SET lease_until = 0 WHERE resource = ?").run(resource);
    const nextToken = "successor-cleanup-token-with-the-same-primary-error";
    const nextOwner = JSON.stringify({ ...oldDescriptor, token: nextToken, confirmed: false });
    const nextGrant = f.store.coordinationHandle.acquireLease(resource, 60_000, nextOwner);
    assert.ok(nextGrant);
    const nextMarker: WorkflowTerminalCleanupMarker = { token: nextToken, epoch: nextGrant.epoch, sessionId: first.dshSessionId };
    assert.equal(nextMarker.epoch, prior.epoch + 1);
    await f.store.update(first.id, (record) => {
      assert.ok(record.retryState);
      assert.equal(record.retryState.terminalFailure, original.terminalFailure);
      record.retryState.terminalCleanup = nextMarker;
    }, { ignoreCancelled: true });
    const successor = f.store.coordinationHandle.loadWorkflow(first.id);
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    await stopping;
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(first.id), successor,
      "The old physical ACK does not authorize deleting the successor's marker or changing its workflow row");
    assert.equal(new TerminalCleanupGuard(f.store).isConfirmed(first.id, nextMarker), false);
    assert.equal(f.store.coordinationHandle.leaseInfo(resource)?.owner, nextOwner, "Stale SQL release cannot confirm the new guard");
    assert.deepEqual(f.rawDisposals, [child.id]);
    assert.deepEqual(f.subscriptionsReleased, [original.threadId]);
    assert.equal(f.ends, 1);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    const ended = await f.control("fixture/stats");
    assert.deepEqual(ended.active, []);
    assert.equal(ended.interrupts.length, stats.interrupts.length + 1);
    assert.ok(ended.interrupts.every((entry) => entry.threadId === pair.threadId && entry.turnId === pair.turnId));
    await f.manager.stop();
    assert.deepEqual(f.rawDisposals, [child.id]);
    assert.equal(f.ends, 1);
  } finally { await f.close(); }
});

test("terminal cleanup Reviewer publishes its fresh guard before exposing a waiting marker to a cold Manager", async () => {
  const f = await nativeFixture();
  const coldStore = new WorkflowStore(f.directory);
  const coldClient = new CodexAppServerClient({ command: process.execPath, args: [protocol],
    requestTimeoutMs: 30_000, rpcTimeoutMs: 15_000, idleProcessMs: 0 });
  const config = (f.manager as unknown as { config: WorkflowConfig }).config;
  const cold = new WorkflowManager(coldStore, coldClient, config, undefined, undefined, undefined, {},
    { get: (id) => id === f.parent.id ? f.parent : undefined }, f.factory);
  const published = sharedGate();
  const originalUpdate = f.store.update.bind(f.store);
  let held = false;
  try {
    await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ kind: "needs_input" }] } });
    const first = await f.manager.reviewOnly({ task: "Review read-only local diagnostic requirements", ...input }, f.exec);
    assert.ok(first.retryState?.terminalCleanup);
    const originalMarker = first.retryState.terminalCleanup;
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await assert.rejects(f.manager.resume(first.id, undefined, f.exec), /unexpectedly requested user input/);
    assert.equal(new TerminalCleanupGuard(f.store).isConfirmed(first.id, originalMarker), true);
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ kind: "needs_input" }] } });
    f.store.update = async <T>(...args: Parameters<typeof originalUpdate<T>>) => {
      const result = await originalUpdate<T>(...args);
      const marker = result.record.retryState?.terminalCleanup;
      if (!held && result.record.id === first.id && result.record.retryState?.awaitingCleanup && marker?.token !== originalMarker.token) {
        held = true;
        published.enter();
        await published.promise;
      }
      return result;
    };
    const reviewing = f.manager.review(first.id, { ...input, newReviewRound: true }, f.exec);
    void reviewing.catch(() => undefined);
    await sharedWaitFor(() => held, "fresh Reviewer terminal waiting marker published");
    const waiting = await coldStore.load(first.id);
    const marker = waiting?.retryState?.terminalCleanup;
    assert.ok(marker);
    assert.notEqual(marker.token, originalMarker.token);
    assert.equal(marker.epoch, originalMarker.epoch + 1);
    assert.equal(new TerminalCleanupGuard(coldStore).isConfirmed(first.id, marker), false);
    assert.equal(new TerminalCleanupGuard(coldStore).isConfirmed(first.id, originalMarker), false);
    const row = coldStore.coordinationHandle.leaseInfo(`terminal-cleanup:${marker.sessionId}:${first.id}`);
    assert.ok(row);
    assert.equal(row.epoch, marker.epoch);
    assert.equal(JSON.parse(row.owner).token, marker.token, "The live fresh guard already exists before the waiting update returns");
    const before = coldStore.coordinationHandle.loadWorkflow(first.id);
    const stats = await f.control("fixture/stats");
    await assert.rejects(cold.review(first.id, { ...input, newReviewRound: true }, f.exec), /unconfirmed.*cleanup|cleanup.*pending/i);
    assert.deepEqual(coldStore.coordinationHandle.loadWorkflow(first.id), before);
    assert.equal((coldClient as unknown as { child?: unknown }).child, undefined,
      "A cold Manager sends no model request or replacement thread when the fresh guard is live");
    assert.deepEqual((await f.control("fixture/stats")).threadStarts, stats.threadStarts);
    published.release();
    const second = await reviewing;
    assert.equal(second.retryState?.terminalCleanup?.token, marker.token);
  } finally {
    published.release();
    f.store.update = originalUpdate;
    await cold.stop();
    await coldClient.stop();
    coldStore.close();
    await f.close();
  }
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { ReviewInput, WorkflowConfig, WorkflowMode, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type ManagerLease } from "../src/workflow.js";
import { sharedReviewerFixture, sharedWaitFor, type SharedReviewerStats } from "./fixtures/bridge-shared-reviewer-fixture.js";
import { captureProcessTreeEvidence, isCompleteProcessIdentityEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { stopCapturedProcessTree } from "../src/infrastructure/process-tree-cleanup.js";

type Fixture = Awaited<ReturnType<typeof sharedReviewerFixture>>;
type Internals = { config: WorkflowConfig; runtime: WorkflowRuntimeState;
  acquireLease(resource: string): Promise<ManagerLease | undefined> };
const internal = (manager: WorkflowManager) => manager as unknown as Internals;
const reviewInput: ReviewInput = { implementationSummary: "Original local diagnostic implemented",
  changedFiles: ["changed.txt"], testResults: "Original valid and missing settings verified" };

function foreground(f: Fixture, store = f.store, parent = f.parent) {
  return new WorkflowManager(store, f.client, { ...internal(f.manager).config }, undefined, undefined, undefined, {},
    { get: (id) => id === parent.id ? parent : undefined }, f.factory);
}

async function waitingReviewer(f: Fixture, manager: WorkflowManager, mode: WorkflowMode) {
  let planned: WorkflowRecord | undefined;
  if (mode === "planned") {
    await f.control("fixture/setTurnMode", { mode: "completed" });
    planned = await manager.start({ task: "Implement read-only local configuration diagnostics" }, f.exec);
    assert.equal(planned.phase, "executing");
    assert.ok(planned.planMarkdown);
  }
  const baseline = await f.control("fixture/stats");
  await f.control("fixture/setTurnMode", { mode: "active" });
  await f.control("fixture/setActiveVisibleTurns", { count: baseline.visibleTurns + 2 });
  const pending = planned ? manager.review(planned.id, reviewInput, f.exec)
    : manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...reviewInput }, f.exec);
  void pending.catch(() => undefined);
  const first = await sharedWaitFor(async () => {
    const stats = await f.control("fixture/stats");
    return stats.active.length === 1 && stats.visibleTurns === baseline.visibleTurns + 1 && stats;
  }, "the original foreground Reviewer turn");
  await f.control("fixture/completeActive", { status: "failed" });
  const continued = await sharedWaitFor(async () => {
    const stats = await f.control("fixture/stats");
    return stats.active.length === 1 && stats.visibleTurns === baseline.visibleTurns + 2 && stats;
  }, "the same-thread automatic continuation");
  assert.equal(continued.active[0]!.threadId, first.active[0]!.threadId);
  await f.control("fixture/completeActive", { status: "failed" });
  const waiting = await pending;
  assert.equal(waiting.processState, "waiting");
  assert.equal(waiting.retryState?.stage, "reviewing");
  assert.equal(waiting.reviewCycles, 0);
  assert.ok(waiting.latestReviewEvidence?.fingerprint);
  const recovery = internal(manager).runtime.recoverableRuns.get(waiting.id);
  const child = internal(manager).runtime.codexChildSessions.get(waiting.id);
  assert.ok(recovery && child);
  assert.equal(recovery.threadId, first.active[0]!.threadId);
  return { waiting, recovery, child, stats: await f.control("fixture/stats") };
}

async function coldReviewer(mode: WorkflowMode) {
  const original = await sharedReviewerFixture();
  const owner = foreground(original);
  let fresh: Fixture | undefined;
  let successor: WorkflowManager | undefined;
  try {
    const run = await waitingReviewer(original, owner, mode);
    const row = original.store.coordinationHandle.loadWorkflow(run.waiting.id);
    await owner.stop();
    await original.client.stop();
    assert.deepEqual(original.store.coordinationHandle.loadWorkflow(run.waiting.id), row,
      "Stopping the original process retains its real waiting record and revision");
    fresh = await sharedReviewerFixture();
    await fresh.control("fixture/setTurnMode", { mode: "completed" });
    successor = foreground(fresh, original.store, original.parent);
    assert.equal(internal(successor).runtime.recoverableRuns.size, 0);
    assert.notEqual((await fresh.control("fixture/stats")).processId, run.stats.processId);
    return { original, owner, fresh, successor, ...run, async close() {
      await successor!.stop(); await owner.stop(); await fresh!.close(); await original.close();
    } };
  } catch (error) {
    await successor?.stop(); await owner.stop(); await fresh?.close(); await original.close();
    throw error;
  }
}

for (const mode of ["planned", "review_only"] as const) {
  test(`a cold ${mode} waiting Reviewer admits actual changed evidence as a new business round`, async () => {
    const f = await coldReviewer(mode);
    try {
      const fingerprint = f.waiting.latestReviewEvidence!.fingerprint;
      await writeFile(join(f.original.directory, "changed.txt"), "v2 actually changed approved diagnostic implementation", "utf8");
      const result = await f.successor.review(f.waiting.id, {
        ...reviewInput, implementationSummary: "The approved diagnostic's actual v2 workspace changed",
      }, f.original.exec);
      assert.equal(result.id, f.waiting.id);
      assert.equal(result.phase, "passed");
      assert.equal(result.reviewCycles, 1);
      assert.notEqual(result.latestReviewEvidence?.fingerprint, fingerprint);
      assert.equal(f.fresh.children.length, 1, "Only the independent new round creates a native child");
      assert.notEqual(f.fresh.children[0]!.id, f.child.id);
      assert.equal(internal(f.successor).runtime.recoverableRuns.size, 0);
      assert.equal(internal(f.successor).runtime.codexChildSessions.size, 0);
      assert.equal(f.fresh.rawDisposals.length, 1, "The successful new child is disposed once");
      assert.equal((await f.fresh.control("fixture/stats")).active.length, 0);
    } finally { await f.close(); }
  });

  test(`a cold ${mode} waiting Reviewer with unchanged evidence preserves the original row and creates nothing`, async () => {
    const f = await coldReviewer(mode);
    try {
      const row = f.original.store.coordinationHandle.loadWorkflow(f.waiting.id);
      await assert.rejects(f.successor.review(f.waiting.id, reviewInput, f.original.exec),
        /no in-process continuation|original.*unavailable|cannot recover/i);
      assert.deepEqual(f.original.store.coordinationHandle.loadWorkflow(f.waiting.id), row);
      const stats = await f.fresh.control("fixture/stats");
      assert.equal(stats.threadStarts.length, 0);
      assert.equal(stats.turnStartRequests.length, 0);
      assert.equal(f.fresh.children.length, 0);
    } finally { await f.close(); }
  });
}

test("changed foreground evidence cannot replace a live original writer without a confirmed interruption", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  let replacement: Promise<WorkflowRecord> | undefined;
  try {
    // A real timeout and a denied interruption leave the real original writer active.
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 50;
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/setActiveVisibleTurns", { count: 1 });
    const waiting = await manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...reviewInput }, f.exec);
    assert.equal(waiting.processState, "waiting");
    const runtime = internal(manager).runtime;
    const recovery = runtime.recoverableRuns.get(waiting.id);
    const child = runtime.codexChildSessions.get(waiting.id);
    assert.ok(recovery?.interruptionTurnId && child);
    const before = await f.control("fixture/stats");
    assert.equal(before.active.length, 1);
    assert.equal(before.interrupts.length, 1);
    assert.equal(before.interrupts[0]!.mode, "failed");
    const pin = (f.client as unknown as { pinned: number }).pinned;
    assert.ok(pin > 0);
    const childCount = f.children.length;
    const row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    await writeFile(join(f.directory, "changed.txt"), "v2 actual change while the original writer remains unconfirmed", "utf8");
    await assert.rejects(manager.review(waiting.id, {
      ...reviewInput, implementationSummary: "The actual approved workspace now contains v2",
    }, f.exec), /interrupt|confirm|pending|active/i);
    const after = await f.control("fixture/stats");
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.threadStarts, before.threadStarts);
    assert.deepEqual(after.active, before.active, "The failed ACK leaves the same physical writer alive");
    assert.equal(after.interrupts.length, before.interrupts.length + 1);
    assert.deepEqual(after.interrupts.at(-1), before.interrupts[0], "The ACK retry targets the original thread and turn");
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(runtime.codexChildSessions.get(waiting.id), child);
    assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
    assert.equal(f.children.length, childCount);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);

    // The actual ACK is now held: replacing resources must wait for confirmation.
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 30_000;
    await f.control("fixture/setInterruptMode", { mode: "held" });
    replacement = manager.review(waiting.id, reviewInput, f.exec);
    void replacement.catch(() => undefined);
    const held = await f.control("fixture/waitForInterrupt", { minimumCount: after.interrupts.length + 1 });
    assert.deepEqual(held.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(held.threadStarts, before.threadStarts);
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(runtime.codexChildSessions.get(waiting.id), child);
    assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    const accepted = await replacement;
    assert.equal(accepted.phase, "passed");
    assert.equal(accepted.reviewCycles, 1);
    assert.equal(f.children.length, childCount + 1);
    assert.notEqual(f.children.at(-1)!.id, child.id);
    assert.equal(f.rawDisposals.filter((id) => id === child.id).length, 1);
    assert.equal(runtime.recoverableRuns.size, 0);
    assert.equal(runtime.codexChildSessions.size, 0);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 0);
    const completed = await f.control("fixture/stats");
    assert.equal(completed.active.length, 0);
    assert.equal(completed.writerConflicts, 0);
  } finally {
    await f.control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
    await f.control("fixture/completeActive").catch(() => undefined);
    await replacement?.catch(() => undefined);
    await manager.stop(); await f.close();
  }
});

test("explicit new-round intent admits unchanged cold evidence as an independent review", async () => {
  const f = await coldReviewer("review_only");
  try {
    const fingerprint = f.waiting.latestReviewEvidence!.fingerprint;
    const result = await f.successor.review(f.waiting.id, { ...reviewInput, newReviewRound: true }, f.original.exec);
    assert.equal(result.phase, "passed");
    assert.equal(result.reviewCycles, 1);
    assert.equal(result.latestReviewEvidence?.fingerprint, fingerprint);
    assert.equal(f.fresh.children.length, 1);
    assert.notEqual(f.fresh.children[0]!.id, f.child.id);
    assert.equal(internal(f.successor).runtime.recoverableRuns.size, 0);
    assert.equal(internal(f.successor).runtime.codexChildSessions.size, 0);
    assert.equal(f.fresh.rawDisposals.length, 1);
  } finally { await f.close(); }
});

test("a second manager with no runtime cannot replace another manager's still-live unconfirmed Reviewer", async (t) => {
  const f = await sharedReviewerFixture();
  const owner = foreground(f);
  const other = foreground(f);
  let foreign: Fixture | undefined;
  let foreignManager: WorkflowManager | undefined;
  let fresh: Fixture | undefined;
  let successor: WorkflowManager | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures: unknown[] = [];
    // One rejected original stop cannot strand an independent fixture. Keep
    // finally and the native after hook on the same cleanup flight, and only
    // report the first error after every owned resource was attempted.
    for (const step of [
      () => f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined),
      () => f.control("fixture/completeActive").catch(() => undefined),
      () => successor?.stop(), () => fresh?.close(),
      () => foreignManager?.stop(), () => foreign?.close(),
      () => other.stop(), () => owner.stop(), () => f.close(),
    ]) {
      try { await step(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  })();
  t.after(cleanup);
  try {
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 50;
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/setActiveVisibleTurns", { count: 1 });
    const waiting = await owner.reviewOnly({ task: "Review read-only local configuration diagnostics", ...reviewInput }, f.exec);
    assert.equal(waiting.processState, "waiting");
    const recovery = internal(owner).runtime.recoverableRuns.get(waiting.id);
    const child = internal(owner).runtime.codexChildSessions.get(waiting.id);
    assert.ok(recovery?.interruptionTurnId && child);
    const before = await f.control("fixture/stats");
    assert.equal(waiting.retryState?.interruption?.processId, before.processId,
      "The waiting marker identifies the actual backend that accepted the original turn");
    assert.ok(waiting.retryState?.interruption?.processIds?.includes(before.processId));
    assert.equal(waiting.reviewerThreadId, undefined,
      "Pending process evidence does not persist the private foreground Reviewer thread");
    assert.equal(before.active.length, 1);
    assert.equal(before.active[0]!.threadId, recovery.threadId);
    assert.equal(before.active[0]!.turnId, recovery.interruptionTurnId);
    assert.equal(f.client.isThreadAvailable(recovery.threadId), true,
      "The original SDK process is live; this is not cold process recovery");
    assert.equal(Boolean(f.store.coordinationHandle.leaseInfo(`review:${waiting.id}`)?.owner), false,
      "The original public review released admission, while its actual writer remains alive");
    assert.equal(internal(other).runtime.recoverableRuns.size, 0);
    assert.equal(internal(other).runtime.codexChildSessions.size, 0);
    const children = f.children.length;
    const pin = (f.client as unknown as { pinned: number }).pinned;
    let row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    await writeFile(join(f.directory, "changed.txt"), "v2 actual change while another manager owns the live original writer", "utf8");
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 30_000;
    const outcome = (await Promise.allSettled([other.review(waiting.id, {
      ...reviewInput, newReviewRound: true,
    }, f.exec)]))[0]!;
    const after = await f.control("fixture/stats");
    const rowAfter = f.store.coordinationHandle.loadWorkflow(waiting.id);
    t.diagnostic(JSON.stringify({ intent: "explicit new round while original writer is live", outcome: outcome.status,
      error: outcome.status === "rejected" ? String(outcome.reason) : undefined,
      originalProcessStillRunning: after.processId === before.processId,
      originalWriterStillAlive: after.active.some((turn) => turn.threadId === recovery.threadId && turn.turnId === recovery.interruptionTurnId),
      additionalModelRequests: after.turnStartRequests.length - before.turnStartRequests.length,
      additionalThreads: after.threadStarts.length - before.threadStarts.length,
      additionalNativeChildren: f.children.length - children,
      originalRecoveryRetained: internal(owner).runtime.recoverableRuns.get(waiting.id) === recovery,
      originalChildRetained: internal(owner).runtime.codexChildSessions.get(waiting.id) === child,
      originalRowUnchanged: JSON.stringify(rowAfter) === JSON.stringify(row) }));
    assert.equal(outcome.status, "rejected", "An empty local runtime cannot authorize replacing another live original writer");
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.threadStarts, before.threadStarts);
    assert.deepEqual(after.active, before.active);
    assert.equal(after.processId, before.processId);
    assert.equal(internal(owner).runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(internal(owner).runtime.codexChildSessions.get(waiting.id), child);
    assert.equal(f.children.length, children);
    assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
    assert.deepEqual(rowAfter, row);

    const implicit = (await Promise.allSettled([other.review(waiting.id, reviewInput, f.exec)]))[0]!;
    const afterImplicit = await f.control("fixture/stats");
    t.diagnostic(JSON.stringify({ intent: "changed evidence while original writer is live", outcome: implicit.status,
      additionalModelRequests: afterImplicit.turnStartRequests.length - before.turnStartRequests.length,
      additionalThreads: afterImplicit.threadStarts.length - before.threadStarts.length,
      additionalNativeChildren: f.children.length - children }));
    assert.equal(implicit.status, "rejected", "Changed evidence cannot authorize replacing a live original writer");
    assert.deepEqual(afterImplicit.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(afterImplicit.threadStarts, before.threadStarts);
    assert.deepEqual(afterImplicit.active, before.active);
    assert.equal(internal(owner).runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(internal(owner).runtime.codexChildSessions.get(waiting.id), child);
    assert.equal(f.children.length, children);
    assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);

    const interruptionTurnId = recovery.interruptionTurnId;
    recovery.interruptionTurnId = undefined;
    try {
      await assert.rejects(owner.review(waiting.id, { ...reviewInput, newReviewRound: true }, f.exec),
        /interruption.*unconfirmed|process.*unknown/i);
      const refused = await f.control("fixture/stats");
      assert.deepEqual(refused.turnStartRequests, before.turnStartRequests);
      assert.deepEqual(refused.threadStarts, before.threadStarts);
      assert.deepEqual(refused.active, before.active);
      assert.equal(internal(owner).runtime.recoverableRuns.get(waiting.id), recovery);
      assert.equal(internal(owner).runtime.codexChildSessions.get(waiting.id), child);
      assert.equal(f.children.length, children);
      assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
      t.diagnostic("Partial original handle without its ACK turn retains the live-process guard and creates no resources");
    } finally { recovery.interruptionTurnId = interruptionTurnId; }

    // Inject a read-only SDK availability projection fault; the physical backend remains alive.
    const originalAvailability = f.client.isThreadAvailable;
    f.client.isThreadAvailable = () => false;
    try {
      await assert.rejects(owner.review(waiting.id, { ...reviewInput, newReviewRound: true }, f.exec),
        /interruption.*unconfirmed|process.*exit.*confirmed/i);
      const refused = await f.control("fixture/stats");
      assert.equal(refused.processId, before.processId);
      assert.doesNotThrow(() => process.kill(before.processId, 0));
      assert.deepEqual(refused.active, before.active);
      assert.deepEqual(refused.turnStartRequests, before.turnStartRequests);
      assert.deepEqual(refused.threadStarts, before.threadStarts);
      assert.equal(internal(owner).runtime.recoverableRuns.get(waiting.id), recovery);
      assert.equal(internal(owner).runtime.codexChildSessions.get(waiting.id), child);
      assert.equal(f.children.length, children);
      assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
      t.diagnostic("SDK availability projection fault refuses replacement while the OS confirms the original PID is live");
    } finally { f.client.isThreadAvailable = originalAvailability; }

    // B2 has its own real SDK process, and cannot infer ownership from an empty local runtime.
    foreign = await sharedReviewerFixture();
    await foreign.control("fixture/setTurnMode", { mode: "completed" });
    foreignManager = foreground(foreign, f.store, f.parent);
    const foreignBaseline = await foreign.control("fixture/stats");
    assert.notEqual(foreignBaseline.processId, before.processId);
    assert.equal(internal(foreignManager).runtime.recoverableRuns.size, 0);
    for (const newReviewRound of [false, true]) {
      await assert.rejects(foreignManager.review(waiting.id, { ...reviewInput, newReviewRound }, f.exec),
        /interruption.*unconfirmed|process.*unknown/i);
      const refused: SharedReviewerStats = await foreign.control("fixture/stats");
      const original = await f.control("fixture/stats");
      t.diagnostic(JSON.stringify({ intent: "separate SDK while original writer is live", newReviewRound,
        additionalModelRequests: refused.turnStartRequests.length - foreignBaseline.turnStartRequests.length,
        additionalThreads: refused.threadStarts.length - foreignBaseline.threadStarts.length,
        additionalNativeChildren: foreign.children.length, originalWriterStillAlive: original.active.length === 1 }));
      assert.deepEqual(refused.turnStartRequests, foreignBaseline.turnStartRequests);
      assert.deepEqual(refused.threadStarts, foreignBaseline.threadStarts);
      assert.equal(foreign.children.length, 0);
      assert.deepEqual(original.active, before.active);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
      assert.equal(internal(owner).runtime.recoverableRuns.get(waiting.id), recovery);
      assert.equal(internal(owner).runtime.codexChildSessions.get(waiting.id), child);
      assert.equal((f.client as unknown as { pinned: number }).pinned, pin);
    }

    const originalRetryState = waiting.retryState;
    assert.ok(originalRetryState?.interruption);
    for (const interruption of [{}, { processId: 0 }]) {
      await f.store.update(waiting.id, (current) => {
        assert.ok(current.retryState);
        current.retryState.interruption = interruption;
      });
      const unknownRow = f.store.coordinationHandle.loadWorkflow(waiting.id);
      await assert.rejects(foreignManager.review(waiting.id, { ...reviewInput, newReviewRound: true }, f.exec),
        /interruption.*unconfirmed|process.*unknown/i);
      const refused: SharedReviewerStats = await foreign.control("fixture/stats");
      t.diagnostic(JSON.stringify({ intent: "unknown pending process marker", interruption,
        additionalModelRequests: refused.turnStartRequests.length - foreignBaseline.turnStartRequests.length,
        additionalThreads: refused.threadStarts.length - foreignBaseline.threadStarts.length,
        additionalNativeChildren: foreign.children.length }));
      assert.deepEqual(refused.turnStartRequests, foreignBaseline.turnStartRequests);
      assert.deepEqual(refused.threadStarts, foreignBaseline.threadStarts);
      assert.equal(foreign.children.length, 0);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), unknownRow);
      assert.equal(internal(owner).runtime.recoverableRuns.get(waiting.id), recovery);
      assert.equal(internal(owner).runtime.codexChildSessions.get(waiting.id), child);
      assert.deepEqual((await f.control("fixture/stats")).active, before.active);
      await f.store.update(waiting.id, (current) => { current.retryState = structuredClone(originalRetryState); });
      assert.deepEqual((await f.store.load(waiting.id))?.retryState, originalRetryState);
    }
    row = f.store.coordinationHandle.loadWorkflow(waiting.id);

    // Retire the actual original process before admitting the separate v2 business round.
    await foreignManager.stop();
    await other.stop();
    await owner.stop();
    await f.client.stop();
    await sharedWaitFor(() => {
      try { process.kill(before.processId, 0); return false; }
      catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH",
          "Only the OS absence result proves the original process exited");
        return true;
      }
    }, "the OS-confirmed original process exit");
    assert.throws(() => process.kill(before.processId, 0), { code: "ESRCH" });
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
    assert.equal(f.client.isThreadAvailable(recovery.threadId), false);
    fresh = await sharedReviewerFixture();
    await fresh.control("fixture/setTurnMode", { mode: "completed" });
    const freshBaseline = await fresh.control("fixture/stats");
    assert.notEqual(freshBaseline.processId, before.processId);
    successor = foreground(fresh, f.store, f.parent);
    assert.equal(internal(successor).runtime.recoverableRuns.size, 0);
    const accepted = await successor.review(waiting.id, reviewInput, f.exec);
    const completed = await fresh.control("fixture/stats");
    t.diagnostic(JSON.stringify({ intent: "actual v2 business round after original process stopped", phase: accepted.phase,
      freshProcessId: completed.processId, originalProcessId: before.processId,
      additionalModelRequests: completed.turnStartRequests.length - freshBaseline.turnStartRequests.length,
      additionalThreads: completed.threadStarts.length - freshBaseline.threadStarts.length,
      additionalNativeChildren: fresh.children.length, visibleReviewerTurns: completed.visibleTurns }));
    assert.equal(accepted.id, waiting.id);
    assert.equal(accepted.phase, "passed");
    assert.equal(accepted.reviewCycles, 1);
    assert.notEqual(accepted.latestReviewEvidence?.fingerprint, waiting.latestReviewEvidence?.fingerprint);
    assert.equal(fresh.children.length, 1);
    assert.notEqual(fresh.children[0]!.id, child.id);
    assert.equal(completed.visibleTurns, 1);
    assert.equal(completed.active.length, 0);
    assert.equal(completed.writerConflicts, 0);
    assert.equal(internal(successor).runtime.recoverableRuns.size, 0);
    assert.equal(internal(successor).runtime.codexChildSessions.size, 0);
    assert.equal(fresh.rawDisposals.length, 1);
  } finally {
    await cleanup();
  }
});

test("a stopped owned launcher cannot authorize replacing its still-live backend Reviewer", async (t) => {
  const f = await sharedReviewerFixture();
  const owner = foreground(f);
  let fresh: Fixture | undefined;
  let successor: WorkflowManager | undefined;
  let launcherPid: number | undefined;
  let backendPid: number | undefined;
  let originalTree: ProcessTreeEvidence | undefined;
  const launcherPath = join(f.directory, "owned-reviewer-launcher.mjs");
  const backendPath = join(f.directory, "owned-reviewer-eof-keepalive.mjs");
  const launcherPidPath = join(f.directory, "owned-reviewer-launcher.pid");
  const backendPidPath = join(f.directory, "owned-reviewer-backend.pid");
  const originalInstance = (pid: number): ProcessTreeEvidence => {
    const identity = originalTree?.processIdentities?.find(value => value.processId === pid);
    assert.ok(identity, "Fixture termination requires a captured original birth, never just a PID file");
    return { processId: pid, processIds: [pid], processIdentities: [identity] };
  };
  const stopOwned = async (pid: number | undefined) => {
    if (pid === undefined || !originalTree) return;
    assert.equal(await stopCapturedProcessTree(originalInstance(pid), 4000), true,
      "Only the captured original fixture instance may be terminated");
  };
  try {
    // Only this diagnostic detached backend survives EOF; the protocol and writer remain the existing fixture.
    await writeFile(backendPath, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(backendPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      'const retainAfterPipeFailure = (error) => { if (!["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };',
      'process.stdin.on("error", retainAfterPipeFailure);',
      'process.stdout.on("error", retainAfterPipeFailure);',
      await readFile(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url), "utf8"),
      'input.on("error", retainAfterPipeFailure);',
    ].join("\n"), "utf8");
    await writeFile(launcherPath, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(launcherPidPath)}, String(process.pid));`,
      `const backend = spawn(process.execPath, [${JSON.stringify(backendPath)}, ...process.argv.slice(2)], { stdio: "inherit", detached: true, windowsHide: true });`,
      'backend.once("error", () => process.exit(1));',
      'backend.once("exit", (code) => process.exit(code ?? 1));',
    ].join("\n"), "utf8");
    const options = (f.client as unknown as { options: { args: string[]; requestTimeoutMs: number } }).options;
    options.args = [launcherPath, ...options.args.slice(1)];
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/setActiveVisibleTurns", { count: 1 });
    const started = await f.control("fixture/stats");
    backendPid = started.processId;
    launcherPid = Number(await readFile(launcherPidPath, "utf8"));
    assert.notEqual(launcherPid, backendPid);
    originalTree = { processId: launcherPid, ...await captureProcessTreeEvidence(launcherPid) };
    assert.equal(isCompleteProcessIdentityEvidence(originalTree), true);
    assert.ok(originalTree.processIds?.includes(backendPid));
    options.requestTimeoutMs = 50;
    const waiting = await owner.reviewOnly({ task: "Review read-only local configuration diagnostics", ...reviewInput }, f.exec);
    assert.equal(waiting.processState, "waiting");
    const original = await f.control("fixture/stats");
    assert.equal(original.processId, backendPid);
    assert.equal(original.active.length, 1);
    const marker = waiting.retryState?.interruption;
    assert.equal(marker?.processId, launcherPid);
    const processIds = marker?.processIds;
    assert.ok(processIds);
    assert.ok(processIds.includes(launcherPid));
    assert.ok(processIds.includes(backendPid));
    assert.equal(waiting.reviewerThreadId, undefined);
    const row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    await writeFile(join(f.directory, "changed.txt"), "v2 actual change after the original launcher exits", "utf8");

    await stopOwned(launcherPid);
    assert.doesNotThrow(() => process.kill(backendPid!, 0), "The owned backend survives the launcher exit");
    // No old control call follows launcher exit: observation cannot respawn its transport.
    fresh = await sharedReviewerFixture();
    await fresh.control("fixture/setTurnMode", { mode: "completed" });
    successor = foreground(fresh, f.store, f.parent);
    const baseline = await fresh.control("fixture/stats");
    for (const newReviewRound of [false, true]) {
      assert.doesNotThrow(() => process.kill(backendPid!, 0));
      assert.deepEqual((await f.store.load(waiting.id))?.retryState?.interruption, marker);
      const outcome: PromiseSettledResult<WorkflowRecord> = (await Promise.allSettled([
        successor.review(waiting.id, { ...reviewInput, newReviewRound }, f.exec),
      ]))[0]!;
      const refused: SharedReviewerStats = await fresh.control("fixture/stats");
      t.diagnostic(JSON.stringify({ intent: "owned launcher gone while owned backend survives EOF", newReviewRound,
        outcome: outcome.status, error: outcome.status === "rejected" ? String(outcome.reason) : undefined,
        launcherPid, backendPid, capturedProcessIds: processIds,
        originalProcessIdentities: originalTree.processIdentities,
        additionalModelRequests: refused.turnStartRequests.length - baseline.turnStartRequests.length,
        additionalThreads: refused.threadStarts.length - baseline.threadStarts.length,
        additionalNativeChildren: fresh.children.length }));
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") assert.match(String(outcome.reason), /interruption.*unconfirmed|process.*unknown/i);
      assert.deepEqual(refused.turnStartRequests, baseline.turnStartRequests);
      assert.deepEqual(refused.threadStarts, baseline.threadStarts);
      assert.equal(fresh.children.length, 0);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
      assert.equal(await originalProcessTreeExited(originalInstance(launcherPid)), true,
        "A reused numeric PID cannot resurrect the original launcher");
      assert.doesNotThrow(() => process.kill(backendPid!, 0));
    }

    await stopOwned(backendPid);
    assert.equal(await originalProcessTreeExited(originalTree), true);
    await owner.stop();
    await f.client.stop();
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
    const accepted = await successor.review(waiting.id, reviewInput, f.exec);
    const completed = await fresh.control("fixture/stats");
    assert.equal(accepted.id, waiting.id);
    assert.equal(accepted.phase, "passed");
    assert.equal(accepted.reviewCycles, 1);
    assert.notEqual(accepted.latestReviewEvidence?.fingerprint, waiting.latestReviewEvidence?.fingerprint);
    assert.equal(fresh.children.length, 1);
    assert.equal(completed.visibleTurns, 1);
    assert.equal(completed.writerConflicts, 0);
    assert.equal(completed.active.length, 0);
    assert.equal(fresh.rawDisposals.length, 1);
    t.diagnostic(JSON.stringify({ intent: "all owned original process-tree instances confirmed exited", phase: accepted.phase,
      additionalModelRequests: completed.turnStartRequests.length - baseline.turnStartRequests.length,
      additionalThreads: completed.threadStarts.length - baseline.threadStarts.length,
      additionalNativeChildren: fresh.children.length, visibleReviewerTurns: completed.visibleTurns }));
  } finally {
    // PID files are written solely by the two scripts created in this unique fixture directory.
    backendPid ??= Number(await readFile(backendPidPath, "utf8").catch(() => "")) || undefined;
    launcherPid ??= Number(await readFile(launcherPidPath, "utf8").catch(() => "")) || undefined;
    await stopOwned(backendPid); await stopOwned(launcherPid);
    await successor?.stop(); await fresh?.close();
    await owner.stop(); await f.client.stop(); await f.close();
  }
});

test("a launcher exit during actual interruption tree capture retains a durable pending guard for its live backend", async (t) => {
  const f = await sharedReviewerFixture();
  const owner = foreground(f);
  let fresh: Fixture | undefined;
  let successor: WorkflowManager | undefined;
  let launcherPid: number | undefined;
  let backendPid: number | undefined;
  let queryPid: number | undefined;
  let capturedDuringFailedAck = false;
  let failedAckObserved = false;
  const launcherPath = join(f.directory, "capture-race-owned-launcher.mjs");
  const backendPath = join(f.directory, "capture-race-owned-backend.mjs");
  const launcherPidPath = join(f.directory, "capture-race-launcher.pid");
  const backendPidPath = join(f.directory, "capture-race-backend.pid");
  const originalExecFile = childProcess.execFile;
  const originalInterrupt = f.client.interrupt;
  const stopOwned = async (pid: number | undefined) => {
    if (pid === undefined) return;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    try { process.kill(pid); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); }
    await sharedWaitFor(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return true; }
    }, `the capture-race owned fixture process ${pid} exit`);
  };
  try {
    await writeFile(backendPath, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(backendPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      'const retainAfterPipeFailure = (error) => { if (!["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };',
      'process.stdin.on("error", retainAfterPipeFailure);',
      'process.stdout.on("error", retainAfterPipeFailure);',
      await readFile(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url), "utf8"),
      'input.on("error", retainAfterPipeFailure);',
    ].join("\n"), "utf8");
    await writeFile(launcherPath, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(launcherPidPath)}, String(process.pid));`,
      `const backend = spawn(process.execPath, [${JSON.stringify(backendPath)}, ...process.argv.slice(2)], { stdio: "inherit", detached: true, windowsHide: true });`,
      'backend.once("error", () => process.exit(1));',
      'backend.once("exit", (code) => process.exit(code ?? 1));',
    ].join("\n"), "utf8");
    const options = (f.client as unknown as { options: { args: string[]; requestTimeoutMs: number } }).options;
    options.args = [launcherPath, ...options.args.slice(1)];
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/setActiveVisibleTurns", { count: 1 });
    backendPid = (await f.control("fixture/stats")).processId;
    launcherPid = Number(await readFile(launcherPidPath, "utf8"));
    assert.notEqual(launcherPid, backendPid);
    f.client.interrupt = async (...args) => {
      try { return await originalInterrupt.apply(f.client, args); }
      catch (error) { failedAckObserved = true; throw error; }
    };
    // The observer calls the real execFile first; an actual query child is live when the launcher exits.
    childProcess.execFile = ((...args: Parameters<typeof originalExecFile>) => {
      const query = Reflect.apply(originalExecFile, childProcess, args) as ReturnType<typeof originalExecFile>;
      const command = String(args[0]);
      const commandArgs = args[1];
      const processTreeQuery = Array.isArray(commandArgs) && commandArgs.some((arg) => String(arg).includes("Get-CimInstance Win32_Process"))
        || command === "ps" && Array.isArray(commandArgs) && commandArgs.includes("ppid=");
      if (processTreeQuery && failedAckObserved && !capturedDuringFailedAck) {
        assert.ok(query.pid);
        queryPid = query.pid;
        assert.doesNotThrow(() => process.kill(queryPid!, 0));
        assert.doesNotThrow(() => process.kill(backendPid!, 0));
        assert.doesNotThrow(() => process.kill(launcherPid!, 0));
        capturedDuringFailedAck = true;
        process.kill(launcherPid!);
      }
      return query;
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    options.requestTimeoutMs = 50;
    const failedInterrupt = f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    void failedInterrupt.catch(() => undefined);
    const operation = owner.reviewOnly({ task: "Review read-only local configuration diagnostics", ...reviewInput }, f.exec);
    const operationOutcome: PromiseSettledResult<WorkflowRecord> = (await Promise.allSettled([operation]))[0]!;
    const failedAckStats = await failedInterrupt;
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    assert.equal(failedAckObserved, true, "Submission census cannot stand in for the actual failed interrupt ACK");
    assert.equal(capturedDuringFailedAck, true);
    assert.ok(queryPid);
    assert.equal(failedAckStats.interrupts.at(-1)?.mode, "failed");
    assert.equal(failedAckStats.active.length, 1);
    await stopOwned(launcherPid);
    assert.doesNotThrow(() => process.kill(backendPid!, 0));
    const retained = (await f.store.list()).find((record) => record.mode === "review_only");
    assert.ok(retained);
    const row = f.store.coordinationHandle.loadWorkflow(retained.id);
    await writeFile(join(f.directory, "changed.txt"), "v2 workspace changed while the orphaned original backend is still alive", "utf8");
    fresh = await sharedReviewerFixture();
    await fresh.control("fixture/setTurnMode", { mode: "completed" });
    successor = foreground(fresh, f.store, f.parent);
    const baseline = await fresh.control("fixture/stats");
    assert.doesNotThrow(() => process.kill(backendPid!, 0));
    const replacement: PromiseSettledResult<WorkflowRecord> = (await Promise.allSettled([
      successor.review(retained.id, { ...reviewInput, newReviewRound: true }, f.exec),
    ]))[0]!;
    const after = await fresh.control("fixture/stats");
    t.diagnostic(JSON.stringify({ intent: "launcher exits during a witnessed live process-tree query after failed ACK",
      queryPid, capturedDuringFailedAck, launcherPid, backendPid,
      originalOperation: operationOutcome.status, originalPhase: retained.phase, originalProcessState: retained.processState,
      durablePendingMarker: retained.retryState?.interruption, replacement: replacement.status,
      replacementError: replacement.status === "rejected" ? String(replacement.reason) : undefined,
      additionalModelRequests: after.turnStartRequests.length - baseline.turnStartRequests.length,
      additionalThreads: after.threadStarts.length - baseline.threadStarts.length,
      additionalNativeChildren: fresh.children.length,
      originalRowUnchanged: JSON.stringify(f.store.coordinationHandle.loadWorkflow(retained.id)) === JSON.stringify(row) }));
    assert.doesNotThrow(() => process.kill(backendPid!, 0));
    assert.equal(retained.processState, "waiting", "Loss of transport after an unconfirmed ACK must retain the pending-writer guard");
    assert.ok(retained.retryState?.interruption);
    assert.equal(replacement.status, "rejected");
    assert.deepEqual(after.turnStartRequests, baseline.turnStartRequests);
    assert.deepEqual(after.threadStarts, baseline.threadStarts);
    assert.equal(fresh.children.length, 0);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(retained.id), row);
  } finally {
    f.client.interrupt = originalInterrupt;
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    backendPid ??= Number(await readFile(backendPidPath, "utf8").catch(() => "")) || undefined;
    launcherPid ??= Number(await readFile(launcherPidPath, "utf8").catch(() => "")) || undefined;
    await stopOwned(backendPid); await stopOwned(launcherPid);
    await successor?.stop(); await fresh?.close();
    await owner.stop(); await f.client.stop(); await f.close();
  }
});

test("a real confirmed Reviewer cleanup followed by caller abort does not leave a false durable pending guard", async (t) => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  const originalInterrupt = f.client.interrupt;
  try {
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 50;
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/setActiveVisibleTurns", { count: 1 });
    const waiting = await manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...reviewInput }, f.exec);
    assert.equal(waiting.processState, "waiting");
    assert.ok(waiting.retryState?.interruption);
    const recovery = internal(manager).runtime.recoverableRuns.get(waiting.id);
    const child = internal(manager).runtime.codexChildSessions.get(waiting.id);
    assert.ok(recovery?.interruptionTurnId && child);
    const before = await f.control("fixture/stats");
    assert.equal(before.active.length, 1);
    const caller = new AbortController();
    let confirmedAck = false;
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    f.client.interrupt = async (...args) => {
      await originalInterrupt.apply(f.client, args);
      confirmedAck = true;
      caller.abort(new Error("diagnostic caller abort immediately after the real cleanup ACK"));
    };
    const resumeExec = Object.assign(Object.create(f.exec), { signal: caller.signal }) as typeof f.exec;
    await assert.rejects(manager.resume(waiting.id, "Continue only the original review", resumeExec), /caller abort|abort/i);
    f.client.interrupt = originalInterrupt;
    const cleaned = await f.control("fixture/stats");
    assert.equal(confirmedAck, true);
    assert.equal(cleaned.active.length, 0, "The real backend ACK actually ended the old writer");
    assert.equal(cleaned.interrupts.length, before.interrupts.length + 1);
    assert.deepEqual(cleaned.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(cleaned.threadStarts, before.threadStarts);
    assert.equal(internal(manager).runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(internal(manager).runtime.codexChildSessions.get(waiting.id), child);
    assert.equal(recovery.interruptionTurnId, undefined);
    const afterAbort = await f.store.load(waiting.id);
    assert.ok(afterAbort);
    assert.equal(afterAbort.processState, "waiting");
    await writeFile(join(f.directory, "changed.txt"), "v2 actual business change after a physically confirmed old Reviewer ACK", "utf8");
    const nextRound: PromiseSettledResult<WorkflowRecord> = (await Promise.allSettled([
      manager.review(waiting.id, { ...reviewInput, newReviewRound: true }, f.exec),
    ]))[0]!;
    const final = await f.control("fixture/stats");
    t.diagnostic(JSON.stringify({ intent: "real ACK then caller-only abort before continuation observation begins", confirmedAck,
      originalWriterEnded: cleaned.active.length === 0, retainedSameRuntime: internal(manager).runtime.recoverableRuns.get(waiting.id) === recovery,
      remainingAckTurnId: recovery.interruptionTurnId, durablePendingMarker: afterAbort.retryState?.interruption,
      newRound: nextRound.status, error: nextRound.status === "rejected" ? String(nextRound.reason) : undefined,
      additionalModelRequests: final.turnStartRequests.length - cleaned.turnStartRequests.length,
      additionalThreads: final.threadStarts.length - cleaned.threadStarts.length,
      additionalNativeChildren: f.children.length - 1 }));
    assert.equal(afterAbort.retryState?.interruption, undefined,
      "A confirmed physical cleanup must not remain persisted as an unconfirmed original writer");
    assert.equal(nextRound.status, "fulfilled");
    if (nextRound.status === "fulfilled") {
      assert.equal(nextRound.value.phase, "passed");
      assert.equal(nextRound.value.reviewCycles, 1);
    }
  } finally {
    f.client.interrupt = originalInterrupt;
    await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
    await f.control("fixture/completeActive").catch(() => undefined);
    await manager.stop(); await f.close();
  }
});

test("public original-thread resume refuses another manager's real live review admission lease", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  const other = foreground(f);
  let lease: ManagerLease | undefined;
  try {
    const run = await waitingReviewer(f, manager, "review_only");
    lease = await internal(other).acquireLease(`review:${run.waiting.id}`);
    assert.ok(lease);
    const row = f.store.coordinationHandle.loadWorkflow(run.waiting.id);
    await assert.rejects(manager.resume(run.waiting.id, "Continue only the original review", f.exec), /admitted review|lease|another.*review/i);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(`review:${run.waiting.id}`, lease.epoch, lease.owner), true);
    const after = await f.control("fixture/stats");
    assert.deepEqual(after.turnStartRequests, run.stats.turnStartRequests);
    assert.deepEqual(after.threadStarts, run.stats.threadStarts);
    assert.equal(internal(manager).runtime.recoverableRuns.get(run.waiting.id), run.recovery);
    assert.equal(internal(manager).runtime.codexChildSessions.get(run.waiting.id), run.child);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(run.waiting.id), row);
  } finally { await lease?.release(); await other.stop(); await manager.stop(); await f.close(); }
});

test("cold changed evidence cannot steal another manager's live review admission lease", async () => {
  const f = await coldReviewer("review_only");
  const other = foreground(f.fresh, f.original.store, f.original.parent);
  let lease: ManagerLease | undefined;
  try {
    await writeFile(join(f.original.directory, "changed.txt"), "v2 actual change with a live external admission owner", "utf8");
    lease = await internal(other).acquireLease(`review:${f.waiting.id}`);
    assert.ok(lease);
    const row = f.original.store.coordinationHandle.loadWorkflow(f.waiting.id);
    await assert.rejects(f.successor.review(f.waiting.id, reviewInput, f.original.exec), /admitted review|lease|another.*review/i);
    assert.equal(f.original.store.coordinationHandle.isLeaseOwner(`review:${f.waiting.id}`, lease.epoch, lease.owner), true);
    assert.deepEqual(f.original.store.coordinationHandle.loadWorkflow(f.waiting.id), row);
    const stats = await f.fresh.control("fixture/stats");
    assert.equal(stats.turnStartRequests.length, 0);
    assert.equal(stats.threadStarts.length, 0);
    assert.equal(f.fresh.children.length, 0);
  } finally { await lease?.release(); await other.stop(); await f.close(); }
});

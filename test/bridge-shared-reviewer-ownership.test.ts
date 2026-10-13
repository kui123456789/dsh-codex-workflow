import assert from "node:assert/strict";
import test from "node:test";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

test("an old Bridge lease-loss notification cannot interrupt the original Reviewer joined by its actual successor", { timeout: 30_000 }, async () => {
  const f = await sharedReviewerFixture({ mode: "active" });
  try {
    const record = await f.start();
    const original = await f.store.load(record.id);
    assert.ok(original?.submissionId);
    assert.ok(original.submissionLeaseToken);
    assert.ok(original.submissionLeaseEpoch !== undefined);
    const child = f.runtime.codexChildSessions.get(record.id);
    assert.ok(child);
    const resource = `submission:${record.id}:${original.submissionId}`;
    assert.equal(f.store.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true);
    // The notification must exist before B adopts: adoption ends A's wait
    // and stops its heartbeat, so it need not observe SQL loss afterwards.
    await f.lossSeen.entered;
    const aTasks = new Set(f.runtime.backgroundTasks);
    assert.equal(await f.manager.recoverCallbacks(), 1);
    await f.bSend.entered;
    const bTasks = [...f.runtime.backgroundTasks].filter((task) => !aTasks.has(task));
    assert.equal(f.sends.length, 2, "Both lease consumers called the real dispatcher");
    const before = await f.control("fixture/stats");
    assert.equal(before.threadStarts.length, 1, "The successor uses the original physical Reviewer");
    assert.equal(before.turnStartRequests.length, 1, "Joining an active operation sends no second model request");
    assert.equal(before.active.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.runtime.codexChildSessions.get(record.id), child);
    const successor = await f.store.load(record.id);
    assert.ok(successor?.submissionLeaseToken);
    assert.ok(successor.submissionLeaseEpoch !== undefined && successor.submissionLeaseEpoch > original.submissionLeaseEpoch);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
    const childHistory = child.session.snapshotEvents();
    f.lossRelease.release();
    await f.lossForwarded.entered;
    await Promise.allSettled([...aTasks]);
    const after = await f.control("fixture/stats");
    assert.deepEqual({ active: after.active, modelRequests: after.turnStartRequests.length,
      threadStarts: after.threadStarts.length, interrupts: after.interrupts.length,
      originalChildStillRegistered: f.runtime.codexChildSessions.get(record.id) === child,
      nativeDisposals: f.rawDisposals.length }, {
      active: before.active, modelRequests: 1, threadStarts: 1, interrupts: 0,
      originalChildStillRegistered: true, nativeDisposals: 0,
    }, "A stale consumer cannot cancel or close the physical operation and child currently claimed by B");
    assert.equal(f.sends[1]!.signal?.aborted, false, "The successor's actual wait signal remains live");
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
    assert.deepEqual(child.session.snapshotEvents(), childHistory);
    await f.control("fixture/completeActive", { status: "completed" });
    await Promise.allSettled(bTasks);
    const completed = await f.store.load(record.id);
    assert.ok(completed);
    assert.equal(completed.submissionState, "received", completed.submissionError);
    assert.equal(completed.submissionLeaseToken, undefined);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.rawDisposals, [child.id], "Only the completed current claimant releases the original native Agent handle");
    assert.equal(f.subscriptionsReleased.filter((id) => id === before.active[0]!.threadId).length, 1);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(Number(f.queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 1);
    assert.equal((await f.manager.applyExternalVerdict(completed.stagedVerdict!.command)).reviewCycles, 1);
  } finally { await f.close(); }
});

test("an old retry finalizer cannot finish or dispose the native child used by the successor's same-thread continuation", { timeout: 30_000 }, async () => {
  const f = await sharedReviewerFixture({ mode: "retained" });
  try {
    const record = await f.start();
    await f.control("fixture/completeActive", { status: "failed" });
    await sharedWaitFor(async () => {
      const stats = await f.control("fixture/stats");
      return stats.active.length === 1 && stats.turnStartRequests.length === 2 && stats;
    }, "the original Reviewer's one automatic continuation");
    await f.control("fixture/completeActive", { status: "failed" });
    await f.retryCommitted.entered;
    const original = await f.store.load(record.id);
    assert.ok(original?.submissionId);
    assert.equal(original.submissionState, "retrying");
    assert.equal(f.dispatcher.availableContinuation(record.id), true);
    assert.ok(original.submissionLeaseToken);
    assert.ok(original.submissionLeaseEpoch !== undefined);
    assert.ok(original.submissionRetryAt !== undefined);
    const child = f.runtime.codexChildSessions.get(record.id);
    assert.ok(child);
    await sharedWaitFor(() => Date.now() >= original.submissionRetryAt!, "the actual persisted callback recovery due time");
    const resource = `submission:${record.id}:${original.submissionId}`;
    assert.equal(f.store.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true);
    const aTasks = new Set(f.runtime.backgroundTasks);
    assert.equal(await f.manager.recoverCallbacks(), 1);
    await f.bSend.entered;
    const bTasks = [...f.runtime.backgroundTasks].filter((task) => !aTasks.has(task));
    const before = await sharedWaitFor(async () => {
      const stats = await f.control("fixture/stats");
      return stats.active.length === 1 && stats.turnStartRequests.length === 3 && stats;
    }, "B's actual original-thread continuation");
    assert.equal(before.threadStarts.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.runtime.codexChildSessions.get(record.id), child);
    assert.equal(f.dispatcher.availableContinuation(record.id), false, "B actually consumed the original retained Reviewer");
    const successor = await f.store.load(record.id);
    assert.ok(successor?.submissionLeaseToken);
    assert.ok(successor.submissionLeaseEpoch !== undefined && successor.submissionLeaseEpoch > original.submissionLeaseEpoch);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
    const historyBefore = child.session.snapshotEvents();
    const rawBefore = f.store.coordinationHandle.loadWorkflow(record.id);
    assert.equal(f.rawDisposals.length, 0);
    f.retryReturn.release();
    await Promise.allSettled([...aTasks]);
    const after = await f.control("fixture/stats");
    assert.deepEqual({ active: after.active, modelRequests: after.turnStartRequests.length,
      threadStarts: after.threadStarts.length, interrupts: after.interrupts.length,
      originalChildStillRegistered: f.runtime.codexChildSessions.get(record.id) === child,
      nativeDisposals: f.rawDisposals.length,
      newNativeTurnEnds: child.session.snapshotEvents().filter((event) => event.type === "turn/end").length
        - historyBefore.filter((event) => event.type === "turn/end").length }, {
      active: before.active, modelRequests: 3, threadStarts: 1, interrupts: 0,
      originalChildStillRegistered: true, nativeDisposals: 0, newNativeTurnEnds: 0,
    }, "The old execution's cleanup cannot acquire the current consumer's original child resource");
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), rawBefore);
    assert.deepEqual(child.session.snapshotEvents(), historyBefore);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
    await f.control("fixture/completeActive", { status: "completed" });
    await Promise.allSettled(bTasks);
    const completed = await f.store.load(record.id);
    assert.ok(completed);
    assert.equal(completed.submissionState, "received", completed.submissionError);
    assert.equal(completed.submissionLeaseToken, undefined);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.rawDisposals, [child.id]);
    assert.equal(f.subscriptionsReleased.filter((id) => id === before.active[0]!.threadId).length, 1);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(Number(f.queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 1);
    assert.equal((await f.manager.applyExternalVerdict(completed.stagedVerdict!.command)).reviewCycles, 1);
  } finally { await f.close(); }
});

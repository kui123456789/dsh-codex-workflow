import assert from "node:assert/strict";
import test from "node:test";
import { bridgeStartReceiptFixture } from "./fixtures/bridge-start-receipt-lifecycle-fixture.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

test("Bridge persistent retry adopts the original pending start receipt without replacing its Reviewer or native child", async () => {
  const f = await bridgeStartReceiptFixture();
  try {
    await f.client.start();
    f.clientPort.options.rpcTimeoutMs = 200;
    const initial = await f.start();
    const original = (await f.stats()).active[0]!;
    const waiting = await f.waitRetry(initial.id);
    await f.drain();
    f.clientPort.options.rpcTimeoutMs = 4000;
    const pending = await f.checkpoint("pending-start");
    assert.equal(waiting.retryState?.awaitingStartReceipt, true);
    assert.equal(waiting.processState, "waiting");
    assert.deepEqual((await f.manager.status(initial.id, f.exec)).continuation, { available: false, reason: "start_receipt_pending" });
    assert.equal(f.children.length, 1); assert.deepEqual(f.rawDisposals, []);
    assert.equal(pending.pin, 1); assert.equal(f.begins, 1); assert.equal(f.ends, 0);
    assert.equal(pending.guards.length, 1);
    const firstStarts = (await f.stats()).turnStartRequests;
    assert.equal(await f.retry(initial.id), 1);
    await f.waitRetry(initial.id); await f.drain();
    assert.deepEqual((await f.stats()).turnStartRequests, firstStarts, "A retry without the real receipt cannot submit another model request");
    assert.deepEqual(f.rawDisposals, []);
    await f.control("fixture/releaseReceipt");
    assert.equal(f.dispatcher.availableContinuation(initial.id), true);
    assert.equal(await f.retry(initial.id), 1);
    await sharedWaitFor(async () => (await f.store.load(initial.id))?.activeTurnId === original.turnId, "original real receipt adoption by the current bridge consumer");
    await f.control("fixture/completeOriginal");
    await f.drain();
    const finished = await f.checkpoint("completed-start");
    const current = finished.row!;
    assert.equal(current.submissionState, "received");
    assert.equal(current.submissionId, waiting.submissionId);
    assert.equal(current.retryState, undefined);
    assert.equal(current.submissionReviewPending, undefined);
    assert.equal(f.dispatcher.hasPendingStartReceipt(initial.id), false);
    assert.equal(f.children.length, 1); assert.deepEqual(f.rawDisposals, [f.children[0]!.id]);
    assert.equal(f.runtime.codexChildSessions.size, 0); assert.equal(finished.pin, 0);
    assert.equal(f.begins, f.ends);
    const final = await f.stats();
    assert.equal(final.turnStartRequests.filter((request) => request.stage === "visible").length, 1);
    assert.equal(final.turnStartRequests.filter((request) => request.stage === "conversion").length, 1);
    assert.ok(final.turnStartRequests.filter((request) => request.stage === "visible" || request.stage === "conversion")
      .every((request) => request.threadId === original.threadId));
    assert.equal(final.unsubscribes.filter((id) => id === original.threadId).length, 1);
    assert.equal(final.writerConflicts, 0);
    assert.ok(final.turnStartRequests.every((request) => !request.originalActive));
    const guard = JSON.parse((finished.guards[0] as { owner: string }).owner);
    assert.equal(guard.confirmed, true);
    assert.ok(current.stagedVerdict);
    const applied = await f.manager.applyExternalVerdict(current.stagedVerdict.command);
    assert.equal(applied.phase, "passed"); assert.equal(applied.reviewCycles, 1);
  } catch (error) { f.fail(); await f.checkpoint("failed-recovery", { error: String(error) }); throw error; }
  finally { await f.close(); }
});

test("Bridge cancellation keeps its durable original-process guard across cold managers until the exact cleanup ACK", async () => {
  const f = await bridgeStartReceiptFixture();
  try {
    await f.client.start(); f.clientPort.options.rpcTimeoutMs = 200;
    const initial = await f.start();
    const waiting = await f.waitRetry(initial.id); await f.drain();
    f.clientPort.options.rpcTimeoutMs = 4000;
    const original = (await f.stats()).active[0]!;
    assert.equal(waiting.retryState?.awaitingStartReceipt, true);
    await f.manager.cancel(initial.id, f.exec);
    const pending = await f.checkpoint("cancel-pending-start");
    assert.equal(pending.row?.phase, "cancelled"); assert.equal(pending.pin, 1);
    assert.deepEqual(f.rawDisposals, []);
    const before = await f.stats();
    await assert.rejects(f.cold.start({ task: "Plan another isolated local diagnostic" }, f.exec), /original terminal cleanup|unconfirmed.*cleanup/i);
    assert.deepEqual((await f.stats()).turnStartRequests, before.turnStartRequests);
    assert.equal(f.children.length, 1);
    // The first cancellation evaluated an unknown receipt. A concurrent
    // cancellation joins that same cleanup flight instead of sending a new
    // interrupt; finish it before testing the later, known original pair.
    await sharedWaitFor(() => (f.dispatcher as unknown as { cleanups: Set<Promise<void>> }).cleanups.size === 0,
      "the original pre-receipt cleanup flight settled");
    const receipt = f.dispatcher.getPendingStartReceipt(initial.id)?.pendingStart.operation;
    assert.ok(receipt);
    await f.control("fixture/releaseReceipt");
    await sharedWaitFor(() => receipt.status() === "ready", "the actual original model start receipt registration");
    await f.manager.cancel(initial.id, f.exec);
    await sharedWaitFor(() => (f.dispatcher as unknown as { cleanups: Set<Promise<void>> }).cleanups.size === 0, "the real failed cleanup ACK");
    const blocked = await f.checkpoint("cancel-failed-ack");
    assert.equal(blocked.pin, 1); assert.deepEqual(f.rawDisposals, []);
    assert.ok((await f.stats()).interrupts.some((entry) => entry.threadId === original.threadId && entry.turnId === original.turnId && entry.mode === "failed"));
    await assert.rejects(f.cold.start({ task: "Plan another isolated local diagnostic" }, f.exec), /original terminal cleanup|unconfirmed.*cleanup/i);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await f.manager.stop();
    const cleaned = await f.checkpoint("cancel-confirmed");
    assert.equal(cleaned.row?.phase, "cancelled"); assert.equal(cleaned.pin, 0);
    assert.deepEqual(f.rawDisposals, [f.children[0]!.id]); assert.equal(f.begins, f.ends);
    assert.equal(f.dispatcher.hasPendingStartReceipt(initial.id), false);
    const final = await f.stats();
    assert.equal(final.turnStartRequests.length, 1); assert.equal(final.threadStarts.length, 1);
    assert.equal(final.unsubscribes.filter((id) => id === original.threadId).length, 1);
    assert.equal(JSON.parse((cleaned.guards[0] as { owner: string }).owner).confirmed, true);
    const next = await f.cold.start({ task: "Plan another isolated local diagnostic" }, f.exec);
    assert.equal(next.phase, "executing", "Confirmed original cleanup allows genuinely new work");
  } catch (error) { f.fail(); await f.checkpoint("failed-cancellation", { error: String(error) }); throw error; }
  finally { await f.close(); }
});

test("Bridge callback observer abort before its real start reply preserves the original durable retry and native child", async () => {
  const f = await bridgeStartReceiptFixture();
  try {
    await f.client.start();
    const initial = await f.start();
    const original = (await f.stats()).active[0]!;
    const submitted = await f.store.load(initial.id);
    assert.ok(submitted?.submissionId);
    const observer = f.runtime.submissionControllers.get(`${initial.id}:${submitted.submissionId}`);
    assert.ok(observer, "Abort only the actual admitted background observer");
    observer.abort(new Error("original callback observer stopped waiting"));
    await f.waitRetry(initial.id); await f.drain();
    const waiting = await f.checkpoint("observer-aborted");
    assert.equal(waiting.row?.retryState?.awaitingStartReceipt, true);
    assert.equal(waiting.row?.processState, "waiting");
    assert.deepEqual((await f.manager.status(initial.id, f.exec)).continuation, { available: false, reason: "start_receipt_pending" });
    assert.equal(waiting.pin, 1); assert.equal(f.children.length, 1); assert.deepEqual(f.rawDisposals, []);
    await f.control("fixture/releaseReceipt");
    assert.equal(await f.retry(initial.id), 1);
    await sharedWaitFor(async () => (await f.store.load(initial.id))?.activeTurnId === original.turnId, "the same callback turn adopted after observer abort");
    await f.control("fixture/completeOriginal"); await f.drain();
    const completed = await f.checkpoint("observer-resumed");
    assert.equal(completed.row?.submissionState, "received");
    assert.equal(completed.row?.submissionId, submitted.submissionId);
    assert.equal(completed.row?.retryState, undefined);
    assert.deepEqual(f.rawDisposals, [f.children[0]!.id]); assert.equal(completed.pin, 0);
    assert.equal(f.begins, f.ends);
    const final = await f.stats();
    assert.equal(final.turnStartRequests.filter((request) => request.stage === "visible").length, 1);
    assert.equal(final.unsubscribes.filter((id) => id === original.threadId).length, 1);
    assert.equal(final.writerConflicts, 0);
  } catch (error) { f.fail(); await f.checkpoint("failed-observer-abort", { error: String(error) }); throw error; }
  finally { await f.close(); }
});

test("Bridge cancellation before the accepted start has any pending capability retains its native child until the original ACK", async () => {
  const f = await bridgeStartReceiptFixture();
  try {
    await f.client.start();
    const initial = await f.start();
    const before = await f.stats();
    const original = before.active[0]!;
    const childId = f.children[0]!.id;
    assert.equal(f.dispatcher.hasPendingStartReceipt(initial.id), false, "The actual model RPC is still waiting for its first receipt");
    assert.equal((await f.wire()).filter((entry) => entry.kind === "original-receipt").length, 0);
    await f.manager.cancel(initial.id, f.exec); await f.drain();
    const cancelled = await f.checkpoint("direct-cancel-before-receipt");
    assert.equal(cancelled.row?.phase, "cancelled");
    assert.equal(cancelled.pin, 1); assert.equal(f.begins, 1); assert.equal(f.ends, 0);
    assert.deepEqual(f.rawDisposals, [], "The receipt producer still owns the existing native child");
    assert.equal(f.runtime.codexChildSessions.get(initial.id)?.id, childId);
    assert.equal(f.dispatcher.hasPendingStartReceipt(initial.id), true);
    assert.deepEqual((await f.stats()).turnStartRequests, before.turnStartRequests);
    await f.control("fixture/releaseReceipt");
    await f.manager.cancel(initial.id, f.exec);
    await sharedWaitFor(() => (f.dispatcher as unknown as { cleanups: Set<Promise<void>> }).cleanups.size === 0, "direct cancel's original failed interruption ACK");
    const failedAck = await f.checkpoint("direct-cancel-failed-ack");
    assert.equal(failedAck.pin, 1); assert.deepEqual(f.rawDisposals, []);
    assert.equal(f.runtime.codexChildSessions.get(initial.id)?.id, childId);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" }); await f.manager.stop();
    const finished = await f.checkpoint("direct-cancel-confirmed");
    assert.equal(finished.row?.phase, "cancelled"); assert.equal(finished.row?.retryState, undefined);
    assert.equal(finished.pin, 0); assert.equal(f.begins, f.ends);
    assert.deepEqual(f.rawDisposals, [childId]); assert.equal(f.runtime.codexChildSessions.size, 0);
    const final = await f.stats();
    assert.equal(final.threadStarts.length, 1); assert.equal(final.turnStartRequests.length, 1);
    assert.equal(final.unsubscribes.filter((id) => id === original.threadId).length, 1);
    assert.equal(final.writerConflicts, 0);
  } catch (error) { f.fail(); await f.checkpoint("failed-direct-cancellation", { error: String(error) }); throw error; }
  finally { await f.close(); }
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bridgeStartReceiptFixture } from "./fixtures/bridge-start-receipt-lifecycle-fixture.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

test("successive Bridge start receipts transfer the confirmed guard generation on the same Reviewer", async () => {
  const f = await bridgeStartReceiptFixture();
  f.clientPort.options.args = [fileURLToPath(new URL("./fixtures/fake-bridge-start-receipt-generation.mjs", import.meta.url)),
    join(f.evidenceDirectory, "wire.jsonl")];
  let primaryError: unknown;
  try {
    await f.client.start(); f.clientPort.options.rpcTimeoutMs = 200;
    const initial = await f.start();
    await f.waitRetry(initial.id); await f.drain();
    const first = await f.checkpoint("first-stage-pending");
    const original = (await f.stats()).active[0]!;
    const firstReceipt = f.dispatcher.getPendingStartReceipt(initial.id);
    assert.ok(firstReceipt);
    assert.equal(firstReceipt.pendingStart.operation.finished(), false);
    assert.equal(first.guards.length, 1);
    const firstGuard = first.guards[0] as { owner: string; epoch: number };
    const firstToken = JSON.parse(firstGuard.owner).token;
    await f.control("fixture/releaseReceipt", { stage: "visible" });
    await f.control("fixture/completeOriginal", { stage: "visible" });
    assert.equal(firstReceipt.pendingStart.operation.finished(), true, "The original completed pair proves its own guard may retire");
    assert.equal(await f.retry(initial.id), 1);
    await sharedWaitFor(async () => (await f.stats()).turnStartRequests.some((request) => request.stage === "conversion"),
      "the original Reviewer's next conversion actually submitted");
    const background = await Promise.allSettled([...f.runtime.backgroundTasks]);
    await f.drain();
    const second = await f.checkpoint("second-stage-pending", { backgroundErrors: background.flatMap((result) =>
      result.status === "rejected" ? [{ name: result.reason?.name, message: String(result.reason?.message ?? result.reason) }] : []) });
    const secondReceipt = f.dispatcher.getPendingStartReceipt(initial.id);
    assert.ok(secondReceipt);
    assert.notEqual(secondReceipt.pendingStart.operation, firstReceipt.pendingStart.operation,
      "The second original model operation is a distinct receipt capability on the same Reviewer");
    assert.equal(secondReceipt.pendingStart.operation.finished(), false);
    assert.equal(second.guards.length, 1);
    const secondGuard = second.guards[0] as { owner: string; epoch: number };
    assert.ok(secondGuard.epoch > firstGuard.epoch, "A completed receipt's guard transfers to the new pending operation without an owner collision");
    assert.notEqual(JSON.parse(secondGuard.owner).token, firstToken);
    assert.equal(JSON.parse(secondGuard.owner).confirmed, undefined);
    assert.equal(second.row?.retryState?.terminalCleanup?.epoch, secondGuard.epoch);
    assert.equal(second.row?.retryState?.awaitingStartReceipt, true);
    assert.equal(second.row?.processState, "waiting");
    assert.deepEqual(second.children, first.children); assert.deepEqual(second.disposals, []);
    assert.equal(second.pin, 1); assert.equal(f.ends, 0);
    assert.equal(f.runtime.submissionControllers.size, 0, "The waiting observer releases its admitted task and lease normally");
    await f.control("fixture/releaseReceipt", { stage: "conversion" });
    await f.control("fixture/completeOriginal", { stage: "conversion" });
    f.clientPort.options.rpcTimeoutMs = 4000;
    assert.equal(await f.retry(initial.id), 1); await f.drain();
    const completed = await f.checkpoint("successive-stages-completed");
    assert.equal(completed.row?.submissionState, "received");
    assert.equal(completed.row?.submissionId, first.row?.submissionId);
    assert.equal(completed.row?.retryState, undefined);
    assert.ok(completed.row?.stagedVerdict);
    assert.equal(f.dispatcher.hasPendingStartReceipt(initial.id), false);
    assert.equal(completed.pin, 0); assert.deepEqual(completed.disposals, first.children);
    assert.deepEqual(completed.children, first.children);
    assert.equal(f.begins, f.ends, "Every original and private seed pin is released exactly once");
    assert.equal(JSON.parse((completed.guards[0] as { owner: string }).owner).confirmed, true);
    const final = await f.stats();
    assert.equal(final.turnStartRequests.filter((request) => request.stage === "visible").length, 1);
    assert.equal(final.turnStartRequests.filter((request) => request.stage === "conversion").length, 1);
    assert.ok(final.turnStartRequests.filter((request) => request.stage === "visible" || request.stage === "conversion")
      .every((request) => request.threadId === original.threadId && !request.originalActive));
    assert.equal(final.unsubscribes.filter((id) => id === original.threadId).length, 1);
    assert.equal(final.writerConflicts, 0);
    assert.deepEqual(final.active, []);
    const applied = await f.manager.applyExternalVerdict(completed.row!.stagedVerdict!.command);
    assert.equal(applied.phase, "passed"); assert.equal(applied.reviewCycles, 1);
  } catch (error) {
    primaryError = error; f.fail(); await f.checkpoint("failed-successive-generation", { error: String(error) });
  } finally {
    try { await f.close(); } catch (error) { primaryError ??= error; }
  }
  if (primaryError) throw primaryError;
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerLiveEvent } from "../src/app-server.js";
import { sharedGate, sharedReviewerFixture } from "./fixtures/bridge-shared-reviewer-fixture.js";

const visibleReview = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: CURRENT-CONSUMER-REVIEW verified original requirements.";

async function takeover(f: Awaited<ReturnType<typeof sharedReviewerFixture>>, workflowId: string) {
  const original = await f.step("takeover original workflow", () => f.store.load(workflowId));
  assert.ok(original?.submissionId);
  assert.ok(original.submissionLeaseToken);
  assert.ok(original.submissionLeaseEpoch !== undefined);
  const resource = `submission:${workflowId}:${original.submissionId}`;
  assert.equal(f.store.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true);
  await f.step("takeover lease loss observation", () => f.lossSeen.entered);
  assert.equal(await f.step("takeover callback recovery", () => f.manager.recoverCallbacks()), 1);
  await f.step("takeover original Reviewer adoption", () => f.bSend.entered);
  const successor = await f.step("takeover successor workflow", () => f.store.load(workflowId));
  assert.ok(successor?.submissionLeaseToken);
  assert.ok(successor.submissionLeaseEpoch !== undefined && successor.submissionLeaseEpoch > original.submissionLeaseEpoch);
  assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
  assert.equal(successor.processState, "running");
  return { original, successor, resource };
}

test("shared Reviewer notifications follow the adopted consumer and original native child", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  try {
    const record = await f.step("original Reviewer startup", () => f.start());
    const originalStats = await f.control("fixture/stats");
    const originalActive = originalStats.active[0];
    assert.ok(originalActive);
    const originalThread = originalActive.threadId;
    const child = f.runtime.codexChildSessions.get(record.id);
    assert.ok(child);
    const native = f.children[0];
    assert.ok(native);
    assert.equal(native.id, child.id);
    const nativeProgress: AppServerLiveEvent[] = [];
    const originalProgress = child.progress.bind(child);
    child.progress = (entry) => { nativeProgress.push(entry); originalProgress(entry); };
    const { successor, resource } = await takeover(f, record.id);
    const marker = "ADOPTED-CONSUMER-NATIVE-DELTA";
    await f.control("fixture/emitMessage", { threadId: originalThread, text: marker });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const received = nativeProgress.filter((entry) => entry.kind === "message" && entry.text.includes(marker));
    assert.equal(received.length, 1, "The actual SDK notification must reach the current consumer's original native child once");
    assert.equal(f.runtime.codexChildSessions.get(record.id), child);
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(f.children.length, 1);
    const active = await f.control("fixture/stats");
    assert.deepEqual(active.active, originalStats.active);
    assert.equal(active.visibleTurns, 1);
    assert.equal(active.threadStarts.length, 1);
    assert.equal(active.interrupts.length, 0);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch!, successor.submissionLeaseToken!), true);
    f.lossRelease.release();
    await f.step("original lease loss forwarding", () => f.lossForwarded.entered);
    await f.control("fixture/completeActive", { text: visibleReview });
    await f.step("original callbacks settlement", () => Promise.allSettled([...f.runtime.backgroundTasks]));
    const completed = await f.store.load(record.id);
    assert.equal(completed?.submissionState, "received");
    assert.ok(JSON.stringify(native.snapshotEvents()).includes("CURRENT-CONSUMER-REVIEW"),
      "Current visible-review hooks preserve the actual readable result in the original native history");
    assert.deepEqual(f.rawDisposals, [child.id]);
    assert.equal(f.subscriptionsReleased.filter((id) => id === originalThread).length, 1);
    assert.equal((await f.control("fixture/stats")).visibleTurns, 1);
    assert.equal((await f.manager.applyExternalVerdict(completed!.stagedVerdict!.command)).reviewCycles, 1);
  } finally { await f.close(); }
});

test("a shared Reviewer's display rewrite binds its original turn to the current consumer", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal, task: "只读核验原配置诊断要求", planMarkdown: "<proposed_plan>\n只读验证已批准的配置范围。\n</proposed_plan>" });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  const originalTurn = f.client.startTurn.bind(f.client);
  const rewriteStarted = sharedGate();
  let rewriteError: unknown;
  try {
    const record = await f.step("original Reviewer startup", () => f.start());
    const originalStats = await f.control("fixture/stats");
    const originalActive = originalStats.active[0];
    assert.ok(originalActive);
    const originalThread = originalActive.threadId;
    const child = f.runtime.codexChildSessions.get(record.id);
    assert.ok(child);
    const native = f.children[0];
    assert.ok(native);
    assert.equal(native.id, child.id);
    await f.control("fixture/setActiveVisibleTurns", { count: 2 });
    f.client.startTurn = (threadId, options, signal) => originalTurn(threadId, options.outputSchema ? options : {
      ...options, onStarted: async (started) => {
        try { await options.onStarted?.(started); }
        catch (error) { rewriteError = error; throw error; }
        finally { rewriteStarted.enter(); }
      },
    }, signal);
    const { successor, resource } = await takeover(f, record.id);
    await f.control("fixture/completeActive", { text: visibleReview });
    await f.step("original display rewrite", () => rewriteStarted.entered);
    assert.equal(rewriteError, undefined, "The rewrite uses B's valid callback hooks instead of stale A lease writes");
    const rewrite = await f.control("fixture/stats");
    const rewriteActive = rewrite.active[0];
    assert.ok(rewriteActive);
    assert.equal(rewrite.visibleTurns, 2);
    assert.equal(rewrite.active[0]?.threadId, originalThread);
    assert.equal(rewrite.threadStarts.length, 1);
    assert.equal(rewrite.interrupts.length, 0);
    assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch!, successor.submissionLeaseToken!), true);
    assert.equal(f.runtime.codexChildSessions.get(record.id), child);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 0);
    const current = await f.store.load(record.id);
    assert.equal(current?.reviewerTurnId, rewriteActive.turnId);
    assert.equal(native.snapshotEvents().filter((event) => event.type === "turn/start").length, 2,
      "The display rewrite appends to the same native conversation");
    f.lossRelease.release();
    await f.step("original lease loss forwarding", () => f.lossForwarded.entered);
    await f.control("fixture/completeActive", { text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 已验证原批准要求。" });
    await f.step("original callbacks settlement", () => Promise.allSettled([...f.runtime.backgroundTasks]));
    const completed = await f.store.load(record.id);
    assert.equal(completed?.submissionState, "received");
    assert.deepEqual(f.rawDisposals, [child.id]);
    assert.equal(f.subscriptionsReleased.filter((id) => id === originalThread).length, 1);
    assert.equal((await f.control("fixture/stats")).visibleTurns, 2);
    assert.equal((await f.manager.applyExternalVerdict(completed!.stagedVerdict!.command)).reviewCycles, 1);
  } finally { f.client.startTurn = originalTurn; await f.close(); }
});

for (const action of ["cancel", "stop"] as const) {
  test(`explicit ${action} cleans the adopted shared Reviewer and original child once`, { timeout: 90_000 }, async (t) => {
    const f = await sharedReviewerFixture({ signal: t.signal });
    t.after(async () => {
      if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
      await f.close();
    });
    try {
      const record = await f.step("original Reviewer startup", () => f.start());
      const original = await f.control("fixture/stats");
      const active = original.active[0];
      assert.ok(active);
      const child = f.runtime.codexChildSessions.get(record.id);
      assert.ok(child);
      await takeover(f, record.id);
      f.lossRelease.release();
      await f.step("original lease loss forwarding", () => f.lossForwarded.entered);
      if (action === "cancel") await f.step("original Reviewer cancellation", () => f.manager.cancel(record.id, f.exec));
      else await f.step("original Reviewer stop", () => f.manager.stop());
      await f.step("original callbacks settlement", () => Promise.allSettled([...f.runtime.backgroundTasks]));
      const stopped = await f.control("fixture/stats");
      assert.equal(stopped.active.length, 0, "Explicit global authority interrupts the actual shared model writer");
      assert.equal(stopped.visibleTurns, 1);
      assert.equal(stopped.threadStarts.length, 1);
      assert.equal(f.runtime.codexChildSessions.size, 0);
      assert.equal(f.runtime.reviewHeartbeats.size, 0);
      assert.deepEqual(f.rawDisposals, [child.id]);
      assert.equal(f.subscriptionsReleased.filter((id) => id === active.threadId).length, 1);
      const current = await f.store.load(record.id);
      assert.equal(current?.reviewCycles, 0);
      assert.equal(current?.stagedVerdict, undefined);
      if (action === "cancel") assert.equal(current?.phase, "cancelled");
    } finally { await f.close(); }
  });
}

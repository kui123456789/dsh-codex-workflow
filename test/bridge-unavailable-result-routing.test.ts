import assert from "node:assert/strict";
import test from "node:test";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

async function lostCompletedResult(f: Awaited<ReturnType<typeof sharedReviewerFixture>>) {
  const record = await f.start();
  const original = await f.control("fixture/stats");
  const originalThread = original.active[0]?.threadId;
  assert.ok(originalThread);
  await f.control("fixture/setHeldSchema", { property: "aligned" });
  await f.control("fixture/completeActive", { status: "completed" });
  const alignment = await sharedWaitFor(async () => {
    const stats = await f.control("fixture/stats");
    const active = stats.active.find((turn) => turn.threadId !== originalThread);
    return active && f.runtime.submissionReviewResults.has(record.id) && active;
  }, "the actual private authority RPC after readable review and conversion completed");
  await f.control("fixture/completeActive", { threadId: alignment.threadId, status: "failed" });
  await f.retryCommitted.entered;
  f.retryReturn.release();
  await Promise.allSettled([...f.runtime.backgroundTasks]);
  const waiting = await f.store.load(record.id);
  assert.ok(waiting);
  assert.equal(waiting.submissionState, "retrying");
  assert.equal(waiting.submissionReviewPending, true);
  assert.ok(f.runtime.submissionReviewResults.get(record.id)?.verdict);
  assert.equal(f.children.length, 1);
  assert.equal(f.rawDisposals.length, 0);
  const completedModels = await f.control("fixture/stats");
  assert.equal(completedModels.visibleTurns, 1, "The readable review has genuinely completed once");
  assert.equal(completedModels.turnStartRequests.length, 3, "Readable review, conversion and one actual failed authority RPC");
  // Model work and durable pending state are genuine. Remove only the
  // process-local result to simulate loss; no failure code is fabricated.
  f.runtime.submissionReviewResults.clear();
  await f.control("fixture/setHeldSchema", { property: "" });
  await sharedWaitFor(() => Date.now() >= (waiting.submissionRetryAt ?? 0), "the real pending-result recovery due time");
  assert.equal(await f.manager.recoverCallbacks(), 1);
  await Promise.allSettled([...f.runtime.backgroundTasks]);
  const failed = await f.store.load(record.id);
  assert.ok(failed);
  assert.equal(failed.submissionState, "failed");
  assert.match(failed.submissionError ?? "", /completed Reviewer result is unavailable/);
  assert.equal(failed.stagedVerdict, undefined);
  assert.equal(failed.reviewCycles, 0);
  const stopped = await f.control("fixture/stats");
  assert.deepEqual(stopped.turnStartRequests, completedModels.turnStartRequests, "Actual missing-result recovery does not repeat the completed review");
  assert.deepEqual(stopped.threadStarts, completedModels.threadStarts);
  assert.equal(f.rawDisposals.length, 1);
  return { record, failed, stopped };
}

test("a lost completed original review reports handle_unavailable without implementation or automatic-repeat guidance", { timeout: 30_000 }, async () => {
  const f = await sharedReviewerFixture({ mode: "retained" });
  const steers: string[] = [];
  f.parent.steer = (message: UserMessage) => {
    steers.push(message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"));
  };
  try {
    const { record, stopped } = await lostCompletedResult(f);
    const status = await f.manager.status(undefined, f.exec);
    await f.manager.onTurnStopping(f.parent, 8);
    const after = await f.control("fixture/stats");
    assert.deepEqual(after.turnStartRequests, stopped.turnStartRequests);
    assert.deepEqual(after.threadStarts, stopped.threadStarts);
    assert.equal(status.id, record.id);
    assert.deepEqual(status.continuation, { available: false, reason: "handle_unavailable" });
    assert.equal(steers.length, 1);
    assert.match(steers[0]!, /completed|已完成|结果|result/i);
    assert.match(steers[0]!, /user|用户|explicit|明确/i);
    assert.doesNotMatch(steers[0]!, /finish implementing the approved plan|run tests, then call codex_workflow_submit/i);
  } finally { await f.close(); }
});

test("the missing completed result cannot be bypassed by submitting unchanged evidence as another default review", { timeout: 30_000 }, async () => {
  const f = await sharedReviewerFixture({ mode: "retained" });
  try {
    const { record, failed, stopped } = await lostCompletedResult(f);
    const before = f.store.coordinationHandle.loadWorkflow(record.id);
    const queue = f.queue.coordinationHandle.db.prepare("SELECT * FROM queue ORDER BY request_id").all();
    const history = f.parent.session.snapshotEvents();
    const result = (await Promise.allSettled([f.manager.submit(record.id, {
      implementationSummary: "Local diagnostic implemented", changedFiles: ["changed.txt"],
    }, f.exec)]))[0]!;
    if (result.status === "fulfilled") {
      await sharedWaitFor(async () => {
        const stats = await f.control("fixture/stats");
        return stats.active.length === 1 && stats.visibleTurns === stopped.visibleTurns + 1;
      }, "the incorrectly admitted replacement model before fixture completion");
    }
    await f.control("fixture/completeActive", { status: "completed" });
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const after = await f.control("fixture/stats");
    assert.equal(result.status, "rejected", "A lost validated result cannot justify repeating the readable review");
    assert.deepEqual(after.turnStartRequests, stopped.turnStartRequests);
    assert.deepEqual(after.threadStarts, stopped.threadStarts);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), before);
    assert.deepEqual(await f.store.load(record.id), failed);
    assert.deepEqual(f.queue.coordinationHandle.db.prepare("SELECT * FROM queue ORDER BY request_id").all(), queue);
    assert.deepEqual(f.parent.session.snapshotEvents(), history);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 1);
  } finally { await f.close(); }
});

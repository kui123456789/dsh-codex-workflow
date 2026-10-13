import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sharedReviewerFixture, unavailableSharedReviewer } from "./fixtures/bridge-shared-reviewer-fixture.js";

test("an explicit new business round may review unchanged evidence without masquerading as original continuation", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  try {
    const { record, failed, stopped } = await unavailableSharedReviewer(f);
    const oldHistory = f.children[0]?.snapshotEvents();
    assert.ok(oldHistory);
    const submitted = await f.manager.submit(record.id, {
      implementationSummary: "The user explicitly requested a new independent review of this same version",
      changedFiles: ["changed.txt"], newReviewRound: true,
    }, f.exec);
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const completed = await f.store.load(record.id);
    assert.ok(completed);
    assert.equal(completed.id, failed.id);
    assert.equal(completed.task, failed.task);
    assert.equal(completed.planMarkdown, failed.planMarkdown);
    assert.notEqual(submitted.submissionId, failed.submissionId);
    assert.equal(completed.latestReviewEvidence?.fingerprint, failed.latestReviewEvidence?.fingerprint,
      "The explicit new-round request is the authority; no workspace change is fabricated");
    assert.equal(completed.submissionState, "received", completed.submissionError);
    assert.equal(completed.pendingReviewRequest?.implementationSummary,
      "The user explicitly requested a new independent review of this same version");
    assert.equal(Object.hasOwn(completed.pendingReviewRequest ?? {}, "newReviewRound"), false,
      "Admission controls are not persisted as review material or sent as implementation facts");
    assert.notEqual(completed.submissionCallbackReason, "original_reviewer_unavailable");
    assert.deepEqual(f.children[0]?.snapshotEvents(), oldHistory, "A new review preserves the retired original child history");
    assert.equal(f.children.length, 2);
    assert.equal(f.rawDisposals.length, 2);
    const after = await f.control("fixture/stats");
    assert.equal(after.visibleTurns, stopped.visibleTurns + 1);
    assert.equal(after.threadStarts.length, stopped.threadStarts.length + 2);
    assert.equal(f.sends.at(-1)?.request.prompt.includes("newReviewRound"), false);
    assert.equal((await f.manager.applyExternalVerdict(completed.stagedVerdict!.command)).reviewCycles, 1);
  } finally { await f.close(); }
});

test("summary and test-result wording cannot opt an unavailable original into another unchanged review", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  try {
    const { record, failed, stopped } = await unavailableSharedReviewer(f);
    const before = f.store.coordinationHandle.loadWorkflow(record.id);
    const queue = f.queue.coordinationHandle.db.prepare("SELECT * FROM queue ORDER BY request_id").all();
    const events = f.parent.session.snapshotEvents();
    await assert.rejects(f.manager.submit(record.id, {
      implementationSummary: "A different summary claims this is a new review, but the observed files are unchanged",
      changedFiles: ["changed.txt"], testResults: "Tests were described again", newReviewRound: false,
    }, f.exec), /original|unavailable|new.*round|unchanged|不可恢复|新.*轮|未变化/i);
    const after = await f.control("fixture/stats");
    assert.deepEqual(after.threadStarts, stopped.threadStarts);
    assert.equal(after.turnStartRequests.length, stopped.turnStartRequests.length);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), before);
    assert.deepEqual(await f.store.load(record.id), failed);
    assert.deepEqual(f.queue.coordinationHandle.db.prepare("SELECT * FROM queue ORDER BY request_id").all(), queue);
    assert.deepEqual(f.parent.session.snapshotEvents(), events);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 1);
  } finally { await f.close(); }
});

test("switching the declared file scope cannot disguise unchanged original workspace evidence as recovery", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  try {
    await writeFile(join(f.directory, "already-existing.txt"), "This stable file existed before the original review", "utf8");
    const { record, failed, stopped } = await unavailableSharedReviewer(f);
    const before = f.store.coordinationHandle.loadWorkflow(record.id);
    const result = (await Promise.allSettled([f.manager.submit(record.id, {
      implementationSummary: "Same approved implementation with a different file list", changedFiles: ["already-existing.txt"],
    }, f.exec)]))[0]!;
    await f.control("fixture/completeActive");
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const after = await f.control("fixture/stats");
    assert.equal(result.status, "rejected", "A different evidence selection alone is not an actual change to the original approved review scope");
    assert.deepEqual(after.threadStarts, stopped.threadStarts);
    assert.equal(after.turnStartRequests.length, stopped.turnStartRequests.length);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), before);
    assert.deepEqual(await f.store.load(record.id), failed);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 1);
  } finally { await f.close(); }
});

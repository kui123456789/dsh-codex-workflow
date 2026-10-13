import assert from "node:assert/strict";
import test from "node:test";
import { newRequestId } from "../src/bridge-protocol.js";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

async function submitWithProtocolFailure(f: Awaited<ReturnType<typeof sharedReviewerFixture>>, target: "Thread" | "Turn") {
  await f.control(`fixture/setNext${target}Error`, { message: "403 Forbidden: fixture diagnostic read permission denied" });
  const record = await f.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: f.directory, dshSessionId: f.parent.id },
    task: "Inspect approved diagnostics read-only", planMarkdown: "<proposed_plan>\nCheck the current diagnostic.\n</proposed_plan>", assumptions: [] }, f.parent);
  await f.manager.submit(record.id, { implementationSummary: "Local diagnostic implemented", changedFiles: ["changed.txt"] }, f.exec);
  await Promise.allSettled([...f.runtime.backgroundTasks]);
  const failed = await f.store.load(record.id);
  assert.ok(failed);
  assert.equal(failed.submissionState, "failed");
  assert.match(failed.submissionError ?? "", /403 Forbidden/);
  assert.equal(failed.stagedVerdict, undefined);
  const stats = await f.control("fixture/stats");
  assert.equal(f.rawDisposals.length, 1);
  return { record, failed, stats };
}

test("a terminal permission failure after actual Reviewer registration cannot induce an unchanged replacement", { timeout: 30_000 }, async () => {
  const f = await sharedReviewerFixture();
  const steers: string[] = [];
  f.parent.steer = (message) => { steers.push(message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")); };
  try {
    const { record, failed, stats } = await submitWithProtocolFailure(f, "Turn");
    assert.equal(stats.threadStarts.length, 1, "The original thread was actually registered before its model RPC failed");
    assert.equal(stats.turnStartRequests.length, 1);
    assert.equal(failed.reviewerThreadOrigin, "app-server-ephemeral");
    const before = f.store.coordinationHandle.loadWorkflow(record.id);
    const status = await f.manager.status(undefined, f.exec);
    await f.manager.onTurnStopping(f.parent, 10);
    const submission = (await Promise.allSettled([f.manager.submit(record.id, {
      implementationSummary: "Local diagnostic implemented", changedFiles: ["changed.txt"],
    }, f.exec)]))[0]!;
    if (submission.status === "fulfilled") await sharedWaitFor(async () => (await f.control("fixture/stats")).active.length === 1,
      "the incorrectly admitted replacement model");
    await f.control("fixture/completeActive");
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const after = await f.control("fixture/stats");
    assert.deepEqual({ reason: status.continuation.reason, outcome: submission.status,
      modelRequests: after.turnStartRequests.length, threadStarts: after.threadStarts.length, children: f.children.length }, {
      reason: "thread_unavailable", outcome: "rejected", modelRequests: 1, threadStarts: 1, children: 1,
    });
    assert.equal(steers.length, 1);
    assert.match(steers[0]!, /unavailable|不可恢复/);
    assert.doesNotMatch(steers[0]!, /finish implementing the approved plan|run tests, then call codex_workflow_submit/i);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), before);
    assert.equal(failed.reviewCycles, 0);
  } finally { await f.close(); }
});

test("a permission failure before any Reviewer exists can retry the first real business review", { timeout: 90_000 }, async () => {
  const f = await sharedReviewerFixture();
  try {
    const { record, failed, stats } = await submitWithProtocolFailure(f, "Thread");
    assert.deepEqual(stats.threadStarts, []);
    assert.deepEqual(stats.turnStartRequests, []);
    assert.equal(failed.reviewerThreadOrigin, undefined);
    assert.notEqual(failed.submissionCallbackReason, "original_reviewer_unavailable");
    const submitted = await f.manager.submit(record.id, { implementationSummary: "Original startup issue corrected",
      changedFiles: ["changed.txt"] }, f.exec);
    await sharedWaitFor(async () => (await f.control("fixture/stats")).active.length === 1, "the first actual Reviewer after corrected startup");
    await f.control("fixture/completeActive");
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const completed = await f.store.load(record.id);
    assert.ok(completed);
    assert.notEqual(submitted.submissionId, failed.submissionId);
    assert.equal(completed.latestReviewEvidence?.fingerprint, failed.latestReviewEvidence?.fingerprint);
    assert.equal(completed.submissionState, "received", completed.submissionError);
    assert.equal((await f.control("fixture/stats")).visibleTurns, 1);
    assert.equal((await f.manager.applyExternalVerdict(completed.stagedVerdict!.command)).reviewCycles, 1);
  } finally { await f.close(); }
});

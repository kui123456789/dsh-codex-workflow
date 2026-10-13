import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { BridgeRuntime } from "../src/bridge-runtime.js";
import { sharedReviewerFixture, unavailableSharedReviewer } from "./fixtures/bridge-shared-reviewer-fixture.js";

const text = (message: UserMessage) => message.content.filter((block) => block.type === "text")
  .map((block) => block.type === "text" ? block.text : "").join("\n");

function assertUnavailableInstructions(message: string) {
  assert.match(message, /unavailable|retired|不可恢复|无法.*继续|丢失|lost/i,
    "The parent must receive the original resource's actual unavailable boundary");
  assert.match(message, /user|用户|choose|choice|选择|explicit.*new|明确.*新/i,
    "An unavailable original review waits for the caller's choice of a genuine new round");
  assert.doesNotMatch(message, /finish implementing the approved plan|finish the fixes|run tests, then call codex_workflow_submit|修复环境或任务问题后重新提交/i,
    "Unrecoverable model context cannot become an automatic implementation or resubmission instruction");
}

test("a retired original Bridge Reviewer reports thread_unavailable and relays an explicit choice instead of automatic resubmission", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  const steers: string[] = [];
  const followups: string[] = [];
  const parent = f.parent as Agent & { steer: (message: UserMessage) => void; followup: (message: UserMessage) => void };
  parent.steer = (message) => { steers.push(text(message)); };
  parent.followup = (message) => {
    followups.push(text(message));
    parent.session.append("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message] });
  };
  const runtime = new BridgeRuntime(f.queue, { get: (id) => id === parent.id ? parent : undefined, list: () => [parent] }, {
    pollMs: 5, storageDir: f.directory, manager: f.manager, workflowStore: f.store,
  });
  try {
    const { record, failed, stopped } = await unavailableSharedReviewer(f);
    const status = await f.manager.status(undefined, f.exec);
    await f.manager.onTurnStopping(parent, 7);
    assert.ok(failed.submissionNotice);
    await runtime.refreshSessions(true);
    await runtime.pump();
    const receipt = await f.queue.receipt(failed.submissionNotice.command.requestId);
    assert.equal(receipt?.status, "delivered", "The actual SQL notice is delivered to the original native parent");
    assert.equal(steers.length, 1);
    assert.equal(followups.length, 1);
    const after = await f.control("fixture/stats");
    assert.equal(after.turnStartRequests.length, stopped.turnStartRequests.length);
    assert.deepEqual(after.threadStarts, stopped.threadStarts);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 1);
    assert.equal(status.id, record.id);
    assert.deepEqual(status.continuation, { available: false, reason: "thread_unavailable" },
      "Status must distinguish unavailable original resources from an ordinary non-waiting workflow");
    assertUnavailableInstructions(steers[0]!);
    assertUnavailableInstructions(followups[0]!);
  } finally { await runtime.stop(); await f.close(); }
});

test("unavailable original Bridge recovery refuses an unchanged submission without changing durable state or model resources", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  try {
    const { record, failed, stopped } = await unavailableSharedReviewer(f);
    const durableBefore = f.store.coordinationHandle.loadWorkflow(record.id);
    const queueBefore = f.queue.coordinationHandle.db.prepare("SELECT * FROM queue ORDER BY request_id").all();
    const eventsBefore = f.parent.session.snapshotEvents();
    const callbackCount = f.sends.length;
    const result = (await Promise.allSettled([f.manager.submit(record.id, {
      implementationSummary: "Local diagnostic implemented", changedFiles: ["changed.txt"],
    }, f.exec)]))[0]!;
    // Complete local fixtures if the old implementation incorrectly dispatched
    // another review; the assertions below still require zero new resources.
    await f.control("fixture/completeActive", { status: "completed" });
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const after = await f.control("fixture/stats");
    const current = await f.store.load(record.id);
    assert.deepEqual({ submission: result.status, additionalModelRequests: after.turnStartRequests.length - stopped.turnStartRequests.length,
      additionalThreads: after.threadStarts.length - stopped.threadStarts.length, children: f.children.length,
      sameSubmission: current?.submissionId === failed.submissionId }, {
      submission: "rejected", additionalModelRequests: 0, additionalThreads: 0, children: 1, sameSubmission: true,
    }, "A fault-recovery instruction cannot silently become a fresh Reviewer for the exact same approved scope and evidence");
    assert.equal(result.status, "rejected");
    assert.match(String(result.reason), /original|unavailable|new.*round|unchanged|不可恢复|新.*轮|未变化/i);
    assert.deepEqual(current, failed);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), durableBefore);
    assert.deepEqual(f.queue.coordinationHandle.db.prepare("SELECT * FROM queue ORDER BY request_id").all(), queueBefore);
    assert.deepEqual(f.parent.session.snapshotEvents(), eventsBefore);
    assert.equal(f.sends.length, callbackCount);
    assert.equal(f.rawDisposals.length, 1);
  } finally { await f.close(); }
});

test("a real workspace change in the original approved context admits a new Bridge review round after original resources are unavailable", { timeout: 30_000 }, async (t) => {
  const f = await sharedReviewerFixture({ signal: t.signal });
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(`Original fixture phase: ${f.phase}`);
    await f.close();
  });
  try {
    const { record, failed, stopped } = await unavailableSharedReviewer(f);
    const originalFingerprint = failed.latestReviewEvidence?.fingerprint;
    assert.ok(originalFingerprint);
    await writeFile(join(f.directory, "changed.txt"), "v2 actually changed diagnostic implementation", "utf8");
    const submitted = await f.manager.submit(record.id, { implementationSummary: "Actual v2 diagnostic changed", changedFiles: ["changed.txt"] }, f.exec);
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const completed = await f.store.load(record.id);
    assert.ok(completed);
    assert.equal(completed.id, failed.id);
    assert.equal(completed.task, failed.task);
    assert.equal(completed.planMarkdown, failed.planMarkdown);
    assert.equal(completed.cwd, failed.cwd);
    assert.notEqual(submitted.submissionId, failed.submissionId);
    assert.notEqual(completed.latestReviewEvidence?.fingerprint, originalFingerprint);
    assert.equal(completed.submissionState, "received", completed.submissionError);
    const after = await f.control("fixture/stats");
    assert.equal(after.visibleTurns, stopped.visibleTurns + 1, "A changed business scope gets one new readable review");
    assert.equal(after.threadStarts.length, stopped.threadStarts.length + 2, "The new Reviewer and its private authority seed are both explicit new-round work");
    assert.equal(f.children.length, 2);
    assert.equal(f.rawDisposals.length, 2);
    assert.equal((await f.manager.applyExternalVerdict(completed.stagedVerdict!.command)).reviewCycles, 1);
  } finally { await f.close(); }
});

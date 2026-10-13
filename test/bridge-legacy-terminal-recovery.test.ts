import assert from "node:assert/strict";
import test from "node:test";
import { newRequestId } from "../src/bridge-protocol.js";
import { sharedReviewerFixture } from "./fixtures/bridge-shared-reviewer-fixture.js";

for (const [target, diagnostic] of [
  ["Thread", "403 Forbidden: read permission denied; thread already has an active writer"],
  ["Turn", "403 Forbidden: read permission denied; thread already has an active writer"],
  ["Thread", "Schema rejected; thread already has an active writer"],
  ["Turn", "Schema rejected; thread already has an active writer"],
  ["Thread", "403 Forbidden: read permission denied"],
  ["Turn", "Schema rejected"],
] as const) {
  test(`legacy migration must not revive a terminal ${target} error: ${diagnostic}`, {timeout: 30000}, async t => {
    const f = await sharedReviewerFixture({signal: t.signal});
    t.after(() => f.close());
    try {
      await f.control(`fixture/setNext${target}Error`, {message: diagnostic});
      const record = await f.manager.startExternalPlan({version: 1, kind: "dispatch_plan", requestId: newRequestId(), createdAt: new Date().toISOString(),
        codexThreadId: newRequestId(), target: {cwd: f.directory, dshSessionId: f.parent.id}, task: "Read-only recovery classification probe",
        planMarkdown: "<proposed_plan>\nInspect existing diagnostic behavior read-only.\n</proposed_plan>", assumptions: []}, f.parent);
      await f.manager.submit(record.id, {implementationSummary: "Read-only diagnostic implemented", changedFiles: ["changed.txt"]}, f.exec);
      await f.step("original terminal callback", () => Promise.allSettled([...f.runtime.backgroundTasks]));
      const failed = await f.store.load(record.id); assert.ok(failed); assert.equal(failed.submissionState, "failed");
      assert.ok(failed.pendingReviewRequest); assert.ok(failed.submissionNotice);
      // Recovery sees this state after the original failure notice has already
      // been delivered; a pending notice would mask the legacy migration.
      await f.store.update(record.id, r => {if (r.submissionNotice) r.submissionNotice.state = "delivered";});
      await f.control("fixture/setTurnMode", {mode: "completed"});
      const originalStats = await f.control("fixture/stats"), before = f.store.coordinationHandle.loadWorkflow(record.id);
      const recovered = await f.manager.recoverCallbacks();
      await f.step("legacy recovery callback", () => Promise.allSettled([...f.runtime.backgroundTasks]));
      const after = await f.control("fixture/stats"), current = await f.store.load(record.id);
      t.diagnostic(JSON.stringify({target, diagnostic, recovered, callbacksBefore: 1, callbacksAfter: f.sends.length,
        originalThreads: originalStats.threadStarts.length, actualThreads: after.threadStarts.length, originalCalls: originalStats.turnStartRequests.length,
        actualCalls: after.turnStartRequests.length, state: current?.submissionState, originalError: failed.submissionError, actualError: current?.submissionError,
        durableUnchanged: JSON.stringify(f.store.coordinationHandle.loadWorkflow(record.id)) === JSON.stringify(before)}));
      assert.equal(recovered, 0, "A terminal diagnostic cannot authorize persistent recovery via its writer substring");
      assert.equal(f.sends.length, 1); assert.deepEqual(after.threadStarts, originalStats.threadStarts);
      assert.equal(after.turnStartRequests.length, originalStats.turnStartRequests.length);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), before);
    } finally {await f.close();}
  });
}

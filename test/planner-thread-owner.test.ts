import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

for (const stage of ["model_failure", "native_input"] as const) {
  test(`original Planner ${stage} never resumes a reused thread address after actual SDK process loss`, async () => {
    const f = await sharedReviewerFixture();
    (f.client as unknown as { options: { args: string[] } }).options.args = [protocol, "--interrupt-mode", "confirmed"];
    let bThread: string | undefined;
    let bPinned = false;
    try {
      await f.control("fixture/configure", { responses: { visible: stage === "native_input"
        ? [{ kind: "needs_input" }]
        : [{ kind: "failed", message: "turn failed" }, { kind: "failed", message: "turn failed" }] } });
      const row = await f.manager.start({ task: "Plan read-only local configuration diagnostics without changing data" }, f.exec);
      assert.equal(row.phase, stage === "native_input" ? "waiting_input" : "planning");
      const original = await f.control("fixture/stats");
      assert.equal(f.children.length, 1);
      const child = f.children[0]!;
      const originalHandle = stage === "native_input" ? f.runtime.plannerInputs.get(row.id) : f.runtime.recoverableRuns.get(row.id);
      assert.ok(originalHandle);
      await f.control("fixture/exit");
      await sharedWaitFor(() => exited(original.processId), "the original Planner OS process exited");
      await sharedWaitFor(() => !f.client.isThreadAvailable(originalHandle.threadId), "SDK observed actual process loss");
      const restarted = await f.control("fixture/stats");
      assert.notEqual(restarted.processId, original.processId);
      f.client.beginRound(); bPinned = true;
      bThread = await f.client.startThread({ cwd: f.directory, ephemeral: true, model: "model-A" });
      assert.equal(bThread, originalHandle.threadId, "Only the local upstream fixture deliberately reuses process-local text IDs");
      await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
      const bInput = await f.client.startTurn(bThread, { prompt: "Independent B original native question", model: "model-A" });
      assert.equal(bInput.kind, "needs_input");
      const before = await f.control("fixture/stats");
      const releasedBefore = [...f.subscriptionsReleased];
      const originalEvents = child.snapshotEvents();
      if (stage === "model_failure") {
        const status = await f.manager.status(undefined, f.exec);
        assert.deepEqual(status.continuation, { available: false, reason: "thread_unavailable" });
        await assert.rejects(f.manager.resume(undefined, "Continue original Planner only", f.exec), /original.*thread|unavailable/i);
      } else {
        await assert.rejects(f.manager.continue(row.id, { scope: ["Answer the original A question only"] }, f.exec), /original.*(thread|clarification)|unavailable/i);
      }
      const after = await f.control("fixture/stats");
      assert.deepEqual(after.active, before.active);
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
      assert.deepEqual(after.interrupts, before.interrupts);
      assert.deepEqual(f.subscriptionsReleased, releasedBefore);
      assert.deepEqual(child.snapshotEvents(), originalEvents, "Unavailable recovery does not author a substitute continuation in the old display");
      assert.equal(f.rawDisposals.length, 0);
      assert.equal(f.children.length, 1);
      assert.equal((f.client as unknown as { pinned: number }).pinned, 2);
      assert.equal(stage === "native_input" ? f.runtime.plannerInputs.get(row.id) : f.runtime.recoverableRuns.get(row.id), originalHandle);
    } finally {
      await f.control("fixture/completeActive").catch(() => undefined);
      if (bThread) await f.client.unsubscribeThread(bThread).catch(() => undefined);
      if (bPinned) f.client.endRound();
      await f.close();
    }
  });
}

test("a Planner handle without its original owner cannot recapture a current SDK thread by text", async () => {
  const f = await sharedReviewerFixture();
  (f.client as unknown as { options: { args: string[] } }).options.args = [protocol, "--interrupt-mode", "confirmed"];
  try {
    await f.control("fixture/configure", { responses: { visible: [
      { kind: "failed", message: "turn failed" }, { kind: "failed", message: "turn failed" },
    ] } });
    const row = await f.manager.start({ task: "Plan read-only local configuration diagnostics" }, f.exec);
    const original = f.runtime.recoverableRuns.get(row.id)!;
    assert.ok(original.plannerCheckpoint);
    // A legacy or incomplete in-process handle has no capability. The SDK can
    // capture owners, but looking up this id now cannot establish the old one.
    const incomplete = { ...original, threadOwner: undefined,
      plannerCheckpoint: { ...original.plannerCheckpoint, threadOwner: undefined } };
    f.runtime.recoverableRuns.set(row.id, incomplete);
    const before = await f.control("fixture/stats");
    await assert.rejects(f.manager.resume(undefined, "Continue", f.exec), /original.*thread|unavailable/i);
    const after = await f.control("fixture/stats");
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.interrupts, before.interrupts);
    assert.equal(f.runtime.recoverableRuns.get(row.id), incomplete);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 0);
    // Restore only the known original capability so teardown may release it.
    f.runtime.recoverableRuns.set(row.id, original);
  } finally { await f.close(); }
});

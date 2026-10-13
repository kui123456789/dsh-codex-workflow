import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved local diagnostic is verified.";
const input = { implementationSummary: "Verified read-only local diagnostic", changedFiles: ["changed.txt"], testResults: "Local checks passed" };
type Stage = "visible" | "conversion";
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function fixture(stage: Stage) {
  const f = await sharedReviewerFixture();
  (f.client as unknown as { options: { args: string[] } }).options.args = [protocol, "--interrupt-mode", "confirmed"];
  const failures = [{ kind: "failed", message: "turn failed" }, { kind: "failed", message: "turn failed" }];
  await f.control("fixture/configure", { responses: stage === "visible"
    ? { visible: failures } : { visible: [{ text: REVIEW }], verdict: failures } });
  const row = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
  assert.equal(row.processState, "waiting");
  const original = await f.control("fixture/stats");
  const recovery = f.runtime.recoverableRuns.get(row.id)!;
  assert.ok(recovery);
  assert.equal(Boolean(recovery.reviewCheckpoint), stage === "conversion");
  if (stage === "conversion") assert.equal(recovery.reviewCheckpoint?.nextStep, "conversion");
  await f.control("fixture/exit");
  await sharedWaitFor(() => exited(original.processId), "the original Reviewer OS process exited");
  await sharedWaitFor(() => !f.client.isThreadAvailable(recovery.threadId), "SDK observed actual Reviewer process loss");
  const restarted = await f.control("fixture/stats");
  assert.notEqual(restarted.processId, original.processId);
  f.client.beginRound();
  const bThread = await f.client.startThread({ cwd: f.directory, ephemeral: true, model: "model-A" });
  assert.equal(bThread, recovery.threadId, "Only the local protocol deliberately reuses process-local thread text");
  await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
  const pending = await f.client.startTurn(bThread, { prompt: "Independent B question must stay open", model: "model-A" });
  assert.equal(pending.kind, "needs_input");
  return { ...f, row, recovery, bThread, async close() {
    await f.control("fixture/completeActive").catch(() => undefined);
    await f.client.unsubscribeThread(bThread).catch(() => undefined);
    f.client.endRound();
    await f.close();
  } };
}

for (const stage of ["visible", "conversion"] as const) {
  test(`original Reviewer ${stage} recovery rejects a new SDK process at the same textual address`, async () => {
    const f = await fixture(stage);
    try {
      const before = await f.control("fixture/stats");
      const raw = f.store.coordinationHandle.loadWorkflow(f.row.id);
      const child = f.children[0]!;
      const events = child.snapshotEvents();
      const status = await f.manager.status(undefined, f.exec);
      assert.deepEqual(status.continuation, { available: false, reason: "thread_unavailable" });
      await assert.rejects(f.manager.resume(undefined, "Continue only the original Reviewer", f.exec), /original.*thread|unavailable/i);
      const after = await f.control("fixture/stats");
      assert.deepEqual(after.active, before.active);
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
      assert.deepEqual(after.interrupts, before.interrupts);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(f.row.id), raw);
      assert.deepEqual(child.snapshotEvents(), events);
      assert.equal(f.runtime.recoverableRuns.get(f.row.id), f.recovery);
      assert.equal(f.rawDisposals.length, 0);
      assert.equal(f.children.length, 1);
      assert.equal((f.client as unknown as { pinned: number }).pinned, 2);
    } finally { await f.close(); }
  });
}

test("an explicit independent review can start after original process loss without releasing its same-address successor", async () => {
  const f = await fixture("conversion");
  try {
    const before = await f.control("fixture/stats");
    await f.control("fixture/configure", { responses: {
      visible: [{ text: REVIEW }], verdict: [{ result: { verdict: "pass", summary: "Verified independent review", findings: [], testGaps: [] } }],
      aligned: [{ result: { aligned: true, conflicts: [] } }],
    } });
    const reviewed = await f.manager.review(f.row.id, { ...input, newReviewRound: true }, f.exec);
    const after = await f.control("fixture/stats");
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.reviewCycles, 1);
    assert.ok(after.threadStarts.length > before.threadStarts.length, "The explicit independent review creates its own thread");
    assert.equal(after.turnStartRequests.filter((request) => request.method === "review/start").length, 1,
      "The new business round runs its readable Reviewer exactly once");
    assert.deepEqual(after.active, before.active, "The unrelated B native request remains open");
    assert.deepEqual(after.interrupts, before.interrupts);
    assert.ok(!(after as typeof after & { unsubscribes: string[] }).unsubscribes.includes(f.bThread));
    assert.equal(f.client.isThreadAvailable(f.bThread), true);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 1);
    assert.equal(f.children.length, 2);
    assert.equal(f.rawDisposals.length, 2);
    assert.equal(after.turnStartRequests.filter((request) => request.threadId === f.bThread).length,
      before.turnStartRequests.filter((request) => request.threadId === f.bThread).length,
      "The independent review does not send a continuation to the reused original address");
  } finally { await f.close(); }
});

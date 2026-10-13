import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedReviewerFixture } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Fixture = Awaited<ReturnType<typeof sharedReviewerFixture>>;
type Stats = { processId: number; initializations: number;
  active: Array<{ threadId: string; turnId: string }>;
  threadStarts: Array<{ threadId: string }>;
  turnStartRequests: Array<{ threadId: string; turnId?: string }>;
  interrupts: Array<{ threadId: string; turnId: string }>;
  unsubscribes: string[] };
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved local diagnostic is verified.";
const primary = "Codex structured conversion unexpectedly requested user input";
const input = { implementationSummary: "Verified read-only local diagnostic", changedFiles: ["changed.txt"],
  testResults: "Valid and unavailable inputs checked" };
const configuration = { responses: { visible: [{ text: REVIEW }], verdict: [{ kind: "needs_input" }] } };
const stats = (f: Fixture) => f.control("fixture/stats") as Promise<unknown> as Promise<Stats>;

async function fixture() {
  const f = await sharedReviewerFixture();
  (f.client as unknown as { options: { args: string[] } }).options.args = [protocol, "--interrupt-mode", "failed"];
  await f.control("fixture/configure", configuration);
  return f;
}

function processExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

test("a new SDK process cannot use an old terminal ACK for reused process-local turn IDs", async () => {
  const f = await fixture();
  try {
    const first = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    const original = await stats(f);
    assert.equal(first.processState, "waiting");
    assert.equal(first.retryState?.awaitingCleanup, true);
    assert.equal(original.active.length, 1);
    assert.equal(f.rawDisposals.length, 0);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await assert.rejects(f.manager.resume(first.id, undefined, f.exec), (error: unknown) =>
      error instanceof Error && error.message === primary);
    assert.equal((await f.store.load(first.id))?.processState, "failed");
    assert.deepEqual((await stats(f)).active, []);
    assert.equal(f.rawDisposals.length, 1);
    assert.equal(f.runtime.recoverableRuns.size, 0);

    // Exercise the real recoverable SDK idle shutdown, never a projected
    // availability toggle or permanent stop. Only the local upstream protocol
    // intentionally reuses IDs; this does not claim production CLI UUID reuse.
    await f.client.releaseThreadForExternal(original.active[0]!.threadId);
    assert.equal(processExited(original.processId), true, "The original OS process really exited");
    assert.equal(f.client.isThreadAvailable(original.active[0]!.threadId), false);
    const initialized = await f.control("fixture/configure", configuration) as unknown as Stats;
    assert.notEqual(initialized.processId, original.processId);
    assert.equal(initialized.initializations, 1);

    const second = await f.manager.review(first.id, { ...input, newReviewRound: true }, f.exec);
    const current = await stats(f);
    assert.equal(second.id, first.id);
    assert.equal(second.processState, "waiting");
    assert.equal(second.retryState?.awaitingCleanup, true);
    assert.equal(current.processId, initialized.processId);
    assert.deepEqual(current.active, original.active, "The local protocol reused its process-local textual pair");
    assert.equal(original.threadStarts.length, 1);
    assert.equal(current.threadStarts.length, 1);
    assert.equal(f.children.length, 2);
    assert.equal(f.rawDisposals.length, 1);
    const newChild = f.runtime.codexChildSessions.get(first.id);
    const originalRun = f.runtime.recoverableRuns.get(first.id);
    assert.ok(newChild);
    assert.ok(originalRun);

    const resumed = await f.manager.resume(first.id, undefined, f.exec);
    const after = await stats(f);
    assert.equal(resumed.processState, "waiting");
    assert.equal(resumed.retryState?.awaitingCleanup, true);
    assert.equal(after.interrupts.length, current.interrupts.length + 1,
      "The new resource owner must request its own exact interruption ACK");
    const interrupted = after.interrupts.at(-1)!;
    assert.deepEqual({ threadId: interrupted.threadId, turnId: interrupted.turnId }, current.active[0]);
    assert.deepEqual(after.active, current.active, "The failed ACK keeps the actual new remote writer active");
    assert.deepEqual(after.turnStartRequests, current.turnStartRequests, "Cleanup does not call the model");
    assert.equal(f.runtime.codexChildSessions.get(first.id), newChild);
    assert.equal(f.runtime.recoverableRuns.get(first.id), originalRun);
    assert.equal(f.rawDisposals.length, 1);
    assert.deepEqual(after.unsubscribes, []);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 1);

    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await assert.rejects(f.manager.resume(first.id, undefined, f.exec), (error: unknown) =>
      error instanceof Error && error.message === primary);
    const ended = await stats(f);
    assert.deepEqual(ended.active, []);
    assert.deepEqual(ended.turnStartRequests, current.turnStartRequests);
    assert.deepEqual(ended.unsubscribes, [current.active[0]!.threadId]);
    assert.equal(f.rawDisposals.length, 2);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 0);
  } finally { await f.close(); }
});

test("repeated and concurrent cleanup of one original run stays idempotent", async () => {
  const f = await fixture();
  try {
    const row = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    const original = await stats(f);
    const retained = f.runtime.recoverableRuns.get(row.id);
    const waiting = await Promise.all([f.manager.resume(row.id, undefined, f.exec), f.manager.resume(row.id, undefined, f.exec)]);
    assert.ok(waiting.every((record) => record.processState === "waiting"));
    const retried = await stats(f);
    assert.equal(retried.interrupts.length, original.interrupts.length + 1);
    assert.deepEqual(retried.active, original.active);
    assert.deepEqual(retried.turnStartRequests, original.turnStartRequests);
    assert.equal(f.runtime.recoverableRuns.get(row.id), retained);
    assert.equal(f.rawDisposals.length, 0);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const settled = await Promise.allSettled([f.manager.resume(row.id, undefined, f.exec), f.manager.resume(row.id, undefined, f.exec)]);
    assert.ok(settled.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof Error
      && outcome.reason.message === primary));
    const ended = await stats(f);
    assert.equal(ended.interrupts.length, retried.interrupts.length + 1);
    assert.deepEqual(ended.active, []);
    assert.deepEqual(ended.turnStartRequests, original.turnStartRequests);
    assert.deepEqual(ended.unsubscribes, [original.active[0]!.threadId]);
    assert.deepEqual(f.rawDisposals, [f.children[0]!.id]);
    await Promise.all([f.manager.cancel(row.id, f.exec), f.manager.cancel(row.id, f.exec)]);
    const cancelled = await stats(f);
    assert.deepEqual(cancelled.interrupts, ended.interrupts);
    assert.deepEqual(cancelled.turnStartRequests, ended.turnStartRequests);
    assert.deepEqual(cancelled.unsubscribes, ended.unsubscribes);
    assert.deepEqual(f.rawDisposals, [f.children[0]!.id]);
    assert.equal(f.children.length, 1);
  } finally { await f.close(); }
});

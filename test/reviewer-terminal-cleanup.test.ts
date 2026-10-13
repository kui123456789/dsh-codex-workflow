import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { newRequestId } from "../src/bridge-protocol.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { sharedReviewerFixture } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Fixture = Awaited<ReturnType<typeof sharedReviewerFixture>>;
type Stats = { processId: number; visibleTurns: number; nativeReplies: number; writerConflicts: number;
  active: Array<{ threadId: string; turnId: string }>; unsubscribes: string[];
  threadStarts: Array<{ threadId: string; ephemeral: boolean }>;
  turnStartRequests: Array<{ threadId: string; turnId?: string; scope: string }>;
  interrupts: Array<{ threadId: string; turnId: string; mode: string }> };
type Fault = "native" | "registration";
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved local diagnostic is verified.";
const REGISTRATION = "permission denied: ORIGINAL-REVIEWER-REGISTRATION";
const input = { implementationSummary: "Verified read-only local diagnostic", changedFiles: ["changed.txt"], testResults: "Valid and unavailable inputs checked" };
const stats = (f: Fixture) => f.control("fixture/stats") as Promise<unknown> as Promise<Stats>;

async function fixture(fault: Fault) {
  const f = await sharedReviewerFixture();
  (f.client as unknown as { options: { args: string[] } }).options.args = [protocol, "--interrupt-mode", "failed"];
  (f.manager as unknown as { config: WorkflowConfig }).config.callbackRetryBaseMs = 1;
  await f.control("fixture/configure", { responses: {
    visible: [{ ...(fault === "registration" ? { kind: "hold" } : {}), text: REVIEW }],
    verdict: [{ kind: "needs_input" }],
  } });
  let injected = false;
  const startReview = f.client.startReview.bind(f.client);
  const startTurn = f.client.startTurn.bind(f.client);
  if (fault === "registration") {
    f.client.startReview = (options, signal) => startReview({ ...options, onStarted: async (started) => {
      await options.onStarted?.(started);
      if (!injected) { injected = true; throw new Error(REGISTRATION); }
    } }, signal);
    f.client.startTurn = (threadId, options, signal) => startTurn(threadId, { ...options, onStarted: async (started) => {
      await options.onStarted?.(started);
      if (!options.conversion && !injected) { injected = true; throw new Error(REGISTRATION); }
    } }, signal);
  }
  const background = async () => { await Promise.allSettled([...f.runtime.backgroundTasks]); };
  const retry = async () => {
    const row = (await f.store.list())[0]!;
    await f.store.update(row.id, (record) => { if (record.submissionState === "retrying") record.submissionRetryAt = 0; });
    await f.manager.recoverCallbacks();
    await background();
  };
  const close = async () => {
    await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
    f.client.startReview = startReview; f.client.startTurn = startTurn;
    await f.close();
  };
  return { ...f, background, retry, close };
}

async function retained(f: Fixture, row: WorkflowRecord) {
  const observed = await stats(f);
  assert.equal(observed.threadStarts.length, 1);
  assert.equal(f.children.length, 1);
  assert.equal(observed.active.length, 1, "Failed ACK leaves the actual original remote writer active");
  assert.ok(observed.interrupts.some((entry) => entry.threadId === observed.active[0]!.threadId
    && entry.turnId === observed.active[0]!.turnId), "A terminal failure requests interruption of its exact original writer");
  assert.equal(f.rawDisposals.length, 0);
  assert.deepEqual(observed.unsubscribes, []);
  assert.equal(observed.visibleTurns, 1);
  assert.equal(observed.nativeReplies, 0, "No invented answer is sent to private input");
  assert.equal(observed.writerConflicts, 0);
  const child = f.children[0]!;
  const handle = f.runtime.codexChildSessions.get(row.id);
  assert.ok(handle);
  assert.equal(handle.id, child.id);
  return { observed, child, threadId: observed.threadStarts[0]!.threadId, pair: observed.active[0]! };
}

for (const fault of ["native", "registration"] as const) {
  test(`foreground ${fault} terminal cleanup retains the original Reviewer and confirms without another model call`, async () => {
    const f = await fixture(fault);
    try {
      const result = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
      const primary = fault === "registration" ? REGISTRATION : "Codex structured conversion unexpectedly requested user input";
      assert.equal(result.processState, "waiting");
      assert.equal(result.retryState?.awaitingCleanup, true);
      assert.equal(result.error, primary);
      const original = await retained(f, result);
      const recovery = f.runtime.recoverableRuns.get(result.id);
      assert.equal(recovery?.terminalFailure, primary);
      assert.equal(recovery?.threadId, original.threadId);
      assert.equal(recovery?.interruptionTurnId, original.pair.turnId);
      assert.equal(recovery?.automaticContinuations, 0);
      assert.ok(recovery?.originalProcessIds?.includes(original.observed.processId));
      const status = await f.manager.status(result.id, f.exec);
      assert.deepEqual({ available: status.continuation.available, reason: status.continuation.reason },
        { available: false, reason: "interruption_unconfirmed" });
      const frozen = f.store.coordinationHandle.loadWorkflow(result.id);
      await writeFile(join(f.directory, "changed.txt"), "changed workspace does not stop the old writer", "utf8");
      await assert.rejects(f.manager.review(result.id, { ...input, newReviewRound: true }, f.exec), /cleanup|interruption/i);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(result.id), frozen);
      assert.equal((await f.manager.resume(result.id, undefined, f.exec)).processState, "waiting");
      const again = await retained(f, result);
      assert.equal(again.observed.processId, original.observed.processId);
      assert.equal(again.child.id, original.child.id);
      assert.deepEqual(again.observed.turnStartRequests, original.observed.turnStartRequests);
      await f.control("fixture/setInterruptMode", { mode: "confirmed" });
      await assert.rejects(f.manager.resume(result.id, undefined, f.exec), (error: unknown) => error instanceof Error && error.message === primary);
      const failed = await f.store.load(result.id);
      assert.equal(failed?.processState, "failed");
      assert.equal(failed?.error, primary);
      assert.equal(failed?.retryState, undefined);
      const final = await stats(f);
      assert.deepEqual(final.turnStartRequests, original.observed.turnStartRequests);
      assert.deepEqual(final.active, []);
      assert.deepEqual(final.unsubscribes, [original.threadId]);
      assert.deepEqual(f.rawDisposals, [original.child.id]);
      assert.equal(f.runtime.recoverableRuns.size, 0);
      assert.equal(f.runtime.codexChildSessions.size, 0);
      assert.equal(original.child.snapshotEvents().filter((event) => event.type === "turn/start").length, 1);
    } finally { await f.close(); }
  });

  test(`Bridge persistent ${fault} terminal cleanup reuses its actual Reviewer and native child without re-reviewing`, async () => {
    const f = await fixture(fault);
    try {
      const row = await f.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
        createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: f.directory, dshSessionId: f.parent.id },
        task: "Review read-only local configuration diagnostics", planMarkdown: "<proposed_plan>\nVerify local diagnostics without changing data.\n</proposed_plan>",
        assumptions: [] }, f.parent);
      await f.manager.submit(row.id, input, f.exec);
      await f.background();
      const waiting = await f.store.load(row.id);
      assert.ok(waiting);
      assert.equal(waiting.submissionState, "retrying");
      const original = await retained(f, waiting);
      assert.equal(f.dispatcher.hasPendingTerminalCleanup(row.id), true);
      assert.equal(f.dispatcher.availableContinuation(row.id), false);
      await f.retry();
      const after = await retained(f, waiting);
      assert.deepEqual(after.observed.turnStartRequests, original.observed.turnStartRequests);
      assert.equal(after.observed.processId, original.observed.processId);
      assert.equal(after.child.id, original.child.id);
      assert.equal(after.observed.interrupts.length, original.observed.interrupts.length + 1);
      assert.ok(after.observed.interrupts.every((entry) => entry.threadId === original.pair.threadId && entry.turnId === original.pair.turnId));
      await f.control("fixture/setInterruptMode", { mode: "confirmed" });
      await f.retry();
      const finalRow = await f.store.load(row.id);
      assert.equal(finalRow?.submissionState, "failed");
      assert.match(finalRow?.submissionError ?? "", fault === "registration" ? /ORIGINAL-REVIEWER-REGISTRATION/ : /unexpectedly requested user input/);
      assert.equal(finalRow?.stagedVerdict, undefined);
      assert.equal(finalRow?.reviewCycles, 0);
      const final = await stats(f);
      assert.deepEqual(final.turnStartRequests, original.observed.turnStartRequests);
      assert.deepEqual(final.active, []);
      assert.deepEqual(final.unsubscribes, [original.threadId]);
      assert.deepEqual(f.rawDisposals, [original.child.id]);
      assert.equal(f.children.length, 1);
      assert.equal(f.dispatcher.hasPendingTerminalCleanup(row.id), false);
    } finally { await f.close(); }
  });
}

test("foreground terminal cleanup releases an ended original after scope drift without writing the foreign record", async () => {
  const f = await fixture("registration");
  try {
    const row = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    const original = await retained(f, row);
    await f.store.update(row.id, (record) => { record.task = "A different business scope must not be overwritten"; });
    const foreign = f.store.coordinationHandle.loadWorkflow(row.id);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await assert.rejects(f.manager.resume(row.id, undefined, f.exec));
    const after = await stats(f);
    assert.deepEqual(after.active, []);
    assert.deepEqual(after.turnStartRequests, original.observed.turnStartRequests);
    assert.deepEqual(after.unsubscribes, [original.threadId]);
    assert.deepEqual(f.rawDisposals, [original.child.id]);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(row.id), foreign);
  } finally { await f.close(); }
});

test("foreground confirmed terminal cleanup preserves the primary error when child disposal rejects", async () => {
  const f = await fixture("registration");
  try {
    const row = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    const original = await retained(f, row);
    const child = f.runtime.codexChildSessions.get(row.id)!;
    const dispose = child.dispose.bind(child);
    child.dispose = async () => { await dispose(); throw new Error("SECONDARY-CHILD-CLEANUP-ERROR"); };
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await assert.rejects(f.manager.resume(row.id, undefined, f.exec), (error: unknown) => error instanceof Error && error.message === REGISTRATION);
    const after = await stats(f);
    assert.deepEqual(after.active, []);
    assert.deepEqual(after.turnStartRequests, original.observed.turnStartRequests);
    assert.deepEqual(after.unsubscribes, [original.threadId]);
    assert.deepEqual(f.rawDisposals, [original.child.id]);
    const failed = await f.store.load(row.id);
    assert.equal(failed?.error, REGISTRATION);
    assert.ok([...(f.runtime.cleanupNotes.get(row.id) ?? []), failed?.lastProgressMessage ?? ""]
      .some((note) => /SECONDARY-CHILD-CLEANUP-ERROR/.test(note)));
  } finally { await f.close(); }
});

test("Bridge cancel and stop keep a terminal writer until exact cleanup confirmation", async () => {
  const f = await fixture("registration");
  try {
    const row = await f.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: f.directory, dshSessionId: f.parent.id },
      task: "Review read-only local configuration diagnostics", planMarkdown: "<proposed_plan>\nVerify local diagnostics.\n</proposed_plan>", assumptions: [] }, f.parent);
    await f.manager.submit(row.id, input, f.exec);
    await f.background();
    const original = await retained(f, row);
    f.dispatcher.cancel(row.id);
    await f.dispatcher.stop();
    const waiting = await retained(f, row);
    assert.equal(f.dispatcher.hasPendingTerminalCleanup(row.id), true);
    assert.deepEqual(waiting.observed.turnStartRequests, original.observed.turnStartRequests);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await f.dispatcher.stop();
    const final = await stats(f);
    assert.deepEqual(final.active, []);
    assert.deepEqual(final.turnStartRequests, original.observed.turnStartRequests);
    assert.deepEqual(final.unsubscribes, [original.threadId]);
    assert.equal(f.dispatcher.hasPendingTerminalCleanup(row.id), false);
    await f.manager.stop();
    assert.deepEqual(f.rawDisposals, [original.child.id]);
  } finally { await f.close(); }
});

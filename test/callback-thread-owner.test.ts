import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { newRequestId } from "../src/bridge-protocol.js";
import type { CodexCallbackRequest } from "../src/codex-callback.js";
import { sharedReviewerFixture } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Fixture = Awaited<ReturnType<typeof sharedReviewerFixture>>;
type Stats = { processId: number; initializations: number;
  active: Array<{ threadId: string; turnId: string }>;
  threadStarts: Array<{ threadId: string }>;
  turnStartRequests: Array<{ threadId: string; turnId: string; scope: string }>;
  interrupts: Array<{ threadId: string; turnId: string }>;
  unsubscribes: string[] };
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved local diagnostic was verified.";
const VERDICT = { verdict: "pass", findings: [], testGaps: [], summary: "The approved local diagnostic was verified." };
const input = { implementationSummary: "Read-only local diagnostics implemented", changedFiles: ["changed.txt"], testResults: "Local checks passed" };
const stats = (f: Fixture) => f.control("fixture/stats") as Promise<unknown> as Promise<Stats>;

async function fixture() {
  const f = await sharedReviewerFixture();
  const options = (f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number } }).options;
  options.args = [protocol, "--interrupt-mode", "confirmed"];
  options.rpcTimeoutMs = 15_000;
  return f;
}

async function retireOriginalProcess(f: Fixture) {
  const child = (f.client as unknown as { child: import("node:child_process").ChildProcess }).child;
  const ended = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  await f.control("fixture/exit");
  await ended;
  assert.ok(child.pid);
  assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
}

function request(f: Fixture): CodexCallbackRequest {
  return { workflowId: "original-callback-workflow", submissionId: "original-callback-submission",
    codexThreadId: "foreign-origin-must-not-be-resumed", cwd: f.directory,
    task: "Review read-only local diagnostics", prompt: "Verify the approved local diagnostic requirements.",
    ephemeral: true, model: "model-A", effort: "low" };
}

test("Bridge recovery cannot continue a waiting Reviewer on a replacement process with the same thread ID", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/configure", { responses: { visible: [
      { kind: "failed", message: "turn failed" }, { kind: "failed", message: "turn failed" },
    ] } });
    const row = await f.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(),
      target: { cwd: f.directory, dshSessionId: f.parent.id }, task: "Review read-only local diagnostics",
      planMarkdown: "<proposed_plan>\nVerify local diagnostics without changing user data.\n</proposed_plan>", assumptions: [] }, f.parent);
    await f.manager.submit(row.id, input, f.exec);
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    assert.equal((await f.store.load(row.id))?.submissionState, "retrying");
    const old = await stats(f);
    assert.equal(f.dispatcher.availableContinuation(row.id), true);
    await retireOriginalProcess(f);
    const replacement = await f.client.startThread({ cwd: f.directory, ephemeral: true, model: "model-A" });
    assert.equal(replacement, old.threadStarts[0]!.threadId);
    const before = await stats(f);
    assert.notEqual(before.processId, old.processId);
    const available = f.dispatcher.availableContinuation(row.id);
    await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ result: VERDICT }] } });
    await f.store.update(row.id, (record) => { record.submissionRetryAt = 0; });
    await f.manager.recoverCallbacks();
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const after = await stats(f);
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests,
      "Persistent callback retry must never send the original review or conversion to the replacement transport");
    assert.deepEqual(after.interrupts, before.interrupts);
    assert.deepEqual(after.unsubscribes, before.unsubscribes);
    assert.equal(available, false, "Textual thread availability does not prove the original execution survived");
    assert.equal(f.children.length, 1);
    assert.equal((await f.store.load(row.id))?.reviewCycles, 0);
  } finally { await f.close(); }
});

test("terminal callback cleanup preserves its primary error and never interrupts or unsubscribes a replacement writer", async () => {
  const f = await fixture();
  let replacementPin = false;
  try {
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ kind: "needs_input" }] } });
    const originalRequest = request(f);
    const waiting = await f.dispatcher.send(originalRequest);
    assert.equal(waiting.kind, "retryable_busy");
    assert.equal(f.dispatcher.hasPendingTerminalCleanup(originalRequest.workflowId), true);
    const old = await stats(f);
    assert.equal(old.active.length, 1);
    const primary = f.dispatcher.getPendingTerminalCleanup(originalRequest.workflowId)?.terminalFailure;
    assert.ok(primary);
    await retireOriginalProcess(f);
    const replacement = await f.client.startThread({ cwd: f.directory, ephemeral: true, model: "model-A" });
    assert.equal(replacement, old.active[0]!.threadId);
    f.client.beginRound(); replacementPin = true;
    await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
    const active = await f.client.startTurn(replacement, { prompt: "Unrelated replacement writer" });
    assert.equal(active.kind, "needs_input");
    const before = await stats(f);
    assert.notEqual(before.processId, old.processId);
    await assert.rejects(f.dispatcher.send(originalRequest), (error: unknown) => error instanceof Error && error.message === primary);
    const after = await stats(f);
    assert.deepEqual(after.interrupts, before.interrupts, "The original cleanup does not target the new transport");
    assert.deepEqual(after.unsubscribes, before.unsubscribes);
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.active, before.active, "The unrelated native request remains active");
    assert.equal((f.client as unknown as { pinned: number }).pinned, 1, "Only the original callback pin is released");
  } finally {
    if (replacementPin) f.client.endRound();
    await f.close();
  }
});

test("callback usage lookup stays with its original Reviewer owner after process replacement", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/configure", { responses: { visible: [
      { kind: "failed", message: "turn failed" }, { kind: "failed", message: "turn failed" },
    ] } });
    const originalRequest = request(f);
    assert.equal((await f.dispatcher.send(originalRequest)).kind, "retryable_busy");
    const old = await stats(f);
    await retireOriginalProcess(f);
    const replacement = await f.client.startThread({ cwd: f.directory, ephemeral: true });
    assert.equal(replacement, old.threadStarts[0]!.threadId);
    let replacementLookups = 0;
    const getter = f.client.getThreadTokenUsage;
    f.client.getThreadTokenUsage = () => { replacementLookups += 1; return undefined; };
    try {
      assert.equal(f.dispatcher.getOriginalThreadUsage(originalRequest.workflowId), undefined);
      assert.equal(replacementLookups, 0, "A missing original owner must not read another transport's counters by thread ID");
    } finally { f.client.getThreadTokenUsage = getter; }
  } finally { await f.close(); }
});

test("callback continuation and cleanup retain the same live Reviewer owner", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/configure", { responses: { visible: [
      { kind: "failed", message: "turn failed" }, { kind: "failed", message: "turn failed" },
    ] } });
    const originalRequest = request(f);
    assert.equal((await f.dispatcher.send(originalRequest)).kind, "retryable_busy");
    const before = await stats(f);
    await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ result: VERDICT }] } });
    assert.equal((await f.dispatcher.send(originalRequest)).kind, "verdict");
    const after = await stats(f);
    assert.equal(after.processId, before.processId);
    assert.deepEqual(after.threadStarts, before.threadStarts);
    assert.ok(after.turnStartRequests.every((turn) => turn.threadId === before.threadStarts[0]!.threadId));
    assert.deepEqual(after.unsubscribes, [before.threadStarts[0]!.threadId]);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 0);
  } finally { await f.close(); }
});

test("lost thread projection with a live original process cannot confirm terminal callback cleanup", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ kind: "needs_input" }] } });
    const originalRequest = request(f);
    assert.equal((await f.dispatcher.send(originalRequest)).kind, "retryable_busy");
    const original = await stats(f);
    const pending = f.dispatcher.getPendingTerminalCleanup(originalRequest.workflowId);
    assert.equal(pending?.originalProcessId, original.processId);
    assert.equal(original.active.length, 1);
    // An external unsubscription removes the real SDK's local thread view.
    // The protocol actor intentionally keeps its original remote turn active.
    await f.client.unsubscribeThread(original.active[0]!.threadId);
    assert.equal(f.client.isThreadAvailable(original.active[0]!.threadId), false);
    assert.doesNotThrow(() => process.kill(original.processId, 0));
    const before = await stats(f);
    const retry = await f.dispatcher.send(originalRequest);
    assert.deepEqual(retry, { kind: "retryable_busy", reason: "original Reviewer interruption is unconfirmed" });
    assert.equal(f.dispatcher.hasPendingTerminalCleanup(originalRequest.workflowId), true);
    const after = await stats(f);
    assert.deepEqual(after.active, before.active);
    assert.deepEqual(after.interrupts, before.interrupts);
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.unsubscribes, before.unsubscribes);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 1);
    await f.client.stop();
    assert.throws(() => process.kill(original.processId, 0), { code: "ESRCH" });
    await assert.rejects(f.dispatcher.send(originalRequest), (error: unknown) => error instanceof Error && error.message === pending?.terminalFailure);
    assert.equal((f.client as unknown as { pinned: number }).pinned, 0);
  } finally { await f.close(); }
});

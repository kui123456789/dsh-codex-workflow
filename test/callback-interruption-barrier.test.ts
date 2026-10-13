import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { CodexCallbackProcessError, type CodexCallbackRequest, type CodexCallbackResult } from "../src/codex-callback.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";

const server = fileURLToPath(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url));
interface Stats {
  processId: number;
  initializations: number;
  visibleTurns: number;
  heldInterrupts: number;
  writerConflicts: number;
  active: Array<{ threadId: string; turnId: string }>;
  threadStarts: Array<{ threadId: string; method: string; ephemeral: boolean }>;
  turnStartRequests: Array<{ threadId: string; method: string; prompt: string; model: string; effort: string }>;
  interrupts: Array<{ threadId: string; turnId: string; mode: string }>;
}

async function fixture(mode: "held" | "failed" | "confirmed" = "held", completed = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-interruption-barrier-"));
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [server, "--interrupt-mode", mode, "--active-visible-turns", "1", "--turn-mode", completed ? "completed" : "active"],
    requestTimeoutMs: 150, rpcTimeoutMs: 5000, idleProcessMs: 0 });
  const dispatcher = new AppServerCodexCallbackDispatcher(client, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const rpc = (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(client);
  const control = (method: string, params: object = {}) => rpc<Stats>(method, params);
  const tasks: Promise<CodexCallbackResult>[] = [];
  const started: Array<{ threadId: string; turnId: string }> = [];
  const released: string[] = [];
  const unsubscribed: string[] = [];
  let pins = 0;
  let begins = 0;
  let ends = 0;
  const begin = client.beginRound.bind(client);
  const end = client.endRound.bind(client);
  client.beginRound = () => { pins += 1; begins += 1; begin(); };
  client.endRound = () => { pins -= 1; ends += 1; end(); };
  const unsubscribe = client.unsubscribeThread.bind(client);
  client.unsubscribeThread = async (...args) => { unsubscribed.push(args[0]); return unsubscribe(...args); };
  const request: CodexCallbackRequest = {
    workflowId: "callback-workflow", submissionId: "original-submission", codexThreadId: "origin-must-not-be-resumed",
    cwd: directory, task: "Review the read-only local diagnostic implementation",
    prompt: "INITIAL-CALLBACK-REVIEW-SENTINEL: verify the read-only diagnostic requirements.",
    ephemeral: true, model: "model-A", effort: "low",
    onStarted(value) { started.push(value); },
    onThreadReleased(threadId) { released.push(threadId); },
  };
  const send = (signal?: AbortSignal) => {
    const task = dispatcher.send(request, signal);
    tasks.push(task);
    void task.catch(() => undefined);
    return task;
  };
  const assertRetained = (threadId: string) => {
    assert.equal(client.isThreadAvailable(threadId), true);
    assert.equal(pins, 1);
    assert.equal(begins, 1);
    assert.equal(ends, 0);
    assert.deepEqual(released, []);
    assert.deepEqual(unsubscribed, []);
  };
  const assertReleasedOnce = (threadId: string) => {
    assert.equal(pins, 0);
    assert.equal(begins, 1);
    assert.equal(ends, 1);
    assert.deepEqual(released, [threadId]);
    assert.deepEqual(unsubscribed, [threadId]);
  };
  return { client, dispatcher, request, control, send, started, assertRetained, assertReleasedOnce,
    async close() {
      await control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
      await control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
      await Promise.allSettled(tasks);
      await dispatcher.stop();
      await client.stop();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test("Bridge waits for the original interruption ACK and retries only cleanup before reusing its Reviewer", async () => {
  const f = await fixture();
  try {
    let settled = false;
    const first = f.send();
    void first.then(() => { settled = true; }, () => { settled = true; });
    const held = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    const original = f.started[0]!;
    assert.ok(original);
    assert.equal(held.heldInterrupts, 1);
    assert.deepEqual(held.active, [original]);
    assert.equal(settled, false, "a held ACK cannot settle the callback into a new model attempt");
    const blocked = await f.control("fixture/stats");
    assert.equal(blocked.turnStartRequests.length, 1, "the automatic continuation cannot start an overlapping writer");
    assert.equal(blocked.writerConflicts, 0);
    f.assertRetained(original.threadId);

    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/releaseInterrupt", { confirmed: false });
    assert.deepEqual(await first, { kind: "retryable_busy", reason: "original Reviewer interruption is unconfirmed" });
    f.assertRetained(original.threadId);
    const waiting = await f.control("fixture/stats");
    assert.deepEqual(waiting.active, [original]);
    assert.equal(waiting.turnStartRequests.length, 1);
    assert.equal(waiting.threadStarts.length, 1);
    assert.equal(waiting.threadStarts[0]!.ephemeral, true);

    assert.deepEqual(await f.send(), { kind: "retryable_busy", reason: "original Reviewer interruption is unconfirmed" });
    f.assertRetained(original.threadId);
    const failedAgain = await f.control("fixture/stats");
    assert.equal(failedAgain.processId, held.processId);
    assert.equal(failedAgain.initializations, 1);
    assert.equal(failedAgain.turnStartRequests.length, 1, "persistent retry with failed cleanup sends no new model request");
    assert.equal(failedAgain.interrupts.length, waiting.interrupts.length + 1);
    assert.deepEqual(failedAgain.active, [original]);
    assert.ok(failedAgain.interrupts.every((entry) => entry.threadId === original.threadId && entry.turnId === original.turnId));
    assert.equal(failedAgain.writerConflicts, 0);

    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const completed = await f.send();
    assert.equal(completed.kind, "verdict");
    if (completed.kind === "verdict") assert.equal(completed.verdict.verdict, "pass");
    const final = await f.control("fixture/stats");
    assert.equal(final.processId, held.processId);
    assert.equal(final.initializations, 1);
    assert.equal(final.threadStarts.length, 1, "cleanup retries never create a replacement Reviewer");
    assert.equal(final.visibleTurns, 2);
    assert.equal(final.turnStartRequests.length, 3, "one initial review, one ACK-authorized continuation and one conversion");
    assert.equal(final.interrupts.length, failedAgain.interrupts.length + 1);
    assert.ok(final.interrupts.every((entry) => entry.threadId === original.threadId && entry.turnId === original.turnId));
    assert.ok(final.turnStartRequests.every((entry) => entry.threadId === original.threadId && entry.model === "model-A" && entry.effort === "low"));
    assert.equal(final.turnStartRequests[1]!.prompt.includes("INITIAL-CALLBACK-REVIEW-SENTINEL"), false);
    assert.match(final.turnStartRequests[1]!.prompt, /继续|continue/i);
    assert.deepEqual(final.active, []);
    assert.equal(final.writerConflicts, 0);
    f.assertReleasedOnce(original.threadId);
  } finally { await f.close(); }
});

test("Bridge cancellation cleans the retained original interruption pair and releases its claim once", async () => {
  const f = await fixture("failed");
  try {
    assert.deepEqual(await f.send(), { kind: "retryable_busy", reason: "original Reviewer interruption is unconfirmed" });
    const original = f.started[0]!;
    assert.ok(original);
    f.assertRetained(original.threadId);
    const before = await f.control("fixture/stats");
    assert.deepEqual(before.active, [original]);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    f.dispatcher.cancel(f.request.workflowId);
    assert.deepEqual(await f.send(), { kind: "retryable_busy", reason: "cancelled by user (latch)" });
    f.dispatcher.cancel(f.request.workflowId);
    await f.dispatcher.stop();
    const final = await f.control("fixture/stats");
    assert.equal(final.processId, before.processId);
    assert.equal(final.initializations, 1);
    assert.equal(final.threadStarts.length, 1);
    assert.equal(final.turnStartRequests.length, 1, "waiting cancellation starts no continuation or conversion");
    assert.equal(final.interrupts.length, before.interrupts.length + 1, "repeated cancel and stop clean the marker once");
    assert.deepEqual(final.interrupts.at(-1), { ...original, mode: "confirmed" });
    assert.deepEqual(final.active, []);
    assert.equal(final.writerConflicts, 0);
    f.assertReleasedOnce(original.threadId);
  } finally { await f.close(); }
});

test("Bridge rejects a foreign typed interruption before timeout text can start a replacement or continuation", async () => {
  const f = await fixture("confirmed", true);
  try {
    const start = f.client.startTurn.bind(f.client);
    let injected = false;
    f.client.startTurn = async (...args) => {
      const result = await start(...args);
      if (!injected && !args[1].conversion) {
        injected = true;
        assert.equal(result.kind, "completed");
        if (result.kind === "completed") assert.equal(result.status, "completed");
        // The real original turn has finished. Fault only the port's marker,
        // so no actual writer is left running or discarded by this test.
        throw new CodexTurnInterruptionError(new Error("Codex turn timed out: FOREIGN-PAIR-SENTINEL"),
          "foreign-reviewer-must-not-be-touched", "foreign-turn-must-not-be-touched");
      }
      return result;
    };
    await assert.rejects(f.send(), (error: unknown) => error instanceof CodexCallbackProcessError
      && /different Reviewer thread; refusing to continue or replace the original/.test(error.message));
    assert.equal(injected, true);
    const original = f.started[0]!;
    assert.ok(original);
    const final = await f.control("fixture/stats");
    assert.equal(final.initializations, 1);
    assert.equal(final.threadStarts.length, 1);
    assert.equal(final.threadStarts[0]!.threadId, original.threadId);
    assert.equal(final.turnStartRequests.length, 1, "the foreign marker cannot trigger a model retry or conversion");
    assert.equal(final.turnStartRequests[0]!.threadId, original.threadId);
    assert.equal(final.writerConflicts, 0);
    assert.deepEqual(final.interrupts, [], "no guessed foreign pair is interrupted, and the original completed normally");
    assert.deepEqual(final.active, []);
    assert.equal(f.dispatcher.availableContinuation(f.request.workflowId), false);
    f.assertReleasedOnce(original.threadId);
  } finally { await f.close(); }
});

for (const mode of ["failed", "confirmed"] as const) {
  test(`Bridge caller-only abort with ${mode} ACK rejects its caller and retains the original Reviewer for a fresh signal`, async () => {
    const f = await fixture(mode);
    try {
      const caller = new AbortController();
      const reason = new Error("CALLER-ONLY-ABORT-SENTINEL");
      const recordStarted = f.request.onStarted;
      assert.ok(recordStarted);
      f.request.onStarted = async (value) => {
        await recordStarted(value);
        caller.abort(reason);
      };
      await assert.rejects(f.send(caller.signal), (error: unknown) => error === reason);
      f.request.onStarted = recordStarted;
      assert.equal(caller.signal.aborted, true);
      assert.equal(f.dispatcher.isCancelled(f.request.workflowId), false, "caller abort is not workflow cancellation");
      const original = f.started[0]!;
      assert.ok(original);
      f.assertRetained(original.threadId);
      const before = await f.control("fixture/stats");
      assert.equal(before.initializations, 1);
      assert.equal(before.threadStarts.length, 1);
      assert.equal(before.turnStartRequests.length, 1);
      assert.equal(before.writerConflicts, 0);
      assert.deepEqual(before.active, mode === "failed" ? [original] : []);
      assert.equal(before.interrupts.length, 1);
      assert.ok(before.interrupts.every((entry) => entry.threadId === original.threadId && entry.turnId === original.turnId));

      await f.control("fixture/setInterruptMode", { mode: "confirmed" });
      const fresh = new AbortController();
      const completed = await f.send(fresh.signal);
      assert.equal(fresh.signal.aborted, false);
      assert.equal(completed.kind, "verdict");
      if (completed.kind === "verdict") assert.equal(completed.verdict.verdict, "pass");
      const final = await f.control("fixture/stats");
      assert.equal(final.processId, before.processId);
      assert.equal(final.initializations, 1);
      assert.equal(final.threadStarts.length, 1, "a fresh caller signal never creates a replacement Reviewer");
      assert.equal(final.visibleTurns, 2);
      assert.equal(final.turnStartRequests.length, 3);
      assert.equal(final.interrupts.length, before.interrupts.length + (mode === "failed" ? 1 : 0),
        "only the unconfirmed caller abort retries the original cleanup");
      assert.ok(final.interrupts.every((entry) => entry.threadId === original.threadId && entry.turnId === original.turnId));
      assert.ok(final.turnStartRequests.every((entry) => entry.threadId === original.threadId && entry.model === "model-A" && entry.effort === "low"));
      assert.equal(final.turnStartRequests[1]!.prompt.includes("INITIAL-CALLBACK-REVIEW-SENTINEL"), false);
      assert.match(final.turnStartRequests[1]!.prompt, /继续|continue/i);
      assert.deepEqual(final.active, []);
      assert.equal(final.writerConflicts, 0);
      f.assertReleasedOnce(original.threadId);
    } finally { await f.close(); }
  });
}

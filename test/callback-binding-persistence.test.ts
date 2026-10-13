import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

test("ephemeral callback binding failure retains the exact Reviewer and retries persistence before model work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-binding-persistence-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const port = codex as unknown as { child?: ChildProcess };
  const asynchronousFailures: Array<{ kind: string; error: unknown }> = [];
  const rejected = (error: unknown) => { asynchronousFailures.push({ kind: "unhandledRejection", error }); };
  const uncaught = (error: unknown) => { asynchronousFailures.push({ kind: "uncaughtException", error }); };
  process.on("unhandledRejection", rejected); process.on("uncaughtExceptionMonitor", uncaught);
  let bindingCalls = 0;
  const request = {
    workflowId: "workflow-binding-persistence",
    submissionId: "submission-binding-persistence",
    codexThreadId: "origin-task-binding-persistence",
    cwd: directory,
    prompt: "Review this implementation.",
    reviewerName: "DSH Reviewer: binding-persistence",
    ephemeral: true,
    onThread: () => {
      bindingCalls += 1;
      if (bindingCalls === 1) throw new Error("transport error: workflow store unavailable");
    },
  };
  try {
    const first = await callback.send(request);
    assert.deepEqual(first, { kind: "retryable_busy", reason: "Reviewer binding persistence failed; waiting for retry" },
      "A local binding failure retains the exact Reviewer without starting a model");
    assert.equal(bindingCalls, 1);

    let calls = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
      method: string;
      params: Record<string, unknown>;
    });
    assert.equal(calls.filter(call => call.method === "thread/start").length, 1,
      "The failed request creates exactly one Reviewer and does not create a replacement");
    assert.equal(calls.filter(call => call.method === "turn/start").length, 0,
      "A failed binding cannot admit a model turn");
    const second = await callback.send(request);
    assert.deepEqual(second, { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });
    assert.equal(bindingCalls, 2, "The retained Reviewer retries persistence before model work");
    calls = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
      method: string;
      params: Record<string, unknown>;
    });
    assert.equal(calls.filter(call => call.method === "turn/start").length, 2,
      "The retry runs visible and conversion turns only after binding succeeds");
    assert.equal(calls.filter(call => call.method === "thread/unsubscribe").length, 1,
      "The exact retained Reviewer is released once after the successful retry");
    assert.equal(calls.filter(call => call.method === "thread/fork").length, 0,
      "ephemeral submission conversion stays on its original Reviewer thread");
    assert.equal(asynchronousFailures.length, 0);
  } finally {
    process.off("unhandledRejection", rejected); process.off("uncaughtExceptionMonitor", uncaught);
    const originalChild = port.child;
    await callback.stop().catch(() => undefined);
    await codex.stop().catch(() => undefined);
    const cleanupCalls = (await readFile(marker, "utf8").catch(() => "")).trim()
      .split("\n").filter(Boolean).map(line => JSON.parse(line) as { method: string });
    console.log(JSON.stringify({ callbackBindingFixtureCleanup: true,
      processExitConfirmed: Boolean(originalChild && (originalChild.exitCode !== null || originalChild.signalCode !== null)),
      threadStarts: cleanupCalls.filter(call => call.method === "thread/start").length,
      turnStarts: cleanupCalls.filter(call => call.method === "turn/start").length,
      unsubscribes: cleanupCalls.filter(call => call.method === "thread/unsubscribe").length,
      forks: cleanupCalls.filter(call => call.method === "thread/fork").length,
      unhandledEvents: asynchronousFailures.length }));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

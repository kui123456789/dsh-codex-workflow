import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const open = new Promise<void>((resolve) => { release = resolve; });
  return { entered, open, enter, release };
}

test("cancel, lease loss or stop during pending ephemeral Reviewer binding releases the original subscription", async () => {
  for (const action of ["cancel", "cancelSubmission", "stop"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `dsh-callback-binding-${action}-`));
    const marker = join(directory, "calls.jsonl");
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 5000,
      rpcTimeoutMs: 4000,
      idleProcessMs: 0,
      env: { ...process.env, FAKE_CODEX_THREAD_PARAMS_MARKER: marker },
    });
    const callback = new AppServerCodexCallbackDispatcher(codex);
    const port = codex as unknown as { child?: ChildProcess };
    const binding = gate();
    const asynchronousFailures: Array<{ kind: string; error: unknown }> = [];
    const rejected = (error: unknown) => { asynchronousFailures.push({ kind: "unhandledRejection", error }); };
    const uncaught = (error: unknown) => { asynchronousFailures.push({ kind: "uncaughtException", error }); };
    process.on("unhandledRejection", rejected); process.on("uncaughtExceptionMonitor", uncaught);
    let stopping: Promise<void> | undefined;
    try {
      const request = {
        workflowId: `workflow-binding-${action}`,
        submissionId: `submission-binding-${action}`,
        codexThreadId: `origin-binding-${action}`,
        cwd: directory,
        prompt: "Review this implementation.",
        reviewerName: `DSH Reviewer: binding-${action}`,
        ephemeral: true,
        onThread: async () => {
          binding.enter();
          await binding.open;
          throw new Error("transport error: workflow store unavailable");
        },
      };
      const sending = callback.send(request);
      await binding.entered;
      let calls = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      assert.equal(calls.filter(call => call.method === "thread/start").length, 1);
      assert.equal(calls.filter(call => call.method === "turn/start").length, 0);
      if (action === "cancel") callback.cancel(request.workflowId);
      else if (action === "cancelSubmission") stopping = Promise.resolve(callback.cancelSubmission(request.workflowId, request.submissionId));
      else stopping = callback.stop();
      binding.release();
      await Promise.allSettled([sending, stopping ?? Promise.resolve()]);
      if (action !== "stop") await callback.stop();
      calls = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      assert.equal(calls.filter(call => call.method === "thread/start").length, 1,
        "the cancelled request keeps one original Reviewer");
      assert.equal(calls.filter(call => call.method === "turn/start").length, 0,
        "a cancelled pending binding cannot start a model turn");
      assert.equal(calls.filter(call => call.method === "thread/unsubscribe").length, 1,
        "cancel/stop must release the exact Reviewer that was created before binding failed");
      assert.equal(calls.filter(call => call.method === "thread/fork").length, 0);
      assert.deepEqual(asynchronousFailures, []);
    } finally {
      process.off("unhandledRejection", rejected); process.off("uncaughtExceptionMonitor", uncaught);
      binding.release();
      await callback.stop().catch(() => undefined);
      const originalChild = port.child;
      await codex.stop().catch(() => undefined);
      const calls = (await readFile(marker, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as { method: string });
      console.log(JSON.stringify({ callbackBindingRaceFixtureCleanup: true, action,
        processExitConfirmed: Boolean(originalChild && (originalChild.exitCode !== null || originalChild.signalCode !== null)),
        threadStarts: calls.filter(call => call.method === "thread/start").length,
        turnStarts: calls.filter(call => call.method === "turn/start").length,
        unsubscribes: calls.filter(call => call.method === "thread/unsubscribe").length,
        forks: calls.filter(call => call.method === "thread/fork").length,
        unhandledEvents: asynchronousFailures.length }));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

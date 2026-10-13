import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAuditDispatcher } from "../../src/codex-cli-audit.js";
import { CodexCallbackProcessError, CodexInvalidThreadError } from "../../src/codex-callback.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", { message: error.message }));
let child!: ChildProcess, starts = 0, diagnostic = "", release!: () => void;
let retiredChild: ChildProcess | undefined;
const ready = new Promise<void>(resolve => { release = resolve; });
const maxOutputBytes = mode === "small-bound" ? 2 : undefined;
const audit = new CodexCliAuditDispatcher({ command: "local-cli-stderr", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 5_000, maxOutputBytes, retry: { budgetMs: 0 },
  spawn: (_command, args, options) => {
    starts++;
    const backendMode = mode === "successor" ? starts === 1 ? "success" : "terminal-exit" : mode;
    child = spawn(process.execPath, [fileURLToPath(new URL("./cli-stderr-failure-backend.mjs", import.meta.url)), backendMode],
      { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    log("backend-start", { pid: child.pid, args });
    child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    child.once("message", () => {
      const failed = ["transient-exit", "terminal-exit", "invalid-thread"].includes(backendMode);
      const inject = () => {
        log("before-diagnostic-error", { starts, diagnostic, listeners: child.stderr!.listenerCount("error") });
        if (mode === "successor" && starts === 2) {
          retiredChild!.stderr!.emit("error", new Error("retired diagnostic-only server_overloaded"));
          child.send!({ continue: true }); return;
        }
        if (mode === "control") { release(); child.send!({ continue: true }); return; }
        child.stderr!.once("close", () => { release(); if (mode !== "stop") child.send!({ continue: true }); });
        child.stderr!.destroy(new Error("controlled diagnostic-only permission denied server_overloaded"));
      };
      if (failed && !diagnostic) child.stderr!.once("data", inject);
      else inject();
    });
    return child;
  },
});
type RunEntry = { run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> };
try {
  if (["transient-exit", "terminal-exit", "invalid-thread"].includes(mode)) {
    const error = await audit.review({ workflowId: "original-workflow", submissionId: "original-submission", codexThreadId: "original-reviewer",
      cwd: directory, prompt: "Original review" }).then(() => { throw new Error("Failure cannot produce a verdict"); }, error => error);
    assert.ok(error instanceof Error);
    assert.equal(error instanceof CodexCallbackProcessError, mode === "terminal-exit");
    if (mode === "invalid-thread") assert.ok(error instanceof CodexInvalidThreadError);
    else assert.ok(error.message.includes(diagnostic));
    assert.match(error.message, /stderr diagnostic stream unavailable/);
    assert.ok(!error.message.includes("controlled diagnostic-only"));
    log("original-exit-diagnostic", { message: error.message, transient: mode === "transient-exit", actualExitCode: child.exitCode });
  } else if (mode === "stop") {
    const original = audit.normalize({ workflowId: "original-workflow", cwd: directory, visibleText: "Original review" });
    const settled = original.then(() => { throw new Error("Stopped model cannot finish"); }, error => error);
    await ready; await audit.stop();
    const error = await settled;
    assert.match(error.message, /dispatcher stopped/);
    log("stopped-original", { message: error.message, exitCode: child.exitCode, signalCode: child.signalCode });
  } else if (mode === "small-bound") {
    const result = await (audit as unknown as RunEntry).run("original-workflow", undefined, [], "Original review").catch(error => error);
    // The small stdout budget still has its own original overflow behavior.
    assert.ok(result instanceof Error);
    assert.match(result.message, /output exceeded retention bound/);
    log("small-original-bound", { message: result.message });
  } else {
    const result = await audit.normalize({ workflowId: "original-workflow", cwd: directory, visibleText: "Original review" });
    assert.equal(result.verdict, "pass"); assert.equal(result.summary, "original result");
    assert.equal(child.exitCode, 0);
    log("healthy-original", { result, actualExitCode: child.exitCode });
    if (mode === "retired-error") {
      child.stderr!.emit("error", new Error("retired original diagnostic failure"));
      await new Promise<void>(resolve => setImmediate(resolve));
      log("retired-error-consumed");
    }
    if (mode === "successor") {
      retiredChild = child;
      const error = await audit.review({ workflowId: "new-workflow", submissionId: "new-submission", codexThreadId: "new-reviewer",
        cwd: directory, prompt: "New independent review" }).then(() => { throw new Error("Terminal original result cannot become a verdict"); }, error => error);
      assert.ok(error instanceof CodexCallbackProcessError);
      assert.match(error.message, /permission denied/);
      assert.ok(!error.message.includes("stderr diagnostic stream unavailable"));
      assert.ok(!error.message.includes("retired diagnostic-only"));
      log("successor-isolated", { message: error.message, currentExitCode: child.exitCode, retiredExitCode: retiredChild.exitCode });
    }
  }
  assert.equal(starts, mode === "successor" ? 2 : 1);
  log("actor-complete", { starts });
} finally { await audit.stop(); }

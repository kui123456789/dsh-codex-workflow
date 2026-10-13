import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAuditDispatcher } from "../../src/codex-cli-audit.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", { message: error.message }));
const controller = new AbortController(), cancellation = new Error("original caller cancelled");
const failure = new Error("controlled original model pipe 503 Service Unavailable");
const streamName = mode.endsWith("stdin") || mode === "stdin" ? "stdin" : "stdout";
let child!: ChildProcess, retired: ChildProcess | undefined, starts = 0, killRequests = 0, observedOutput = "";
let releaseBinding!: () => void, bindingEntered = false, callerSettled = false;
const bindingGate = new Promise<void>(resolve => { releaseBinding = resolve; });
let originalClose: Promise<void> | undefined;
const audit = new CodexCliAuditDispatcher({ command: "local-cli-model-stream", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 5_000, retry: { budgetMs: 65_000 },
  spawn: (_command, args, options) => {
    starts++;
    child = spawn(process.execPath, [fileURLToPath(new URL("./cli-model-stream-backend.mjs", import.meta.url)), mode],
      { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    const originalKill = child.kill.bind(child);
    originalClose = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill = signal => { killRequests++; return originalKill(signal); };
    log("backend-start", { pid: child.pid, args });
    child.stdout!.on("data", chunk => { observedOutput += String(chunk); });
    child.once("message", () => {
      log("original-ready", { starts, streamName, listeners: child[streamName]!.listenerCount("error"), observedOutput });
      if (mode === "control" || mode.startsWith("retired")) { child.send!({ finish: true }); return; }
      if (mode.startsWith("successor")) {
        if (starts === 1) { child.send!({ finish: true }); return; }
        retired![streamName]!.emit("error", new Error("retired model stream failure"));
        child.send!({ finish: true }); return;
      }
      if (mode.startsWith("cancel")) controller.abort(cancellation);
      child[streamName]!.destroy(failure);
    });
    if (mode === "sync-stdin") child.stdin!.end = (() => { throw failure; }) as NonNullable<ChildProcess["stdin"]>["end"];
    return child;
  },
});
try {
  type RunEntry = { run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string,
    signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> };
  const operation = () => mode === "stdin" || mode === "cancel-stdin"
    ? (audit as unknown as RunEntry).run("original-workflow", "original-submission", [], "x".repeat(4 * 1024 * 1024), controller.signal)
    : audit.normalize({ workflowId: "original-workflow", cwd: directory, visibleText: "Original review" }, controller.signal);
  if (mode === "identity-stdout") {
    const pending = audit.createReview({ workflowId: "original-workflow", submissionId: "original-submission", cwd: directory,
      prompt: "Original review", onThread: async threadId => {
        assert.equal(threadId, "01234567-89ab-4def-8123-456789abcdef"); bindingEntered = true;
        log("original-binding-entered", { threadId }); await bindingGate; log("original-binding-finished", { threadId });
      } });
    const result = pending.then(() => { callerSettled = true; throw new Error("Broken output cannot produce verdict"); },
      error => { callerSettled = true; return error; });
    await originalClose; assert.equal(bindingEntered, true); assert.equal(callerSettled, false);
    log("original-close-awaiting-binding", { callerSettled, bindingEntered, children: (audit as unknown as { children: Map<number, unknown> }).children.size });
    releaseBinding(); const error = await result; assert.equal(error, failure);
    assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
    log("original-failed", { sameCause: true, message: error.message, exitCode: child.exitCode, signalCode: child.signalCode, killRequests });
  } else if (["stdin", "sync-stdin", "stdout", "completed-stdout", "cancel-stdin", "cancel-stdout"].includes(mode)) {
    const error = await operation().then(() => { throw new Error("Broken model stream cannot publish a verdict"); }, error => error);
    assert.equal(error, mode.startsWith("cancel") ? cancellation : failure);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "Caller waits for original process close");
    assert.equal(starts, 1, "Pipe failure cannot trigger the transient model retry loop");
    if (mode === "completed-stdout") assert.match(observedOutput, /original result/);
    log("original-failed", { sameCause: true, message: error.message, exitCode: child.exitCode, signalCode: child.signalCode, killRequests });
  } else {
    const result = await operation(); assert.ok("summary" in result); assert.equal(result.summary, "original result");
    assert.equal(child.exitCode, 0); retired = child;
    if (mode.startsWith("retired")) {
      const before = killRequests;
      retired[streamName]!.emit("error", new Error("retired model stream failure"));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(killRequests, before); log("retired-error-consumed");
    } else if (mode.startsWith("successor")) {
      const next = await operation(); assert.ok("summary" in next); assert.equal(next.summary, "original result");
      assert.equal(child.exitCode, 0); assert.equal(retired.exitCode, 0);
      assert.equal(killRequests, 0); log("successor-isolated", { starts, oldExitCode: retired.exitCode, currentExitCode: child.exitCode });
    }
  }
  await audit.stop();
  log("actor-complete", { starts, killRequests });
} finally { await audit.stop(); }

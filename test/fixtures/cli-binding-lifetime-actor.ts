import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAuditDispatcher } from "../../src/codex-cli-audit.js";
import { CodexCallbackProcessError } from "../../src/codex-callback.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", { message: error.message }));
const controller = new AbortController(), cause = new Error("original caller cancelled during binding");
const bindingFailure = new Error("original binding save rejected");
let release!: () => void, close!: Promise<void>, entered = false, callerSettled = false, starts = 0, killRequests = 0, bindings = 0;
let child!: ChildProcess, bindingFinished = false;
const gate = new Promise<void>(resolve => { release = resolve; });
const success = mode === "success-control" || mode === "caller-success";
const audit = new CodexCliAuditDispatcher({ command: "local-binding-lifetime", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 5_000, retry: { budgetMs: 0 },
  spawn: (_command, args, options) => {
    starts++;
    child = spawn(process.execPath, [fileURLToPath(new URL("./cli-binding-lifetime-backend.mjs", import.meta.url)),
      starts === 1 ? success ? "success" : "terminal" : "normalization"], { ...options, windowsHide: true });
    const originalKill = child.kill.bind(child); child.kill = signal => { killRequests++; return originalKill(signal); };
    close = new Promise<void>(resolve => child.once("close", () => resolve()));
    log("backend-start", { pid: child.pid, args }); return child;
  },
});
try {
  const pending = audit.createReview({ workflowId: "original-workflow", submissionId: "original-submission", cwd: directory, prompt: "Original review",
    onThread: async id => {
      bindings++; entered = true; assert.equal(id, "01234567-89ab-4def-8123-456789abcdef");
      log("original-binding-entered", { id }); await gate; bindingFinished = true;
      log("original-binding-finished", { id });
      if (mode === "caller-rejected-binding" || mode === "binding-reject-control") throw bindingFailure;
    } }, controller.signal);
  const result = pending.then(value => { callerSettled = true; return { value, error: undefined }; },
    error => { callerSettled = true; return { value: undefined, error }; });
  await close; assert.equal(entered, true); assert.equal(callerSettled, false); assert.equal(bindings, 1);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  log("original-closed-binding-held", { exitCode: child.exitCode, signalCode: child.signalCode, callerSettled,
    children: (audit as unknown as { children: Map<number, unknown> }).children.size, abortListeners: getEventListeners(controller.signal, "abort").length });
  let stopping: Promise<void> | undefined, stopFinished = false;
  if (mode.startsWith("caller")) controller.abort(cause);
  if (mode === "workflow-cancel") audit.cancel("original-workflow");
  if (mode === "submission-cancel") audit.cancelSubmission("original-workflow", "original-submission");
  if (mode === "stop") stopping = audit.stop().then(() => { stopFinished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(callerSettled, false); assert.equal(bindingFinished, false);
  if (mode === "stop") assert.equal(stopFinished, false);
  release(); const observed = await result; await stopping;
  assert.equal(bindingFinished, true);
  if (mode.startsWith("caller")) assert.equal(observed.error, cause);
  else if (mode === "workflow-cancel") assert.match(observed.error.message, /audit cancelled/);
  else if (mode === "submission-cancel") assert.match(observed.error.message, /submission lease lost/);
  else if (mode === "stop") assert.match(observed.error.message, /dispatcher stopped/);
  else if (mode === "binding-reject-control") assert.equal(observed.error, bindingFailure);
  else if (mode === "terminal-control") { assert.ok(observed.error instanceof CodexCallbackProcessError); assert.match(observed.error.message, /permission denied/); }
  else { assert.equal(observed.value!.verdict.verdict, "pass"); assert.equal(observed.value!.threadId, "01234567-89ab-4def-8123-456789abcdef"); }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
  assert.equal(starts, mode === "success-control" ? 2 : 1); assert.equal(bindings, 1); assert.equal(killRequests, 0);
  controller.abort(new Error("late settled cancellation"));
  assert.equal(killRequests, 0);
  log("actor-complete", { starts, bindings, killRequests, listenerCount: getEventListeners(controller.signal, "abort").length,
    sameCause: observed.error === cause, errorMessage: observed.error?.message, resultKind: observed.value?.kind });
} finally { release(); await audit.stop(); }

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAuditDispatcher } from "../../src/codex-cli-audit.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", { message: error.message }));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const children: ChildProcess[] = [];
const workflowId = "original-workflow", submissionId = "original-submission";
let enterSleep!: () => void, releaseSleep!: () => void;
const sleeping = new Promise<void>(resolve => { enterSleep = resolve; });
const released = new Promise<void>(resolve => { releaseSleep = resolve; });
const caller = new AbortController(), callerCause = new Error("original caller abort reason");
const runSignal = mode === "no-caller" ? undefined : caller.signal;
let settled = false, operationError: unknown, stopSettled = false;
let stopping: Promise<void> | undefined, peer: Promise<unknown> | undefined;
let sleepSignal: AbortSignal | undefined;
let clockReads = 0;
const audit = new CodexCliAuditDispatcher({ command: "local-backoff-cancel", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 5000, retry: { baseMs: 300, maxMs: 300, budgetMs: 10000, jitterRatio: 0 },
  ...(mode === "default-delay" ? { now: () => {
    if (++clockReads === 2) queueMicrotask(() => { enterSleep(); audit.cancel(workflowId); });
    return Date.now();
  } } : { sleep: async (_ms: number, signal?: AbortSignal) => {
    sleepSignal = signal;
    enterSleep();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      const listening = mode !== "stop-wait" && mode !== "late-wakeup";
      if (listening && signal?.aborted) return abort();
      if (listening) signal?.addEventListener("abort", abort, { once: true });
      released.then(resolve).finally(() => signal?.removeEventListener("abort", abort));
    });
  } }),
  spawn: (_command, _args, options) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-backoff-cancel-backend.mjs", import.meta.url)),
      children.length === 0 ? mode === "create-review" ? "bound-overload" : "overload" : "success"],
      { ...options, windowsHide: true });
    children.push(child);
    log("backend-start", { pid: child.pid });
    return child;
  },
});
const normalize = (id = submissionId) => audit.normalize({ workflowId, submissionId: id, cwd: directory, visibleText: "Local conversion" }, runSignal);
const request = { workflowId, submissionId, cwd: directory, prompt: "Local review", codexThreadId: "original-reviewer" };
const operation = (mode === "review" ? audit.review(request, caller.signal)
  : mode === "create-review" ? audit.createReview({ ...request, onThread: async () => undefined }, caller.signal)
  : mode === "align" ? audit.align({ ...request, result: { verdict: "pass", findings: [], testGaps: [], summary: "ok" }, task: "Local alignment" }, caller.signal)
  : mode === "reconcile" ? audit.reconcile(request, caller.signal)
  : normalize()).then(() => { settled = true; }, error => { settled = true; operationError = error; });
try {
  await Promise.race([sleeping, operation.then(() => { throw new Error("Operation settled without reaching its backoff boundary"); })]);
  assert.equal(children.length, 1); assert.equal(children[0]!.exitCode, 1);
  if (mode === "peer") { peer = normalize("peer-submission"); await peer; }
  if (mode === "wrong-target") {
    audit.cancel("foreign-workflow"); audit.cancelSubmission(workflowId, "foreign-submission");
    for (let count = 0; count < 5; count++) await tick();
    assert.equal(settled, false); assert.equal(sleepSignal?.aborted, false);
    releaseSleep(); await operation; assert.equal(operationError, undefined); assert.equal(children.length, 2);
  } else {
    if (mode === "caller-first") caller.abort(callerCause);
    if (mode === "stop" || mode === "stop-wait") stopping = audit.stop().then(() => { stopSettled = true; });
    else if (mode === "submission" || mode === "peer") audit.cancelSubmission(workflowId, submissionId);
    else { audit.cancel(workflowId); if (mode === "repeated") audit.cancel(workflowId); }
    if (mode === "api-first") caller.abort(callerCause);
    for (let count = 0; count < 5; count++) await tick();
    if (mode === "stop-wait" || mode === "late-wakeup") {
      log("held-sleep-after-cancellation", { settled, stopSettled, childStarts: children.length, signalAborted: Boolean(sleepSignal?.aborted) });
      assert.equal(settled, false);
      if (mode === "stop-wait") assert.equal(stopSettled, false, "stop must wait for the owned retry operation to unwind");
      assert.equal(sleepSignal?.aborted, true);
      releaseSleep(); await operation; await stopping;
    } else {
      log("cancelled-before-wakeup", { settled, childStarts: children.length,
        signalAborted: sleepSignal?.aborted, productionDelay: mode === "default-delay" });
      assert.equal(settled, true, "Cancellation settles the original operation during backoff, before any wakeup");
    }
    assert.ok(operationError instanceof Error);
    if (mode === "caller-first") assert.equal(operationError, callerCause);
    else assert.match(operationError.message, mode.startsWith("stop") ? /dispatcher stopped/ : mode === "submission" || mode === "peer" ? /submission lease lost/ : /audit cancelled/);
    assert.equal(children.length, mode === "peer" ? 2 : 1, "No cancelled retry starts another model process");
    releaseSleep(); await operation; await stopping;
    if (mode === "reuse") { await normalize(); assert.equal(children.length, 2, "A new explicit call is not permanently blacklisted"); }
  }
  await tick();
  assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
  assert.equal((audit as unknown as { pendingRuns: Set<unknown> }).pendingRuns.size, 0);
  log("actor-complete", { childStarts: children.length, error: operationError instanceof Error ? operationError.message : undefined });
} finally {
  releaseSleep(); await operation; await peer; await stopping; await audit.stop();
}

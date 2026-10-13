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
const visible = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ok";
const verdict = { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" };
const workflowId = "original-workflow", submissionId = "original-submission";
const cached = mode.startsWith("cached-");
const children: ChildProcess[] = [];
let enterCapture!: () => void, releaseCapture!: () => void, enterPeer!: () => void, releasePeer!: () => void;
const capturing = new Promise<void>(resolve => { enterCapture = resolve; });
const captured = new Promise<void>(resolve => { releaseCapture = resolve; });
const peerCapturing = new Promise<void>(resolve => { enterPeer = resolve; });
const peerCaptured = new Promise<void>(resolve => { releasePeer = resolve; });
const caller = new AbortController(), callerCause = new Error("original caller reason"), captureCause = new Error("original capture failed");
if (mode === "cached-pre-abort") { caller.abort(callerCause); releaseCapture(); }
let captureCalls = 0, settled = false, operationError: unknown, stopSettled = false;
let stopping: Promise<void> | undefined, peer: Promise<unknown> | undefined;
const audit = new CodexCliAuditDispatcher({ command: "local-pipeline-cancel", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 5000, retry: { budgetMs: 0 },
  spawn: (_command, _args, options) => {
    const text = children.length === 0 && !cached ? visible : JSON.stringify(verdict);
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-pipeline-cancel-backend.mjs", import.meta.url)), text],
      { ...options, windowsHide: true });
    children.push(child); log("backend-start", { pid: child.pid }); return child;
  },
});
const request = { workflowId, submissionId, codexThreadId: "original-reviewer", cwd: directory, prompt: "Local review" };
const capture = async (text: string) => {
  assert.equal(text, visible); captureCalls++; enterCapture(); await captured;
  if (mode === "capture-error") throw captureCause;
};
const operation = (mode === "review-callback" ? audit.review({ ...request, onThread: async () => { captureCalls++; enterCapture(); await captured; } }, caller.signal)
  : audit.reconcile(request, caller.signal, { ...(cached ? { visibleText: visible } : {}), captureVisibleText: capture }))
  .then(() => { settled = true; }, error => { settled = true; operationError = error; });
try {
  if (mode === "cached-pre-abort") {
    await operation; assert.equal(operationError, callerCause); assert.equal(captureCalls, 0); assert.equal(children.length, 0);
  } else {
    await Promise.race([capturing, operation.then(() => { throw new Error("Original operation never reached its admitted callback"); })]);
    const initialChildren = mode === "review-callback" ? 2 : cached ? 0 : 1;
    assert.equal(children.length, initialChildren);
    if (mode === "peer") {
      peer = audit.reconcile({ ...request, submissionId: "peer-submission" }, undefined,
        { visibleText: visible, captureVisibleText: async () => { enterPeer(); await peerCaptured; } });
      await peerCapturing;
    }
    if (mode === "wrong-target") { audit.cancel("foreign-workflow"); audit.cancelSubmission(workflowId, "foreign-submission"); }
    else if (mode !== "capture-error") {
      if (mode === "caller" || mode === "caller-first") caller.abort(callerCause);
      if (mode === "stop" || mode === "cached-stop") stopping = audit.stop().then(() => { stopSettled = true; });
      else if (mode.includes("submission") || mode === "peer") audit.cancelSubmission(workflowId, submissionId);
      else { audit.cancel(workflowId); if (mode === "repeated") audit.cancel(workflowId); }
      if (mode === "api-first") caller.abort(callerCause);
    }
    for (let count = 0; count < 5; count++) await tick();
    log("held-admitted-callback", { settled, stopSettled, captureCalls, childStarts: children.length });
    assert.equal(settled, false, "An admitted persistence callback remains owned until it settles");
    if (stopping) assert.equal(stopSettled, false, "Stop waits for the original admitted callback");
    releaseCapture(); releasePeer(); await operation; await peer; await stopping;
    if (mode === "wrong-target") { assert.equal(operationError, undefined); assert.equal(children.length, 2); }
    else if (mode === "capture-error") { assert.equal(operationError, captureCause); assert.equal(children.length, 1); }
    else {
      assert.ok(operationError instanceof Error);
      if (mode === "caller" || mode === "caller-first") assert.equal(operationError, callerCause);
      else assert.match(operationError.message, mode.includes("stop") ? /dispatcher (?:is )?stopped/ : mode.includes("submission") || mode === "peer" ? /submission lease lost/ : /audit cancelled/);
      assert.equal(children.length, initialChildren + (mode === "peer" ? 1 : 0), "Cancellation cannot start a downstream model stage");
      if (mode === "reuse") { await audit.normalize({ workflowId, submissionId, cwd: directory, visibleText: visible }); assert.equal(children.length, 2); }
    }
    assert.equal(captureCalls, 1, "The original capture is never replayed");
  }
  await tick();
  assert.equal((audit as unknown as { pendingRuns: Set<unknown> }).pendingRuns.size, 0);
  assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
  log("actor-complete", { captureCalls, childStarts: children.length, error: operationError instanceof Error ? operationError.message : undefined });
} finally { releaseCapture(); releasePeer(); await operation; await peer; await stopping; await audit.stop(); }

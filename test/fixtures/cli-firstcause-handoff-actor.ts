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
const verdict = { verdict: "pass", findings: [], testGaps: [], summary: "ok" };
const cached = mode.startsWith("cached-"), review = mode.startsWith("review-");
const kind = mode.replace(/^(?:cached|live|review)-/, "");
const children: ChildProcess[] = [];
const caller = new AbortController(), cause = new Error("original caller before stop"), captureCause = new Error("original capture failure");
let enterCapture!: () => void, releaseCapture!: () => void;
const capturing = new Promise<void>(resolve => { enterCapture = resolve; });
const captured = new Promise<void>(resolve => { releaseCapture = resolve; });
let captureCalls = 0, settled = false, error: unknown, stopSettled = false, expectedCause: unknown = cause;
let stopping: Promise<void> | undefined;
const audit = new CodexCliAuditDispatcher({ command: "local-firstcause-handoff", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 5000, retry: { budgetMs: 0 },
  spawn: (_command, _args, options) => {
    const text = children.length === 0 && !cached ? visible : JSON.stringify(verdict);
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-pipeline-cancel-backend.mjs", import.meta.url)), text],
      { ...options, windowsHide: true });
    children.push(child); log("backend-start", { pid: child.pid }); return child;
  },
});
const request = { workflowId: "original-workflow", submissionId: "original-submission", codexThreadId: "original-reviewer", cwd: directory, prompt: "Local reconciliation" };
const capture = async () => { captureCalls++; enterCapture(); await captured; if (kind === "capture-error") throw captureCause; };
if (kind === "pre-stopped") await audit.stop();
if (kind === "pre-stopped" || kind === "pre-aborted") { caller.abort(cause); releaseCapture(); }
const operation = (review ? audit.review({ ...request, onThread: capture }, caller.signal)
  : audit.reconcile(request, caller.signal, { ...(cached ? { visibleText: visible } : {}), captureVisibleText: capture }))
  .then(() => { settled = true; }, value => { settled = true; error = value; });
try {
  if (kind === "pre-stopped" || kind === "pre-aborted") {
    await operation; assert.ok(error instanceof Error);
    if (kind === "pre-stopped") assert.match(error.message, /dispatcher is stopped/); else assert.equal(error, cause);
    assert.equal(captureCalls, 0); assert.equal(children.length, 0);
  } else {
    await Promise.race([capturing, operation.then(() => { throw new Error("Original callback was never admitted"); })]);
    const admittedChildren = review ? 2 : cached ? 0 : 1;
    assert.equal(children.length, admittedChildren);
    if (kind === "caller-first" || kind === "identity-drift") caller.abort(cause);
    else if (kind === "default-first") { caller.abort(); expectedCause = caller.signal.reason; }
    else if (kind === "string-first") caller.abort("original string cancellation");
    else if (kind === "workflow-first") audit.cancel(request.workflowId);
    else if (kind === "submission-first") audit.cancelSubmission(request.workflowId, request.submissionId);
    if (kind === "identity-drift") request.workflowId = "displaced-workflow";
    stopping = audit.stop().then(() => { stopSettled = true; });
    if (kind === "stop-first") caller.abort(cause);
    for (let count = 0; count < 5; count++) await tick();
    log("held-original-callback", { settled, stopSettled, childStarts: children.length });
    assert.equal(settled, false); assert.equal(stopSettled, false, "Stop retains original callback ownership");
    releaseCapture(); await operation; await stopping;
    log("resolved-original-callback", { reason: error instanceof Error ? error.message : undefined, firstCallerCause: error === expectedCause });
    assert.ok(error instanceof Error);
    if (kind === "caller-first" || kind === "default-first") assert.equal(error, expectedCause, "The inherited original cause survives later stop");
    else if (kind === "string-first") assert.equal(error.message, "codex CLI audit aborted", "Non-Error caller reasons retain the existing fallback");
    else if (kind === "workflow-first") assert.equal(error.message, "codex CLI audit cancelled");
    else if (kind === "submission-first") assert.equal(error.message, "codex CLI audit submission lease lost");
    else if (kind === "capture-error") assert.equal(error, captureCause);
    else if (kind === "identity-drift") assert.equal(error.message, "codex CLI audit dispatcher is stopped", "A different identity cannot inherit another operation's admission");
    else assert.match(error.message, /dispatcher (?:is )?stopped/);
    assert.equal(children.length, admittedChildren, "Cancellation and stop never start a downstream model");
    assert.equal(captureCalls, 1);
  }
  await tick();
  assert.equal((audit as unknown as { pendingRuns: Set<unknown> }).pendingRuns.size, 0);
  assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
  log("actor-complete", { captureCalls, childStarts: children.length, reason: error instanceof Error ? error.message : undefined });
} finally { releaseCapture(); await operation; await stopping; await audit.stop(); }

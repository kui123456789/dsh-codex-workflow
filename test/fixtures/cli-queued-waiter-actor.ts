import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAuditDispatcher } from "../../src/codex-cli-audit.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", { message: error.message }));
const controller = new AbortController(), cause = new Error("original queued caller cancelled");
const ownerController = new AbortController(), peerController = new AbortController();
let releaseBinding!: () => void, bindingEntered = false, ready!: Promise<void>, originalClosed!: Promise<void>;
let starts = 0, killRequests = 0;
const children: ChildProcess[] = [];
const bindingGate = new Promise<void>(resolve => { releaseBinding = resolve; });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const audit = new CodexCliAuditDispatcher({ command: "local-queued-waiter", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 10_000, retry: { budgetMs: 0 },
  spawn: (_command, args, options) => {
    starts++;
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-queued-waiter-backend.mjs", import.meta.url)),
      starts === 1 ? mode === "binding-owner" ? "binding" : "held" : "immediate"],
    { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    children.push(child);
    if (starts === 1) { ready = new Promise<void>(resolve => child.once("message", () => resolve())); originalClosed = new Promise<void>(resolve => child.once("close", () => resolve())); }
    const kill = child.kill.bind(child); child.kill = signal => { killRequests++; return kill(signal); };
    log("backend-start", { pid: child.pid, args }); return child;
  },
});
type RunEntry = { run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string, signal?: AbortSignal,
  threadId?: string, onNewThread?: (threadId: string) => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> };
const run = (audit as unknown as RunEntry).run.bind(audit);
const originalThread = mode === "binding-owner" ? "01234567-89ab-4def-8123-456789abcdef" : "original-reviewer";
let owner!: ReturnType<RunEntry["run"]>, queued: Promise<unknown> | undefined, peer: ReturnType<RunEntry["run"]> | undefined;
try {
  owner = run("original-workflow", "original-submission", [], "Original prompt", ownerController.signal,
    mode === "binding-owner" ? undefined : originalThread, mode === "binding-owner" ? async id => {
      assert.equal(id, originalThread); bindingEntered = true; await bindingGate;
    } : undefined);
  if (mode === "binding-owner") { await originalClosed; assert.equal(bindingEntered, true); }
  else await ready;
  if (mode === "preaborted") controller.abort(cause);
  let settled = false, error: unknown, queuedValue: unknown;
  queued = (mode === "public-caller"
    ? audit.review({ workflowId: "queued-workflow", submissionId: "queued-submission", codexThreadId: originalThread,
      cwd: directory, prompt: "Queued original review" }, controller.signal)
    : run("queued-workflow", "queued-submission", [], "Queued prompt", controller.signal,
      mode === "different-thread" ? "independent-reviewer" : originalThread)).then(value => { settled = true; queuedValue = value; },
    caught => { settled = true; error = caught; });
  if (mode === "peer-waiter") peer = run("peer-workflow", "peer-submission", [], "Peer prompt", peerController.signal, originalThread);
  await tick(); await tick();
  if (mode === "different-thread") {
    await queued; assert.equal(error, undefined); assert.ok(queuedValue);
    assert.equal(starts, 2); assert.equal(children[0]!.exitCode, null); assert.equal(killRequests, 0);
    log("independent-thread-finished", { starts, ownerAlive: children[0]!.exitCode === null });
  } else if (mode === "control") {
    assert.equal(settled, false); assert.equal(starts, 1);
    children[0]!.send!({ finish: true }); await owner; await queued;
    assert.equal(error, undefined); assert.ok(queuedValue); assert.equal(starts, 2);
  } else {
    if (mode === "release-race") children[0]!.send!({ finish: true });
    if (mode === "default-reason") controller.abort(); else controller.abort(cause);
    await tick(); await tick();
    log("cancelled-before-owner-finished", { settled, sameCause: error === controller.signal.reason, starts, killRequests,
      ownerExitCode: children[0]!.exitCode, ownerSignalCode: children[0]!.signalCode,
      abortListeners: getEventListeners(controller.signal, "abort").length,
      ownerAborted: ownerController.signal.aborted, peerAborted: peerController.signal.aborted });
    assert.equal(settled, true, "Queued cancellation settles before the original owner completes");
    assert.equal(error, controller.signal.reason); assert.equal(starts, 1); assert.equal(killRequests, 0);
    assert.equal(ownerController.signal.aborted, false); assert.equal(peerController.signal.aborted, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    if (mode === "binding-owner") releaseBinding(); else if (mode !== "release-race") children[0]!.send!({ finish: true });
    await owner; await queued; if (peer) await peer;
    assert.equal(starts, mode === "peer-waiter" ? 2 : 1);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(killRequests, 0);
  controller.abort(new Error("late waiter cancel")); assert.equal(killRequests, 0);
  log("actor-complete", { starts, killRequests, listenerCount: getEventListeners(controller.signal, "abort").length });
} finally {
  releaseBinding();
  if (children[0]?.connected) children[0].send!({ finish: true });
  await Promise.allSettled([owner, queued, peer]); await audit.stop();
}

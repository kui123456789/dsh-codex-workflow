import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAuditDispatcher } from "../../src/codex-cli-audit.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", { message: error.message }));
const children: ChildProcess[] = [];
let ready!: Promise<void>, closed!: Promise<void>, autoFinish = false, killRequests = 0, bindingEntered = false;
let releaseBinding!: () => void;
const bindingGate = new Promise<void>(resolve => { releaseBinding = resolve; });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const binding = mode === "workflow-binding" || mode === "stop-binding";
const sharedWorkflow = mode.includes("submission") || mode === "peer";
const ownerWorkflow = sharedWorkflow ? "shared-workflow" : "owner-workflow";
const queuedWorkflow = sharedWorkflow ? ownerWorkflow : "queued-workflow";
const thread = binding ? "01234567-89ab-4def-8123-456789abcdef" : "same-reviewer";
const caller = new AbortController(), callerCause = new Error("original caller reason wins");
let spawnObservations = 0;
const audit = new CodexCliAuditDispatcher({ command: "local-targeted-queue", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 10_000, retry: { budgetMs: 0 },
  onSpawn: () => {
    spawnObservations++;
    if (mode === "onspawn-cancel" && spawnObservations === 2) audit.cancel(queuedWorkflow);
  },
  spawn: (_command, args, options) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-queued-waiter-backend.mjs", import.meta.url)),
      children.length === 0 ? binding ? "binding" : "held" : "immediate"],
      { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    children.push(child); const kill = child.kill.bind(child); child.kill = signal => { killRequests++; return kill(signal); };
    if (children.length === 1) {
      ready = new Promise<void>(resolve => child.once("message", () => { resolve(); if (autoFinish && child.connected) child.send!({finish:true}); }));
      closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    }
    log("backend-start", { pid: child.pid, args });
    if (mode === "spawn-cancel" && children.length === 2) audit.cancel(queuedWorkflow);
    return child;
  },
});
type RunEntry = { run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string, signal?: AbortSignal,
  threadId?: string, onNewThread?: (threadId: string) => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> };
const run = (audit as unknown as RunEntry).run.bind(audit);
let owner!: ReturnType<RunEntry["run"]>, queued: Promise<unknown> | undefined, peer: ReturnType<RunEntry["run"]> | undefined;
let stopping: Promise<void> | undefined;
try {
  owner = run(ownerWorkflow, "owner-submission", [], "Owner prompt", undefined, binding ? undefined : thread,
    binding ? async id => { assert.equal(id, thread); bindingEntered = true; await bindingGate; } : undefined);
  let ownerError: unknown;
  const ownerResult = owner.catch(error => { ownerError = error; });
  if (binding) { await closed; assert.equal(bindingEntered, true); } else await ready;
  let queuedSettled = false, queuedError: unknown;
  const pending = mode.startsWith("public")
    ? audit.review({ workflowId: queuedWorkflow, submissionId: "cancel-submission", codexThreadId: thread, cwd: directory, prompt: "Queued public review" })
    : run(queuedWorkflow, "cancel-submission", [], "Queued prompt", mode === "caller-first" || mode === "api-first" ? caller.signal : undefined, thread);
  queued = pending.then(value => { queuedSettled = true; return value; }, error => { queuedSettled = true; queuedError = error; });
  if (mode === "peer") peer = run(ownerWorkflow, "peer-submission", [], "Peer prompt", undefined, thread);
  await tick(); await tick(); assert.equal(children.length, 1);
  if (mode === "onspawn-cancel" || mode === "spawn-cancel") {
    children[0]!.send!({finish:true}); await ownerResult; await queued;
    assert.ok(queuedError instanceof Error); assert.match(queuedError.message, /audit cancelled/);
    assert.equal(spawnObservations, 2);
    if (mode === "spawn-cancel") {
      assert.equal(children.length, 2); assert.ok(killRequests >= 1);
      assert.ok(children[1]!.exitCode !== null || children[1]!.signalCode !== null);
    } else { assert.equal(children.length, 1); assert.equal(killRequests, 0); }
    log("cancelled-before-spawn", { actualChildren: children.length, spawnObservations, queuedError: queuedError.message });
  } else if (mode === "wrong-target") {
    audit.cancel("foreign-workflow"); audit.cancelSubmission(queuedWorkflow, "foreign-submission");
    await tick(); await tick(); assert.equal(queuedSettled, false); assert.equal(killRequests, 0);
    children[0]!.send!({finish:true}); await ownerResult; await queued;
    assert.equal(queuedError, undefined); assert.equal(children.length, 2);
  } else {
    if (mode === "caller-first") caller.abort(callerCause);
    if (mode === "stop-binding") stopping = audit.stop();
    else if (mode.includes("submission") || mode === "peer") audit.cancelSubmission(queuedWorkflow, "cancel-submission");
    else { audit.cancel(queuedWorkflow); if (mode === "repeated-workflow") audit.cancel(queuedWorkflow); }
    if (mode === "api-first") caller.abort(callerCause);
    await tick(); await tick();
    log("target-cancelled-before-owner", { queuedSettled, starts: children.length, killRequests, bindingEntered,
      ownerExitCode: children[0]!.exitCode, ownerSignalCode: children[0]!.signalCode, queuedError: queuedError instanceof Error ? queuedError.message : undefined });
    assert.equal(queuedSettled, true, "Targeted cancellation finds the original waiting call");
    assert.ok(queuedError instanceof Error);
    if (mode === "caller-first") assert.equal(queuedError, callerCause);
    else assert.match(queuedError.message, mode === "stop-binding" ? /dispatcher.*stopped/ : mode.includes("submission") || mode === "peer" ? /submission lease lost/ : /audit cancelled/);
    assert.equal(children.length, 1); assert.equal(killRequests, 0);
    if (binding) releaseBinding(); else children[0]!.send!({finish:true});
    await ownerResult; await queued; if (peer) await peer; await stopping;
    if (mode === "stop-binding") { assert.ok(ownerError instanceof Error); assert.match(ownerError.message, /dispatcher stopped/); }
    else assert.equal(ownerError, undefined);
    assert.equal(children.length, mode === "peer" ? 2 : 1);
    if (mode === "reuse") {
      const result = await run(queuedWorkflow, "cancel-submission", [], "New explicit call", undefined, thread);
      assert.equal(result.code, 0); assert.equal(children.length, 2);
    }
  }
  await tick(); await tick();
  assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
  assert.equal((audit as unknown as { threadReservations: Map<string, unknown> }).threadReservations.size, 0);
  assert.equal((audit as unknown as { pendingRuns: Set<unknown> }).pendingRuns.size, 0);
  log("actor-complete", { actualChildren: children.length, killRequests, pendingRuns: 0 });
} finally {
  autoFinish = true; releaseBinding();
  if (children[0]?.connected) children[0].send!({finish:true});
  await Promise.allSettled([owner, queued, peer, stopping]); await audit.stop();
}

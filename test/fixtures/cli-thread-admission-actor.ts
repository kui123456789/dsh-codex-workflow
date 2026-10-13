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
const children: ChildProcess[] = [], readiness: Promise<void>[] = [], closes: Promise<void>[] = [], prompts: string[] = [];
let autoFinish = false, killRequests = 0, spawnAttempts = 0, releaseBinding!: () => void, bindingEntered = false;
const bindingGate = new Promise<void>(resolve => { releaseBinding = resolve; });
let firstReady!: () => void, firstClosed!: () => void;
const originalReady = new Promise<void>(resolve => { firstReady = resolve; });
const originalClosed = new Promise<void>(resolve => { firstClosed = resolve; });
const controllers = [new AbortController(), new AbortController(), new AbortController()];
const cause = new Error("cancelled reserved caller");
const spawnFailure = new Error("original synchronous spawn rejected");
const audit = new CodexCliAuditDispatcher({ command: "local-thread-admission", reviewSchemaFile: "unused", alignmentSchemaFile: "unused",
  timeoutMs: 10_000, retry: { budgetMs: 0 },
  spawn: (_command, args, options) => {
    spawnAttempts++;
    if (mode === "spawn-throw" && spawnAttempts === 1) { log("spawn-rejected"); throw spawnFailure; }
    const backendMode = args.includes("--output-schema") ? "normalization" : mode === "binding" && children.length === 0 ? "binding" : "held";
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-thread-admission-backend.mjs", import.meta.url)), backendMode],
      { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    const index = children.length; children.push(child); prompts.push("");
    const originalWrite = child.stdin!.end.bind(child.stdin!);
    child.stdin!.end = ((...values: Parameters<typeof originalWrite>) => { if (typeof values[0] === "string") prompts[index] += values[0]; return Reflect.apply(originalWrite, child.stdin!, values); }) as typeof originalWrite;
    const kill = child.kill.bind(child); child.kill = signal => { killRequests++; return kill(signal); };
    log("backend-start", { index, pid: child.pid, args, backendMode });
    closes.push(new Promise<void>(resolve => child.once("close", () => { resolve(); if (index === 0) firstClosed(); })));
    readiness.push(new Promise<void>(resolve => child.once("message", () => { resolve(); if (index === 0) firstReady(); if (autoFinish && child.connected) child.send!({ finish: true }); })));
    return child;
  },
});
type RunEntry = { run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string, signal?: AbortSignal,
  threadId?: string, onNewThread?: (threadId: string) => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> };
const run = (audit as unknown as RunEntry).run.bind(audit);
const thread = mode === "binding" ? "01234567-89ab-4def-8123-456789abcdef" : "same-reviewer";
const operations: Promise<unknown>[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const invoke = (label: string, signal?: AbortSignal, target = thread) => {
  const task = mode === "public"
    ? audit.review({ workflowId: label, submissionId: label, codexThreadId: target, cwd: directory, prompt: label }, signal)
    : run(label, label, [], label, signal, target);
  operations.push(task); return task;
};
try {
  if (mode === "spawn-throw") {
    const rejected = invoke("rejected").catch(error => error); await tick();
    const next = invoke("next");
    assert.equal(await rejected, spawnFailure); await originalReady; assert.equal(children.length, 1);
    children[0]!.send!({ finish: true }); await next; assert.equal(spawnAttempts, 2);
  } else if (mode === "fresh") {
    const first = invoke("first"), second = invoke("second"); await originalReady;
    assert.equal(children.length, 1, "Fresh contenders cannot both admit the same Reviewer");
    children[0]!.send!({ finish: true }); await first; await tick(); await tick();
    assert.equal(children.length, 2); await readiness[1]; children[1]!.send!({ finish: true }); await second;
  } else {
    const owner = mode === "binding"
      ? run("owner", "owner", [], "owner", undefined, undefined, async id => { bindingEntered = true; assert.equal(id, thread); await bindingGate; })
      : invoke("owner");
    let ownerError: unknown;
    const observeOwner = owner.catch(error => { ownerError = error; });
    if (mode === "binding") { operations.push(owner); await originalClosed; assert.equal(bindingEntered, true); } else await originalReady;
    const first = invoke("first", controllers[0]!.signal), second = invoke("second", controllers[1]!.signal,
      mode === "different-thread" ? "independent-reviewer" : thread);
    let firstError: unknown, secondError: unknown;
    const observeFirst = first.catch(error => { firstError = error; }), observeSecond = second.catch(error => { secondError = error; });
    if (mode === "stop") {
      await tick(); await tick(); assert.equal(children.length, 1);
      await audit.stop(); await Promise.all([observeOwner, observeFirst, observeSecond]);
      for (const error of [ownerError, firstError, secondError]) {
        assert.ok(error instanceof Error); assert.match(error.message, /dispatcher.*stopped/);
      }
      assert.equal(children.length, 1);
      assert.ok(children[0]!.exitCode !== null || children[0]!.signalCode !== null);
    } else if (mode === "different-thread") {
      await tick(); await tick(); assert.equal(children.length, 2); await readiness[1];
      assert.equal(children[0]!.exitCode, null); children[1]!.send!({ finish: true }); await second;
      children[0]!.send!({ finish: true }); await owner; await tick(); await tick();
      assert.equal(children.length, 3); await readiness[2]; children[2]!.send!({ finish: true }); await first;
    } else {
      await tick(); await tick(); assert.equal(children.length, 1);
      if (mode === "cancel-first") controllers[0]!.abort(cause);
      if (mode === "cancel-last") controllers[1]!.abort(cause);
      if (mode.startsWith("cancel")) {
        await tick(); await tick(); assert.equal(mode === "cancel-first" ? firstError : secondError, cause);
        assert.equal(children.length, 1); assert.equal(killRequests, 0);
      }
      if (mode === "binding") releaseBinding(); else children[0]!.send!({ finish: true }); await owner;
      // Let admitted callers finish their synchronous spawn microtasks before
      // observing which original processes actually acquired the thread.
      await tick(); await tick();
      const held = children.filter(child => child.exitCode === null && child.signalCode === null);
      log("after-owner-release", { children: children.length, active: held.length, prompts });
      if (mode !== "public") assert.equal(children.length, 2, "Only the first non-cancelled contender is admitted");
      const admittedIndex = children.findIndex((child, index) => index > 0 && child.exitCode === null && child.signalCode === null);
      assert.ok(admittedIndex > 0); await readiness[admittedIndex];
      assert.equal(prompts[admittedIndex], mode === "cancel-first" ? "second" : "first");
      children[admittedIndex]!.send!({ finish: true });
      if (mode === "cancel-first") { await second; await observeFirst; }
      else if (mode === "cancel-last") { await first; await observeSecond; }
      else {
        await first; await tick(); await tick();
        const laterIndex = children.findIndex((child, index) => index > admittedIndex && child.exitCode === null && child.signalCode === null);
        assert.ok(laterIndex > admittedIndex); await readiness[laterIndex]; assert.equal(prompts[laterIndex], "second");
        children[laterIndex]!.send!({ finish: true }); await second;
      }
    }
    await Promise.all([observeFirst, observeSecond]);
  }
  await tick(); await tick();
  if (mode === "stop") assert.ok(killRequests >= 1); else assert.equal(killRequests, 0);
  assert.equal((audit as unknown as { children: Map<number, unknown> }).children.size, 0);
  assert.equal((audit as unknown as { threadReservations: Map<string, Promise<void>> }).threadReservations.size, 0);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  log("actor-complete", { actualChildren: children.length, spawnAttempts, prompts, killRequests, remainingReservations: 0 });
} finally {
  autoFinish = true; releaseBinding();
  for (const child of children) if (child.connected) child.send!({ finish: true });
  await Promise.allSettled(operations); await audit.stop();
}

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";
import { captureProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";
import { sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";

const [mode, directoryArg] = process.argv.slice(2);
assert.ok(directoryArg);
const directory = directoryArg;
const protocol = fileURLToPath(new URL("./fake-pending-receipt-app-server.mjs", import.meta.url));
const state = join(directory, "states.jsonl"), wire = join(directory, "wire.jsonl"), gates = join(directory, "gates.jsonl");
let client = new CodexAppServerClient({ command: process.execPath, args: [protocol, wire, gates],
  requestTimeoutMs: 15000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
let port = client as unknown as { child: ChildProcess; pending: Map<unknown, unknown>; turnWaiters: number; pinned: number };
let started = 0, originalPid: number | undefined;
let evidence: Awaited<ReturnType<typeof captureProcessTreeEvidence>>;
const log = (kind: string, detail: object = {}) => appendFileSync(state, JSON.stringify({ kind, sdkWorkerPid: process.pid,
  originalPid, rawPending: port.pending.size, started, waiters: port.turnWaiters, ...detail }) + "\n");
const rows = (): any[] => readFileSync(wire, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
async function gate(command: object) {
  const before = rows().filter((row) => row.kind === "gate-processed").length;
  appendFileSync(gates, JSON.stringify(command) + "\n");
  await sharedWaitFor(() => rows().filter((row) => row.kind === "gate-processed").length > before,
    "the actual upstream processed its file gate");
}
function chain(error: unknown) {
  const result: object[] = [];
  let current = error;
  while (current instanceof Error && result.length < 4) {
    const value = current as Error & { cleanupOnly?: boolean; threadId?: string; turnId?: string };
    result.push({ name: value.name, message: value.message, cleanupOnly: value.cleanupOnly, threadId: value.threadId, turnId: value.turnId });
    current = value.cause;
  }
  return result;
}
process.on("uncaughtExceptionMonitor", (error: Error, origin) => log("uncaught-monitor", { origin, chain: chain(error) }));
log("actor-start", { mode });
async function prepare() {
  await client.start(); originalPid = port.child.pid; evidence = await captureProcessTreeEvidence(originalPid);
  log("captured-owned-tree", { processIds: evidence?.processIds, processIdentities: evidence?.processIdentities });
  let incoming = "";
  // Observe actual pipe bytes before Readline consumes a combined chunk;
  // this preserves the before-receipt counts even under host contention.
  port.child.stdout!.prependListener("data", (chunk: Buffer) => {
    incoming += String(chunk);
    let end: number;
    while ((end = incoming.indexOf("\n")) >= 0) {
      const message = JSON.parse(incoming.slice(0, end)); incoming = incoming.slice(end + 1);
      if (String(message.id).startsWith("synthetic-early-input-")) log("actual-frame-observed", { variant: String(message.id).slice(22) });
    }
  });
}
async function retired() {
  if (evidence?.processIds) await sharedWaitFor(() => evidence!.processIds.every((pid) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }), "all actual owned process PIDs exited");
}
const startedReceipt = (pair: { threadId: string; turnId: string }) => {
  started += 1; log("authoritative-start-receipt", pair);
};
const observe = <T>(task: Promise<T>) => task.then((result) => ({ result, error: undefined }),
  (error: unknown) => ({ result: undefined, error }));
async function main() {
  const tasks: Promise<unknown>[] = [];
  try {
    await prepare();
    const thread = await client.startThread({ cwd: directory, ephemeral: true });
    const task = mode === "detached"
      ? observe(client.startReview({ threadId: thread, cwd: directory, detached: true,
        target: { type: "custom", instructions: "Synthetic detached pending review" }, onStarted: startedReceipt }))
        .then((outcome) => ({ result: outcome.result?.result, error: outcome.error }))
      : observe(client.startTurn(thread, { prompt: "Synthetic original pending receipt diagnostic", onStarted: startedReceipt }));
    tasks.push(task);
    await sharedWaitFor(() => rows().some((row) => row.kind === "actual-writer-accepted"), "actual writer accepted original RPC");
    if (mode === "ambiguous") {
      const peerThread = await client.startThread({ cwd: directory, ephemeral: true });
      const peer = observe(client.startTurn(peerThread, { prompt: "Independent original receipt peer", onStarted: startedReceipt }));
      tasks.push(peer);
      await sharedWaitFor(() => rows().filter((row) => row.kind === "actual-writer-accepted").length === 2, "two genuine pending receipts");
      await gate({ kind: "frame", variant: "no-scope" }); await gate({ kind: "frame", variant: "turn-only" });
      await gate({ kind: "receipt", index: 0 }); await gate({ kind: "receipt", index: 1 });
      await sharedWaitFor(() => started === 2, "both original receipts adopted independently");
      await gate({ kind: "complete", index: 0 }); await gate({ kind: "complete", index: 1 });
      const outcomes = await Promise.all([task, peer]);
      log("ambiguous-outcomes", { outcomes: outcomes.map((outcome) => ({ kind: outcome.result?.kind,
        usableText: outcome.result?.kind === "completed" && Boolean(outcome.result.text), chain: chain(outcome.error) })) });
      return;
    }
    if (mode === "first-cause") {
      await gate({ kind: "frame", variant: "foreign" });
      await gate({ kind: "frame", variant: "bad-question" });
      await gate({ kind: "frame", variant: "matching" });
    } else if (mode !== "healthy") await gate({ kind: "frame", variant: mode === "missing-turn" ? "missing-turn" : "matching" });
    await gate({ kind: "receipt" });
    await sharedWaitFor(() => started === 1, "public original receipt adoption");
    await gate({ kind: "complete" });
    const outcome = await task;
    log("public-outcome", { resultKind: outcome.result?.kind,
      status: outcome.result?.kind === "completed" ? outcome.result.status : undefined,
      usableText: outcome.result?.kind === "completed" && Boolean(outcome.result.text), chain: chain(outcome.error) });
  } finally {
    await client.stop();
    await Promise.allSettled(tasks); await retired();
    log("actor-complete");
  }
}
async function planner() {
  const f = await sharedReviewerFixture();
  client = f.client; port = client as unknown as typeof port;
  (client as unknown as { options: { args: string[] } }).options.args = [protocol, wire, gates];
  try {
    await prepare();
    const task = f.manager.start({ task: "Plan a read-only synthetic pending-receipt diagnostic" }, f.exec);
    void task.catch(() => undefined);
    await sharedWaitFor(() => rows().some((row) => row.kind === "actual-writer-accepted"), "the genuine original Planner writer accepted its RPC");
    await gate({ kind: "frame", variant: "matching" }); await gate({ kind: "receipt" });
    // The actual upstream writer remains active after the failed ACK. No
    // invented completion authorizes its release or consumes another model.
    const waiting = await task;
    const held = f.runtime.recoverableRuns.get(waiting.id);
    const original = rows().find((row) => row.kind === "actual-writer-accepted");
    log("planner-waiting", { row: waiting, threadId: held?.threadId, turnId: held?.interruptionTurnId,
      automaticContinuations: held?.plannerCheckpoint?.automaticContinuations, primary: held?.terminalFailure,
      childIds: f.children.map((child) => child.id), disposals: [...f.rawDisposals], pin: port.pinned, original,
      stats: await (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request("fixture/stats", {}) });
    if (!waiting.retryState?.awaitingCleanup) return;
    let unconfirmed: unknown;
    try { await f.manager.resume(waiting.id, "Only clean the original delayed-receipt failure", f.exec); }
    catch (error) { unconfirmed = error; }
    log("planner-unconfirmed", { chain: chain(unconfirmed), row: await f.store.load(waiting.id),
      pin: port.pinned, disposals: [...f.rawDisposals],
      stats: await (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request("fixture/stats", {}) });
    await gate({ kind: "confirm" });
    const failed = await f.manager.resume(waiting.id, "Only confirm original cleanup", f.exec);
    log("planner-cleaned", { row: failed, disposals: [...f.rawDisposals], pin: port.pinned,
      recoverable: f.runtime.recoverableRuns.size, children: f.runtime.codexChildSessions.size,
      childTurns: f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length });
  } finally { await f.close(); await retired(); log("actor-complete"); }
}
(mode === "planner" ? planner() : main()).catch((error: unknown) => { log("actor-rejected", { chain: chain(error) }); process.exitCode = 1; });

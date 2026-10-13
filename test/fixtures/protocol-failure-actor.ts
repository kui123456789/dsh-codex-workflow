import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";
import { captureProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";

const [mode, directoryArg] = process.argv.slice(2);
assert.ok(directoryArg);
const directory = directoryArg;
const protocol = fileURLToPath(new URL("./fake-protocol-failure-app-server.mjs", import.meta.url));
const wire = join(directory, "wire.jsonl"), state = join(directory, "states.jsonl");
let client: CodexAppServerClient, evidence: Awaited<ReturnType<typeof captureProcessTreeEvidence>>;
let originalPid: number | undefined;
const alive = (pid?: number) => {
  try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; }
};
const log = (kind: string, detail: object = {}) => appendFileSync(state,
  JSON.stringify({ sdkWorkerPid: process.pid, originalPid, upstreamAlive: alive(originalPid), ...detail, kind }) + "\n");
const errors = (error: unknown) => {
  const chain: Array<{ name: string; message: string; cleanupOnly?: boolean; threadId?: string; turnId?: string }> = [];
  let current = error;
  while (current instanceof Error && chain.length < 4) {
    const value = current as Error & { cleanupOnly?: boolean; threadId?: string; turnId?: string };
    chain.push({ name: value.name, message: value.message, cleanupOnly: value.cleanupOnly,
      threadId: value.threadId, turnId: value.turnId }); current = value.cause;
  }
  return chain;
};
process.on("uncaughtExceptionMonitor", (error: Error, origin) => log("uncaught-monitor", { origin, chain: errors(error) }));
async function capture() {
  originalPid = (client as unknown as { child: ChildProcess }).child.pid;
  evidence = await captureProcessTreeEvidence(originalPid);
  log("captured-original-tree", { processIds: evidence?.processIds, processIdentities: evidence?.processIdentities });
}
const rpc = () => (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(client);
async function stats() { return rpc()<any>("fixture/stats", {}); }
async function send(kind: string, pair?: object, secondKind?: string) {
  await rpc()("fixture/sendFrame", { kind, pair, secondKind });
  await new Promise((resolve) => setImmediate(resolve));
}
function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
async function retired() {
  if (evidence?.processIds) await sharedWaitFor(() => evidence!.processIds.every(absent), "all original owned process PIDs exited");
}

async function standalone() {
  client = new CodexAppServerClient({ command: process.execPath, args: [protocol, wire],
    requestTimeoutMs: 15000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const tasks: Promise<unknown>[] = [];
  const handoff = sharedGate();
  try {
    await client.start(); await capture(); client.beginRound();
    const threadId = await client.startThread({ cwd: directory, ephemeral: true });
    const started = sharedGate();
    let outcome: any;
    const task = client.startTurn(threadId, { prompt: "Synthetic local protocol validation", onStarted: async (pair) => {
      log("actual-start-receipt", pair); started.enter();
      if (mode === "handoff") await handoff.promise;
    } }).then((result) => { outcome = { result }; return outcome; }, (error) => { outcome = { error }; return outcome; });
    tasks.push(task); await started.entered;
    if (mode === "healthy") {
      await send("healthy"); const received = await task;
      assert.equal(received.result?.kind, "needs_input");
      const completed = await client.continueTurn(received.result, { scope: ["Synthetic answer"] });
      log("healthy-result", { resultKind: completed.kind, status: completed.kind === "completed" ? completed.status : undefined,
        stats: await stats() });
    } else if (mode === "ambiguous") {
      const secondThread = await client.startThread({ cwd: directory, ephemeral: true });
      const secondStarted = sharedGate();
      let secondOutcome: any;
      const peer = client.startTurn(secondThread, { prompt: "Independent local peer", onStarted: () => secondStarted.enter() })
        .then((result) => { secondOutcome = { result }; return secondOutcome; }, (error) => { secondOutcome = { error }; return secondOutcome; });
      tasks.push(peer); await secondStarted.entered;
      const before = await stats();
      await send("foreign", before.active[0]); await send("ambiguous");
      const after = await stats();
      log("ambiguous-unbound-frames", { before, after, firstSettled: outcome !== undefined,
        secondSettled: secondOutcome !== undefined, firstAvailable: client.isThreadAvailable(threadId),
        secondAvailable: client.isThreadAvailable(secondThread) });
      for (const pair of before.active) await client.interrupt(pair.threadId, pair.turnId);
      await Promise.all([task, peer]);
    } else {
      const before = await stats();
      log("before-malformed-frame", { stats: before,
        activeWaiters: (client as unknown as { turnWaiters: number }).turnWaiters });
      await send("missing-item", before.active[0], mode === "known" ? "bad-question" : undefined);
      handoff.release();
      const rejected = await task;
      log("terminal-public-error", { chain: errors(rejected.error), stats: await stats() });
    }
    await client.unsubscribeThread(threadId);
    client.endRound();
  } finally {
    handoff.release();
    await rpc()("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
    await rpc()("fixture/completeActive", {}).catch(() => undefined);
    await Promise.allSettled(tasks);
    await client.stop(); await retired(); log("actor-complete");
  }
}
async function planner() {
  const f = await sharedReviewerFixture();
  client = f.client;
  (client as unknown as { options: { args: string[] } }).options.args = [protocol, wire];
  const startTurn = client.startTurn.bind(client);
  client.startTurn = async (...args) => {
    try { return await startTurn(...args); }
    catch (error) { log("planner-sdk-rejection", { chain: errors(error) }); throw error; }
  };
  try {
    await rpc()("fixture/setInterruptMode", { mode: "failed" }); await capture();
    const task = f.manager.start({ task: "Plan a read-only synthetic local diagnostic" }, f.exec);
    void task.catch(() => undefined);
    await sharedWaitFor(async () => { const value = await stats(); return value.active.length === 1 && value; }, "original actual Planner writer");
    const before = await stats();
    await send("missing-thread", before.active[0]);
    const waiting = await task;
    const held = f.runtime.recoverableRuns.get(waiting.id);
    const primary = held?.terminalFailure ?? waiting.retryState?.terminalFailure;
    log("planner-waiting", { row: waiting, primary, stats: await stats(), childIds: f.children.map((child) => child.id),
      disposals: [...f.rawDisposals], runtimeThread: held?.threadId, runtimeTurn: held?.interruptionTurnId,
      automaticContinuations: held?.plannerCheckpoint?.automaticContinuations,
      pin: (client as unknown as { pinned: number }).pinned });
    let unconfirmed: unknown;
    try { await f.manager.resume(waiting.id, "Only confirm the original protocol-failed writer cleanup", f.exec); }
    catch (error) { unconfirmed = error; }
    const again = await f.store.load(waiting.id);
    log("planner-resume-unconfirmed", { row: again, chain: errors(unconfirmed), stats: await stats(), disposals: [...f.rawDisposals] });
    await rpc()("fixture/setInterruptMode", { mode: "confirmed" });
    let finalError: unknown;
    let returnedRow: unknown;
    try { returnedRow = await f.manager.resume(waiting.id, "Only confirm original terminal cleanup", f.exec); }
    catch (error) { finalError = error; }
    const failed = await f.store.load(waiting.id);
    log("planner-cleaned", { chain: errors(finalError), returnedRow, row: failed, stats: await stats(),
      disposals: [...f.rawDisposals], recoverable: f.runtime.recoverableRuns.size,
      childHandles: f.runtime.codexChildSessions.size, pin: (client as unknown as { pinned: number }).pinned,
      childTurnCount: f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length });
  } finally {
    await f.close(); await retired(); log("actor-complete");
  }
}
log("actor-start", { mode });
(mode === "planner" ? planner() : standalone()).catch((error: unknown) => {
  log("actor-operation-rejected", { chain: errors(error) }); process.exitCode = 1;
});

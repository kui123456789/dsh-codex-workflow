import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";

const [mode, directory] = process.argv.slice(2);
const journal = join(directory!, "wire.jsonl");
const state = join(directory!, "states.jsonl");
const protocol = fileURLToPath(new URL("./fake-stdio-failure-app-server.mjs", import.meta.url));
const client = new CodexAppServerClient({ command: process.execPath, args: [protocol, mode!, journal],
  requestTimeoutMs: 5000, rpcTimeoutMs: 2000, idleProcessMs: 0, quitGraceMs: 100, killGraceMs: 100 });
const port = client as unknown as { pending: Map<unknown, unknown>; child?: {
  pid: number; stdin: { writableLength: number; writableNeedDrain: boolean; listenerCount(name: string): number;
    emit(name: string, error: Error): boolean }; };
  request<T>(method: string, params: object): Promise<T> };
let phase = "startup";
let originalPid: number | undefined;
let requestOutcome = "not-started";
const alive = (pid?: number) => {
  try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; }
};
const log = (kind: string, extra: object = {}) => appendFileSync(state,
  JSON.stringify({ kind, sdkWorkerPid: process.pid, phase, originalPid, upstreamAlive: alive(originalPid),
    pending: port.pending.size, requestOutcome, ...extra }) + "\n");
// Observation preserves Node's default fatal behavior. There is no
// uncaughtException handler and no forced success exit in this actor.
process.on("uncaughtExceptionMonitor", (error: NodeJS.ErrnoException, origin) =>
  log("uncaught-monitor", { origin, code: error.code, message: error.message }));
const raw = <T>(method: string, params: object = {}) => port.request<T>(method, params);
log("actor-start", { mode });
try {
  await client.start();
  originalPid = port.child!.pid;
  const originalThread = await client.startThread({ cwd: directory!, ephemeral: true });
  const originalOwner = client.captureThreadOwner(originalThread);
  log("ready", { thread: originalThread, stdinErrorListeners: port.child!.stdin.listenerCount("error") });
  if (mode === "old-late") {
    const retiredInput = port.child!.stdin;
    await client.releaseThreadForExternal(originalThread, undefined, originalOwner);
    const successor = await client.startThread({ cwd: directory!, ephemeral: true });
    const successorPid = port.child!.pid;
    const owner = client.captureThreadOwner(successor);
    await client.resolveDefaultModel();
    phase = "old-retired-input-error";
    retiredInput.emit("error", new Error("Late retired original stdin event"));
    log("late-error-consumed", { successorPid, successorAvailable: client.isThreadAvailable(successor, owner),
      successorModel: await client.resolveDefaultModel() });
  } else {
    if (mode === "queued-stop") {
      await raw("fixture/pauseRead");
      const deadline = Date.now() + 2000;
      while (!readFileSync(journal, "utf8").includes('"kind":"reader-paused"')) {
        if (Date.now() > deadline) throw new Error("Actual upstream did not pause reading");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    phase = "real-large-write";
    requestOutcome = "pending";
    const task = raw<{ receivedBytes: number }>("fixture/large", { payload: "x".repeat(4 * 1024 * 1024) });
    const observed = task.then((result) => { requestOutcome = "fulfilled"; log("rpc-fulfilled", result); },
      (error: Error) => { requestOutcome = "rejected"; log("rpc-rejected", { message: error.message }); });
    await new Promise((resolve) => setImmediate(resolve));
    log("write-observed", { writableLength: port.child!.stdin.writableLength, writableNeedDrain: port.child!.stdin.writableNeedDrain,
      stdinErrorListeners: port.child!.stdin.listenerCount("error") });
    if (mode === "queued-stop") {
      phase = "stop-with-real-queued-write";
      await client.stop();
    }
    await observed;
  }
} catch (error) {
  log("actor-operation-rejected", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  phase = "final-cleanup";
  await client.stop();
  await new Promise((resolve) => setImmediate(resolve));
  log("actor-complete");
}

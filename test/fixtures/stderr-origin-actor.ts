import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence }
  from "../../src/infrastructure/process-transport.js";

const [mode, directoryArg, currentMode = "current-own"] = process.argv.slice(2);
const isLate = mode === "late" || mode === "late-read-error";
assert.ok(directoryArg);
const directory = directoryArg;
const OLD = "DSH_LOCAL_OLD_STDERR_GENERATION";
const CURRENT = "DSH_LOCAL_CURRENT_STDERR_GENERATION";
const protocol = fileURLToPath(new URL("./fake-stderr-origin-app-server.mjs", import.meta.url));
const states = join(directory, "states.jsonl");
const wire = join(directory, "wire.jsonl");
const timeline: Array<Record<string, unknown>> = [];
const oldPipe: Buffer[] = [];
const births: ProcessTreeEvidence[] = [];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
let saved = Promise.resolve();
function record(kind: string, detail: Record<string, unknown> = {}): void {
  const value = { kind, ms: performance.now(), ...detail };
  timeline.push(value);
  saved = saved.then(() => appendFile(states, JSON.stringify(value) + "\n", "utf8"));
}
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Actual stderr fixture did not reach " + label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function absent(processId: number): boolean {
  try { process.kill(processId, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
const options = { command: process.execPath,
  args: [protocol, mode === "healthy" ? currentMode : mode === "drained" ? "old-drained" : "old-held", wire],
  requestTimeoutMs: 10000, rpcTimeoutMs: 10000, idleProcessMs: 0 };
const sdk = new CodexAppServerClient(options);
const originalChild = () => (sdk as unknown as { child?: ChildProcess }).child;
const control = (sdk as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(sdk);
let a: ChildProcess | undefined, b: ChildProcess | undefined;
let aExited = false, aClosed = false, bStarted = false, stopping = false, mayRestart = false;
let bFlight: Promise<void> | undefined;
const capture = async (child: ChildProcess) => {
  const evidence = { processId: child.pid, ...await captureProcessTreeEvidence(child.pid) };
  births.push(evidence);
  record("captured-owned-original", { processId: child.pid, processIds: evidence.processIds,
    processIdentities: evidence.processIdentities });
};
function watchB(): void {
  b = originalChild();
  assert.ok(b?.pid);
  bStarted = true;
  record("B-actual-spawn", { processId: b.pid, oldExitObserved: aExited, oldCloseObserved: aClosed });
  b.stderr!.on("data", (value: Buffer) => record("B-external-pipe-data", {
    processId: b!.pid, bytes: value.length, sha256: hash(value), currentMarker: value.includes(CURRENT) }));
  b.once("exit", (code, signal) => record("B-real-exit", { processId: b!.pid, code, signal }));
  b.once("close", (code, signal) => record("B-real-close", { processId: b!.pid, code, signal }));
}
function startB(): void {
  if (stopping) return;
  options.args = [protocol, currentMode, wire];
  record("B-start-call", { oldExitObserved: aExited, oldCloseObserved: aClosed });
  const startup = sdk.start();
  void startup.catch(() => undefined);
  bFlight = (async () => {
    await waitFor(() => Boolean(originalChild() && originalChild() !== a), "actual successor spawn after original cleanup");
    watchB();
    if (isLate) a?.stderr?.resume();
    await startup;
  })();
  void bFlight.catch(() => undefined);
}

async function main(): Promise<void> {
  record("actor-start", { sdkWorkerPid: process.pid, mode, currentMode });
  try {
    await sdk.start();
    if (mode === "healthy") { watchB(); await capture(b!); }
    else {
      a = originalChild();
      assert.ok(a?.pid);
      await capture(a);
      a.stderr!.on("data", (value: Buffer) => {
        const chunk = Buffer.from(value); oldPipe.push(chunk);
        record("A-external-pipe-data", { processId: a!.pid, bytes: chunk.length, sha256: hash(chunk),
          oldMarker: chunk.includes(OLD), afterOldExit: aExited, afterSuccessorStart: bStarted,
          currentProcessId: originalChild()?.pid });
        if (mode === "late-read-error" && aExited && bStarted && !a!.stderr!.destroyed) {
          record("A-retired-read-error", { processId: a!.pid, currentProcessId: originalChild()?.pid });
          a!.stderr!.destroy(new Error("Actual retired stderr pipe read failure"));
        }
      });
      a.stderr!.once("end", () => record("A-external-pipe-end", { processId: a!.pid }));
      a.stderr!.once("close", () => record("A-external-pipe-close", { processId: a!.pid }));
      a.once("close", (code, signal) => { aClosed = true; record("A-real-close", { processId: a!.pid, code, signal }); });
      a.once("exit", (code, signal) => {
        aExited = true;
        record("A-real-exit", { processId: a!.pid, code, signal, readableLength: a!.stderr!.readableLength,
          flowing: a!.stderr!.readableFlowing });
        if (isLate && mayRestart && !stopping) startB();
      });
      if (isLate) {
        // Node resumes child stdio after exit. Hold the actual readable's
        // buffered OS bytes across the SDK's original-process cleanup, then
        // release them only once the successor really owns the transport.
        a.stderr!.on("resume", () => {
          if (aExited && !bStarted && !stopping) a!.stderr!.pause();
        });
        a.stderr!.pause(); record("A-actual-readable-paused", { processId: a.pid, flowing: a.stderr!.readableFlowing });
      }
      const ack = await control<{ processId: number; bytes: number }>("fixture/flood",
        { bytes: isLate ? 512 * 1024 : 8192 });
      record("old-flood-ACK", { processId: ack.processId, bytes: ack.bytes });
      if (isLate) {
        await waitFor(() => a!.stderr!.readableLength > 0, "actual paused pipe bytes");
        assert.equal(originalChild(), a, "Only the exact currently owned original ChildProcess is terminated");
        assert.equal(a.exitCode, null);
        record("A-own-child-termination", { processId: a.pid, readableLength: a.stderr!.readableLength });
        mayRestart = true;
        assert.equal(a.kill(), true, "Real termination is issued through the original ChildProcess object");
        await waitFor(() => bFlight !== undefined, "successor started at the actual original exit");
      } else {
        await waitFor(() => aClosed, "original stderr fully drained and closed");
        startB();
      }
      await bFlight;
      assert.ok(b);
      await capture(b);
      await waitFor(() => aClosed, "original pipe close after successor startup");
    }
    assert.ok(b);
    const failure = await sdk.health().then(
      () => { throw new Error("The actual current backend unexpectedly returned a model catalog"); },
      (error: Error) => {
        const classified = { name: error.name, bytes: Buffer.byteLength(error.message), sha256: hash(error.message),
          currentExitPrefix: error.message.startsWith("codex app-server exited 42 (no signal):"),
          errorContainsOldMarker: error.message.includes(OLD), errorContainsCurrentMarker: error.message.includes(CURRENT),
          causeUndefined: error.cause === undefined,
          stderrUnavailable: error.message.includes("stderr diagnostic stream unavailable") };
        record("public-health-rejection", classified);
        return classified;
      });
    assert.equal(failure.currentExitPrefix, true, "Public rejection preserves the current backend's actual exit prefix");
    const pipeBytes = Buffer.concat(oldPipe);
    await writeFile(join(directory, "actual-old-stderr.bin"), pipeBytes);
    record("actual-old-pipe-artifact", { bytes: pipeBytes.length, sha256: hash(pipeBytes) });
    record("observed-result", { mode, currentMode, processIdA: a?.pid, processIdB: b.pid,
      actualOldPipeBytes: pipeBytes.length,
      lateOldPipeChunks: timeline.filter((row) => row.kind === "A-external-pipe-data" && row.currentProcessId === b!.pid
        && row.afterOldExit && row.afterSuccessorStart).length });
  } finally {
    stopping = true;
    a?.stderr?.resume();
    await sdk.stop();
    if (a && a.exitCode === null && a.signalCode === null) a.kill();
    for (const evidence of births) {
      const processIds = evidence.processIds;
      if (processIds) {
        await waitFor(() => processIds.every(absent), "all captured owned original processes exited");
        assert.equal(await originalProcessTreeExited(evidence), true);
      }
    }
    record("actor-complete");
    await saved;
  }
}
main().catch(async (error: Error) => {
  record("actor-error", { name: error.name, message: error.message });
  await saved;
  process.exitCode = 1;
});

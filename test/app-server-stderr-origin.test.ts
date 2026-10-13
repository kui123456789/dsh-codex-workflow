import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/stderr-origin-actor.ts", import.meta.url));
type Event = { kind: string; sdkWorkerPid?: number; processId?: number; parentProcessId?: number; ms?: number;
  bytes?: number; sha256?: string; oldExitObserved?: boolean; oldCloseObserved?: boolean; oldMarker?: boolean;
  afterOldExit?: boolean; afterSuccessorStart?: boolean; currentProcessId?: number; readableLength?: number;
  currentExitPrefix?: boolean; errorContainsOldMarker?: boolean; errorContainsCurrentMarker?: boolean;
  causeUndefined?: boolean; name?: string; actualOldPipeBytes?: number; lateOldPipeChunks?: number };
const rows = async (path: string): Promise<Event[]> => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as Event);
const absent = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
async function fixture(mode: "healthy" | "drained" | "late" | "late-read-error", currentMode = "current-own") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-stderr-origin-"));
  const worker = spawn(process.execPath, [tsx, actor, mode, directory, currentMode],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.resume();
  let workerStderrBytes = 0;
  worker.stderr.on("data", (value: Buffer) => { workerStderrBytes += value.length; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const states = await rows(join(directory, "states.jsonl"));
  const wire = await rows(join(directory, "wire.jsonl"));
  assert.equal(exit.code, 0, `Actual stderr actor must finish before reading its artifact; retained evidence: ${directory}`);
  const pipe = await readFile(join(directory, "actual-old-stderr.bin"));
  return { directory, exit, states, wire, pipe, workerStderrBytes,
    async close() {
      const owner = states.find((entry) => entry.kind === "actor-start")!.sdkWorkerPid;
      for (const entry of wire.filter((row) => row.kind === "start")) {
        assert.equal(entry.parentProcessId, owner, "All protocol processes belong only to this diagnostic worker");
        assert.equal(absent(entry.processId!), true, "Each actual diagnostic original exited before fixture removal");
      }
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    } };
}
function currentFailure(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.exit.code, 0, "The unattended actual-process actor exits normally");
  assert.equal(f.states.at(-1)?.kind, "actor-complete");
  const failure = f.states.find((entry) => entry.kind === "public-health-rejection");
  assert.ok(failure);
  assert.equal(failure.name, "Error");
  assert.equal(failure.currentExitPrefix, true);
  assert.equal(failure.causeUndefined, true, "Current process error cause semantics are preserved");
  return failure;
}

test("healthy current backend preserves its own stderr in the public exit error", async () => {
  const f = await fixture("healthy");
  try {
    const failure = currentFailure(f);
    assert.equal(failure.errorContainsCurrentMarker, true);
    assert.equal(failure.errorContainsOldMarker, false);
    assert.equal(f.wire.filter((row) => row.kind === "start").length, 1);
    assert.equal(f.pipe.length, 0);
    assert.ok(f.states.some((event) => event.kind === "B-external-pipe-data" && event.bytes! > 0));
  } finally { await f.close(); }
});

test("old stderr drained before successor startup does not contaminate the successor error", async () => {
  const f = await fixture("drained");
  try {
    const failure = currentFailure(f);
    assert.equal(failure.errorContainsCurrentMarker, true);
    assert.equal(failure.errorContainsOldMarker, false);
    const start = f.states.find((row) => row.kind === "B-start-call")!;
    const closed = f.states.find((row) => row.kind === "A-real-close")!;
    assert.equal(start.oldCloseObserved, true);
    assert.ok(closed.ms! < start.ms!);
    assert.equal(f.pipe.length, 8192);
    assert.equal(f.states.find((row) => row.kind === "observed-result")?.lateOldPipeChunks, 0);
    assert.equal(f.wire.filter((row) => row.kind === "start").length, 2);
  } finally { await f.close(); }
});

test("real retired OS-pipe bytes cannot enter successor public failures with own or absent stderr", async (t) => {
  for (const currentMode of ["current-own", "current-silent"]) {
    const f = await fixture("late", currentMode);
    try {
      const failure = currentFailure(f);
      const result = f.states.find((row) => row.kind === "observed-result");
      const start = f.states.find((row) => row.kind === "B-actual-spawn")!;
      const data = f.states.filter((row) => row.kind === "A-external-pipe-data" && row.afterOldExit
        && row.afterSuccessorStart && row.currentProcessId === start.processId);
      assert.equal(start.oldExitObserved, true);
      assert.equal(start.oldCloseObserved, false, "The actual child exited before its actual stdio closed");
      assert.ok(data.length > 0, "Old bytes really arrive from the OS pipe while the successor owns the SDK");
      assert.ok(data.some((row) => row.oldMarker));
      assert.ok(f.states.some((row) => row.kind === "A-own-child-termination" && row.readableLength! > 0));
      assert.ok(result?.actualOldPipeBytes && result.actualOldPipeBytes > 0);
      const artifact = f.states.find((row) => row.kind === "actual-old-pipe-artifact")!;
      assert.equal(artifact.sha256, createHash("sha256").update(f.pipe).digest("hex"));
      t.diagnostic(JSON.stringify({ currentMode, externalPipeBytes: f.pipe.length, sha256: artifact.sha256,
        actualLateChunks: data.length, currentExitPrefix: failure.currentExitPrefix,
        errorContainsOldMarker: failure.errorContainsOldMarker }));
      assert.equal(failure.errorContainsOldMarker, false,
        "The successor public error must never include the retired original's actual pipe bytes: " + currentMode);
      assert.equal(failure.errorContainsCurrentMarker, currentMode === "current-own");
      assert.equal(f.wire.filter((row) => row.kind === "start").length, 2);
      assert.equal(f.wire.some((row) => row.kind === "rpc" && /turn|review|thread/.test(String((row as unknown as { method: string }).method))), false);
    } finally { await f.close(); }
  }
});

test("an actual late retired stderr read error cannot annotate the current successor's exit", async () => {
  for (const currentMode of ["current-own", "current-silent"]) {
    const f = await fixture("late-read-error", currentMode);
    try {
      const failure = currentFailure(f);
      assert.ok(f.states.some(row => row.kind === "A-retired-read-error"));
      assert.ok(f.pipe.length > 0, "The old error follows bytes actually delivered from its original OS pipe");
      assert.equal((failure as Event & { stderrUnavailable?: boolean }).stderrUnavailable, false);
      assert.equal(failure.errorContainsOldMarker, false);
      assert.equal(failure.errorContainsCurrentMarker, currentMode === "current-own");
      assert.equal(f.wire.filter(row => row.kind === "start").length, 2);
    } finally { await f.close(); }
  }
});

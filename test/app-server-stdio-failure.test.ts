import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/stdio-failure-actor.ts", import.meta.url));
type Event = { kind: string; processId?: number; sdkWorkerPid?: number; parentProcessId?: number; phase?: string;
  code?: string; message?: string; pending?: number; requestOutcome?: string; writableLength?: number; writableNeedDrain?: boolean;
  receivedBytes?: number; successorPid?: number; successorAvailable?: boolean; successorModel?: string };
const rows = async (path: string): Promise<Event[]> => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as Event);
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-appserver-stdio-failure-"));
  // A real SDK worker is isolated because the baseline's Socket error is
  // fatal. The main test runner never installs a global error workaround.
  const worker = spawn(process.execPath, [tsx, actor, mode, directory], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  worker.stderr.on("data", (value: Buffer | string) => { stderr += String(value); });
  worker.stdout.resume();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    worker.once("error", reject); worker.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const states = await rows(join(directory, "states.jsonl"));
  const wire = await rows(join(directory, "wire.jsonl"));
  return { directory, exit, states, wire, stderr,
    async close() {
      const source = states.find((entry) => entry.kind === "actor-start")!.sdkWorkerPid;
      for (const entry of wire.filter((row) => row.kind === "start")) {
        assert.equal(entry.parentProcessId, source, "Only this actor's actual diagnostic children may be inspected");
        assert.equal(exited(entry.processId!), true, "The diagnostic original really exited before fixture removal");
      }
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    } };
}

test("healthy large stdio writes complete successfully despite ordinary backpressure", async () => {
  const f = await fixture("healthy");
  try {
    assert.equal(f.exit.code, 0, f.stderr);
    assert.equal(f.states.filter((entry) => entry.kind === "uncaught-monitor").length, 0);
    const received = f.states.find((entry) => entry.kind === "rpc-fulfilled");
    assert.equal(received?.receivedBytes, 4 * 1024 * 1024);
    assert.equal(f.states.at(-1)?.kind, "actor-complete");
    assert.equal(f.wire.filter((entry) => entry.kind === "start").length, 1);
  } finally { await f.close(); }
});

test("stopping an original process with a real queued write preserves the primary rejection without crashing its SDK host", async (t) => {
  const f = await fixture("queued-stop");
  try {
    const queued = f.states.find((entry) => entry.kind === "write-observed");
    assert.ok(queued?.writableLength && queued.writableLength > 64 * 1024);
    assert.equal(queued.writableNeedDrain, true, "The actual OS pipe has queued data; no write method is patched");
    assert.equal(queued.pending, 1);
    t.diagnostic(JSON.stringify({ exit: f.exit, queuedBytes: queued.writableLength,
      fatal: f.states.find((entry) => entry.kind === "uncaught-monitor")?.code }));
    assert.equal(f.exit.code, 0, f.stderr);
    assert.equal(f.states.filter((entry) => entry.kind === "uncaught-monitor").length, 0);
    const rejected = f.states.find((entry) => entry.kind === "rpc-rejected");
    assert.equal(rejected?.message, "Codex app-server stopped");
    assert.equal(rejected?.pending, 0);
    assert.equal(f.states.at(-1)?.kind, "actor-complete");
    assert.equal(f.wire.filter((entry) => entry.kind === "start").length, 1, "Teardown creates no replacement");
  } finally { await f.close(); }
});

test("a late retired stdin error is consumed without invalidating an independent successor", async () => {
  const f = await fixture("old-late");
  try {
    assert.equal(f.exit.code, 0, f.stderr);
    const consumed = f.states.find((entry) => entry.kind === "late-error-consumed");
    assert.ok(consumed);
    assert.equal(consumed.successorAvailable, true);
    assert.equal(consumed.successorModel, "pipe-model");
    assert.equal(f.states.filter((entry) => entry.kind === "uncaught-monitor").length, 0);
    assert.equal(f.wire.filter((entry) => entry.kind === "start").length, 2);
  } finally { await f.close(); }
});

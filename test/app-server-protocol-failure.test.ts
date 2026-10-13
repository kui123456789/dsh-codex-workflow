import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/esm");
const actor = fileURLToPath(new URL("./fixtures/protocol-failure-actor.ts", import.meta.url));
const readRows = async (path: string): Promise<any[]> => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line));
async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-protocol-failure-"));
  const worker = spawn(process.execPath, ["--import", pathToFileURL(tsx).href, actor, mode, directory],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.resume(); worker.stderr.resume();
  const exit = await new Promise<number | null>((resolve, reject) => {
    worker.once("error", reject); worker.once("exit", resolve);
  });
  const states = await readRows(join(directory, "states.jsonl"));
  const wire = await readRows(join(directory, "wire.jsonl"));
  return { exit, states, wire,
    async close() {
      const owner = states.find((row) => row.kind === "actor-start").sdkWorkerPid;
      assert.ok(wire.filter((row) => row.kind === "start").every((row) => row.parentProcessId === owner),
        "Every backend belongs only to this isolated SDK worker");
      const captured = states.find((row) => row.kind === "captured-original-tree");
      assert.ok(captured?.processIds?.includes(captured.originalPid));
      const deadline = Date.now() + 15000;
      while (!captured.processIds.every((pid: number) => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      })) {
        if (Date.now() >= deadline) throw new Error("Actual owned backend tree did not fully exit within its original bound");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    } };
}
function healthyHost(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.states.some((row) => row.kind === "uncaught-monitor"), false,
    "Actual upstream JSON schema failure cannot escape the Readline callback into a fatal SDK-host exception");
  assert.equal(f.exit, 0, JSON.stringify(f.states.find((row) => row.kind === "actor-operation-rejected")?.chain));
  assert.equal(f.states.at(-1)?.kind, "actor-complete");
  assert.equal(f.wire.filter((row) => row.kind === "start").length, 1);
}

test("native input and unknown future notifications remain compatible", async () => {
  const f = await fixture("healthy");
  try {
    healthyHost(f);
    const result = f.states.find((row) => row.kind === "healthy-result");
    assert.equal(result.status, "completed");
    assert.equal(result.stats.nativeReplies, 1);
    assert.equal(result.stats.turnStartRequests.length, 1);
  } finally { await f.close(); }
});
for (const mode of ["known", "handoff"]) test(`protocol failure preserves the original first cause and ACK target during ${mode}`, async () => {
  const f = await fixture(mode);
  try {
    healthyHost(f);
    const before = f.states.find((row) => row.kind === "before-malformed-frame");
    if (mode === "handoff") assert.equal(before.activeWaiters, 0, "The real turn receipt exists while onStarted still holds waiter registration");
    const failure = f.states.find((row) => row.kind === "terminal-public-error");
    assert.equal(failure.chain[0].name, "CodexProtocolError");
    assert.equal(failure.chain[0].message, "Codex app-server protocol schema invalid: invalid requestUserInput itemId");
    assert.deepEqual(failure.stats.active, []);
    assert.deepEqual(failure.stats.interrupts.map(({ mode: _mode, ...pair }: any) => pair), before.stats.active);
    assert.equal(failure.stats.turnStartRequests.length, 1);
  } finally { await f.close(); }
});

test("ambiguous and foreign malformed frames cannot borrow another registered original tuple", async () => {
  const f = await fixture("ambiguous");
  try {
    healthyHost(f);
    const observed = f.states.find((row) => row.kind === "ambiguous-unbound-frames");
    assert.deepEqual(observed.after.active, observed.before.active);
    assert.deepEqual(observed.after.interrupts, []);
    assert.equal(observed.firstSettled, false); assert.equal(observed.secondSettled, false);
    assert.equal(observed.firstAvailable, true); assert.equal(observed.secondAvailable, true);
    assert.equal(observed.after.turnStartRequests.length, 2);
  } finally { await f.close(); }
});

test("Planner malformed input retains one original cleanup claim and resume performs no model continuation", async () => {
  const f = await fixture("planner");
  try {
    healthyHost(f);
    const waiting = f.states.find((row) => row.kind === "planner-waiting");
    const primary = "Codex app-server protocol schema invalid: invalid requestUserInput threadId";
    assert.equal(waiting.row.processState, "waiting");
    assert.equal(waiting.row.retryState.awaitingCleanup, true);
    assert.equal(waiting.row.retryState.terminalFailure, primary); assert.equal(waiting.primary, primary);
    assert.equal(waiting.row.error, primary); assert.equal(waiting.automaticContinuations, 0);
    const sdkFailure = f.states.find((row) => row.kind === "planner-sdk-rejection");
    assert.equal(sdkFailure.chain[0].name, "CodexTurnInterruptionError");
    assert.equal(sdkFailure.chain[0].cleanupOnly, true);
    assert.equal(sdkFailure.chain[1].name, "CodexProtocolError");
    assert.equal(sdkFailure.chain[1].message, primary);
    assert.equal(sdkFailure.chain[0].threadId, waiting.runtimeThread);
    assert.equal(sdkFailure.chain[0].turnId, waiting.runtimeTurn);
    assert.equal(waiting.pin, 1); assert.equal(waiting.childIds.length, 1); assert.deepEqual(waiting.disposals, []);
    assert.deepEqual(waiting.stats.active, [{ threadId: waiting.runtimeThread, turnId: waiting.runtimeTurn }]);
    assert.equal(waiting.stats.turnStartRequests.length, 1);
    const again = f.states.find((row) => row.kind === "planner-resume-unconfirmed");
    assert.equal(again.chain[0].message, "Original Planner terminal cleanup is unconfirmed; no model continuation was sent");
    assert.equal(again.row.retryState.awaitingCleanup, true);
    assert.deepEqual(again.stats.active, waiting.stats.active);
    assert.equal(again.stats.turnStartRequests.length, 1); assert.deepEqual(again.disposals, []);
    const cleaned = f.states.find((row) => row.kind === "planner-cleaned");
    assert.equal(cleaned.row.processState, "failed"); assert.equal(cleaned.row.error, primary);
    assert.equal(cleaned.row.retryState, undefined); assert.deepEqual(cleaned.chain, []);
    assert.equal(cleaned.returnedRow.id, waiting.row.id);
    assert.equal(cleaned.returnedRow.phase, "failed"); assert.equal(cleaned.returnedRow.error, primary);
    assert.equal(cleaned.stats.turnStartRequests.length, 1); assert.deepEqual(cleaned.stats.active, []);
    assert.deepEqual(cleaned.stats.unsubscribes, [waiting.runtimeThread]);
    assert.deepEqual(cleaned.disposals, waiting.childIds);
    assert.equal(cleaned.recoverable, 0); assert.equal(cleaned.childHandles, 0); assert.equal(cleaned.pin, 0);
    assert.equal(cleaned.childTurnCount, 1);
    assert.ok(cleaned.stats.interrupts.every((pair: any) => pair.threadId === waiting.runtimeThread && pair.turnId === waiting.runtimeTurn));
  } finally { await f.close(); }
});

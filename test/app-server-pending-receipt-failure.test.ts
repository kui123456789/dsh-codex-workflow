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
const actor = fileURLToPath(new URL("./fixtures/pending-receipt-failure-actor.ts", import.meta.url));
const rows = async (path: string): Promise<any[]> => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line));
async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-pending-receipt-failure-"));
  const worker = spawn(process.execPath, ["--import", pathToFileURL(tsx).href, actor, mode, directory],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.resume(); worker.stderr.resume();
  const exit = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  const states = await rows(join(directory, "states.jsonl")), wire = await rows(join(directory, "wire.jsonl"));
  return { states, wire, exit, async close() {
    const owner = states.find((row) => row.kind === "actor-start").sdkWorkerPid;
    assert.ok(wire.filter((row) => row.kind === "start").every((row) => row.parentProcessId === owner));
    const captured = states.find((row) => row.kind === "captured-owned-tree");
    assert.ok(captured.processIds.includes(captured.originalPid));
    assert.ok(captured.processIds.every((pid: number) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }), "The actor retired every captured owned PID before removal");
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  } };
}
function healthyHost(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.exit, 0, JSON.stringify(f.states.find((row) => row.kind === "actor-rejected")?.chain));
  assert.equal(f.states.some((row) => row.kind === "uncaught-monitor"), false);
  assert.equal(f.states.at(-1).kind, "actor-complete");
}
test("healthy delayed original receipt delivers its original usable completion", async () => {
  const f = await fixture("healthy");
  try {
    healthyHost(f);
    assert.equal(f.states.find((row) => row.kind === "public-outcome").usableText, true);
    assert.equal(f.wire.filter((row) => row.kind === "actual-writer-accepted").length, 1);
  } finally { await f.close(); }
});
for (const [mode, cause] of [["matching", "invalid requestUserInput itemId"], ["missing-turn", "invalid requestUserInput turnId"],
  ["first-cause", "invalid question text"], ["detached", "invalid requestUserInput itemId"]]) {
test(`${mode} malformed pipe frame before original receipt permits cleanup only and never usable output`, async () => {
  const f = await fixture(mode!);
  try {
    healthyHost(f);
    const frame = f.states.find((row) => row.kind === "actual-frame-observed");
    assert.equal(frame.rawPending, 1); assert.equal(frame.started, 0); assert.equal(frame.waiters, 0);
    const outcome = f.states.find((row) => row.kind === "public-outcome");
    assert.equal(outcome.usableText, false, "A real original schema failure before the authoritative RPC receipt cannot become usable success");
    assert.equal(outcome.chain[0].name, "CodexTurnInterruptionError"); assert.equal(outcome.chain[0].cleanupOnly, true);
    assert.equal(outcome.chain[1].name, "CodexProtocolError");
    assert.equal(outcome.chain[1].message, "Codex app-server protocol schema invalid: " + cause);
    const original = f.wire.find((row) => row.kind === "actual-original-receipt");
    assert.equal(outcome.chain[0].threadId, original.threadId); assert.equal(outcome.chain[0].turnId, original.turnId);
    const interrupts = f.wire.filter((row) => row.kind === "actual-interrupt");
    assert.ok(interrupts.length > 0);
    assert.ok(interrupts.every((row) => row.threadId === original.threadId && row.turnId === original.turnId));
    assert.equal(f.wire.filter((row) => row.kind === "actual-writer-accepted").length, 1);
    if (mode === "first-cause") {
      assert.deepEqual(f.wire.filter((row) => row.kind === "actual-frame-before-receipt").map((row) => row.variant),
        ["foreign", "bad-question", "matching"]);
    }
    if (mode === "detached") assert.notEqual(original.threadId, original.sourceThreadId,
      "Cleanup uses the authoritative detached review destination, never an early hint or its source task");
  } finally { await f.close(); }
});
}
test("unscoped and ambiguous hints cannot borrow either of two original pending receipts", async () => {
  const f = await fixture("ambiguous");
  try {
    healthyHost(f);
    const frames = f.states.filter((row) => row.kind === "actual-frame-observed");
    assert.equal(frames.length, 2); assert.ok(frames.every((row) => row.rawPending === 2 && row.started === 0 && row.waiters === 0));
    const outcomes = f.states.find((row) => row.kind === "ambiguous-outcomes").outcomes;
    assert.equal(outcomes.length, 2); assert.ok(outcomes.every((row: any) => row.usableText && row.chain.length === 0));
    assert.equal(f.wire.some((row) => row.kind === "actual-interrupt"), false);
    assert.equal(f.wire.filter((row) => row.kind === "actual-writer-accepted").length, 2);
  } finally { await f.close(); }
});
test("Planner early schema failure retains its original claim and resume only confirms cleanup once", async () => {
  const f = await fixture("planner");
  try {
    healthyHost(f);
    const waiting = f.states.find((row) => row.kind === "planner-waiting");
    const primary = "Codex app-server protocol schema invalid: invalid requestUserInput itemId";
    assert.equal(waiting.row.retryState?.awaitingCleanup, true, "An early schema error cannot become an accepted usable Planner result");
    assert.equal(waiting.row.processState, "waiting"); assert.equal(waiting.row.retryState.terminalFailure, primary);
    assert.equal(waiting.primary, primary); assert.equal(waiting.automaticContinuations, 0);
    assert.equal(waiting.threadId, waiting.original.threadId); assert.equal(waiting.turnId, waiting.original.turnId);
    assert.deepEqual(waiting.stats.active, [{ threadId: waiting.threadId, turnId: waiting.turnId }]);
    assert.deepEqual(waiting.stats.unsubscribes, []);
    assert.equal(waiting.childIds.length, 1); assert.deepEqual(waiting.disposals, []); assert.equal(waiting.pin, 1);
    const failedACK = f.states.find((row) => row.kind === "planner-unconfirmed");
    assert.equal(failedACK.chain[0].message, "Original Planner terminal cleanup is unconfirmed; no model continuation was sent");
    assert.equal(failedACK.row.retryState.awaitingCleanup, true); assert.deepEqual(failedACK.disposals, []); assert.equal(failedACK.pin, 1);
    assert.deepEqual(failedACK.stats.unsubscribes, []);
    const cleaned = f.states.find((row) => row.kind === "planner-cleaned");
    assert.equal(cleaned.row.processState, "failed"); assert.equal(cleaned.row.error, primary); assert.equal(cleaned.row.retryState, undefined);
    assert.deepEqual(cleaned.disposals, waiting.childIds); assert.equal(cleaned.pin, 0);
    assert.equal(cleaned.recoverable, 0); assert.equal(cleaned.children, 0); assert.equal(cleaned.childTurns, 1);
    assert.equal(f.wire.filter((row) => row.kind === "actual-writer-accepted").length, 1);
    assert.ok(f.wire.filter((row) => row.kind === "actual-interrupt")
      .every((row) => row.threadId === waiting.threadId && row.turnId === waiting.turnId));
    assert.deepEqual(f.wire.filter((row) => row.kind === "actual-unsubscribe").map((row) => row.threadId), [waiting.threadId]);
  } finally { await f.close(); }
});

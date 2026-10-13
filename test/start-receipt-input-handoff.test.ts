import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const requireHost = createRequire(import.meta.url);
const actor = fileURLToPath(new URL("./fixtures/start-receipt-input-handoff-actor.ts", import.meta.url));
const readRows = async (path: string): Promise<any[]> => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((row) => JSON.parse(row));
async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-start-receipt-input-handoff-"));
  const child = spawn(process.execPath, ["--import", pathToFileURL(requireHost.resolve("tsx/esm")).href, actor, directory, mode],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
  child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  const exit = await new Promise<number | null>((fulfill, reject) => { child.once("error", reject); child.once("exit", fulfill); });
  return { directory, exit, diagnostics, states: await readRows(join(directory, "states.jsonl")), wire: await readRows(join(directory, "wire.jsonl")),
    async close() { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); } };
}
function released(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.exit, 0, f.diagnostics);
  const first = f.states.find((row) => row.kind === "initial-waiting");
  const completed = f.states.find((row) => row.kind === "completed");
  assert.equal(first.row.processState, "waiting"); assert.equal(first.row.retryState.awaitingStartReceipt, true);
  assert.equal(first.pin, 1); assert.deepEqual(first.disposals, []);
  assert.equal(completed.row.phase, "executing");
  assert.equal(completed.row.retryState, undefined);
  assert.equal(completed.pin, 0); assert.equal(completed.begins, 1); assert.equal(completed.ends, 1);
  assert.deepEqual(completed.children, first.children); assert.deepEqual(completed.disposals, first.children);
  assert.equal(completed.recoverable, 0); assert.equal(completed.pendingInputs, 0);
  assert.equal(completed.plannerInputs, 0); assert.equal(completed.activeTurns, 0);
  assert.equal(completed.guards.length, 1, "The original guard retains only its independent confirmation receipt");
  assert.equal(completed.guards[0].lease_until, 0);
  assert.equal(JSON.parse(completed.guards[0].owner).confirmed, true, "No unconfirmed SQLite guard can strand the completed workflow");
  assert.equal(completed.guards[0].epoch, first.guards[0].epoch);
  assert.equal(JSON.parse(completed.guards[0].owner).token, JSON.parse(first.guards[0].owner).token,
    "Receipt handoff preserves the original SQL guard generation until its own confirmation");
  assert.equal(f.wire.filter((row) => row.kind === "thread-created").length, 1);
  assert.deepEqual(f.wire.filter((row) => row.kind === "unsubscribe").map((row) => row.threadId), [first.original.threadId]);
  assert.ok(f.wire.filter((row) => row.kind === "model-request").every((row) => !row.originalActive && row.threadId === first.original.threadId));
  const starts = completed.childEvents.filter((event: any) => event.type === "turn/start").map((event: any) => event.data.turn);
  const ends = completed.childEvents.filter((event: any) => event.type === "turn/end").map((event: any) => event.data.turn);
  assert.deepEqual(starts, Array.from({ length: starts.length }, (_, index) => index + 1)); assert.deepEqual(ends, starts);
  const stopped = f.states.find((row) => row.kind === "stopped-after-completion");
  assert.equal(stopped.ends, 1); assert.deepEqual(stopped.disposals, first.children);
  assert.equal(f.states.at(-1).originalProcessesExited, true, "The captured original process tree really exited");
  return { first, completed };
}

test("a late original start receipt hands native input to continue without releasing the Planner twice", async (t) => {
  const f = await fixture("native-input"); let passed = false;
  try {
    const { first, completed } = released(f);
    const handed = f.states.find((row) => row.kind === "native-input-handoff");
    assert.equal(handed.row.phase, "waiting_input"); assert.equal(handed.metadataOnly, true);
    assert.equal(handed.pin, 1); assert.equal(handed.ends, 0); assert.deepEqual(handed.disposals, []);
    assert.deepEqual(handed.children, first.children); assert.equal(handed.childId, first.children[0]);
    const observed = f.states.find((row) => row.kind === "native-input-status");
    assert.equal(observed.row.phase, "waiting_input"); assert.equal(observed.pin, 1); assert.equal(observed.ends, 0);
    assert.deepEqual(observed.disposals, []);
    const answer = f.wire.filter((row) => row.kind === "native-answer");
    assert.deepEqual(answer.map((row) => ({ requestId: row.requestId, result: row.result })), [{ requestId: handed.nativeRequestId,
      result: { answers: { scope: { answers: ["Inspect existing configuration only"] } } } }]);
    assert.equal(answer[0].originalActive, true);
    assert.equal(f.wire.filter((row) => row.kind === "model-request" && !row.schema).length, 1);
    assert.equal(f.wire.filter((row) => row.kind === "model-request" && row.schema).length, 1);
    assert.equal(completed.row.id, first.row.id);
    passed = true;
  } finally { if (passed) await f.close(); else t.diagnostic(`Failure evidence retained at ${f.directory}`); }
});

test("a resumed receipt's failed interruption waits for its exact ACK and continues without a completion notification", async (t) => {
  const f = await fixture("reabort-no-completion"); let passed = false;
  try {
    const { first } = released(f);
    const second = f.states.find((row) => row.kind === "second-waiting");
    assert.equal(second.row.processState, "waiting"); assert.equal(second.sameOwner, true);
    assert.equal(second.interruptionTurnId, first.original.turnId);
    assert.equal(second.pin, 1); assert.equal(second.ends, 0); assert.deepEqual(second.disposals, []);
    assert.equal(second.wire.filter((row: any) => row.kind === "model-request").length, 1);
    assert.ok(second.wire.some((row: any) => row.kind === "interrupt-request" && row.confirmed === false
      && row.threadId === first.original.threadId && row.turnId === first.original.turnId), "The second observer ends only after its real failed interruption ACK");
    const originalRegistrations = f.states.filter((row) => row.kind === "registered-pair" && row.turnId === first.original.turnId);
    assert.equal(originalRegistrations.length, 1, "The original pair is adopted only once despite the second local observer abort");
    const requests = f.wire.filter((row) => row.kind === "model-request");
    assert.equal(requests.filter((row) => !row.schema).length, 2); assert.equal(requests.filter((row) => row.schema).length, 1);
    const ackIndex = f.wire.findIndex((row) => row.kind === "interrupt-ack" && row.turnId === first.original.turnId);
    const nextIndex = f.wire.findIndex((row) => row.kind === "model-request" && row.requestId !== first.original.id);
    assert.ok(ackIndex >= 0 && nextIndex > ackIndex, "A successor writer starts only after the original exact interruption ACK");
    assert.equal(f.wire.filter((row) => row.kind === "completion" && row.turnId === first.original.turnId).length, 0);
    assert.ok(f.wire.filter((row) => row.kind === "interrupt-request").every((row) => row.threadId === first.original.threadId && row.turnId === first.original.turnId));
    passed = true;
  } finally { if (passed) await f.close(); else t.diagnostic(`Failure evidence retained at ${f.directory}`); }
});

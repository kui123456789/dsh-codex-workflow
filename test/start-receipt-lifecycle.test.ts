import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const actor = fileURLToPath(new URL("./fixtures/start-receipt-lifecycle-actor.ts", import.meta.url));
const readRows = async (path: string): Promise<any[]> => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  .map((row) => JSON.parse(row));
async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-start-receipt-lifecycle-"));
  const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx/esm")).href, actor, directory, mode],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const exit = await new Promise<number | null>((fulfill, reject) => { child.once("error", reject); child.once("exit", fulfill); });
  const states = await readRows(join(directory, "states.jsonl")), wire = await readRows(join(directory, "wire.jsonl"));
  return { exit, states, wire, async close() {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  } };
}
test("healthy delayed start reply still finishes the original Planner normally", async () => {
  const f = await fixture("healthy");
  try {
    assert.equal(f.exit, 0); assert.equal(f.states.at(-1).kind, "actor-completed");
    const outcome = f.states.find((row) => row.kind === "healthy-outcome");
    assert.deepEqual(outcome.errors, []); assert.equal(outcome.row.phase, "executing");
    assert.equal(f.wire.filter((row) => row.kind === "start-rpc-observed" && !row.schema).length, 1);
  } finally { await f.close(); }
});
for (const mode of ["abort", "timeout"]) test(`${mode} before start receipt preserves the original operation and never repeats its model request`, async () => {
  const f = await fixture(mode);
  try {
    assert.equal(f.exit, 0); assert.equal(f.states.at(-1).kind, "actor-completed");
    const initial = f.states.find((row) => row.kind === "first-observer-outcome");
    assert.ok(initial.row, "An accepted original operation must remain discoverable after its local observer ends");
    assert.equal(initial.row.processState, "waiting");
    const waiting = f.states.find((row) => row.kind === "receipt-waiting");
    assert.equal(waiting.continuation.available, false, "An unknown original receipt cannot authorize a new model turn");
    assert.equal(waiting.continuation.reason, "start_receipt_pending");
    assert.equal(waiting.planDisplay?.status, "planning");
    assert.equal(waiting.planDisplay?.processState, "waiting", "unknown original start receipt is a paused display, not a completed plan");
    assert.equal(waiting.pin, 1); assert.equal(waiting.children.length, 1); assert.deepEqual(waiting.disposals, []);
    const early = f.states.find((row) => row.kind === "before-receipt-resume");
    assert.equal(early.wire.filter((row: any) => row.kind === "start-rpc-observed" && !row.schema).length, 1);
    assert.deepEqual(early.children, waiting.children); assert.deepEqual(early.disposals, []);
    const completed = f.states.find((row) => row.kind === "after-receipt-resume");
    assert.deepEqual(completed.errors, []); assert.equal(completed.row.phase, "executing");
    assert.equal(completed.planDisplay?.status, "ready");
    assert.equal(completed.planDisplay?.processState, "completed");
    assert.equal(completed.wire.filter((row: any) => row.kind === "start-rpc-observed" && !row.schema).length, 1);
    const accepted = f.wire.find((row) => row.kind === "actual-writer-accepted" && !row.schema);
    const receipts = f.states.filter((row) => row.kind === "adopted-original-receipt" && row.turnId === accepted.turnId);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].threadId, accepted.threadId);
    assert.deepEqual(completed.children, waiting.children);
  } finally { await f.close(); }
});

test("cancel before the original receipt retains cleanup ownership and never revives the workflow", async () => {
  const f = await fixture("cancel");
  try {
    assert.equal(f.exit, 0); assert.equal(f.states.at(-1).kind, "actor-completed");
    const waiting = f.states.find((row) => row.kind === "cancelled-before-receipt");
    assert.equal(waiting.row.phase, "cancelled"); assert.equal(waiting.pin, 1); assert.deepEqual(waiting.disposals, []);
    const finished = f.states.find((row) => row.kind === "cancelled-after-receipt");
    assert.equal(finished.planWaitingEvents, waiting.planWaitingEvents, "cancelled late receipt cannot publish a fresh paused Planner");
    assert.deepEqual(finished.errors, []); assert.equal(finished.row.phase, "cancelled");
    assert.equal(finished.row.retryState, undefined); assert.equal(finished.pin, 0);
    assert.deepEqual(finished.disposals, waiting.children);
    assert.equal(f.wire.filter((row) => row.kind === "start-rpc-observed").length, 1);
    assert.ok(f.wire.filter((row) => row.kind === "actual-interrupt").length > 0);
  } finally { await f.close(); }
});

test("plugin stop keeps the pending child until the original captured process tree exits", async () => {
  const f = await fixture("stop");
  try {
    assert.equal(f.exit, 0); assert.equal(f.states.at(-1).kind, "actor-completed");
    const waiting = f.states.find((row) => row.kind === "stopped-before-receipt");
    assert.deepEqual(waiting.disposals, []); assert.equal(waiting.pin, 1);
    const finished = f.states.find((row) => row.kind === "stopped-after-original-exit");
    assert.equal(finished.planWaitingEvents, waiting.planWaitingEvents, "stopped late receipt cannot publish a fresh pause");
    assert.deepEqual(finished.disposals, waiting.children); assert.equal(finished.pin, 0); assert.equal(finished.recoverable, 0);
    assert.equal(finished.row.retryState, undefined); assert.equal(finished.row.processState, "failed");
    assert.equal(f.wire.filter((row) => row.kind === "start-rpc-observed").length, 1);
  } finally { await f.close(); }
});

for (const mode of ["review-native", "review-conversion", "review-alignment"]) test(`${mode} reattaches the original review operation without repeating its stage`, async () => {
  const f = await fixture(mode);
  try {
    assert.equal(f.exit, 0); assert.equal(f.states.at(-1).kind, "actor-completed");
    const waiting = f.states.find((row) => row.kind === "review-waiting");
    assert.deepEqual(waiting.errors, []); assert.equal(waiting.row.processState, "waiting");
    assert.equal(waiting.continuation.available, false); assert.equal(waiting.continuation.reason, "start_receipt_pending");
    assert.deepEqual(waiting.disposals, []); assert.equal(waiting.children.length, 1);
    const early = f.states.find((row) => row.kind === "review-before-receipt");
    assert.equal(early.wire.filter((row: any) => row.kind === "start-rpc-observed").length,
      waiting.wire.filter((row: any) => row.kind === "start-rpc-observed").length);
    const complete = f.states.find((row) => row.kind === "review-completed");
    assert.deepEqual(complete.errors, []); assert.equal(complete.row.phase, "passed"); assert.equal(complete.row.reviewCycles, 1);
    assert.equal(complete.wire.filter((row: any) => row.kind === "actual-writer-accepted" && row.property === waiting.original.property
      && row.method === waiting.original.method && row.threadId === waiting.original.threadId).length, 1);
    assert.deepEqual(complete.children, waiting.children); assert.deepEqual(complete.disposals, waiting.children); assert.equal(complete.pin, 0);
  } finally { await f.close(); }
});

test("cancel overlapping pending Planner resume leaves resources with the original cleanup owner", async () => {
  const f = await fixture("resume-cancel");
  try {
    assert.equal(f.exit, 0);
    const held = f.states.find((row) => row.kind === "resume-cancel-returned");
    assert.equal(held.row.phase, "cancelled"); assert.equal(held.pin, 1); assert.deepEqual(held.disposals, []);
    const cleaned = f.states.find((row) => row.kind === "resume-cancel-cleaned");
    assert.equal(cleaned.row.phase, "cancelled"); assert.equal(cleaned.row.retryState, undefined);
    assert.equal(cleaned.pin, 0); assert.deepEqual(cleaned.disposals, held.children);
    assert.equal(f.wire.filter((row) => row.kind === "start-rpc-observed").length, 1);
  } finally { await f.close(); }
});

test("a terminal conversion after adopting the original receipt releases its child and round", async () => {
  const f = await fixture("invalid-conversion");
  try {
    assert.equal(f.exit, 0);
    const completed = f.states.find((row) => row.kind === "after-receipt-resume");
    assert.equal(completed.row.phase, "failed"); assert.ok(completed.row.error);
    assert.equal(completed.pin, 0); assert.deepEqual(completed.disposals, completed.children);
    assert.equal(f.wire.filter((row) => row.kind === "start-rpc-observed" && !row.schema).length, 1);
  } finally { await f.close(); }
});

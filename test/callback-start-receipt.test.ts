import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const requireHost = createRequire(import.meta.url);
const actor = fileURLToPath(new URL("./fixtures/callback-start-receipt-actor.ts", import.meta.url));

/** Real SDK, stdio and native DSH child; only upstream output is synthetic. */
async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-start-receipt-"));
  try {
    const child = spawn(process.execPath, ["--import", pathToFileURL(requireHost.resolve("tsx/esm")).href, actor, directory, mode,
      mode === "visible-timeout" ? "120" : "0", mode === "visible-abort" ? "120" : "0"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    child.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
    child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
    const exit = await new Promise<number | null>((fulfill, reject) => { child.once("error", reject); child.once("exit", fulfill); });
    assert.equal(exit, 0, diagnostics);
    return JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as { mode: string; states: any[] };
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const mode of ["visible-abort", "rewrite-abort", "conversion-abort", "fork-abort", "visible-timeout", "conversion-timeout", "visible-finished"]) {
  test(`callback ${mode} adopts its original start receipt without repeating the model stage`, async () => {
    const result = await fixture(mode);
    const first = result.states.find((state) => state.kind === "first");
    const early = result.states.find((state) => state.kind === "early");
    const resumed = result.states.find((state) => state.kind === "resumed");
    assert.equal(first.available, false); assert.equal(first.pending, true); assert.equal(first.pin, 1);
    assert.equal(first.children.length, 1); assert.deepEqual(first.disposals, []);
    assert.deepEqual(early.children, first.children); assert.deepEqual(early.disposals, []);
    assert.equal(early.wire.filter((row: any) => row.kind === "model-start-rpc").length,
      first.wire.filter((row: any) => row.kind === "model-start-rpc").length);
    assert.equal(early.early.value.kind, "retryable_busy");
    assert.equal(resumed.resumed.value.kind, "verdict"); assert.equal(resumed.pin, 0);
    assert.deepEqual(resumed.children, first.children); assert.deepEqual(resumed.disposals, []);
    const original = first.wire.find((row: any) => row.kind === "model-accepted" && row.held);
    if (mode.endsWith("timeout")) assert.deepEqual(first.timeoutFault, { requestId: original.id, timeoutMs: 80 });
    assert.equal(resumed.wire.filter((row: any) => row.kind === "model-start-rpc" && row.stage === original.stage).length, 1);
    assert.equal(resumed.started.filter((pair: any) => pair.threadId === original.threadId && pair.turnId === original.turnId).length, 1);
    assert.equal(resumed.wire.filter((row: any) => row.kind === "thread-created" && row.method === "thread/start").length, 1);
    assert.equal(resumed.wire.filter((row: any) => row.kind === "actual-unsubscribe" && row.threadId === original.threadId).length, 1);
    assert.ok(resumed.wire.filter((row: any) => row.kind === "model-start-rpc").every((row: any) => !row.originalActive));
    assert.ok(!JSON.stringify(resumed.progress).includes('\\"verdict\\":\\"pass\\"'), "Internal conversion JSON must stay out of the child display");
    if (mode.startsWith("fork")) assert.equal(resumed.wire.filter((row: any) => row.kind === "thread-created" && row.method === "thread/fork").length, 1);
  });
}

for (const mode of ["visible-cancel", "conversion-cancel"]) test(`callback ${mode} keeps ownership until original cleanup ACK`, async () => {
  const result = await fixture(mode);
  const waiting = result.states.find((state) => state.kind === "cancel-before-receipt");
  const finished = result.states.find((state) => state.kind === "cancel-confirmed");
  assert.equal(waiting.pin, 1); assert.equal(waiting.pending, true); assert.deepEqual(waiting.disposals, []);
  assert.equal(waiting.wire.filter((row: any) => row.kind === "actual-unsubscribe").length, 0);
  assert.equal(finished.pin, 0); assert.equal(finished.pending, false);
  assert.deepEqual(finished.children, waiting.children); assert.deepEqual(finished.disposals, []);
  const original = waiting.wire.find((row: any) => row.kind === "model-accepted" && row.held);
  assert.equal(finished.wire.filter((row: any) => row.kind === "model-start-rpc" && row.stage === original.stage).length, 1);
  assert.equal(finished.wire.filter((row: any) => row.kind === "actual-unsubscribe").length, 1);
  assert.ok(finished.wire.some((row: any) => row.kind === "actual-interrupt" && row.confirmed));
});

test("callback stop keeps pending original ownership until its whole process exits", async () => {
  const result = await fixture("visible-stop");
  const waiting = result.states.find((state) => state.kind === "stop-before-exit");
  const finished = result.states.find((state) => state.kind === "stop-after-exit");
  assert.equal(waiting.pin, 1); assert.equal(waiting.pending, true); assert.deepEqual(waiting.disposals, []);
  assert.equal(finished.pin, 0); assert.equal(finished.pending, false);
  assert.equal(finished.wire.filter((row: any) => row.kind === "model-start-rpc").length, 1);
  assert.deepEqual(finished.children, waiting.children); assert.deepEqual(finished.disposals, []);
});

test("callback process exit reconciles the pending start before reporting unavailable without replacement", async () => {
  const result = await fixture("visible-unavailable");
  const waiting = result.states.find((state) => state.kind === "unavailable-waiting");
  const finished = result.states.find((state) => state.kind === "unavailable-finished");
  assert.equal(waiting.waiting.value.kind, "retryable_busy"); assert.equal(waiting.pending, true);
  assert.equal(typeof waiting.terminal, "string");
  assert.equal(finished.finished.error.name, "CodexInvalidThreadError");
  assert.equal(finished.pin, 0); assert.equal(finished.pending, false);
  assert.equal(finished.wire.filter((row: any) => row.kind === "thread-created").length, 1);
  assert.equal(finished.wire.filter((row: any) => row.kind === "model-start-rpc").length, 1);
});

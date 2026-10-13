import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-late-thread-start-app-server.mjs", import.meta.url));
type Stats = { processId: number; initializations: number; heldThreadStarts: number;
  threadStartRequests: unknown[]; threadStarts: unknown[]; turnStartRequests: unknown[] };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-rpc-settlement-"));
  const processLog = join(directory, "wire.jsonl");
  const client = new CodexAppServerClient({ command: process.execPath, args: [protocol, "--process-log", processLog],
    requestTimeoutMs: 15_000, rpcTimeoutMs: 15_000, idleProcessMs: 0, quitGraceMs: 1000, killGraceMs: 1000 });
  const port = client as unknown as { pending: Map<unknown, unknown>; options: { rpcTimeoutMs?: number };
    request<T>(method: string, params: object): Promise<T> };
  const control = (method: string, params: object = {}) => port.request<Stats>(method, params);
  await client.start();
  const original = await control("fixture/stats");
  const assertQuiescent = (signal: AbortSignal) => {
    assert.equal(getEventListeners(signal, "abort").length, 0, "A terminal RPC does not retain its caller's signal listener");
    assert.equal(port.pending.size, 0, "No settled RPC remains in the original pending map");
  };
  const start = (signal: AbortSignal) => client.startThread({ cwd: directory, model: "model-A", ephemeral: true }, signal);
  return { client, port, control, original, assertQuiescent, start,
    async assertNoModels() {
      const stats = await control("fixture/stats");
      assert.equal(stats.processId, original.processId);
      assert.equal(stats.initializations, 1);
      assert.deepEqual(stats.turnStartRequests, []);
    },
    async close() {
      await client.stop();
      assert.throws(() => process.kill(original.processId, 0), { code: "ESRCH" });
      const starts = (await readFile(processLog, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as { kind: string }).filter((event) => event.kind === "start");
      assert.equal(starts.length, 1, "RPC settlement never creates a replacement diagnostic backend");
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    } };
}

test("RPC timeout clears the held original request's abort listener before and after client stop", async () => {
  const f = await fixture();
  const caller = new AbortController();
  try {
    f.assertQuiescent(caller.signal);
    // Initialization uses the generous default. Only this deliberately held
    // request needs a short deadline; a fresh protocol boot is not timed here.
    f.port.options.rpcTimeoutMs = 500;
    const starting = f.start(caller.signal);
    void starting.catch(() => undefined);
    const held = await f.control("fixture/waitForThreadCreation");
    assert.equal(held.heldThreadStarts, 1);
    assert.equal(getEventListeners(caller.signal, "abort").length, 1);
    await assert.rejects(starting, /Codex request timed out: thread\/start/);
    assert.equal(caller.signal.aborted, false);
    f.assertQuiescent(caller.signal);
    await f.assertNoModels();
    await f.client.stop();
    f.assertQuiescent(caller.signal);
  } finally { await f.close(); }
});

test("successful original RPC response clears pending resources without cancelling its caller", async () => {
  const f = await fixture();
  const caller = new AbortController();
  try {
    const starting = f.start(caller.signal);
    await f.control("fixture/waitForThreadCreation");
    assert.equal(getEventListeners(caller.signal, "abort").length, 1);
    await f.control("fixture/releaseThreadStart");
    assert.ok(await starting);
    assert.equal(caller.signal.aborted, false);
    f.assertQuiescent(caller.signal);
    await f.assertNoModels();
  } finally { await f.close(); }
});

test("original RPC error preserves its concrete primary cause and removes the caller listener", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const cause = "permission denied: ORIGINAL-RPC-CAUSE";
  try {
    await f.control("fixture/setNextThreadError", { message: cause });
    await assert.rejects(f.start(caller.signal), (error: unknown) => error instanceof Error && error.message === cause);
    assert.equal(caller.signal.aborted, false);
    f.assertQuiescent(caller.signal);
    await f.assertNoModels();
  } finally { await f.close(); }
});

test("explicit caller abort clears only its held RPC and retains the exact abort cause", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const cause = new Error("ORIGINAL-CALLER-RPC-ABORT");
  try {
    const starting = f.start(caller.signal);
    void starting.catch(() => undefined);
    await f.control("fixture/waitForThreadCreation");
    caller.abort(cause);
    await assert.rejects(starting, (error: unknown) => error === cause);
    f.assertQuiescent(caller.signal);
    await f.control("fixture/releaseThreadStart");
    f.assertQuiescent(caller.signal);
    await f.assertNoModels();
  } finally { await f.close(); }
});

test("client stop clears a held RPC's timer and listener while preserving the stop cause", async () => {
  const f = await fixture();
  const caller = new AbortController();
  try {
    const starting = f.start(caller.signal);
    void starting.catch(() => undefined);
    await f.control("fixture/waitForThreadCreation");
    await f.assertNoModels();
    await f.client.stop();
    await assert.rejects(starting, /Codex app-server stopped/);
    assert.equal(caller.signal.aborted, false);
    f.assertQuiescent(caller.signal);
  } finally { await f.close(); }
});

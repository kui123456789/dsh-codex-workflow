import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";

const serverFixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

async function fixture(t: TestContext, idleProcessMs = 0) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-availability-"));
  const processMarker = join(directory, "process.txt");
  const callsMarker = join(directory, "thread-calls.jsonl");
  const client = new CodexAppServerClient({
    command: process.execPath, args: [serverFixture], requestTimeoutMs: 5_000, idleProcessMs,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: processMarker, FAKE_CODEX_THREAD_PARAMS_MARKER: callsMarker },
  });
  t.after(async () => {
    try { await client.stop(); } finally {
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`), "cleanup stays in the system temporary directory");
      await rm(directory, { recursive: true, force: true });
    }
  });
  const pid = async () => {
    const value = Number((await readFile(processMarker, "utf8")).trim());
    assert.ok(Number.isSafeInteger(value) && value > 0 && value !== process.pid, "marker identifies the fixture child");
    return value;
  };
  const calls = () => readFile(callsMarker, "utf8");
  return { directory, processMarker, client, pid, calls };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("thread availability probes never start a process or send RPCs, and unsubscribe releases availability", async (t) => {
  const f = await fixture(t);
  assert.equal(f.client.isThreadAvailable("unknown"), false);
  await assert.rejects(access(f.processMarker), { code: "ENOENT" }, "a cold probe cannot spawn the fixture");
  const threadId = await f.client.startThread({ cwd: f.directory, ephemeral: true });
  const childPid = await f.pid();
  assert.equal(processAlive(childPid), true);
  const afterStart = await f.calls();
  assert.deepEqual(afterStart.trim().split("\n").map((line) => JSON.parse(line).method), ["thread/start"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(f.client.isThreadAvailable(threadId), true);
    assert.equal(f.client.isThreadAvailable("unknown"), false);
  }
  assert.equal(await f.calls(), afterStart, "repeated probes do not read, resume, start, or fork threads");
  assert.equal(await f.pid(), childPid, "repeated probes preserve the live process");
  assert.equal(await f.client.unsubscribeThread(threadId), "unsubscribed");
  const afterRelease = await f.calls();
  assert.equal(f.client.isThreadAvailable(threadId), false);
  assert.equal(await f.calls(), afterRelease, "released-thread probe does not reacquire a subscription");
  await f.client.stop();
  assert.equal(f.client.isThreadAvailable(threadId), false);
  assert.equal(await f.pid(), childPid, "post-stop probe cannot respawn an App Server");
});

test("a real unexpected App Server exit invalidates thread availability without probe-driven respawn", async (t) => {
  const f = await fixture(t);
  const threadId = await f.client.startThread({ cwd: f.directory, ephemeral: true });
  const firstPid = await f.pid();
  assert.equal(f.client.isThreadAvailable(threadId), true);
  const beforeExit = await f.calls();
  assert.equal(processAlive(firstPid), true, "only the confirmed test fixture process may be terminated");
  process.kill(firstPid);
  await waitUntil(() => !processAlive(firstPid), `fixture process ${firstPid} to exit`);
  await waitUntil(() => !f.client.isThreadAvailable(threadId), "the real child exit event to invalidate availability");
  for (let attempt = 0; attempt < 20; attempt += 1) assert.equal(f.client.isThreadAvailable(threadId), false);
  assert.equal(await f.pid(), firstPid, "unavailable-thread probes do not replace the process marker");
  assert.equal(await f.calls(), beforeExit, "unavailable-thread probes do not issue model RPCs");

  assert.ok((await f.client.health()).modelCount > 0, "an explicit health request may start a replacement process");
  const replacementPid = await f.pid();
  assert.notEqual(replacementPid, firstPid);
  assert.equal(processAlive(replacementPid), true);
  assert.equal(f.client.isThreadAvailable(threadId), false, "a healthy new process cannot inherit the old ephemeral thread");
  assert.equal(await f.calls(), beforeExit, "health plus availability cannot create a replacement thread");
});

test("idle shutdown invalidates old thread capability even after explicit health respawns the App Server", async (t) => {
  const f = await fixture(t, 50);
  // Pin creation so the first observation does not race the idle timer.
  f.client.beginRound();
  const threadId = await f.client.startThread({ cwd: f.directory, ephemeral: true });
  const firstPid = await f.pid();
  assert.equal(f.client.isThreadAvailable(threadId), true);
  const beforeIdle = await f.calls();
  f.client.endRound();
  await waitUntil(() => !processAlive(firstPid), `idle fixture process ${firstPid} to exit`);
  assert.equal(f.client.isThreadAvailable(threadId), false);
  assert.equal(await f.pid(), firstPid, "the probe cannot undo the idle shutdown");
  assert.equal(await f.calls(), beforeIdle);

  f.client.beginRound();
  await f.client.health();
  const replacementPid = await f.pid();
  assert.notEqual(replacementPid, firstPid);
  assert.equal(processAlive(replacementPid), true);
  assert.equal(f.client.isThreadAvailable(threadId), false, "thread IDs are only known within their original process epoch");
  assert.equal(await f.calls(), beforeIdle, "the replacement remains thread-free until an explicit thread operation");
  f.client.endRound();
});

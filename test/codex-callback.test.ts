import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import {
  CodexCallbackDispatcher,
  CodexInvalidThreadError,
  CodexNoVerdictError,
  extractVerdict,
} from "../src/codex-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-resume.mjs");

async function makeSchema(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-schema-"));
  const schemaFile = join(directory, "review-schema.json");
  await writeFile(schemaFile, JSON.stringify({
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "changes_requested"] },
      findings: { type: "array" },
      testGaps: { type: "array" },
      summary: { type: "string" },
    },
    required: ["verdict", "findings", "testGaps", "summary"],
  }), "utf8");
  return schemaFile;
}

function dispatcher(schemaFile: string, timeoutMs = 10_000, env: Record<string, string> = {}, maxOutputBytes = 16_384) {
  return new CodexCallbackDispatcher({
    command: process.execPath,
    args: [fixture],
    schemaFile,
    timeoutMs,
    maxOutputBytes,
    env,
  });
}

const request = {
  workflowId: "wf-1",
  submissionId: "01a01411-0000-4000-8000-000000000001",
  codexThreadId: "01a01419-032c-76d0-98b9-16fe76ba455c",
  cwd: "C:\\Users\\张三\\project with spaces",
  prompt: "Review this implementation.",
};

const validVerdict = JSON.stringify({
  verdict: "changes_requested",
  findings: [{ severity: "high", blocking: true, title: "缺陷", body: "修复", file: "src/a.ts", line: 10 }],
  testGaps: [],
  summary: "需要修复",
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("the read-only child gets --json --output-schema and never writes the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-contract-"));
  try {
    const schemaFile = await makeSchema();
    const argsFile = join(directory, "args.jsonl");
    const stdinFile = join(directory, "stdin.txt");
    const queuePath = join(directory, "bridge", "inbox", "must-not-exist.json");
    const callback = dispatcher(schemaFile, 10_000, {
      FAKE_CALLBACK_ARGS_FILE: argsFile,
      FAKE_CALLBACK_STDIN_FILE: stdinFile,
      FAKE_CALLBACK_VERDICT: validVerdict,
    });
    const result = await callback.send(request);
    assert.equal(result.kind, "verdict");
    if (result.kind === "verdict") {
      assert.equal(result.verdict.verdict, "changes_requested");
      assert.equal(result.verdict.findings[0]?.blocking, true);
    }
    // The read-only child never wrote the queue or invoked respond.
    assert.equal(await exists(queuePath), false, "the child must not write the bridge queue");
    const args = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(args[0], [
      "exec",
      "--json",
      "--output-schema", schemaFile,
      "-C", request.cwd,
      "--sandbox", "read-only",
      "-c", "approval_policy=never",
      "resume", request.codexThreadId, "-",
    ]);
    assert.equal(await readFile(stdinFile, "utf8"), request.prompt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("extractVerdict takes the final agent message from JSONL and validates the schema", () => {
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "{\"verdict\":\"pass\",\"findings\":[],\"testGaps\":[],\"summary\":\"early\"}" } }),
    JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: validVerdict } }),
  ].join("\n");
  const verdict = extractVerdict(stream, 16_384);
  assert.equal(verdict.verdict, "changes_requested");
  assert.equal(verdict.findings[0]?.body, "修复");
});

test("missing final message, malformed JSON and schema violations are explicit failures", () => {
  assert.throws(() => extractVerdict("", 16_384), CodexNoVerdictError);
  assert.throws(
    () => extractVerdict(JSON.stringify({ type: "turn.completed", turn: {} }), 16_384),
    CodexNoVerdictError,
  );
  assert.throws(
    () => extractVerdict(`{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"not json"}}`, 16_384),
    /not valid JSON/,
  );
  assert.throws(
    () => extractVerdict(`{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\"verdict\\":\\"maybe\\"}"}}`, 16_384),
    /violates the review schema/,
  );
  assert.throws(() => extractVerdict("x".repeat(20_000), 1_024), /retention bound/);
});

test("a child that succeeds without any verdict message is an explicit failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-noverdict-"));
  try {
    const schemaFile = await makeSchema();
    const callback = dispatcher(schemaFile, 10_000, {
      FAKE_CALLBACK_JSONL: JSON.stringify({ type: "turn.completed", turn: { status: "completed" } }),
    });
    await assert.rejects(callback.send(request), CodexNoVerdictError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid thread id is terminal; rate-limit and unknown exits are retryable", async () => {
  const schemaFile = await makeSchema();
  const invalid = dispatcher(schemaFile, 10_000, {
    FAKE_CALLBACK_EXIT: "1",
    FAKE_CALLBACK_STDERR: "no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)",
  });
  await assert.rejects(invalid.send(request), CodexInvalidThreadError);

  const busy = dispatcher(schemaFile, 10_000, {
    FAKE_CALLBACK_EXIT: "1",
    FAKE_CALLBACK_STDERR: "exceeded retry limit, last status: 429 Too Many Requests",
  });
  assert.deepEqual(await busy.send(request), { kind: "retryable_busy" });
});

test("timeout and cancellation terminate the child", async () => {
  const schemaFile = await makeSchema();
  const timeout = dispatcher(schemaFile, 200, { FAKE_CALLBACK_HANG: "1" });
  const started = Date.now();
  assert.deepEqual(await timeout.send(request), { kind: "retryable_busy" });
  assert.ok(Date.now() - started >= 150);

  const cancelled = dispatcher(schemaFile, 60_000, { FAKE_CALLBACK_HANG: "1" });
  const controller = new AbortController();
  const pending = cancelled.send(request, controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled by test")), 100);
  await assert.rejects(pending, /cancelled by test/);
});

test("cancel(workflowId) and stop() kill active children and wait for them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-kill-"));
  try {
    const schemaFile = await makeSchema();
    const callback = dispatcher(schemaFile, 60_000, { FAKE_CALLBACK_HANG: "1" });
    const pending = callback.send(request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    callback.cancel("wf-1");
    const outcome = await pending;
    assert.deepEqual(outcome, { kind: "retryable_busy" }); // killed child -> close(0? no, kill) -> close with null code
    void outcome;

    const pending2 = callback.send({ ...request, submissionId: "01a01411-0000-4000-8000-000000000002" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await callback.stop();
    assert.equal((await Promise.race([pending2.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 2_000))])), "settled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a timeout waits for the child to fully exit before returning retryable", async () => {
  const schemaFile = await makeSchema();
  const spawns: ChildProcess[] = [];
  const dispatch = new CodexCallbackDispatcher({
    command: process.execPath,
    args: [fixture],
    schemaFile,
    timeoutMs: 150,
    env: { FAKE_CALLBACK_HANG: "1" },
    spawn: (command, args, options) => {
      const child = crossSpawn(command, args, options);
      spawns.push(child);
      return child;
    },
  });
  const started = Date.now();
  const pending = dispatch.send(request);
  // send() awaits its thread-idle isolation gate before spawning, so wait for
  // the child to appear before attaching the exit listener.
  const deadline = Date.now() + 3000;
  while (spawns.length === 0) {
    if (Date.now() > deadline) throw new Error("child never spawned");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const child = spawns[0]!;
  let exitObserved = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => { exitObserved = true; });
  const result = await pending;
  assert.deepEqual(result, { kind: "retryable_busy" });
  assert.ok(Date.now() - started >= 120);
  assert.equal(exitObserved, true, "the timed-out child must be fully exited before send resolves");
});

test("send rejects once the dispatcher is stopped", async () => {
  const schemaFile = await makeSchema();
  const dispatch = dispatcher(schemaFile, 10_000, { FAKE_CALLBACK_VERDICT: validVerdict });
  await dispatch.stop();
  await assert.rejects(dispatch.send(request), /dispatcher is stopped/);
  // stop() is idempotent and still rejects after a second call.
  await dispatch.stop();
  await assert.rejects(dispatch.send(request), /dispatcher is stopped/);
});

test("concurrent dispatcher.stop() calls share one settle promise", async () => {
  const schemaFile = await makeSchema();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  const fakeChild = new EventEmitter() as unknown as ChildProcess;
  (fakeChild as { exitCode: number | null }).exitCode = null;
  (fakeChild as { signalCode: string | null }).signalCode = null;
  (fakeChild as { kill: () => boolean }).kill = () => true;
  const out = new PassThrough();
  const err = new PassThrough();
  (fakeChild as { stdout: unknown }).stdout = out;
  (fakeChild as { stderr: unknown }).stderr = err;
  (fakeChild as { stdin: unknown }).stdin = new Writable({ write: (_chunk: Buffer, _enc: unknown, cb: () => void) => cb() });
  const dispatch = new CodexCallbackDispatcher({
    command: "nope",
    schemaFile,
    timeoutMs: 60_000,
    spawn: () => fakeChild as unknown as ChildProcess,
  });
  const sending = dispatch.send(request);
  // Let the async send pass its thread-idle gate and register the child.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const first = dispatch.stop();
  let secondDone = false;
  const second = dispatch.stop();
  second.then(() => { secondDone = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondDone, false, "the second stop must not resolve before the children exit");
  // Confirm the child exited (and its stdout/stderr ended): send() then settles
  // (with a no-verdict error, which we capture) and stop() resolves for BOTH
  // waiters — no stray unhandled rejection after the test.
  out.end();
  err.end();
  fakeChild.emit("close", 0);
  await Promise.all([first, second]);
  assert.equal(secondDone, true);
  await sending.catch(() => undefined);
});

/** Finding 3: a POST-spawn child error (IPC kill/send failure, abort) only
 * settles that send; the entry stays tracked until CLOSE — a same-thread send
 * and stop() both keep blocking, and even setting exitCode does NOT unblock
 * (only close does). */
test("a post-spawn child error keeps the entry alive until close", async () => {
  const schemaFile = await makeSchema();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  const fakeChild = new EventEmitter() as unknown as ChildProcess;
  (fakeChild as { pid: number }).pid = 12345;
  (fakeChild as { exitCode: number | null }).exitCode = null;
  (fakeChild as { signalCode: string | null }).signalCode = null;
  (fakeChild as { kill: () => boolean }).kill = () => true;
  const out = new PassThrough();
  const err = new PassThrough();
  (fakeChild as { stdout: unknown }).stdout = out;
  (fakeChild as { stderr: unknown }).stderr = err;
  (fakeChild as { stdin: unknown }).stdin = new Writable({ write: (_chunk: Buffer, _enc: unknown, cb: () => void) => cb() });
  const dispatch = new CodexCallbackDispatcher({
    command: "nope",
    schemaFile,
    timeoutMs: 60_000,
    spawn: () => fakeChild as unknown as ChildProcess,
  });
  const p1 = dispatch.send(request);
  await new Promise((resolve) => setTimeout(resolve, 60));
  fakeChild.emit("error", new Error("ipc send failure"));
  await assert.rejects(p1, /ipc send failure/);
  // The errored-but-alive child must still gate a same-thread send.
  let p2Done = false;
  const p2 = dispatch.send(request);
  p2.then(() => { p2Done = true; }).catch(() => { p2Done = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(p2Done, false, "same-thread send blocks while the errored child is alive");
  // Even setting exitCode must NOT unblock: only close retires the entry.
  (fakeChild as { exitCode: number | null }).exitCode = 1;
  let stopDone = false;
  const stopPromise = dispatch.stop();
  stopPromise.then(() => { stopDone = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stopDone, false, "stop waits for close even after exitCode was set on an errored child");
  out.end();
  err.end();
  fakeChild.emit("close", 1);
  await stopPromise;
  assert.equal(stopDone, true);
  await p2.catch(() => undefined); // rejects with "stopped" once the gate opens
});

/** Finding 3: a SPAWN failure (no pid, no process) surfaces the error and
 * must never hang teardown. */
test("a spawn failure rejects the send and does not hang stop", async () => {
  const schemaFile = await makeSchema();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  const fakeChild = new EventEmitter() as unknown as ChildProcess;
  (fakeChild as { exitCode: number | null }).exitCode = null;
  (fakeChild as { signalCode: string | null }).signalCode = null;
  (fakeChild as { kill: () => boolean }).kill = () => true;
  (fakeChild as { stdout: unknown }).stdout = new PassThrough();
  (fakeChild as { stderr: unknown }).stderr = new PassThrough();
  (fakeChild as { stdin: unknown }).stdin = new Writable({ write: (_chunk: Buffer, _enc: unknown, cb: () => void) => cb() });
  const dispatch = new CodexCallbackDispatcher({
    command: "nope",
    schemaFile,
    timeoutMs: 60_000,
    spawn: () => fakeChild as unknown as ChildProcess,
  });
  const p = dispatch.send(request);
  await new Promise((resolve) => setTimeout(resolve, 50));
  fakeChild.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  await assert.rejects(p, /spawn ENOENT/);
  // Nothing was tracked (no process), so stop cannot stall on a non-existent child.
  await Promise.race([
    dispatch.stop(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stop hung on a spawn-failed child")), 300)),
  ]);
});

/** Finding 3 (escalation): a child that ignores the first termination must
 * still be SIGKILL-escalated via the full kill-and-wait escalation, so
 * dispatcher.stop() cannot wait for close forever. */
test("stop() escalates a stubborn child through kill->SIGKILL and completes", async () => {
  const schemaFile = await makeSchema();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  const fakeChild = new EventEmitter() as unknown as ChildProcess;
  (fakeChild as { pid: number }).pid = 9001;
  (fakeChild as { exitCode: number | null }).exitCode = null;
  (fakeChild as { signalCode: string | null }).signalCode = null;
  const killCalls: Array<string | null> = [];
  (fakeChild as { kill: (signal?: string | number | null) => boolean }).kill = (signal?: string | number | null) => {
    killCalls.push(typeof signal === "string" ? signal : null);
    if (signal === "SIGKILL") {
      // Only the escalated SIGKILL terminates this stubborn child.
      setImmediate(() => {
        (fakeChild as { exitCode: number | null }).exitCode = 137;
        (fakeChild as { signalCode: string | null }).signalCode = "SIGKILL";
        fakeChild.emit("close", 137);
      });
    }
    return true;
  };
  const out = new PassThrough();
  const err = new PassThrough();
  (fakeChild as { stdout: unknown }).stdout = out;
  (fakeChild as { stderr: unknown }).stderr = err;
  (fakeChild as { stdin: unknown }).stdin = new Writable({ write: (_chunk: Buffer, _enc: unknown, cb: () => void) => cb() });
  const dispatch = new CodexCallbackDispatcher({
    command: "nope",
    schemaFile,
    timeoutMs: 60_000,
    killGraceMs: 40,
    killKillGraceMs: 80,
    spawn: () => fakeChild as unknown as ChildProcess,
  });
  const sending = dispatch.send(request);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await Promise.race([
    dispatch.stop().then(() => undefined),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stop was not escalated and hung forever")), 1000)),
  ]);
  // The first termination was followed by at least one SIGKILL escalation.
  assert.ok(killCalls.length >= 2, `expected SIGTERM then SIGKILL, got ${JSON.stringify(killCalls)}`);
  assert.equal(killCalls[0], null, "first termination is the plain kill()");
  assert.ok(killCalls.slice(1).includes("SIGKILL"), "a SIGKILL escalation was issued");
  out.end();
  err.end();
  await sending.catch(() => undefined);
});

test("a verdict split across chunk boundaries keeps multi-byte UTF-8 intact", async () => {
  const schemaFile = await makeSchema();
  // Rebuild the exact JSONL wrapper the fixture emits, then choose a byte
  // offset INSIDE a Chinese character so the decoder must reassemble it.
  const text = validVerdict;
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "00000000-0000-0000-0000-000000000000" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } }),
    JSON.stringify({ type: "turn.completed", turn: { id: "turn-1", status: "completed" } }),
  ].join("\n");
  const textStart = stream.indexOf(text);
  const cjkByte = Buffer.from(text, "utf8").indexOf(Buffer.from("缺陷", "utf8"));
  const midChar = textStart + cjkByte + 1; // split after the lead byte of 缺
  const callback = dispatcher(schemaFile, 10_000, {
    FAKE_CALLBACK_VERDICT: text,
    FAKE_CALLBACK_CHUNK_AT: String(midChar),
  });
  const result = await callback.send(request);
  assert.equal(result.kind, "verdict");
  if (result.kind === "verdict") {
    assert.equal(result.verdict.verdict, "changes_requested");
    assert.equal(result.verdict.findings[0]?.title, "缺陷");
    assert.equal(result.verdict.findings[0]?.body, "修复");
    assert.equal(result.verdict.summary, "需要修复");
  }
});

test("stdout over the byte bound kills the child with an explicit failure", async () => {
  const schemaFile = await makeSchema();
  const overflow = dispatcher(schemaFile, 10_000, { FAKE_CALLBACK_STDOUT_BYTES: "65536" }, 1024);
  await assert.rejects(
    overflow.send(request),
    (error: unknown) => error instanceof CodexNoVerdictError && /retention bound/.test(error.message),
  );
});

test("stderr over the byte bound still classifies busy from the retained head", async () => {
  const schemaFile = await makeSchema();
  const longStderr = "exceeded retry limit, last status: 429 Too Many Requests\n" + "x".repeat(5000);
  const overflow = dispatcher(schemaFile, 10_000, { FAKE_CALLBACK_EXIT: "1", FAKE_CALLBACK_STDERR: longStderr }, 1024);
  assert.deepEqual(await overflow.send(request), { kind: "retryable_busy" });
});

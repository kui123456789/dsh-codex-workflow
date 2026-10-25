import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { PLANNER_OUTPUT_SCHEMA } from "../src/schemas.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-native-receipt-app-server.mjs", import.meta.url));
type Stats = { processId: number; threadStarts: Array<{ threadId: string; method: string }>;
  turnStartRequests: Array<{ threadId: string; turnId: string }>; active: Array<{ threadId: string; turnId: string }>;
  interrupts: Array<{ threadId: string; turnId: string }>; unsubscribes: string[]; nativeReplies: number };

async function fixture(mode: "failed" | "confirmed" | "held" = "failed", ephemeral = true) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-sdk-cleanup-only-"));
  const processLog = join(directory, "process.jsonl");
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [protocol, "--interrupt-mode", mode, "--process-log", processLog], requestTimeoutMs: 5000, rpcTimeoutMs: 15_000, idleProcessMs: 0 });
  const request = (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(client);
  const control = (method: string, params: object = {}) => request<Stats>(method, params);
  const threadId = await client.startThread({ cwd: directory, model: "model-A", ephemeral });
  const configure = (responses: object) => control("fixture/configure", { responses });
  const stats = () => control("fixture/stats");
  const conversion = () => client.normalizeInFork({ threadId, cwd: directory, sourceEphemeral: ephemeral,
    prompt: "Convert the completed original plan", outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown> });
  const finishCleanup = async (error: CodexTurnInterruptionError) => {
    const before = await stats();
    await control("fixture/setInterruptMode", { mode: "confirmed" });
    await client.interrupt(error.threadId, error.turnId);
    const after = await stats();
    assert.equal(after.turnStartRequests.length, before.turnStartRequests.length, "Cleanup never runs another model turn");
    assert.deepEqual(after.active, []);
    assert.equal(after.interrupts.at(-1)?.threadId, error.threadId);
    assert.equal(after.interrupts.at(-1)?.turnId, error.turnId);
    const turns = (client as unknown as { turns: Map<string, { input?: object }> }).turns;
    assert.equal(turns.get(`${error.threadId}:${error.turnId}`)?.input, undefined,
      "An exact terminal receipt retires the interrupted native input request");
  };
  return { client, directory, threadId, control, configure, stats, conversion, finishCleanup,
    async processStarts() { return (await readFile(processLog, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { kind: string }).filter((event) => event.kind === "start").length; },
    async close() {
      if ((client as unknown as { child?: ChildProcess }).child?.exitCode === null) {
        await control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
        await control("fixture/completeActive").catch(() => undefined);
        await control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
      }
      await client.stop();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    } };
}

for (const boundary of ["turn registration", "review registration", "review settings"] as const) {
  for (const ack of ["failed", "confirmed"] as const) {
    test(`${boundary} failure preserves its primary error and observes the ${ack} interruption ACK`, async () => {
      const f = await fixture(ack);
      const original = new Error(`permission denied during ${boundary}`);
      const port = f.client as unknown as { request<T>(method: string, params: object, signal?: AbortSignal): Promise<T> };
      const request = port.request;
      try {
        await f.configure({ visible: [{ kind: "hold" }] });
        if (boundary === "review settings") port.request = function<T>(method: string, params: object, signal?: AbortSignal) {
          return method === "thread/settings/update" ? Promise.reject(original) : request.call(this, method, params, signal) as Promise<T>;
        };
        const task = boundary === "turn registration"
          ? f.client.startTurn(f.threadId, { prompt: "Plan original diagnostics", onStarted: () => { throw original; } })
          : f.client.startReview({ threadId: f.threadId, cwd: f.directory, detached: false, target: { type: "custom", instructions: "Review original diagnostics" },
            ...(boundary === "review registration" ? { onStarted: () => { throw original; } } : {}) });
        let failure: unknown;
        await task.catch((error: unknown) => { failure = error; });
        assert.ok(failure instanceof Error);
        const observed = await f.stats();
        assert.equal(observed.threadStarts.length, 1);
        assert.equal(observed.turnStartRequests.length, 1);
        assert.deepEqual(observed.unsubscribes, []);
        if (ack === "confirmed") {
          assert.equal(failure, original);
          assert.deepEqual(observed.active, []);
        } else {
          assert.ok(failure instanceof CodexTurnInterruptionError);
          assert.equal(failure.cleanupOnly, true);
          assert.equal(failure.cause, original);
          assert.equal(failure.originalProcessId, observed.processId);
          assert.ok(failure.originalProcessIds?.includes(observed.processId));
          assert.equal(failure.threadId, f.threadId);
          assert.equal(failure.turnId, observed.turnStartRequests[0]?.turnId);
          assert.deepEqual(observed.active, [{ threadId: failure.threadId, turnId: failure.turnId }]);
          assert.equal(f.client.isThreadAvailable(f.threadId), true);
          assert.equal(JSON.stringify(failure).includes(f.threadId), false);
          await f.finishCleanup(failure);
        }
      } finally { port.request = request; await f.close(); }
    });
  }
}

for (const ephemeral of [true, false]) {
  for (const ack of ["failed", "confirmed"] as const) {
    test(`${ephemeral ? "original ephemeral" : "private fork"} conversion native input requires ${ack} exact cleanup`, async () => {
      const f = await fixture(ack, ephemeral);
      try {
        await f.configure({ status: [{ kind: "needs_input" }] });
        let failure: unknown;
        await f.conversion().catch((error: unknown) => { failure = error; });
        assert.ok(failure instanceof Error, "Conversion must reject its unexpected native request");
        assert.match(failure.message, /structured conversion unexpectedly requested user input/i);
        const observed = await f.stats();
        assert.equal(observed.threadStarts.length, ephemeral ? 1 : 2);
        assert.equal(observed.turnStartRequests.length, 1);
        assert.equal(observed.nativeReplies, 0, "The SDK never answers a private request with invented input");
        const privateThread = observed.turnStartRequests[0]!.threadId;
        if (ack === "failed") {
          assert.ok(failure instanceof CodexTurnInterruptionError);
          assert.equal(failure.cleanupOnly, true);
          assert.equal(failure.threadId, privateThread);
          assert.deepEqual(observed.active, [{ threadId: privateThread, turnId: failure.turnId }]);
          assert.deepEqual(observed.unsubscribes, [], "An unconfirmed private writer retains its subscription and native handle");
          assert.equal(f.client.isThreadAvailable(privateThread), true);
          await f.finishCleanup(failure);
        } else {
          assert.equal(failure instanceof CodexTurnInterruptionError, false);
          assert.deepEqual(observed.active, []);
          assert.deepEqual(observed.unsubscribes, ephemeral ? [] : [privateThread]);
        }
      } finally { await f.close(); }
    });
  }
}

for (const method of ["review/start", "silent turn/start"] as const) {
  test(`${method} native input preserves a cleanup-only original pair after failed ACK`, async () => {
    const f = await fixture();
    try {
      await f.configure({ visible: [{ kind: "needs_input" }] });
      const task = method === "review/start"
        ? f.client.startReview({ threadId: f.threadId, cwd: f.directory, detached: false, target: { type: "custom", instructions: "Review original diagnostics" } })
        : f.client.startTurn(f.threadId, { prompt: "Continue original review", silentReview: true });
      let failure: unknown;
      await task.catch((error: unknown) => { failure = error; });
      assert.ok(failure instanceof CodexTurnInterruptionError);
      assert.equal(failure.cleanupOnly, true);
      assert.match(failure.cause instanceof Error ? failure.cause.message : "", /review unexpectedly requested user input/i);
      assert.equal(failure.threadId, f.threadId);
      const observed = await f.stats();
      assert.equal(observed.threadStarts.length, 1);
      assert.equal(observed.turnStartRequests.length, 1);
      assert.equal(observed.nativeReplies, 0);
      assert.deepEqual(observed.unsubscribes, []);
      await f.finishCleanup(failure);
    } finally { await f.close(); }
  });
}

test("ordinary Planner native clarification keeps its request and never interrupts it", async () => {
  const f = await fixture();
  try {
    await f.configure({ visible: [{ kind: "needs_input" }] });
    const pending = await f.client.startTurn(f.threadId, { prompt: "Plan original diagnostics", planMode: true });
    assert.equal(pending.kind, "needs_input");
    const observed = await f.stats();
    assert.equal(observed.active.length, 1);
    assert.deepEqual(observed.interrupts, []);
    assert.deepEqual(observed.unsubscribes, []);
  } finally { await f.close(); }
});

test("a durable conversion fork waiter timeout retains its original continuation classification and subscription after failed ACK", async (t) => {
  const f = await fixture("failed", false);
  const originalExecFile = childProcess.execFile;
  let activeCensuses = 0, peakCensuses = 0;
  const nativeQuery = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    const values = args[1];
    if (!Array.isArray(values) || !values.some(value => String(value).includes("Get-CimInstance Win32_Process"))) {
      return Reflect.apply(originalExecFile, childProcess, args);
    }
    activeCensuses += 1;
    peakCensuses = Math.max(peakCensuses, activeCensuses);
    const callback = args.at(-1) as (...values: unknown[]) => void;
    try {
      return Reflect.apply(originalExecFile, childProcess, [...args.slice(0, -1), (...values: unknown[]) => {
        activeCensuses -= 1;
        callback(...values);
      }]);
    } catch (error) { activeCensuses -= 1; throw error; }
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    await f.configure({ status: [{ kind: "hold" }] });
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 80;
    let failure: unknown;
    await f.conversion().catch((error: unknown) => { failure = error; });
    assert.ok(failure instanceof CodexTurnInterruptionError);
    assert.equal(failure.cleanupOnly, false, "A timeout remains distinct from a terminal callback or private-input contract error");
    assert.match(failure.cause instanceof Error ? failure.cause.message : "", /^Codex turn timed out:/);
    const observed = await f.stats();
    assert.equal(observed.threadStarts.length, 2);
    assert.notEqual(failure.threadId, f.threadId);
    assert.deepEqual(observed.unsubscribes, []);
    assert.deepEqual(observed.active, [{ threadId: failure.threadId, turnId: failure.turnId }]);
    await f.finishCleanup(failure);
  } finally {
    try { await f.close(); }
    finally { nativeQuery.mock.restore(); syncBuiltinESMExports(); }
  }
  if (process.platform === "win32") assert.equal(peakCensuses, 1,
    "one original backend must not compete with its own fork, receipt and interruption census queries");
});

test("a native conversion request cannot unsubscribe while its interruption ACK is still pending", async () => {
  const f = await fixture("held", false);
  try {
    await f.configure({ status: [{ kind: "needs_input" }] });
    let settled = false;
    const pending = f.conversion().then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    const deadline = Date.now() + 15_000;
    let observed = await f.stats();
    while (observed.interrupts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed = await f.stats();
    }
    assert.equal(observed.interrupts.length, 1);
    assert.equal(settled, false, "Returning the native request is not proof that its writer stopped");
    assert.deepEqual(observed.unsubscribes, []);
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    const error = await pending;
    assert.ok(error instanceof Error);
    assert.equal(error instanceof CodexTurnInterruptionError, false);
    const final = await f.stats();
    assert.deepEqual(final.active, []);
    assert.deepEqual(final.unsubscribes, [observed.turnStartRequests[0]!.threadId]);
  } finally { await f.close(); }
});

test("an original process exit during callback cleanup preserves the primary error without spawning a process", async () => {
  const f = await fixture("held");
  try {
    await f.configure({ visible: [{ kind: "hold" }] });
    const primary = new Error("permission denied during registration");
    const child = (f.client as unknown as { child: ChildProcess }).child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const pending = f.client.startTurn(f.threadId, { prompt: "Plan original diagnostics", onStarted: () => { throw primary; } })
      .then(() => undefined, (error: unknown) => error);
    const deadline = Date.now() + 15_000;
    while ((await f.stats()).interrupts.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.control("fixture/exit");
    await exited;
    assert.equal(await pending, primary);
    assert.equal(f.client.isThreadAvailable(f.threadId), false);
    await f.client.stop();
    assert.equal(await f.processStarts(), 1, "Cleanup and final stop never spawn a replacement for the old writer");
  } finally { await f.close(); }
});

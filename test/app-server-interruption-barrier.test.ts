import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";

const server = fileURLToPath(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url));
interface Stats {
  processId: number;
  initializations: number;
  threadStarts: Array<{ threadId: string }>;
  turnStartRequests: Array<{ threadId: string; prompt: string; model: string; effort: string }>;
  interrupts: Array<{ threadId: string; turnId: string }>;
  writerConflicts: number;
  heldInterrupts: number;
  active: Array<{ threadId: string; turnId: string }>;
}

async function fixture(interruption: "held" | "failed" | "confirmed", completed = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-real-interruption-barrier-"));
  const processLog = join(directory, "fixture-process.jsonl");
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [server, "--interrupt-mode", interruption, "--turn-mode", completed ? "completed" : "active", "--process-log", processLog],
    requestTimeoutMs: 150, rpcTimeoutMs: 5000, idleProcessMs: 0 });
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const control = (method: string, params: Record<string, unknown> = {}) => (client as unknown as {
    request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  }).request<Stats>(method, params);
  const threadId = await client.startThread({ cwd: directory, model: "model-A", ephemeral: true });
  let turnId: string | undefined;
  let settled = false;
  const begin = (abort: boolean) => {
    const running = client.startTurn(threadId, { prompt: "Plan read-only health diagnostics", model: "model-A", effort: "low",
      onStarted(value) {
        turnId = value.turnId;
        if (abort) controller.abort(new Error("CALLER-ABORT-SENTINEL"));
      } }, abort ? controller.signal : undefined);
    const observed = Promise.allSettled([running]);
    pending.push(observed);
    void observed.then(() => { settled = true; });
    return observed;
  };
  const assertNextOriginalTurn = async (processId: number) => {
    const result = await client.startTurn(threadId, { prompt: "Continue only unfinished work", model: "model-A", effort: "low" });
    assert.equal(result.kind, "completed");
    if (result.kind === "completed") assert.equal(result.status, "completed");
    const final = await control("fixture/stats");
    assert.equal(final.processId, processId, "Interruption recovery must not respawn the App Server");
    assert.equal(final.initializations, 1);
    assert.equal(final.threadStarts.length, 1);
    assert.equal(final.writerConflicts, 0);
    assert.equal(final.turnStartRequests.length, 2);
    assert.ok(final.turnStartRequests.every((request) => request.threadId === threadId && request.model === "model-A" && request.effort === "low"));
    assert.deepEqual(final.active, []);
  };
  return { client, controller, threadId, control, begin, assertNextOriginalTurn,
    async processEvents() { return (await readFile(processLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      kind: string; processId: number; threadId?: string; turnId?: string;
    }); },
    get turnId() { return turnId; }, get settled() { return settled; },
    async close() {
      if (client.isThreadAvailable(threadId)) await control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
      await Promise.allSettled(pending);
      await client.stop();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const reason of ["abort", "timeout"] as const) {
  test(`ordinary startTurn ${reason} waits for interruption acknowledgement before rejecting its caller`, async () => {
    const f = await fixture("held");
    try {
      const observed = f.begin(reason === "abort");
      const held = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
      assert.deepEqual(held.active, [{ threadId: f.threadId, turnId: f.turnId }]);
      assert.equal(held.heldInterrupts, 1);
      assert.equal(f.settled, false, "A caller cannot start its next turn while the original writer still awaits interruption acknowledgement");
      await f.control("fixture/releaseInterrupt", { confirmed: true });
      const outcome = (await observed)[0]!;
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof Error);
        assert.equal(outcome.reason instanceof CodexTurnInterruptionError, false, "A confirmed interruption preserves the original diagnostic");
        assert.match(outcome.reason.message, reason === "abort" ? /CALLER-ABORT-SENTINEL/ : /^Codex turn timed out:/);
      }
      await f.assertNextOriginalTurn(held.processId);
    } finally { await f.close(); }
  });
}

test("ordinary turn interruption failure reports the exact original pair without claiming the remote writer ended", async () => {
  const f = await fixture("failed");
  try {
    const observed = f.begin(true);
    const interrupted = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    const outcome = (await observed)[0]!;
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert.ok(outcome.reason instanceof CodexTurnInterruptionError);
      assert.equal(outcome.reason.threadId, f.threadId);
      assert.equal(outcome.reason.turnId, f.turnId);
      assert.equal(outcome.reason.interruptionConfirmed, false);
      assert.match(outcome.reason.message, /CALLER-ABORT-SENTINEL/);
      assert.ok(outcome.reason.cause instanceof Error);
      assert.equal(outcome.reason.cause.message, "CALLER-ABORT-SENTINEL");
      assert.equal(JSON.stringify(outcome.reason).includes(f.threadId), false, "Raw ephemeral identifiers must remain process-local");
    }
    assert.deepEqual(interrupted.active, [{ threadId: f.threadId, turnId: f.turnId }]);
    assert.equal(f.client.isThreadAvailable(f.threadId), true, "A failed interrupt is not a process exit");
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await f.client.interrupt(f.threadId, f.turnId!);
    await f.assertNextOriginalTurn(interrupted.processId);
  } finally { await f.close(); }
});

test("ordinary completed turns remain successful without sending interruption requests", async () => {
  const f = await fixture("confirmed", true);
  try {
    const outcome = (await f.begin(false))[0]!;
    assert.equal(outcome.status, "fulfilled");
    const stats = await f.control("fixture/stats");
    assert.deepEqual(stats.interrupts, []);
    assert.deepEqual(stats.active, []);
    assert.equal(stats.threadStarts.length, 1);
    assert.equal(stats.turnStartRequests.length, 1);
    assert.equal(stats.initializations, 1);
    assert.equal(stats.writerConflicts, 0);
  } finally { await f.close(); }
});

test("a late terminal notification confirms a failed interrupt without another interruption RPC", async () => {
  const f = await fixture("failed");
  try {
    const observed = f.begin(true);
    const before = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    const rejected = (await observed)[0]!;
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected") assert.ok(rejected.reason instanceof CodexTurnInterruptionError);
    assert.equal(before.interrupts.length, 1);
    await f.control("fixture/completeActive", { threadId: f.threadId });
    // Keep the fixture in failed-ACK mode: another RPC would fail, so success
    // here must be explained by the actual terminal notification cache.
    await f.client.interrupt(f.threadId, f.turnId!);
    await f.client.interrupt(f.threadId, f.turnId!);
    const completed = await f.control("fixture/stats");
    assert.equal(completed.interrupts.length, 1);
    assert.deepEqual(completed.active, []);
    await f.assertNextOriginalTurn(before.processId);
  } finally { await f.close(); }
});

for (const terminal of ["exit", "stop"] as const) {
  test(`App Server ${terminal} during a pending interruption never respawns to clean the original pair`, async () => {
    const f = await fixture("held");
    try {
      const observed = f.begin(true);
      const held = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
      assert.equal(f.settled, false);
      assert.equal(held.heldInterrupts, 1);
      if (terminal === "exit") {
        const child = (f.client as unknown as { child: ChildProcess }).child;
        assert.ok(child);
        const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
        await f.control("fixture/exit");
        await exited;
      } else await f.client.stop();
      const rejected = (await observed)[0]!;
      assert.equal(rejected.status, "rejected");
      if (rejected.status === "rejected") {
        assert.ok(rejected.reason instanceof Error);
        assert.equal(rejected.reason instanceof CodexTurnInterruptionError, false, "A dead original process is terminal, not recoverable on a new process");
        assert.match(rejected.reason.message, /CALLER-ABORT-SENTINEL/);
      }
      assert.equal(f.client.isThreadAvailable(f.threadId), false);
      await assert.rejects(f.client.interrupt(f.threadId, f.turnId!), /original.*process.*unavailable/i);
      await f.client.stop();
      const events = await f.processEvents();
      assert.equal(events.filter((event) => event.kind === "start").length, 1, "Cleanup must never launch a replacement process");
      assert.ok(events.every((event) => event.processId === held.processId));
      const interrupts = events.filter((event) => event.kind === "interrupt");
      assert.deepEqual(interrupts, [{ kind: "interrupt", processId: held.processId, threadId: f.threadId, turnId: f.turnId }]);
    } finally { await f.close(); }
  });
}

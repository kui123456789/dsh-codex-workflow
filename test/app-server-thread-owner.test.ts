import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import { sharedGate, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
type Stats = { processId: number; active: Array<{ threadId: string; turnId: string }>;
  turnStartRequests: unknown[]; interrupts: unknown[]; unsubscribes: string[]; nativeReplies: number };
async function fixture() {
  const client = new CodexAppServerClient({ command: process.execPath, args: [protocol, "--interrupt-mode", "confirmed"],
    requestTimeoutMs: 15_000, rpcTimeoutMs: 15_000, idleProcessMs: 0 });
  const port = client as unknown as { child?: ChildProcess; request<T>(method: string, params: object): Promise<T>;
    onLine(line: string): void; planMode(...args: unknown[]): Promise<object | undefined> };
  const control = (method: string, params: object = {}) => port.request<Stats>(method, params);
  const create = () => client.startThread({ cwd: process.cwd(), ephemeral: true });
  const retire = async () => {
    const child = port.child;
    assert.ok(child);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await control("fixture/exit");
    await exited;
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    return child;
  };
  const close = async () => {
    if (port.child?.exitCode === null) await control("fixture/completeActive").catch(() => undefined);
    await client.stop();
  };
  return { client, port, control, create, retire, close };
}

test("SDK original thread owner rejects models and native answers after a real process exit and same-address registration", async () => {
  const f = await fixture();
  try {
    const threadId = await f.create();
    const owner = f.client.captureThreadOwner(threadId);
    assert.ok(owner);
    await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
    const pending = await f.client.startTurn(threadId, { prompt: "Original A question", expectedOwner: owner });
    assert.equal(pending.kind, "needs_input");
    if (pending.kind !== "needs_input") throw new Error("Expected original native input");
    const original = await f.retire();
    const replacement = await f.create();
    assert.equal(replacement, threadId);
    const nextOwner = f.client.captureThreadOwner(replacement);
    assert.ok(nextOwner);
    assert.notEqual(nextOwner, owner);
    assert.notEqual(f.port.child, original);
    await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
    const next = await f.client.startTurn(replacement, { prompt: "Original B question", expectedOwner: nextOwner });
    assert.equal(next.kind, "needs_input");
    if (next.kind !== "needs_input") throw new Error("Expected replacement native input");
    assert.equal(next.turnId, pending.turnId);
    const before = await f.control("fixture/stats");
    const unavailable = /original.*(?:owner|process|thread).*unavailable|lost.*original/i;
    await assert.rejects(f.client.startTurn(threadId, { prompt: "Stale A", expectedOwner: owner }), unavailable);
    await assert.rejects(f.client.startReview({ threadId, cwd: process.cwd(), target: { type: "custom", instructions: "Stale A" },
      detached: false, expectedOwner: owner }), unavailable);
    await assert.rejects(f.client.normalizeInThread({ threadId, cwd: process.cwd(), prompt: "Stale A", outputSchema: {}, expectedOwner: owner }), unavailable);
    await assert.rejects(f.client.normalizeInFork({ threadId, cwd: process.cwd(), prompt: "Stale A", outputSchema: {}, expectedOwner: owner }), unavailable);
    await assert.rejects(f.client.continueTurn(pending, { scope: ["Old A answer"] }, undefined, undefined, owner), unavailable);
    await assert.rejects(f.client.continueTurn(pending, { scope: ["Old A implicit answer"] }), unavailable);
    await assert.rejects(f.client.interrupt(threadId, pending.turnId, undefined, owner), unavailable);
    assert.equal(f.client.isThreadAvailable(threadId, owner), false);
    assert.equal(f.client.isThreadAvailable(threadId, nextOwner), true);
    assert.deepEqual(await f.control("fixture/stats"), before, "Stale operations emit no mutation or native answer to B");
    const answered = await f.client.continueTurn(next, { scope: ["B answer"] }, undefined, undefined, nextOwner);
    assert.equal(answered.kind, "completed");
    assert.equal((await f.control("fixture/stats")).nativeReplies, 1);
  } finally { await f.close(); }
});

test("SDK stale subscription cleanup preserves the replacement's thread and usage cache", async () => {
  const f = await fixture();
  try {
    const threadId = await f.create();
    const owner = f.client.captureThreadOwner(threadId);
    assert.ok(owner);
    await f.retire();
    assert.equal(await f.create(), threadId);
    const nextOwner = f.client.captureThreadOwner(threadId);
    assert.ok(nextOwner);
    const counters = { totalTokens: 20, inputTokens: 10, cachedInputTokens: 2, outputTokens: 10, reasoningOutputTokens: 3 };
    f.port.onLine(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "B-turn",
      tokenUsage: { total: counters, last: counters } } }));
    const usage = f.client.getThreadTokenUsage(threadId);
    assert.ok(usage);
    const before = await f.control("fixture/stats");
    assert.equal(await f.client.unsubscribeThread(threadId, undefined, owner), "notLoaded");
    await f.client.releaseThreadForExternal(threadId, undefined, owner);
    assert.equal(f.client.isThreadAvailable(threadId, nextOwner), true);
    assert.deepEqual(f.client.getThreadTokenUsage(threadId), usage);
    assert.deepEqual(await f.control("fixture/stats"), before);
    assert.equal(await f.client.unsubscribeThread(threadId, undefined, nextOwner), "unsubscribed");
    assert.equal(f.client.isThreadAvailable(threadId, nextOwner), false);
  } finally { await f.close(); }
});

test("SDK thread owner changes on registration within the same actual process", async () => {
  const f = await fixture();
  try {
    const threadId = await f.create();
    const owner = f.client.captureThreadOwner(threadId);
    assert.ok(owner);
    const child = f.port.child;
    await f.client.resumeThread(threadId, process.cwd());
    const nextOwner = f.client.captureThreadOwner(threadId);
    assert.ok(nextOwner);
    assert.notEqual(nextOwner, owner);
    assert.equal(f.port.child, child, "PID and ChildProcess are unchanged; the registration itself has a new owner");
    assert.equal(f.client.isThreadAvailable(threadId, owner), false);
    assert.equal(await f.client.unsubscribeThread(threadId, undefined, owner), "notLoaded");
    assert.equal(f.client.isThreadAvailable(threadId, nextOwner), true);
    assert.deepEqual((await f.control("fixture/stats")).unsubscribes, []);
  } finally { await f.close(); }
});

test("SDK model preparation rechecks original ownership after an await before turn/start", async () => {
  const f = await fixture();
  const gate = sharedGate();
  const planMode = f.port.planMode;
  let modelCallbacks = 0;
  try {
    const threadId = await f.create();
    const owner = f.client.captureThreadOwner(threadId);
    assert.ok(owner);
    f.port.planMode = async () => { gate.enter(); await gate.promise; return { mode: "plan", settings: { model: "model-A" } }; };
    const planning = f.client.startTurn(threadId, { prompt: "A only", planMode: true, expectedOwner: owner,
      onModel: () => { modelCallbacks += 1; } });
    void planning.catch(() => undefined);
    await gate.entered;
    await f.retire();
    assert.equal(await f.create(), threadId);
    gate.release();
    await assert.rejects(planning, /original.*(?:owner|process|thread).*unavailable/i);
    assert.equal(modelCallbacks, 0, "A stale prepared model cannot mutate the original observer");
    assert.deepEqual((await f.control("fixture/stats")).turnStartRequests, []);
  } finally { gate.release(); f.port.planMode = planMode; await f.close(); }
});

test("SDK turn registration handoff cannot wait for or interrupt a same-pair replacement turn", async () => {
  const f = await fixture();
  const gate = sharedGate();
  try {
    const threadId = await f.create();
    const owner = f.client.captureThreadOwner(threadId);
    assert.ok(owner);
    await f.control("fixture/configure", { responses: { visible: [{ kind: "hold" }] } });
    const original = f.client.startTurn(threadId, { prompt: "A running", expectedOwner: owner,
      onStarted: async () => { gate.enter(); await gate.promise; } });
    void original.catch(() => undefined);
    await gate.entered;
    await f.retire();
    assert.equal(await f.create(), threadId);
    const nextOwner = f.client.captureThreadOwner(threadId);
    assert.ok(nextOwner);
    await f.control("fixture/configure", { responses: { visible: [{ kind: "hold" }] } });
    const next = f.client.startTurn(threadId, { prompt: "B running", expectedOwner: nextOwner });
    void next.catch(() => undefined);
    await sharedWaitFor(async () => (await f.control("fixture/stats")).active.length === 1, "replacement active writer");
    gate.release();
    await assert.rejects(original, /original.*(?:owner|process|thread).*unavailable/i);
    const after = await f.control("fixture/stats");
    assert.equal(after.active.length, 1);
    assert.deepEqual(after.interrupts, []);
    await f.control("fixture/completeActive");
    assert.equal((await next).kind, "completed");
  } finally { gate.release(); await f.close(); }
});

test("SDK pending interruption error retains its original opaque thread owner without serialization", async () => {
  const f = await fixture();
  try {
    const threadId = await f.create();
    const owner = f.client.captureThreadOwner(threadId);
    assert.ok(owner);
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/configure", { responses: { visible: [{ kind: "hold" }] } });
    let failure: unknown;
    await f.client.startTurn(threadId, { prompt: "Original writer", expectedOwner: owner,
      onStarted: () => { throw new Error("permission denied during registration"); } }).catch((error: unknown) => { failure = error; });
    assert.ok(failure instanceof CodexTurnInterruptionError);
    assert.equal(failure.originalThreadOwner, owner);
    assert.equal(Object.keys(failure).includes("originalThreadOwner"), false);
    assert.equal(JSON.stringify(failure).includes("originalThreadOwner"), false);
  } finally { await f.close(); }
});

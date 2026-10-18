import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";

type Stage = "planning" | "reviewing";
interface Stats {
  processId: number;
  visibleTurns: number;
  heldInterrupts: number;
  writerConflicts: number;
  active: Array<{ threadId: string; turnId: string }>;
  threadStarts: Array<{ threadId: string; method: string }>;
  turnStartRequests: Array<{ threadId: string; method: string }>;
  interrupts: Array<{ threadId: string; turnId: string; mode: string }>;
}

async function fixture(stage: Stage, mode: "held" | "confirmed" = "held") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-model-interruption-recovery-"));
  await writeFile(join(directory, "changed.txt"), "verified local diagnostic implementation", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const fixturePath = fileURLToPath(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url));
  const codex = new CodexAppServerClient({ command: process.execPath,
    args: [fixturePath, "--interrupt-mode", mode, "--active-visible-turns", "1"],
    requestTimeoutMs: 100, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const request = (codex as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(codex);
  const control = (method: string, params: object = {}) => request<Stats>(method, params);
  const children: Session[] = [];
  const frames: Array<{ type: string }> = [];
  const releases: string[] = [];
  const auxiliaryThreads: string[] = [];
  const tasks: Promise<unknown>[] = [];
  let rawDisposals = 0;
  let pins = 0;
  let begins = 0;
  let ends = 0;
  const begin = codex.beginRound.bind(codex);
  const end = codex.endRound.bind(codex);
  codex.beginRound = () => { begins += 1; pins += 1; begin(); };
  codex.endRound = () => { ends += 1; pins -= 1; end(); };
  const startThread = codex.startThread.bind(codex);
  codex.startThread = async (options, signal) => {
    const id = await startThread(options, signal);
    if (options.name?.startsWith("DSH Review ")) auxiliaryThreads.push(id);
    return id;
  };
  const unsubscribe = codex.unsubscribeThread.bind(codex);
  codex.unsubscribeThread = async (...args) => { releases.push(args[0]); return unsubscribe(...args); };
  const owner = SessionId(`model-interruption-${stage}`);
  const parentSession = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false });
  const parent = { id: owner, session: parentSession } as Agent;
  let provider: SubagentProvider;
  const childFactory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), isSeeded: false, ...options.meta });
    children.push(session);
    return { agent: { id: session.id, session, ctx: { emit(_name: string, payload: { frame: { type: string } }) {
      frames.push(payload.frame);
    } } } as unknown as Agent, async dispose() { rawDisposals += 1; } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: object) {
      const run = await provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name }) } as never);
      const child = run.localAgent!.session;
      parentSession.append("subagent/catalog", { version: 0, childId: child.id, childCreatedAt: child.header.createdAt,
        mode: "one-shot", label: "Original Codex child" } as never);
      return run;
    },
  } as never);
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 100, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, codex, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const start = () => track(stage === "planning"
    ? manager.start({ task: "Plan read-only local diagnostic implementation" }, exec)
    : manager.reviewOnly({ task: "Review the implemented read-only local diagnostic", implementationSummary: "Implemented health adapters",
      changedFiles: ["changed.txt"], testResults: "Verified valid and missing settings" }, exec));
  const record = async () => { const value = (await store.list())[0]; assert.ok(value); return value; };
  const assertOneChild = () => {
    assert.equal(children.length, 1);
    assert.equal(parentSession.snapshotEvents().filter((event) => event.type === "subagent/catalog").length, 1);
  };
  const assertCleaned = (originalThread: string, nativeTurns = 2) => {
    assertOneChild();
    assert.equal(rawDisposals, 1);
    assert.equal(pins, 0);
    assert.equal(begins, 1 + auxiliaryThreads.length, "the original business round and each private seed own independent pins");
    assert.equal(ends, 1 + auxiliaryThreads.length);
    assert.equal(releases.filter((threadId) => threadId === originalThread).length, 1);
    for (const threadId of auxiliaryThreads) assert.equal(releases.filter((id) => id === threadId).length, 1);
    assert.equal(runtime.recoverableRuns.size, 0);
    assert.equal(runtime.activeTurns.size, 0);
    assert.deepEqual(children[0]?.snapshotEvents().filter((event) => event.type === "turn/start").map((event) => event.data.turn),
      Array.from({ length: nativeTurns }, (_, index) => index + 1));
    assert.equal(frames.filter((frame) => frame.type === "start").length, frames.filter((frame) => frame.type === "end").length);
  };
  return { directory, store, manager, codex, control, runtime, exec, track, start, record, children, releases,
    assertOneChild, assertCleaned,
    get rawDisposals() { return rawDisposals; }, get pins() { return pins; },
    async close() {
      await control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
      await control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
      await Promise.allSettled(tasks);
      await manager.stop(); childFactory.unregisterProvider(); await codex.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

for (const stage of ["planning", "reviewing"] as const) {
  test(`${stage} timeout awaits interruption ACK and preserves original identities after failed ACK`, async () => {
    const f = await fixture(stage);
    try {
      const operation = f.start();
      const interrupted = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
      const original = interrupted.active[0];
      assert.ok(original);
      let settled = false;
      void operation.then(() => { settled = true; }, () => { settled = true; });
      // Hold a real control-RPC ACK beyond an event-loop window. A model
      // timeout must not send another writer while this ACK remains pending.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const held = await f.control("fixture/stats");
      assert.equal(held.writerConflicts, 0, "held interruption ACK must not admit an early writer on the original thread");
      assert.equal(settled, false, "the timeout result cannot escape before its interruption acknowledgement");
      assert.equal(held.turnStartRequests.length, 1);
      await f.control("fixture/releaseInterrupt", { confirmed: false });
      const waiting = await operation;
      assert.equal(waiting.processState, "waiting");
      assert.equal(waiting.retryState?.stage, stage);
      const recovery = f.runtime.recoverableRuns.get(waiting.id);
      assert.ok(recovery);
      assert.equal(recovery.threadId, original.threadId);
      assert.equal(recovery.interruptionTurnId, original.turnId);
      assert.equal(recovery.child?.id, f.children[0]?.id);
      assert.equal(f.rawDisposals, 0);
      assert.equal(f.pins, 1);
      const pending = await f.control("fixture/stats");
      assert.deepEqual(pending.active, [original]);
      assert.equal(pending.turnStartRequests.length, 1);
      assert.equal(pending.writerConflicts, 0);
      await f.control("fixture/setInterruptMode", { mode: "confirmed" });
      const completed = await f.track(f.manager.resume(waiting.id, undefined, f.exec));
      assert.equal(completed.id, waiting.id);
      assert.equal(completed.phase, stage === "planning" ? "executing" : "passed");
      const after = await f.control("fixture/stats");
      assert.equal(after.processId, interrupted.processId);
      assert.equal(after.writerConflicts, 0);
      assert.equal(after.visibleTurns, 2);
      assert.equal(after.turnStartRequests[1]?.threadId, original.threadId, "manual visible continuation reuses the same original backend thread");
      assert.ok(after.interrupts.every((request) => request.threadId === original.threadId && request.turnId === original.turnId));
      f.assertCleaned(original.threadId);
    } finally { await f.close(); }
  });

  test(`${stage} confirmed model timeout permits only one original-thread automatic continuation`, async () => {
    const f = await fixture(stage, "confirmed");
    try {
      const completed = await f.start();
      assert.equal(completed.phase, stage === "planning" ? "executing" : "passed");
      const stats = await f.control("fixture/stats");
      assert.equal(stats.visibleTurns, 2);
      assert.equal(stats.writerConflicts, 0);
      assert.equal(stats.interrupts.length, 1);
      assert.equal(stats.turnStartRequests[1]?.threadId, stats.interrupts[0]?.threadId);
      f.assertCleaned(stats.interrupts[0]!.threadId);
    } finally { await f.close(); }
  });
}

for (const action of ["cancel", "stop"] as const) test(`${action} during a model interruption ACK cleans the original round once`, async () => {
  const f = await fixture("planning");
  try {
    const operation = f.start();
    const interrupted = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    const original = interrupted.active[0];
    assert.ok(original);
    const record = await f.record();
    const ending = action === "cancel" ? f.track(f.manager.cancel(record.id, f.exec)) : f.track(f.manager.stop());
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    await Promise.allSettled([operation, ending]);
    if (action === "cancel") assert.equal((await f.store.load(record.id))?.phase, "cancelled");
    const stats = await f.control("fixture/stats");
    assert.equal(stats.turnStartRequests.length, 1);
    assert.equal(stats.writerConflicts, 0);
    f.assertCleaned(original.threadId, 1);
  } finally { await f.close(); }
});

test("a displaced caller cannot claim or clear a retained model-interruption handle", async () => {
  const f = await fixture("planning");
  try {
    const operation = f.start();
    const interrupted = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    const original = interrupted.active[0];
    assert.ok(original);
    await f.control("fixture/releaseInterrupt", { confirmed: false });
    const waiting = await operation;
    const handle = f.runtime.recoverableRuns.get(waiting.id);
    assert.ok(handle);
    assert.equal(handle.interruptionTurnId, original.turnId);
    const changed = await f.store.update(waiting.id, (record) => { record.dshSessionId = "replacement-model-owner"; });
    await assert.rejects(f.manager.resume(waiting.id, undefined, f.exec), /another DSH session|owner|identity/i);
    assert.deepEqual(await f.store.load(waiting.id), changed.record);
    assert.equal(f.runtime.recoverableRuns.get(waiting.id), handle, "denied admission must not consume another owner's exact retained handle");
    assert.equal(f.rawDisposals, 0);
    assert.equal(f.pins, 1);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.turnStartRequests.length, 1);
    assert.equal(stats.writerConflicts, 0);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await f.manager.stop();
    f.assertCleaned(original.threadId, 1);
  } finally { await f.close(); }
});

test("Reviewer cleanup ACK cannot expose a changed same-owner cancelled task or consume its old handle", async () => {
  const f = await fixture("reviewing");
  try {
    const operation = f.start();
    const interrupted = await f.control("fixture/waitForInterrupt", { minimumCount: 1 });
    const original = interrupted.active[0];
    assert.ok(original);
    await f.control("fixture/releaseInterrupt", { confirmed: false });
    const waiting = await operation;
    const handle = f.runtime.recoverableRuns.get(waiting.id);
    assert.ok(handle);
    const resuming = f.track(f.manager.resume(waiting.id, undefined, f.exec));
    const settled = Promise.allSettled([resuming]);
    const cleanup = await f.control("fixture/waitForInterrupt", { minimumCount: 2 });
    assert.equal(cleanup.heldInterrupts, 1);
    assert.deepEqual(cleanup.active, [original]);
    const changed = await f.store.update(waiting.id, (record) => {
      record.task = "PRIVATE-REPLACEMENT-REVIEW-TASK-SENTINEL";
      record.phase = "cancelled";
      record.processState = "cancelled";
    });
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    const [result] = await settled;
    assert.equal(result?.status, "rejected", "the scope check must precede the terminal shortcut after awaited cleanup");
    if (result?.status === "rejected") {
      assert.ok(!String(result.reason).includes("PRIVATE-REPLACEMENT-REVIEW-TASK-SENTINEL"));
    }
    assert.deepEqual(await f.store.load(waiting.id), changed.record, "old Reviewer cleanup cannot mutate the replacement task or row metadata");
    assert.equal(f.runtime.recoverableRuns.get(waiting.id), handle);
    assert.equal(handle.interruptionTurnId, original.turnId, "displaced cleanup cannot consume the old recovery marker");
    assert.equal(handle.child?.id, f.children[0]?.id);
    assert.equal(f.rawDisposals, 0);
    assert.equal(f.pins, 1);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.turnStartRequests.length, 1);
    assert.equal(stats.writerConflicts, 0);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    await f.manager.stop();
    f.assertCleaned(original.threadId, 1);
  } finally { await f.close(); }
});

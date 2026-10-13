import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";
import { applyCodexWorkflowProjection, codexWorkflowProjectionDefinition } from "../src/review-events.js";

type Stats = { processId: number; visibleTurns: number; nativeReplies: number; nativeMessages: unknown[];
  inputRequests: Array<string | number>;
  writerConflicts: number; active: Array<{ threadId: string; turnId: string }>; unsubscribes: string[];
  threadStarts: Array<{ threadId: string; method: string; ephemeral: boolean }>;
  turnStartRequests: Array<{ threadId: string; turnId?: string; scope: string; prompt?: string }>;
  interrupts: Array<{ threadId: string; turnId: string; mode: string }> };
const requireHost = createRequire(new URL("../package.json", import.meta.url));
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const TASK = "Plan read-only local configuration diagnostics without changing user data.";
const PRIMARY = "Codex structured conversion unexpectedly requested user input";
const loadHost = (name: string): Promise<any> => import(pathToFileURL(requireHost.resolve(name)).href);

async function waitFor<T>(predicate: () => Promise<T | false> | T | false, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Planner terminal fixture did not reach ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Real App Server transport, native SubagentRuntime and workflow SQLite.
 * No production host/process, provider request or shared fixture is changed. */
async function fixture(options: { interruptMode?: "confirmed" | "failed" | "held"; registrationError?: string } = {}) {
  const [cordis, sessions, projections, subagents] = await Promise.all([
    loadHost("@deepseek-ai/cordis"), loadHost("@deepseek-ai/dsh-session"),
    loadHost("@deepseek-ai/dsh-session-projection"), loadHost("@deepseek-ai/dsh-subagent"),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "dsh-planner-terminal-cleanup-"));
  const ctx = new cordis.Context();
  await ctx.plugin(projections.SessionProjectionRegistry, {});
  await ctx.plugin(subagents.SubagentRuntime, {});
  const owner = sessions.SessionId("planner-terminal-parent");
  const parentSession = sessions.Session.create(owner, [], { version: sessions.SESSION_FORMAT_VERSION,
    id: owner, createdAt: Date.now(), cwd: directory, isSeeded: false }) as Session;
  const parent = { id: owner, session: parentSession } as Agent;
  const displayedPlan = () => {
    let state = codexWorkflowProjectionDefinition.init();
    for (const event of parentSession.snapshotEvents()) state = applyCodexWorkflowProjection(state, event);
    assert.equal(state.failure, null);
    return state.plan;
  };
  const children: Session[] = [];
  const disposals: string[] = [];
  const factory = new CodexChildSessionFactory({ create: async (request: { sessionId: string; meta: object }) => {
    const session = sessions.Session.create(request.sessionId, [], { version: sessions.SESSION_FORMAT_VERSION,
      id: request.sessionId, createdAt: Date.now(), isSeeded: false, ...request.meta }) as Session;
    children.push(session);
    return { agent: { id: session.id, session, ctx: { emit() {} } } as unknown as Agent,
      async dispose() { disposals.push(session.id); } };
  } } as never, ctx.subagents);
  const store = new WorkflowStore(directory);
  const processLog = join(directory, "protocol-processes.jsonl");
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [protocol, "--interrupt-mode", options.interruptMode ?? "confirmed", "--process-log", processLog],
    requestTimeoutMs: 30_000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const request = (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(client);
  const control = (method: string, params: object = {}) => request<Stats>(method, params);
  const stats = () => control("fixture/stats");
  const originalTurn = client.startTurn.bind(client);
  client.startTurn = (threadId, turn, signal) => originalTurn(threadId,
    options.registrationError && (turn.outputSchema?.properties as Record<string, unknown> | undefined)?.status ? { ...turn, onStarted: async (started) => {
      await turn.onStarted?.(started); throw new Error(options.registrationError);
    } } : turn, signal);
  let begins = 0;
  let ends = 0;
  const begin = client.beginRound.bind(client);
  const end = client.endRound.bind(client);
  client.beginRound = () => { begins += 1; return begin(); };
  client.endRound = () => { ends += 1; return end(); };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 30_000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60_000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 30_000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000,
    leaseTtlMs: 60_000, storageDir: directory };
  const agentPort = { get: (id: string) => id === parent.id ? parent : undefined };
  const manager = new WorkflowManager(store, client, config, undefined, undefined, undefined, {}, agentPort, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  await control("fixture/configure", { responses: { status: [{ kind: "needs_input" }] } });
  const start = () => manager.start({ task: TASK }, exec);
  const outcome = (task: Promise<WorkflowRecord>) => task.then((record) => ({ record, error: undefined }),
    (error: unknown) => ({ record: undefined, error: error instanceof Error ? error.message : String(error) }));
  const record = async () => { const rows = await store.list(); assert.equal(rows.length, 1); return rows[0]!; };
  const original = async () => {
    const current = await stats();
    assert.equal(current.threadStarts.length, 1);
    assert.equal(children.length, 1);
    assert.equal(current.visibleTurns, 1);
    assert.equal(current.turnStartRequests.filter((r) => r.scope === "status").length, 1,
      "A terminal native/schema failure sends no automatic continuation");
    assert.equal(current.nativeReplies, 0, "Private requests never receive invented or duplicate answers");
    assert.equal(current.writerConflicts, 0);
    return { stats: current, threadId: current.threadStarts[0]!.threadId,
      turnId: current.turnStartRequests.find((r) => r.scope === "status")!.turnId!, childId: children[0]!.id };
  };
  const retained = async (row: WorkflowRecord, primary = PRIMARY) => {
    const old = await original();
    assert.equal(row.phase, "planning"); assert.equal(row.processState, "waiting");
    assert.equal(row.error, primary); assert.equal(row.retryState?.terminalFailure, primary);
    assert.equal(row.retryState?.awaitingCleanup, true);
    assert.equal(displayedPlan()?.status, "failed", "a rejected original model remains a failure while its cleanup waits");
    assert.equal(displayedPlan()?.processState, "waiting");
    assert.equal(displayedPlan()?.message, primary);
    const handle = runtime.recoverableRuns.get(row.id);
    assert.equal(handle?.terminalFailure, primary);
    assert.equal(handle?.interruptionTurnId, old.turnId);
    assert.equal(handle?.threadId, old.threadId);
    assert.equal(handle?.child?.id, old.childId);
    assert.equal(handle?.plannerCheckpoint?.automaticContinuations, 0);
    assert.ok(handle?.originalProcessIds?.includes(old.stats.processId), "Retain actual original-process evidence");
    assert.equal(old.stats.active.length, 1); assert.equal(old.stats.unsubscribes.length, 0);
    assert.equal(disposals.length, 0); assert.equal(begins, 1); assert.equal(ends, 0);
    return old;
  };
  const released = async (old: Awaited<ReturnType<typeof original>>) => {
    const current = await original();
    assert.equal(current.stats.active.length, 0);
    assert.deepEqual(current.stats.unsubscribes, [old.threadId]);
    assert.deepEqual(disposals, [old.childId]);
    assert.equal(runtime.recoverableRuns.size, 0); assert.equal(runtime.codexChildSessions.size, 0);
    assert.equal(runtime.activeTurns.size, 0); assert.equal(runtime.pending.size, 0);
    assert.equal(begins, 1); assert.equal(ends, 1);
    assert.equal(children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length, 1,
      "Cleanup acknowledgement must not append a model continuation in the native child");
    const final = await store.list();
    if (final[0]?.phase === "failed" && !runtime.stopped) {
      assert.equal(displayedPlan()?.status, "failed");
      assert.equal(displayedPlan()?.processState, "failed", "confirmed cleanup removes the display's pending process marker");
    }
  };
  const fresh = () => {
    const coldClient = new CodexAppServerClient({ command: process.execPath,
      args: [protocol, "--process-log", join(directory, "cold-processes.jsonl")], requestTimeoutMs: 30_000,
      rpcTimeoutMs: 4000, idleProcessMs: 0 });
    const coldStore = new WorkflowStore(directory);
    const coldManager = new WorkflowManager(coldStore, coldClient, config, undefined, undefined, undefined, {}, agentPort, factory);
    return { client: coldClient, store: coldStore, manager: coldManager,
      async close() { await coldManager.stop(); await coldClient.stop(); coldStore.close(); } };
  };
  return { directory, store, manager, runtime, client, control, stats, children, disposals, exec,
    start, record, outcome, original, retained, released, fresh,
    get begins() { return begins; }, get ends() { return ends; },
    async close() {
      const before = await stats().catch(() => undefined);
      await control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
      await control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
      await control("fixture/completeActive").catch(() => undefined);
      await manager.stop(); factory.unregisterProvider(); await client.stop(); await manager.stop();
      await ctx.fiber.dispose(); store.close();
      if (before) assert.throws(() => process.kill(before.processId, 0), { code: "ESRCH" }, "The isolated original backend exited");
      client.startTurn = originalTurn; client.beginRound = begin; client.endRound = end;
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
}

test("private Planner native input is interrupted on its exact pair before terminal release", async () => {
  const f = await fixture();
  try {
    const result = await f.outcome(f.start());
    assert.equal(result.error, PRIMARY);
    const row = await f.record();
    assert.equal(row.phase, "failed"); assert.equal(row.error, PRIMARY);
    const old = await f.original();
    assert.deepEqual(old.stats.interrupts, [{ threadId: old.threadId, turnId: old.turnId, mode: "confirmed" }]);
    await f.released(old);
  } finally { await f.close(); }
});

test("failed then held interruption resumes only terminal cleanup in the original Planner", async () => {
  const f = await fixture({ interruptMode: "failed" });
  try {
    const first = await f.start(); const old = await f.retained(first);
    assert.deepEqual(old.stats.interrupts, [{ threadId: old.threadId, turnId: old.turnId, mode: "failed" }]);
    await assert.rejects(f.start(), /active|cleanup|waiting/i);
    const status = await f.manager.status(undefined, f.exec);
    assert.equal(status.id, first.id); assert.equal(status.error, PRIMARY);
    await f.control("fixture/setInterruptMode", { mode: "held" });
    const resume = f.manager.resume(undefined, "Continue original terminal cleanup only", f.exec);
    await waitFor(async () => { const current = await f.stats(); return current.interrupts.length === 2 && current; }, "second exact interruption held");
    await f.retained(await f.record());
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    const final = await resume;
    assert.equal(final.id, first.id); assert.equal(final.phase, "failed"); assert.equal(final.error, PRIMARY);
    assert.equal(final.retryState, undefined);
    await f.released(old);
    const interrupts = (await f.stats()).interrupts;
    assert.ok(interrupts.every((entry) => entry.threadId === old.threadId && entry.turnId === old.turnId));
    await assert.rejects(f.manager.resume(first.id, "Resume again", f.exec), /no in-process/i);
    await f.released(old);
  } finally { await f.close(); }
});

test("a cold Manager cannot replace a Planner with a persisted terminal cleanup marker", async () => {
  const f = await fixture({ interruptMode: "failed" });
  const cold = f.fresh();
  try {
    const first = await f.start(); const old = await f.retained(first);
    await assert.rejects(cold.manager.start({ task: TASK }, f.exec), /active|cleanup|waiting/i);
    await assert.rejects(cold.manager.resume(first.id, "Continue original cleanup", f.exec), /no in-process/i);
    await assert.rejects(readFile(join(f.directory, "cold-processes.jsonl"), "utf8"), { code: "ENOENT" },
      "Public recovery cannot initialize another App Server before original cleanup");
    await f.retained(await f.record());
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const final = await f.manager.resume(first.id, "Finish cleanup", f.exec);
    assert.equal(final.phase, "failed"); await f.released(old);
  } finally { await cold.close(); await f.close(); }
});

test("cancelling terminal Planner cleanup with failed ACK preserves resources until original acknowledgement", async () => {
  const f = await fixture({ interruptMode: "failed" });
  try {
    const first = await f.start(); const old = await f.retained(first);
    const cancelled = await f.manager.cancel(first.id, f.exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(f.disposals.length, 0); assert.equal(f.ends, 0);
    assert.equal(f.runtime.recoverableRuns.get(first.id)?.terminalFailure, PRIMARY);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const finished = await f.manager.resume(first.id, "Cleanup cancelled original writer", f.exec);
    assert.equal(finished.phase, "cancelled");
    await f.released(old);
  } finally { await f.close(); }
});

test("a rejected Planner conversion registration never becomes a resumable model error", async () => {
  const primary = "permission denied registering original private Planner turn";
  const f = await fixture({ interruptMode: "failed", registrationError: primary });
  try {
    const first = await f.start(); const old = await f.retained(first, primary);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const final = await f.manager.resume(first.id, "Finish original cleanup", f.exec);
    assert.equal(final.phase, "failed"); assert.equal(final.error, primary);
    await f.released(old);
  } finally { await f.close(); }
});

test("terminal conversion after native clarification never repeats the already submitted answer", async () => {
  const f = await fixture({ interruptMode: "failed" });
  try {
    await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
    const first = await f.start();
    assert.equal(first.phase, "waiting_input");
    const nativeRequest = (await f.stats()).inputRequests[0];
    assert.ok(nativeRequest);
    const waiting = await f.manager.continue(first.id, { scope: ["Inspect the existing configuration only"] }, f.exec);
    assert.equal(waiting.processState, "waiting"); assert.equal(waiting.error, PRIMARY);
    assert.equal(waiting.retryState?.awaitingCleanup, true);
    const before = await f.stats();
    assert.equal(before.visibleTurns, 1); assert.equal(before.turnStartRequests.length, 2);
    assert.equal(before.nativeReplies, 1);
    assert.deepEqual(before.nativeMessages, [{ id: nativeRequest,
      result: { answers: { scope: { answers: ["Inspect the existing configuration only"] } } } }]);
    const childId = f.children[0]!.id;
    assert.equal(f.runtime.recoverableRuns.get(first.id)?.child?.id, childId);
    assert.equal(f.disposals.length, 0); assert.equal(f.ends, 0);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const final = await f.manager.resume(first.id, "Only complete original terminal cleanup", f.exec);
    assert.equal(final.phase, "failed"); assert.equal(final.error, PRIMARY);
    const after = await f.stats();
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.nativeMessages, before.nativeMessages);
    assert.equal(after.active.length, 0);
    assert.deepEqual(f.disposals, [childId]); assert.equal(f.begins, 1); assert.equal(f.ends, 1);
    assert.equal(f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length, 2);
  } finally { await f.close(); }
});

test("a manually resumed conversion that fails its contract can only retry cleanup afterwards", async () => {
  const f = await fixture({ interruptMode: "failed" });
  try {
    await f.control("fixture/configure", { responses: { status: [{ kind: "failed" }, { kind: "failed" }, { kind: "needs_input" }] } });
    const first = await f.start();
    assert.equal(first.processState, "waiting"); assert.equal(first.retryState?.awaitingCleanup, undefined);
    assert.equal(f.runtime.recoverableRuns.get(first.id)?.plannerCheckpoint?.automaticContinuations, 1);
    const waiting = await f.manager.resume(first.id, "Continue only the failed original conversion", f.exec);
    assert.equal(waiting.id, first.id); assert.equal(waiting.error, PRIMARY);
    assert.equal(waiting.retryState?.awaitingCleanup, true);
    const recovery = f.runtime.recoverableRuns.get(first.id);
    assert.equal(recovery?.terminalFailure, PRIMARY);
    assert.equal(recovery?.plannerCheckpoint?.automaticContinuations, 1);
    const before = await f.stats();
    assert.equal(before.visibleTurns, 1); assert.equal(before.turnStartRequests.length, 4);
    assert.equal(before.nativeReplies, 0); assert.equal(f.children.length, 1);
    assert.equal(f.disposals.length, 0); assert.equal(f.ends, 0);
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const final = await f.manager.resume(first.id, "Only retry terminal cleanup", f.exec);
    assert.equal(final.phase, "failed"); assert.equal(final.error, PRIMARY);
    const after = await f.stats();
    assert.deepEqual(after.threadStarts, before.threadStarts);
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.equal(after.active.length, 0); assert.equal(after.nativeReplies, 0);
    assert.deepEqual(f.disposals, [f.children[0]!.id]); assert.equal(f.begins, 1); assert.equal(f.ends, 1);
    assert.equal(f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length, 3);
  } finally { await f.close(); }
});

test("an already completed invalid Planner Schema result releases without unnecessary interruption", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/configure", { responses: { status: [{ text: "malformed JSON" }] } });
    const result = await f.outcome(f.start());
    assert.match(result.error!, /^planner normalization returned an invalid result:/);
    const row = await f.record();
    assert.equal(row.phase, "failed"); assert.equal(row.error, result.error);
    const old = await f.original();
    assert.equal(old.stats.interrupts.length, 0); await f.released(old);
  } finally { await f.close(); }
});

for (const primary of ["permission denied: stream disconnected", "invalid output schema: schema validation failed"]) {
  test(`completed failed conversion preserves its primary diagnostic: ${primary}`, async () => {
    const f = await fixture();
    try {
      await f.control("fixture/configure", { responses: { status: [{ kind: "failed", message: primary, text: "Unusable partial structured output" }] } });
      const reported = JSON.stringify({ message: primary });
      await assert.rejects(f.start(), (error: unknown) => error instanceof Error && error.message === reported);
      const record = await f.record();
      assert.equal(record.phase, "failed");
      assert.equal(record.error, reported, "Keep the actual SDK error envelope rather than replacing its specific diagnostic with turn failed");
      assert.equal(record.planMarkdown, undefined);
      const current = await f.stats();
      assert.equal(current.visibleTurns, 1);
      assert.equal(current.turnStartRequests.filter((request) => request.scope === "status").length, 1);
      assert.deepEqual(current.active, []);
      assert.deepEqual(current.interrupts, [], "A returned terminal receipt needs no unnecessary interrupt");
      assert.equal(f.runtime.recoverableRuns.size, 0);
      assert.equal(f.disposals.length, 1);
      assert.equal(f.ends, 1);
    } finally { await f.close(); }
  });
}

test("supported visible Planner native input retains the original answer capability", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
    const waiting = await f.start();
    assert.equal(waiting.phase, "waiting_input");
    const current = await f.stats();
    assert.equal(current.active.length, 1); assert.equal(current.interrupts.length, 0);
    assert.equal(current.nativeReplies, 0); assert.equal(current.threadStarts.length, 1);
    assert.equal(current.turnStartRequests.length, 1); assert.equal(f.children.length, 1);
    assert.equal(f.runtime.pending.size, 1); assert.equal(f.runtime.plannerInputs.size, 1);
    assert.equal(f.disposals.length, 0); assert.equal(f.ends, 0);
  } finally { await f.close(); }
});

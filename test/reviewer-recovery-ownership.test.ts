import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Original health requirements are verified.";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { started: new Promise<void>((resolve) => { enter = resolve; }),
    promise: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

class RecoveryReadStore extends WorkflowStore {
  readGate?: ReturnType<typeof gate>;
  override async load(id: string): Promise<WorkflowRecord | undefined> {
    const snapshot = await super.load(id);
    const hold = this.readGate;
    if (hold) { this.readGate = undefined; hold.enter(); await hold.promise; }
    return snapshot;
  }
}

async function waitStarted(hold: ReturnType<typeof gate>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hold.started, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Reviewer recovery boundary was not reached")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(interruption = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-reviewer-recovery-owner-"));
  await writeFile(join(directory, "changed.txt"), "original local health implementation", "utf8");
  const store = new RecoveryReadStore(join(directory, "storage"));
  const owner = SessionId("reviewer-recovery-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  const children: Session[] = [];
  const disposed: string[] = [];
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const visibleTurns: string[] = [];
  const releases: string[] = [];
  const interruptions: Array<{ threadId: string; turnId: string }> = [];
  const available = new Set<string>();
  let ack: ReturnType<typeof gate> | undefined;
  let failures = 2;
  let pins = 0;
  let ends = 0;
  let turns = 0;
  const runVisible = async (threadId: string, options: Pick<Parameters<CodexGateway["startTurn"]>[1], "onStarted" | "onProgress">) => {
    const turnId = `original-review-turn-${++turns}`;
    assert.ok(available.has(threadId));
    visibleTurns.push(threadId);
    await options.onStarted?.({ threadId, turnId });
    if (interruption && visibleTurns.length === 1) throw new CodexTurnInterruptionError(new Error("original model timed out"), threadId, turnId);
    if (failures > 0) { failures -= 1; return { kind: "completed" as const, threadId, turnId,
      status: "failed" as const, text: "", reason: "turn failed" }; }
    options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
    return { kind: "completed" as const, threadId, turnId, status: "completed" as const, text: REVIEW };
  };
  const gateway: CodexGateway = {
    async startThread() {
      const id = `recovery-alignment-${privateThreads.length + 1}`;
      privateThreads.push(id); available.add(id); return id;
    },
    async startReviewerThread() {
      const id = `original-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("An ephemeral recovery cannot fabricate a resumed thread"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this Reviewer recovery"); },
    async resolveDefaultModel() { return "model-A"; },
    async startReview(options) { return { threadId: options.threadId, result: await runVisible(options.threadId, options) }; },
    async startTurn(threadId, options) { return runVisible(threadId, options); },
    async normalizeInFork(options) {
      const turnId = `normalization-${++turns}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { kind: "completed", threadId: options.threadId, turnId, status: "completed",
        text: options.prompt.includes("REVIEW AUTHORITY checker") ? JSON.stringify({ aligned: true, conflicts: [] })
          : JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Original health requirements are verified" }) };
    },
    async interrupt(threadId, turnId) {
      interruptions.push({ threadId, turnId });
      const hold = ack;
      if (hold) { ack = undefined; hold.enter(); await hold.promise; }
    },
    async unsubscribeThread(id) { releases.push(id); assert.ok(available.delete(id), "each original/private subscription cleans once"); },
    isThreadAvailable: (id) => available.has(id),
    beginRound() { pins += 1; }, endRound() { pins -= 1; ends += 1; },
  };
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const child = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    children.push(child);
    return { agent: { id: child.id, session: child } as Agent, async dispose() { disposed.push(child.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    leaseTtlMs: 10000, turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const waiting = await manager.reviewOnly({ task: "Review the original read-only health command",
    implementationSummary: "Original health command implemented", changedFiles: ["changed.txt"] }, exec);
  assert.equal(waiting.processState, "waiting");
  const recovery = runtime.recoverableRuns.get(waiting.id)!;
  assert.ok(recovery);
  const initialTurns = visibleTurns.length;
  const assertRetained = () => {
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(runtime.codexChildSessions.get(waiting.id), recovery.child);
    assert.equal(visibleTurns.length, initialTurns);
    assert.equal(reviewerThreads.length, 1);
    assert.equal(children.length, 1);
    assert.deepEqual(privateThreads, []);
    assert.deepEqual(releases, []);
    assert.deepEqual(disposed, []);
    assert.equal(pins, 1); assert.equal(ends, 0);
  };
  return { directory, store, manager, runtime, exec, waiting, recovery, children, disposed, reviewerThreads, privateThreads,
    visibleTurns, releases, interruptions, assertRetained,
    failTwiceAgain() { failures = 2; },
    holdAck(hold: ReturnType<typeof gate>) { ack = hold; },
    get pins() { return pins; },
    async assertStoppedOnce() {
      await manager.stop(); await manager.stop();
      assert.deepEqual(disposed, [children[0]!.id]);
      assert.deepEqual(releases, [recovery.threadId]);
      assert.equal(pins, 0); assert.equal(ends, 1);
      assert.equal(runtime.recoverableRuns.size, 0);
      assert.equal(runtime.codexChildSessions.size, 0);
    },
    async close() {
      store.readGate?.release(); ack?.release(); await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("waiting Reviewer scope drift during public resume read cannot consume its original recovery", async () => {
  for (const change of ["task", "model", "attempt"] as const) {
    const f = await fixture();
    const reading = gate();
    f.store.readGate = reading;
    const resumed = f.manager.resume(f.waiting.id, "Continue original review", f.exec);
    const settled = Promise.allSettled([resumed]);
    try {
      await waitStarted(reading);
      await f.store.update(f.waiting.id, (record) => {
        if (change === "task") record.task = "REPLACEMENT-TASK-DURING-RESUME-READ";
        else if (change === "model") record.reviewerModel = "replacement-model";
        else record.reviewAttempt = 19;
      });
      const replacement = (await f.store.load(f.waiting.id))!;
      reading.release();
      assert.equal((await settled)[0]?.status, "rejected", `${change}: the original Reviewer cannot inherit a replacement scope`);
      assert.deepEqual(await f.store.load(f.waiting.id), replacement);
      f.assertRetained();
      await f.assertStoppedOnce();
    } finally { reading.release(); await settled; await f.close(); }
  }
});

test("Reviewer model drift during original interruption ACK preserves its handle and sends no continuation", async () => {
  const f = await fixture(true);
  const ack = gate();
  f.holdAck(ack);
  const resumed = f.manager.resume(f.waiting.id, "Continue original review", f.exec);
  const settled = Promise.allSettled([resumed]);
  try {
    assert.ok(f.recovery.interruptionTurnId);
    await waitStarted(ack);
    await f.store.update(f.waiting.id, (record) => { record.reviewerModel = "replacement-model-during-ACK"; });
    const replacement = (await f.store.load(f.waiting.id))!;
    ack.release();
    assert.equal((await settled)[0]?.status, "rejected");
    assert.deepEqual(await f.store.load(f.waiting.id), replacement);
    f.assertRetained();
    assert.equal(f.interruptions[0]?.threadId, f.recovery.threadId);
    await f.assertStoppedOnce();
  } finally { ack.release(); await settled; await f.close(); }
});

test("Reviewer scope drift after its recovery is claimed restores the same original handle without changing replacement history", async () => {
  const f = await fixture();
  const internal = f.manager as unknown as { reviewExecution: {
    ctx: { owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> };
  } };
  const readOwned = internal.reviewExecution.ctx.owned;
  let injected = false;
  let replacement: WorkflowRecord | undefined;
  try {
    internal.reviewExecution.ctx.owned = async (id, exec) => {
      const snapshot = await readOwned(id, exec);
      if (!injected && !f.runtime.recoverableRuns.has(id)) {
        injected = true;
        await f.store.update(id, (record) => { record.task = "REPLACEMENT-TASK-AFTER-RECOVERY-CLAIM"; });
        replacement = (await f.store.load(id))!;
      }
      return snapshot;
    };
    const outcome = await Promise.allSettled([f.manager.resume(f.waiting.id, "Continue original review", f.exec)]);
    assert.equal(injected, true, "the real owned read returns its old snapshot only after the original handle was claimed");
    assert.equal(outcome[0]?.status, "rejected");
    assert.ok(replacement);
    assert.deepEqual(await f.store.load(f.waiting.id), replacement, "late refusal cannot rewrite the replacement's history or counters");
    f.assertRetained();
    internal.reviewExecution.ctx.owned = readOwned;
    await f.assertStoppedOnce();
  } finally { internal.reviewExecution.ctx.owned = readOwned; await f.close(); }
});

test("a legacy waiting Reviewer without its immutable identity reports unavailable rather than fabricating one", async () => {
  const f = await fixture();
  try {
    Reflect.deleteProperty(f.recovery, "reviewerIdentity");
    const before = (await f.store.load(f.waiting.id))!;
    const status = await f.manager.status(f.waiting.id, f.exec);
    assert.deepEqual(status.continuation, { available: false, reason: "handle_unavailable" });
    await assert.rejects(f.manager.resume(f.waiting.id, "Continue original review", f.exec), /identity|handle.*unavailable|original.*unavailable/i);
    assert.deepEqual(await f.store.load(f.waiting.id), before);
    f.assertRetained();
    await f.assertStoppedOnce();
  } finally { await f.close(); }
});

test("a new owner's cancellation during a claimed Reviewer read cannot restore its cancelled recovery", async () => {
  const f = await fixture();
  const reading = gate();
  const internal = f.manager as unknown as { reviewExecution: {
    ctx: { owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> };
  } };
  const readOwned = internal.reviewExecution.ctx.owned;
  let intercepted = false;
  internal.reviewExecution.ctx.owned = async (id, exec) => {
    if (!intercepted && !f.runtime.recoverableRuns.has(id)) {
      intercepted = true; reading.enter(); await reading.promise;
    }
    return readOwned(id, exec);
  };
  const resumed = f.manager.resume(f.waiting.id, "Continue original review", f.exec);
  const settled = Promise.allSettled([resumed]);
  try {
    await waitStarted(reading);
    assert.equal(f.runtime.recoverableRuns.has(f.waiting.id), false, "the existing run is already claimed by the suspended resume");
    const newOwner = SessionId("reviewer-recovery-replacement-owner");
    await f.store.update(f.waiting.id, (record) => { record.dshSessionId = newOwner; });
    const newSession = Session.create(newOwner, [], { version: SESSION_FORMAT_VERSION, id: newOwner,
      createdAt: Date.now(), cwd: f.directory, isSeeded: false });
    const cancelExec = { agent: { id: newOwner, session: newSession } as Agent,
      signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
    assert.equal((await f.manager.cancel(f.waiting.id, cancelExec)).phase, "cancelled");
    assert.deepEqual(f.disposed, [f.children[0]!.id], "public cancellation completes original child cleanup before the old read returns");
    const cancelled = (await f.store.load(f.waiting.id))!;
    reading.release();
    const outcome = (await settled)[0]!;
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /another DSH session/);
    assert.deepEqual(await f.store.load(f.waiting.id), cancelled, "the rejected old owner cannot write the cancelled replacement");
    assert.equal(f.runtime.recoverableRuns.has(f.waiting.id), false, "a cancelled handle must not be reinserted by the failed owned read");
    assert.equal(f.runtime.codexChildSessions.has(f.waiting.id), false);
    assert.equal(f.pins, 0, "the rejected resume must release its claimed pin without a later stop rescuing it");
    assert.deepEqual(f.releases, [f.recovery.threadId]);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.visibleTurns.length, 2);
    assert.equal(f.reviewerThreads.length, 1);
  } finally { reading.release(); await settled; internal.reviewExecution.ctx.owned = readOwned; await f.close(); }
});

test("valid same-Reviewer recovery allows later waiting attempts without replacing its original conversation", async () => {
  const f = await fixture();
  try {
    f.failTwiceAgain();
    const secondWaiting = await f.manager.resume(f.waiting.id, "Continue original review", f.exec);
    assert.equal(secondWaiting.processState, "waiting");
    assert.equal(secondWaiting.reviewAttempt, (f.waiting.reviewAttempt ?? 0) + 1);
    assert.equal(f.runtime.recoverableRuns.get(f.waiting.id)?.threadId, f.recovery.threadId);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.disposed, []);
    assert.equal(f.runtime.recoverableRuns.get(f.waiting.id)?.automaticContinuations, 1);
    assert.equal(f.visibleTurns.length, 3, "manual continuation cannot reset the business round's automatic budget");
    const thirdWaiting = await f.manager.resume(f.waiting.id, "Continue original review", f.exec);
    assert.equal(thirdWaiting.processState, "waiting");
    assert.equal(thirdWaiting.reviewAttempt, (secondWaiting.reviewAttempt ?? 0) + 1);
    assert.equal(thirdWaiting.reviewCycles, 0);
    assert.equal(f.runtime.recoverableRuns.get(f.waiting.id)?.threadId, f.recovery.threadId);
    assert.equal(f.runtime.recoverableRuns.get(f.waiting.id)?.automaticContinuations, 1);
    assert.deepEqual(f.visibleTurns, Array(4).fill(f.recovery.threadId));
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.disposed, []);
    assert.equal(f.pins, 1);
    const completed = await f.manager.resume(f.waiting.id, "Continue original review", f.exec);
    assert.equal(completed.phase, "passed");
    assert.equal(completed.reviewCycles, 1);
    assert.equal(completed.reviewAttempt, (thirdWaiting.reviewAttempt ?? 0) + 1);
    assert.deepEqual(f.reviewerThreads, [f.recovery.threadId]);
    assert.deepEqual(f.visibleTurns, Array(5).fill(f.recovery.threadId));
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.pins, 0);
  } finally { await f.close(); }
});

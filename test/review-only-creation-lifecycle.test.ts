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
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Approved diagnostic implementation is verified.";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { started: new Promise<void>((resolve) => { enter = resolve; }),
    promise: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

class PersistedCreationStore extends WorkflowStore {
  readonly saved = gate();
  createdId?: string;
  override async save(record: WorkflowRecord): Promise<void> {
    await super.save(record);
    if (record.mode === "review_only" && !this.createdId) {
      this.createdId = record.id;
      this.saved.enter();
      await this.saved.promise;
    }
  }
}

async function waitStarted(hold: ReturnType<typeof gate>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hold.started, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Review-only durable creation never reached its return barrier")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-review-only-creation-lifecycle-"));
  await writeFile(join(directory, "changed.txt"), "read-only health command v1", "utf8");
  const store = new PersistedCreationStore(join(directory, "storage"));
  const owner = SessionId("review-only-creation-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  const children: Session[] = [];
  const disposed: string[] = [];
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const released: string[] = [];
  const available = new Set<string>();
  let modelCalls = 0;
  let turns = 0;
  let pins = 0;
  const gateway: CodexGateway = {
    async startThread() {
      const id = `creation-private-${privateThreads.length + 1}`;
      privateThreads.push(id); available.add(id); return id;
    },
    async startReviewerThread() {
      const id = `creation-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("A new review-only workflow cannot resume a foreign thread"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification at review-only creation"); },
    async resolveDefaultModel() { return "model-A"; },
    async startReview(options) {
      modelCalls += 1;
      const turnId = `creation-native-${++turns}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { threadId: options.threadId, result: { kind: "completed" as const, threadId: options.threadId,
        turnId, status: "completed" as const, text: REVIEW } };
    },
    async startTurn(threadId, options) {
      modelCalls += 1;
      const turnId = `creation-visible-${++turns}`;
      await options.onStarted?.({ threadId, turnId });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async normalizeInFork(options) {
      modelCalls += 1;
      const turnId = `creation-conversion-${++turns}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { kind: "completed", threadId: options.threadId, turnId, status: "completed",
        text: options.prompt.includes("REVIEW AUTHORITY checker") ? JSON.stringify({ aligned: true, conflicts: [] })
          : JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Approved diagnostic implementation is verified" }) };
    },
    async interrupt() {},
    async unsubscribeThread(id) { released.push(id); assert.ok(available.delete(id), "each owned subscription releases once"); },
    isThreadAvailable: (id) => available.has(id),
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
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
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {},
    { get: (id) => id === owner ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const input = { task: "Review the original read-only health command", implementationSummary: "Health command implemented",
    changedFiles: ["changed.txt"], testResults: "Fixture verified" };
  return { directory, store, manager, runtime, exec, input,
    assertNeverStarted() {
      assert.equal(modelCalls, 0);
      assert.deepEqual(children, []);
      assert.deepEqual(disposed, []);
      assert.deepEqual(reviewerThreads, []);
      assert.deepEqual(privateThreads, []);
      assert.deepEqual(released, []);
      assert.equal(pins, 0);
    },
    assertEmpty() {
      assert.equal(runtime.foreground.size, 0);
      assert.equal(runtime.backgroundTasks.size, 0);
      assert.equal(runtime.codexChildSessions.size, 0);
      assert.equal(runtime.reviewFlights.size, 0);
      assert.equal(runtime.reviewControllers.size, 0);
      assert.equal(runtime.reviewHeartbeats.size, 0);
      assert.equal(runtime.activeTurns.size, 0);
      assert.equal(runtime.auxiliaryTurns.size, 0);
    },
    async close() {
      store.saved.release(); await manager.stop(); factory.unregisterProvider();
      if (!store.isClosed()) store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("review-only cancellation after its durable creation returns the exact latest cancelled DTO before admission", async () => {
  const f = await fixture();
  const reviewing = f.manager.reviewOnly(f.input, f.exec);
  const settled = Promise.allSettled([reviewing]);
  try {
    await waitStarted(f.store.saved);
    const id = f.store.createdId!;
    const cancelled = await f.manager.cancel(id, f.exec);
    assert.equal(cancelled.phase, "cancelled");
    f.store.saved.release();
    const outcomes = await settled;
    assert.equal(outcomes[0]?.status, "fulfilled", "a committed cancellation wins before the initial review admission");
    if (outcomes[0]?.status === "fulfilled") assert.deepEqual(outcomes[0].value, cancelled);
    assert.deepEqual(await f.store.load(id), cancelled);
    f.assertNeverStarted();
    await f.manager.stop(); f.assertEmpty();
  } finally { f.store.saved.release(); await settled; await f.close(); }
});

test("stop waits for review-only durable creation and closes its unadmitted record without late writes", async () => {
  const f = await fixture();
  const reviewing = f.manager.reviewOnly(f.input, f.exec);
  const settled = Promise.allSettled([reviewing]);
  let stopping: Promise<void> | undefined;
  try {
    await waitStarted(f.store.saved);
    const id = f.store.createdId!;
    let stopped = false;
    stopping = f.manager.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "the durable creation prelude still belongs to manager teardown");
    f.store.saved.release();
    await Promise.all([stopping, settled]);
    const current = (await f.store.load(id))!;
    assert.ok(["executing", "failed"].includes(current.phase), "no model handle exists to keep this workflow in reviewing");
    assert.notEqual(current.processState, "running");
    assert.equal(current.reviewCycles, 0);
    assert.equal(current.latestReview, undefined);
    assert.equal(current.observedUsage, undefined);
    f.assertNeverStarted(); f.assertEmpty();
    f.store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observer = new WorkflowStore(f.store.directory);
    try { assert.deepEqual(await observer.load(id), current); } finally { observer.close(); }
  } finally { f.store.saved.release(); await settled; await stopping; await f.close(); }
});

test("review-only creation cannot inherit a replacement owner or task after its record is saved", async () => {
  for (const change of ["owner", "task"] as const) {
    const f = await fixture();
    const reviewing = f.manager.reviewOnly(f.input, f.exec);
    const settled = Promise.allSettled([reviewing]);
    try {
      await waitStarted(f.store.saved);
      const id = f.store.createdId!;
      await f.store.update(id, (record) => {
        if (change === "owner") record.dshSessionId = "replacement-owner";
        else record.task = "REPLACEMENT-TASK-AFTER-CREATION";
        record.lastProgressMessage = "REPLACEMENT-PROGRESS-AFTER-CREATION";
      });
      const replacement = (await f.store.load(id))!;
      f.store.saved.release();
      const outcomes = await settled;
      assert.equal(outcomes[0]?.status, "rejected", `${change}: the caller cannot adopt replacement scope`);
      assert.deepEqual(await f.store.load(id), replacement, `${change}: the full replacement record stays unchanged`);
      f.assertNeverStarted();
      await f.manager.stop(); f.assertEmpty();
    } finally { f.store.saved.release(); await settled; await f.close(); }
  }
});

test("review-only model, effort and attempt cannot replace the original saved creation scope", async () => {
  for (const change of ["model", "effort", "attempt"] as const) {
    const f = await fixture();
    const reviewing = f.manager.reviewOnly(f.input, f.exec);
    const settled = Promise.allSettled([reviewing]);
    try {
      await waitStarted(f.store.saved);
      const id = f.store.createdId!;
      await f.store.update(id, (record) => {
        if (change === "model") record.reviewerModel = "replacement-model";
        else if (change === "effort") record.reviewerEffort = "high";
        else record.reviewAttempt = 19;
      });
      const replacement = (await f.store.load(id))!;
      f.store.saved.release();
      const outcomes = await settled;
      assert.equal(outcomes[0]?.status, "rejected", `${change}: initial admission cannot reinterpret a different model, effort or attempt`);
      assert.deepEqual(await f.store.load(id), replacement, `${change}: the replacement record must remain byte-identical`);
      f.assertNeverStarted();
      await f.manager.stop(); f.assertEmpty();
    } finally { f.store.saved.release(); await settled; await f.close(); }
  }
});

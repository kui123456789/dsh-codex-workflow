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
import type { ReviewResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Approved health requirements are verified.";
const VERDICT: ReviewResult = { verdict: "pass", findings: [], testGaps: [], summary: "Approved health requirements are verified" };

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { started: new Promise<void>((resolve) => { enter = resolve; }),
    promise: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

async function waitStarted(hold: ReturnType<typeof gate>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hold.started, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Foreground native child creation never started")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-foreground-startup-lifecycle-"));
  await writeFile(join(directory, "changed.txt"), "health diagnostic implementation v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const creation = gate();
  const owner = SessionId("foreground-startup-owner");
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
  let begins = 0;
  let ends = 0;
  const gateway: CodexGateway = {
    async startThread() {
      const id = `foreground-private-${privateThreads.length + 1}`;
      privateThreads.push(id); available.add(id); return id;
    },
    async startReviewerThread() {
      const id = `foreground-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("Foreground startup cannot resume a replacement thread"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this foreground startup"); },
    async resolveDefaultModel() { return "model-A"; },
    async startReview(options) {
      modelCalls += 1;
      const turnId = `native-${++turns}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { threadId: options.threadId, result: { kind: "completed" as const, threadId: options.threadId,
        turnId, status: "completed" as const, text: REVIEW } };
    },
    async startTurn(threadId, options) {
      modelCalls += 1;
      const turnId = `visible-${++turns}`;
      await options.onStarted?.({ threadId, turnId });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async normalizeInFork(options) {
      modelCalls += 1;
      const turnId = `normalization-${++turns}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { kind: "completed", threadId: options.threadId, turnId, status: "completed",
        text: options.prompt.includes("REVIEW AUTHORITY checker")
          ? JSON.stringify({ aligned: true, conflicts: [] }) : JSON.stringify(VERDICT) };
    },
    async interrupt() {},
    async unsubscribeThread(id) { released.push(id); assert.ok(available.delete(id), "each thread is released once"); },
    isThreadAvailable: (id) => available.has(id),
    beginRound() { begins += 1; pins += 1; },
    endRound() { ends += 1; pins -= 1; },
  };
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    creation.enter();
    // Exercise an already admitted host operation that returns after abort.
    await creation.promise;
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
  const input = { task: "Review read-only local health diagnostics", implementationSummary: "Health command implemented",
    changedFiles: ["changed.txt"], testResults: "Fixture verified" };
  return { directory, store, manager, runtime, exec, input, creation, children, disposed,
    get modelCalls() { return modelCalls; },
    async seed() {
      const now = new Date().toISOString();
      const record: WorkflowRecord = { schemaVersion: 1, id: "planned-startup-workflow", dshSessionId: owner,
        cwd: directory, task: input.task, mode: "planned", phase: "executing", createdAt: now, updatedAt: now,
        assumptions: [], questions: [], planMarkdown: "<proposed_plan>\nCheck health read-only.\n</proposed_plan>", reviewCycles: 0 };
      await store.save(record); return record;
    },
    async originalRecord() {
      const records = await store.list(); assert.equal(records.length, 1); return records[0]!;
    },
    assertNoModel() {
      assert.equal(modelCalls, 0);
      assert.deepEqual(reviewerThreads, []);
      assert.deepEqual(privateThreads, []);
    },
    assertCleaned() {
      assert.equal(runtime.codexChildSessions.size, 0);
      assert.equal(runtime.foreground.size, 0);
      assert.equal(runtime.backgroundTasks.size, 0);
      assert.equal(runtime.reviewFlights.size, 0);
      assert.equal(runtime.reviewControllers.size, 0);
      assert.equal(runtime.reviewHeartbeats.size, 0);
      assert.equal(runtime.activeTurns.size, 0);
      assert.equal(runtime.auxiliaryTurns.size, 0);
      assert.equal(runtime.recoverableRuns.size, 0);
      assert.equal(pins, 0);
      assert.equal(begins, ends);
      assert.deepEqual(released, [...privateThreads, ...reviewerThreads]);
    },
    async close() {
      creation.release(); await manager.stop(); factory.unregisterProvider();
      if (!store.isClosed()) store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("cancel during foreground native child creation returns the latest cancelled workflow without starting a model", async () => {
  const f = await fixture();
  const reviewing = f.manager.reviewOnly(f.input, f.exec);
  const settled = Promise.allSettled([reviewing]);
  try {
    await waitStarted(f.creation);
    const original = await f.originalRecord();
    assert.equal((await f.manager.cancel(original.id, f.exec)).phase, "cancelled");
    f.creation.release();
    const outcomes = await settled;
    assert.equal(outcomes[0]?.status, "fulfilled", "explicit cancellation wins the public review DTO even before a model handle exists");
    if (outcomes[0]?.status === "fulfilled") assert.equal(outcomes[0].value.phase, "cancelled");
    const current = (await f.store.load(original.id))!;
    assert.equal(current.phase, "cancelled");
    assert.equal(current.processState, "cancelled");
    assert.equal(current.reviewCycles, 0);
    assert.equal(current.latestReview, undefined);
    assert.equal(current.observedUsage, undefined);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    f.assertNoModel();
    await f.manager.stop(); f.assertCleaned();
  } finally { f.creation.release(); await settled; await f.close(); }
});

test("stop during reviewOnly native creation awaits its handle and leaves a queryable workflow outside reviewing", async () => {
  const f = await fixture();
  const reviewing = f.manager.reviewOnly(f.input, f.exec);
  const settled = Promise.allSettled([reviewing]);
  let stopping: Promise<void> | undefined;
  try {
    await waitStarted(f.creation);
    const original = await f.originalRecord();
    assert.equal(original.phase, "executing", "durable creation is retryable before review observation actually starts");
    let stopped = false;
    stopping = f.manager.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    f.creation.release();
    await Promise.all([stopping, settled]);
    const current = (await f.store.load(original.id))!;
    assert.ok(["executing", "failed"].includes(current.phase), "an unstarted model cannot strand reviewOnly in reviewing");
    assert.notEqual(current.processState, "running");
    assert.equal(current.reviewCycles, 0);
    assert.equal(current.latestReview, undefined);
    assert.equal(current.observedUsage, undefined);
    assert.match(current.error ?? "", /startup|child|stopped|teardown|abort|cancel/i);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length, 0);
    f.assertNoModel(); f.assertCleaned();
    f.store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observer = new WorkflowStore(f.store.directory);
    try { assert.deepEqual(await observer.load(original.id), current); } finally { observer.close(); }
  } finally { f.creation.release(); await settled; await stopping; await f.close(); }
});

test("a displaced foreground startup cannot adopt its child or overwrite replacement owner, task and attempt", async () => {
  const f = await fixture();
  const original = await f.seed();
  const reviewing = f.manager.review(original.id, f.input, f.exec);
  const settled = Promise.allSettled([reviewing]);
  try {
    await waitStarted(f.creation);
    await f.store.update(original.id, (record) => {
      record.dshSessionId = "replacement-owner";
      record.task = "REPLACEMENT-TASK-STARTUP";
      record.reviewAttempt = 17;
      record.lastProgressMessage = "REPLACEMENT-PROGRESS-STARTUP";
    });
    const replacement = (await f.store.load(original.id))!;
    f.creation.release();
    const outcomes = await settled;
    assert.equal(outcomes[0]?.status, "rejected", "the original caller cannot inherit a replacement's review authority");
    assert.deepEqual(await f.store.load(original.id), replacement, "no startup, model, usage or finalizer can write the replacement record");
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    f.assertNoModel();
    await f.manager.stop(); f.assertCleaned();
  } finally { f.creation.release(); await settled; await f.close(); }
});

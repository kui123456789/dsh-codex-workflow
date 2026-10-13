import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { mergeWorkflowObservedUsage } from "../src/workflow-usage.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const ORIGINAL_TASK = "Original caller's local diagnostic";
const PRIVATE_TASK = "PRIVATE-REPLACEMENT-TASK-SENTINEL";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { enter, release, entered, promise };
}

const usage = (model: string, totalTokens: number) => mergeWorkflowObservedUsage(undefined, [{
  sourceId: "opaque-usage-source", stage: "planning", model,
  total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0 },
}]);

async function fixture(entry: "start" | "review" | "native" = "start") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-workflow-return-owner-"));
  await writeFile(join(directory, "changed.txt"), "local diagnostic implementation", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const threadFailure = gate();
  const flushing = gate();
  const interruption = gate();
  let modelCalls = 0;
  let pins = 0;
  let ends = 0;
  let flushes = 0;
  const gateway: CodexGateway = {
    async startThread() {
      if (entry === "native") return "original-return-planner";
      // This in-process port creates no App Server or RPC. It only holds the
      // genuine Planner error path before its raw cancelled-record read.
      threadFailure.enter();
      await threadFailure.promise;
      throw new Error("operation aborted");
    },
    async resumeThread(): Promise<never> { throw new Error("No replacement is permitted"); },
    async startReviewerThread(): Promise<never> {
      threadFailure.enter();
      await threadFailure.promise;
      throw new Error("operation aborted");
    },
    async startTurn(threadId) {
      if (entry === "native") return { kind: "needs_input", threadId, turnId: "original-return-turn", request: {
        requestId: 1, threadId, turnId: "original-return-turn", itemId: "original-return-question", questions: [{ id: "scope",
          header: "Scope", question: "Which configuration should be inspected?", options: [], allowOther: true, secret: false }],
      } };
      modelCalls += 1;
      throw new Error("No model is used by this return-boundary test");
    },
    async continueTurn(): Promise<never> {
      if (entry === "native") throw new Error("operation aborted");
      throw new Error("No native input is used");
    },
    async startReview(): Promise<never> { throw new Error("No model is used"); },
    async normalizeInFork(): Promise<never> { throw new Error("No conversion is used"); },
    async interrupt() {
      if (entry === "native") { interruption.enter(); await interruption.promise; }
    },
    beginRound() { pins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const owner = SessionId("return-owner-A");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false });
  const exec = { agent: { id: owner, session }, signal: new AbortController().signal,
    deferContext() { throw new Error("A cancelled or displaced workflow cannot inject a plan"); } } as unknown as ToolRunContext;
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config);
  const observer = (manager as unknown as { usageObserver: { flush(id?: string): Promise<void> } }).usageObserver;
  const flush = observer.flush.bind(observer);
  observer.flush = async (id) => {
    flushes += 1;
    flushing.enter();
    await flushing.promise;
    await flush(id);
  };
  if (entry === "review") {
    const now = new Date().toISOString();
    await store.save({ schemaVersion: 1, id: "return-review", dshSessionId: owner, cwd: directory,
      task: ORIGINAL_TASK, phase: "executing", mode: "planned", createdAt: now, updatedAt: now,
      planMarkdown: "<proposed_plan>\nInspect local configuration read-only and verify valid, missing and invalid settings.\n</proposed_plan>",
      questions: [], assumptions: [], reviewCycles: 0 });
  }
  const operation = entry === "review"
    ? manager.review("return-review", { implementationSummary: "Implemented a local diagnostic", changedFiles: ["changed.txt"] }, exec)
    : manager.start({ task: ORIGINAL_TASK }, exec);
  void operation.catch(() => undefined);
  const outcome = Promise.allSettled([operation]);
  const initial = async () => {
    await Promise.race([threadFailure.entered, operation.then(() => { throw new Error("The Planner returned before its local error boundary"); })]);
    const record = (await store.list())[0];
    assert.ok(record);
    assert.equal(record.dshSessionId, owner);
    return record;
  };
  return { directory, store, manager, exec, threadFailure, flushing, interruption, operation, outcome, initial,
    get modelCalls() { return modelCalls; }, get flushes() { return flushes; },
    assertClosed() { assert.deepEqual({ modelCalls, pins, ends }, { modelCalls: 0, pins: 0, ends: 1 }); },
    async close() {
      threadFailure.release(); flushing.release(); interruption.release(); await operation.catch(() => undefined); await manager.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test("same-owner cancelled result refreshes canonical counters after usage flush without replacing its business DTO", async () => {
  const f = await fixture();
  try {
    const initial = await f.initial();
    await f.store.update(initial.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; });
    f.threadFailure.release();
    await Promise.race([f.flushing.entered, f.operation.then(() => { throw new Error("The result returned before metering flush"); })]);
    const canonical = usage("same-owner-model", 42);
    await f.store.update(initial.id, (record) => { record.observedUsage = canonical; }, { ignoreCancelled: true });
    f.flushing.release();
    const returned = await f.operation;
    assert.equal(returned.dshSessionId, initial.dshSessionId);
    assert.equal(returned.task, ORIGINAL_TASK);
    assert.equal(returned.phase, "cancelled");
    assert.deepEqual(returned.observedUsage, canonical);
    assert.equal(f.flushes, 1);
    f.assertClosed();
  } finally { await f.close(); }
});

test("owner change only during usage flush never exposes the replacement record or its counters", async () => {
  const f = await fixture();
  try {
    const initial = await f.initial();
    await f.store.update(initial.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; });
    f.threadFailure.release();
    await Promise.race([f.flushing.entered, f.operation.then(() => { throw new Error("The result returned before metering flush"); })]);
    await f.store.update(initial.id, (record) => {
      record.dshSessionId = "return-owner-B";
      record.task = PRIVATE_TASK;
      record.observedUsage = usage("PRIVATE-MODEL-SENTINEL", 99);
    }, { ignoreCancelled: true });
    assert.equal((await f.store.load(initial.id))?.dshSessionId, "return-owner-B");
    f.flushing.release();
    const [result] = await f.outcome;
    if (result?.status === "fulfilled") {
      assert.equal(result.value.dshSessionId, initial.dshSessionId);
      assert.equal(result.value.task, ORIGINAL_TASK);
      assert.ok(!JSON.stringify(result.value).includes("PRIVATE-"));
    } else assert.match(String(result?.reason), /owner|scope|session|identity/i);
    f.assertClosed();
  } finally { await f.close(); }
});

test("cancelled fast return cannot expose a changed owner's private workflow through the usage wrapper", async () => {
  const f = await fixture();
  try {
    const initial = await f.initial();
    await f.store.update(initial.id, (record) => {
      record.dshSessionId = "return-owner-B";
      record.task = PRIVATE_TASK;
      record.phase = "cancelled";
      record.processState = "cancelled";
    });
    const replacement = await f.store.load(initial.id);
    assert.ok(replacement);
    f.threadFailure.release();
    await Promise.race([f.flushing.entered, f.operation.catch(() => undefined)]);
    f.flushing.release();
    const [result] = await f.outcome;
    if (result?.status === "fulfilled") {
      assert.ok(!JSON.stringify(result.value).includes(PRIVATE_TASK), "the original caller must never receive the private replacement task");
    }
    assert.equal(result?.status, "rejected", "the original caller cannot receive a foreign cancelled DTO even when record and counter owners agree");
    if (result?.status === "rejected") assert.ok(!String(result.reason).includes(PRIVATE_TASK));
    assert.deepEqual(await f.store.load(initial.id), replacement, "return authorization cannot rewrite the replacement owner's terminal record");
    f.assertClosed();
  } finally { await f.close(); }
});

test("public workflow wrapper rejects a foreign DTO stubbed at the flow boundary before flushing usage", async () => {
  const f = await fixture();
  try {
    const initial = await f.initial();
    await f.store.update(initial.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; });
    f.threadFailure.release();
    await Promise.race([f.flushing.entered, f.operation.then(() => { throw new Error("The result returned before metering flush"); })]);
    f.flushing.release();
    const ownResult = await f.operation;
    const flow = (f.manager as unknown as { plannerFlow: { start(): Promise<WorkflowRecord> } }).plannerFlow;
    const originalStart = flow.start;
    // This isolates the public wrapper's defense against a bad flow result;
    // the preceding fast-return regression covers the genuine Planner path.
    flow.start = async () => ({ ...ownResult, dshSessionId: "return-owner-B", task: PRIVATE_TASK });
    try {
      await assert.rejects(f.manager.start({ task: ORIGINAL_TASK }, f.exec), /another DSH session|owner|identity/i);
      assert.equal(f.flushes, 1, "foreign results must be denied before metering their record");
      f.assertClosed();
    } finally { flow.start = originalStart; }
  } finally { await f.close(); }
});

test("native interruption cleanup cannot return a changed same-owner cancelled scope", async () => {
  const f = await fixture("native");
  let answering: Promise<WorkflowRecord> | undefined;
  try {
    await Promise.race([f.flushing.entered, f.operation.then(() => { throw new Error("The native Planner skipped its usage flush"); })]);
    f.flushing.release();
    const initial = await f.operation;
    assert.equal(initial.phase, "waiting_input");
    answering = f.manager.continue(initial.id, { scope: ["Inspect local configuration"] }, f.exec);
    const settled = Promise.allSettled([answering]);
    await Promise.race([f.interruption.entered, answering.then(() => { throw new Error("Native interruption was not attempted"); })]);
    const changed = await f.store.update(initial.id, (record) => {
      record.task = PRIVATE_TASK;
      record.phase = "cancelled";
      record.processState = "cancelled";
    });
    f.interruption.release();
    const [result] = await settled;
    assert.equal(result?.status, "rejected", "a terminal shortcut cannot bypass the original task scope after awaited cleanup");
    if (result?.status === "rejected") assert.ok(!String(result.reason).includes(PRIVATE_TASK));
    assert.deepEqual(await f.store.load(initial.id), changed.record);
    f.assertClosed();
  } finally { f.interruption.release(); await answering?.catch(() => undefined); await f.close(); }
});

test("public Review cannot return a foreign cancelled workflow through the usage wrapper", async () => {
  const f = await fixture("review");
  try {
    const initial = await f.initial();
    const changed = await f.store.update(initial.id, (record) => {
      record.dshSessionId = "return-owner-B";
      record.task = PRIVATE_TASK;
      record.phase = "cancelled";
      record.processState = "cancelled";
    });
    f.threadFailure.release();
    await Promise.race([f.flushing.entered, f.operation.catch(() => undefined)]);
    f.flushing.release();
    const [result] = await f.outcome;
    assert.equal(result?.status, "rejected", "the real Review failure path remains bound to its original caller");
    if (result?.status === "rejected") assert.ok(!String(result.reason).includes(PRIVATE_TASK));
    assert.deepEqual(await f.store.load(initial.id), changed.record,
      "old cleanup cannot mutate the replacement owner's business fields or row metadata");
    f.assertClosed();
  } finally { await f.close(); }
});

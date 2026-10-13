import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowRecord } from "../src/types.js";
import type { TokenUsageSnapshot } from "../src/usage-accounting.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-persisted-usage-"));
  const store = new WorkflowStore(directory);
  const now = new Date().toISOString();
  const record: WorkflowRecord = { schemaVersion: 1, id: randomUUID(), dshSessionId: "owner", cwd: directory,
    task: "Observe token usage", mode: "planned", phase: "executing", createdAt: now, updatedAt: now,
    questions: [], assumptions: [], reviewCycles: 0, noChangeReviewRounds: 0 };
  await store.save(record);
  const module = await import("../src/application/workflow-usage-observer.js");
  const snapshots = new Map<string, TokenUsageSnapshot>();
  const listeners = new Set<(snapshot: TokenUsageSnapshot) => void>();
  const gateway = {
    getThreadTokenUsage(threadId: string) { return snapshots.get(threadId); },
    onTokenUsage(listener: (snapshot: TokenUsageSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const observer = new module.WorkflowUsageObserver(store, gateway);
  const emit = (snapshot: TokenUsageSnapshot) => {
    snapshots.set(snapshot.threadId, snapshot);
    for (const listener of listeners) listener(snapshot);
  };
  const saved = async () => (await store.load(record.id))!.observedUsage!;
  return { directory, store, record, observer, gateway, emit, saved, snapshots, listeners, module,
    async close() { await observer.stop(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function snapshot(threadId: string, totalTokens: number, cachedInputTokens = 0): TokenUsageSnapshot {
  const usage = { totalTokens, inputTokens: totalTokens, cachedInputTokens, outputTokens: 0, reasoningOutputTokens: 0 };
  return { threadId, turnId: `${threadId}:private-turn`, total: usage, last: usage, modelContextWindow: 128000 };
}

test("bound sources stay unknown until observed and optional cache writes are never fabricated as zero", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "raw-thread-secret", "planning", "test-model");
    const empty = await f.saved();
    assert.equal(empty.version, 1);
    assert.equal(empty.scope, "observed_original_threads");
    assert.equal(empty.source, "app_server");
    assert.equal(empty.summary.missingSources, 1);
    assert.equal(empty.summary.observedSources, 0);
    assert.equal(empty.summary.total, undefined);
    assert.equal(empty.sources[0]?.total, undefined);
    assert.equal(empty.sources[0]?.last, undefined);
    f.emit(snapshot("raw-thread-secret", 100, 60));
    await f.observer.flush(f.record.id);
    const observed = await f.saved();
    assert.equal(observed.summary.total?.totalTokens, 100);
    assert.equal(observed.summary.total?.cachedInputTokens, 60);
    assert.equal(observed.summary.total?.cacheWriteInputTokens, undefined);
    assert.equal(observed.summary.partialSources, 1);
    assert.ok(!JSON.stringify(observed).includes("raw-thread-secret"));
    assert.match(observed.sources[0]!.sourceId, /^[0-9a-f-]{36}$/i);
  } finally { await f.close(); }
});

test("100 then 150 then repeated 150 replaces one retained source and an independent 30 contributes exactly once", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "planner-thread", "planning");
    const sourceId = (await f.saved()).sources[0]!.sourceId;
    for (const count of [100, 150, 150]) f.emit(snapshot("planner-thread", count));
    await f.observer.bind(f.record.id, "planner-thread", "planning");
    await f.observer.bind(f.record.id, "reviewer-thread", "reviewing");
    f.emit(snapshot("reviewer-thread", 30));
    await f.observer.flush();
    const observed = await f.saved();
    assert.equal(observed.sources.length, 2);
    assert.equal(observed.sources[0]!.sourceId, sourceId);
    assert.equal(observed.sources[0]!.total?.totalTokens, 150);
    assert.equal(observed.summary.total?.totalTokens, 180);
    assert.equal(observed.summary.observedSources, 2);
    assert.equal(observed.summary.missingSources, 0);
  } finally { await f.close(); }
});

test("usage survives store reopen, terminal phases and concurrent business updates without losing either write", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "reviewing");
    await Promise.all([
      f.store.update(f.record.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; }),
      (async () => { f.emit(snapshot("thread", 150)); await f.observer.flush(); })(),
    ]);
    f.snapshots.set("thread", snapshot("thread", 200));
    await f.observer.release(f.record.id, "thread");
    const ended = (await f.store.load(f.record.id))!;
    assert.equal(ended.phase, "cancelled");
    assert.equal(ended.processState, "cancelled");
    assert.equal(ended.observedUsage?.summary.total?.totalTokens, 200);
    await f.observer.stop();
    f.store.close();
    const reopened = new WorkflowStore(f.directory);
    try { assert.deepEqual((await reopened.load(f.record.id))?.observedUsage, ended.observedUsage); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

test("raw store observation records late real usage even inside a lost review admission context", async () => {
  const f = await fixture();
  try {
    const { WorkflowReviewAdmission } = await import("../src/application/workflow-review-admission.js");
    const admission = new WorkflowReviewAdmission();
    await f.observer.bind(f.record.id, "thread", "reviewing");
    const controller = new AbortController();
    await admission.run(f.record.id, "missing-review-lease", { owner: "expired", epoch: 1 }, f.store.coordinationHandle, controller, async () => {
      f.emit(snapshot("thread", 70));
      await f.observer.flush();
    });
    assert.equal((await f.saved()).summary.total?.totalTokens, 70);
    assert.equal((await f.store.load(f.record.id))!.phase, "executing");
  } finally { await f.close(); }
});

test("counter regression preserves the previous authoritative snapshot and marks the source anomalous", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "reviewing");
    f.emit(snapshot("thread", 150, 100));
    await f.observer.flush();
    f.emit(snapshot("thread", 120, 80));
    await f.observer.flush();
    const observed = await f.saved();
    assert.equal(observed.sources[0]?.total?.totalTokens, 150);
    assert.equal(observed.sources[0]?.last?.totalTokens, 150);
    assert.ok(observed.sources[0]?.anomalies?.includes("counter_regression"));
    assert.equal(observed.summary.anomalousSources, 1);
    assert.equal(observed.summary.total?.totalTokens, 150);
  } finally { await f.close(); }
});

test("safe-integer overflow is marked rather than silently wrapping or being reported as zero", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "large", "planning");
    await f.observer.bind(f.record.id, "small", "reviewing");
    f.emit(snapshot("large", Number.MAX_SAFE_INTEGER));
    f.emit(snapshot("small", 1));
    await f.observer.flush();
    const observed = await f.saved();
    assert.equal(observed.summary.total?.totalTokens, undefined);
    assert.equal(observed.summary.total?.inputTokens, undefined);
    assert.ok(observed.summary.overflowCounters?.includes("totalTokens"));
    assert.equal(observed.sources[0]?.total?.totalTokens, Number.MAX_SAFE_INTEGER);
  } finally { await f.close(); }
});

test("write faults retain the original source and snapshot for retry without exposing raw diagnostics", async () => {
  const f = await fixture();
  try {
    const update = f.store.update.bind(f.store);
    let failed = false;
    f.store.update = ((...args: Parameters<WorkflowStore["update"]>) => {
      if (!failed) { failed = true; return Promise.reject(new Error("raw-thread-secret token=do-not-expose")); }
      return update(...args);
    }) as typeof f.store.update;
    f.snapshots.set("thread", snapshot("thread", 100));
    await f.observer.bind(f.record.id, "thread", "planning");
    const diagnostic = f.observer.getPersistenceError(f.record.id);
    assert.ok(diagnostic);
    assert.ok(!diagnostic!.includes("raw-thread-secret"));
    assert.ok(!diagnostic!.includes("do-not-expose"));
    await f.observer.flush();
    const observed = await f.saved();
    assert.equal(observed.sources.length, 1);
    assert.equal(observed.summary.total?.totalTokens, 100);
    assert.equal(f.observer.getPersistenceError(f.record.id), undefined);
  } finally { await f.close(); }
});

test("one process-local thread cannot be rebound to another workflow or stage", async () => {
  const f = await fixture();
  try {
    const other = { ...f.record, id: randomUUID(), dshSessionId: "other" };
    await f.store.save(other);
    await f.observer.bind(f.record.id, "thread", "planning");
    await assert.rejects(f.observer.bind(other.id, "thread", "planning"), /binding|identity|owner/i);
    await assert.rejects(f.observer.bind(f.record.id, "thread", "reviewing"), /binding|identity|owner/i);
    await assert.rejects(f.observer.release(other.id, "thread"), /binding|identity|owner/i);
    f.emit(snapshot("thread", 100));
    await f.observer.flush();
    assert.equal((await f.saved()).sources.length, 1);
    assert.equal((await f.store.load(other.id))?.observedUsage, undefined);
  } finally { await f.close(); }
});

test("release captures the final snapshot, drops process binding and stop removes the notification observer", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "planning");
    f.emit(snapshot("thread", 100));
    f.snapshots.set("thread", snapshot("thread", 150));
    await f.observer.release(f.record.id, "thread");
    const finished = await f.saved();
    assert.equal(finished.summary.total?.totalTokens, 150);
    f.emit(snapshot("thread", 180));
    await f.observer.flush();
    assert.deepEqual(await f.saved(), finished, "a released thread no longer mutates the durable source");
    await f.observer.stop();
    assert.equal(f.listeners.size, 0);
  } finally { await f.close(); }
});

test("identical usage notifications and same-source rebind do not rewrite revision or timestamps", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "planning");
    f.emit(snapshot("thread", 150));
    await f.observer.flush();
    const before = await f.store.load(f.record.id);
    for (let i = 0; i < 10; i += 1) f.emit(snapshot("thread", 150));
    await f.observer.bind(f.record.id, "thread", "planning");
    await f.observer.flush();
    assert.deepEqual(await f.store.load(f.record.id), before);
  } finally { await f.close(); }
});

test("separate raw-store observers use CAS to preserve independent source updates and business fields", async () => {
  const f = await fixture();
  const secondStore = new WorkflowStore(f.directory);
  const second = new f.module.WorkflowUsageObserver(secondStore, f.gateway);
  try {
    await Promise.all([f.observer.bind(f.record.id, "planner", "planning"), second.bind(f.record.id, "reviewer", "reviewing")]);
    f.emit(snapshot("planner", 100));
    f.emit(snapshot("reviewer", 30));
    await Promise.all([
      f.observer.flush(), second.flush(),
      f.store.update(f.record.id, (record) => { record.planMarkdown = "Approved plan"; record.reviewCycles = 1; }),
    ]);
    const record = (await f.store.load(f.record.id))!;
    assert.equal(record.observedUsage?.summary.total?.totalTokens, 130);
    assert.equal(record.observedUsage?.sources.length, 2);
    assert.equal(record.reviewCycles, 1);
    assert.equal(record.planMarkdown, "Approved plan");
  } finally { await second.stop(); secondStore.close(); await f.close(); }
});

test("a changed DSH owner cannot receive usage from an already bound source", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "planning");
    await f.store.update(f.record.id, (record) => { record.dshSessionId = "new-owner"; });
    f.emit(snapshot("thread", 150));
    await f.observer.flush();
    assert.equal((await f.saved()).summary.total, undefined);
    assert.ok(f.observer.getPersistenceError(f.record.id));
    assert.equal((await f.store.load(f.record.id))?.dshSessionId, "new-owner");
  } finally { await f.close(); }
});

test("invalid snapshots cannot overwrite valid usage and missing counters remain unknown", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "planning");
    f.emit(snapshot("thread", 100));
    await f.observer.flush();
    f.emit({ ...snapshot("thread", 150), total: { ...snapshot("thread", 150).total, inputTokens: -1 } });
    await f.observer.flush();
    assert.equal((await f.saved()).summary.total?.totalTokens, 100);
    assert.ok((await f.saved()).sources[0]?.anomalies?.includes("invalid_snapshot"));
    assert.equal((await f.saved()).summary.anomalousSources, 1);
  } finally { await f.close(); }
});

test("release waits for usage arriving while its final write is pending before forgetting the binding", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  let releaseSecond!: () => void;
  let enteredSecond!: () => void;
  let releaseThird!: () => void;
  let enteredThird!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const heldSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const startedSecond = new Promise<void>((resolve) => { enteredSecond = resolve; });
  const heldThird = new Promise<void>((resolve) => { releaseThird = resolve; });
  const startedThird = new Promise<void>((resolve) => { enteredThird = resolve; });
  let secondReleased = false;
  let thirdReleased = false;
  try {
    await f.observer.bind(f.record.id, "thread", "planning");
    const update = f.store.update.bind(f.store);
    let writeNumber = 0;
    f.store.update = (async (...args: Parameters<WorkflowStore["update"]>) => {
      writeNumber += 1;
      if (writeNumber === 1) { entered(); await held; }
      if (writeNumber === 2) { enteredSecond(); await heldSecond; }
      if (writeNumber === 3) { enteredThird(); await heldThird; }
      return update(...args);
    }) as typeof f.store.update;
    f.snapshots.set("thread", snapshot("thread", 100));
    const releasing = f.observer.release(f.record.id, "thread").then(() => {
      assert.equal(secondReleased, true, "release must await the last admitted usage write");
      assert.equal(thirdReleased, true, "release must also await a notification admitted during its own queued write");
    });
    const settled = Promise.allSettled([releasing]);
    await started;
    f.emit(snapshot("thread", 150));
    release();
    await startedSecond;
    f.emit(snapshot("thread", 200));
    await new Promise<void>((resolve) => setImmediate(resolve));
    secondReleased = true;
    releaseSecond();
    await startedThird;
    await new Promise<void>((resolve) => setImmediate(resolve));
    thirdReleased = true;
    releaseThird();
    const result = (await settled)[0]!;
    if (result.status === "rejected") throw result.reason;
    assert.equal((await f.saved()).summary.total?.totalTokens, 200);
    const before = await f.store.load(f.record.id);
    f.emit(snapshot("thread", 220));
    await f.observer.flush();
    assert.deepEqual(await f.store.load(f.record.id), before);
  } finally { release(); releaseSecond(); releaseThird(); await f.close(); }
});

test("same-source model changes preserve counters but explicitly remove single-model attribution", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread", "planning", "model-a");
    f.emit(snapshot("thread", 100));
    await f.observer.flush();
    await f.observer.bind(f.record.id, "thread", "planning", "model-b");
    f.emit(snapshot("thread", 150));
    await f.observer.flush();
    const mixed = await f.saved();
    assert.equal(mixed.sources.length, 1);
    assert.equal(mixed.summary.total?.totalTokens, 150);
    assert.equal(mixed.sources[0]?.model, undefined);
    assert.equal(mixed.sources[0]?.modelMixed, true);
  } finally { await f.close(); }
});

test("a failed stop flush retains its fixed diagnostic and opaque pending snapshots for an explicit retry", async () => {
  const f = await fixture();
  try {
    await f.observer.bind(f.record.id, "thread-secret", "planning");
    const update = f.store.update.bind(f.store);
    f.store.update = (() => Promise.reject(new Error("secret raw disk diagnostic"))) as typeof f.store.update;
    f.emit(snapshot("thread-secret", 120));
    await f.observer.stop();
    assert.ok(f.observer.getPersistenceError(f.record.id));
    assert.equal(f.listeners.size, 0);
    f.store.update = update;
    await f.observer.flush();
    const observed = await f.saved();
    assert.equal(observed.summary.total?.totalTokens, 120);
    assert.ok(!JSON.stringify(observed).includes("thread-secret"));
    assert.equal(f.observer.getPersistenceError(f.record.id), undefined);
  } finally { await f.close(); }
});

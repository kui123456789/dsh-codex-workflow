import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { ReviewInput, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Fixture = Awaited<ReturnType<typeof sharedReviewerFixture>>;
type Stage = "conversion" | "alignment";
type Outcome = { record: WorkflowRecord; error?: never } | { record?: never; error: unknown };
const input: ReviewInput = { implementationSummary: "Verified read-only local diagnostic implementation",
  changedFiles: ["changed.txt"], testResults: "Valid and unavailable inputs verified in isolation" };
const internal = (manager: WorkflowManager) => manager as unknown as { runtime: WorkflowRuntimeState; config: WorkflowConfig };

function foreground(f: Fixture, store = f.store, parent = f.parent) {
  return new WorkflowManager(store, f.client, { ...internal(f.manager).config,
    conversionTransport: "app-server", conversionFallback: "fail" }, undefined, undefined, undefined, {},
  { get: (id) => id === parent.id ? parent : undefined }, f.factory);
}

async function failPrivateStages(f: Fixture, manager: WorkflowManager, stage: Stage) {
  await f.control("fixture/setTurnMode", { mode: "completed" });
  await f.control("fixture/setHeldSchema", { property: stage === "conversion" ? "verdict" : "aligned" });
  let settled: Outcome | undefined;
  const pending = manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec)
    .then((record): Outcome => settled = { record }, (error: unknown): Outcome => settled = { error });
  const created = await sharedWaitFor(async () => (await f.store.list())[0], "the real SQL review workflow");
  const first = await sharedWaitFor(async () => {
    const stats = await f.control("fixture/stats");
    const row = await f.store.load(created.id);
    return stats.active.length === 1 && row?.reviewStep === `review_${stage}` && stats;
  }, `the actual private ${stage} turn`);
  await f.control("fixture/completeActive", { status: "failed" });
  // An implementation may send its one automatic continuation. The original
  // failure instead settles immediately; observe it without hiding that RED.
  const next = await sharedWaitFor(async () => {
    if (settled) return { settled };
    const stats = await f.control("fixture/stats");
    return settled ? { settled } : stats.active.length === 1 ? { stats } : undefined;
  }, `one automatic ${stage} continuation or the actual failed outcome`);
  if ("stats" in next) {
    await f.control("fixture/completeActive", { status: "failed" });
  }
  const outcome = await pending;
  const stored = await f.store.load(created.id);
  assert.ok(stored);
  return { id: created.id, first, outcome, stored };
}

for (const stage of ["conversion", "alignment"] as const) {
  test(`foreground ${stage} model failure retains its completed stages and resumes only the failed stage`, async (t) => {
    const f = await sharedReviewerFixture();
    const manager = foreground(f);
    try {
      const failed = await failPrivateStages(f, manager, stage);
      t.diagnostic(JSON.stringify({ stage, processState: failed.stored.processState,
        originalOutcome: failed.outcome.error instanceof Error ? failed.outcome.error.message : undefined,
        nativeChildren: f.children.length, rawDisposals: f.rawDisposals.length }));
      assert.ok(failed.outcome.record, "A recoverable private model error returns the original waiting workflow");
      assert.equal(failed.stored.processState, "waiting");
      assert.equal(failed.stored.retryState?.stage, "reviewing");
      assert.equal(failed.stored.reviewCycles, 0);
      const runtime = internal(manager).runtime;
      const recovery = runtime.recoverableRuns.get(failed.id);
      const child = runtime.codexChildSessions.get(failed.id);
      assert.ok(recovery && child);
      assert.equal(recovery.threadId, failed.first.threadStarts[0]!.threadId);
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 0);
      const before = await f.control("fixture/stats");
      assert.equal(before.turnStartRequests.filter((request) => request.method === "review/start").length, 1);
      assert.equal(before.turnStartRequests.filter((request) => request.prompt?.includes("Convert the readable code review")).length,
        stage === "conversion" ? 2 : 1, "Exactly one automatic continuation is allowed; successful conversion is not replayed");
      const row = f.store.coordinationHandle.loadWorkflow(failed.id);
      await f.control("fixture/setHeldSchema", {});
      const resumed = await manager.resume(failed.id, undefined, f.exec);
      const completed = await f.control("fixture/stats");
      assert.equal(resumed.id, failed.id);
      assert.equal(resumed.phase, "passed");
      assert.equal(resumed.reviewCycles, 1);
      assert.equal(resumed.latestReview?.verdict, "pass");
      assert.equal(f.children.length, 1, "Stage recovery cannot start another native DSH child");
      assert.equal(f.children[0]!.id, child.id);
      assert.equal(f.rawDisposals.length, 1);
      assert.equal(completed.turnStartRequests.filter((request) => request.method === "review/start").length, 1,
        "A completed readable review is not repeated during stage recovery");
      assert.equal(completed.turnStartRequests.filter((request) => request.prompt?.includes("Convert the readable code review")).length,
        stage === "conversion" ? 3 : 1);
      assert.equal(completed.visibleTurns, 1, "A short private continuation does not become another visible review");
      assert.equal(completed.active.length, 0);
      assert.equal(completed.writerConflicts, 0);
      assert.equal(runtime.recoverableRuns.size, 0);
      assert.equal(runtime.codexChildSessions.size, 0);
      assert.notDeepEqual(f.store.coordinationHandle.loadWorkflow(failed.id), row);
    } finally { await manager.stop(); await f.close(); }
  });
}

for (const explicit of [false, true]) {
  test(`an unconfirmed live private alignment writer blocks a cold ${explicit ? "explicit new business" : "default same-material"} review`, async (t) => {
    const original = await sharedReviewerFixture();
    const owner = foreground(original);
    let fresh: Fixture | undefined;
    let successor: WorkflowManager | undefined;
    try {
      (original.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 180;
      await original.control("fixture/setTurnMode", { mode: "completed" });
      await original.control("fixture/setInterruptMode", { mode: "failed" });
      await original.control("fixture/setHeldSchema", { property: "aligned" });
      const [outcome] = await Promise.allSettled([owner.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, original.exec)]);
      const waiting = (await original.store.list())[0];
      assert.ok(waiting);
      const before = await original.control("fixture/stats");
      assert.equal(before.active.length, 1, "The actual SDK private writer remains active after failed interruption acknowledgement");
      const row = original.store.coordinationHandle.loadWorkflow(waiting.id);
      fresh = await sharedReviewerFixture();
      await fresh.control("fixture/setTurnMode", { mode: "completed" });
      successor = foreground(fresh, original.store, original.parent);
      assert.equal(internal(successor).runtime.recoverableRuns.size, 0);
      const coldBaseline = await fresh.control("fixture/stats");
      assert.notEqual(coldBaseline.processId, before.processId);
      const cold = await Promise.allSettled([successor.review(waiting.id, {
        ...input, ...(explicit ? { newReviewRound: true } : {}),
      }, original.exec)]);
      const after = await fresh.control("fixture/stats");
      const old = await original.control("fixture/stats");
      t.diagnostic(JSON.stringify({ explicit, originalOutcome: outcome?.status, processState: waiting.processState,
        originalPrivateWriterStillAlive: old.active.some((turn) => turn.threadId === before.active[0]!.threadId && turn.turnId === before.active[0]!.turnId),
        additionalThreads: after.threadStarts.length - coldBaseline.threadStarts.length,
        additionalModels: after.turnStartRequests.length - coldBaseline.turnStartRequests.length, children: fresh.children.length }));
      assert.equal(cold[0]?.status, "rejected", "A released review lease cannot prove the old private SDK writer ended");
      assert.deepEqual(after.threadStarts, coldBaseline.threadStarts);
      assert.deepEqual(after.turnStartRequests, coldBaseline.turnStartRequests);
      assert.equal(fresh.children.length, 0);
      assert.deepEqual(original.store.coordinationHandle.loadWorkflow(waiting.id), row);
      assert.deepEqual(old.active, before.active);
      assert.equal(waiting.processState, "waiting");
      assert.ok(waiting.retryState?.interruption, "The original live process barrier must survive an empty runtime");
    } finally {
      await successor?.stop(); await fresh?.close();
      await original.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
      await original.control("fixture/completeActive").catch(() => undefined);
      await owner.stop(); await original.close();
    }
  });
}

for (const reason of ["permission denied", "invalid output schema: schema validation failed"]) {
  test(`a registered foreground Reviewer ${reason} cannot silently become another default round`, async (t) => {
    const f = await sharedReviewerFixture();
    const manager = foreground(f);
    try {
      await f.control("fixture/setTurnMode", { mode: "completed" });
      await f.control("fixture/setNextTurnError", { message: reason });
      await assert.rejects(manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec));
      const failed = (await f.store.list())[0];
      assert.ok(failed);
      const before = await f.control("fixture/stats");
      assert.equal(before.threadStarts.length, 1, "The original Reviewer thread was successfully created and registered");
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 1, "Terminal errors release the original child once");
      const row = f.store.coordinationHandle.loadWorkflow(failed.id);
      const [retry] = await Promise.allSettled([manager.review(failed.id, input, f.exec)]);
      const after = await f.control("fixture/stats");
      t.diagnostic(JSON.stringify({ reason, retryStatus: retry?.status,
        additionalThreads: after.threadStarts.length - before.threadStarts.length,
        additionalModels: after.turnStartRequests.length - before.turnStartRequests.length, children: f.children.length }));
      assert.equal(retry?.status, "rejected", "Unchanged terminal failure requires an explicit independent business round");
      assert.deepEqual(after.threadStarts, before.threadStarts);
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
      assert.equal(f.children.length, 1);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(failed.id), row);
    } finally { await manager.stop(); await f.close(); }
  });
}

test("failure before the first foreground Reviewer thread preserves the first real review retry", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  try {
    await f.control("fixture/setTurnMode", { mode: "completed" });
    await f.control("fixture/setNextThreadError", { message: "permission denied: local startup control" });
    await assert.rejects(manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec));
    const failed = (await f.store.list())[0];
    assert.ok(failed);
    const before = await f.control("fixture/stats");
    assert.equal(before.threadStarts.length, 0);
    assert.equal(before.turnStartRequests.length, 0);
    const completed = await manager.review(failed.id, input, f.exec);
    const after = await f.control("fixture/stats");
    assert.equal(completed.id, failed.id);
    assert.equal(completed.phase, "passed");
    assert.equal(completed.reviewCycles, 1);
    assert.equal(after.turnStartRequests.filter((request) => request.method === "review/start").length, 1);
    assert.equal(after.active.length, 0);
    assert.equal(after.writerConflicts, 0);
  } finally { await manager.stop(); await f.close(); }
});

const conflictingReadableReview = "VERDICT: changes_requested\nFINDINGS: high/blocking: require an unrelated persistence migration\nTEST GAPS: none\nSUMMARY: Require unrelated migration.";
const conflictingReview = { verdict: "changes_requested", findings: [{ severity: "high", blocking: true,
  title: "Require unrelated persistence migration", body: "Generic architectural suggestion exceeds the read-only diagnostic scope",
  file: "changed.txt", line: 1 }], testGaps: [], summary: "Requested an unrelated migration" };
const authorityConflict = { aligned: false, conflicts: [{ kind: "finding", index: 0,
  reason: "An unrelated migration exceeds the read-only diagnostic task", violated: "Original task requires read-only diagnostics",
  highSeverityException: false }] };

async function actualActiveModel(f: Fixture, minimumCalls: number) {
  return sharedWaitFor(async () => {
    const stats = await f.control("fixture/stats");
    return stats.active.length === 1 && stats.turnStartRequests.length >= minimumCalls && stats;
  }, `the real model call ${minimumCalls}`);
}

for (const late of ["corrected_conversion", "corrected_alignment"] as const) {
  test(`a failed ${late} resumes after the successful one-shot reconciliation without repeating it`, async (t) => {
    const f = await sharedReviewerFixture();
    const manager = foreground(f);
    try {
      // All model turns run through the real SDK. Fixture controls supply a
      // genuine authority conflict and hold only the chosen late private stage.
      await f.control("fixture/setTurnMode", { mode: "active" });
      await f.control("fixture/setActiveVisibleTurns", { count: 1 });
      await f.control("fixture/setHeldSchema", { property: "verdict" });
      let settled: Outcome | undefined;
      const pending = manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec)
        .then((record): Outcome => settled = { record }, (error: unknown): Outcome => settled = { error });
      await actualActiveModel(f, 1);
      await f.control("fixture/completeActive", { text: conflictingReadableReview });
      await actualActiveModel(f, 2);
      await f.control("fixture/setHeldSchema", { property: "aligned" });
      await f.control("fixture/completeActive", { text: JSON.stringify(conflictingReview) });
      await actualActiveModel(f, 3);
      if (late === "corrected_conversion") await f.control("fixture/setHeldSchema", { property: "verdict" });
      await f.control("fixture/completeActive", { text: JSON.stringify(authorityConflict) });
      const beforeFailure = await actualActiveModel(f, late === "corrected_conversion" ? 5 : 6);
      const reconciliations = beforeFailure.turnStartRequests.filter((request) => request.prompt?.includes("CONFLICTING ENTRIES"));
      assert.equal(reconciliations.length, 1, "The private reconciliation readable correction actually completed once");
      assert.notEqual(reconciliations[0]!.threadId, beforeFailure.threadStarts[0]!.threadId,
        "The actual current API uses its private Reconciliation seed, not the original visible Reviewer");
      await f.control("fixture/completeActive", { status: "failed" });
      const next = await sharedWaitFor(async () => {
        if (settled) return { settled };
        const stats = await f.control("fixture/stats");
        return settled ? { settled } : stats.active.length === 1 ? { stats } : undefined;
      }, "the one allowed continuation of the failed private reconciliation stage");
      if ("stats" in next) await f.control("fixture/completeActive", { status: "failed" });
      const outcome = await pending;
      const waiting = (await f.store.list())[0];
      assert.ok(waiting);
      t.diagnostic(JSON.stringify({ late, processState: waiting.processState, outcome: outcome.error instanceof Error ? outcome.error.message : undefined,
        successfulReconciliations: reconciliations.length, nativeChildren: f.children.length, disposals: f.rawDisposals.length }));
      assert.ok(outcome.record, "A late recoverable model error returns the original waiting workflow");
      assert.equal(waiting.processState, "waiting");
      assert.equal(waiting.reviewCycles, 0);
      const child = internal(manager).runtime.codexChildSessions.get(waiting.id);
      assert.ok(child);
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 0);
      await f.control("fixture/setHeldSchema", {});
      const result = await manager.resume(waiting.id, undefined, f.exec);
      const after = await f.control("fixture/stats");
      assert.equal(result.phase, "passed");
      assert.equal(result.reviewCycles, 1);
      assert.equal(after.turnStartRequests.filter((request) => request.method === "review/start").length, 1);
      assert.equal(after.turnStartRequests.filter((request) => request.prompt?.includes("CONFLICTING ENTRIES")).length, 1,
        "The successful one-shot readable correction cannot be repeated during private recovery");
      assert.equal(after.turnStartRequests.filter((request) => request.prompt?.includes("Convert the readable code review")).length,
        late === "corrected_conversion" ? 4 : 2, "Successful initial and corrected conversions are never replayed");
      assert.equal(f.children.length, 1);
      assert.equal(f.children[0]!.id, child.id);
      assert.equal(f.rawDisposals.length, 1);
      assert.equal(after.active.length, 0);
      assert.equal(after.writerConflicts, 0);
    } finally {
      await f.control("fixture/setHeldSchema", {}).catch(() => undefined);
      await f.control("fixture/completeActive").catch(() => undefined);
      await manager.stop(); await f.close();
    }
  });
}

for (const mutation of ["scope", "plan", "previous_applied_review"] as const) {
  test(`a waiting private stage rejects ${mutation} drift before any model request or row write`, async () => {
    const f = await sharedReviewerFixture();
    const manager = foreground(f);
    try {
      const failed = await failPrivateStages(f, manager, "conversion");
      assert.ok(failed.outcome.record, "The original private conversion must first reach a real recoverable wait");
      assert.equal(failed.stored.processState, "waiting");
      const runtime = internal(manager).runtime;
      const handle = runtime.recoverableRuns.get(failed.id);
      const child = runtime.codexChildSessions.get(failed.id);
      assert.ok(handle && child);
      await f.store.update(failed.id, (current) => {
        if (mutation === "scope") current.task = "A different approved task now requires destructive changes";
        if (mutation === "plan") current.planMarkdown = "<proposed_plan>\nA changed authority plan\n</proposed_plan>";
        if (mutation === "previous_applied_review") current.latestReview = {
          verdict: "changes_requested", findings: [], testGaps: ["Different carried-forward review requirement"], summary: "Changed previous applied review",
        };
      });
      const row = f.store.coordinationHandle.loadWorkflow(failed.id);
      const baseline = await f.control("fixture/stats");
      await f.control("fixture/setHeldSchema", {});
      await assert.rejects(manager.resume(failed.id, undefined, f.exec), /scope|authority|checkpoint|plan|original|changed|review/i);
      const after = await f.control("fixture/stats");
      assert.deepEqual(after.threadStarts, baseline.threadStarts);
      assert.deepEqual(after.turnStartRequests, baseline.turnStartRequests);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(failed.id), row);
      assert.equal(runtime.recoverableRuns.get(failed.id), handle);
      assert.equal(runtime.codexChildSessions.get(failed.id), child);
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 0);
    } finally { await manager.stop(); await f.close(); }
  });
}

test("warm private alignment recovery requires its exact ACK and keeps completed conversion cached", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  try {
    (f.client as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 180;
    await f.control("fixture/setTurnMode", { mode: "completed" });
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    await f.control("fixture/setHeldSchema", { property: "aligned" });
    const waiting = await manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    assert.equal(waiting.processState, "waiting");
    const runtime = internal(manager).runtime;
    const recovery = runtime.recoverableRuns.get(waiting.id);
    const child = runtime.codexChildSessions.get(waiting.id);
    assert.ok(recovery?.reviewCheckpoint && recovery.auxiliaryInterruption && child);
    assert.equal(recovery.reviewCheckpoint.nextStep, "alignment");
    const pair = recovery.auxiliaryInterruption;
    const auxiliaryOwner = recovery.auxiliaryInterruptionOwner;
    assert.ok(auxiliaryOwner);
    const before = await f.control("fixture/stats");
    assert.deepEqual(before.active, [{ threadId: pair.threadId, turnId: pair.turnId }]);
    assert.notEqual(pair.threadId, recovery.threadId);
    const row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    await assert.rejects(manager.resume(waiting.id, undefined, f.exec), /private.*interruption.*unconfirmed/i);
    const refused = await f.control("fixture/stats");
    assert.deepEqual(refused.active, before.active);
    assert.deepEqual(refused.threadStarts, before.threadStarts);
    assert.deepEqual(refused.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(runtime.codexChildSessions.get(waiting.id), child);
    assert.equal(f.rawDisposals.length, 0);
    await f.control("fixture/setHeldSchema", {});
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const result = await manager.resume(waiting.id, undefined, f.exec);
    const after = await f.control("fixture/stats");
    assert.equal(result.phase, "passed");
    assert.equal(result.reviewCycles, 1);
    assert.ok(after.interrupts.some((entry) => entry.threadId === pair.threadId && entry.turnId === pair.turnId && entry.mode === "confirmed"));
    assert.equal(f.subscriptionsReleased.filter((id) => id === pair.threadId).length, 1,
      "The acknowledged private subscription is released once");
    assert.equal(after.turnStartRequests.filter((request) => request.method === "review/start").length, 1);
    assert.equal(after.turnStartRequests.filter((request) => request.prompt?.includes("Convert the readable code review")).length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.id, child.id);
    assert.equal(f.rawDisposals.length, 1);
    assert.equal(runtime.auxiliaryTurns.size, 0);
    assert.equal(runtime.auxiliaryConfirmations.has(auxiliaryOwner), true,
      "The original execution keeps its own confirmation without retaining a global address cache");
    assert.equal(after.active.length, 0);
    assert.equal(after.writerConflicts, 0);
  } finally {
    await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
    await f.control("fixture/completeActive").catch(() => undefined);
    await manager.stop(); await f.close();
  }
});

test("a lost original completed checkpoint refuses recovery before resources or SQL change", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  try {
    const failed = await failPrivateStages(f, manager, "conversion");
    assert.ok(failed.outcome.record);
    const runtime = internal(manager).runtime;
    const recovery = runtime.recoverableRuns.get(failed.id);
    const child = runtime.codexChildSessions.get(failed.id);
    assert.ok(recovery?.reviewCheckpoint && child);
    assert.ok(failed.stored.retryState?.reviewCheckpoint);
    const originalCheckpoint = recovery.reviewCheckpoint;
    recovery.reviewCheckpoint = undefined;
    try {
      const row = f.store.coordinationHandle.loadWorkflow(failed.id);
      const before = await f.control("fixture/stats");
      await assert.rejects(manager.resume(failed.id, undefined, f.exec), /original completed Reviewer checkpoint is unavailable/i);
      const after = await f.control("fixture/stats");
      assert.deepEqual(after.threadStarts, before.threadStarts);
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(failed.id), row);
      assert.equal(runtime.recoverableRuns.get(failed.id), recovery);
      assert.equal(runtime.codexChildSessions.get(failed.id), child);
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 0);
    } finally { recovery.reviewCheckpoint = originalCheckpoint; }
  } finally { await manager.stop(); await f.close(); }
});

test("filesystem unavailability during final verification resumes its cached verdict without any model call", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  const source = resolve(join(f.directory, "changed.txt"));
  const held = resolve(join(f.directory, "held-final-evidence.txt"));
  assert.ok(source.startsWith(`${resolve(f.directory)}${sep}`));
  assert.ok(held.startsWith(`${resolve(f.directory)}${sep}`));
  let relocated = false;
  const normalize = f.client.normalizeInFork.bind(f.client);
  f.client.normalizeInFork = async (options, signal) => {
    const result = await normalize(options, signal);
    if (!relocated && options.prompt.includes("REVIEW AUTHORITY checker")) {
      // A real file disappears after all model stages finish; the cached
      // verdict must not be lost while final evidence is temporarily unavailable.
      await rename(source, held);
      relocated = true;
    }
    return result;
  };
  try {
    await f.control("fixture/setTurnMode", { mode: "completed" });
    const waiting = await manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    assert.equal(waiting.processState, "waiting");
    assert.equal(waiting.reviewCycles, 0);
    assert.equal(waiting.retryState?.reviewCheckpoint?.nextStep, "finalizing");
    const recovery = internal(manager).runtime.recoverableRuns.get(waiting.id);
    const child = internal(manager).runtime.codexChildSessions.get(waiting.id);
    assert.ok(recovery?.reviewCheckpoint?.applied && child);
    const before = await f.control("fixture/stats");
    assert.equal(before.turnStartRequests.length, 3);
    assert.equal(f.rawDisposals.length, 0);
    await rename(held, source);
    relocated = false;
    // The model wrapper only caused the one original filesystem fault.
    f.client.normalizeInFork = normalize;
    const completed = await manager.resume(waiting.id, undefined, f.exec);
    const after = await f.control("fixture/stats");
    assert.equal(completed.phase, "passed");
    assert.equal(completed.reviewCycles, 1);
    assert.deepEqual(after.threadStarts, before.threadStarts);
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests,
      "Restoring final evidence consumes no new visible or private model turn");
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.id, child.id);
    assert.equal(f.rawDisposals.length, 1);
    assert.equal(after.active.length, 0);
    assert.equal(after.writerConflicts, 0);
  } finally {
    f.client.normalizeInFork = normalize;
    if (relocated) await rename(held, source);
    await manager.stop(); await f.close();
  }
});

test("alignment progress storage failure does not trigger a model continuation", async () => {
  const f = await sharedReviewerFixture();
  const manager = foreground(f);
  const originalStartThread = f.client.startThread.bind(f.client);
  const originalLoad = f.store.load.bind(f.store);
  let failNextLoad = false;
  f.client.startThread = async (...args) => {
    const threadId = await originalStartThread(...args);
    if (args[0].name?.includes("DSH Review Alignment")) failNextLoad = true;
    return threadId;
  };
  f.store.load = async (id) => {
    if (failNextLoad) {
      failNextLoad = false;
      throw new Error("connection reset by peer while checking review progress");
    }
    return originalLoad(id);
  };
  try {
    await f.control("fixture/setTurnMode", { mode: "completed" });
    await assert.rejects(manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec),
      /connection reset by peer/);
    const record = (await f.store.list())[0];
    assert.ok(record);
    assert.equal(record.processState, "failed");
    assert.equal(record.retryState, undefined);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.turnStartRequests.filter((request) => request.method === "review/start").length, 1);
    assert.equal(stats.active.length, 0);
    assert.equal(f.children.length, 1, "The original child is created once and then disposed");
    assert.equal(f.rawDisposals.length, 1);
  } finally {
    f.client.startThread = originalStartThread;
    f.store.load = originalLoad;
    await manager.stop(); await f.close();
  }
});

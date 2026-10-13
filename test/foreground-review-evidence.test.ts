import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { collectEvidence, type EvidenceOptions } from "../src/evidence.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewEvidence, ReviewInput, ReviewResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

type Stage = "native" | "conversion" | "alignment";

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { enter = resolve; });
  return { promise, started, release, enter };
}

function result(verdict: ReviewResult["verdict"]): ReviewResult {
  return verdict === "pass" ? { verdict, findings: [], testGaps: [], summary: "Approved implementation is verified" }
    : { verdict, findings: [{ severity: "high", blocking: true, title: "STALE-FINDING-SENTINEL",
      body: "The reviewed v1 fixture contains a reproducible configuration defect", file: "changed.txt" }],
      testGaps: [], summary: "Repair the reviewed v1 defect" };
}

async function fixture(verdict: ReviewResult["verdict"] = "pass", heldStage?: Stage, controls: { releaseFailure?: boolean; failedReview?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-foreground-review-evidence-"));
  await writeFile(join(directory, "changed.txt"), "v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const hold = gate();
  const scanHolds: Array<ReturnType<typeof gate>> = [];
  const restoreReaders: Array<() => void> = [];
  const calls: Array<{ stage: Stage; threadId: string }> = [];
  const visibleThreads: string[] = [];
  const released: string[] = [];
  const children: Array<{ id: string; disposals: number }> = [];
  const deferred: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  let selectedVerdict = verdict;
  let holdUsed = false;
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let privateThreads = 0;
  const maybeHold = async (stage: Stage) => {
    if (heldStage === stage && !holdUsed) { holdUsed = true; hold.enter(); await hold.promise; }
  };
  const gateway: CodexGateway = {
    async startThread() { return `private-alignment-${++privateThreads}`; },
    async startReviewerThread() {
      const id = `reviewer-${visibleThreads.length + 1}`;
      visibleThreads.push(id);
      return id;
    },
    async resumeThread() { throw new Error("A foreground business review creates its own Reviewer"); },
    async startReview(options) {
      const turnId = `visible-${visibleThreads.length}`;
      calls.push({ stage: "native", threadId: options.threadId });
      await options.onStarted?.({ threadId: options.threadId, turnId });
      await maybeHold("native");
      if (controls.failedReview) {
        return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId, turnId,
          status: "failed", text: "", reason: "turn failed" } };
      }
      const text = selectedVerdict === "pass"
        ? "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Approved implementation is verified."
        : "VERDICT: changes_requested\nFINDINGS: A reproducible high-severity configuration defect exists in changed.txt.\nTEST GAPS: none\nSUMMARY: Repair the v1 defect.";
      return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId, turnId,
        status: "completed", text } };
    },
    async normalizeInFork(options) {
      const stage = options.prompt.includes("REVIEW AUTHORITY checker") ? "alignment" : "conversion";
      calls.push({ stage, threadId: options.threadId });
      await options.onStarted?.({ threadId: options.threadId, turnId: `${stage}-${calls.length}` });
      await maybeHold(stage);
      return { kind: "completed", threadId: options.threadId, turnId: `${stage}-${calls.length}`, status: "completed",
        text: JSON.stringify(stage === "alignment" ? { aligned: true, conflicts: [] } : result(selectedVerdict)) };
    },
    async startTurn(threadId) {
      calls.push({ stage: "native", threadId });
      throw new Error("The valid aligned fixture must not rewrite or reconcile");
    },
    async continueTurn() { throw new Error("Clarification is outside this regression"); },
    async interrupt() {},
    async unsubscribeThread(threadId) {
      released.push(threadId);
      if (controls.releaseFailure) throw new Error("injected Reviewer release failure");
    },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; begins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const owner = SessionId("foreground-review-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = { agent: { id: owner, session }, signal: new AbortController().signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext;
  const childFactory = { async create() {
    const child = { id: `child-${children.length + 1}`, disposals: 0 };
    children.push(child);
    return { id: child.id, session, beginContinuation() {}, failAttempt() {}, progress() {}, finish() {},
      async dispose() { child.disposals += 1; } } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "test-reviewer",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const now = new Date().toISOString();
  const record: WorkflowRecord = { schemaVersion: 1, id: randomUUID(), dshSessionId: owner, cwd: directory,
    task: "Verify the implemented local configuration diagnostic", mode: "planned", origin: "dsh", phase: "executing",
    createdAt: now, updatedAt: now, planMarkdown: "<proposed_plan>\nAdd a read-only local configuration diagnostic and verify valid/invalid inputs.\n</proposed_plan>",
    questions: [], assumptions: [], reviewCycles: 0, noChangeReviewRounds: 0 };
  await store.save(record);
  const input: ReviewInput = { implementationSummary: "Implemented the local configuration diagnostic", changedFiles: ["changed.txt"], testResults: "Verified the v1 fixture" };
  const review = () => {
    const task = manager.review(record.id, input, exec);
    tasks.push(task);
    void task.catch(() => undefined);
    return task;
  };
  const evidence = () => collectEvidence({ cwd: directory, maxDiffBytes: config.reviewDiffMaxBytes, changedFiles: input.changedFiles });
  const finalEvidenceContext = (manager as unknown as { reviewExecution: { ctx: {
    readFinalEvidence(options: EvidenceOptions): Promise<ReviewEvidence>;
  } } }).reviewExecution.ctx;
  const pauseFinalScan = () => {
    const scan = gate();
    scanHolds.push(scan);
    const original = finalEvidenceContext.readFinalEvidence;
    let scanned: ReviewEvidence | undefined;
    let scanOptions: EvidenceOptions | undefined;
    finalEvidenceContext.readFinalEvidence = async (options) => {
      scanOptions = options;
      scanned = await (original ? original(options) : collectEvidence(options));
      scan.enter();
      await scan.promise;
      return scanned;
    };
    restoreReaders.push(() => { finalEvidenceContext.readFinalEvidence = original; });
    return { ...scan,
      get evidence() { return scanned; }, get options() { return scanOptions; },
      async enteredBefore(task: Promise<unknown>) {
        await Promise.race([scan.started, task.then(() => { throw new Error("Review completed before its final read-only evidence scan"); })]);
      },
    };
  };
  const replaceFinalReader = (reader: (options: EvidenceOptions) => Promise<ReviewEvidence>) => {
    const original = finalEvidenceContext.readFinalEvidence;
    finalEvidenceContext.readFinalEvidence = reader;
    restoreReaders.push(() => { finalEvidenceContext.readFinalEvidence = original; });
  };
  const assertNoVerdict = async () => {
    const current = await store.load(record.id);
    assert.ok(current);
    assert.equal(current.reviewCycles, 0, "An obsolete workspace verdict must not consume a business cycle");
    assert.equal(current.latestReview, undefined, "An obsolete workspace verdict must not become the current review");
    assert.notEqual(current.phase, "passed");
    assert.notEqual(current.phase, "fixing", "Findings for an obsolete workspace must not trigger repair");
    assert.deepEqual(deferred, [], "No completion or repair instruction may be injected for stale evidence");
    const reviewEnds = session.snapshotEvents().filter((event) => event.type === "dsh-codex-workflow/review-end");
    assert.ok(reviewEnds.every((event) => !(event.data as { verdict?: unknown }).verdict), "The session projection must not publish a stale applied verdict");
    return current;
  };
  const assertCleanup = (rounds = 1) => {
    assert.equal(pins, 0);
    assert.equal(begins, rounds + privateThreads, "each business round and private seed owns one pin");
    assert.equal(ends, rounds + privateThreads, "each owned lifecycle releases its pin once");
    assert.equal(children.length, rounds);
    assert.ok(children.every((child) => child.disposals === 1));
    assert.ok(visibleThreads.every((threadId) => released.filter((id) => id === threadId).length === 1));
    for (let index = 1; index <= privateThreads; index += 1) {
      assert.equal(released.filter((id) => id === `private-alignment-${index}`).length, 1);
    }
  };
  return { directory, store, manager, exec, session, hold, calls, deferred, record, input, review, evidence, assertNoVerdict, assertCleanup,
    pauseFinalScan, replaceFinalReader,
    children, visibleThreads, released,
    setVerdict(value: ReviewResult["verdict"]) { selectedVerdict = value; },
    async change() { await writeFile(join(directory, "changed.txt"), "v2", "utf8"); },
    async close() {
      hold.release(); for (const scan of scanHolds) scan.release();
      await Promise.allSettled(tasks);
      for (const restore of restoreReaders.reverse()) restore();
      await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const changed of ["owner", "reviewAttempt", "baselineFingerprint"] as const) {
  test(`failed native review cannot continue or park a changed foreground ${changed}`, async () => {
    const f = await fixture("pass", "native", { failedReview: true });
    try {
      const pending = f.review();
      const settled = Promise.allSettled([pending]);
      await f.hold.started;
      await f.store.update(f.record.id, (record) => {
        if (changed === "owner") record.dshSessionId = "replacement-review-owner";
        if (changed === "reviewAttempt") record.reviewAttempt = (record.reviewAttempt ?? 0) + 1;
        if (changed === "baselineFingerprint") {
          record.latestReviewEvidence = { ...record.latestReviewEvidence!, fingerprint: "replacement-review-baseline" };
        }
        record.lastProgressMessage = "REPLACEMENT-NATIVE-PROGRESS-SENTINEL";
        record.lastProgressAt = "2026-10-05T00:00:00.000Z";
      });
      const replacement = await f.store.load(f.record.id);
      assert.ok(replacement);
      f.hold.release();
      await settled;
      const current = await f.assertNoVerdict();
      assert.deepEqual(f.calls, [{ stage: "native", threadId: f.visibleThreads[0] }], "an obsolete failure cannot call another backend turn");
      assert.equal(current.dshSessionId, replacement.dshSessionId);
      assert.equal(current.reviewAttempt, replacement.reviewAttempt);
      assert.equal(current.latestReviewEvidence?.fingerprint, replacement.latestReviewEvidence?.fingerprint);
      assert.equal(current.phase, replacement.phase);
      assert.equal(current.processState, replacement.processState);
      assert.equal(current.retryState, undefined, "an obsolete Reviewer cannot install its recovery state on the replacement record");
      assert.equal(current.lastProgressMessage, replacement.lastProgressMessage);
      assert.equal(current.lastProgressAt, replacement.lastProgressAt);
      f.assertCleanup();
    } finally { f.hold.release(); await f.close(); }
  });
}

for (const changed of ["owner", "reviewAttempt", "baselineFingerprint"] as const) {
  test(`cleanup failure cannot publish into a changed foreground ${changed}`, async () => {
    const f = await fixture("pass", undefined, { releaseFailure: true });
    const scan = f.pauseFinalScan();
    try {
      const pending = f.review();
      const settled = Promise.allSettled([pending]);
      await scan.enteredBefore(pending);
      await f.store.update(f.record.id, (record) => {
        if (changed === "owner") record.dshSessionId = "replacement-review-owner";
        if (changed === "reviewAttempt") record.reviewAttempt = (record.reviewAttempt ?? 0) + 1;
        if (changed === "baselineFingerprint") {
          record.latestReviewEvidence = { ...record.latestReviewEvidence!, fingerprint: "replacement-review-baseline" };
        }
        record.lastProgressMessage = "REPLACEMENT-REVIEW-PROGRESS-SENTINEL";
        record.lastProgressAt = "2026-10-05T00:00:00.000Z";
      });
      const replacement = await f.store.load(f.record.id);
      assert.ok(replacement);
      scan.release();
      await settled;
      const current = await f.assertNoVerdict();
      assert.equal(current.dshSessionId, replacement.dshSessionId);
      assert.equal(current.reviewAttempt, replacement.reviewAttempt);
      assert.equal(current.latestReviewEvidence?.fingerprint, replacement.latestReviewEvidence?.fingerprint);
      assert.equal(current.lastProgressMessage, replacement.lastProgressMessage, "old cleanup notes cannot append to another admitted review");
      assert.equal(current.lastProgressAt, replacement.lastProgressAt, "old cleanup cannot refresh another review's heartbeat");
      f.assertCleanup();
    } finally { scan.release(); await f.close(); }
  });
}

for (const stage of ["native", "conversion", "alignment"] as const) {
  for (const verdict of ["pass", "changes_requested"] as const) {
    test(`workspace changes during ${stage} invalidate the foreground ${verdict} verdict before publication`, async () => {
      const f = await fixture(verdict, stage);
      try {
        const before = await f.evidence();
        const pending = f.review();
        const settled = Promise.allSettled([pending]);
        await f.hold.started;
        await f.change();
        const changed = await f.evidence();
        assert.notEqual(changed.fingerprint, before.fingerprint);
        f.hold.release();
        await settled;
        const rejected = await f.assertNoVerdict();
        assert.equal(rejected.phase, "executing", "The same workflow remains available for an explicit fresh review");
        assert.match(rejected.error ?? "", /workspace.*changed|evidence.*(?:stale|mismatch)|stale.*evidence/i);
        f.assertCleanup();
      } finally { await f.close(); }
    });
  }
}

for (const verdict of ["pass", "changes_requested"] as const) {
  test(`unchanged foreground evidence still applies a normal ${verdict} verdict`, async () => {
    const f = await fixture(verdict);
    try {
      const before = await f.evidence();
      const completed = await f.review();
      assert.equal(completed.phase, verdict === "pass" ? "passed" : "fixing");
      assert.equal(completed.latestReview?.verdict, verdict);
      assert.equal(completed.reviewCycles, 1);
      assert.equal(completed.latestReviewEvidence?.fingerprint, before.fingerprint);
      if (verdict === "changes_requested") assert.match(JSON.stringify(f.deferred), /STALE-FINDING-SENTINEL/);
      f.assertCleanup();
    } finally { await f.close(); }
  });
}

test("an explicit fresh foreground review succeeds after the obsolete workspace verdict was rejected", async () => {
  const f = await fixture("changes_requested", "alignment");
  try {
    const pending = f.review();
    const settled = Promise.allSettled([pending]);
    await f.hold.started;
    await f.change();
    f.hold.release();
    await settled;
    await f.assertNoVerdict();
    f.setVerdict("pass");
    const currentEvidence = await f.evidence();
    const fresh = await f.review();
    assert.equal(fresh.id, f.record.id);
    assert.equal(fresh.phase, "passed");
    assert.equal(fresh.latestReview?.verdict, "pass");
    assert.equal(fresh.reviewCycles, 1, "Only the new evidence's applied verdict counts as a review cycle");
    assert.equal(fresh.latestReviewEvidence?.fingerprint, currentEvidence.fingerprint);
    assert.equal(fresh.error, undefined);
    assert.equal(f.visibleThreads.length, 2, "The explicit fresh business review receives a new Reviewer");
    f.assertCleanup(2);
  } finally { await f.close(); }
});

for (const action of ["cancel", "stop", "owner", "reviewAttempt", "baselineFingerprint"] as const) {
  test(`${action} during the final foreground evidence scan cannot apply a late verdict`, async () => {
    const f = await fixture("changes_requested");
    const scan = f.pauseFinalScan();
    try {
      const reviewing = f.review();
      const settled = Promise.allSettled([reviewing]);
      await scan.enteredBefore(reviewing);
      assert.equal(scan.evidence?.insufficient, false);
      assert.equal(typeof scan.evidence?.fingerprint, "string");
      assert.deepEqual(scan.options, { cwd: f.directory, maxDiffBytes: 65536, changedFiles: ["changed.txt"] });
      assert.equal(f.calls.at(-1)?.stage, "alignment", "The read-only scan must follow the actual alignment operation");
      const baseline = await f.store.load(f.record.id);
      assert.ok(baseline);
      let stopping: Promise<void> | undefined;
      let stopSettled = false;
      if (action === "cancel") await f.manager.cancel(f.record.id, f.exec);
      if (action === "stop") {
        stopping = f.manager.stop().then(() => { stopSettled = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(stopSettled, false, "Stop must wait for the current read-only scan and foreground finalizer");
      }
      if (action === "owner") await f.store.update(f.record.id, (record) => { record.dshSessionId = "new-owner"; });
      if (action === "reviewAttempt") await f.store.update(f.record.id, (record) => {
        record.reviewAttempt = (record.reviewAttempt ?? 0) + 1;
      });
      if (action === "baselineFingerprint") await f.store.update(f.record.id, (record) => {
        record.latestReviewEvidence = { ...record.latestReviewEvidence!, fingerprint: "another-admitted-evidence" };
      });
      scan.release();
      const outcome = (await settled)[0]!;
      if (stopping) await stopping;
      const current = await f.assertNoVerdict();
      if (action === "cancel") assert.equal(current.phase, "cancelled");
      if (action === "stop") assert.equal(stopSettled, true);
      if (action === "owner") {
        assert.equal(current.dshSessionId, "new-owner");
        assert.equal(outcome.status, "rejected");
        if (outcome.status === "rejected") assert.match(String(outcome.reason), /another DSH session|owner|authority/i);
      }
      if (action === "reviewAttempt") assert.equal(current.reviewAttempt, (baseline.reviewAttempt ?? 0) + 1);
      if (action === "baselineFingerprint") assert.equal(current.latestReviewEvidence?.fingerprint, "another-admitted-evidence");
      f.assertCleanup();
      const after = await f.store.load(f.record.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(await f.store.load(f.record.id), after, "No late finalizer may apply the rejected verdict");
    } finally { scan.release(); await f.close(); }
  });
}

test("a rejected final evidence read retains completed review output and resumes without another model", async () => {
  const f = await fixture("changes_requested");
  try {
    f.replaceFinalReader(async () => { throw new Error("FINAL-EVIDENCE-READ-SENTINEL: storage unavailable"); });
    await Promise.allSettled([f.review()]);
    const current = await f.assertNoVerdict();
    assert.equal(current.phase, "executing");
    assert.equal(current.processState, "waiting");
    assert.equal(current.retryState?.reviewCheckpoint?.nextStep, "finalizing");
    assert.match(current.error ?? "", /FINAL-EVIDENCE-READ-SENTINEL/);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.disposals, 0, "The original child remains owned while final evidence is unavailable");
    assert.equal(f.released.filter((id) => id === f.visibleThreads[0]).length, 0);
    const calls = structuredClone(f.calls);
    f.replaceFinalReader((options) => collectEvidence(options));
    const resumed = await f.manager.resume(current.id, undefined, f.exec);
    assert.equal(resumed.phase, "fixing");
    assert.equal(resumed.reviewCycles, 1);
    assert.equal(resumed.latestReview?.verdict, "changes_requested");
    assert.deepEqual(f.calls, calls, "A recovered evidence reader accepts the cached verdict without any new model turn");
    f.assertCleanup();
  } finally { await f.close(); }
});

for (const insufficient of ["original", "final"] as const) {
  test(`insufficient ${insufficient} evidence refuses a foreground verdict even when the model returns pass`, async () => {
    const f = await fixture("pass", insufficient === "final" ? "alignment" : undefined);
    try {
      if (insufficient === "original") f.input.changedFiles = ["missing.txt"];
      const observed = await f.evidence();
      assert.equal(observed.insufficient, insufficient === "original");
      const pending = f.review();
      const settled = Promise.allSettled([pending]);
      if (insufficient === "final") {
        await f.hold.started;
        await rm(join(f.directory, "changed.txt"));
        assert.equal((await f.evidence()).insufficient, true, "The real final file scope is now missing");
        f.hold.release();
      }
      await settled;
      const current = await f.assertNoVerdict();
      assert.equal(current.phase, "executing");
      assert.match(current.error ?? "", /insufficient|unverifiable|evidence.*unavailable/i);
      if (insufficient === "final") {
        assert.equal(current.processState, "waiting");
        assert.equal(current.retryState?.reviewCheckpoint?.nextStep, "finalizing");
        assert.equal(f.children[0]!.disposals, 0);
        assert.equal(f.released.filter((id) => id === f.visibleThreads[0]).length, 0);
        const calls = structuredClone(f.calls);
        await writeFile(join(f.directory, "changed.txt"), "v1", "utf8");
        assert.equal((await f.evidence()).fingerprint, observed.fingerprint, "Restore the exact original evidence, not a new implementation");
        const resumed = await f.manager.resume(current.id, undefined, f.exec);
        assert.equal(resumed.phase, "passed");
        assert.equal(resumed.reviewCycles, 1);
        assert.equal(resumed.latestReview?.verdict, "pass");
        assert.deepEqual(f.calls, calls, "Restored final evidence cannot repeat completed review, conversion or alignment");
      }
      f.assertCleanup();
    } finally { await f.close(); }
  });
}

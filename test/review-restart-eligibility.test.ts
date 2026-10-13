import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { ReviewExecutionContext } from "../src/application/review-execution.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewEvidence, TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-review-restart-"));
  await writeFile(join(directory, "changed.txt"), "v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const children: Array<{ id: string; disposals: number; finishes: string[] }> = [];
  const reviewerThreads: string[] = [];
  const released: string[] = [];
  const privateThreads: string[] = [];
  let modelCalls = 0;
  let pins = 0;
  let pinReleases = 0;
  let pinStarts = 0;
  let oldReleasePause: { entered(): void; hold: Promise<void> } | undefined;
  const visible = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Requirements verified.";
  const run = async (threadId: string, options: { onStarted?: (value: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<TurnWaitResult> => {
    const turnId = `review-turn-${++modelCalls}`;
    await options.onStarted?.({ threadId, turnId });
    return modelCalls <= 2 ? { kind: "completed", status: "failed", threadId, turnId, text: "", reason: "turn failed" }
      : { kind: "completed", status: "completed", threadId, turnId, text: visible };
  };
  const gateway: CodexGateway = {
    async startThread() {
      const id = `private-alignment-${privateThreads.length + 1}`;
      privateThreads.push(id);
      return id;
    },
    async startReviewerThread() {
      const id = `reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id);
      return id;
    },
    async resumeThread() {},
    startTurn: run,
    async startReview(options) { return { threadId: options.threadId, result: await run(options.threadId, options) }; },
    async normalizeInFork(options) { return { kind: "completed", status: "completed", threadId: options.threadId,
      turnId: "private-conversion", text: JSON.stringify(options.prompt.includes("REVIEW AUTHORITY checker")
        ? { aligned: true, conflicts: [] } : { verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified" }) }; },
    async continueTurn() { throw new Error("Unexpected clarification"); },
    async interrupt() {},
    async unsubscribeThread(threadId) {
      if (threadId === "reviewer-1" && oldReleasePause) { oldReleasePause.entered(); await oldReleasePause.hold; }
      released.push(threadId);
    },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; pinStarts += 1; },
    endRound() { pins -= 1; pinReleases += 1; },
  };
  const childFactory = { async create() {
    const child = { id: `child-${children.length + 1}`, disposals: 0, finishes: [] as string[] };
    children.push(child);
    return { id: child.id, session: Session.create(SessionId(child.id), [], {
      version: SESSION_FORMAT_VERSION, id: SessionId(child.id), createdAt: Date.now(), cwd: directory, isSeeded: false,
    }), beginContinuation() {}, failAttempt() {}, progress() {},
    finish(text) { child.finishes.push(text); }, async dispose() { child.disposals += 1; } } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 200,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  const exec = { agent: { id: "owner", session: { header: { cwd: directory }, append() {} } },
    signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  const input = { implementationSummary: "Implemented v1", changedFiles: ["changed.txt"] };
  const waiting = () => manager.reviewOnly({ task: "Review the health implementation", ...input }, exec);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const pausePreparation = () => {
    const context = (manager as unknown as { reviewExecution: { ctx: ReviewExecutionContext } }).reviewExecution.ctx;
    const original = context.owned;
    let calls = 0;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    context.owned = async (...args) => {
      if (++calls === 2) { enter(); await hold; }
      return original(...args);
    };
    return { entered, release, restore() { context.owned = original; } };
  };
  const pauseOldRelease = () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    oldReleasePause = { entered: enter, hold };
    return { entered, release, restore() { oldReleasePause = undefined; } };
  };
  return { directory, store, manager, exec, input, waiting, children, reviewerThreads, released, runtime, pausePreparation, pauseOldRelease,
    get modelCalls() { return modelCalls; }, get pins() { return pins; }, get pinReleases() { return pinReleases; },
    get pinStarts() { return pinStarts; }, privateThreads,
    async close() { await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const changedInput of [false, true]) {
  test(`explicit review after workspace changes starts one fresh Reviewer with ${changedInput ? "updated" : "identical"} input`, async () => {
    const f = await fixture();
    try {
      const waiting = await f.waiting();
      assert.equal(waiting.processState, "waiting");
      await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
      assert.deepEqual((await f.manager.status(waiting.id, f.exec)).continuation, { available: false, reason: "workspace_changed" });
      const input = changedInput ? { ...f.input, implementationSummary: "Implemented v2", testResults: "Verified v2" } : f.input;
      const result = await f.manager.review(waiting.id, input, f.exec);
      assert.equal(result.id, waiting.id);
      assert.equal((await f.store.list()).length, 1);
      assert.equal(result.phase, "passed");
      assert.equal(result.reviewCycles, 1, "the failed original review did not consume a business cycle");
      assert.equal(result.retryState, undefined);
      assert.equal(result.error, undefined);
      assert.deepEqual(f.reviewerThreads, ["reviewer-1", "reviewer-2"]);
      assert.equal(f.children.length, 2);
      assert.equal(f.children[0]!.disposals, 1);
      assert.ok(f.children[0]!.finishes.some((text) => /workspace|工作区/i.test(text)), "the old child explains why its review ended");
      assert.equal(f.released.filter((threadId) => threadId === "reviewer-1").length, 1);
      assert.equal(f.modelCalls, 3, "only one fresh business review is sent after the two failed original turns");
      assert.equal(f.pins, 0);
      assert.equal(f.privateThreads.length, 1);
      assert.equal(f.pinStarts, 2 + f.privateThreads.length);
      assert.equal(f.pinReleases, 2 + f.privateThreads.length, "two business rounds and the private seed each release once");
      for (const threadId of f.privateThreads) assert.equal(f.released.filter((id) => id === threadId).length, 1);
    } finally { await f.close(); }
  });
}

test("unchanged workspace with different review input keeps the original recovery handle", async () => {
  const f = await fixture();
  try {
    const waiting = await f.waiting();
    const recovery = f.runtime.recoverableRuns.get(waiting.id);
    await assert.rejects(f.manager.review(waiting.id, { ...f.input, implementationSummary: "Different instructions" }, f.exec), /waiting Reviewer with different input/);
    assert.equal(f.runtime.recoverableRuns.get(waiting.id), recovery);
    assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
    assert.equal(f.children[0]!.disposals, 0);
    assert.equal(f.pins, 1);
    assert.equal(f.modelCalls, 2);
  } finally { await f.close(); }
});

test("explicit resume after workspace changes still refuses a replacement Reviewer", async () => {
  const f = await fixture();
  try {
    const waiting = await f.waiting();
    await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
    await assert.rejects(f.manager.resume(waiting.id, "Continue original", f.exec), /workspace changed/);
    assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
    assert.equal(f.children.length, 1);
    assert.equal(f.modelCalls, 2);
  } finally { await f.close(); }
});

for (const race of ["cancel", "stop", "resume", "replace", "owner"] as const) {
  test(`changed-workspace preparation rechecks ${race} before claiming the old Reviewer`, async () => {
    const f = await fixture();
    let pause: ReturnType<typeof f.pausePreparation> | undefined;
    try {
      const waiting = await f.waiting();
      const old = f.runtime.recoverableRuns.get(waiting.id)!;
      await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
      pause = f.pausePreparation();
      const pending = f.manager.review(waiting.id, f.input, f.exec);
      const settled = Promise.allSettled([pending]);
      await pause.entered;
      let stopped: Promise<void> | undefined;
      if (race === "cancel") await f.manager.cancel(waiting.id, f.exec);
      if (race === "stop") stopped = f.manager.stop();
      if (race === "resume") f.runtime.resumeFlights.set(waiting.id, Promise.resolve(waiting));
      if (race === "replace") f.runtime.recoverableRuns.set(waiting.id, { ...old });
      if (race === "owner") await f.store.update(waiting.id, (record) => { record.dshSessionId = "new-owner"; });
      pause.release();
      const outcome = (await settled)[0]!;
      if (race === "cancel") {
        assert.equal(outcome.status, "fulfilled");
        if (outcome.status === "fulfilled") assert.equal(outcome.value.phase, "cancelled");
        assert.equal(f.children[0]!.disposals, 1);
        assert.equal(f.pinReleases, 1);
      } else if (race === "stop") {
        await stopped;
        assert.equal(outcome.status, "rejected");
        assert.equal(f.children[0]!.disposals, 1);
        assert.equal(f.pinReleases, 1);
        assert.equal(f.pins, 0);
      } else {
        assert.equal(outcome.status, "rejected");
        if (outcome.status === "rejected") assert.match(String(outcome.reason), race === "owner" ? /another DSH session/ : /recovery owner/);
        assert.equal(f.children[0]!.disposals, 0);
        assert.equal(f.pins, 1);
        assert.equal(f.runtime.recoverableRuns.has(waiting.id), true);
      }
      assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
      assert.equal(f.modelCalls, 2);
    } finally { pause?.release(); pause?.restore(); await f.close(); }
  });
}

for (const absent of ["evidence", "fingerprint"] as const) {
  test(`missing original ${absent} cannot authorize a new review round or release its waiting handle`, async () => {
    const f = await fixture();
    try {
      const waiting = await f.waiting();
      const recovery = f.runtime.recoverableRuns.get(waiting.id)!;
      const unknown = { ...recovery, evidence: absent === "evidence" ? undefined
        : { ...recovery.evidence, fingerprint: undefined } as unknown as ReviewEvidence };
      f.runtime.recoverableRuns.set(waiting.id, unknown);
      await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
      await assert.rejects(f.manager.review(waiting.id, { ...f.input, implementationSummary: "Updated instructions" }, f.exec), /waiting Reviewer with different input/);
      assert.equal(f.runtime.recoverableRuns.get(waiting.id), unknown);
      assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
      assert.equal(f.children.length, 1);
      assert.equal(f.children[0]!.disposals, 0);
      assert.deepEqual(f.released, []);
      assert.equal(f.pins, 1);
      assert.equal(f.modelCalls, 2);
    } finally { await f.close(); }
  });
}

test("ownership changes during old Reviewer cleanup cannot authorize a fresh model turn", async () => {
  const f = await fixture();
  let pause: ReturnType<typeof f.pauseOldRelease> | undefined;
  try {
    const waiting = await f.waiting();
    await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
    pause = f.pauseOldRelease();
    const pending = f.manager.review(waiting.id, f.input, f.exec);
    const settled = Promise.allSettled([pending]);
    await pause.entered;
    await f.store.update(waiting.id, (record) => { record.dshSessionId = "new-owner"; });
    pause.release();
    const outcome = (await settled)[0]!;
    assert.equal(outcome.status, "rejected", "the preparation snapshot was captured before cleanup and cannot authorize another owner's work");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /another DSH session/);
    assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.disposals, 1);
    assert.equal(f.modelCalls, 2);
    assert.equal(f.pins, 0);
    assert.equal((await f.store.load(waiting.id))?.dshSessionId, "new-owner");
  } finally { pause?.release(); pause?.restore(); await f.close(); }
});

test("approved plan changes during old Reviewer cleanup cannot authorize a fresh model turn", async () => {
  const f = await fixture();
  let pause: ReturnType<typeof f.pauseOldRelease> | undefined;
  try {
    const waiting = await f.waiting();
    await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
    pause = f.pauseOldRelease();
    const pending = f.manager.review(waiting.id, f.input, f.exec);
    const settled = Promise.allSettled([pending]);
    await pause.entered;
    await f.store.update(waiting.id, (record) => { record.planMarkdown = "# Changed approval\nDo a different implementation."; });
    const row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    pause.release();
    const outcome = (await settled)[0]!;
    assert.equal(outcome.status, "rejected", "New dispatch must use the captured approval, including across old-resource cleanup");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /scope|approval|plan|changed/i);
    assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
    assert.equal(f.children.length, 1);
    assert.equal(f.modelCalls, 2);
    assert.equal(f.pins, 0);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
  } finally { pause?.release(); pause?.restore(); await f.close(); }
});

test("cancel during old Reviewer cleanup remains terminal without a fresh child or thread", async () => {
  const f = await fixture();
  let pause: ReturnType<typeof f.pauseOldRelease> | undefined;
  try {
    const waiting = await f.waiting();
    await writeFile(join(f.directory, "changed.txt"), "v2", "utf8");
    pause = f.pauseOldRelease();
    const pending = f.manager.review(waiting.id, f.input, f.exec);
    const settled = Promise.allSettled([pending]);
    await pause.entered;
    const cancelled = await f.manager.cancel(waiting.id, f.exec);
    assert.equal(cancelled.phase, "cancelled");
    pause.release();
    await settled;
    assert.equal((await f.store.load(waiting.id))?.phase, "cancelled");
    assert.deepEqual(f.reviewerThreads, ["reviewer-1"]);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.disposals, 1);
    assert.equal(f.modelCalls, 2);
    assert.equal(f.pins, 0);
  } finally { pause?.release(); pause?.restore(); await f.close(); }
});

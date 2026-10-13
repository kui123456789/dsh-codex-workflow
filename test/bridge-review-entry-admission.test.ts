import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";
import { settleWorkflowBackground } from "./fixtures/workflow-background-settlement.js";

const PLAN = "<proposed_plan>\n# Goal\nImplement read-only local configuration diagnostics.\n# Changes\n- Add configuration validation with explicit unavailable-storage handling.\n- Preserve current storage and user settings.\n# Verification\n- Verify valid, missing and invalid inputs through an isolated diagnostic fixture.\n# Risks\n- Never initialize or mutate an existing database during inspection.\n</proposed_plan>";
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved implementation requirements are verified.";
const VERDICT = { verdict: "pass" as const, findings: [], testGaps: [], summary: "Approved implementation verified" };

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture(failBackground = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-entry-admission-"));
  await writeFile(join(directory, "changed.txt"), "read-only diagnostic implementation v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const background = gate();
  const reviewerThreads: string[] = [];
  const foregroundTurns: string[] = [];
  const backgroundTurns: string[] = [];
  const children: Array<{ id: string; disposals: number }> = [];
  const commands: BridgeCommand[] = [];
  const deferred: unknown[] = [];
  let otherThreads = 0;
  let turns = 0;
  let pins = 0;
  const gateway: CodexGateway = {
    async startThread(options) { return options.name?.startsWith("DSH Plan") ? `planner-${++otherThreads}` : `private-alignment-${++otherThreads}`; },
    async startReviewerThread() {
      const id = `reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id);
      return id;
    },
    async resumeThread() {},
    async startTurn(threadId, options): Promise<TurnWaitResult> {
      const turnId = `turn-${++turns}`;
      await options.onStarted?.({ threadId, turnId });
      if (options.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
      if (threadId.startsWith("planner-")) return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
      backgroundTurns.push(threadId);
      if (backgroundTurns.length === 1) { background.enter(); await background.promise; }
      if (failBackground && backgroundTurns.length <= 2) return { kind: "completed", threadId, turnId,
        status: "failed", text: "", reason: "turn failed" };
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async startReview(options) {
      foregroundTurns.push(options.threadId);
      const turnId = `foreground-${foregroundTurns.length}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId, turnId,
        status: "completed", text: REVIEW } };
    },
    async normalizeInFork(options) {
      const schema = options.outputSchema.properties as Record<string, unknown>;
      const value = schema.aligned ? { aligned: true, conflicts: [] }
        : schema.status ? { status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] } : VERDICT;
      return { kind: "completed", threadId: options.threadId, turnId: "private-conversion", status: "completed", text: JSON.stringify(value) };
    },
    async continueTurn() { throw new Error("Clarification is outside this entry audit"); },
    async resolveDefaultModel() { return "model-A"; },
    async interrupt() {}, async unsubscribeThread() {},
    isThreadAvailable: () => true,
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const owner = SessionId("bridge-entry-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const parent = { id: owner, session } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext;
  const childFactory = { async create() {
    const child = { id: `child-${children.length + 1}`, disposals: 0 };
    children.push(child);
    return { id: child.id, session, beginContinuation() {}, failAttempt() {}, pauseForInput() {}, progress() {}, finish() {},
      async dispose() { child.disposals += 1; } } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {}, undefined, childFactory);
  const input = { implementationSummary: "Read-only configuration diagnostic implemented", changedFiles: ["changed.txt"], testResults: "Verified local fixture" };
  const waitRecord = async (id: string, predicate: (record: WorkflowRecord) => boolean) => {
    // Final rows only. The intentionally held `sending` case below observes
    // background.entered and loads its row directly before releasing its gate.
    await settleWorkflowBackground(manager, config, id);
    const current = await store.load(id);
    assert.ok(current);
    assert.equal(predicate(current), true, `Original callback settled in an unexpected state: ${current.submissionState}`);
    return current;
  };
  const bridge = () => manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
    task: "Implement and review local configuration diagnostics", planMarkdown: PLAN, assumptions: [] }, parent);
  return { directory, store, manager, exec, session, callback, background, reviewerThreads, foregroundTurns, backgroundTurns,
    children, commands, deferred, input, waitRecord, bridge,
    get pins() { return pins; },
    async close() { background.release(); await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const stage of ["sending", "retrying", "received"] as const) {
  test(`Bridge ${stage} submission rejects foreground review instead of creating another Reviewer`, async () => {
    const f = await fixture(stage === "retrying");
    try {
      const bridge = await f.bridge();
      const submitted = await f.manager.submit(bridge.id, f.input, f.exec);
      await f.background.entered;
      if (stage !== "sending") f.background.release();
      const current = stage === "sending" ? (await f.store.load(bridge.id))!
        : await f.waitRecord(bridge.id, (record) => record.submissionState === stage && !record.submissionLeaseToken);
      assert.equal(current.origin, "codex_bridge");
      assert.equal(current.submissionState, stage);
      assert.equal(current.submissionId, submitted.submissionId);
      assert.equal(current.reviewCycles, 0);
      const originalThread = f.reviewerThreads[0];
      const originalChild = f.children[0];
      assert.ok(originalThread);
      assert.ok(originalChild);
      const backgroundTurnCount = f.backgroundTurns.length;
      const [outcome] = await Promise.allSettled([f.manager.review(bridge.id, f.input, f.exec)]);
      const after = (await f.store.load(bridge.id))!;
      assert.deepEqual({ admission: outcome!.status, foregroundTurns: f.foregroundTurns.length,
        reviewerThreads: f.reviewerThreads.length, children: f.children.length, cycles: after.reviewCycles }, {
        admission: "rejected", foregroundTurns: 0, reviewerThreads: 1, children: 1, cycles: 0,
      }, "A Bridge submission must retain its existing callback flow and cannot be reviewed through the foreground entry");
      if (outcome!.status === "rejected") assert.match(String(outcome!.reason), /codex_workflow_submit|bridge.*review|foreground|entry/i);
      assert.equal(after.submissionId, submitted.submissionId);
      assert.equal(after.codexThreadId, bridge.codexThreadId);
      assert.equal(after.latestReview, undefined);
      assert.deepEqual(f.deferred, []);
      assert.equal(f.children[0], originalChild);
      assert.deepEqual(f.backgroundTurns, Array(backgroundTurnCount).fill(originalThread));
      if (stage === "retrying") {
        assert.equal(f.callback.availableContinuation(bridge.id), true);
        assert.equal(originalChild.disposals, 0);
        assert.equal(f.pins, 1);
      } else {
        f.background.release();
        const received = await f.waitRecord(bridge.id, (record) => record.submissionState === "received" && !record.submissionLeaseToken);
        assert.equal(received.reviewCycles, 0);
        const verdicts = f.commands.filter((command): command is SubmitVerdictCommand => command.kind === "submit_verdict");
        assert.equal(verdicts.length, 1);
        assert.deepEqual(verdicts[0], received.stagedVerdict?.command);
        assert.equal(verdicts[0]!.submissionId, submitted.submissionId);
        const applied = await f.manager.applyExternalVerdict(verdicts[0]!);
        assert.equal(applied.id, bridge.id);
        assert.equal(applied.phase, "passed");
        assert.equal(applied.reviewCycles, 1, "Only the exact Bridge callback verdict consumes one business cycle");
        assert.equal(f.children.length, 1);
        assert.equal(originalChild.disposals, 1);
        assert.equal(f.pins, 0);
      }
    } finally { await f.close(); }
  });
}

for (const mode of ["planned", "review_only"] as const) {
  test(`ordinary DSH ${mode} still admits its legitimate foreground review`, async () => {
    const f = await fixture();
    try {
      const reviewed = mode === "planned"
        ? await f.manager.review((await f.manager.start({ task: "Implement local configuration diagnostics" }, f.exec)).id, f.input, f.exec)
        : await f.manager.reviewOnly({ task: "Review local configuration diagnostics", ...f.input }, f.exec);
      assert.equal(reviewed.origin, "dsh");
      assert.equal(reviewed.mode, mode);
      assert.equal(reviewed.phase, "passed");
      assert.equal(reviewed.reviewCycles, 1);
      assert.equal(f.foregroundTurns.length, 1);
      assert.equal(f.backgroundTurns.length, 0);
      assert.equal(f.commands.length, 0);
      assert.equal(f.reviewerThreads.length, 1);
      assert.equal(f.pins, 0);
    } finally { await f.close(); }
  });
}

test("a Bridge workflow with no submission must use submit rather than the foreground review entry", async () => {
  const f = await fixture();
  try {
    const bridge = await f.bridge();
    assert.equal(bridge.submissionId, undefined);
    assert.equal(bridge.submissionState, undefined);
    const before = await f.store.load(bridge.id);
    const db = f.store.coordinationHandle.db;
    const leases = db.prepare("SELECT * FROM leases ORDER BY resource").all();
    const writes = db.prepare("SELECT total_changes() AS writes").get();
    await assert.rejects(f.manager.review(bridge.id, f.input, f.exec), /codex_workflow_submit/);
    assert.deepEqual(await f.store.load(bridge.id), before);
    assert.deepEqual(db.prepare("SELECT * FROM leases ORDER BY resource").all(), leases);
    assert.deepEqual(db.prepare("SELECT total_changes() AS writes").get(), writes, "Rejecting the wrong entry must not write or claim any lease row");
    assert.deepEqual(f.reviewerThreads, []);
    assert.deepEqual(f.foregroundTurns, []);
    assert.deepEqual(f.backgroundTurns, []);
    assert.deepEqual(f.children, []);
    assert.equal(f.commands.length, 0);
    const submitted = await f.manager.submit(bridge.id, f.input, f.exec);
    await f.background.entered;
    f.background.release();
    const received = await f.waitRecord(bridge.id, (record) => record.submissionState === "received" && !record.submissionLeaseToken);
    const command = f.commands.find((value): value is SubmitVerdictCommand => value.kind === "submit_verdict");
    assert.ok(command);
    assert.equal(command.submissionId, submitted.submissionId);
    assert.deepEqual(command, received.stagedVerdict?.command);
    assert.equal(received.reviewCycles, 0);
    const applied = await f.manager.applyExternalVerdict(command);
    assert.equal(applied.phase, "passed");
    assert.equal(applied.reviewCycles, 1);
    assert.equal(f.reviewerThreads.length, 1);
    assert.equal(f.foregroundTurns.length, 0);
    assert.equal(f.children.length, 1);
  } finally { await f.close(); }
});

test("foreign-session foreground review is denied before exposing the Bridge route or claiming resources", async () => {
  const f = await fixture();
  try {
    const bridge = await f.bridge();
    const foreignId = SessionId("foreign-entry-owner");
    const foreign = { id: foreignId, session: Session.create(foreignId, [], { version: SESSION_FORMAT_VERSION,
      id: foreignId, createdAt: Date.now(), cwd: f.directory, isSeeded: false }) } as Agent;
    const foreignExec = { agent: foreign, signal: new AbortController().signal,
      deferContext() { throw new Error("The owning workflow must never be disclosed to a foreign session"); } } as unknown as ToolRunContext;
    const before = await f.store.load(bridge.id);
    const db = f.store.coordinationHandle.db;
    const leases = db.prepare("SELECT * FROM leases ORDER BY resource").all();
    const writes = db.prepare("SELECT total_changes() AS writes").get();
    await assert.rejects(f.manager.review(bridge.id, f.input, foreignExec), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "workflow belongs to another DSH session", "Ownership denial must precede route or phase diagnostics");
      return true;
    });
    assert.deepEqual(await f.store.load(bridge.id), before);
    assert.deepEqual(db.prepare("SELECT * FROM leases ORDER BY resource").all(), leases);
    assert.deepEqual(db.prepare("SELECT total_changes() AS writes").get(), writes);
    assert.deepEqual(f.reviewerThreads, []);
    assert.deepEqual(f.foregroundTurns, []);
    assert.deepEqual(f.backgroundTurns, []);
    assert.deepEqual(f.children, []);
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.deferred, []);
  } finally { await f.close(); }
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexAppServerClient } from "../src/app-server.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";
import { settleWorkflowBackground } from "./fixtures/workflow-background-settlement.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ORIGINAL-REVIEW-SENTINEL: the approved local diagnostic is verified.";
const VERDICT = { verdict: "pass" as const, findings: [], testGaps: [], summary: "The approved local diagnostic is verified" };

async function fixture(alignmentFailures: number) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-review-checkpoint-"));
  await writeFile(join(directory, "changed.txt"), "verified read-only health diagnostic v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const reviewerThreads: string[] = [];
  const visibleCalls: Array<{ threadId: string; prompt: string }> = [];
  const alignmentCalls: string[] = [];
  const children: Session[] = [];
  const disposed: string[] = [];
  const released: string[] = [];
  const commands: BridgeCommand[] = [];
  let pins = 0;
  let privateThreads = 0;
  let turns = 0;
  const gateway: CodexGateway = {
    async startThread() { return `alignment-${++privateThreads}`; },
    async startReviewerThread() {
      const id = `original-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id);
      return id;
    },
    async resumeThread() { throw new Error("Completed callbacks must not resume or replace their original Reviewer"); },
    async startTurn(threadId, options) {
      const turnId = `turn-${++turns}`;
      await options.onStarted?.({ threadId, turnId });
      if (options.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
      visibleCalls.push({ threadId, prompt: options.prompt });
      options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async normalizeInFork(options) {
      alignmentCalls.push(options.threadId);
      await options.onStarted?.({ threadId: options.threadId, turnId: `alignment-${alignmentCalls.length}` });
      if (alignmentCalls.length <= alignmentFailures) return { kind: "completed", threadId: options.threadId,
        turnId: `alignment-${alignmentCalls.length}`, status: "failed", text: "", reason: "ALIGNMENT-FAILED-SENTINEL: schema checker denied this run" };
      return { kind: "completed", threadId: options.threadId, turnId: `alignment-${alignmentCalls.length}`,
        status: "completed", text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async startReview(): Promise<never> { throw new Error("Bridge review must stay in its original callback flow"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this review checkpoint"); },
    async resolveDefaultModel() { return "model-A"; },
    async interrupt() {},
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const owner = SessionId("bridge-checkpoint-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  let provider: SubagentProvider;
  const childFactory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    children.push(session);
    return { agent: { id: session.id, session } as Agent, async dispose() { disposed.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {}, { get: (id) => id === parent.id ? parent : undefined }, childFactory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const input = { implementationSummary: "Read-only diagnostic implemented", changedFiles: ["changed.txt"], testResults: "Verified v1 fixture" };
  const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
    task: "Implement and review read-only local configuration diagnostics", planMarkdown: "<proposed_plan>\nImplement read-only health adapters and verify valid, missing and invalid local configuration.\n</proposed_plan>", assumptions: [] }, parent);
  const waitRecord = async (predicate: (value: WorkflowRecord) => boolean, storage = store, taskOwner = manager) => {
    await settleWorkflowBackground(taskOwner, config, record.id);
    const current = await storage.load(record.id);
    assert.ok(current);
    assert.equal(predicate(current), true, `The original background task settled in an unexpected state: ${current.submissionState}`);
    assert.equal(current.submissionLeaseToken, undefined, "The original callback finalizer must release its lease");
    return current;
  };
  return { manager, store, callback, exec, record, input, waitRecord, reviewerThreads, visibleCalls, alignmentCalls, children, runtime,
    gateway, config, childFactory, parent,
    disposed, released, commands,
    get pins() { return pins; },
    async retry() {
      // Change only the persisted scheduling clock; ownership, original input,
      // workspace evidence and submission identity remain exactly the same.
      await store.update(record.id, (value) => { value.submissionRetryAt = 0; });
      return manager.recoverCallbacks();
    },
    async close() {
      await manager.stop(); childFactory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Bridge authority retry checkpoints the completed callback instead of repeating its readable review", async () => {
  const f = await fixture(1);
  try {
    const submitted = await f.manager.submit(f.record.id, f.input, f.exec);
    const waiting = await f.waitRecord((record) => record.submissionState === "retrying");
    assert.match(waiting.submissionError ?? "", /ALIGNMENT-FAILED-SENTINEL/);
    assert.equal(waiting.submissionId, submitted.submissionId);
    assert.equal(waiting.reviewCycles, 0);
    assert.equal(waiting.latestReview, undefined);
    const firstEnd = f.parent.session.snapshotEvents().filter((event) => event.type === "dsh-codex-workflow/review-end").at(-1);
    assert.ok(firstEnd, "The real owning parent Session received the validation failure event");
    assert.equal(firstEnd.data.verdict, undefined, "A completed callback has not yet passed authority validation");
    assert.equal(firstEnd.data.result, undefined, "The sidebar must not publish an unvalidated checkpoint as the business review");
    assert.match(firstEnd.data.visibleText ?? "", /ORIGINAL-REVIEW-SENTINEL/, "The readable diagnostic remains available without a verdict");
    assert.equal(f.visibleCalls.length, 1);
    assert.equal(f.callback.availableContinuation(f.record.id), false, "The original callback model really completed and released its own handle");
    const originalChild = f.children[0]!;
    const childDisposedBeforeRetry = f.disposed.includes(originalChild.id);
    const childRetainedBeforeRetry = f.runtime.codexChildSessions.get(f.record.id)?.id === originalChild.id;
    const evidence = waiting.latestReviewEvidence;
    assert.ok(evidence?.fingerprint);
    assert.equal(await f.retry(), 1);
    const received = await f.waitRecord((record) => record.submissionState === "received");
    assert.deepEqual({ readableReviewerCalls: f.visibleCalls.length, reviewerThreads: f.reviewerThreads.length,
      childIds: f.children.map((child) => child.id), childDisposedBeforeRetry, childRetainedBeforeRetry }, {
      readableReviewerCalls: 1, reviewerThreads: 1, childIds: [originalChild.id], childDisposedBeforeRetry: false, childRetainedBeforeRetry: true,
    }, "Authority recovery must reuse the already completed review and native child rather than spend another visible model turn");
    assert.equal(f.alignmentCalls.length, 2, "Only the failed authority check is rerun");
    assert.equal(received.submissionId, submitted.submissionId);
    assert.deepEqual(received.pendingReviewRequest, f.input);
    assert.deepEqual(received.latestReviewEvidence, evidence);
    assert.equal(received.reviewCycles, 0);
    const verdicts = f.commands.filter((command): command is SubmitVerdictCommand => command.kind === "submit_verdict");
    assert.equal(verdicts.length, 1);
    assert.deepEqual(verdicts[0], received.stagedVerdict?.command);
    assert.equal(verdicts[0]!.submissionId, submitted.submissionId);
    assert.equal(verdicts[0]!.workflowId, f.record.id);
    assert.equal(verdicts[0]!.codexThreadId, f.record.codexThreadId);
    const applied = await f.manager.applyExternalVerdict(verdicts[0]!);
    assert.equal(applied.phase, "passed");
    assert.equal(applied.reviewCycles, 1);
    assert.equal((await f.manager.applyExternalVerdict(verdicts[0]!)).reviewCycles, 1, "Exact staged replay does not consume another cycle");
    assert.deepEqual(f.disposed, [originalChild.id]);
    assert.equal(f.released.filter((id) => id === f.reviewerThreads[0]).length, 1);
    assert.equal(f.pins, 0);
  } finally { await f.close(); }
});

test("Bridge review without an authority failure still stages its original callback verdict once", async () => {
  const f = await fixture(0);
  try {
    const submitted = await f.manager.submit(f.record.id, f.input, f.exec);
    const received = await f.waitRecord((record) => record.submissionState === "received");
    assert.equal(f.visibleCalls.length, 1);
    assert.equal(f.reviewerThreads.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.alignmentCalls.length, 1);
    assert.equal(received.submissionId, submitted.submissionId);
    assert.equal(received.reviewCycles, 0);
    const command = f.commands.find((value): value is SubmitVerdictCommand => value.kind === "submit_verdict");
    assert.ok(command);
    assert.deepEqual(command, received.stagedVerdict?.command);
    assert.equal((await f.manager.applyExternalVerdict(command)).reviewCycles, 1);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.pins, 0);
  } finally { await f.close(); }
});

test("Bridge checkpoint marker survives SQLite reopen but a new manager cannot silently repeat the completed Reviewer", async () => {
  const f = await fixture(1);
  let reopened: WorkflowStore | undefined;
  let restarted: WorkflowManager | undefined;
  try {
    const submitted = await f.manager.submit(f.record.id, f.input, f.exec);
    const waiting = await f.waitRecord((record) => record.submissionState === "retrying");
    assert.equal(waiting.submissionReviewPending, true);
    const originalChild = f.children[0]!;
    assert.equal(f.runtime.submissionReviewResults.size, 1);
    assert.deepEqual(f.disposed, []);
    await f.manager.stop();
    assert.equal(f.runtime.submissionReviewResults.size, 0);
    assert.deepEqual(f.disposed, [originalChild.id]);
    const raw = f.store.coordinationHandle.loadWorkflow(f.record.id);
    assert.ok(raw);
    const envelope = JSON.parse(raw.recordJson) as { schemaVersion: number; submission: { submissionReviewPending?: boolean } };
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.submission.submissionReviewPending, true);
    const storage = f.store.directory;
    f.store.close();
    reopened = new WorkflowStore(storage);
    const restored = await reopened.load(f.record.id);
    assert.ok(restored);
    assert.equal(restored.submissionReviewPending, true, "The durable marker cannot be erased by losing its process-local result");
    assert.equal(restored.submissionId, submitted.submissionId);
    assert.deepEqual(restored.pendingReviewRequest, waiting.pendingReviewRequest);
    assert.deepEqual(restored.latestReviewEvidence, waiting.latestReviewEvidence);
    const freshCallback = new AppServerCodexCallbackDispatcher(f.gateway as unknown as CodexAppServerClient, {
      policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
    });
    restarted = new WorkflowManager(reopened, f.gateway, f.config, freshCallback, { async enqueue(command) {
      f.commands.push(command); return command.requestId;
    } }, undefined, {}, { get: (id) => id === f.parent.id ? f.parent : undefined }, f.childFactory);
    await reopened.update(f.record.id, (record) => { record.submissionRetryAt = 0; });
    assert.equal(await restarted.recoverCallbacks(), 1);
    const rejected = await f.waitRecord((record) => record.submissionState === "failed", reopened, restarted);
    assert.match(rejected.submissionError ?? "", /completed Reviewer result is unavailable.*refusing to repeat/i);
    assert.equal(rejected.submissionId, submitted.submissionId);
    assert.equal(rejected.reviewCycles, 0);
    assert.equal(rejected.latestReview, undefined);
    assert.equal(f.visibleCalls.length, 1, "A persisted pending marker is not permission for another callback");
    assert.equal(f.reviewerThreads.length, 1);
    assert.equal(f.alignmentCalls.length, 1);
    assert.deepEqual(f.children.map((child) => child.id), [originalChild.id], "Even a live owning agent cannot silently create a replacement native child");
    assert.deepEqual(f.disposed, [originalChild.id]);
    assert.equal(f.commands.filter((command) => command.kind === "submit_verdict").length, 0);
    assert.equal(f.pins, 0);
  } finally {
    await restarted?.stop(); reopened?.close(); await f.close();
  }
});

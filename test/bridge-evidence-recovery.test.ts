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
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand, type SubmissionNoticeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { collectEvidence } from "../src/evidence.js";
import type { CodexReviewEndEvent } from "../src/review-events.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewEvidence, ReviewInput, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import type { TokenUsageSnapshot } from "../src/usage-accounting.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Read-only diagnostic scope is verified.";
const VERDICT = { verdict: "pass" as const, findings: [], testGaps: [], summary: "Read-only diagnostic scope is verified" };

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { started: new Promise<void>((resolve) => { enter = resolve; }),
    promise: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

async function fixture(mode: "completed" | "held" | "continuation" = "completed") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-evidence-recovery-"));
  const changedFile = join(directory, "changed.txt");
  await writeFile(changedFile, "read-only health diagnostic v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const firstModel = gate();
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const visibleTurns: string[] = [];
  const released: string[] = [];
  const available = new Set<string>();
  const snapshots = new Map<string, TokenUsageSnapshot>();
  const children: Session[] = [];
  const disposed: string[] = [];
  const commands: BridgeCommand[] = [];
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let turnNumber = 0;
  let callbackCalls = 0;
  const gateway: CodexGateway = {
    async startThread() {
      const id = `evidence-validation-${privateThreads.length + 1}`;
      privateThreads.push(id); available.add(id); return id;
    },
    async startReviewerThread() {
      const id = `evidence-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("Evidence recovery must not resume a replacement Reviewer"); },
    async startTurn(threadId, options) {
      assert.ok(available.has(threadId));
      const turnId = `evidence-turn-${++turnNumber}`;
      await options.onStarted?.({ threadId, turnId });
      if (options.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
      visibleTurns.push(threadId);
      const responses = visibleTurns.length;
      const counters = { totalTokens: responses * 18, inputTokens: responses * 11, cachedInputTokens: 0,
        cacheWriteInputTokens: 0, outputTokens: responses * 7, reasoningOutputTokens: 0 };
      snapshots.set(threadId, { threadId, turnId, total: counters, last: { ...counters,
        totalTokens: 18, inputTokens: 11, outputTokens: 7 } });
      if (responses === 1) { firstModel.enter(); if (mode === "held") await firstModel.promise; }
      if (mode === "continuation" && responses <= 2) return { kind: "completed", threadId, turnId,
        status: "failed", text: "", reason: "turn failed" };
      options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async normalizeInFork(options) {
      assert.ok(available.has(options.threadId));
      const turnId = `validation-turn-${++turnNumber}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { kind: "completed", threadId: options.threadId, turnId, status: "completed",
        text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async startReview(): Promise<never> { throw new Error("Bridge recovery cannot start a foreground review"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this evidence fixture"); },
    async resolveDefaultModel() { return "model-A"; },
    async interrupt() {},
    async unsubscribeThread(threadId) {
      released.push(threadId);
      assert.ok(available.delete(threadId), "each owned subscription must be released exactly once");
    },
    isThreadAvailable: (threadId) => available.has(threadId),
    getThreadTokenUsage: (threadId) => snapshots.get(threadId),
    beginRound() { begins += 1; pins += 1; },
    endRound() { ends += 1; pins -= 1; },
  };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const send = callback.send.bind(callback);
  callback.send = async (request, signal) => { callbackCalls += 1; return send(request, signal); };
  const owner = SessionId("bridge-evidence-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
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
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {}, { get: (id) => id === owner ? parent : undefined }, factory);
  const input: ReviewInput = { implementationSummary: "Read-only health command implemented", changedFiles: ["changed.txt"], testResults: "Fixture verified" };
  const waitRecord = async (id: string, predicate: (record: WorkflowRecord) => boolean) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const current = await store.load(id);
      assert.ok(current);
      if (predicate(current) && !current.submissionLeaseToken) return current;
      if (Date.now() > deadline) throw new Error(`Evidence submission did not settle: ${current.submissionState}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const startPlan = () => manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
    task: "Implement and review read-only local health diagnostics", planMarkdown: "<proposed_plan>\nInspect local configuration read-only.\n</proposed_plan>", assumptions: [] }, parent);
  return { directory, changedFile, store, manager, callback, exec, parent, input, commands, children, disposed,
    visibleTurns, reviewerThreads, privateThreads, released, firstModel, startPlan, waitRecord,
    get callbackCalls() { return callbackCalls; }, get pins() { return pins; },
    async persistLegacy(state: "retrying" | "sending", evidence: ReviewEvidence) {
      const now = new Date().toISOString();
      const record: WorkflowRecord = { schemaVersion: 1, id: newRequestId(), dshSessionId: owner, cwd: directory,
        task: "Resume the original diagnostic audit", mode: "planned", phase: "executing", createdAt: now, updatedAt: now,
        assumptions: [], questions: [], reviewCycles: 0, origin: "codex_bridge", codexThreadId: newRequestId(),
        pendingReviewRequest: input, latestReviewEvidence: evidence, submissionId: newRequestId(), submissionState: state,
        submissionAttempts: 1, submissionRetryAt: 0, callbackState: "retrying", processState: "waiting" };
      await store.save(record);
      return record;
    },
    assertCleaned() {
      assert.deepEqual(released, [...reviewerThreads, ...privateThreads]);
      assert.equal(available.size, 0);
      assert.equal(pins, 0);
      assert.equal(begins, reviewerThreads.length + privateThreads.length);
      assert.equal(ends, begins);
    },
    async terminalNotice(id: string) {
      const current = (await store.load(id))!;
      const notice = commands.find((command): command is SubmissionNoticeCommand => command.kind === "submission_notice");
      assert.ok(notice);
      assert.equal(notice.submissionId, current.submissionId);
      assert.deepEqual(notice, current.submissionNotice?.command);
      assert.equal((await manager.commitSubmissionNoticeDelivery(notice)).committed, true);
      assert.equal(await manager.recoverCallbacks(), 0);
      assert.equal(commands.filter((command) => command.kind === "submission_notice").length, 1);
    },
    async close() {
      firstModel.release(); await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("persisted Bridge recovery refuses missing fingerprints or insufficient original evidence before spawning a callback", async () => {
  for (const oldState of ["retrying", "sending"] as const) {
    const f = await fixture();
    try {
      const observed = await collectEvidence({ cwd: f.directory, maxDiffBytes: 65536, changedFiles: f.input.changedFiles });
      const evidence = structuredClone(observed);
      if (oldState === "retrying") delete (evidence as Partial<ReviewEvidence>).fingerprint;
      else evidence.insufficient = true;
      const original = await f.persistLegacy(oldState, evidence);
      assert.equal(await f.manager.recoverCallbacks(), 1);
      const settled = await f.waitRecord(original.id, (record) => record.submissionState === "failed" || record.submissionState === "received");
      assert.equal(f.callbackCalls, 0, "legacy evidence cannot be silently rebuilt to authorize a replacement review");
      assert.deepEqual(f.reviewerThreads, []);
      assert.deepEqual(f.privateThreads, []);
      assert.deepEqual(f.visibleTurns, []);
      assert.deepEqual(f.children, []);
      assert.equal(settled.submissionState, "failed");
      assert.match(settled.submissionError ?? "", /evidence|fingerprint|unavailable|insufficient/i);
      assert.equal(settled.reviewCycles, 0);
      assert.equal(settled.latestReview, undefined);
      assert.equal(settled.stagedVerdict, undefined);
      assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false);
      await f.terminalNotice(original.id);
      f.assertCleaned();
    } finally { await f.close(); }
  }
});

test("Bridge result loses all verdict projection when its original scope disappears after the model starts", async () => {
  const f = await fixture("held");
  try {
    const record = await f.startPlan();
    const submitted = await f.manager.submit(record.id, f.input, f.exec);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([f.firstModel.started, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The original model did not start")), 5000);
    })]); } finally { clearTimeout(timer); }
    await rm(f.changedFile);
    f.firstModel.release();
    const failed = await f.waitRecord(record.id, (current) => current.submissionState === "failed" || current.submissionState === "received");
    assert.equal(failed.submissionId, submitted.submissionId);
    assert.equal(failed.submissionState, "failed");
    assert.match(failed.submissionError ?? "", /workspace|evidence/i);
    assert.equal(failed.reviewCycles, 0);
    assert.equal(failed.latestReview, undefined);
    assert.equal(failed.stagedVerdict, undefined);
    assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false);
    const end = f.parent.session.snapshotEvents().filter((event) => event.type === "dsh-codex-workflow/review-end").at(-1)?.data as CodexReviewEndEvent | undefined;
    assert.ok(end, "the public session receives a terminal review-end event");
    assert.equal(end.verdict, undefined);
    assert.equal(end.result, undefined);
    assert.equal(end.summary, undefined);
    assert.equal(end.processState, "failed");
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    await f.terminalNotice(record.id);
    assert.equal(f.callbackCalls, 1);
    assert.deepEqual(f.visibleTurns, [f.reviewerThreads[0]!]);
    assert.equal(f.children.length, 1);
    f.assertCleaned();
  } finally { await f.close(); }
});

test("valid original Bridge evidence permits same-Reviewer continuation and retains one usage source and business cycle", async () => {
  const f = await fixture("continuation");
  try {
    const record = await f.startPlan();
    const submitted = await f.manager.submit(record.id, f.input, f.exec);
    const waiting = await f.waitRecord(record.id, (current) => current.submissionState === "retrying");
    assert.ok(waiting.latestReviewEvidence?.fingerprint);
    assert.equal(waiting.latestReviewEvidence.insufficient, false);
    assert.equal(f.callback.availableContinuation(record.id), true);
    assert.equal(f.children.length, 1);
    const child = f.children[0]!;
    assert.deepEqual(f.disposed, []);
    assert.equal(f.pins, 1);
    assert.equal(waiting.reviewCycles, 0);
    assert.equal(f.visibleTurns.length, 2);
    await f.store.update(record.id, (current) => { current.submissionRetryAt = 0; });
    assert.equal(await f.manager.recoverCallbacks(), 1);
    const received = await f.waitRecord(record.id, (current) => current.submissionState === "received");
    assert.equal(received.submissionId, submitted.submissionId);
    assert.deepEqual(received.latestReviewEvidence, waiting.latestReviewEvidence);
    assert.equal(f.reviewerThreads.length, 1);
    assert.deepEqual(f.visibleTurns, Array(3).fill(f.reviewerThreads[0]!));
    assert.deepEqual(f.children.map((value) => value.id), [child.id]);
    assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, 3);
    assert.equal(received.observedUsage?.sources.length, 1);
    assert.equal(received.observedUsage?.summary.total?.totalTokens, 54);
    const verdict = f.commands.find((command): command is SubmitVerdictCommand => command.kind === "submit_verdict");
    assert.ok(verdict);
    assert.deepEqual(verdict, received.stagedVerdict?.command);
    assert.equal((await f.manager.applyExternalVerdict(verdict)).reviewCycles, 1);
    assert.equal((await f.manager.applyExternalVerdict(verdict)).reviewCycles, 1);
    assert.deepEqual(f.disposed, [child.id]);
    f.assertCleaned();
  } finally { await f.close(); }
});

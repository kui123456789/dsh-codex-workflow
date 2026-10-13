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
import type { ReviewInput, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import type { TokenUsageSnapshot } from "../src/usage-accounting.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";
import { settleWorkflowBackground } from "./fixtures/workflow-background-settlement.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: COMPLETED-REVIEW-SENTINEL: approved health diagnostics are verified.";
const VERDICT = { verdict: "pass" as const, findings: [], testGaps: [], summary: "Approved health diagnostics are verified" };

function gate() {
  let release!: () => void;
  let enter!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }),
    started: new Promise<void>((resolve) => { enter = resolve; }),
    release: () => release(), enter: () => enter() };
}

async function waitStarted(hold: ReturnType<typeof gate>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([hold.started, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Retry never entered its validation gate")), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

class MarkerFaultStore extends WorkflowStore {
  failMarkerWrite = false;
  markerFaults = 0;
  override update<T = void>(id: string, fn: (record: WorkflowRecord) => T,
    options: { ignoreCancelled?: boolean } = {}) {
    return super.update(id, (record) => {
      const wasPending = record.submissionReviewPending === true;
      const result = fn(record);
      if (this.failMarkerWrite && !wasPending && record.submissionReviewPending === true) {
        this.failMarkerWrite = false;
        this.markerFaults += 1;
        throw new Error("MARKER-WRITE-FAULT-SENTINEL: simulated first checkpoint persistence failure");
      }
      return result;
    }, options);
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-checkpoint-lifecycle-"));
  await writeFile(join(directory, "changed.txt"), "read-only diagnostic implementation v1", "utf8");
  const store = new MarkerFaultStore(join(directory, "storage"));
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const visibleCalls: Array<{ threadId: string; prompt: string }> = [];
  const alignmentCalls: string[] = [];
  const released: string[] = [];
  const children: Session[] = [];
  const disposed: string[] = [];
  const commands: BridgeCommand[] = [];
  const available = new Set<string>();
  const usage = new Map<string, TokenUsageSnapshot>();
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let turns = 0;
  let alignmentGate: ReturnType<typeof gate> | undefined;
  const gateway: CodexGateway = {
    async startThread() {
      const id = `validation-${privateThreads.length + 1}`;
      privateThreads.push(id); available.add(id); return id;
    },
    async startReviewerThread() {
      const id = `reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("A released callback Reviewer must not be resumed"); },
    async startTurn(threadId, options) {
      assert.ok(available.has(threadId), "turn/start must address an owned live thread");
      const turnId = `turn-${++turns}`;
      await options.onStarted?.({ threadId, turnId });
      if (options.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
      visibleCalls.push({ threadId, prompt: options.prompt });
      const counters = { totalTokens: 18, inputTokens: 11, cachedInputTokens: 2,
        cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 0 };
      usage.set(threadId, { threadId, turnId, total: counters, last: counters });
      options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async normalizeInFork(options) {
      assert.ok(available.has(options.threadId));
      alignmentCalls.push(options.threadId);
      const turnId = `validation-turn-${alignmentCalls.length}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      if (alignmentCalls.length === 1) return { kind: "completed", threadId: options.threadId, turnId,
        status: "failed", text: "", reason: "AUTHORITY-FAILURE-SENTINEL: schema checker denied this run" };
      alignmentGate?.enter();
      await alignmentGate?.promise;
      return { kind: "completed", threadId: options.threadId, turnId, status: "completed",
        text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async startReview(): Promise<never> { throw new Error("Bridge callbacks cannot become foreground reviews"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this completed checkpoint"); },
    async resolveDefaultModel() { return "model-A"; },
    async interrupt() {},
    async unsubscribeThread(threadId) {
      released.push(threadId);
      assert.ok(available.delete(threadId), "each owned subscription must be released exactly once");
    },
    isThreadAvailable: (threadId) => available.has(threadId),
    getThreadTokenUsage: (threadId) => usage.get(threadId),
    beginRound() { pins += 1; begins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const owner = SessionId("checkpoint-lifecycle-owner");
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
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
    reviewHeartbeatMs: 250 };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {}, undefined, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime as WorkflowRuntimeState
    & { submissionReviewResults?: Map<string, unknown> };
  const input: ReviewInput = { implementationSummary: "Health diagnostic implemented", changedFiles: ["changed.txt"], testResults: "Fixture verified" };
  const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
    task: "Implement and review read-only local configuration diagnostics", planMarkdown: "<proposed_plan>\nImplement a read-only health command and check invalid configuration.\n</proposed_plan>", assumptions: [] }, parent);
  const waitRecord = async (predicate: (value: WorkflowRecord) => boolean) => {
    await settleWorkflowBackground(manager, config, record.id);
    const current = await store.load(record.id);
    assert.ok(current);
    assert.equal(predicate(current), true, `The original background task settled in an unexpected state: ${current.submissionState}`);
    assert.equal(current.submissionLeaseToken, undefined, "Original cleanup must release the callback lease");
    return current;
  };
  const assertReleased = () => {
    assert.equal(reviewerThreads.length, 1);
    assert.deepEqual(released, [...reviewerThreads, ...privateThreads]);
    assert.equal(pins, 0);
    assert.equal(begins, 1 + privateThreads.length);
    assert.equal(ends, begins);
  };
  return { directory, store, manager, callback, exec, record, input, runtime, children, disposed, commands,
    visibleCalls, reviewerThreads, privateThreads, alignmentCalls, released, waitRecord, assertReleased,
    get pins() { return pins; },
    holdValidation(hold: ReturnType<typeof gate>) { alignmentGate = hold; },
    async park() {
      const submitted = await manager.submit(record.id, input, exec);
      const waiting = await waitRecord((value) => value.submissionState === "retrying");
      assert.equal(waiting.submissionId, submitted.submissionId);
      assert.match(waiting.submissionError ?? "", /AUTHORITY-FAILURE-SENTINEL/);
      assert.equal(callback.availableContinuation(record.id), false, "the callback completed and released its model handle");
      assert.equal(visibleCalls.length, 1);
      assert.equal(waiting.reviewCycles, 0);
      assert.equal(waiting.latestReview, undefined);
      assertReleased();
      return waiting;
    },
    async retry() {
      await store.update(record.id, (value) => { value.submissionRetryAt = 0; });
      return manager.recoverCallbacks();
    },
    async drain() { await settleWorkflowBackground(manager, config, record.id); },
    async close() {
      alignmentGate?.release();
      await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Bridge validation-only retry preserves the original child and observed usage without another readable review", async () => {
  const f = await fixture();
  try {
    const waiting = await f.park();
    const child = f.children[0]!;
    const turnsBefore = child.snapshotEvents().filter((event) => event.type === "turn/start").length;
    assert.deepEqual(f.disposed, []);
    assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), true);
    assert.equal(waiting.submissionReviewPending, true);
    const raw = f.store.coordinationHandle.loadWorkflow(f.record.id)!.recordJson;
    assert.equal(JSON.parse(raw).submission.submissionReviewPending, true);
    assert.equal(raw.includes("COMPLETED-REVIEW-SENTINEL"), false, "the completed model result stays process-local");
    for (const id of [...f.reviewerThreads, ...f.privateThreads, child.id]) {
      assert.equal(raw.includes(id), false, "the marker cannot persist ephemeral resource identities");
    }
    assert.equal(waiting.observedUsage?.sources.length, 1);
    assert.equal(waiting.observedUsage?.summary.total?.totalTokens, 18);
    assert.equal(await f.retry(), 1);
    const received = await f.waitRecord((value) => value.submissionState === "received");
    assert.equal(f.visibleCalls.length, 1);
    assert.deepEqual(f.children.map((value) => value.id), [child.id]);
    assert.equal(f.alignmentCalls.length, 2);
    assert.deepEqual(received.observedUsage, waiting.observedUsage, "validation forks do not create a second original-thread usage source");
    assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, turnsBefore + 1);
    assert.match(JSON.stringify(child.snapshotEvents().filter((event) => event.type === "user/message").at(-1)?.data), /校验|validation|authority|沿用|继续/i);
    assert.match(JSON.stringify(child.snapshotEvents().filter((event) => event.type === "assistant/message").at(-1)?.data), /COMPLETED-REVIEW-SENTINEL/);
    assert.deepEqual(f.disposed, [child.id]);
    assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), false);
    const verdicts = f.commands.filter((command): command is SubmitVerdictCommand => command.kind === "submit_verdict");
    assert.equal(verdicts.length, 1);
    assert.deepEqual(verdicts[0], received.stagedVerdict?.command);
    assert.equal(received.submissionId, waiting.submissionId);
    assert.equal((await f.manager.applyExternalVerdict(verdicts[0]!)).reviewCycles, 1);
    f.assertReleased();
  } finally { await f.close(); }
});

test("Bridge completed checkpoint refuses changed workspace before starting another callback or validation", async () => {
  const f = await fixture();
  try {
    await f.park();
    await writeFile(join(f.directory, "changed.txt"), "diagnostic implementation changed v2", "utf8");
    assert.equal(await f.retry(), 1);
    await f.drain();
    const current = (await f.store.load(f.record.id))!;
    assert.equal(f.visibleCalls.length, 1);
    assert.equal(f.alignmentCalls.length, 1);
    assert.equal(current.submissionState, "failed");
    assert.match(current.submissionError ?? "", /workspace|evidence/i);
    assert.equal(current.latestReview, undefined);
    assert.equal(current.reviewCycles, 0);
    assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), false);
    f.assertReleased();
  } finally { await f.close(); }
});

test("a failed checkpoint marker write cannot persist retrying without its completed-review recovery guard", async () => {
  const f = await fixture();
  try {
    f.store.failMarkerWrite = true;
    await f.manager.submit(f.record.id, f.input, f.exec);
    const waiting = await f.waitRecord((value) => value.submissionState === "retrying");
    assert.equal(f.store.markerFaults, 1, "only the first marker transaction failed; retry state commits normally");
    assert.equal(f.visibleCalls.length, 1);
    assert.equal(f.alignmentCalls.length, 0, "the write fault occurred before authority validation");
    assert.equal(f.callback.availableContinuation(f.record.id), false);
    assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), true);
    assert.deepEqual(f.disposed, []);
    assert.equal(waiting.submissionReviewPending, true, "a successful retry write must also preserve the restart guard");
    const raw = f.store.coordinationHandle.loadWorkflow(f.record.id)!.recordJson;
    assert.equal(JSON.parse(raw).submission.submissionReviewPending, true);
    assert.equal(raw.includes("COMPLETED-REVIEW-SENTINEL"), false);
    assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false);
    f.assertReleased();
    await f.manager.stop();
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
  } finally { await f.close(); }
});

test("Bridge checkpoint rejects changed pending input, task or owner without reviewing the replacement scope", async () => {
  for (const change of ["input", "task", "owner"] as const) {
    const f = await fixture();
    try {
      await f.park();
      await f.store.update(f.record.id, (value) => {
        if (change === "input") value.pendingReviewRequest = { ...f.input, implementationSummary: "REPLACEMENT-INPUT" };
        else if (change === "task") value.task = "REPLACEMENT-TASK";
        else value.dshSessionId = "replacement-owner";
      });
      const replacement = (await f.store.load(f.record.id))!;
      assert.equal(await f.retry(), 1);
      await f.drain();
      const current = (await f.store.load(f.record.id))!;
      assert.equal(f.visibleCalls.length, 1, `${change}: obsolete checkpoint cannot trigger another readable review`);
      assert.equal(f.alignmentCalls.length, 1, `${change}: validation cannot inspect replacement scope`);
      assert.deepEqual({ owner: current.dshSessionId, task: current.task, input: current.pendingReviewRequest },
        { owner: replacement.dshSessionId, task: replacement.task, input: replacement.pendingReviewRequest });
      assert.equal(current.latestReview, undefined);
      assert.equal(current.reviewCycles, 0);
      assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false);
      assert.deepEqual(f.disposed, [f.children[0]!.id]);
      assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), false);
      f.assertReleased();
    } finally { await f.close(); }
  }
});

test("cancel and stop dispose a completed Bridge checkpoint child once without releasing its finished Reviewer again", async () => {
  for (const action of ["cancel", "stop"] as const) {
    const f = await fixture();
    try {
      await f.park();
      const child = f.children[0]!;
      assert.deepEqual(f.disposed, []);
      if (action === "cancel") await f.manager.cancel(f.record.id, f.exec);
      else await f.manager.stop();
      await f.manager.stop();
      assert.deepEqual(f.disposed, [child.id]);
      assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), false);
      assert.equal(f.runtime.codexChildSessions.has(f.record.id), false);
      assert.equal(f.visibleCalls.length, 1);
      assert.equal(f.alignmentCalls.length, 1);
      assert.equal(await f.manager.recoverCallbacks(), 0);
      f.assertReleased();
    } finally { await f.close(); }
  }
});

test("a different submission cannot consume or silently replace an existing Bridge review checkpoint", async () => {
  const f = await fixture();
  try {
    const waiting = await f.park();
    const nextSubmission = newRequestId();
    assert.notEqual(nextSubmission, waiting.submissionId);
    await f.store.update(f.record.id, (value) => { value.submissionId = nextSubmission; });
    assert.equal(await f.retry(), 1);
    await f.drain();
    const current = (await f.store.load(f.record.id))!;
    assert.equal(current.submissionId, nextSubmission);
    assert.equal(f.visibleCalls.length, 1);
    assert.equal(f.alignmentCalls.length, 1);
    assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false);
    assert.equal(current.reviewCycles, 0);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), false);
    f.assertReleased();
  } finally { await f.close(); }
});

test("Bridge validation completion rechecks workspace, scope and lease before publishing its checkpoint verdict", async () => {
  for (const change of ["workspace", "scope", "lease"] as const) {
    const f = await fixture();
    const hold = gate();
    try {
      await f.park();
      f.holdValidation(hold);
      assert.equal(await f.retry(), 1);
      await waitStarted(hold);
      let replacement: WorkflowRecord | undefined;
      if (change === "workspace") await writeFile(join(f.directory, "changed.txt"), "changed during authority validation", "utf8");
      else {
        await f.store.update(f.record.id, (value) => {
          if (change === "scope") {
            value.task = "REPLACEMENT-TASK-DURING-VALIDATION";
            value.dshSessionId = "replacement-owner";
            value.lastProgressAt = "2000-01-01T00:00:00.000Z";
            value.lastProgressMessage = "REPLACEMENT-OWNER-PROGRESS";
            value.reviewElapsedMs = 17;
          }
          else {
            value.submissionLeaseToken = "replacement-lease-token";
            value.submissionLeaseEpoch = (value.submissionLeaseEpoch ?? 0) + 1;
            value.submissionState = "received";
            value.submissionError = "REPLACEMENT-LEASE-OWNER";
          }
        });
        replacement = (await f.store.load(f.record.id))!;
      }
      // The real observation timer clamps at 250 ms. Let it tick while the
      // authority model is still held and already belongs to obsolete scope.
      if (change === "scope") await new Promise((resolve) => setTimeout(resolve, 350));
      hold.release();
      await f.drain();
      const current = (await f.store.load(f.record.id))!;
      assert.equal(f.commands.some((command) => command.kind === "submit_verdict"), false, `${change}: a stale validation cannot publish`);
      assert.equal(f.visibleCalls.length, 1);
      assert.equal(current.latestReview, undefined);
      assert.equal(current.reviewCycles, 0);
      if (change === "scope") assert.deepEqual({ owner: current.dshSessionId, task: current.task,
        revision: current.revision, updatedAt: current.updatedAt, lastProgressAt: current.lastProgressAt,
        message: current.lastProgressMessage, elapsed: current.reviewElapsedMs },
      { owner: replacement!.dshSessionId, task: replacement!.task,
        revision: replacement!.revision, updatedAt: replacement!.updatedAt, lastProgressAt: replacement!.lastProgressAt,
        message: replacement!.lastProgressMessage, elapsed: replacement!.reviewElapsedMs });
      if (change === "lease") assert.deepEqual({ token: current.submissionLeaseToken, epoch: current.submissionLeaseEpoch,
        state: current.submissionState, error: current.submissionError, revision: current.revision, updatedAt: current.updatedAt },
      { token: replacement!.submissionLeaseToken, epoch: replacement!.submissionLeaseEpoch,
        state: replacement!.submissionState, error: replacement!.submissionError,
        revision: replacement!.revision, updatedAt: replacement!.updatedAt });
      assert.deepEqual(f.disposed, [f.children[0]!.id]);
      assert.equal(f.runtime.submissionReviewResults?.has(f.record.id), false);
      f.assertReleased();
    } finally { hold.release(); await f.close(); }
  }
});

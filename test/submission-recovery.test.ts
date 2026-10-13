import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { BridgeStore } from "../src/bridge-store.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Requirements verified.";

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { enter = resolve; });
  return { promise, started, enter, release };
}

class SubmissionClient implements CodexGateway {
  readonly reviewerThreads: string[] = [];
  readonly privateThreads: string[] = [];
  readonly visibleTurns: Array<{ threadId: string; prompt: string }> = [];
  readonly unsubscribed: string[] = [];
  readonly firstTurn = gate();
  recoveryTurn?: ReturnType<typeof gate>;
  pins = 0;
  beginCount = 0;
  endCount = 0;
  private turnNumber = 0;
  beginRound(): void { this.pins += 1; this.beginCount += 1; }
  endRound(): void { this.pins -= 1; this.endCount += 1; }
  async startThread(): Promise<string> {
    const id = `private-alignment-${this.privateThreads.length + 1}`;
    this.privateThreads.push(id);
    return id;
  }
  async startReviewerThread(): Promise<string> { return this.startReviewerThreadShell(); }
  async startReviewerThreadShell(): Promise<string> {
    const id = `reviewer-${this.reviewerThreads.length + 1}`;
    this.reviewerThreads.push(id);
    return id;
  }
  async configureReviewerThread(): Promise<void> {}
  async resumeThread(): Promise<void> { throw new Error("Unexpected thread/resume on an ephemeral Reviewer"); }
  async interrupt(): Promise<void> {}
  async unsubscribeThread(id: string): Promise<void> { this.unsubscribed.push(id); }
  async resolveDefaultModel(): Promise<string> { return "test-model"; }
  async continueTurn(): Promise<TurnWaitResult> { throw new Error("Unexpected clarification"); }
  async startReview(): Promise<never> { throw new Error("Background reviews use turn/start"); }
  async normalizeInFork(options: Parameters<CodexGateway["normalizeInFork"]>[0]): Promise<TurnWaitResult> {
    return { kind: "completed", threadId: options.threadId, turnId: `private-${++this.turnNumber}`, status: "completed",
      text: JSON.stringify({ aligned: true, conflicts: [] }) };
  }
  async startTurn(threadId: string, options: Parameters<CodexGateway["startTurn"]>[1]): Promise<TurnWaitResult> {
    const turnId = `turn-${++this.turnNumber}`;
    await options.onStarted?.({ threadId, turnId });
    if (options.conversion) {
      return { kind: "completed", threadId, turnId, status: "completed",
        text: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified." }) };
    }
    this.visibleTurns.push({ threadId, prompt: options.prompt });
    if (this.visibleTurns.length === 1) {
      this.firstTurn.enter();
      await this.firstTurn.promise;
    }
    if (this.visibleTurns.length <= 2) {
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    this.recoveryTurn?.enter();
    await this.recoveryTurn?.promise;
    options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
    return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-submission-recovery-"));
  const storage = join(directory, "storage");
  await writeFile(join(directory, "changed.txt"), "verified implementation", "utf8");
  const store = new WorkflowStore(storage);
  const queue = new BridgeStore(storage);
  const client = new SubmissionClient();
  const callback = new AppServerCodexCallbackDispatcher(client as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const children: Session[] = [];
  const disposed: string[] = [];
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION,
      id: options.sessionId, createdAt: Date.now(), cwd: directory, parentSession: SessionId("owner"),
      origin: "subagent", delegationDepth: 1, isSeeded: false });
    children.push(session);
    return { agent: { id: session.id, session } as Agent, dispose: async () => { disposed.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "complex", plannerModel: "", reviewerModel: "test-model",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60_000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: storage,
    reviewHeartbeatMs: 250, reviewStaleMs: 1000,
  };
  const queued: BridgeCommand[] = [];
  const manager = new WorkflowManager(store, client, config, callback, {
    async enqueue(command) { queued.push(command); return queue.enqueue(command); },
  }, undefined, {}, undefined, factory);
  const parent = { id: "owner", session: Session.create(SessionId("owner"), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId("owner"), createdAt: Date.now(), cwd: directory, isSeeded: false,
  }) } as Agent;
  const exec = (controller = new AbortController()) => ({ agent: parent, signal: controller.signal, deferContext() {} } as unknown as ToolRunContext);
  const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: parent.id },
    task: "Implement and review a read-only health command", planMarkdown: "<proposed_plan>\nCheck health read-only.\n</proposed_plan>", assumptions: [] }, parent);
  const awaitRecord = async (predicate: (current: WorkflowRecord) => boolean): Promise<WorkflowRecord> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const current = (await store.load(record.id))!;
      if (predicate(current)) return current;
      if (Date.now() > deadline) throw new Error(`submission did not reach the expected state: ${JSON.stringify({
        phase: current.phase, processState: current.processState, submissionState: current.submissionState, error: current.submissionError })}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const submitWaiting = async () => {
    const controller = new AbortController();
    const submitted = await manager.submit(record.id, { implementationSummary: "Health check implemented", changedFiles: ["changed.txt"] }, exec(controller));
    await client.firstTurn.started;
    assert.equal(submitted.submissionState, "queued", "submit returns before the background Reviewer completes");
    controller.abort();
    client.firstTurn.release();
    const waiting = await awaitRecord((current) => current.submissionState === "retrying"
      && current.processState === "waiting" && !current.submissionLeaseToken);
    assert.equal(waiting.submissionId, submitted.submissionId);
    assert.equal(callback.availableContinuation(record.id), true);
    assert.equal(disposed.length, 0);
    assert.equal(client.pins, 1);
    assert.equal(client.beginCount, 1);
    assert.equal(client.endCount, 0);
    assert.deepEqual(client.privateThreads, []);
    assert.equal(children.length, 1);
    return waiting;
  };
  const recover = async () => {
    // Expire only the persisted retry schedule; no sleep or lease manipulation is needed.
    await store.update(record.id, (current) => { current.submissionRetryAt = 0; });
    return manager.recoverCallbacks();
  };
  return { directory, store, queue, queued, client, callback, manager, children, disposed, record, exec, awaitRecord, submitWaiting, recover,
    async close() {
      client.firstTurn.release();
      await manager.stop();
      factory.unregisterProvider();
      queue.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("durable Bridge recovery continues the original submission, Reviewer and child through the exact staged verdict", async () => {
  const f = await fixture();
  try {
    const waiting = await f.submitWaiting();
    assert.equal(waiting.reviewCycles, 0);
    assert.equal((await f.manager.status(undefined, f.exec())).reviewerActive, false);
    const child = f.children[0]!;
    const originalTurns = child.snapshotEvents().filter((event) => event.type === "turn/start").length;
    assert.equal(await f.recover(), 1);
    const received = await f.awaitRecord((current) => current.submissionState === "received" && !current.submissionLeaseToken);
    assert.equal(received.submissionId, waiting.submissionId);
    assert.equal(received.submissionAttempts, 2);
    assert.equal(f.client.reviewerThreads.length, 1);
    assert.deepEqual([...new Set(f.client.visibleTurns.map((turn) => turn.threadId))], f.client.reviewerThreads);
    assert.equal(f.children.length, 1);
    assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, originalTurns + 1);
    assert.match(JSON.stringify(child.snapshotEvents().filter((event) => event.type === "user/message").at(-1)?.data), /继续|continue/i);
    assert.match(JSON.stringify(child.snapshotEvents().filter((event) => event.type === "assistant/message").at(-1)?.data), /Requirements verified/);
    assert.deepEqual(f.disposed, [child.id]);
    assert.equal(f.client.pins, 0);
    assert.equal(f.client.privateThreads.length, 1);
    assert.equal(f.client.beginCount, 1 + f.client.privateThreads.length);
    assert.equal(f.client.endCount, f.client.beginCount);
    assert.deepEqual(f.client.unsubscribed, [...f.client.reviewerThreads, ...f.client.privateThreads]);
    const queued = f.queued.filter((command): command is SubmitVerdictCommand => command.kind === "submit_verdict");
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0], received.stagedVerdict?.command, "queued identity matches the durable staged command byte-for-byte");
    const claim = await f.queue.claimNext("test-verdict-consumer");
    assert.deepEqual(claim?.command, received.stagedVerdict?.command);
    assert.equal(claim?.command.requestId, queued[0]?.requestId);
    assert.equal(claim?.command.createdAt, queued[0]?.createdAt);
    assert.equal(claim?.command.kind, "submit_verdict");
    const applied = await f.manager.applyExternalVerdict(claim!.command as SubmitVerdictCommand);
    assert.equal(applied.phase, "passed");
    assert.equal(applied.reviewCycles, 1);
    assert.equal(await f.manager.recoverCallbacks(), 0);
  } finally { await f.close(); }
});

test("durable Bridge recovery refuses changed evidence before starting another model turn", async () => {
  const f = await fixture();
  try {
    const waiting = await f.submitWaiting();
    const turns = f.client.visibleTurns.length;
    await writeFile(join(f.directory, "changed.txt"), "implementation changed after failed review", "utf8");
    assert.equal(await f.recover(), 1);
    const failed = await f.awaitRecord((current) => current.submissionState === "failed" && !current.submissionLeaseToken);
    assert.equal(failed.submissionId, waiting.submissionId);
    assert.match(failed.submissionError ?? "", /workspace changed/);
    assert.equal(f.client.visibleTurns.length, turns);
    assert.equal(f.client.reviewerThreads.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.disposed.length, 1);
    assert.equal(f.client.pins, 0);
    assert.deepEqual(f.client.privateThreads, []);
    assert.equal(f.client.beginCount, 1);
    assert.equal(f.client.endCount, 1);
    assert.deepEqual(f.client.unsubscribed, f.client.reviewerThreads);
    assert.equal(f.callback.availableContinuation(f.record.id), false);
    assert.equal(f.queued.filter((command) => command.kind === "submit_verdict").length, 0);
  } finally { await f.close(); }
});

for (const action of ["cancel", "stop"] as const) {
  test(`${action} closes a parked Bridge child and its retained Reviewer exactly once`, async () => {
    const f = await fixture();
    try {
      await f.submitWaiting();
      if (action === "cancel") await f.manager.cancel(f.record.id, f.exec());
      else await f.manager.stop();
      await f.manager.stop();
      assert.equal(f.disposed.length, 1);
      assert.equal(f.children.length, 1);
      assert.deepEqual(f.client.unsubscribed, [f.client.reviewerThreads[0]!]);
      assert.deepEqual(f.client.privateThreads, []);
      assert.equal(f.client.beginCount, 1);
      assert.equal(f.client.endCount, 1);
      assert.equal(f.client.pins, 0);
      assert.equal(f.callback.availableContinuation(f.record.id), false);
      assert.equal(await f.manager.recoverCallbacks(), 0);
    } finally { await f.close(); }
  });
}

test("a durable background continuation restores running observation and its heartbeat while the model waits", async () => {
  const f = await fixture();
  const hold = gate();
  try {
    await f.submitWaiting();
    f.client.recoveryTurn = hold;
    assert.equal(await f.recover(), 1);
    await hold.started;
    const running = await f.manager.status(f.record.id, f.exec());
    assert.equal(running.submissionState, "sending");
    assert.equal(running.processState, "running");
    assert.equal(running.reviewerActive, true);
    assert.equal(running.continuation.available, false);
    await f.awaitRecord((current) => current.lastProgressAt !== running.lastProgressAt);
    hold.release();
    await f.awaitRecord((current) => current.submissionState === "received" && !current.submissionLeaseToken);
  } finally { hold.release(); await f.close(); }
});

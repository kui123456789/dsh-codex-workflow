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

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Read-only health implementation verified.";
const VERDICT = { verdict: "pass" as const, findings: [], testGaps: [], summary: "Read-only health implementation verified" };

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { started: new Promise<void>((resolve) => { enter = resolve; }),
    promise: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

async function waitStarted(hold: ReturnType<typeof gate>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hold.started, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Native child creation never started")), 5000);
  })]); } finally { clearTimeout(timer); }
}

class StartupObservationFaultStore extends WorkflowStore {
  failStartupObservation = false;
  injectedFaults = 0;
  override update<T = void>(id: string, fn: (record: WorkflowRecord) => T,
    options: { ignoreCancelled?: boolean } = {}) {
    return super.update(id, (record) => {
      const previousAttempt = record.reviewAttempt ?? 0;
      const result = fn(record);
      if (this.failStartupObservation && record.reviewAttempt === previousAttempt + 1
        && record.reviewStep === "reviewing" && record.processState === "running") {
        this.failStartupObservation = false;
        this.injectedFaults += 1;
        throw new Error("STARTUP-OBSERVATION-FAULT: review-start persistence unavailable");
      }
      return result;
    }, options);
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-startup-lifecycle-"));
  await writeFile(join(directory, "changed.txt"), "read-only health command v1", "utf8");
  const store = new StartupObservationFaultStore(join(directory, "storage"));
  const creation = gate();
  const caller = new AbortController();
  const children: Session[] = [];
  const disposed: string[] = [];
  const commands: BridgeCommand[] = [];
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const releases: string[] = [];
  const available = new Set<string>();
  let turns = 0;
  let visibleTurns = 0;
  let callbackCalls = 0;
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let failDisposal = false;
  const gateway: CodexGateway = {
    async startThread() {
      const id = `startup-validation-${privateThreads.length + 1}`;
      privateThreads.push(id); available.add(id); return id;
    },
    async startReviewerThread() {
      const id = `startup-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("Startup recovery cannot invent a resumable thread"); },
    async startTurn(threadId, options) {
      assert.ok(available.has(threadId));
      const turnId = `startup-turn-${++turns}`;
      await options.onStarted?.({ threadId, turnId });
      if (options.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
      visibleTurns += 1;
      options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async normalizeInFork(options) {
      const turnId = `startup-validation-turn-${++turns}`;
      await options.onStarted?.({ threadId: options.threadId, turnId });
      return { kind: "completed", threadId: options.threadId, turnId, status: "completed",
        text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async startReview(): Promise<never> { throw new Error("Startup stays on the public Bridge callback path"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this startup fixture"); },
    async resolveDefaultModel() { return "model-A"; },
    async interrupt() {},
    async unsubscribeThread(id) {
      releases.push(id); assert.ok(available.delete(id), "owned thread cleanup must run exactly once");
    },
    isThreadAvailable: (id) => available.has(id),
    beginRound() { begins += 1; pins += 1; },
    endRound() { ends += 1; pins -= 1; },
  };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const send = callback.send.bind(callback);
  callback.send = async (request, signal) => { callbackCalls += 1; return send(request, signal); };
  const owner = SessionId("bridge-startup-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: caller.signal, deferContext() {} } as unknown as ToolRunContext;
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    creation.enter();
    // A host may finish an admitted creation despite lifecycle cancellation.
    // The manager must await it and own the returned child's cleanup.
    await creation.promise;
    const child = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    children.push(child);
    return { agent: { id: child.id, session: child } as Agent, async dispose() {
      disposed.push(child.id);
      if (failDisposal) throw new Error("CHILD-DISPOSAL-FAULT: native child disposal failed");
    } };
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
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
    task: "Implement and review read-only local health diagnostics", planMarkdown: "<proposed_plan>\nInspect local configuration read-only.\n</proposed_plan>", assumptions: [] }, parent);
  const input = { implementationSummary: "Read-only health command implemented", changedFiles: ["changed.txt"] };
  const waitRecord = async (predicate: (value: WorkflowRecord) => boolean) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = await store.load(record.id); assert.ok(current);
      if (predicate(current) && !current.submissionLeaseToken) return current;
      if (Date.now() > deadline) throw new Error(`Startup submission did not settle: ${current.submissionState}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { directory, store, manager, callback, runtime, record, exec, input, caller, creation, children, disposed,
    commands, reviewerThreads, privateThreads, waitRecord,
    failChildDisposal() { failDisposal = true; },
    get callbackCalls() { return callbackCalls; }, get visibleTurns() { return visibleTurns; },
    assertRuntimeEmpty() {
      assert.equal(runtime.codexChildSessions.size, 0);
      assert.equal(runtime.foreground.size, 0);
      assert.equal(runtime.backgroundTasks.size, 0);
      assert.equal(runtime.submissionControllers.size, 0);
      assert.equal(runtime.submissionReviewResults.size, 0);
      assert.equal(runtime.activeTurns.size, 0);
      assert.equal(runtime.auxiliaryTurns.size, 0);
      assert.equal(runtime.reviewHeartbeats.size, 0);
      assert.equal(pins, 0);
      assert.equal(ends, begins);
      assert.deepEqual(releases, [...reviewerThreads, ...privateThreads]);
    },
    async drain() { await Promise.allSettled([...runtime.backgroundTasks]); },
    async close() {
      creation.release(); await manager.stop(); factory.unregisterProvider();
      if (!store.isClosed()) store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("plugin stop awaits admitted Bridge child creation and leaves no late startup work or store writes", async () => {
  const f = await fixture();
  const submitted = f.manager.submit(f.record.id, f.input, f.exec);
  const settled = Promise.allSettled([submitted]);
  let stopping: Promise<void> | undefined;
  try {
    await waitStarted(f.creation);
    const prepared = (await f.store.load(f.record.id))!;
    assert.equal(prepared.submissionState, "queued");
    assert.ok(prepared.submissionId);
    assert.ok(prepared.submissionLeaseToken);
    let stopDone = false;
    stopping = f.manager.stop().then(() => { stopDone = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopDone, false, "stop cannot return while its admitted native child creation is unfinished");
    f.creation.release();
    await Promise.all([stopping, settled]);
    assert.equal(stopDone, true);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    assert.equal(f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length, 0,
      "a late native handle must be disposed before opening a child turn after teardown");
    assert.equal(f.callbackCalls, 0);
    assert.equal(f.visibleTurns, 0);
    assert.deepEqual(f.reviewerThreads, []);
    assert.deepEqual(f.commands, []);
    f.assertRuntimeEmpty();
    const afterStop = (await f.store.load(f.record.id))!;
    assert.equal(afterStop.submissionLeaseToken, undefined);
    assert.equal(afterStop.reviewCycles, 0);
    assert.equal(afterStop.latestReview, undefined);
    f.store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observer = new WorkflowStore(f.store.directory);
    try { assert.deepEqual(await observer.load(f.record.id), afterStop, "no startup writer may outlive stop and store closure"); }
    finally { observer.close(); }
    f.assertRuntimeEmpty();
  } finally { f.creation.release(); await settled; await stopping; await f.close(); }
});

test("workflow cancellation during Bridge child creation disposes the returned child once without starting its Reviewer", async () => {
  const f = await fixture();
  const submitted = f.manager.submit(f.record.id, f.input, f.exec);
  const settled = Promise.allSettled([submitted]);
  try {
    await waitStarted(f.creation);
    const cancelled = await f.manager.cancel(f.record.id, f.exec);
    assert.equal(cancelled.phase, "cancelled");
    f.creation.release();
    const outcomes = await settled;
    await f.drain();
    const current = (await f.store.load(f.record.id))!;
    assert.equal(current.phase, "cancelled");
    assert.equal(current.submissionState, "failed");
    assert.equal(current.submissionLeaseToken, undefined);
    if (outcomes[0]?.status === "fulfilled") assert.equal(outcomes[0].value.phase, "cancelled", "late startup must not return its obsolete queued record");
    assert.equal(f.callbackCalls, 0);
    assert.equal(f.visibleTurns, 0);
    assert.deepEqual(f.reviewerThreads, []);
    assert.deepEqual(f.commands, []);
    assert.equal(current.reviewCycles, 0);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    await f.manager.stop();
    f.assertRuntimeEmpty();
  } finally { f.creation.release(); await settled; await f.close(); }
});

test("caller abort after durable Bridge submission does not cancel its admitted startup or replace its child", async () => {
  const f = await fixture();
  const submitted = f.manager.submit(f.record.id, f.input, f.exec);
  const settled = Promise.allSettled([submitted]);
  try {
    await waitStarted(f.creation);
    const prepared = (await f.store.load(f.record.id))!;
    assert.ok(prepared.submissionId);
    f.caller.abort(new Error("the foreground tool ended after durable submission"));
    f.creation.release();
    const received = await f.waitRecord((record) => record.submissionState === "received");
    const outcomes = await settled;
    assert.equal(outcomes[0]?.status, "fulfilled");
    assert.equal(received.submissionId, prepared.submissionId);
    assert.equal(f.callbackCalls, 1);
    assert.equal(f.visibleTurns, 1);
    assert.equal(f.reviewerThreads.length, 1);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.disposed, [f.children[0]!.id]);
    const command = f.commands.find((value): value is SubmitVerdictCommand => value.kind === "submit_verdict");
    assert.ok(command);
    assert.deepEqual(command, received.stagedVerdict?.command);
    assert.equal((await f.manager.applyExternalVerdict(command)).reviewCycles, 1);
    await f.manager.stop();
    f.assertRuntimeEmpty();
  } finally { f.creation.release(); await settled; await f.close(); }
});

test("native child disposal failure cannot strand the original submission lease after startup persistence fails", async () => {
  const f = await fixture();
  f.store.failStartupObservation = true;
  f.failChildDisposal();
  const submitted = f.manager.submit(f.record.id, f.input, f.exec);
  const settled = Promise.allSettled([submitted]);
  try {
    await waitStarted(f.creation);
    const prepared = (await f.store.load(f.record.id))!;
    assert.ok(prepared.submissionId);
    assert.ok(prepared.submissionLeaseToken);
    assert.ok(prepared.submissionLeaseEpoch);
    f.creation.release();
    const outcomes = await settled;
    assert.equal(outcomes[0]?.status, "rejected");
    assert.equal(f.store.injectedFaults, 1, "only the review-start observation commit failed");
    assert.deepEqual(f.disposed, [f.children[0]!.id], "native cleanup is attempted exactly once despite its own failure");
    assert.equal(f.store.coordinationHandle.isLeaseOwner(`submission:${f.record.id}:${prepared.submissionId}`,
      prepared.submissionLeaseEpoch!, prepared.submissionLeaseToken!), false, "display cleanup failure cannot retain the callback lease");
    const current = (await f.store.load(f.record.id))!;
    assert.equal(current.submissionId, prepared.submissionId);
    assert.equal(current.submissionLeaseToken, undefined);
    assert.equal(current.submissionLeaseEpoch, undefined);
    assert.equal(current.submissionLeaseUntil, undefined);
    assert.equal(f.callbackCalls, 0);
    assert.equal(f.visibleTurns, 0);
    assert.deepEqual(f.commands, []);
    assert.equal(current.latestReview, undefined);
    assert.equal(current.reviewCycles, 0);
    await f.manager.stop();
    f.assertRuntimeEmpty();
  } finally { f.creation.release(); await settled; await f.close(); }
});

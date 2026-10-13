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
import type { LiveRelay } from "../src/application/live-relay.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand } from "../src/bridge-protocol.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { CodexCallbackRequest } from "../src/codex-callback.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway } from "../src/workflow.js";

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
    timer = setTimeout(() => reject(new Error("The real callback did not reach its held model turn")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(bufferA = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-progress-ownership-"));
  await writeFile(join(directory, "changed.txt"), "approved diagnostic implementation", "utf8");
  const owner = SessionId("bridge-progress-owner");
  const storage = join(directory, "storage");
  const makeActor = (role: "A" | "B") => {
    const store = new WorkflowStore(storage);
    const native = gate();
    const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
      createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
    const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
    const children: Session[] = [];
    const frames: unknown[] = [];
    const disposed: string[] = [];
    const commands: BridgeCommand[] = [];
    const threads: string[] = [];
    const released: string[] = [];
    const available = new Set<string>();
    const requests: CodexCallbackRequest[] = [];
    let pins = 0;
    let turns = 0;
    let nativeCalls = 0;
    const review = `VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ${role}-ORIGINAL-REVIEW: approved diagnostics are verified.`;
    const gateway: CodexGateway = {
      async startThread() { const id = `${role}-alignment-${threads.length + 1}`; threads.push(id); available.add(id); return id; },
      async startReviewerThread() { const id = `${role}-reviewer-${threads.length + 1}`; threads.push(id); available.add(id); return id; },
      async resumeThread(): Promise<never> { throw new Error("A callback cannot borrow a foreign ephemeral thread"); },
      async continueTurn(): Promise<never> { throw new Error("No clarification in this callback ownership fixture"); },
      async resolveDefaultModel() { return "model-A"; },
      async startTurn(threadId, input) {
        assert.ok(available.has(threadId));
        const turnId = `${role}-turn-${++turns}`;
        await input.onStarted?.({ threadId, turnId });
        if (input.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify({
          verdict: "pass", findings: [], testGaps: [], summary: `${role}-verified original diagnostics` }) };
        nativeCalls += 1; native.enter(); await native.promise;
        input.onProgress?.({ kind: "message", itemId: turnId, text: review });
        return { kind: "completed", threadId, turnId, status: "completed", text: review };
      },
      async startReview(): Promise<never> { throw new Error("Background review stays on callback turn/start"); },
      async normalizeInFork(input) {
        const turnId = `${role}-alignment-turn-${++turns}`;
        await input.onStarted?.({ threadId: input.threadId, turnId });
        return { kind: "completed", threadId: input.threadId, turnId, status: "completed", text: JSON.stringify({ aligned: true, conflicts: [] }) };
      },
      async interrupt() {},
      async unsubscribeThread(id) { released.push(id); assert.ok(available.delete(id), "thread cleanup must be exactly once"); },
      isThreadAvailable: (id) => available.has(id),
      beginRound() { pins += 1; }, endRound() { pins -= 1; },
    };
    const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
      policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
    });
    const send = callback.send.bind(callback);
    callback.send = (request, signal) => { requests.push(request); return send(request, signal); };
    // These two independent runtimes exercise legacy callback progress fences,
    // where each adapter owns its own operation. Original ephemeral recovery
    // uses the shared consumer-aware SDK fixture in the dedicated suites.
    const legacyCallback: CodexCallback = {
      send(request, signal) {
        const { consumer: _consumer, originalReviewerRequired: _required, ...legacy } = request;
        return callback.send(legacy, signal);
      },
      cancel: (id) => callback.cancel(id),
      cancelSubmission: (id, submissionId) => callback.cancelSubmission(id, submissionId),
      availableContinuation: (id) => callback.availableContinuation(id),
      stop: () => callback.stop(),
    };
    let provider: SubagentProvider;
    const factory = new CodexChildSessionFactory({ create: async (input: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
      const child = Session.create(input.sessionId, [], { version: SESSION_FORMAT_VERSION, id: input.sessionId,
        createdAt: Date.now(), cwd: directory, isSeeded: false, ...input.meta });
      children.push(child);
      const agent = { id: child.id, session: child, ctx: { emit(_name: string, payload: { frame: unknown }) {
        frames.push(structuredClone(payload.frame));
      } } } as unknown as Agent;
      return { agent, async dispose() { disposed.push(child.id); } };
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
      leaseTtlMs: 60000, reviewHeartbeatMs: 60000, turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: storage };
    const manager = new WorkflowManager(store, gateway, config, legacyCallback, { async enqueue(command) {
      commands.push(command); return command.requestId;
    } }, undefined, {}, { get: (id) => id === owner ? parent : undefined }, factory);
    const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    let relay: LiveRelay | undefined;
    let holdFlush = role === "A" && bufferA;
    const internal = manager as unknown as { submissionExecution: { ctx: {
      createLiveRelay(record: WorkflowRecord, stage: "reviewing", reviewId: string): LiveRelay;
    } } };
    const makeLive = internal.submissionExecution.ctx.createLiveRelay;
    internal.submissionExecution.ctx.createLiveRelay = (...args) => {
      relay = makeLive(...args);
      const flush = relay.flush.bind(relay);
      relay.flush = () => { if (!holdFlush) flush(); };
      return relay;
    };
    return { store, manager, callback, exec, parent, children, frames, disposed, commands, requests, native, runtime,
      threads, released,
      get nativeCalls() { return nativeCalls; },
      flush() { holdFlush = false; relay?.flush(); },
      async drain() { await Promise.allSettled([...runtime.backgroundTasks]); },
      async close() {
        native.release(); holdFlush = false;
        await manager.stop(); factory.unregisterProvider(); store.close();
        assert.equal(pins, 0);
        assert.deepEqual(released, threads);
      },
    };
  };
  const a = makeActor("A");
  const b = makeActor("B");
  const record = await a.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
    task: "Implement and review read-only health diagnostics", planMarkdown: "<proposed_plan>\nInspect diagnostics read-only.\n</proposed_plan>", assumptions: [] }, a.parent);
  await a.manager.submit(record.id, { implementationSummary: "Health diagnostics implemented", changedFiles: ["changed.txt"] }, a.exec);
  await waitStarted(a.native);
  const takeover = async () => {
    const original = (await a.store.load(record.id))!;
    assert.ok(original.submissionId && original.submissionLeaseToken && original.submissionLeaseEpoch);
    const resource = `submission:${record.id}:${original.submissionId}`;
    assert.equal(a.store.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch!, original.submissionLeaseToken!), true);
    assert.equal(await b.manager.recoverCallbacks(), 1);
    await waitStarted(b.native);
    const current = (await b.store.load(record.id))!;
    assert.notEqual(current.submissionLeaseToken, original.submissionLeaseToken);
    assert.equal(b.store.coordinationHandle.isLeaseOwner(resource, current.submissionLeaseEpoch!, current.submissionLeaseToken!), true);
    assert.equal(current.processState, "running");
    return current;
  };
  return { a, b, record, takeover,
    async close() {
      a.native.release(); b.native.release(); a.flush(); b.flush();
      await Promise.all([a.close(), b.close()]);
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("stale callback hooks cannot emit parent progress or append child turns after another runtime owns the submission", async () => {
  const f = await fixture();
  try {
    const request = f.a.requests[0]!;
    const running = await f.takeover();
    const parentBefore = structuredClone(f.a.parent.session.snapshotEvents());
    const childBefore = structuredClone(f.a.children[0]!.snapshotEvents());
    const framesBefore = structuredClone(f.a.frames);
    await Promise.allSettled([
      Promise.resolve().then(() => request.onThread?.(f.a.threads[0]!)),
      Promise.resolve().then(() => request.onStarted?.({ threadId: f.a.threads[0]!, turnId: "STALE-A-STARTED" })),
    ]);
    request.onProgress?.({ kind: "message", itemId: "STALE-A-PROGRESS", text: "STALE-A-PROGRESS:" + "x".repeat(2200) });
    await request.onContinuation?.("STALE-A-CONTINUATION");
    await request.onVisibleReview?.("STALE-A-VISIBLE-REVIEW");
    assert.deepEqual(f.a.parent.session.snapshotEvents(), parentBefore, "old A cannot emit progress after B owns the real SQLite lease");
    assert.deepEqual(f.a.children[0]!.snapshotEvents(), childBefore, "old A cannot append a continuation into the native child");
    assert.deepEqual(f.a.frames, framesBefore);
    assert.deepEqual(await f.b.store.load(f.record.id), running);
    f.a.native.release(); await f.a.drain();
    assert.deepEqual(f.a.commands, []);
    assert.deepEqual(f.a.parent.session.snapshotEvents(), parentBefore);
    assert.deepEqual(await f.b.store.load(f.record.id), running);
    assert.deepEqual(f.a.disposed, [f.a.children[0]!.id]);
  } finally { await f.close(); }
});

test("progress accepted before takeover cannot flush into the old parent after the successor completes review", async () => {
  const f = await fixture(true);
  try {
    f.a.requests[0]!.onProgress?.({ kind: "message", itemId: "EARLY-A-PENDING", text: "EARLY-A-PENDING-OWNED-TEXT" });
    await f.takeover();
    f.b.native.release(); await f.b.drain();
    const received = (await f.b.store.load(f.record.id))!;
    assert.equal(received.submissionState, "received");
    assert.equal(f.b.commands.filter((command) => command.kind === "submit_verdict").length, 1);
    const parentBefore = structuredClone(f.a.parent.session.snapshotEvents());
    f.a.flush();
    assert.deepEqual(f.a.parent.session.snapshotEvents(), parentBefore, "buffered live data must recheck owner when emitted");
    f.a.native.release(); await f.a.drain();
    assert.deepEqual(f.a.commands, []);
    assert.deepEqual(f.a.parent.session.snapshotEvents(), parentBefore);
    assert.deepEqual(await f.b.store.load(f.record.id), received);
  } finally { await f.close(); }
});

test("the current callback still emits owned progress and stages one verdict", async () => {
  const f = await fixture();
  try {
    const framesBefore = f.a.frames.length;
    f.a.requests[0]!.onProgress?.({ kind: "message", itemId: "OWNED-A-PROGRESS", text: "OWNED-A-PROGRESS:" + "x".repeat(2200) });
    assert.ok(f.a.parent.session.snapshotEvents().some((event) => event.type === "dsh-codex-workflow/live"));
    assert.ok(f.a.frames.length > framesBefore);
    f.a.native.release(); await f.a.drain();
    const received = (await f.a.store.load(f.record.id))!;
    assert.equal(received.submissionState, "received");
    assert.equal(f.a.commands.filter((command) => command.kind === "submit_verdict").length, 1);
    assert.deepEqual(f.a.disposed, [f.a.children[0]!.id]);
  } finally { await f.close(); }
});

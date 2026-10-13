import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { CodexChildSessionHandle } from "../src/codex-child-session.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

for (const processLoss of [false, true]) test(processLoss
  ? "auxiliary process exit drains its owned cleanup without respawning an App Server"
  : "successful foreground review releases its private alignment thread as well as its original Reviewer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-auxiliary-thread-"));
  await writeFile(join(directory, "changed.txt"), "verified local diagnostic", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-turn-interruption-app-server.mjs", import.meta.url));
  const processLog = join(directory, "process.jsonl");
  const codex = new CodexAppServerClient({ command: process.execPath,
    args: [fixture, "--turn-mode", "completed", "--process-log", processLog], requestTimeoutMs: 3000, rpcTimeoutMs: 3000, idleProcessMs: 0 });
  const normalize = codex.normalizeInFork.bind(codex);
  if (processLoss) codex.normalizeInFork = async (options, signal) => {
    if (!options.prompt.includes("REVIEW AUTHORITY checker")) return normalize(options, signal);
    const control = (codex as unknown as { request(method: string, params: object): Promise<unknown> }).request.bind(codex);
    const original = await control("fixture/exit", {}) as { processId: number };
    const deadline = Date.now() + 3000;
    while (codex.isThreadAvailable(options.threadId)) {
      if (Date.now() >= deadline) throw new Error("fixture process did not exit");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (;;) {
      try { process.kill(original.processId, 0); }
      catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        break;
      }
      if (Date.now() >= deadline) throw new Error("original auxiliary backend process exit was not confirmed by the OS");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Inject the interrupted auxiliary result after actual process loss.
    // The SDK waiter itself is tested in the protocol interruption suite.
    throw new CodexTurnInterruptionError(new Error("Codex turn timed out: exited-auxiliary-turn"), options.threadId,
      "exited-auxiliary-turn", original.processId, [original.processId]);
  };
  const created: Array<{ id: string; name?: string }> = [];
  const released: string[] = [];
  const startThread = codex.startThread.bind(codex);
  codex.startThread = async (options, signal) => {
    const id = await startThread(options, signal);
    created.push({ id, name: options.name });
    return id;
  };
  const startReviewer = codex.startReviewerThreadShell.bind(codex);
  codex.startReviewerThreadShell = async (options, signal) => {
    const id = await startReviewer(options, signal);
    created.push({ id, name: options.name });
    return id;
  };
  const unsubscribe = codex.unsubscribeThread.bind(codex);
  codex.unsubscribeThread = async (...args) => { released.push(args[0]); return unsubscribe(...args); };
  const children: Session[] = [];
  const frames: Array<{ type: string }> = [];
  let rawDisposals = 0;
  let pins = 0;
  const begin = codex.beginRound.bind(codex);
  const end = codex.endRound.bind(codex);
  codex.beginRound = () => { pins += 1; begin(); };
  codex.endRound = () => { pins -= 1; end(); };
  const owner = SessionId("auxiliary-thread-owner");
  const parentSession = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false });
  const parent = { id: owner, session: parentSession } as Agent;
  let provider: SubagentProvider;
  const childFactory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), isSeeded: false, ...options.meta });
    children.push(session);
    return { agent: { id: session.id, session, ctx: { emit(_name: string, payload: { frame: { type: string } }) {
      frames.push(payload.frame);
    } } } as unknown as Agent, async dispose() { rawDisposals += 1; } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: object) {
      const run = await provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name }) } as never);
      const child = run.localAgent!.session;
      parentSession.append("subagent/catalog", { version: 0, childId: child.id, childCreatedAt: child.header.createdAt,
        mode: "one-shot", label: "Original Reviewer" } as never);
      return run;
    },
  } as never);
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 3000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, codex, config,
    undefined, undefined, undefined, {}, undefined, childFactory);
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  try {
    const [outcome] = await Promise.allSettled([manager.reviewOnly({ task: "Review a read-only local diagnostic", implementationSummary: "Implemented health adapters",
      changedFiles: ["changed.txt"], testResults: "Verified missing and valid inputs" }, exec)]);
    if (processLoss) {
      assert.equal(outcome?.status, "fulfilled");
      const record = (await store.list())[0];
      assert.ok(record);
      assert.equal(record.latestReview, undefined);
      assert.equal(record.reviewCycles, 0);
      assert.equal(record.processState, "waiting");
      assert.equal(record.retryState?.reviewCheckpoint?.nextStep, "alignment");
      const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
      const recovery = runtime.recoverableRuns.get(record.id);
      assert.ok(recovery?.reviewCheckpoint && recovery.child);
      assert.equal(codex.isThreadAvailable(recovery.threadId), false,
        "A retained completed artifact never pretends that the exited original backend is resumable");
      assert.equal(rawDisposals, 0, "Preserve the original child until explicit lifecycle teardown");
      assert.equal(pins, 1, "Only the original completed review pin remains after OS-confirmed auxiliary exit");
      await manager.stop();
    } else {
      assert.equal(outcome?.status, "fulfilled");
      if (outcome?.status === "fulfilled") {
        assert.equal(outcome.value.phase, "passed");
        assert.equal(outcome.value.reviewCycles, 1);
        assert.equal(outcome.value.latestReview?.verdict, "pass");
      }
    }
    assert.equal(children.length, 1, "private alignment does not create another visible child");
    assert.equal(rawDisposals, 1);
    assert.equal(pins, 0);
    assert.equal(parentSession.snapshotEvents().filter((event) => event.type === "subagent/catalog").length, 1);
    assert.equal(frames.filter((frame) => frame.type === "start").length, frames.filter((frame) => frame.type === "end").length);
    const auxiliary = created.filter((thread) => thread.name?.startsWith("DSH Review Alignment"));
    const original = created.filter((thread) => thread.name?.startsWith("DSH Reviewer"));
    if (processLoss) {
      const events = (await readFile(processLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; processId: number });
      t.diagnostic(JSON.stringify({ auxiliaryThreads: auxiliary.length, originalReviewers: original.length,
        processStarts: events.filter((event) => event.kind === "start").map((event) => event.processId), rawDisposals, pins }));
    }
    assert.equal(auxiliary.length, 1);
    assert.equal(original.length, 1);
    assert.equal(released.filter((id) => id === original[0]!.id).length, 1);
    assert.equal(released.filter((id) => id === auxiliary[0]!.id).length, 1, "the independently created auxiliary subscription must be released exactly once");
    assert.equal(codex.isThreadAvailable(auxiliary[0]!.id), false, "the completed auxiliary thread cannot remain loaded");
    await manager.stop();
    const records = (await readFile(processLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; processId: number });
    assert.equal(records.filter((record) => record.kind === "start").length, 1, "cleanup cannot respawn the exited auxiliary process");
  } finally {
    await manager.stop(); childFactory.unregisterProvider(); await codex.stop(); store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

type AuxiliaryOutcome = "failure" | "abort_before_turn" | "held" | "unknown_then_confirmed" | "unknown_still_active";

async function scriptedAuxiliary(outcome: AuxiliaryOutcome) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-owned-auxiliary-"));
  await writeFile(join(directory, "changed.txt"), "verified diagnostic implementation", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const available = new Set<string>();
  const active = new Map<string, string>();
  const releases: string[] = [];
  const releaseAttempts: string[] = [];
  const interrupts: Array<{ threadId: string; turnId: string; aborted: boolean }> = [];
  const visibleCalls: string[] = [];
  const controller = new AbortController();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let failedAcknowledgements = outcome === "unknown_then_confirmed" ? 1 : outcome === "unknown_still_active" ? Number.POSITIVE_INFINITY : 0;
  let interruptedAlignment = false;
  const auxiliaryIds: string[] = [];
  const normalizationCalls: Array<{ threadId: string; stage: "conversion" | "alignment" }> = [];
  let holdCleanup = false;
  let enterCleanup!: () => void;
  let releaseCleanup!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => { enterCleanup = resolve; });
  const cleanupHeld = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let auxiliaryId = "";
  let originalId = "";
  let children = 0;
  let rawDisposals = 0;
  let pins = 0;
  const gateway: CodexGateway = {
    async startThread(options) {
      assert.ok(options.name?.startsWith("DSH Review Alignment"));
      const created = `owned-private-alignment-${auxiliaryIds.length + 1}`;
      auxiliaryIds.push(created);
      auxiliaryId ||= created;
      available.add(created);
      return created;
    },
    async startReviewerThread() { originalId = "original-visible-reviewer"; available.add(originalId); return originalId; },
    async resumeThread(): Promise<never> { throw new Error("No thread replacement is allowed"); },
    async startReview(options) {
      visibleCalls.push(options.threadId);
      await options.onStarted?.({ threadId: options.threadId, turnId: "visible-review-turn" });
      return { threadId: options.threadId, result: { kind: "completed", threadId: options.threadId,
        turnId: "visible-review-turn", status: "completed",
        text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved diagnostic requirements are verified." } };
    },
    async startTurn(): Promise<never> { throw new Error("Auxiliary failure cannot silently start a Reviewer continuation"); },
    async continueTurn(): Promise<never> { throw new Error("Native answers are outside this auxiliary lifecycle"); },
    async normalizeInFork(options, signal) {
      const alignment = options.prompt.includes("REVIEW AUTHORITY checker");
      normalizationCalls.push({ threadId: options.threadId, stage: alignment ? "alignment" : "conversion" });
      if (!alignment) return { kind: "completed", threadId: options.threadId, turnId: "private-conversion",
        status: "completed", text: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified" }) };
      if (outcome === "abort_before_turn") {
        controller.abort(new Error("operation aborted"));
        signal?.throwIfAborted();
      }
      const turnId = "owned-auxiliary-turn";
      await options.onStarted?.({ threadId: options.threadId, turnId });
      if (outcome === "held") {
        active.set(options.threadId, turnId);
        enter();
        await held;
        signal?.throwIfAborted();
      }
      if (outcome.startsWith("unknown_") && !interruptedAlignment) {
        interruptedAlignment = true;
        active.set(options.threadId, turnId);
        await assert.rejects(gateway.interrupt(options.threadId, turnId), /not acknowledged/);
        // This scripted gateway runs inside the test process. That real live
        // PID owns its local active writer; availability is not exit evidence.
        throw new CodexTurnInterruptionError(new Error(`Codex turn timed out: ${turnId}`), options.threadId, turnId,
          process.pid, [process.pid]);
      }
      if (outcome.startsWith("unknown_")) return { kind: "completed", threadId: options.threadId, turnId,
        status: "completed", text: JSON.stringify({ aligned: true, conflicts: [] }) };
      throw new Error("scripted private alignment failure");
    },
    async interrupt(threadId, turnId, signal) {
      interrupts.push({ threadId, turnId, aborted: signal?.aborted ?? false });
      if (active.has(threadId)) assert.equal(active.get(threadId), turnId);
      if (failedAcknowledgements > 0) { failedAcknowledgements -= 1; throw new Error("auxiliary interruption was not acknowledged"); }
      if (holdCleanup) { holdCleanup = false; enterCleanup(); await cleanupHeld; }
      signal?.throwIfAborted();
      active.delete(threadId);
    },
    async unsubscribeThread(threadId, signal) {
      releaseAttempts.push(threadId);
      assert.equal(signal?.aborted ?? false, false, "owned auxiliary release uses an independent cleanup signal");
      assert.equal(active.has(threadId), false, "unsubscribe cannot pretend an unconfirmed active model has terminated");
      releases.push(threadId);
      available.delete(threadId);
    },
    isThreadAvailable: (threadId) => available.has(threadId),
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  const owner = SessionId("owned-auxiliary-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false });
  const childFactory = { create: async () => {
    children += 1;
    return { id: "original-reviewer-child", session, beginContinuation() {}, failAttempt() {}, progress() {}, finish() {},
      async dispose() { rawDisposals += 1; } } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config,
    undefined, undefined, undefined, {}, undefined, childFactory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const exec = { agent: { id: owner, session }, signal: controller.signal, deferContext() {} } as unknown as ToolRunContext;
  const operation = manager.reviewOnly({ task: "Review the local diagnostic", implementationSummary: "Implemented health adapters",
    changedFiles: ["changed.txt"], testResults: "Verified valid and missing inputs" }, exec);
  const settled = Promise.allSettled([operation]);
  return { manager, store, runtime, exec, operation, settled, entered, release, cleanupEntered, releaseCleanup,
    active, available, releases, releaseAttempts, interrupts, visibleCalls, normalizationCalls,
    get auxiliaryId() { return auxiliaryId; }, get originalId() { return originalId; },
    allowAcknowledgement(hold = false) { failedAcknowledgements = 0; holdCleanup = hold; },
    snapshot() { return { children, rawDisposals, auxiliaryId, originalId, visibleCalls: [...visibleCalls] }; },
    async record() { const record = (await store.list())[0]; assert.ok(record); return record; },
    assertCleaned() {
      assert.equal(children, 1);
      assert.equal(rawDisposals, 1);
      assert.equal(pins, 0);
      assert.deepEqual(visibleCalls, [originalId]);
      assert.equal(releases.filter((id) => id === originalId).length, 1);
      assert.equal(releaseAttempts.filter((id) => id === originalId).length, 1);
      for (const id of auxiliaryIds) {
        assert.equal(releases.filter((released) => released === id).length, 1);
        assert.equal(releaseAttempts.filter((released) => released === id).length, 1);
        assert.equal(available.has(id), false);
      }
      assert.equal(active.size, 0);
    },
    async close() {
      failedAcknowledgements = 0; release(); releaseCleanup(); await settled; await manager.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

for (const outcome of ["failure", "abort_before_turn"] as const) test(`${outcome} still releases the independently created alignment subscription`, async () => {
  const f = await scriptedAuxiliary(outcome);
  try {
    await f.settled;
    const record = await f.record();
    assert.equal(record.latestReview, undefined);
    assert.equal(record.reviewCycles, 0);
    assert.notEqual(record.phase, "passed");
    assert.equal(f.releases.filter((id) => id === f.auxiliaryId).length, 1);
    await f.manager.stop();
    f.assertCleaned();
  } finally { await f.close(); }
});

test("stop awaits the auxiliary operation and releases only its owned alignment and Reviewer resources", async () => {
  const f = await scriptedAuxiliary("held");
  try {
    await Promise.race([f.entered, f.operation.then(() => { throw new Error("Alignment never reached its held operation"); })]);
    let stopped = false;
    const stopping = f.manager.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    f.release();
    await Promise.allSettled([f.operation, stopping]);
    const record = await f.record();
    assert.equal(record.latestReview, undefined);
    assert.equal(record.reviewCycles, 0);
    f.assertCleaned();
  } finally { await f.close(); }
});

test("unconfirmed auxiliary timeout retries the exact private interruption before releasing its subscription", async () => {
  const f = await scriptedAuxiliary("unknown_then_confirmed");
  try {
    await f.settled;
    const record = await f.record();
    assert.equal(record.latestReview?.verdict, "pass");
    assert.equal(record.reviewCycles, 1, "A confirmed old interruption permits the one retry of only the alignment stage");
    assert.ok(f.interrupts.length >= 2, "the helper must confirm the model's termination after the SDK acknowledgement failed");
    assert.ok(f.interrupts.every((pair) => pair.threadId === f.auxiliaryId && pair.turnId === "owned-auxiliary-turn" && !pair.aborted));
    assert.notEqual(f.runtime.recoverableRuns.get(record.id)?.interruptionTurnId, "owned-auxiliary-turn",
      "the private turn cannot become an original Reviewer continuation marker");
    assert.equal(f.normalizationCalls.filter((call) => call.stage === "conversion").length, 1);
    assert.equal(f.normalizationCalls.filter((call) => call.stage === "alignment").length, 2);
    f.assertCleaned();
  } finally { await f.close(); }
});

test("still-active auxiliary interruption retains the original Reviewer and its completed checkpoint for safe continuation", async () => {
  const f = await scriptedAuxiliary("unknown_still_active");
  try {
    await f.settled;
    const record = await f.record();
    assert.equal(record.latestReview, undefined);
    assert.equal(record.reviewCycles, 0);
    assert.equal(record.processState, "waiting");
    const recovery = f.runtime.recoverableRuns.get(record.id);
    assert.equal(recovery?.threadId, f.originalId);
    assert.equal(recovery?.reviewCheckpoint?.nextStep, "alignment");
    assert.deepEqual(recovery?.auxiliaryInterruption, { threadId: f.auxiliaryId, turnId: "owned-auxiliary-turn" });
    assert.equal(f.runtime.codexChildSessions.get(record.id)?.id, "original-reviewer-child");
    assert.equal(f.snapshot().rawDisposals, 0);
    assert.match(`${record.error ?? ""} ${record.lastProgressMessage ?? ""}`, /unconfirmed|not acknowledged/i);
    assert.equal(f.active.get(f.auxiliaryId), "owned-auxiliary-turn");
    assert.equal(f.releases.filter((id) => id === f.auxiliaryId).length, 0);
    assert.equal(f.releaseAttempts.filter((id) => id === f.auxiliaryId).length, 0, "an unconfirmed model must not receive a speculative unsubscribe");
    assert.notEqual(f.runtime.recoverableRuns.get(record.id)?.interruptionTurnId, "owned-auxiliary-turn");
    f.allowAcknowledgement();
    await f.manager.stop();
    f.assertCleaned();
  } finally { await f.close(); }
});

test("cancel and stop share one cleanup flight for the exact retained auxiliary pair", async () => {
  const f = await scriptedAuxiliary("unknown_still_active");
  try {
    await f.settled;
    const record = await f.record();
    const initialInterrupts = f.interrupts.length;
    assert.ok(initialInterrupts >= 2);
    f.allowAcknowledgement(true);
    const cancelling = f.manager.cancel(record.id, f.exec);
    await f.cleanupEntered;
    const stopping = f.manager.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.interrupts.length, initialInterrupts + 1, "overlapping lifecycle callers cannot send another auxiliary interruption");
    f.releaseCleanup();
    await Promise.all([cancelling, stopping]);
    assert.equal((await f.record()).phase, "cancelled");
    assert.equal(f.interrupts.length, initialInterrupts + 1);
    f.assertCleaned();
  } finally { f.releaseCleanup(); await f.close(); }
});

test("a retained unconfirmed auxiliary turn refuses a new review before creating models or children", async () => {
  const f = await scriptedAuxiliary("unknown_still_active");
  try {
    await f.settled;
    const record = await f.record();
    const before = f.snapshot();
    const row = f.store.coordinationHandle.loadWorkflow(record.id);
    const original = f.runtime.recoverableRuns.get(record.id);
    await assert.rejects(f.manager.review(record.id, { implementationSummary: "Another review", changedFiles: ["changed.txt"], newReviewRound: true }, f.exec),
      /private.*interruption.*unconfirmed/i);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), row);
    assert.equal(f.runtime.recoverableRuns.get(record.id), original);
    assert.equal(f.releaseAttempts.filter((id) => id === f.auxiliaryId).length, 0);
    f.allowAcknowledgement();
    await f.manager.stop();
    f.assertCleaned();
  } finally { await f.close(); }
});

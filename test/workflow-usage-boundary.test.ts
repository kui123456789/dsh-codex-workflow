import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { WorkflowStore } from "../src/store.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { TokenUsageSnapshot } from "../src/usage-accounting.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-workflow-usage-app-server.mjs", import.meta.url));

async function fixture(success = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-workflow-usage-"));
  await writeFile(join(directory, "changed.txt"), "verified implementation", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const codex = new CodexAppServerClient({ command: process.execPath, args: [fixturePath], requestTimeoutMs: 5_000,
    idleProcessMs: 0, env: { ...process.env, FAKE_WORKFLOW_USAGE_SUCCESS: success ? "1" : "0" } });
  const callback = new AppServerCodexCallbackDispatcher(codex, { policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 } });
  const released: string[] = [];
  const disposed: string[] = [];
  let endRounds = 0;
  let finishError = false;
  let disposalError = false;
  let provider: SubagentProvider;
  const realFactory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, parentSession: SessionId("owner"), origin: "subagent", delegationDepth: 1, isSeeded: false });
    return { agent: { id: session.id, session } as Agent, dispose: async () => { disposed.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const childFactory = { create: async (...args: Parameters<CodexChildSessionFactory["create"]>) => {
    const child = await realFactory.create(...args);
    return { ...child,
      finish: (...finishArgs: Parameters<typeof child.finish>) => {
        if (finishError) throw new Error("child finish failed");
        child.finish(...finishArgs);
      },
      dispose: async () => {
        await child.dispose();
        if (disposalError) throw new Error("child disposal failed");
      },
    };
  } } as unknown as CodexChildSessionFactory;
  const originalUnsubscribe = codex.unsubscribeThread.bind(codex);
  codex.unsubscribeThread = async (threadId, signal) => { released.push(threadId); return originalUnsubscribe(threadId, signal); };
  const originalEndRound = codex.endRound.bind(codex);
  codex.endRound = () => { endRounds += 1; originalEndRound(); };
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "complex", plannerModel: "test-model", reviewerModel: "test-model",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60_000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 5_000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, codex, config, callback, { enqueue: async (command) => command.requestId },
    undefined, {}, undefined, childFactory);
  const exec = (sessionId = "owner") => ({ agent: { id: sessionId, session: { header: { cwd: directory }, append() {} } },
    signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext);
  const snapshots: TokenUsageSnapshot[] = [];
  codex.onTokenUsage((snapshot) => snapshots.push(snapshot));
  const startBridge = () => manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: "owner" },
    task: "Review the health implementation", planMarkdown: "<proposed_plan>\nVerify health read-only.\n</proposed_plan>", assumptions: [] }, exec().agent!);
  // These foreground observation cases begin from an approved DSH plan. The
  // protocol fixture deliberately fails all model turns, so setup supplies
  // the durable plan without borrowing the separate Codex-bridge entry.
  const approvedDshPlan = async (phase: "executing" | "fixing" = "executing") => {
    const now = new Date().toISOString();
    const record: WorkflowRecord = { schemaVersion: 1, id: newRequestId(), dshSessionId: "owner", cwd: directory,
      task: "Review the health implementation", mode: "planned", origin: "dsh", phase, createdAt: now, updatedAt: now,
      planMarkdown: "<proposed_plan>\nVerify configuration and storage health through read-only adapters. Check valid, missing and invalid inputs without changing existing user data.\n</proposed_plan>",
      assumptions: [], questions: [], reviewCycles: 0, noChangeReviewRounds: 0 };
    await store.save(record);
    return record;
  };
  return { directory, store, codex, callback, manager, exec, snapshots, startBridge, approvedDshPlan, released, disposed,
    get endRounds() { return endRounds; },
    failChildCleanup() { finishError = true; disposalError = true; },
    async close() {
      try { await manager.stop().catch(() => undefined); }
      finally { realFactory.unregisterProvider(); await codex.stop(); store.close(); await rm(directory, { recursive: true, force: true }); }
    },
  };
}

for (const stage of ["planning", "reviewing", "fixing"] as const) {
  test(`real App Server and Manager preserve current original-thread usage while ${stage} waits for continuation`, async () => {
    const f = await fixture();
    try {
      let waiting;
      if (stage === "planning") waiting = await f.manager.start({ task: "Inspect configuration" }, f.exec());
      else if (stage === "reviewing") waiting = await f.manager.reviewOnly({ task: "Review configuration", implementationSummary: "Implemented",
        changedFiles: ["changed.txt"] }, f.exec());
      else {
        const record = await f.approvedDshPlan("fixing");
        waiting = await f.manager.review(record.id, { implementationSummary: "Fixed findings", changedFiles: ["changed.txt"] }, f.exec());
      }
      assert.equal(waiting.processState, "waiting");
      const before = await f.store.load(waiting.id);
      const status = await f.manager.status(undefined, f.exec());
      assert.deepEqual(status.continuation, { available: true });
      assert.equal(status.tokenUsage?.stage, stage === "planning" ? "planning" : "reviewing");
      assert.equal(status.tokenUsage?.total.totalTokens, 215);
      assert.equal(status.tokenUsage?.total.cachedInputTokens, 130);
      assert.equal(status.tokenUsage?.total.cacheWriteInputTokens, 9);
      assert.equal(status.tokenUsage?.last.totalTokens, 95);
      assert.deepEqual(await f.store.load(waiting.id), before, "reading measured usage never changes workflow persistence");
      await f.manager.cancel(waiting.id, f.exec());
      assert.equal((await f.manager.status(waiting.id, f.exec())).tokenUsage, undefined);
    } finally { await f.close(); }
  });
}

test("real Bridge callback usage reaches status on the owning session and disappears after cleanup or process loss", async () => {
  const f = await fixture();
  try {
    const record = await f.startBridge();
    await f.manager.submit(record.id, { implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
    const deadline = Date.now() + 5_000;
    for (;;) {
      const current = (await f.store.load(record.id))!;
      if (current.processState === "waiting" && current.submissionState === "retrying" && !current.submissionLeaseToken) break;
      if (Date.now() > deadline) throw new Error("Bridge callback did not settle into its retained waiting state");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(f.callback.availableContinuation(record.id), true);
    assert.equal(f.snapshots.at(-1)?.total.totalTokens, 215);
    const before = await f.store.load(record.id);
    await assert.rejects(f.manager.status(record.id, f.exec("another-session")), /another DSH session/);
    const status = await f.manager.status(undefined, f.exec());
    assert.equal(status.tokenUsage?.scope, "current_original_thread");
    assert.equal(status.tokenUsage?.stage, "reviewing");
    assert.equal(status.tokenUsage?.total.totalTokens, 215);
    assert.equal(status.tokenUsage?.total.cachedInputTokens, 130);
    assert.deepEqual(await f.store.load(record.id), before);
    await f.codex.stop();
    assert.equal((await f.manager.status(record.id, f.exec())).tokenUsage, undefined);
    await f.manager.cancel(record.id, f.exec());
    assert.equal((await f.manager.status(record.id, f.exec())).tokenUsage, undefined);
  } finally { await f.close(); }
});

for (const stage of ["planning", "reviewing"] as const) {
  const startWaiting = async (f: Awaited<ReturnType<typeof fixture>>) => stage === "planning"
    ? f.manager.start({ task: "Inspect configuration" }, f.exec())
    : f.manager.reviewOnly({ task: "Review configuration", implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());

  test(`two cancels release the parked ${stage} source once and keep unrelated App Server threads alive`, async () => {
    const f = await fixture();
    try {
      const waiting = await startWaiting(f);
      const source = f.snapshots.at(-1)!.threadId;
      const unrelated = await f.codex.startThread({ cwd: f.directory, ephemeral: true });
      assert.equal(f.codex.isThreadAvailable(source), true);
      await Promise.all([f.manager.cancel(waiting.id, f.exec()), f.manager.cancel(waiting.id, f.exec())]);
      assert.deepEqual(f.released, [source]);
      assert.equal(f.disposed.length, 1);
      assert.equal(f.endRounds, 1);
      assert.equal(f.codex.isThreadAvailable(source), false);
      assert.equal(f.codex.getThreadTokenUsage(source), undefined);
      assert.equal(f.codex.isThreadAvailable(unrelated), true, "cancel must not stop the shared App Server");
    } finally { await f.close(); }
  });

  test(`stop releases the parked ${stage} source and pin even when child finish and disposal fail`, async () => {
    const f = await fixture();
    try {
      await startWaiting(f);
      const source = f.snapshots.at(-1)!.threadId;
      f.failChildCleanup();
      await f.manager.stop();
      assert.deepEqual(f.released, [source]);
      assert.equal(f.disposed.length, 1);
      assert.equal(f.endRounds, 1);
      assert.equal(f.codex.isThreadAvailable(source), false);
      assert.equal(f.codex.getThreadTokenUsage(source), undefined);
    } finally { await f.close(); }
  });

  test(`stop waits for an in-progress parked ${stage} cancellation cleanup without releasing twice`, async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cleanupReleased = false;
    try {
      const waiting = await startWaiting(f);
      const source = f.snapshots.at(-1)!.threadId;
      const original = f.codex.unsubscribeThread.bind(f.codex);
      f.codex.unsubscribeThread = async (...args) => { entered(); await held; return original(...args); };
      const cancelled = f.manager.cancel(waiting.id, f.exec());
      const settledCancel = Promise.allSettled([cancelled]);
      await started;
      const stopped = f.manager.stop().then(() => {
        assert.equal(cleanupReleased, true, "stop must await the unsubscribe already owned by cancel");
      });
      const settledStop = Promise.allSettled([stopped]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      cleanupReleased = true;
      release();
      const result = (await settledStop)[0]!;
      await settledCancel;
      if (result.status === "rejected") throw result.reason;
      assert.deepEqual(f.released, [source]);
      assert.equal(f.disposed.length, 1);
      assert.equal(f.endRounds, 1);
    } finally { release(); await f.close(); }
  });
}

test("a private conversion fork never replaces the callback's original Reviewer usage", async () => {
  const f = await fixture(true);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const request = { workflowId: "workflow", submissionId: "submission", codexThreadId: "origin", cwd: f.directory,
      task: "Review implementation", prompt: "Review read-only", ephemeral: false,
      onEphemeralStarted: async () => { entered(); await held; } };
    const pending = f.callback.send(request);
    const settled = Promise.allSettled([pending]);
    await started;
    const original = f.callback.getOriginalThreadUsage(request.workflowId);
    const fork = f.snapshots.at(-1)!;
    assert.equal(fork.total.totalTokens, 1200, "the real fork reports a deliberately different usage snapshot");
    assert.equal(original?.total.totalTokens, 120);
    assert.notEqual(original?.threadId, fork.threadId);
    original!.total.totalTokens = 999;
    assert.equal(f.callback.getOriginalThreadUsage(request.workflowId)?.total.totalTokens, 120);
    release();
    assert.equal((await settled)[0]?.status, "fulfilled");
    assert.equal(f.callback.getOriginalThreadUsage(request.workflowId), undefined);
  } finally { release(); await f.close(); }
});

test("an admitted foreground review reports running before its backend turn has started", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const originalStartReview = f.codex.startReview.bind(f.codex);
  f.codex.startReview = async (...args) => { entered(); await held; return originalStartReview(...args); };
  try {
    const record = await f.approvedDshPlan();
    const reviewing = f.manager.review(record.id, { implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
    const settled = Promise.allSettled([reviewing]);
    await Promise.race([started, settled.then(([outcome]) => {
      if (outcome?.status === "rejected") throw outcome.reason;
      throw new Error("The foreground review settled before entering its backend barrier");
    })]);
    const status = await f.manager.status(record.id, f.exec());
    assert.equal(status.reviewerActive, false, "admission does not report a running Reviewer before its model turn exists");
    assert.deepEqual(status.continuation, { available: false, reason: "running" });
    assert.equal(status.tokenUsage, undefined, "an admitted but unstarted turn has no reported usage");
    release();
    assert.equal((await settled)[0]?.status, "fulfilled");
  } finally { release(); await f.close(); }
});

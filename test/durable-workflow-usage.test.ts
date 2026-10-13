import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";
import { settleWorkflowBackground } from "./fixtures/workflow-background-settlement.js";

const serverPath = fileURLToPath(new URL("./fixtures/fake-durable-workflow-usage.mjs", import.meta.url));

async function fixture(env: Record<string, string> = {}, legacyGateway = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-durable-workflow-usage-"));
  await writeFile(join(directory, "changed.txt"), "implemented health", "utf8");
  const storage = join(directory, "storage");
  const store = new WorkflowStore(storage);
  const codex = new CodexAppServerClient({ command: process.execPath, args: [serverPath],
    requestTimeoutMs: 5000, idleProcessMs: 0, env: { ...process.env, ...env } });
  const callback = new AppServerCodexCallbackDispatcher(codex, { policy: { baseMs: 1, maxMs: 1, budgetMs: 0 } });
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "off", plannerModel: "test-model", reviewerModel: "test-model",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60_000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 5000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: storage,
  };
  const gateway = legacyGateway ? new Proxy(codex, { get(target, property) {
    if (property === "onTokenUsage" || property === "getThreadTokenUsage") return undefined;
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } }) : codex;
  const manager = new WorkflowManager(store, gateway, config, callback, { enqueue: async (command) => command.requestId });
  const exec = (owner = "owner") => ({ agent: { id: owner, session: { header: { cwd: directory }, append() {} } },
    signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext);
  const startBridge = () => manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: "owner" },
    task: "Review health implementation", planMarkdown: "<proposed_plan>\nVerify health diagnostics.\n</proposed_plan>", assumptions: [] }, exec().agent!);
  const reopenedUsage = async (workflowId: string) => {
    await manager.stop();
    await codex.stop();
    store.close();
    const reopened = new WorkflowStore(storage);
    try { return (await reopened.load(workflowId))?.observedUsage; }
    finally { reopened.close(); }
  };
  let lateNotificationInjected = false;
  const injectUsageAfterCommit = (phase: "executing" | "passed") => {
    const update = store.update.bind(store);
    store.update = (async (...args: Parameters<WorkflowStore["update"]>) => {
      const outcome = await update(...args);
      if (!lateNotificationInjected && outcome.record.phase === phase) {
        lateNotificationInjected = true;
        // Metering can arrive after the business commit but before the thread
        // is released. Use the real client's notification parser, not a fake
        // accounting mutation, to exercise that completion window.
        const transport = codex as unknown as { onLine(line: string): void };
        transport.onLine(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
          threadId: "raw-durable-usage-thread-1", turnId: "raw-durable-usage-thread-1:raw-turn-2",
          tokenUsage: {
            total: { totalTokens: 360, inputTokens: 300, cachedInputTokens: 210, cacheWriteInputTokens: 15,
              outputTokens: 60, reasoningOutputTokens: 18 },
            last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 5,
              outputTokens: 20, reasoningOutputTokens: 6 },
            modelContextWindow: 128000,
          },
        } }));
      }
      return outcome;
    }) as typeof store.update;
  };
  return { directory, store, codex, callback, manager, config, exec, startBridge, reopenedUsage, injectUsageAfterCommit,
    get lateNotificationInjected() { return lateNotificationInjected; },
    async close() { await manager.stop(); await codex.stop(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const stage of ["planning", "reviewing"] as const) {
  test(`${stage} completion returns observations received after the business commit before thread release`, async () => {
    const f = await fixture();
    try {
      f.injectUsageAfterCommit(stage === "planning" ? "executing" : "passed");
      const result = stage === "planning" ? await f.manager.start({ task: "Implement safe health diagnostics" }, f.exec())
        : await f.manager.reviewOnly({ task: "Review health diagnostics", implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
      const persisted = (await f.store.load(result.id))!;
      assert.equal(f.lateNotificationInjected, true);
      assert.equal(persisted.phase, stage === "planning" ? "executing" : "passed");
      assert.equal(result.phase, persisted.phase, "metering must not change the completed business phase");
      assert.equal(persisted.observedUsage?.summary.total?.totalTokens, 360, "cleanup already persisted the final reported counters");
      assert.deepEqual(result.observedUsage, persisted.observedUsage, "tool-facing success must not return the earlier 240-token snapshot");
      assert.equal(result.observedUsage?.summary.total?.totalTokens, 360);
    } finally { await f.close(); }
  });
}

for (const stage of ["planning", "reviewing"] as const) {
  test(`completed ${stage} usage remains durable after thread unsubscribe and storage reopen`, async () => {
    const f = await fixture();
    try {
      const result = stage === "planning" ? await f.manager.start({ task: "Implement safe health diagnostics" }, f.exec())
        : await f.manager.reviewOnly({ task: "Review health diagnostics", implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
      assert.equal(result.phase, stage === "planning" ? "executing" : "passed");
      const status = await f.manager.status(result.id, f.exec());
      const observed = status.observedUsage!;
      assert.ok(observed, "completed work must retain server observations");
      assert.equal(observed.scope, "observed_original_threads");
      assert.equal(observed.summary.observedSources, 1);
      assert.equal(observed.summary.total?.totalTokens, 240, "the original thread includes its in-place normalization");
      assert.equal(observed.sources[0]?.stage, stage);
      assert.equal(observed.sources[0]?.total?.totalTokens, 240);
      assert.equal(f.codex.isThreadAvailable("raw-durable-usage-thread-1"), false);
      assert.equal(f.codex.getThreadTokenUsage("raw-durable-usage-thread-1"), undefined);
      assert.equal(JSON.stringify(observed).includes("raw-durable-usage"), false, "ephemeral identities must never become durable output");
      assert.deepEqual(await f.reopenedUsage(result.id), observed);
    } finally { await f.close(); }
  });
}

test("same-thread continuation replaces cumulative observations instead of adding the total again", async () => {
  const f = await fixture({ FAKE_DURABLE_USAGE_FAIL_FIRST: "2" });
  try {
    const waiting = await f.manager.start({ task: "Implement health diagnostics" }, f.exec());
    const before = (await f.manager.status(waiting.id, f.exec())).observedUsage!;
    assert.equal(before.summary.total?.totalTokens, 240);
    const sourceId = before.sources[0]!.sourceId;
    const completed = await f.manager.resume(waiting.id, "Continue the original plan", f.exec());
    assert.equal(completed.phase, "executing");
    const after = (await f.manager.status(waiting.id, f.exec())).observedUsage!;
    assert.equal(after.sources.length, 1);
    assert.equal(after.sources[0]!.sourceId, sourceId);
    assert.equal(after.summary.total?.totalTokens, 480, "latest server cumulative total replaces 240, rather than becoming 720");
    assert.deepEqual(await f.reopenedUsage(waiting.id), after);
  } finally { await f.close(); }
});

test("a fresh review round adds a source while private alignment threads are excluded", async () => {
  const f = await fixture({ FAKE_DURABLE_USAGE_FIRST_REVIEW_BLOCKS: "1" });
  try {
    const first = await f.manager.reviewOnly({ task: "Review health failure handling", implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
    assert.equal(first.phase, "fixing");
    const before = (await f.manager.status(first.id, f.exec())).observedUsage!;
    assert.equal(before.summary.total?.totalTokens, 240, "12,000 private alignment tokens must not be attributed to the original thread");
    await writeFile(join(f.directory, "changed.txt"), "added required failure handling", "utf8");
    const second = await f.manager.review(first.id, { implementationSummary: "Fixed failure handling", changedFiles: ["changed.txt"] }, f.exec());
    assert.equal(second.phase, "passed");
    const after = (await f.manager.status(first.id, f.exec())).observedUsage!;
    assert.equal(after.sources.length, 2);
    assert.equal(new Set(after.sources.map((source) => source.sourceId)).size, 2);
    assert.equal(after.summary.total?.totalTokens, 480);
    assert.equal(after.scope, "observed_original_threads", "observed original threads are not a complete provider bill");
  } finally { await f.close(); }
});

test("cancel and stop preserve observations already received before closing SQLite", async () => {
  const f = await fixture({ FAKE_DURABLE_USAGE_FAIL_FIRST: "2" });
  try {
    const waiting = await f.manager.start({ task: "Implement health inspection" }, f.exec());
    const before = (await f.manager.status(waiting.id, f.exec())).observedUsage!;
    const cancelled = await f.manager.cancel(waiting.id, f.exec());
    assert.equal(cancelled.phase, "cancelled");
    const status = await f.manager.status(waiting.id, f.exec());
    assert.equal(status.tokenUsage, undefined);
    assert.deepEqual(status.observedUsage, before);
    assert.deepEqual(await f.reopenedUsage(waiting.id), before, "stop must flush observations before the store closes");
  } finally { await f.close(); }
});

test("missing provider usage remains unknown rather than becoming zero", async () => {
  const f = await fixture({ FAKE_DURABLE_USAGE_UNKNOWN: "1" });
  try {
    const result = await f.manager.start({ task: "Implement health inspection" }, f.exec());
    const observed = (await f.manager.status(result.id, f.exec())).observedUsage!;
    assert.ok(observed);
    assert.equal(observed.sources.length, 1);
    assert.equal(observed.summary.observedSources, 0);
    assert.equal(observed.summary.missingSources, 1);
    assert.equal(observed.summary.total, undefined);
    assert.equal(observed.sources[0]!.total, undefined);
    assert.equal(observed.sources[0]!.last, undefined);
    assert.deepEqual(await f.reopenedUsage(result.id), observed);
  } finally { await f.close(); }
});

test("legacy gateways without usage subscription or snapshot access still complete with unknown observations", async () => {
  const f = await fixture({}, true);
  try {
    const result = await f.manager.start({ task: "Implement health inspection" }, f.exec());
    assert.equal(result.phase, "executing");
    const observed = (await f.manager.status(result.id, f.exec())).observedUsage!;
    assert.ok(observed);
    assert.equal(observed.sources.length, 1);
    assert.equal(observed.summary.observedSources, 0);
    assert.equal(observed.summary.missingSources, 1);
    assert.equal(observed.summary.total, undefined);
    assert.deepEqual(await f.reopenedUsage(result.id), observed);
  } finally { await f.close(); }
});

test("stop flushes a parked original thread before the client and store are closed", async () => {
  const f = await fixture({ FAKE_DURABLE_USAGE_FAIL_FIRST: "2" });
  try {
    const waiting = await f.manager.start({ task: "Implement health inspection" }, f.exec());
    assert.equal(waiting.processState, "waiting");
    // Deliberately do not call status: teardown itself must flush the observers.
    const observed = await f.reopenedUsage(waiting.id);
    assert.ok(observed);
    assert.equal(observed.sources.length, 1);
    assert.equal(observed.summary.total?.totalTokens, 240);
    assert.equal(observed.scope, "observed_original_threads");
  } finally { await f.close(); }
});

test("a missing optional cache-write counter stays unknown across durable aggregation", async () => {
  const f = await fixture({ FAKE_DURABLE_USAGE_OMIT_CACHE_WRITE: "1" });
  try {
    const result = await f.manager.reviewOnly({ task: "Review health diagnostics", implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
    const observed = (await f.manager.status(result.id, f.exec())).observedUsage!;
    assert.equal(observed.summary.observedSources, 1);
    assert.equal(observed.summary.partialSources, 1);
    assert.equal(observed.summary.total?.totalTokens, 240);
    assert.equal(observed.summary.total?.cacheWriteInputTokens, undefined);
    assert.equal(observed.sources[0]!.total?.cacheWriteInputTokens, undefined);
    assert.deepEqual(await f.reopenedUsage(result.id), observed);
  } finally { await f.close(); }
});

test("the real bridge callback persists its original Reviewer observations after delivery", async () => {
  const f = await fixture();
  try {
    const workflow = await f.startBridge();
    await f.manager.submit(workflow.id, { implementationSummary: "Implemented", changedFiles: ["changed.txt"] }, f.exec());
    await settleWorkflowBackground(f.manager, f.config, workflow.id);
    const current = (await f.store.load(workflow.id))!;
    assert.equal(current.submissionState, "received", "The original callback must complete its durable verdict delivery");
    assert.equal(current.submissionLeaseToken, undefined, "The original background task must release its own lease");
    const observed = (await f.manager.status(workflow.id, f.exec())).observedUsage!;
    assert.ok(observed, "background callbacks must share durable accounting");
    assert.equal(observed.sources.length, 1);
    assert.equal(observed.sources[0]!.stage, "reviewing");
    assert.equal(observed.summary.total?.totalTokens, 240);
    assert.deepEqual(await f.reopenedUsage(workflow.id), observed);
  } finally { await f.close(); }
});

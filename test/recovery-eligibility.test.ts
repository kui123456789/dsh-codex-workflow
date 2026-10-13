import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

test("real Manager diagnoses changed Reviewer evidence without destroying its waiting thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-recovery-eligibility-"));
  await writeFile(join(directory, "changed.txt"), "v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  let modelCalls = 0;
  let pins = 0;
  const released: string[] = [];
  const fail = async (threadId: string, options: { onStarted?: (value: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<TurnWaitResult> => {
    const turnId = `failed-turn-${++modelCalls}`;
    await options.onStarted?.({ threadId, turnId });
    return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
  };
  const gateway: CodexGateway = {
    async startThread() { throw new Error("A Reviewer must not create a Planner"); },
    async startReviewerThread() { return "original-reviewer"; },
    async resumeThread() {},
    startTurn: fail,
    async startReview(options) { return { threadId: options.threadId, result: await fail(options.threadId, options) }; },
    async normalizeInFork() { throw new Error("A failed visible turn must not be normalized"); },
    async continueTurn() { throw new Error("Unexpected clarification"); },
    async interrupt() {},
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; },
  };
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 200,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config);
  const exec = { agent: { id: "owner", session: { header: { cwd: directory }, append() {} } },
    signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  try {
    const waiting = await manager.reviewOnly({ task: "Review implementation", implementationSummary: "Implemented v1", changedFiles: ["changed.txt"] }, exec);
    assert.equal(waiting.processState, "waiting");
    const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    const recovery = runtime.recoverableRuns.get(waiting.id);
    await writeFile(join(directory, "changed.txt"), "v2", "utf8");
    const before = await store.load(waiting.id);
    const changed = await manager.status(waiting.id, exec);
    assert.deepEqual(changed.continuation, { available: false, reason: "workspace_changed" });
    assert.deepEqual(await store.load(waiting.id), before, "status must not change the workflow or release its resources");
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery);
    assert.deepEqual(released, []);
    assert.equal(pins, 1);
    assert.equal(modelCalls, 2, "checking availability must not send a model request");
    await writeFile(join(directory, "changed.txt"), "v1", "utf8");
    assert.deepEqual((await manager.status(waiting.id, exec)).continuation, { available: true });
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery, "restoring evidence must not silently replace the original thread");
  } finally {
    await manager.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

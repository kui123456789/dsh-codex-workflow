import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

/** This protects an existing safety boundary, not an unknown-thread recovery:
 * a failed thread/start cannot supply an identity that the plugin never received. */
test("abort before thread/start returns keeps a queryable failure without inventing a resumable thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-start-boundary-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const controller = new AbortController();
  let workflowId: string | undefined;
  let threadStarts = 0;
  let modelCalls = 0;
  let threadResumes = 0;
  let pins = 0;
  let children = 0;
  let disposals = 0;
  const session = Session.create(SessionId("start-boundary-owner"), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId("start-boundary-owner"),
    createdAt: Date.now(), cwd: directory, isSeeded: false,
  });
  const exec = (signal = new AbortController().signal): ToolRunContext => ({
    agent: { id: session.id, session } as Agent, signal, deferContext() {},
  } as unknown as ToolRunContext);
  const unexpectedModelCall = async (): Promise<never> => {
    modelCalls += 1;
    throw new Error("An unknown thread must never receive a model turn");
  };
  const gateway: CodexGateway = {
    async startThread() {
      threadStarts += 1;
      const record = (await store.list())[0]!;
      workflowId = record.id;
      assert.equal(record.phase, "planning", "the workflow is persisted before thread creation");
      controller.abort(new Error("operation aborted"));
      throw new Error("operation aborted");
    },
    async resumeThread() { threadResumes += 1; },
    startTurn: unexpectedModelCall,
    continueTurn: unexpectedModelCall,
    startReview: unexpectedModelCall,
    normalizeInFork: unexpectedModelCall,
    async interrupt() {},
    beginRound() { pins += 1; },
    endRound() { pins -= 1; },
    isThreadAvailable: () => false,
  };
  const childFactory = { create: async () => {
    children += 1;
    return {
      id: "start-boundary-child", session,
      beginContinuation() {}, failAttempt() {}, progress() {}, finish() {},
      async dispose() { disposals += 1; },
    } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "codex", autoTriggerMode: "off", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
  try {
    await assert.rejects(manager.start({ task: "Plan the health check" }, exec(controller.signal)), /operation aborted/);
    assert.ok(workflowId);
    const status = await manager.status(workflowId, exec());
    assert.equal(status.phase, "failed");
    assert.equal(status.error, "operation aborted");
    assert.equal(status.continuation.available, false);
    assert.equal(status.continuation.reason, "not_waiting");
    assert.equal(status.planMarkdown, undefined);
    assert.equal(status.latestReview, undefined);
    assert.equal((await store.list()).length, 1, "the failure remains in durable storage");
    const sessionStatus = await manager.status(undefined, exec());
    assert.equal(sessionStatus.id, workflowId, "the current session can find its actual failed startup without the lost return id");
    assert.equal(sessionStatus.error, "operation aborted");
    assert.deepEqual(sessionStatus.continuation, { available: false, reason: "not_waiting" });
    await assert.rejects(manager.resume(workflowId, "Continue", exec()), /no in-process continuation/);
    await assert.rejects(manager.resume(undefined, "Continue", exec()), /no active Codex workflow/);
    assert.equal(threadStarts, 1, "resume must never create a replacement thread");
    assert.equal(threadResumes, 0, "an unavailable thread identity must never be invented");
    assert.equal(modelCalls, 0);
    assert.equal(children, 1);
    assert.equal(disposals, 1);
    assert.equal(pins, 0);
  } finally {
    await manager.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

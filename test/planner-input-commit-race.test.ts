import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { enter, release, entered, promise };
}

for (const entry of ["start", "resume"] as const) test(`${entry} native input cancelled before its waiting commit releases the original resources once`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-planner-input-commit-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const waitingCommit = gate();
  const releases: string[] = [];
  const interrupts: Array<{ threadId: string; turnId: string }> = [];
  let threadStarts = 0;
  let childStarts = 0;
  let rawDisposals = 0;
  let begins = 0;
  let ends = 0;
  let pins = 0;
  let turnStarts = 0;
  const owner = SessionId(`input-commit-${entry}`);
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = { agent: { id: owner, session } as Agent, signal: new AbortController().signal,
    deferContext() {} } as unknown as ToolRunContext;
  const gateway: CodexGateway = {
    async startThread() { threadStarts += 1; return "original-planner"; },
    async resumeThread() { throw new Error("An ephemeral Planner must not be recreated"); },
    async startTurn(threadId, options) {
      const turnId = `original-turn-${++turnStarts}`;
      await options.onStarted?.({ threadId, turnId });
      if (entry === "resume" && turnStarts <= 2) {
        return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
      }
      return { kind: "needs_input", threadId, turnId, request: {
        requestId: turnStarts, threadId, turnId, itemId: "original-input", questions: [{
          id: "scope", header: "Scope", question: "Which scope should the plan cover?",
          options: [], allowOther: true, secret: false,
        }],
      } };
    },
    async continueTurn(): Promise<never> { throw new Error("No answers are submitted in this race"); },
    async normalizeInFork(): Promise<never> { throw new Error("Native input must not require conversion"); },
    async startReview(): Promise<never> { throw new Error("No Reviewer should be started"); },
    async interrupt(threadId, turnId) { interrupts.push({ threadId, turnId }); },
    async unsubscribeThread(threadId) { releases.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { begins += 1; pins += 1; },
    endRound() { ends += 1; pins -= 1; },
  };
  const childFactory = { create: async () => {
    childStarts += 1;
    return { id: "original-child", session, beginContinuation() {}, pauseForInput() {},
      failAttempt() {}, progress() {}, finish() {},
      async dispose() { rawDisposals += 1; },
    } as CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "planner-model", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config,
    undefined, undefined, undefined, {}, undefined, childFactory);
  const update = store.update.bind(store);
  let delayed = false;
  store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, opts?: Parameters<typeof update>[2]) => {
    if (!delayed && mutate.toString().includes("return mutate")) {
      const prior = await store.load(id);
      if (prior) {
        // The ownership fence wraps these Planner mutations. They only edit
        // the supplied record; this copy probe makes no model/gateway calls.
        // Skip usage-observer callbacks, whose closures own accounting state.
        const candidate = structuredClone(prior);
        mutate(candidate);
        if (prior.phase !== "waiting_input" && candidate.phase === "waiting_input") {
          delayed = true;
          waitingCommit.enter();
          await waitingCommit.promise;
        }
      }
    }
    return update<T>(id, mutate, opts);
  };
  let operation: Promise<unknown> | undefined;
  try {
    if (entry === "resume") {
      const failed = await manager.start({ task: "Plan a scoped configuration diagnostic" }, exec);
      assert.equal(failed.processState, "waiting");
      assert.equal(failed.retryState?.stage, "planning");
      assert.equal(turnStarts, 2);
      operation = manager.resume(failed.id, undefined, exec);
    } else {
      operation = manager.start({ task: "Plan a scoped configuration diagnostic" }, exec);
    }
    void operation.catch(() => undefined);
    await Promise.race([waitingCommit.entered, operation.then(() => {
      throw new Error("Planner settled before reaching the native waiting commit");
    })]);
    const active = await store.activeForSession(owner);
    assert.ok(active);
    assert.equal(pins, 1);
    await manager.cancel(active.id, exec);
    waitingCommit.release();
    const cancelled = await operation as Awaited<ReturnType<WorkflowManager["start"]>>;
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.dshSessionId, owner);
    assert.equal((await store.load(active.id))?.phase, "cancelled");
    assert.deepEqual(releases, ["original-planner"], "the original Planner subscription is released once after a suppressed input commit");
    assert.equal(rawDisposals, 1, "count raw dispose calls rather than an idempotent fake effect");
    assert.deepEqual({ threadStarts, childStarts, begins, ends, pins }, {
      threadStarts: 1, childStarts: 1, begins: 1, ends: 1, pins: 0,
    });
    assert.deepEqual(interrupts, [{ threadId: "original-planner", turnId: `original-turn-${turnStarts}` }]);
    await manager.cancel(active.id, exec);
    await manager.stop();
    assert.deepEqual(interrupts, [{ threadId: "original-planner", turnId: `original-turn-${turnStarts}` }],
      "a released terminal Planner cannot remain an active cancel or stop target");
    assert.deepEqual(releases, ["original-planner"]);
    assert.equal(rawDisposals, 1);
    assert.equal(ends, 1);
  } finally {
    waitingCommit.release();
    await operation?.catch(() => undefined);
    await manager.stop();
    store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

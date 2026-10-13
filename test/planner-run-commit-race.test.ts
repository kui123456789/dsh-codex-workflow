import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const PLAN = "<proposed_plan>\n# Goal\nAdd a local diagnostic that preserves user data.\n# Changes\n- Inspect configuration through read-only adapters.\n- Report missing settings without initializing storage.\n# Verification\n- Check valid, missing and invalid settings in isolated fixtures.\n# Risks\n- Preserve configuration and existing database contents.\n</proposed_plan>";
type Boundary = "ready" | "needs_input" | "failed" | "registration";
type Drift = "owner" | "cwd" | "phase" | "stop";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { enter, release, entered, promise };
}

async function fixture(boundary: Boundary) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-planner-commit-owner-"));
  await mkdir(join(directory, "replacement-workspace"));
  const store = new WorkflowStore(join(directory, "storage"));
  const commit = gate();
  const frames: Array<{ type: string }> = [];
  const children: Session[] = [];
  const releases: string[] = [];
  const interrupts: Array<{ threadId: string; turnId: string }> = [];
  const deferred: unknown[] = [];
  let threadStarts = 0;
  let turnStarts = 0;
  let conversions = 0;
  let rawDisposals = 0;
  let pins = 0;
  let ends = 0;
  let registrationStarted = false;
  let nativeReturned = false;
  let conversionReturned = false;
  const gateway: CodexGateway = {
    async startThread() { threadStarts += 1; return "original-planner"; },
    async resumeThread() { throw new Error("A displaced Planner cannot be replaced"); },
    async startTurn(threadId, options) {
      turnStarts += 1;
      registrationStarted = true;
      try { await options.onStarted?.({ threadId, turnId: "original-turn" }); }
      catch (error) {
        // Match the real App Server's failure contract: reject registration
        // only after abandoning its genuinely started thread/turn pair.
        await gateway.interrupt(threadId, "original-turn");
        throw error;
      }
      nativeReturned = true;
      if (boundary === "needs_input") return { kind: "needs_input", threadId, turnId: "original-turn", request: {
        requestId: 1, threadId, turnId: "original-turn", itemId: "original-question", questions: [{ id: "scope",
          header: "Scope", question: "Which configuration should the plan inspect?", options: [], allowOther: true, secret: false }],
      } };
      return { kind: "completed", threadId, turnId: "original-turn", status: "completed", text: PLAN };
    },
    async normalizeInFork(options) {
      conversions += 1;
      await options.onStarted?.({ threadId: options.threadId, turnId: "private-conversion" });
      conversionReturned = true;
      return { kind: "completed", threadId: options.threadId, turnId: "private-conversion", status: "completed",
        text: JSON.stringify(boundary === "failed"
          ? { status: "failed", questions: [], assumptions: [], message: "The original task cannot be planned" }
          : { status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
    },
    async continueTurn(): Promise<never> { throw new Error("Answers must not be submitted in this commit race"); },
    async startReview(): Promise<never> { throw new Error("A Reviewer cannot start in this commit race"); },
    async interrupt(threadId, turnId) { interrupts.push({ threadId, turnId }); },
    async unsubscribeThread(threadId) { releases.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const owner = SessionId("planner-commit-owner");
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
        mode: "one-shot", label: "Original Planner" } as never);
      return run;
    },
  } as never);
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "",
    plannerEffort: "low", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config,
    undefined, undefined, undefined, {}, undefined, childFactory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const update = store.update.bind(store);
  let delayed = false;
  store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, opts?: Parameters<typeof update>[2]) => {
    // The fence wraps pure Planner record mutations. Its source marker only
    // excludes observer closures that own counters; the barrier is selected
    // by the independent gateway stage and proposed public phase change.
    if (!delayed && mutate.toString().includes("return mutate")) {
      const prior = await store.load(id);
      if (prior) {
        const candidate = structuredClone(prior);
        mutate(candidate);
        const matches = boundary === "registration" ? registrationStarted && !nativeReturned
          : boundary === "needs_input" ? nativeReturned && candidate.phase === "waiting_input"
            : conversionReturned && candidate.phase === (boundary === "ready" ? "executing" : "failed");
        if (matches) {
          delayed = true;
          commit.enter();
          await commit.promise;
        }
      }
    }
    return update<T>(id, mutate, opts);
  };
  const exec = { agent: parent, signal: new AbortController().signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext;
  const operation = manager.start({ task: "Plan the local diagnostic" }, exec);
  void operation.catch(() => undefined);
  const assertCleaned = () => {
    assert.deepEqual({ threadStarts, turnStarts, children: children.length, rawDisposals, pins, ends }, {
      threadStarts: 1, turnStarts: 1, children: 1, rawDisposals: 1, pins: 0, ends: 1,
    });
    assert.deepEqual(releases, ["original-planner"]);
    assert.equal(runtime.activeTurns.size, 0);
    assert.equal(runtime.pending.size, 0);
    assert.equal(runtime.plannerInputs.size, 0);
    assert.equal(runtime.recoverableRuns.size, 0);
    assert.equal(parentSession.snapshotEvents().filter((event) => event.type === "subagent/catalog").length, 1);
    assert.deepEqual(children[0]?.snapshotEvents().filter((event) => event.type === "turn/start").map((event) => event.data.turn), [1]);
    assert.equal(frames.filter((frame) => frame.type === "start").length, frames.filter((frame) => frame.type === "end").length,
      "the original native child stream settles once without replacement frames");
  };
  return { directory, store, manager, runtime, commit, operation, exec, deferred, interrupts, assertCleaned,
    get conversions() { return conversions; },
    async close() {
      commit.release(); await operation.catch(() => undefined); await manager.stop(); childFactory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const cases: Array<{ boundary: Boundary; drift: Drift }> = [
  { boundary: "ready", drift: "owner" },
  { boundary: "ready", drift: "cwd" },
  { boundary: "needs_input", drift: "phase" },
  { boundary: "failed", drift: "owner" },
  { boundary: "registration", drift: "cwd" },
  { boundary: "ready", drift: "stop" },
];

for (const { boundary, drift } of cases) test(`Planner ${boundary} transaction rejects ${drift} winning its final write barrier`, async () => {
  const f = await fixture(boundary);
  try {
    const settled = Promise.allSettled([f.operation]);
    await Promise.race([f.commit.entered, f.operation.then(() => { throw new Error("Planner settled before the transaction barrier"); })]);
    const original = (await f.store.list())[0];
    assert.ok(original);
    let replacement: WorkflowRecord | undefined;
    let stopping: Promise<void> | undefined;
    if (drift === "stop") {
      let stopped = false;
      stopping = f.manager.stop().then(() => { stopped = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopped, false, "stop must await the admitted Planner write operation");
    } else {
      replacement = (await f.store.update(original.id, (record) => {
        if (drift === "owner") record.dshSessionId = "replacement-owner";
        if (drift === "cwd") record.cwd = join(f.directory, "replacement-workspace");
        if (drift === "phase") record.phase = "passed";
        record.lastProgressMessage = "REPLACEMENT-PROGRESS-SENTINEL";
      })).record;
    }
    f.commit.release();
    const [result] = await settled;
    if (stopping) await stopping;
    assert.equal(result?.status, "rejected");
    const current = await f.store.load(original.id);
    assert.ok(current);
    if (replacement) assert.deepEqual(current, replacement, "the transaction guard cannot rewrite the replacement owner's record");
    assert.equal(current.planMarkdown, undefined);
    assert.equal(current.retryState, undefined);
    assert.deepEqual(f.deferred, []);
    assert.equal(f.conversions, boundary === "needs_input" || boundary === "registration" ? 0 : 1);
    if (boundary === "registration") assert.deepEqual(f.interrupts, [{ threadId: "original-planner", turnId: "original-turn" }]);
    f.assertCleaned();
  } finally { await f.close(); }
});

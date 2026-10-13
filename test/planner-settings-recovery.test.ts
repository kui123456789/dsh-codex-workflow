import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";

const PLAN = "<proposed_plan>\n# Goal\nPreserve the user's Planner settings during recovery.\n# Changes\n- Persist the effective model and reasoning effort before any interruption.\n- Reuse these settings on automatic and manual continuation.\n# Verification\n- Check failed turns, interrupted turns, SQLite reopen and legacy records.\n# Risks\n- Recovery must keep the original thread and child session.\n</proposed_plan>";

type PlannerSettingsRecord = WorkflowRecord & { plannerEffort?: WorkflowConfig["plannerEffort"] };
type Scenario = "fail_twice" | "abort_after_thread" | "abort_on_started" | "transient_once" | "short_reply";
type Settings = { model: string | undefined; effort: WorkflowConfig["plannerEffort"] | undefined };

function settings(record: PlannerSettingsRecord | undefined): Settings {
  return { model: record?.plannerModel, effort: record?.plannerEffort };
}

async function fixture(options: {
  scenario?: Scenario;
  configuredModel?: string;
  configuredEffort?: WorkflowConfig["plannerEffort"];
  resolvedModel?: string;
  resolvedAtTurn?: number;
  transientBudgetMs?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-planner-settings-recovery-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const controller = new AbortController();
  const scenario = options.scenario ?? "fail_twice";
  const turns: Array<Settings & { threadId: string }> = [];
  const threadOptions: Array<Parameters<CodexGateway["startThread"]>[0]> = [];
  const conversions: Array<{ model?: string; threadId: string }> = [];
  const conversionTurns: Array<Settings & { threadId: string; conversion?: boolean }> = [];
  const continuations: string[] = [];
  const retryDelays: number[] = [];
  let retryClock = 0;
  let children = 0;
  // Exercise the real conversion's settings without starting a subprocess.
  // The transport seam records exactly what normalizeInThread sends.
  const converter = new CodexAppServerClient({ command: "must-not-launch-a-model", requestTimeoutMs: 1000, idleProcessMs: 0 });
  converter.startTurn = async (threadId, input) => {
    conversionTurns.push({ threadId, model: input.model, effort: input.effort, conversion: input.conversion });
    const turnId = `conversion-turn-${conversionTurns.length}`;
    await input.onStarted?.({ threadId, turnId });
    return { kind: "completed", threadId, turnId, status: "completed",
      text: JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] }) };
  };
  const gateway: CodexGateway = {
    async startThread(input) {
      threadOptions.push({ ...input });
      if (scenario === "abort_after_thread") controller.abort(new Error("operation aborted"));
      return threadOptions.length === 1 ? "original-planner" : `independent-planner-${threadOptions.length}`;
    },
    async resumeThread() { throw new Error("Original-thread recovery must not use thread/resume"); },
    async startTurn(threadId, input) {
      turns.push({ threadId, model: input.model, effort: input.effort });
      const turnId = `planner-turn-${turns.length}`;
      if (options.resolvedModel && turns.length === (options.resolvedAtTurn ?? 1)) input.onModel?.(options.resolvedModel);
      await input.onStarted?.({ threadId, turnId });
      if (scenario === "abort_on_started" && turns.length === 1) {
        controller.abort(new Error("operation aborted"));
        throw new Error("operation aborted");
      }
      if (scenario === "fail_twice" && turns.length <= 2) {
        return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
      }
      if (scenario === "transient_once" && turns.length === 1) {
        return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "stream disconnected before completion" };
      }
      if (scenario === "short_reply" && turns.length === 1) {
        return { kind: "completed", threadId, turnId, status: "completed", text: "Acknowledged; I will produce the plan." };
      }
      return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
    },
    async normalizeInFork(input, signal) {
      conversions.push({ threadId: input.threadId, ...(input.model ? { model: input.model } : {}) });
      assert.equal(input.sourceEphemeral, true, "The test must not take a subprocess or thread/fork path");
      return converter.normalizeInFork(input, signal);
    },
    async continueTurn(): Promise<TurnWaitResult> { throw new Error("Native clarification is outside this regression"); },
    async startReview(): Promise<never> { throw new Error("Reviewer is outside this regression"); },
    async interrupt() {},
    async unsubscribeThread() {},
    isThreadAvailable: () => true,
    beginRound() {},
    endRound() {},
  };
  const owner = SessionId("planner-settings-owner");
  const session = Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, delegationDepth: 0, isSeeded: false });
  const exec = (signal = new AbortController().signal, id: string = owner) => {
    const agentId = SessionId(id);
    const agentSession = agentId === owner ? session : Session.create(agentId, [], {
      version: SESSION_FORMAT_VERSION, id: agentId, createdAt: Date.now(), cwd: directory,
      delegationDepth: 0, isSeeded: false,
    });
    return { agent: { id: agentId, session: agentSession } as Agent, signal, deferContext() {} } as unknown as ToolRunContext;
  };
  const childFactory = { create: async () => {
    children += 1;
    return { id: `original-child-${children}`, session, beginContinuation(instruction) { continuations.push(instruction); }, failAttempt() {},
      progress() {}, finish() {}, async dispose() {} } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "off", plannerModel: options.configuredModel ?? "model-B", reviewerModel: "",
    plannerEffort: options.configuredEffort ?? "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: options.transientBudgetMs ?? 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory,
  };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {
    now: () => retryClock,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); retryDelays.push(ms); retryClock += ms; },
  }, undefined, childFactory);
  const reopened = async (id: string) => {
    const reader = new WorkflowStore(store.directory);
    try {
      const record = await reader.load(id);
      const raw = reader.coordinationHandle.loadWorkflow(id);
      assert.ok(raw, "The record must exist in SQLite before a new storage handle reads it");
      return { record, envelope: JSON.parse(raw.recordJson) as {
        schemaVersion: number; planning: { plannerModel?: string; plannerEffort?: string };
      } };
    } finally { reader.close(); }
  };
  const assertOriginalResources = () => {
    assert.equal(threadOptions.length, 1, "Recovery must not create a replacement Planner thread");
    assert.equal(children, 1, "Recovery must not create a replacement child session");
    assert.ok(turns.every((turn) => turn.threadId === "original-planner"));
  };
  return { manager, store, exec, controller, config, turns, threadOptions, conversions, conversionTurns,
    continuations, retryDelays, reopened, assertOriginalResources,
    async close() { await manager.stop(); await converter.stop(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function assertDurableSettings(snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["reopened"]>>, expected: Settings) {
  assert.deepEqual(settings(snapshot.record), expected, "SQLite reopen must retain the effective Planner settings");
  assert.equal(snapshot.envelope.schemaVersion, 2);
  assert.deepEqual({ model: snapshot.envelope.planning.plannerModel, effort: snapshot.envelope.planning.plannerEffort },
    expected, "Both settings belong to the durable planning schema");
}

function legacyRecovery(f: Awaited<ReturnType<typeof fixture>>, record: WorkflowRecord): void {
  const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const recovery = runtime.recoverableRuns.get(record.id);
  assert.ok(recovery && record.retryState);
  // Old live handles predate both the durable stage marker and cached outputs.
  // Removing settings from a current checkpoint instead represents drift.
  delete recovery.plannerCheckpoint;
  const { plannerCheckpoint: _checkpoint, ...legacyState } = record.retryState;
  record.retryState = legacyState;
  recovery.state = legacyState;
}

test("failed Planner retains explicit model and effort for automatic and manual original-thread continuation", async () => {
  const f = await fixture();
  try {
    const waiting = await f.manager.start({ task: "Plan recovery", plannerModel: "model-A", plannerEffort: "low" }, f.exec());
    assert.equal(waiting.processState, "waiting");
    const parked = await f.reopened(waiting.id);
    const resumed = await f.manager.resume(waiting.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    f.assertOriginalResources();
    assert.deepEqual(f.turns.map(({ model, effort }) => ({ model, effort })), [
      { model: "model-A", effort: "low" }, { model: "model-A", effort: "low" }, { model: "model-A", effort: "low" },
    ], "Every visible turn must preserve the user-selected settings despite different defaults");
    const expected = { model: "model-A", effort: "low" } as const;
    assert.deepEqual(settings(waiting), expected);
    assertDurableSettings(parked, expected);
    assert.deepEqual(settings(resumed), expected);
    assertDurableSettings(await f.reopened(waiting.id), expected);
    assert.deepEqual(f.conversions, [{ threadId: "original-planner", model: "model-A" }]);
  } finally { await f.close(); }
});

test("Plan-mode model notification survives generic failure and pins both continuations to the resolved model", async () => {
  const f = await fixture({ configuredModel: "", resolvedModel: "resolved-plan-model" });
  try {
    const waiting = await f.manager.start({ task: "Plan recovery", plannerEffort: "low" }, f.exec());
    assert.equal(waiting.processState, "waiting");
    const parked = await f.reopened(waiting.id);
    const resumed = await f.manager.resume(waiting.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    f.assertOriginalResources();
    assert.deepEqual(f.turns.map(({ model, effort }) => ({ model, effort })), [
      { model: undefined, effort: "low" },
      { model: "resolved-plan-model", effort: "low" },
      { model: "resolved-plan-model", effort: "low" },
    ], "The client's first model selection must survive before a successful outcome exists");
    const expected = { model: "resolved-plan-model", effort: "low" } as const;
    assert.deepEqual(settings(waiting), expected);
    assertDurableSettings(parked, expected);
    assert.deepEqual(settings(resumed), expected);
    assertDurableSettings(await f.reopened(waiting.id), expected);
    assert.deepEqual(f.conversions, [{ threadId: "original-planner", model: "resolved-plan-model" }]);
  } finally { await f.close(); }
});

for (const scenario of ["abort_after_thread", "abort_on_started"] as const) {
  test(`${scenario} retains user-selected model and effort before manual original-thread recovery`, async () => {
    const f = await fixture({ scenario });
    try {
      const waiting = await f.manager.start({ task: "Plan recovery", plannerModel: "model-A", plannerEffort: "low" },
        f.exec(f.controller.signal));
      assert.equal(waiting.processState, "waiting");
      assert.equal(waiting.phase, "planning");
      const parked = await f.reopened(waiting.id);
      const resumed = await f.manager.resume(waiting.id, undefined, f.exec());
      assert.equal(resumed.phase, "executing");
      f.assertOriginalResources();
      assert.equal(f.threadOptions[0]?.model, "model-A");
      assert.equal(f.turns.length, scenario === "abort_after_thread" ? 1 : 2);
      assert.ok(f.turns.every(({ model, effort }) => model === "model-A" && effort === "low"),
        `An interrupted start must not switch to config defaults on resume: ${JSON.stringify(f.turns)}`);
      const expected = { model: "model-A", effort: "low" } as const;
      assert.deepEqual(settings(waiting), expected);
      assertDurableSettings(parked, expected);
      assert.deepEqual(settings(resumed), expected);
      assertDurableSettings(await f.reopened(waiting.id), expected);
      assert.deepEqual(f.conversions, [{ threadId: "original-planner", model: "model-A" }]);
    } finally { await f.close(); }
  });
}

for (const legacyModel of [undefined, "legacy-model"] as const) {
  test(`legacy Planner without effort${legacyModel ? " keeps its persisted model" : " or model uses configured defaults"}`, async () => {
    const f = await fixture();
    try {
      const waiting = await f.manager.start({ task: "Plan recovery" }, f.exec());
      assert.equal(waiting.processState, "waiting");
      const legacy = { ...waiting } as PlannerSettingsRecord;
      delete legacy.plannerEffort;
      delete legacy.plannerModel;
      if (legacyModel) legacy.plannerModel = legacyModel;
      legacyRecovery(f, legacy);
      f.store.coordinationHandle.saveWorkflow(waiting.id, JSON.stringify(legacy));
      const parked = await f.reopened(waiting.id);
      assert.deepEqual(settings(parked.record), { model: legacyModel, effort: undefined },
        "Legacy flat storage must remain readable without requiring new settings fields");
      const resumed = await f.manager.resume(waiting.id, undefined, f.exec());
      assert.equal(resumed.phase, "executing");
      f.assertOriginalResources();
      assert.deepEqual(f.turns.at(-1), { threadId: "original-planner", model: legacyModel ?? "model-B", effort: "high" });
      assert.equal(resumed.plannerModel, legacyModel ?? "model-B");
      assert.deepEqual(f.conversions, [{ threadId: "original-planner", model: legacyModel ?? "model-B" }]);
    } finally { await f.close(); }
  });
}

test("config-selected Planner settings remain fixed during recovery while a new task uses changed defaults", async () => {
  const f = await fixture({ configuredEffort: "low" });
  try {
    const waiting = await f.manager.start({ task: "Plan recovery with defaults" }, f.exec());
    assert.equal(waiting.processState, "waiting");
    assertDurableSettings(await f.reopened(waiting.id), { model: "model-B", effort: "low" });
    f.config.plannerModel = "model-C";
    f.config.plannerEffort = "high";
    const resumed = await f.manager.resume(waiting.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    f.assertOriginalResources();
    assert.deepEqual(f.turns.map(({ model, effort }) => ({ model, effort })), [
      { model: "model-B", effort: "low" }, { model: "model-B", effort: "low" }, { model: "model-B", effort: "low" },
    ], "Changing global settings must not reconfigure an already admitted Planner");
    assertDurableSettings(await f.reopened(waiting.id), { model: "model-B", effort: "low" });
    const independent = await f.manager.start({ task: "Plan a separate task" }, f.exec(undefined, "independent-owner"));
    assert.equal(independent.phase, "executing");
    assert.notEqual(independent.id, waiting.id);
    assert.deepEqual(f.turns.at(-1), { threadId: "independent-planner-2", model: "model-C", effort: "high" });
    assert.equal(f.threadOptions[1]?.model, "model-C");
    assertDurableSettings(await f.reopened(independent.id), { model: "model-C", effort: "high" });
    assertDurableSettings(await f.reopened(waiting.id), { model: "model-B", effort: "low" });
  } finally { await f.close(); }
});

test("a transient stream retry within the same wrapper pins the first client-resolved model", async () => {
  const f = await fixture({ scenario: "transient_once", configuredModel: "", resolvedModel: "model-A", transientBudgetMs: 3 });
  try {
    const result = await f.manager.start({ task: "Plan with a temporary stream failure", plannerEffort: "medium" }, f.exec());
    assert.equal(result.phase, "executing");
    f.assertOriginalResources();
    assert.deepEqual(f.retryDelays, [1], "This must exercise the existing transient backoff wrapper");
    assert.deepEqual(f.continuations, [], "A successful bounded transient retry must not consume a continuation turn");
    assert.deepEqual(f.turns, [
      { threadId: "original-planner", model: undefined, effort: "medium" },
      { threadId: "original-planner", model: "model-A", effort: "medium" },
    ], "Capture options before onModel so a mutation cannot rewrite the first request's evidence");
    assertDurableSettings(await f.reopened(result.id), { model: "model-A", effort: "medium" });
    assert.deepEqual(f.conversions, [{ threadId: "original-planner", model: "model-A" }]);
    assert.deepEqual(f.conversionTurns, [{ threadId: "original-planner", model: "model-A", effort: "low", conversion: true }]);
  } finally { await f.close(); }
});

test("legacy blank-model resume captures its new model selection for conversion and durable settings", async () => {
  const f = await fixture({ configuredModel: "", resolvedModel: "model-A", resolvedAtTurn: 3 });
  try {
    const waiting = await f.manager.start({ task: "Plan legacy recovery" }, f.exec());
    assert.equal(waiting.processState, "waiting");
    const legacy = { ...waiting } as PlannerSettingsRecord;
    delete legacy.plannerModel;
    delete legacy.plannerEffort;
    legacyRecovery(f, legacy);
    f.store.coordinationHandle.saveWorkflow(waiting.id, JSON.stringify(legacy));
    assert.deepEqual(settings((await f.reopened(waiting.id)).record), { model: undefined, effort: undefined });
    const resumed = await f.manager.resume(waiting.id, undefined, f.exec());
    assert.equal(resumed.phase, "executing");
    f.assertOriginalResources();
    assert.deepEqual(f.turns.at(-1), { threadId: "original-planner", model: undefined, effort: "high" },
      "The legacy resume must first ask the client to resolve an unspecified model");
    assert.deepEqual(f.conversions, [{ threadId: "original-planner", model: "model-A" }]);
    assert.deepEqual(f.conversionTurns, [{ threadId: "original-planner", model: "model-A", effort: "low", conversion: true }]);
    assertDurableSettings(await f.reopened(waiting.id), { model: "model-A", effort: "high" });
  } finally { await f.close(); }
});

test("deleting current Planner settings cannot turn its retained checkpoint into a legacy fallback", async () => {
  const f = await fixture();
  try {
    const waiting = await f.manager.start({ task: "Keep the admitted Planner settings", plannerModel: "model-A", plannerEffort: "low" }, f.exec());
    const runtime = (f.manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    const recovery = runtime.recoverableRuns.get(waiting.id);
    assert.ok(recovery?.plannerCheckpoint && waiting.retryState?.plannerCheckpoint);
    await f.store.update(waiting.id, (record) => {
      record.plannerModel = undefined;
      record.plannerEffort = undefined;
    });
    const displaced = await f.store.load(waiting.id);
    const count = f.turns.length;
    assert.deepEqual((await f.manager.status(waiting.id, f.exec())).continuation,
      { available: false, reason: "identity_changed" });
    await assert.rejects(f.manager.resume(waiting.id, "Continue original planning", f.exec()), /checkpoint lost its scope/);
    assert.deepEqual(await f.store.load(waiting.id), displaced);
    assert.equal(f.turns.length, count);
    assert.equal(runtime.recoverableRuns.get(waiting.id), recovery);
    f.assertOriginalResources();
  } finally { await f.close(); }
});

test("controlled completion after a short reply retains visible effort while conversion stays low", async () => {
  const f = await fixture({ scenario: "short_reply" });
  try {
    const planned = await f.manager.start({ task: "Produce a complete plan", plannerModel: "model-A", plannerEffort: "medium" }, f.exec());
    assert.equal(planned.phase, "executing");
    f.assertOriginalResources();
    assert.deepEqual(f.turns, [
      { threadId: "original-planner", model: "model-A", effort: "medium" },
      { threadId: "original-planner", model: "model-A", effort: "medium" },
    ], "The controlled completion is part of the admitted Planner, so its visible effort stays fixed");
    assert.deepEqual(f.conversions, [
      { threadId: "original-planner", model: "model-A" }, { threadId: "original-planner", model: "model-A" },
    ]);
    assert.deepEqual(f.conversionTurns, [
      { threadId: "original-planner", model: "model-A", effort: "low", conversion: true },
      { threadId: "original-planner", model: "model-A", effort: "low", conversion: true },
    ], "Exercise real conversion method options independently from the visible completion effort");
    assert.deepEqual(f.retryDelays, []);
    assertDurableSettings(await f.reopened(planned.id), { model: "model-A", effort: "medium" });
  } finally { await f.close(); }
});

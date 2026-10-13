import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const PLAN = "<proposed_plan>\n# Goal\nImplement a read-only local health command.\n# Changes\n- Read configuration through explicit adapters without modifying data.\n# Verification\n- Check valid, missing and invalid local configuration.\n# Risks\n- Avoid initializing storage during diagnostics.\n</proposed_plan>";
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Approved read-only health behavior is verified.";
type ModelCall = { threadId: string; model: string | undefined; effort: string | undefined; modelPresent: boolean };

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
    timer = setTimeout(() => reject(new Error("Original Reviewer did not reach its first model boundary")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(options: { configuredModel?: string; resolvedModel?: string; holdFirst?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-reviewer-settings-recovery-"));
  await writeFile(join(directory, "changed.txt"), "health implementation v1", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const firstNative = gate();
  const owner = SessionId("reviewer-settings-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  const children: Array<{ session: Session; kind: "planner" | "reviewer" }> = [];
  const disposed: string[] = [];
  const reviewerThreads: string[] = [];
  const privateThreads: string[] = [];
  const creates: Array<{ threadId: string; model?: string }> = [];
  const calls: ModelCall[] = [];
  const conversions: Array<ModelCall & { kind: "planner" | "reviewer" | "alignment"; conversion: boolean | undefined }> = [];
  const available = new Set<string>();
  const released: string[] = [];
  let resolvedModel = options.resolvedModel;
  let failures = 2;
  let turns = 0;
  let pins = 0;
  let creatingKind: "planner" | "reviewer" = "planner";
  // Exercise the actual SDK's normalization settings; only its transport is
  // replaced, so a conversion must send the real low-effort turn parameters.
  const converter = new CodexAppServerClient({ command: "must-not-launch-a-model", requestTimeoutMs: 1000, idleProcessMs: 0 });
  converter.startTurn = async (threadId, input) => {
    const properties = (input.outputSchema?.properties ?? {}) as Record<string, unknown>;
    const kind = "status" in properties ? "planner" : "aligned" in properties ? "alignment" : "reviewer";
    conversions.push({ threadId, model: input.model, effort: input.effort,
      modelPresent: Object.hasOwn(input, "model"), conversion: input.conversion, kind });
    const turnId = `sdk-conversion-${++turns}`;
    await input.onStarted?.({ threadId, turnId });
    const text = kind === "planner" ? JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] })
      : kind === "alignment" ? JSON.stringify({ aligned: true, conflicts: [] })
        : JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Approved read-only health behavior is verified" });
    return { kind: "completed", threadId, turnId, status: "completed", text };
  };
  const runReview = async (threadId: string, input: Pick<Parameters<CodexGateway["startTurn"]>[1], "onStarted" | "onProgress" | "model" | "effort">) => {
    calls.push({ threadId, model: input.model, effort: input.effort, modelPresent: Object.hasOwn(input, "model") });
    const turnId = `reviewer-visible-${++turns}`;
    await input.onStarted?.({ threadId, turnId });
    if (calls.length === 1) { firstNative.enter(); if (options.holdFirst) await firstNative.promise; }
    if (failures > 0) { failures -= 1; return { kind: "completed" as const, threadId, turnId, status: "failed" as const,
      text: "", reason: "turn failed" }; }
    input.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
    return { kind: "completed" as const, threadId, turnId, status: "completed" as const, text: REVIEW };
  };
  const gateway: CodexGateway = {
    async startThread(input) {
      const id = input.name?.startsWith("DSH Review") ? `settings-private-${privateThreads.length + 1}` : "original-settings-planner";
      if (input.name?.startsWith("DSH Review")) privateThreads.push(id);
      available.add(id); return id;
    },
    async startReviewerThread(input) {
      const id = `settings-reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id); creates.push({ threadId: id, ...(input.model ? { model: input.model } : {}) });
      available.add(id); return id;
    },
    async resumeThread(): Promise<never> { throw new Error("Settings recovery must stay on the original ephemeral thread"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in these settings fixtures"); },
    async resolveDefaultModel() { return resolvedModel; },
    async startTurn(threadId, input) {
      if (!input.planMode) return runReview(threadId, input);
      const turnId = `planner-visible-${++turns}`;
      input.onModel?.(input.model ?? "planner-model");
      await input.onStarted?.({ threadId, turnId });
      return { kind: "completed", threadId, turnId, status: "completed", text: PLAN };
    },
    async startReview(input) { return { threadId: input.threadId, result: await runReview(input.threadId, input) }; },
    async normalizeInFork(input, signal) { return converter.normalizeInFork(input, signal); },
    async interrupt() {},
    async unsubscribeThread(id) { released.push(id); assert.ok(available.delete(id), "each subscription releases once"); },
    isThreadAvailable: (id) => available.has(id),
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (input: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const child = Session.create(input.sessionId, [], { version: SESSION_FORMAT_VERSION, id: input.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...input.meta });
    children.push({ session: child, kind: creatingKind });
    return { agent: { id: child.id, session: child } as Agent, async dispose() { disposed.push(child.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, input: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      creatingKind = input.label.includes("Reviewer") ? "reviewer" : "planner";
      return provider.start({ ...input, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: input.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "planner-model", reviewerModel: options.configuredModel ?? "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    leaseTtlMs: 10000, turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, undefined, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const planned = await manager.start({ task: "Implement read-only local health diagnostics" }, exec);
  assert.equal(planned.phase, "executing");
  assert.equal(planned.reviewerModel, undefined, "the planned workflow initially captures Planner choices only");
  assert.equal(planned.reviewerEffort, undefined);
  const input = { implementationSummary: "Health diagnostics implemented", changedFiles: ["changed.txt"], testResults: "Fixture verified" };
  return { directory, store, manager, runtime, planned, input, exec, config, calls, conversions, creates, reviewerThreads,
    firstNative, children, disposed, released,
    setResolvedModel(model: string | undefined) { resolvedModel = model; },
    reviewerChildren() { return children.filter((child) => child.kind === "reviewer"); },
    async wait() {
      const waiting = await manager.review(planned.id, input, exec);
      assert.equal(waiting.processState, "waiting"); return waiting;
    },
    assertOriginalIdentities() {
      assert.equal(reviewerThreads.length, 1);
      assert.equal(children.filter((child) => child.kind === "reviewer").length, 1);
      assert.deepEqual([...new Set(calls.map((call) => call.threadId))], reviewerThreads);
    },
    async close() {
      firstNative.release(); await manager.stop(); await converter.stop(); factory.unregisterProvider(); store.close();
      assert.equal(pins, 0);
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("planned Reviewer manual recovery preserves configured or resolved original settings after global config changes", async () => {
  for (const selection of ["configured", "resolved"] as const) {
    const model = selection === "configured" ? "model-A" : "resolved-model-A";
    const f = await fixture({ configuredModel: selection === "configured" ? model : "", resolvedModel: model });
    try {
      const waiting = await f.wait();
      const originalChild = f.reviewerChildren()[0]!.session;
      assert.deepEqual(f.calls.map(({ model, effort }) => ({ model, effort })), Array(2).fill({ model, effort: "low" }));
      f.config.reviewerModel = "new-global-model-B"; f.config.reviewerEffort = "high";
      f.setResolvedModel("new-default-model-B");
      const completed = await f.manager.resume(waiting.id, "Continue original review", f.exec);
      assert.equal(completed.phase, "passed");
      assert.equal(completed.reviewCycles, 1);
      assert.deepEqual(f.calls.at(-1), { threadId: f.reviewerThreads[0]!, model, effort: "low", modelPresent: true });
      const reviewConversions = f.conversions.filter((call) => call.kind !== "planner");
      assert.equal(reviewConversions.length, 2);
      assert.ok(reviewConversions.every((call) => call.effort === "low" && call.conversion === true));
      assert.ok(reviewConversions.every((call) => call.model === model), "private validation uses the captured review model");
      f.assertOriginalIdentities();
      assert.equal(f.disposed.filter((id) => id === originalChild.id).length, 1);
    } finally { await f.close(); }
  }
});

test("automatic Reviewer continuation preserves its initial effort when configuration changes during the first model", async () => {
  const f = await fixture({ holdFirst: true });
  const reviewing = f.manager.review(f.planned.id, f.input, f.exec);
  const settled = Promise.allSettled([reviewing]);
  try {
    await waitStarted(f.firstNative);
    assert.equal(f.calls[0]?.effort, "low");
    f.config.reviewerEffort = "high";
    f.firstNative.release();
    assert.equal((await settled)[0]?.status, "fulfilled");
    assert.deepEqual(f.calls.map((call) => call.effort), ["low", "low"]);
    f.assertOriginalIdentities();
    assert.equal(f.disposed.filter((id) => id === f.reviewerChildren()[0]!.session.id).length, 0);
  } finally { f.firstNative.release(); await settled; await f.close(); }
});

test("an originally omitted Reviewer model stays omitted during recovery when a new global default appears", async () => {
  const f = await fixture({ configuredModel: "" });
  try {
    const waiting = await f.wait();
    assert.equal(f.creates[0]?.model, undefined);
    assert.ok(f.calls.every((call) => call.model === undefined));
    f.config.reviewerModel = "new-global-model-B"; f.config.reviewerEffort = "high";
    f.setResolvedModel("new-default-model-B");
    const completed = await f.manager.resume(waiting.id, "Continue original review", f.exec);
    assert.equal(completed.phase, "passed");
    assert.deepEqual(f.calls.at(-1), { threadId: f.reviewerThreads[0]!, model: undefined, effort: "low", modelPresent: false });
    assert.ok(f.conversions.filter((call) => call.kind !== "planner")
      .every((call) => call.model === undefined && !call.modelPresent && call.effort === "low"));
    f.assertOriginalIdentities();
  } finally { await f.close(); }
});

test("an explicit changed-workspace Reviewer round may select new settings while cleaning the previous original round", async () => {
  const f = await fixture();
  try {
    const waiting = await f.wait();
    const firstChild = f.reviewerChildren()[0]!.session;
    f.config.reviewerModel = "new-global-model-B"; f.config.reviewerEffort = "high";
    await writeFile(join(f.directory, "changed.txt"), "verified health implementation v2", "utf8");
    const completed = await f.manager.review(waiting.id, { ...f.input, implementationSummary: "Updated health implementation v2" }, f.exec);
    assert.equal(completed.phase, "passed");
    assert.equal(completed.reviewCycles, 1);
    assert.equal(f.reviewerThreads.length, 2);
    assert.equal(f.reviewerChildren().length, 2);
    assert.deepEqual(f.calls.at(-1), { threadId: f.reviewerThreads[1]!, model: "new-global-model-B", effort: "high", modelPresent: true });
    assert.equal(f.disposed.filter((id) => id === firstChild.id).length, 1);
    assert.equal(f.released.filter((id) => id === f.reviewerThreads[0]!).length, 1);
    assert.ok(f.conversions.filter((call) => call.kind !== "planner").every((call) => call.effort === "low"));
  } finally { await f.close(); }
});

test("a legacy planned Reviewer without captured settings cannot resume using a new global configuration", async () => {
  const f = await fixture();
  try {
    const waiting = await f.wait();
    const recovery = f.runtime.recoverableRuns.get(waiting.id)!;
    const child = f.reviewerChildren()[0]!.session;
    Reflect.deleteProperty(recovery, "reviewerSettings");
    const before = (await f.store.load(waiting.id))!;
    const calls = f.calls.length;
    f.config.reviewerModel = "new-global-model-B";
    f.config.reviewerEffort = "high";
    const status = await f.manager.status(waiting.id, f.exec);
    assert.deepEqual(status.continuation, { available: false, reason: "handle_unavailable" });
    await assert.rejects(f.manager.resume(waiting.id, "Continue original review", f.exec), /settings|configuration|original.*unavailable/i);
    assert.deepEqual(await f.store.load(waiting.id), before);
    assert.equal(f.runtime.recoverableRuns.get(waiting.id), recovery);
    assert.equal(f.runtime.codexChildSessions.get(waiting.id), recovery.child);
    assert.equal(f.calls.length, calls);
    f.assertOriginalIdentities();
    assert.equal(f.disposed.filter((id) => id === child.id).length, 0);
  } finally { await f.close(); }
});

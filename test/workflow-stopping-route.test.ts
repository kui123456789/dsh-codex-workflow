import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewInput, ReviewResult, TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway } from "../src/workflow.js";

const PLAN = "<proposed_plan>\n# Goal\nImplement a read-only local configuration diagnostic.\n# Changes\n- Read the current workspace configuration and report its validity.\n- Keep user files and settings intact.\n# Verification\n- Check valid and missing configuration and report deterministic errors.\n# Risks\n- Do not initialize storage while inspecting configuration.\n</proposed_plan>";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture(controls: { childFailure?: boolean; bridge?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-workflow-stopping-route-"));
  await writeFile(join(directory, "changed.txt"), "verified configuration diagnostic", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const callbackGate = gate();
  const threads: Array<{ id: string; role: "planning" | "reviewing" | "alignment" }> = [];
  const calls: Array<{ api: "turn" | "review" | "normalize"; threadId: string; prompt: string }> = [];
  const children: Session[] = [];
  const disposals: string[] = [];
  const releases: string[] = [];
  const steers: string[] = [];
  const deferred: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  let plannerFailures = 0;
  let reviewFailures = 0;
  let throwChild = controls.childFailure ?? false;
  let verdict: ReviewResult["verdict"] = "pass";
  let pins = 0;
  const result = (): ReviewResult => verdict === "pass"
    ? { verdict, findings: [], testGaps: [], summary: "Approved configuration diagnostic is verified" }
    : { verdict, findings: [{ severity: "high", blocking: true, title: "Missing configuration is accepted",
      body: "changed.txt accepts missing input; the reproducible diagnostic returns success instead of the expected error.", file: "changed.txt" }],
      testGaps: [], summary: "Fix the missing-input diagnostic" };
  const run = async (threadId: string, prompt: string, api: "turn" | "review",
    options: Pick<Parameters<CodexGateway["startTurn"]>[1], "onStarted" | "onProgress">): Promise<TurnWaitResult> => {
    calls.push({ api, threadId, prompt });
    const turnId = `visible-${calls.length}`;
    await options.onStarted?.({ threadId, turnId });
    const planning = threads.find((thread) => thread.id === threadId)?.role === "planning";
    if (planning && plannerFailures > 0) {
      plannerFailures -= 1;
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    if (!planning && reviewFailures > 0) {
      reviewFailures -= 1;
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    const text = planning ? PLAN : verdict === "pass"
      ? "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Approved configuration diagnostic is verified."
      : "VERDICT: changes_requested\nFINDINGS: changed.txt incorrectly accepts missing configuration; the reproducible diagnostic returns success instead of the expected error.\nTEST GAPS: none\nSUMMARY: Fix the missing-input diagnostic.";
    options.onProgress?.({ kind: "message", itemId: turnId, text });
    return { kind: "completed", threadId, turnId, status: "completed", text };
  };
  const gateway: CodexGateway = {
    async startThread(options) {
      const role = options.name?.startsWith("DSH Review Alignment") ? "alignment" : "planning";
      const id = `${role}-${threads.length + 1}`; threads.push({ id, role }); return id;
    },
    async startReviewerThread() { const id = `reviewing-${threads.length + 1}`; threads.push({ id, role: "reviewing" }); return id; },
    async resumeThread() { throw new Error("Ephemeral recovery must use the original available thread"); },
    async startTurn(threadId, options) { return run(threadId, options.prompt, "turn", options); },
    async startReview(options) {
      return { threadId: options.threadId, result: await run(options.threadId, String(options.target.instructions ?? ""), "review", options) };
    },
    async normalizeInFork(options) {
      calls.push({ api: "normalize", threadId: options.threadId, prompt: options.prompt });
      const text = options.prompt.includes("REVIEW AUTHORITY checker") ? JSON.stringify({ aligned: true, conflicts: [] })
        : options.prompt.startsWith("Convert the readable code review") ? JSON.stringify(result())
          : JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] });
      return { kind: "completed", threadId: options.threadId, turnId: `private-${calls.length}`, status: "completed", text };
    },
    async continueTurn(): Promise<never> { throw new Error("The stopping-route fixture has no clarification"); },
    async interrupt() {},
    async unsubscribeThread(threadId) { releases.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; },
  };
  const id = SessionId("stopping-route-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }),
  steer(message: { content: Array<{ text?: string }> }) { steers.push(message.content[0]?.text ?? ""); } } as unknown as Agent;
  const exec = () => ({ agent: parent, signal: new AbortController().signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext);
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    if (throwChild) { throwChild = false; throw new Error("injected review-only startup failure"); }
    const session = Session.create(options.sessionId, [], { version: SESSION_FORMAT_VERSION, id: options.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...options.meta });
    children.push(session);
    return { agent: { id: session.id, session } as Agent, async dispose() { disposals.push(session.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const callback: CodexCallback = { async send() {
    callbackGate.enter(); await callbackGate.promise; return { kind: "verdict", verdict: result() };
  }, cancel() {}, cancelSubmission() {}, async stop() { callbackGate.release(); } };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "planning-model",
    reviewerModel: "reviewing-model", plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, controls.bridge ? callback : undefined,
    controls.bridge ? { async enqueue(command) { return command.requestId; } } : undefined, undefined, {},
    { get: (sessionId) => sessionId === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const input: ReviewInput = { implementationSummary: "Read-only configuration diagnostic implemented",
    changedFiles: ["changed.txt"], testResults: "Valid and missing input verified" };
  const track = <T>(task: Promise<T>) => { tasks.push(task); void task.catch(() => undefined); return task; };
  const start = () => track(manager.start({ task: "Implement a read-only configuration diagnostic" }, exec()));
  const reviewOnly = () => track(manager.reviewOnly({ task: "Review the local configuration diagnostic", ...input }, exec()));
  const snapshot = () => ({ threads: structuredClone(threads), calls: structuredClone(calls), children: children.map((child) => child.id),
    disposals: [...disposals], releases: [...releases], pins });
  return { store, manager, runtime, parent, exec, input, track, start, reviewOnly, snapshot, steers, children, disposals, callbackGate,
    failPlanner(count = 2) { plannerFailures = count; },
    failReviews(count = 2) { reviewFailures = count; }, setVerdict(value: ReviewResult["verdict"]) { verdict = value; },
    async close() {
      callbackGate.release(); await Promise.allSettled(tasks); await manager.stop();
      factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("onTurnStopping routes a waiting Planner to status and same-thread resume instead of allowing parent-authored completion", async () => {
  const f = await fixture();
  try {
    f.failPlanner();
    const waiting = await f.start();
    assert.equal(waiting.phase, "planning");
    assert.equal(waiting.processState, "waiting");
    assert.equal(waiting.retryState?.stage, "planning");
    assert.equal(waiting.planMarkdown, undefined);
    const before = await f.store.load(waiting.id);
    const resources = f.snapshot();
    const recovery = f.runtime.recoverableRuns.get(waiting.id);
    assert.ok(recovery);
    await f.manager.onTurnStopping(f.parent, 4);
    await f.manager.onTurnStopping(f.parent, 4);
    assert.equal(f.steers.length, 1, "A waiting original Planner must receive one continuation instruction");
    assert.match(f.steers[0]!, /codex_workflow_status/);
    assert.match(f.steers[0]!, /codex_workflow_resume/);
    assert.ok(f.steers[0]!.includes(waiting.id));
    assert.doesNotMatch(f.steers[0]!, /finish implementing|approved plan|finish the fixes|call codex_workflow_review\b|call codex_workflow_start\b/i);
    assert.deepEqual(await f.store.load(waiting.id), before);
    assert.deepEqual(f.snapshot(), resources, "The stopping hook only steers; it does not issue a model call or create another child");
    assert.equal(f.runtime.recoverableRuns.get(waiting.id), recovery);
    const resumed = await f.track(f.manager.resume(waiting.id, "Continue this original unfinished plan", f.exec()));
    assert.equal(resumed.id, waiting.id);
    assert.equal(resumed.phase, "executing");
    assert.equal(resumed.reviewCycles, 0);
    assert.ok(resumed.planMarkdown);
    const after = f.snapshot();
    assert.deepEqual(after.threads, resources.threads);
    assert.deepEqual(after.children, resources.children);
    assert.equal(after.calls.filter((call) => call.api === "turn").at(-1)?.threadId, recovery.threadId);
    assert.equal(f.disposals.filter((id) => id === recovery.child?.id).length, 1);
  } finally { await f.close(); }
});

test("onTurnStopping distinguishes an unconfirmed original start receipt from unavailable model continuation", async () => {
  const f = await fixture();
  try {
    f.failPlanner();
    const waiting = await f.start();
    await f.store.update(waiting.id, (r) => { r.retryState!.awaitingStartReceipt = true; });
    const before = f.snapshot();
    await f.manager.onTurnStopping(f.parent, 11);
    assert.equal(f.steers.length, 1);
    assert.match(f.steers[0]!, /start_receipt_pending/);
    assert.match(f.steers[0]!, /start_receipt_invalid/);
    assert.match(f.steers[0]!, /same original turn/);
    assert.match(f.steers[0]!, /without (?:resending|sending).*turn\/start/);
    assert.doesNotMatch(f.steers[0]!, /otherwise report the exact unavailable reason/);
    assert.deepEqual(f.snapshot(), before, "Recovery guidance alone cannot submit another model request");
  } finally { await f.close(); }
});

for (const mode of ["planned", "review_only"] as const) {
  test(`onTurnStopping routes a waiting ${mode} Reviewer to status and same-thread resume without implementation instructions`, async () => {
    const f = await fixture();
    try {
      let planned;
      if (mode === "planned") planned = await f.start();
      f.failReviews();
      const waiting = mode === "planned" ? await f.track(f.manager.review(planned!.id, f.input, f.exec())) : await f.reviewOnly();
      assert.equal(waiting.processState, "waiting");
      assert.equal(waiting.retryState?.stage, "reviewing");
      const before = await f.store.load(waiting.id);
      const resources = f.snapshot();
      const recovery = f.runtime.recoverableRuns.get(waiting.id);
      assert.ok(recovery);
      await f.manager.onTurnStopping(f.parent, 5);
      await f.manager.onTurnStopping(f.parent, 5);
      assert.equal(f.steers.length, 1, "The same parent turn receives one recovery instruction");
      assert.match(f.steers[0]!, /codex_workflow_status/);
      assert.match(f.steers[0]!, /codex_workflow_resume/);
      assert.ok(f.steers[0]!.includes(waiting.id));
      assert.doesNotMatch(f.steers[0]!, /finish implementing|finish the fixes|call codex_workflow_review\b|call codex_workflow_start\b/i,
        "A waiting review is unfinished model work and cannot be replaced by parent implementation or a fresh review");
      assert.deepEqual(await f.store.load(waiting.id), before);
      assert.deepEqual(f.snapshot(), resources);
      assert.equal(f.runtime.recoverableRuns.get(waiting.id), recovery);
      const resumed = await f.track(f.manager.resume(waiting.id, "Continue only this same unfinished review", f.exec()));
      assert.equal(resumed.phase, "passed");
      assert.equal(resumed.reviewCycles, 1);
      const after = f.snapshot();
      assert.deepEqual(after.threads.filter((thread) => thread.role !== "alignment"), resources.threads.filter((thread) => thread.role !== "alignment"));
      assert.deepEqual(after.children, resources.children);
      assert.equal(after.calls.filter((call) => call.api === "review").length, 1);
      assert.equal(after.calls.filter((call) => call.api === "turn").at(-1)?.threadId, recovery.threadId);
      assert.equal(f.disposals.filter((id) => id === recovery.child?.id).length, 1);
    } finally { await f.close(); }
  });
}

test("onTurnStopping routes a retryable review-only startup failure to review without inventing implementation work", async () => {
  const f = await fixture({ childFailure: true });
  try {
    await assert.rejects(f.reviewOnly(), /injected review-only startup failure/);
    const records = await f.store.list();
    assert.equal(records.length, 1);
    const failed = records[0]!;
    assert.equal(failed.mode, "review_only");
    assert.equal(failed.phase, "executing");
    assert.equal(failed.processState, "failed");
    assert.equal(failed.reviewCycles, 0);
    assert.deepEqual(f.snapshot().threads, []);
    assert.deepEqual(f.snapshot().calls, []);
    assert.deepEqual(f.children, []);
    const before = f.snapshot();
    await f.manager.onTurnStopping(f.parent, 6);
    assert.equal(f.steers.length, 1);
    assert.match(f.steers[0]!, /codex_workflow_review\b/);
    assert.ok(f.steers[0]!.includes(failed.id));
    assert.doesNotMatch(f.steers[0]!, /finish implementing|approved plan|finish the fixes|codex_workflow_start\b|call codex_workflow_resume\b/i);
    assert.deepEqual(await f.store.load(failed.id), failed);
    assert.deepEqual(f.snapshot(), before);
    const reviewed = await f.track(f.manager.review(failed.id, f.input, f.exec()));
    assert.equal(reviewed.id, failed.id);
    assert.equal(reviewed.phase, "passed");
    assert.equal(reviewed.reviewCycles, 1);
    assert.equal((await f.store.list()).length, 1);
  } finally { await f.close(); }
});

for (const phase of ["executing", "fixing"] as const) {
  test(`onTurnStopping preserves ordinary planned ${phase} implementation and review instructions`, async () => {
    const f = await fixture();
    try {
      let record = await f.start();
      if (phase === "fixing") {
        f.setVerdict("changes_requested");
        record = await f.track(f.manager.review(record.id, f.input, f.exec()));
      }
      assert.equal(record.phase, phase);
      const before = await f.store.load(record.id);
      const resources = f.snapshot();
      await f.manager.onTurnStopping(f.parent, 7);
      await f.manager.onTurnStopping(f.parent, 7);
      assert.equal(f.steers.length, 1);
      assert.match(f.steers[0]!, phase === "executing" ? /finish implementing the approved plan/ : /finish the fixes/);
      assert.match(f.steers[0]!, /codex_workflow_review\b/);
      assert.doesNotMatch(f.steers[0]!, /codex_workflow_resume\b/);
      assert.deepEqual(await f.store.load(record.id), before);
      assert.deepEqual(f.snapshot(), resources);
    } finally { await f.close(); }
  });
}

test("onTurnStopping preserves silence while the original Bridge submission callback is active", async () => {
  const f = await fixture({ bridge: true });
  try {
    const record = await f.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: f.parent.session.header.cwd!, dshSessionId: f.parent.id },
      task: "Review a read-only configuration diagnostic", planMarkdown: PLAN, assumptions: [] }, f.parent);
    await f.track(f.manager.submit(record.id, f.input, f.exec()));
    await f.callbackGate.entered;
    const before = await f.store.load(record.id);
    const resources = f.snapshot();
    await f.manager.onTurnStopping(f.parent, 8);
    assert.deepEqual(f.steers, []);
    assert.deepEqual(await f.store.load(record.id), before);
    assert.deepEqual(f.snapshot(), resources);
  } finally { f.callbackGate.release(); await f.close(); }
});

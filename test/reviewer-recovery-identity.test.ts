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
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewInput, TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-reviewer-recovery-identity-"));
  await writeFile(join(directory, "changed.txt"), "verified original review evidence", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const threads: Array<{ id: string; role: "reviewing" | "alignment" }> = [];
  const calls: Array<{ api: "review" | "turn" | "normalize"; threadId: string; model?: string; effort?: string; prompt: string }> = [];
  const children: Session[] = [];
  const disposals: string[] = [];
  const releases: string[] = [];
  const deferred: unknown[] = [];
  let failures = 2;
  let pins = 0;
  const native = async (threadId: string, options: Pick<Parameters<CodexGateway["startTurn"]>[1], "onStarted" | "onProgress">): Promise<TurnWaitResult> => {
    const turnId = `native-${calls.length}`;
    await options.onStarted?.({ threadId, turnId });
    if (failures > 0) {
      failures -= 1;
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    const text = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The original configuration diagnostic is verified.";
    options.onProgress?.({ kind: "message", itemId: turnId, text });
    return { kind: "completed", threadId, turnId, status: "completed", text };
  };
  const gateway: CodexGateway = {
    async startThread() { const id = `alignment-${threads.length + 1}`; threads.push({ id, role: "alignment" }); return id; },
    async startReviewerThread() { const id = `reviewer-${threads.length + 1}`; threads.push({ id, role: "reviewing" }); return id; },
    async resumeThread() { throw new Error("An ephemeral Reviewer cannot be reconstructed"); },
    async startReview(options) {
      calls.push({ api: "review", threadId: options.threadId, model: options.model, effort: options.effort,
        prompt: String(options.target.instructions ?? "") });
      return { threadId: options.threadId, result: await native(options.threadId, options) };
    },
    async startTurn(threadId, options) {
      calls.push({ api: "turn", threadId, model: options.model, effort: options.effort, prompt: options.prompt });
      return native(threadId, options);
    },
    async normalizeInFork(options) {
      calls.push({ api: "normalize", threadId: options.threadId, model: options.model, prompt: options.prompt });
      return { kind: "completed", threadId: options.threadId, turnId: `private-${calls.length}`, status: "completed",
        text: JSON.stringify(options.prompt.includes("REVIEW AUTHORITY checker") ? { aligned: true, conflicts: [] }
          : { verdict: "pass", findings: [], testGaps: [], summary: "The original configuration diagnostic is verified" }) };
    },
    async continueTurn(): Promise<never> { throw new Error("Reviewer identity tests have no native clarification"); },
    async interrupt() {},
    async unsubscribeThread(threadId) { releases.push(threadId); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; },
    endRound() { pins -= 1; },
  };
  const id = SessionId("reviewer-identity-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = () => ({ agent: parent, signal: new AbortController().signal,
    deferContext(message: unknown) { deferred.push(message); } } as unknown as ToolRunContext);
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
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
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "unused-planner",
    reviewerModel: "original-reviewer", plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {},
    { get: (sessionId) => sessionId === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const input: ReviewInput = { implementationSummary: "Original read-only configuration diagnostic implemented",
    changedFiles: ["changed.txt"], testResults: "Original valid and missing configuration cases verified" };
  const waiting = await manager.reviewOnly({ task: "Review the original configuration diagnostic", ...input }, exec());
  assert.equal(waiting.processState, "waiting");
  assert.equal(waiting.retryState?.stage, "reviewing");
  assert.equal(waiting.reviewCycles, 0);
  assert.equal(waiting.reviewerModel, "original-reviewer");
  assert.equal(waiting.reviewerEffort, "low");
  assert.equal(children.length, 1);
  assert.equal(threads.length, 1);
  assert.deepEqual(calls.map((call) => call.api), ["review", "turn"]);
  const recovery = runtime.recoverableRuns.get(waiting.id);
  assert.ok(recovery);
  const snapshot = () => ({ calls: structuredClone(calls), threads: structuredClone(threads), children: children.map((child) => child.id),
    disposals: [...disposals], releases: [...releases], deferred: structuredClone(deferred), pins,
    childHistory: children.map((child) => child.snapshotEvents()) });
  return { store, manager, runtime, waiting, recovery, input, exec, snapshot,
    async close() {
      await manager.stop(); factory.unregisterProvider(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const field of ["task", "reviewerModel", "reviewerEffort", "reviewAttempt"] as const) {
  for (const operation of ["resume", "review"] as const) {
    test(`Reviewer ${operation} rejects changed ${field} while status preserves the original waiting identity`, async () => {
      const f = await fixture();
      try {
        const changed = await f.store.update(f.waiting.id, (record) => {
          if (field === "task") record.task = "Retarget the existing Reviewer to a different approved task";
          if (field === "reviewerModel") record.reviewerModel = "replacement-reviewer";
          if (field === "reviewerEffort") record.reviewerEffort = "high";
          if (field === "reviewAttempt") record.reviewAttempt = (record.reviewAttempt ?? 0) + 1;
        });
        const before = f.snapshot();
        const capability = await f.manager.status(undefined, f.exec());
        const afterStatus = await f.store.load(f.waiting.id);
        const result = (await Promise.allSettled([operation === "resume"
          ? f.manager.resume(f.waiting.id, "Continue only this original review", f.exec())
          : f.manager.review(f.waiting.id, f.input, f.exec())]))[0]!;
        const after = f.snapshot();
        assert.deepEqual({ continuation: capability.continuation, result: result.status,
          additionalModelCalls: after.calls.length - before.calls.length,
          originalRecoveryRetained: f.runtime.recoverableRuns.get(f.waiting.id) === f.recovery,
          childDisposals: after.disposals.length - before.disposals.length, pins: after.pins }, {
          continuation: { available: false, reason: "identity_changed" }, result: "rejected", additionalModelCalls: 0,
          originalRecoveryRetained: true, childDisposals: 0, pins: before.pins,
        }, "A same-owner record edit cannot authorize the original retained Reviewer for a different scope or settings");
        assert.equal(result.status, "rejected");
        assert.match(String(result.reason), /identity|scope|task|attempt|settings|model|effort/i);
        assert.deepEqual(afterStatus, changed.record, "Status does not rewrite the replacement row or revision");
        assert.deepEqual(await f.store.load(f.waiting.id), changed.record,
          "A rejected continuation cannot apply a verdict, change progress or consume a review cycle");
        assert.deepEqual(after, before, "Rejected recovery keeps the exact child history, model calls, subscriptions and process pin");
        assert.equal(f.runtime.codexChildSessions.get(f.waiting.id), f.recovery.child);
        assert.equal(f.runtime.reviewHeartbeats.size, 0);
        assert.equal(f.runtime.resumeFlights.size, 0);
        assert.equal(f.runtime.reviewFlights.size, 0);
      } finally { await f.close(); }
    });
  }
}

test("an unchanged original Reviewer identity remains available and resumes on its original settings, thread and child", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    assert.deepEqual((await f.manager.status(undefined, f.exec())).continuation, { available: true });
    const result = await f.manager.resume(undefined, "Continue this same unfinished review", f.exec());
    assert.equal(result.id, f.waiting.id);
    assert.equal(result.phase, "passed");
    assert.equal(result.reviewCycles, 1);
    const after = f.snapshot();
    assert.deepEqual(after.threads.filter((thread) => thread.role === "reviewing"), before.threads);
    assert.deepEqual(after.children, before.children);
    assert.equal(after.calls.filter((call) => call.api === "review").length, 1);
    const continuation = after.calls.filter((call) => call.api === "turn").at(-1)!;
    assert.equal(continuation.threadId, f.recovery.threadId);
    assert.equal(continuation.model, "original-reviewer");
    assert.equal(continuation.effort, "low");
    assert.equal(continuation.prompt, "Continue this same unfinished review");
    assert.deepEqual(after.disposals, [f.recovery.child!.id]);
    assert.equal(after.pins, 0);
    assert.equal(f.runtime.recoverableRuns.size, 0);
  } finally { await f.close(); }
});

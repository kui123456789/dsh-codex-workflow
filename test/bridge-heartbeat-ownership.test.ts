import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ReviewObservation } from "../src/application/review-observation.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { BridgeStore } from "../src/bridge-store.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture(path: "old_mark_catch" | "old_callback_finalizer") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-heartbeat-ownership-"));
  await writeFile(join(directory, "changed.txt"), "verified original configuration evidence", "utf8");
  const store = new WorkflowStore(directory);
  const queue = new BridgeStore(directory);
  const a = gate();
  const b = gate();
  const oldMark = gate();
  const oldMarkRejected = gate();
  const bMarks = gate();
  const freshBTick = gate();
  const pendingBTicks = new Set<Promise<void>>();
  const sent: string[] = [];
  const cancellations: string[] = [];
  const alignmentCalls: string[] = [];
  let aGuard: ((record: WorkflowRecord) => boolean) | undefined;
  let bGuard: ((record: WorkflowRecord) => boolean) | undefined;
  let bTickNumber = 0;
  let freshAfterTick: number | undefined;
  let freshBRecord: WorkflowRecord | undefined;
  let oldMarkError: unknown;
  let bReturned = false;
  let allowBMarks = false;
  let pins = 0;
  const callback: CodexCallback = {
    async send(request) {
      sent.push(request.submissionId);
      const owner = sent.length === 1 ? "A" : "B";
      if (owner === "A") { a.enter(); await a.promise; }
      else { b.enter(); await b.promise; bReturned = true; }
      return { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: `${owner}'s verified configuration result` } };
    },
    cancel(id) { cancellations.push(`workflow:${id}`); },
    cancelSubmission(workflowId, submissionId) { cancellations.push(`${workflowId}:${submissionId}`); },
    async stop() { a.release(); b.release(); },
  };
  const gateway: CodexGateway = {
    async startThread() { return "private-owner-B-alignment"; },
    async normalizeInFork(options) {
      assert.match(options.prompt, /REVIEW AUTHORITY checker/);
      alignmentCalls.push(options.threadId);
      return { kind: "completed", threadId: options.threadId, turnId: "alignment", status: "completed",
        text: JSON.stringify({ aligned: true, conflicts: [] }) };
    },
    async resumeThread(): Promise<never> { throw new Error("No external model or reconstructed thread belongs to this fixture"); },
    async startTurn(): Promise<never> { throw new Error("No extra model turn belongs to this fixture"); },
    async startReview(): Promise<never> { throw new Error("Bridge reviews use the local callback"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification belongs to this fixture"); },
    async interrupt() {}, async unsubscribeThread() {},
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "fixture-reviewer",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60_000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, leaseTtlMs: 60_000,
    reviewHeartbeatMs: 250, storageDir: directory };
  const id = SessionId("heartbeat-ownership-parent");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const manager = new WorkflowManager(store, gateway, config, callback, queue, undefined, {},
    { get: (sessionId) => sessionId === parent.id ? parent : undefined });
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const observation = (manager as unknown as { reviewObservation: ReviewObservation }).reviewObservation;
  const originalStart = observation.startHeartbeat.bind(observation);
  const originalMark = observation.mark.bind(observation);
  observation.startHeartbeat = (workflowId, guard) => {
    const timer = originalStart(workflowId, guard);
    if (store.snapshot(workflowId)?.submissionState === "sending") {
      if (!aGuard) aGuard = guard;
      else if (guard !== aGuard) bGuard = guard;
    }
    return timer;
  };
  observation.mark = async (...args) => {
    const heartbeat = args[1] === undefined && args[2] === undefined && args[3] === undefined;
    const ownedA = heartbeat && aGuard !== undefined && args[4] === aGuard;
    const ownedB = heartbeat && bGuard !== undefined && args[4] === bGuard;
    const number = ownedB ? ++bTickNumber : undefined;
    let tickDone: (() => void) | undefined;
    const pending = ownedB ? new Promise<void>((resolve) => { tickDone = resolve; }) : undefined;
    if (pending) pendingBTicks.add(pending);
    try {
      if (ownedA && path === "old_mark_catch") { oldMark.enter(); await oldMark.promise; }
      else if (heartbeat && sent.length === 2 && !allowBMarks) {
        // Keep the active successor's timer installed, but hold ordinary ticks
        // while observing the old action so B's valid progress cannot obscure
        // an old owner's unexpected row/revision writes.
        await bMarks.promise;
      }
      const outcome = await originalMark(...args);
      if (number !== undefined && freshAfterTick !== undefined && number > freshAfterTick) {
        freshBRecord = outcome;
        freshBTick.enter();
      }
      return outcome;
    }
    catch (error) {
      if (ownedA) { oldMarkError = error; oldMarkRejected.enter(); }
      throw error;
    }
    finally {
      if (pending) { pendingBTicks.delete(pending); tickDone!(); }
    }
  };
  const keepAlive = setInterval(() => undefined, 1000);
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  return { store, queue, manager, runtime, parent, exec, a, b, oldMark, oldMarkRejected, sent, cancellations, alignmentCalls,
    get bReturned() { return bReturned; }, get oldMarkError() { return oldMarkError; }, get pins() { return pins; },
    releaseBMarks() { allowBMarks = true; bMarks.release(); },
    async nextOwnedBTick(workflowId: string) {
      allowBMarks = true; bMarks.release();
      await Promise.all([...pendingBTicks]);
      const before = store.snapshot(workflowId);
      assert.ok(before);
      const eventsBefore = parent.session.snapshotEvents().length;
      freshAfterTick = bTickNumber;
      await freshBTick.entered;
      assert.ok(freshBRecord, "A new B timer tick actually completed its guarded SQLite mark");
      assert.equal(freshBRecord.submissionLeaseEpoch, before.submissionLeaseEpoch);
      assert.equal(freshBRecord.submissionLeaseToken, before.submissionLeaseToken);
      assert.ok((freshBRecord.revision ?? 0) > (before.revision ?? 0), "A later fresh B tick updates the actual durable revision");
      assert.ok(parent.session.snapshotEvents().slice(eventsBefore).some((event) => event.type === "dsh-codex-workflow/review-progress"
        && (event.data as { workflowId?: string; processState?: string }).workflowId === workflowId
        && (event.data as { processState?: string }).processState === "running"), "The new owned tick emits B's running progress");
    },
    async close() {
      allowBMarks = true; bMarks.release(); oldMark.release(); a.release(); b.release();
      await Promise.allSettled([...runtime.backgroundTasks]);
      await manager.stop(); observation.startHeartbeat = originalStart; observation.mark = originalMark;
      clearInterval(keepAlive); queue.close(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const path of ["old_mark_catch", "old_callback_finalizer"] as const) {
  test(`a Bridge ${path} preserves the still-running successor's exact heartbeat and owned state`, { timeout: 30_000 }, async () => {
    const f = await fixture(path);
    try {
      const record = await f.manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
        createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: f.parent.session.header.cwd!, dshSessionId: f.parent.id },
        task: "Verify current configuration", planMarkdown: "<proposed_plan>\nInspect the existing configuration read-only.\n</proposed_plan>", assumptions: [] }, f.parent);
      await f.manager.submit(record.id, { implementationSummary: "Diagnostic implemented", changedFiles: ["changed.txt"] }, f.exec);
      await Promise.race([f.a.entered, Promise.allSettled([...f.runtime.backgroundTasks]).then(() => {
        throw new Error("The original callback settled before its local readable review was held");
      })]);
      const oldTimer = f.runtime.reviewHeartbeats.get(record.id);
      assert.ok(oldTimer);
      if (path === "old_mark_catch") await f.oldMark.entered;
      const original = await f.store.load(record.id);
      assert.ok(original?.submissionId);
      assert.ok(original.submissionLeaseToken);
      assert.ok(original.submissionLeaseEpoch !== undefined);
      const resource = `submission:${record.id}:${original.submissionId}`;
      assert.equal(f.store.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true);
      const aTasks = new Set(f.runtime.backgroundTasks);
      assert.equal(await f.manager.recoverCallbacks(), 1);
      await f.b.entered;
      const bTasks = [...f.runtime.backgroundTasks].filter((task) => !aTasks.has(task));
      const successor = await f.store.load(record.id);
      assert.ok(successor?.submissionLeaseToken);
      assert.ok(successor.submissionLeaseEpoch !== undefined && successor.submissionLeaseEpoch > original.submissionLeaseEpoch);
      assert.equal(successor.submissionState, "sending");
      assert.equal(successor.processState, "running");
      const bTimer = f.runtime.reviewHeartbeats.get(record.id);
      assert.ok(bTimer);
      assert.notEqual(bTimer, oldTimer);
      const rawBefore = f.store.coordinationHandle.loadWorkflow(record.id);
      const eventsBefore = f.parent.session.snapshotEvents();
      const modelBefore = { sent: [...f.sent], alignments: [...f.alignmentCalls] };
      if (path === "old_mark_catch") {
        f.oldMark.release();
        await f.oldMarkRejected.entered;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.match(String(f.oldMarkError), /review progress no longer owns this scope/);
      } else {
        f.a.release();
        await Promise.allSettled([...aTasks]);
      }
      const preserved = f.runtime.reviewHeartbeats.get(record.id) === bTimer;
      assert.equal(f.bReturned, false, "The successor still waits for its own model result");
      assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), rawBefore,
        "The old action cannot change any successor field, updatedAt or durable revision");
      assert.deepEqual(f.parent.session.snapshotEvents(), eventsBefore);
      assert.deepEqual({ sent: f.sent, alignments: f.alignmentCalls }, modelBefore, "The old action cannot invoke an extra model");
      assert.deepEqual(f.cancellations, [], "The old action cannot cancel the successor's model");
      assert.equal(Number(f.queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 0);
      if (preserved) {
        await f.nextOwnedBTick(record.id);
        assert.equal(f.runtime.reviewHeartbeats.get(record.id), bTimer);
        assert.equal(f.bReturned, false, "The actual fresh heartbeat precedes B's model result");
        assert.equal(f.store.coordinationHandle.isLeaseOwner(resource, successor.submissionLeaseEpoch, successor.submissionLeaseToken), true);
        assert.deepEqual({ sent: f.sent, alignments: f.alignmentCalls }, modelBefore);
        assert.deepEqual(f.cancellations, []);
      }
      // Complete the legitimate successor before reporting the captured timer
      // mismatch, so the red case also proves B's pipeline still succeeds.
      f.releaseBMarks(); f.b.release();
      await Promise.allSettled(bTasks);
      const completed = await f.store.load(record.id);
      assert.ok(completed);
      assert.equal(completed.submissionState, "received");
      assert.equal(completed.submissionLeaseToken, undefined);
      assert.equal(completed.stagedVerdict?.command.verdict.summary, "B's verified configuration result");
      assert.deepEqual(f.sent, [original.submissionId, original.submissionId]);
      assert.equal(f.alignmentCalls.length, 1);
      assert.equal(f.runtime.reviewHeartbeats.size, 0, "The legitimate completed successor releases its own heartbeat");
      f.a.release();
      await Promise.allSettled([...aTasks]);
      assert.deepEqual(await f.store.load(record.id), completed, "A's later result cannot alter B's completed row");
      assert.equal(Number(f.queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 1);
      assert.deepEqual(f.cancellations, []);
      assert.equal(f.pins, 0);
      const applied = await f.manager.applyExternalVerdict(completed.stagedVerdict!.command);
      assert.equal(applied.phase, "passed");
      assert.equal(applied.reviewCycles, 1);
      assert.equal(preserved, true, "The old owner must preserve the still-running successor's exact registered heartbeat timer");
    } finally { await f.close(); }
  });
}

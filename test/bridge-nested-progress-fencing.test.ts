import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { BridgeStore } from "../src/bridge-store.js";
import type { CodexCliAuditGateway } from "../src/codex-cli-audit.js";
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

for (const path of ["late_seed_registration", "alignment_fallback", "reconciliation_backoff", "post_reconciliation_conversion"] as const) {
  test(`a revoked Bridge alignment ${path} cannot overwrite the settled replacement owner's progress or start more model work`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-nested-progress-fence-"));
    await writeFile(join(directory, "changed.txt"), "verified original diagnostic evidence", "utf8");
    const store = new WorkflowStore(directory);
    const queue = new BridgeStore(directory);
    const oldAlignment = gate();
    let originalConsumerSignal: AbortSignal | undefined;
    const cancelledSubmissions: string[] = [];
    const privateThreads: string[] = [];
    const privateKinds = new Map<string, "alignment" | "reconciliation">();
    const alignmentCalls: string[] = [];
    const reconciliationCalls: string[] = [];
    const conversionCalls: string[] = [];
    const cliCalls: string[] = [];
    const released: string[] = [];
    const callbackCalls: string[] = [];
    const lateWrites: Array<{ stack: string; beforeRevision: number; afterRevision: number }> = [];
    let pins = 0;
    let retryClock = 0;
    let observeLate = false;
    const reconciliationPath = path === "reconciliation_backoff" || path === "post_reconciliation_conversion";
    const originalUpdate = store.update.bind(store);
    store.update = async <T>(id: string, mutate: (record: WorkflowRecord) => T, options?: Parameters<typeof originalUpdate>[2]) => {
      const before = observeLate ? store.coordinationHandle.loadWorkflow(id) : undefined;
      const stack = before ? new Error("nested progress write trace").stack ?? "" : "";
      const outcome = await originalUpdate(id, mutate, options);
      const after = before ? store.coordinationHandle.loadWorkflow(id) : undefined;
      if (before && after && before.revision !== after.revision) lateWrites.push({ stack,
        beforeRevision: before.revision, afterRevision: after.revision });
      return outcome;
    };
    const callback: CodexCallback = {
      async send(request) {
        originalConsumerSignal ??= request.consumer?.signal;
        callbackCalls.push(request.submissionId);
        return { kind: "verdict", verdict: reconciliationPath ? {
          verdict: "changes_requested", findings: [{ severity: "low", blocking: false,
            title: "Expand the approved interface", body: "Add an unrelated interface beyond the approved local diagnostic" }],
          testGaps: [], summary: "The completed original diagnostic review includes one generic suggestion",
        } : { verdict: "pass", findings: [], testGaps: [], summary: "The completed original diagnostic review" } };
      },
      cancel() {}, cancelSubmission(workflowId, submissionId) { cancelledSubmissions.push(`${workflowId}:${submissionId}`); }, async stop() {},
    };
    const gateway: CodexGateway = {
      async startThread(options) {
        const id = `private-alignment-${privateThreads.length + 1}`;
        privateThreads.push(id);
        privateKinds.set(id, options.name?.includes("Reconciliation") ? "reconciliation" : "alignment");
        return id;
      },
      async normalizeInFork(options) {
        if (privateKinds.get(options.threadId) === "reconciliation") {
          conversionCalls.push(options.threadId);
          throw new Error("A revoked reconciliation must not dispatch its next private conversion");
        }
        assert.match(options.prompt, /REVIEW AUTHORITY checker/);
        alignmentCalls.push(options.threadId);
        if (alignmentCalls.length === 1 && !reconciliationPath) {
          oldAlignment.enter();
          await oldAlignment.promise;
          if (path === "alignment_fallback") throw new Error("original private alignment provider unavailable");
        }
        await options.onStarted?.({ threadId: options.threadId, turnId: `alignment-${options.threadId}` });
        return { kind: "completed", threadId: options.threadId, turnId: `alignment-${options.threadId}`, status: "completed",
          text: JSON.stringify(reconciliationPath && alignmentCalls.length === 1 ? { aligned: false,
            conflicts: [{ kind: "finding", index: 0, reason: "The suggestion exceeds the approved local task",
              violated: "original task", highSeverityException: false }] } : { aligned: true, conflicts: [] }) };
      },
      async startTurn(threadId, options) {
        assert.equal(privateKinds.get(threadId), "reconciliation", "Only the original private reconciliation may run before takeover");
        reconciliationCalls.push(threadId);
        const turnId = `reconciliation-${reconciliationCalls.length}`;
        await options.onStarted?.({ threadId, turnId });
        if (path === "reconciliation_backoff") return { kind: "completed", threadId, turnId,
          status: "failed", text: "", reason: "server_overloaded" };
        assert.equal(path, "post_reconciliation_conversion");
        oldAlignment.enter();
        await oldAlignment.promise;
        return { kind: "completed", threadId, turnId, status: "completed",
          text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The original diagnostic is verified within its approved scope." };
      },
      async startReview(): Promise<never> { throw new Error("No visible model turn belongs to this local callback fixture"); },
      async resumeThread(): Promise<never> { throw new Error("No original thread may be reconstructed"); },
      async continueTurn(): Promise<never> { throw new Error("No clarification belongs to this fixture"); },
      async interrupt() {}, async unsubscribeThread(id) { released.push(id); },
      beginRound() { pins += 1; }, endRound() { pins -= 1; },
    };
    const audit: CodexCliAuditGateway = {
      async align(request) { cliCalls.push(request.workflowId); return { aligned: true, conflicts: [] }; },
      async createReview(): Promise<never> { throw new Error("No extra CLI review may be started"); },
      async review(): Promise<never> { throw new Error("No extra CLI review may be started"); },
      async normalize(): Promise<never> { throw new Error("No extra CLI conversion may be started"); },
      async reconcile(): Promise<never> { throw new Error("No reconciliation belongs to this aligned fixture"); },
      cancel() {}, cancelSubmission() {}, async stop() {},
    };
    const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "", reviewerModel: "nested-reviewer",
      plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
      reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
      callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60_000,
      transientRetryBaseMs: 1, transientRetryMaxMs: 1,
      transientRetryBudgetMs: path === "reconciliation_backoff" ? 20_000 : 0, transientRetryJitterRatio: 0,
      turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, leaseTtlMs: 10_000,
      conversionFallback: "cli", storageDir: directory };
    const id = SessionId("nested-progress-owner");
    const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
      createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
    const manager = new WorkflowManager(store, gateway, config, callback, queue,
      path === "alignment_fallback" ? audit : undefined, path === "reconciliation_backoff" ? {
        now: () => retryClock,
        sleep: async (ms, signal) => {
          assert.equal(reconciliationCalls.length, 1, "The actual transient wrapper reached its first private reconciliation backoff");
          signal?.throwIfAborted();
          oldAlignment.enter();
          await oldAlignment.promise;
          retryClock += ms;
        },
      } : {}, { get: (sessionId) => sessionId === parent.id ? parent : undefined });
    const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
    let submit: Promise<WorkflowRecord> | undefined;
    try {
      const bridge = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
        createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: parent.id },
        task: "Verify local diagnostics", planMarkdown: "<proposed_plan>\nVerify valid and missing configuration.\n</proposed_plan>", assumptions: [] }, parent);
      submit = manager.submit(bridge.id, { implementationSummary: "Diagnostic verified", changedFiles: ["changed.txt"] }, exec);
      void submit.catch(() => undefined);
      await submit;
      await Promise.race([oldAlignment.entered, Promise.allSettled([...runtime.backgroundTasks]).then(() => {
        throw new Error("The original callback settled before its actual private alignment barrier");
      })]);
      const original = await store.load(bridge.id);
      assert.ok(original?.submissionId);
      assert.equal(original.submissionReviewPending, true);
      assert.ok(runtime.submissionReviewResults.get(bridge.id), "Use the original manager's real completed checkpoint; no review result is fabricated or moved between managers");
      assert.ok(original.submissionLeaseToken);
      assert.ok(original.submissionLeaseEpoch !== undefined);
      const resource = `submission:${bridge.id}:${original.submissionId}`;
      assert.equal(store.coordinationHandle.releaseLease(resource, original.submissionLeaseEpoch, original.submissionLeaseToken), true);
      // B is the new lease generation in the same original manager. Its real
      // recovery consumes the process-local completed result without rerunning
      // the readable review or pretending a restarted process kept the cache.
      const aTasks = new Set(runtime.backgroundTasks);
      assert.equal(await manager.recoverCallbacks(), 1);
      const bTasks = [...runtime.backgroundTasks].filter((task) => !aTasks.has(task));
      await Promise.allSettled(bTasks);
      assert.equal(originalConsumerSignal?.aborted, true,
        "The original consumer's wait is revoked by the actual local handoff; its shared callback is not cancelled");
      assert.deepEqual(cancelledSubmissions, [], "The old generation cannot cancel the successor's shared review");
      const completed = await store.load(bridge.id);
      assert.ok(completed);
      assert.equal(completed.submissionState, "received");
      assert.equal(completed.submissionLeaseToken, undefined, "The actual B recovery finalizer has settled before taking a snapshot");
      assert.deepEqual(callbackCalls, [original.submissionId], "B validates the completed original result without another readable review");
      assert.equal(alignmentCalls.length, 2);
      assert.equal(privateThreads.length, reconciliationPath ? 3 : 2);
      assert.equal(reconciliationCalls.length, reconciliationPath ? 1 : 0);
      assert.equal(conversionCalls.length, 0);
      assert.equal(cliCalls.length, 0);
      const durableBefore = store.coordinationHandle.loadWorkflow(bridge.id);
      const eventsBefore = parent.session.snapshotEvents();
      const queueBefore = queue.coordinationHandle.queueRow(completed.stagedVerdict!.command.requestId);
      assert.ok(queueBefore);
      assert.equal(queueBefore.status, "inbox");
      assert.equal(Number(queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 1);
      const modelBefore = { callbackCalls: [...callbackCalls], alignmentCalls: [...alignmentCalls], cliCalls: [...cliCalls],
        reconciliationCalls: [...reconciliationCalls], conversionCalls: [...conversionCalls], privateThreads: [...privateThreads] };
      observeLate = true;
      oldAlignment.release();
      await Promise.allSettled([...aTasks]);
      const origins = lateWrites.map((entry) => entry.stack.split("\n").find((line) => line.includes("ReviewObservation.mark"))).filter(Boolean);
      assert.deepEqual({ additionalWrites: lateWrites.length, additionalCliModels: cliCalls.length - modelBefore.cliCalls.length,
        additionalReconciliationModels: reconciliationCalls.length - modelBefore.reconciliationCalls.length,
        additionalConversionModels: conversionCalls.length - modelBefore.conversionCalls.length }, {
        additionalWrites: 0, additionalCliModels: 0, additionalReconciliationModels: 0, additionalConversionModels: 0,
      }, `The revoked nested operation cannot publish progress or start a fallback model; late writers: ${origins.join("; ")}`);
      assert.deepEqual(await store.load(bridge.id), completed,
        "Old nested registration/fallback cannot change B's full completed row, timestamps, active turn or revision");
      assert.deepEqual(store.coordinationHandle.loadWorkflow(bridge.id), durableBefore);
      assert.deepEqual(parent.session.snapshotEvents(), eventsBefore);
      assert.deepEqual(queue.coordinationHandle.queueRow(completed.stagedVerdict!.command.requestId), queueBefore);
      assert.equal(Number(queue.coordinationHandle.db.prepare("SELECT COUNT(*) AS count FROM queue").get()?.count), 1);
      assert.deepEqual({ callbackCalls, alignmentCalls, cliCalls, reconciliationCalls, conversionCalls, privateThreads }, modelBefore);
      assert.deepEqual(cancelledSubmissions, [], "Late original cleanup does not acquire shared cancellation authority");
      assert.equal(pins, 0);
      assert.ok(privateThreads.every((thread) => released.filter((id) => id === thread).length === 1));
      assert.equal(runtime.reviewHeartbeats.size, 0);
      assert.equal(runtime.activeTurns.size, 0);
    } finally {
      observeLate = false; oldAlignment.release();
      if (submit) await Promise.allSettled([submit]);
      await manager.stop(); store.update = originalUpdate; queue.close(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

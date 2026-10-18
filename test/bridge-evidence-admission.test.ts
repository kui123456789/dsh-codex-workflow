import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexCallbackRequest } from "../src/codex-callback.js";
import type { CodexChildSessionFactory, CodexChildSessionHandle } from "../src/codex-child-session.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { newRequestId, type BridgeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { collectEvidence } from "../src/evidence.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewInput, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexCallback, type CodexGateway, type ManagerLease } from "../src/workflow.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-evidence-admission-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "valid.txt"), "verified local diagnostic v1", "utf8");
  await writeFile(join(directory, "outside.txt"), "unrelated test fixture", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const callbacks: CodexCallbackRequest[] = [];
  const threads: string[] = [];
  const children: string[] = [];
  const commands: BridgeCommand[] = [];
  const callback: CodexCallback = {
    async send(request) { callbacks.push(request); return { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "Local diagnostic verified" } }; },
    cancel() {}, cancelSubmission() {}, async stop() {},
  };
  const gateway: CodexGateway = {
    async startThread() { const id = `private-${threads.length + 1}`; threads.push(id); return id; },
    async resumeThread() { throw new Error("This evidence test must not resume any model thread"); },
    async startTurn(): Promise<never> { throw new Error("No model provider is part of this admission test"); },
    async startReview(): Promise<never> { throw new Error("Bridge review must use its callback"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this admission test"); },
    async normalizeInFork(options) { return { kind: "completed", threadId: options.threadId, turnId: "alignment",
      status: "completed", text: JSON.stringify({ aligned: true, conflicts: [] }) }; },
    async interrupt() {}, async unsubscribeThread() {},
    beginRound() {}, endRound() {},
  };
  const owner = SessionId("bridge-evidence-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: workspace, isSeeded: false }) } as Agent;
  const exec = (id = "bridge-evidence-owner", signal = new AbortController().signal) => ({ agent: { ...parent, id: SessionId(id) },
    signal, deferContext() {} } as unknown as ToolRunContext);
  const factory = { async create() {
    const id = `child-${children.length + 1}`;
    children.push(id);
    return { id, session: Session.create(SessionId(id), [], { version: SESSION_FORMAT_VERSION, id: SessionId(id),
      createdAt: Date.now(), cwd: workspace, isSeeded: false }), beginContinuation() {}, failAttempt() {}, progress() {},
      finish() {}, async dispose() {} } satisfies CodexChildSessionHandle;
  } } as unknown as CodexChildSessionFactory;
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {}, { get: (id) => id === parent.id ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
    createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: workspace, dshSessionId: owner },
    task: "Implement and review a read-only local diagnostic", planMarkdown: "<proposed_plan>\nInspect local configuration without changing user data.\n</proposed_plan>", assumptions: [] }, parent);
  const valid: ReviewInput = { implementationSummary: "ORIGINAL-INPUT-SENTINEL: diagnostic implemented", changedFiles: ["valid.txt"], testResults: "Verified local inputs" };
  const barriers: Array<ReturnType<typeof gate>> = [];
  const restores: Array<() => void> = [];
  const afterEvidence = () => {
    const barrier = gate();
    barriers.push(barrier);
    const internal = manager as unknown as { acquireWorkflowSubmitLease(id: string): Promise<ManagerLease | undefined> };
    const original = internal.acquireWorkflowSubmitLease.bind(manager);
    internal.acquireWorkflowSubmitLease = async (id) => { barrier.enter(); await barrier.promise; return original(id); };
    restores.push(() => { internal.acquireWorkflowSubmitLease = original; });
    return barrier;
  };
  const afterSubmissionLease = () => {
    const barrier = gate();
    barriers.push(barrier);
    const internal = manager as unknown as {
      acquireSubmissionLease(workflowId: string, submissionId: string): Promise<ManagerLease | undefined>;
    };
    const original = internal.acquireSubmissionLease.bind(manager);
    internal.acquireSubmissionLease = async (...args) => {
      const lease = await original(...args);
      assert.ok(lease, "The barrier must hold after the real SQLite submission lease was acquired");
      barrier.enter(); await barrier.promise; return lease;
    };
    restores.push(() => { internal.acquireSubmissionLease = original; });
    return barrier;
  };
  const waitReceived = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const current = await store.load(record.id);
      assert.ok(current);
      if (current.submissionState === "received" && !current.submissionLeaseToken) return current;
      if (Date.now() > deadline) throw new Error(`Submission did not become received: ${current.submissionState}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const writes = () => ({ leases: store.coordinationHandle.db.prepare("SELECT * FROM leases ORDER BY resource").all(),
    changes: store.coordinationHandle.db.prepare("SELECT total_changes() AS count").get() });
  const assertNoRuns = () => {
    assert.equal(callbacks.length, 0); assert.equal(threads.length, 0); assert.equal(children.length, 0); assert.equal(commands.length, 0);
  };
  return { workspace, store, manager, exec, record, valid, callbacks, children, threads, commands, afterEvidence, afterSubmissionLease,
    waitReceived, writes, assertNoRuns, runtime,
    async close() {
      for (const barrier of barriers) barrier.release();
      for (const restore of restores.reverse()) restore();
      await manager.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const invalid of ["absent", "missing", "outside"] as const) {
  test(`Bridge ${invalid} evidence is rejected before submission side effects and valid scope can use the same workflow`, async () => {
    const f = await fixture();
    try {
      const input: ReviewInput = { implementationSummary: "Diagnostic implemented",
        ...(invalid === "absent" ? {} : { changedFiles: [invalid === "missing" ? "missing.txt" : "../outside.txt"] }) };
      const evidence = await collectEvidence({ cwd: f.workspace, maxDiffBytes: 65536, changedFiles: input.changedFiles });
      assert.equal(evidence.insufficient, true);
      if (invalid === "outside") assert.deepEqual(evidence.rejectedPaths, ["../outside.txt"]);
      const before = await f.store.load(f.record.id);
      const writes = f.writes();
      await assert.rejects(f.manager.submit(f.record.id, input, f.exec()), /observable changed files.*readable changedFiles/);
      assert.deepEqual(await f.store.load(f.record.id), before);
      assert.deepEqual(f.writes(), writes);
      f.assertNoRuns();
      const submitted = await f.manager.submit(f.record.id, f.valid, f.exec());
      const received = await f.waitReceived();
      assert.equal(received.id, f.record.id);
      assert.equal(received.submissionId, submitted.submissionId);
      assert.equal(f.callbacks.length, 1);
      assert.equal(f.children.length, 1);
      const command = f.commands.find((value): value is SubmitVerdictCommand => value.kind === "submit_verdict");
      assert.ok(command);
      assert.equal((await f.manager.applyExternalVerdict(command)).reviewCycles, 1);
    } finally { await f.close(); }
  });
}

test("foreign owner is denied before evidence diagnostics or submission resources", async () => {
  const f = await fixture();
  try {
    const before = await f.store.load(f.record.id);
    const writes = f.writes();
    await assert.rejects(f.manager.submit(f.record.id, { implementationSummary: "Unavailable scope" }, f.exec("foreign-owner")),
      (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message, "workflow belongs to another DSH session"); return true; });
    assert.deepEqual(await f.store.load(f.record.id), before);
    assert.deepEqual(f.writes(), writes);
    f.assertNoRuns();
  } finally { await f.close(); }
});

for (const drift of ["owner", "phase"] as const) {
  test(`Bridge submit rechecks ${drift} after real evidence collection before persisting another submission`, async () => {
    const f = await fixture();
    const barrier = f.afterEvidence();
    try {
      const submitting = f.manager.submit(f.record.id, f.valid, f.exec());
      const settled = Promise.allSettled([submitting]);
      await barrier.entered;
      const changed = await f.store.update(f.record.id, (record) => {
        if (drift === "owner") record.dshSessionId = "new-owner";
        else record.phase = "passed";
      });
      barrier.release();
      await settled;
      await Promise.allSettled([...f.runtime.backgroundTasks]);
      assert.deepEqual(await f.store.load(f.record.id), changed.record, "Submission admission must not overwrite a displaced workflow after async evidence work");
      f.assertNoRuns();
    } finally { barrier.release(); await f.close(); }
  });
}

test("Bridge submit freezes its original request before an async caller mutation can mismatch the collected evidence", async () => {
  const f = await fixture();
  const barrier = f.afterEvidence();
  try {
    const input = structuredClone(f.valid);
    const expected = structuredClone(input);
    const submitting = f.manager.submit(f.record.id, input, f.exec());
    await barrier.entered;
    input.implementationSummary = "MUTATED-INPUT-SENTINEL";
    input.changedFiles!.push("missing.txt");
    barrier.release();
    const submitted = await submitting;
    assert.deepEqual(submitted.pendingReviewRequest, expected, "The original evidence cannot authorize a caller-mutated request");
    const received = await f.waitReceived();
    assert.deepEqual(received.pendingReviewRequest, expected);
    assert.equal(f.callbacks.length, 1);
    assert.match(f.callbacks[0]!.prompt, /ORIGINAL-INPUT-SENTINEL/);
    assert.equal(f.callbacks[0]!.prompt.includes("MUTATED-INPUT-SENTINEL"), false);
  } finally { barrier.release(); await f.close(); }
});

for (const boundary of ["scope", "abort"] as const) {
  test(`Bridge prepared admission rejects ${boundary} changes after acquiring both actual leases`, async () => {
    const f = await fixture();
    const barrier = f.afterSubmissionLease();
    const controller = new AbortController();
    try {
      const submitting = f.manager.submit(f.record.id, f.valid, f.exec(undefined, controller.signal));
      const settled = Promise.allSettled([submitting]);
      await barrier.entered;
      const active = f.store.coordinationHandle.db.prepare("SELECT resource, owner, lease_until FROM leases WHERE owner <> '' ORDER BY resource").all() as unknown as Array<{ resource: string; owner: string; lease_until: number }>;
      assert.equal(active.length, 2, "The workflow and submission leases were both acquired before the race");
      assert.ok(active.every((lease) => lease.lease_until > Date.now()));
      let expected = (await f.store.load(f.record.id))!;
      if (boundary === "scope") {
        const relocated = join(f.workspace, "relocated");
        await mkdir(relocated);
        expected = (await f.store.update(f.record.id, (record) => {
          record.task = "A different approved task";
          record.cwd = relocated;
        })).record;
      } else controller.abort(new Error("SUBMISSION-ENTRY-ABORT-SENTINEL"));
      barrier.release();
      const outcome = (await settled)[0]!;
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") assert.match(String(outcome.reason), boundary === "scope" ? /context changed/ : /SUBMISSION-ENTRY-ABORT-SENTINEL/);
      assert.deepEqual(await f.store.load(f.record.id), expected,
        "Prepared admission and rejected-submission cleanup must preserve the complete row and revision");
      f.assertNoRuns();
      for (const lease of active) {
        const released = f.store.coordinationHandle.db.prepare("SELECT resource, owner, lease_until FROM leases WHERE resource = ?").get(lease.resource);
        assert.ok(released);
        assert.deepEqual({ ...released }, { resource: lease.resource, owner: "", lease_until: 0 }, "Every acquired lease must be released after a rejected commit");
      }
    } finally { barrier.release(); await f.close(); }
  });
}

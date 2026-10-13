import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { PlannerExecutionContext } from "../src/application/planner-execution.js";
import type { WorkflowRecord } from "../src/types.js";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Stats = {
  processId: number;
  heldThreadStarts: number;
  threadStartRequests: Array<{ method: string; ephemeral: boolean }>;
  threadStarts: Array<{ threadId: string; method: string }>;
  turnStartRequests: Array<{ threadId: string; method: string; prompt?: string }>;
  unsubscribes: string[];
  active: Array<{ threadId: string; turnId: string }>;
};
const TASK = "Plan read-only local configuration diagnostics without changing user data.";
const INSTRUCTION = "Continue only the original unfinished planning in this same conversation.";
const protocol = fileURLToPath(new URL("./fixtures/fake-late-thread-start-app-server.mjs", import.meta.url));

async function fixture() {
  const f = await sharedReviewerFixture();
  const options = (f.client as unknown as { options: {
    args: string[]; rpcTimeoutMs: number; requestTimeoutMs: number;
  } }).options;
  // The fixture has not started its external process yet. Replace only the
  // upstream local protocol; keep the real client and native child factory.
  options.args = [protocol, "--interrupt-mode", "confirmed", "--turn-mode", "completed"];
  options.rpcTimeoutMs = 15_000;
  options.requestTimeoutMs = 30_000;
  const control = (method: string, params: object = {}) => f.control(method, params) as unknown as Promise<Stats>;
  let begins = 0;
  let ends = 0;
  const begin = f.client.beginRound.bind(f.client);
  const end = f.client.endRound.bind(f.client);
  f.client.beginRound = () => { begins += 1; return begin(); };
  f.client.endRound = () => { ends += 1; return end(); };
  const exec = (signal = new AbortController().signal) => Object.assign(Object.create(f.exec), { signal });
  const start = (signal: AbortSignal) => {
    const operation = f.manager.start({ task: TASK }, exec(signal));
    // Attach rejection observation immediately: abort may settle before gate
    // release on the old implementation, and that is precisely the RED path.
    const settled = Promise.allSettled([operation]);
    return { operation, settled };
  };
  const held = async () => {
    const stats = await control("fixture/waitForThreadCreation");
    const record = (await f.store.list())[0];
    assert.ok(record, "The real SQLite workflow is saved before the server creates its thread");
    assert.equal(stats.threadStarts.length, 1);
    assert.equal(stats.heldThreadStarts, 1, "Server has created the original thread but withheld the response");
    assert.equal(stats.turnStartRequests.length, 0, "No model has run before the exact creation boundary");
    assert.equal(f.children.length, 1, "Exactly one real native DSH child was created");
    return { record, stats, threadId: stats.threadStarts[0]!.threadId, childId: f.children[0]!.id };
  };
  const assertReleased = async (threadId: string, childId: string) => {
    const stats = await control("fixture/stats");
    assert.deepEqual(stats.unsubscribes, [threadId], "The original late-created subscription is released exactly once");
    assert.deepEqual(f.subscriptionsReleased, [threadId]);
    assert.deepEqual(f.rawDisposals, [childId], "The original native child is disposed exactly once");
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal(f.runtime.activeTurns.size, 0);
    assert.equal(f.runtime.foreground.size, 0);
    assert.equal(begins, 1);
    assert.equal(ends, 1, "The same original round releases its process pin only once");
    return stats;
  };
  const close = async () => {
    await control("fixture/releaseThreadStart").catch(() => undefined);
    await f.close();
    f.client.beginRound = begin;
    f.client.endRound = end;
  };
  return { ...f, control, exec, start, held, assertReleased, close,
    get begins() { return begins; }, get ends() { return ends; } };
}

test("caller abort after server creation receives the original late thread and resumes without a workflow id", async (t) => {
  const f = await fixture();
  const caller = new AbortController();
  try {
    const starting = f.start(caller.signal);
    const original = await f.held();
    caller.abort(new Error("operation aborted"));
    const pendingStatus = await f.manager.status(undefined, f.exec());
    assert.equal(pendingStatus.id, original.record.id);
    assert.deepEqual(pendingStatus.continuation, { available: false, reason: "running" },
      "The actual original creation still owns its bounded receipt before the late reply arrives");
    await f.control("fixture/releaseThreadStart");
    const [outcome] = await starting.settled;
    assert.ok(outcome);
    t.diagnostic(JSON.stringify({ outcome: outcome.status,
      originalThread: original.threadId, originalChild: original.childId,
      durablePhase: (await f.store.load(original.record.id))?.phase,
      children: f.children.length, disposals: f.rawDisposals.length }));
    assert.equal(outcome.status, "fulfilled", "Receipt collection parks the original thread instead of dropping its identity");
    const status = await f.manager.status(undefined, f.exec());
    assert.equal(status.id, original.record.id);
    assert.equal(status.phase, "planning");
    assert.equal(status.processState, "waiting");
    assert.equal(status.continuation.available, true);
    const recovery = f.runtime.recoverableRuns.get(status.id);
    assert.ok(recovery?.plannerIdentity);
    assert.equal(recovery.threadId, original.threadId);
    assert.equal(recovery.child?.id, original.childId);
    assert.equal(f.rawDisposals.length, 0, "Caller abort alone must keep the original child");
    const before = await f.control("fixture/stats");
    assert.equal(before.threadStartRequests.length, 1);
    assert.equal(before.turnStartRequests.length, 0, "Receiving a late thread does not permit an aborted caller to run a model");
    assert.equal(f.begins, 1);
    assert.equal(f.ends, 0, "Parked original recovery keeps the original process pin");
    const beforeTurns = f.children[0]!.snapshotEvents().filter((event: any) => event.type === "turn/start").length;
    const resumed = await f.manager.resume(undefined, INSTRUCTION, f.exec());
    assert.equal(resumed.id, original.record.id);
    assert.equal(resumed.phase, "executing");
    assert.equal(resumed.reviewCycles, 0);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.id, original.childId);
    const events = f.children[0]!.snapshotEvents();
    assert.equal(events.filter((event: any) => event.type === "turn/start").length, beforeTurns + 1);
    const users = events.filter((event: any) => event.type === "user/message");
    assert.match(JSON.stringify(users.at(-1)?.data), /Continue only the original unfinished planning/);
    const after = await f.assertReleased(original.threadId, original.childId);
    assert.equal(after.threadStartRequests.length, 1);
    assert.equal(after.threadStarts.length, 1);
    assert.equal(after.turnStartRequests[0]?.prompt, INSTRUCTION, "Send only continuation, never replay the original task");
    assert.ok(after.turnStartRequests.every((request) => request.threadId === original.threadId),
      "Visible planning and structured conversion keep the original ephemeral thread");
    assert.equal(after.active.length, 0);
  } finally { await f.close(); }
});

test("a real failed thread/start is discoverable without an id but cannot invent a continuation", async () => {
  const f = await fixture();
  try {
    await f.control("fixture/setNextThreadError", { message: "fixture startup permission denied" });
    await assert.rejects(f.manager.start({ task: TASK }, f.exec()), /startup permission denied/);
    const failed = (await f.store.list())[0];
    assert.ok(failed);
    assert.equal(failed.phase, "failed");
    assert.equal(f.store.coordinationHandle.loadWorkflow(failed.id)?.id, failed.id);
    const status = await f.manager.status(undefined, f.exec());
    assert.equal(status.id, failed.id, "Session-scoped diagnostics retain the real failed startup's address");
    assert.equal(status.continuation.available, false);
    assert.match(status.error ?? "", /startup permission denied/);
    const before = await f.control("fixture/stats");
    assert.equal(before.threadStartRequests.length, 1);
    assert.equal(before.threadStarts.length, 0, "The server returned an error before creating any thread");
    assert.equal(before.turnStartRequests.length, 0);
    await assert.rejects(f.manager.resume(undefined, INSTRUCTION, f.exec()),
      /no (active Codex workflow|in-process continuation|in-process Planner)|not.*resum|unavailable/i);
    const after = await f.control("fixture/stats");
    assert.deepEqual(after.threadStartRequests, before.threadStartRequests);
    assert.equal(after.turnStartRequests.length, 0);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.rawDisposals, [f.children[0]!.id]);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal(f.begins, 1);
    assert.equal(f.ends, 1);
    const other = Object.assign(Object.create(f.exec()), { agent: { ...f.parent, id: "unrelated-parent" } });
    await assert.rejects(f.manager.status(undefined, other), /no active Codex workflow/,
      "A session-scoped latest-startup diagnostic cannot expose another parent's workflow");
  } finally { await f.close(); }
});

for (const action of ["cancel", "stop"] as const) {
  test(`${action} while the original creation response is held cleans late resources exactly once and sends no model`, async (t) => {
    const f = await fixture();
    try {
      const starting = f.start(new AbortController().signal);
      const original = await f.held();
      const lifecycle = action === "cancel"
        ? f.manager.cancel(original.record.id, f.exec())
        : f.manager.stop();
      const observedLifecycle = Promise.allSettled([lifecycle]);
      if (action === "cancel") {
        await sharedWaitFor(async () => (await f.store.load(original.record.id))?.phase === "cancelled",
          "the real cancellation CAS before releasing the original creation reply");
      } else {
        assert.equal(f.runtime.stopped, true, "Stop withdraws adoption before the late creation response");
      }
      await f.control("fixture/releaseThreadStart");
      const [outcome] = await starting.settled;
      await observedLifecycle;
      t.diagnostic(JSON.stringify({ action, outcome: outcome?.status,
        originalThread: original.threadId, originalChild: original.childId }));
      const after = await f.assertReleased(original.threadId, original.childId);
      assert.equal(after.threadStartRequests.length, 1);
      assert.equal(after.threadStarts.length, 1);
      assert.equal(after.turnStartRequests.length, 0);
      assert.equal(after.active.length, 0);
      assert.equal(f.children.length, 1);
      if (action === "cancel") assert.equal((await f.store.load(original.record.id))?.phase, "cancelled");
      await Promise.allSettled([f.manager.cancel(original.record.id, f.exec()), f.manager.stop()]);
      const again = await f.control("fixture/stats");
      assert.deepEqual(again.unsubscribes, after.unsubscribes, "Repeated terminal cleanup must not release the receipt twice");
      assert.deepEqual(f.rawDisposals, [original.childId]);
    } finally { await f.close(); }
  });
}

test("a caller already aborted before start creates no workflow, child or thread", async () => {
  const f = await fixture();
  const caller = new AbortController();
  caller.abort(new Error("operation aborted"));
  try {
    await assert.rejects(f.manager.start({ task: TASK }, f.exec(caller.signal)), /operation aborted/);
    const stats = await f.control("fixture/stats");
    assert.equal((await f.store.list()).length, 0, "Admission checks the caller before saving an initial workflow");
    assert.equal(f.children.length, 0);
    assert.equal(stats.threadStartRequests.length, 0);
    assert.equal(stats.threadStarts.length, 0);
    assert.equal(stats.turnStartRequests.length, 0);
    assert.equal(f.begins, 0);
    assert.equal(f.ends, 0);
  } finally { await f.close(); }
});

test("caller abort while acquiring the creation lease releases admission before saving any workflow", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const acquiring = sharedGate();
  const receipt = sharedGate();
  const context = (f.manager as unknown as { plannerExecution: { ctx: PlannerExecutionContext } }).plannerExecution.ctx;
  const acquire = context.acquireCreateLease;
  context.acquireCreateLease = async (...args) => {
    const lease = await acquire(...args);
    acquiring.enter();
    await receipt.promise;
    return lease;
  };
  try {
    const starting = f.start(caller.signal);
    await acquiring.entered;
    caller.abort(new Error("operation aborted"));
    receipt.release();
    const [outcome] = await starting.settled;
    assert.equal(outcome?.status, "rejected");
    if (outcome?.status === "rejected") assert.match(String(outcome.reason), /operation aborted/);
    assert.equal((await f.store.list()).length, 0, "Lease receipt must recheck caller admission before the first row save");
    assert.equal(f.children.length, 0);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.threadStartRequests.length, 0);
    assert.equal(stats.turnStartRequests.length, 0);
    assert.equal(f.begins, 0);
    assert.equal(f.ends, 0);
    const available = await acquire(f.parent.id);
    assert.ok(available, "An aborted creation claimant releases its actual SQL creation lease");
    await available.release();
  } finally {
    receipt.release();
    context.acquireCreateLease = acquire;
    await f.close();
  }
});

test("no-id startup diagnostics select the current session's latest task, prefer active work and never skip newer terminal tasks", async () => {
  const f = await fixture();
  const record = (id: string, createdAt: string, overrides: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
    schemaVersion: 1, id, dshSessionId: f.parent.id, cwd: f.directory, task: TASK,
    mode: "planned", phase: "failed", createdAt, updatedAt: createdAt,
    questions: [], assumptions: [], reviewCycles: 0, error: `${id} startup failed`, ...overrides,
  });
  const old = record("old-failed-startup", "2026-10-01T00:00:00.000Z", {
    updatedAt: "2026-10-31T00:00:00.000Z",
  });
  const latest = record("latest-own-startup", "2026-10-03T00:00:00.000Z");
  try {
    await f.store.save(old);
    await f.store.save(record("unrelated-failed-startup", "2026-10-30T00:00:00.000Z", {
      dshSessionId: "unrelated-parent",
    }));
    await f.store.save(latest);
    const failedStatus = await f.manager.status(undefined, f.exec());
    assert.equal(failedStatus.id, latest.id, "Task creation order matters even if an older task's metering updated it later");
    assert.equal(failedStatus.error, latest.error);
    assert.equal(failedStatus.continuation.available, false);
    await assert.rejects(f.manager.resume(undefined, INSTRUCTION, f.exec()), /no active Codex workflow/);
    const active = record("original-active-workflow", "2026-10-02T00:00:00.000Z", {
      phase: "executing", planMarkdown: "<proposed_plan>\nInspect current configuration.\n</proposed_plan>",
    });
    await f.store.save(active);
    assert.equal((await f.manager.status(undefined, f.exec())).id, active.id,
      "An existing active workflow always takes priority over the later failed startup diagnostic");
    await f.store.update(active.id, (current) => { current.phase = "passed"; });
    for (const phase of ["passed", "cancelled"] as const) {
      await f.store.update(latest.id, (current) => { current.phase = phase; }, { ignoreCancelled: true });
      await assert.rejects(f.manager.status(undefined, f.exec()), /no active Codex workflow/,
        `The latest ${phase} task cannot expose an older failed startup as current`);
    }
    await f.store.update(latest.id, (current) => {
      current.phase = "failed";
      current.planMarkdown = "<proposed_plan>\nThe accepted plan already exists.\n</proposed_plan>";
    }, { ignoreCancelled: true });
    await assert.rejects(f.manager.status(undefined, f.exec()), /no active Codex workflow/,
      "A failed review after an accepted plan is not a first Planner startup diagnostic");
    await f.store.update(latest.id, (current) => {
      current.mode = "review_only";
      current.planMarkdown = undefined;
    }, { ignoreCancelled: true });
    await assert.rejects(f.manager.status(undefined, f.exec()), /no active Codex workflow/,
      "A failed review-only task cannot redirect startup diagnostics to an older planned task");
    const unknown = Object.assign(Object.create(f.exec()), { agent: { ...f.parent, id: "unknown-parent" } });
    await assert.rejects(f.manager.status(undefined, unknown), /no active Codex workflow/);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.threadStartRequests.length, 0);
    assert.equal(stats.turnStartRequests.length, 0);
    assert.equal(f.children.length, 0);
    assert.equal(f.runtime.recoverableRuns.size, 0, "Diagnostic lookup never creates a continuation handle");
  } finally { await f.close(); }
});

test("a committed initial save with its return held reports the real original startup as running", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const committed = sharedGate();
  const receipt = sharedGate();
  const save = f.store.save.bind(f.store);
  let original: WorkflowRecord | undefined;
  f.store.save = async (record) => {
    original = record;
    await save(record);
    committed.enter();
    await receipt.promise;
  };
  try {
    const starting = f.start(caller.signal);
    await committed.entered;
    assert.ok(original);
    caller.abort(new Error("operation aborted"));
    const status = await f.manager.status(undefined, f.exec());
    assert.equal(status.id, original.id);
    assert.deepEqual(status.continuation, { available: false, reason: "running" },
      "A real saved startup owns the held save receipt before child creation begins");
    assert.equal(f.children.length, 0);
    receipt.release();
    const [outcome] = await starting.settled;
    assert.equal(outcome?.status, "rejected");
    assert.equal((f.manager as unknown as { plannerExecution: { isStarting(id: string): boolean } })
      .plannerExecution.isStarting(original.id), false, "The rejected admission clears its real starting marker");
    assert.equal((await f.store.load(original.id))?.phase, "failed");
    assert.equal(f.children.length, 0);
    const stats = await f.control("fixture/stats");
    assert.equal(stats.threadStartRequests.length, 0);
    assert.equal(stats.turnStartRequests.length, 0);
    assert.equal(f.begins, 1);
    assert.equal(f.ends, 1);
  } finally {
    receipt.release();
    f.store.save = save;
    await f.close();
  }
});

for (const field of ["task", "cwd", "dshSessionId"] as const) {
  test(`a late original thread receipt cannot meter or mutate a displaced ${field} scope`, async () => {
    const f = await fixture();
    try {
      const starting = f.start(new AbortController().signal);
      const original = await f.held();
      await f.store.update(original.record.id, (record) => {
        record[field] = field === "cwd" ? join(f.directory, "successor-workspace") : `successor-${field}`;
      });
      const successor = f.store.coordinationHandle.loadWorkflow(original.record.id);
      assert.ok(successor);
      await f.control("fixture/releaseThreadStart");
      const [outcome] = await starting.settled;
      assert.equal(outcome?.status, "rejected", "A creation receipt can only belong to its immutable original Planner scope");
      const stats = await f.assertReleased(original.threadId, original.childId);
      assert.equal(stats.threadStartRequests.length, 1);
      assert.equal(stats.turnStartRequests.length, 0);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(original.record.id), successor,
        "Late usage binding and error finalization cannot overwrite any successor row field or revision");
    } finally { await f.close(); }
  });
}

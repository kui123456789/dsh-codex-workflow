import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { WorkflowStore } from "../src/store.js";
import { WorkflowManager } from "../src/workflow.js";
import { TerminalCleanupGuard } from "../src/application/terminal-cleanup-guard.js";
import { deserializeWorkflowRecord, serializeWorkflowRecord } from "../src/state/workflow-schema.js";
import type { WorkflowConfig, WorkflowTerminalCleanupMarker } from "../src/types.js";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const TASK = "Plan read-only local configuration diagnostics without changing user data.";
type CleanupMarker = WorkflowTerminalCleanupMarker;

function cleanupRun(sessionId = "session-original") {
  return { terminalFailure: "permission denied", originalProcessId: process.pid, originalProcessIds: [process.pid],
    reviewerIdentity: { dshSessionId: sessionId } };
}

async function generationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-terminal-cleanup-generation-"));
  const store = new WorkflowStore(directory);
  await store.init();
  const guard = new TerminalCleanupGuard(store);
  return { guard, store, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

function persistedCleanupMarker(store: WorkflowStore, workflowId: string, sessionId = "session-original"): CleanupMarker {
  const row = store.coordinationHandle.leaseInfo(`terminal-cleanup:${sessionId}:${workflowId}`);
  assert.ok(row);
  const descriptor = JSON.parse(row.owner) as { token: string };
  return { token: descriptor.token, epoch: row.epoch, sessionId };
}

test("cleanup generation historical tombstone cannot confirm a missing or different marker", async () => {
  const f = await generationFixture();
  try {
    const old = { token: "old-original-token", epoch: 3, sessionId: "session-original" };
    f.store.coordinationHandle.db.prepare("INSERT INTO leases (resource, epoch, owner, lease_until) VALUES (?, ?, ?, ?)")
      .run("terminal-cleanup:session-original:wf-generation", old.epoch, JSON.stringify({ kind: "terminal-cleanup-v1",
        workflowId: "wf-generation", token: old.token, sessionId: old.sessionId, confirmed: true }), 0);
    assert.equal(f.guard.isConfirmed("wf-generation", undefined), false, "Legacy records have no current-generation authority");
    assert.equal(f.guard.isConfirmed("wf-generation", { ...old, token: "next-original-token" }), false);
    assert.equal(f.guard.isConfirmed("wf-generation", { ...old, epoch: 4 }), false);
    assert.equal(f.guard.isConfirmed("wf-generation", { ...old, sessionId: "successor-session" }), false);
    assert.equal(f.guard.isConfirmed("different-workflow", old), false);
    assert.equal(f.guard.isConfirmed("wf-generation", old), true, "Only its exact original marker confirms cleanup");
  } finally { await f.close(); }
});

test("cleanup generation retain is idempotent only for its original owner", async () => {
  const f = await generationFixture();
  try {
    const run = cleanupRun();
    const marker = f.guard.retain("wf-generation", run);
    assert.ok(marker);
    assert.deepEqual(f.guard.retain("wf-generation", run), marker);
    assert.throws(() => f.guard.retain("wf-generation", cleanupRun()), /original.*owner|generation/i);
    assert.throws(() => f.guard.retain("wf-generation", cleanupRun("successor-session")), /original.*owner|generation/i);
    assert.equal(f.guard.isConfirmed("wf-generation", marker), false);
    f.guard.release("wf-generation", marker);
    assert.equal(f.guard.isConfirmed("wf-generation", marker), true);
    assert.deepEqual(f.guard.retain("wf-generation", run), marker, "Repeated original cleanup cannot mint a fresh generation");
  } finally { await f.close(); }
});

test("cleanup generation callback wrappers share an explicit original owner without borrowing another run", async () => {
  const f = await generationFixture();
  try {
    const owner = {};
    const marker = f.guard.retain("wf-generation", cleanupRun(), owner);
    assert.ok(marker);
    assert.deepEqual(f.guard.retain("wf-generation", cleanupRun(), owner), marker);
    assert.throws(() => f.guard.retain("wf-generation", cleanupRun(), {}), /original.*owner|generation/i);
    f.guard.release("wf-generation", marker);
    const next = f.guard.retain("wf-generation", cleanupRun(), {});
    assert.ok(next);
    assert.notEqual(next.token, marker.token);
    assert.equal(next.epoch, marker.epoch + 1);
    assert.equal(f.guard.isConfirmed("wf-generation", marker), false);
  } finally { await f.close(); }
});

test("cleanup generation stale release never confirms a fresh held writer", async () => {
  const f = await generationFixture();
  try {
    f.guard.retain("wf-generation", cleanupRun());
    const original = persistedCleanupMarker(f.store, "wf-generation");
    f.guard.release("wf-generation", original);
    f.guard.retain("wf-generation", cleanupRun());
    const next = persistedCleanupMarker(f.store, "wf-generation");
    f.guard.release("wf-generation", original);
    f.guard.release("wf-generation", undefined);
    assert.equal(f.guard.isConfirmed("wf-generation", next), false, "Neither an old nor missing marker releases the new writer");
    assert.throws(() => f.guard.retain("wf-generation", cleanupRun()), /original.*owner|generation/i,
      "A stale release cannot remove the current held owner");
    f.guard.release("wf-generation", next);
    assert.equal(f.guard.isConfirmed("wf-generation", next), true);
  } finally { await f.close(); }
});

test("cleanup generation SQL fence survives another Manager taking the expired lease", async () => {
  const f = await generationFixture();
  try {
    const original = f.guard.retain("wf-generation", cleanupRun());
    assert.ok(original);
    const resource = `terminal-cleanup:${original.sessionId}:wf-generation`;
    f.store.coordinationHandle.db.prepare("UPDATE leases SET lease_until = 0 WHERE resource = ?").run(resource);
    const other = new TerminalCleanupGuard(f.store);
    const next = other.retain("wf-generation", cleanupRun());
    assert.ok(next);
    f.guard.release("wf-generation", original);
    assert.equal(other.isConfirmed("wf-generation", next), false);
    assert.equal(f.guard.isConfirmed("wf-generation", original), false);
    other.release("wf-generation", next);
    assert.equal(other.isConfirmed("wf-generation", next), true);
    assert.equal(f.guard.isConfirmed("wf-generation", original), false, "Confirmed successor cannot authorize the predecessor marker");
  } finally { await f.close(); }
});

test("cleanup generation marker schema preserves valid authority and rejects malformed epochs", () => {
  const marker = { token: "original-token", epoch: 2, sessionId: "session-original" };
  const state = { stage: "reviewing", reason: "permission denied", attempts: 1, awaitingContinuation: true,
    awaitingCleanup: true, terminalFailure: "permission denied", terminalCleanup: marker };
  const base = { schemaVersion: 1, retryState: state };
  assert.deepEqual(deserializeWorkflowRecord(base).retryState, state);
  const encoded = serializeWorkflowRecord(base as unknown as Parameters<typeof serializeWorkflowRecord>[0]);
  assert.deepEqual(deserializeWorkflowRecord(JSON.parse(encoded)).retryState, state);
  for (const invalid of [undefined, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => deserializeWorkflowRecord({ ...base, retryState: { ...state,
      terminalCleanup: { ...marker, epoch: invalid } } }), /terminal cleanup.*marker|generation/i);
  }
  for (const invalid of [null, [], {}, { ...marker, token: "" }, { ...marker, sessionId: "" }]) {
    assert.throws(() => deserializeWorkflowRecord({ ...base, retryState: { ...state, terminalCleanup: invalid } }),
      /terminal cleanup.*marker|generation/i);
  }
  assert.deepEqual(deserializeWorkflowRecord({ schemaVersion: 1, retryState: { ...state, terminalCleanup: undefined } }).retryState,
    { ...state, terminalCleanup: undefined }, "Legacy missing marker stays readable but cannot supply confirmation");
});
type Stats = { processId: number; threadStarts: Array<{ threadId: string }>;
  turnStartRequests: Array<{ threadId: string; turnId?: string; scope: string }>;
  active: Array<{ threadId: string; turnId: string }>;
  interrupts: Array<{ threadId: string; turnId: string }>; unsubscribes: string[] };

/** Actual native DSH child, App Server protocol and shared SQLite coordination.
 * Only upstream model events are scripted; no production host is accessed. */
async function fixture() {
  const f = await sharedReviewerFixture();
  const processLog = join(f.directory, "terminal-guard-processes.jsonl");
  const options = (f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number } }).options;
  options.args = [protocol, "--interrupt-mode", "failed", "--process-log", processLog];
  options.rpcTimeoutMs = 15_000;
  const control = (method: string, params: object = {}) => f.control(method, params) as unknown as Promise<Stats>;
  const stats = () => control("fixture/stats");
  let ends = 0;
  const endRound = f.client.endRound.bind(f.client);
  f.client.endRound = () => { ends += 1; return endRound(); };
  await control("fixture/configure", { responses: { status: [{ kind: "needs_input" }] } });
  const start = () => f.manager.start({ task: TASK }, f.exec);
  const original = async (id: string) => {
    const current = await stats();
    assert.equal(current.threadStarts.length, 1);
    assert.equal(current.turnStartRequests.length, 2);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(ends, 0);
    const run = f.runtime.recoverableRuns.get(id);
    assert.ok(run?.terminalFailure);
    assert.ok(run.originalProcessIds?.includes(current.processId));
    const pair = current.active[0];
    assert.ok(pair);
    assert.equal(run.threadId, pair.threadId);
    assert.equal(run.interruptionTurnId, pair.turnId);
    return { stats: current, pair, childId: f.children[0]!.id };
  };
  const fresh = () => {
    const coldLog = join(f.directory, "cold-terminal-guard-processes.jsonl");
    const coldClient = new CodexAppServerClient({ command: process.execPath, args: [protocol, "--process-log", coldLog],
      requestTimeoutMs: 30_000, rpcTimeoutMs: 15_000, idleProcessMs: 0 });
    const coldStore = new WorkflowStore(f.directory);
    const config = (f.manager as unknown as { config: WorkflowConfig }).config;
    const manager = new WorkflowManager(coldStore, coldClient, config, undefined, undefined, undefined, {},
      { get: (id) => id === f.parent.id ? f.parent : undefined }, f.factory);
    return { manager, processLog: coldLog,
      async close() { await manager.stop(); await coldClient.stop(); await manager.stop(); coldStore.close(); } };
  };
  return { ...f, control, stats, start, original, fresh, processLog, get ends() { return ends; },
    async close() {
      const child = (f.client as unknown as { child?: ChildProcess }).child;
      if (child?.exitCode === null) {
        await control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
        await control("fixture/releaseInterrupt", { confirmed: true }).catch(() => undefined);
        await control("fixture/completeActive").catch(() => undefined);
      }
      await f.manager.stop(); await f.client.stop(); await f.manager.stop();
      await f.close();
      f.client.endRound = endRound;
    } };
}

for (const change of ["cancelled", "owner changed"] as const) {
  test(`an expired terminal cleanup lease blocks a cold Planner after ${change} without a workflow retry marker`, async () => {
    const f = await fixture();
    const cold = f.fresh();
    try {
      const first = await f.start();
      const old = await f.original(first.id);
      if (change === "cancelled") await f.manager.cancel(first.id, f.exec);
      await f.store.update(first.id, (row) => {
        row.retryState = undefined;
        if (change === "owner changed") {
          row.dshSessionId = "successor-session-owner";
          row.task = "Successor task whose complete row must stay unchanged";
          row.phase = "failed";
          row.processState = "failed";
        }
      }, { ignoreCancelled: true });
      const guards = f.store.coordinationHandle.db.prepare(
        "SELECT resource FROM leases WHERE resource LIKE 'terminal-cleanup:%'",
      ).all() as Array<{ resource: string }>;
      assert.equal(guards.length, 1);
      f.store.coordinationHandle.db.prepare("UPDATE leases SET lease_until = 0 WHERE resource = ?").run(guards[0]!.resource);
      const before = f.store.coordinationHandle.loadWorkflow(first.id);
      await assert.rejects(cold.manager.start({ task: TASK }, f.exec), /unconfirmed original terminal cleanup/i);
      await assert.rejects(readFile(cold.processLog, "utf8"), { code: "ENOENT" },
        "Expired coordination TTL does not authorize a replacement App Server");
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(first.id), before);
      assert.deepEqual((await f.stats()).active, [old.pair], "The original writer remains alive during refusal");
      await f.control("fixture/setInterruptMode", { mode: "confirmed" });
      if (change === "owner changed") {
        await assert.rejects(f.manager.resume(first.id, "Only clean the original rejected turn", f.exec),
          /original Planner owner or workspace identity/,
          "A displaced original owner may clean its resource but cannot consume the successor's workflow");
      }
      await f.manager.stop();
      assert.deepEqual(f.rawDisposals, [old.childId]);
      assert.equal(f.ends, 1);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(first.id), before,
        "Old cleanup cannot rewrite a cancelled or successor row after losing its marker");
      const receipt = f.store.coordinationHandle.db.prepare("SELECT owner FROM leases WHERE resource = ?")
        .get(guards[0]!.resource) as { owner: string };
      assert.equal(JSON.parse(receipt.owner).confirmed, true);
      const next = await cold.manager.start({ task: "Explicit separate task after original exact cleanup" }, f.exec);
      assert.equal(next.phase, "executing");
      assert.equal(f.rawDisposals.filter((id) => id === old.childId).length, 1);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(first.id), before);
    } finally { await cold.close(); await f.close(); }
  });
}

test("manager stop retains failed terminal cleanup until the actual original process exits, then releases once", async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const old = await f.original(first.id);
    await f.manager.stop();
    const held = await f.stats();
    assert.deepEqual(held.active, [old.pair]);
    assert.equal(f.runtime.recoverableRuns.size, 1);
    assert.equal(f.runtime.codexChildSessions.size, 1);
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(f.ends, 0, "Stopping one Manager does not close the shared SDK or release its old writer pin");
    const child = (f.client as unknown as { child: ChildProcess }).child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await f.control("fixture/exit");
    await exited;
    assert.throws(() => process.kill(held.processId, 0), { code: "ESRCH" });
    await f.manager.stop(); await f.manager.stop();
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.deepEqual(f.rawDisposals, [old.childId]);
    assert.equal(f.ends, 1);
    await f.client.stop();
    const events = (await readFile(f.processLog, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    assert.equal(events.filter((event) => event.kind === "start").length, 1);
    assert.equal(events.filter((event) => event.kind === "turn-start").length, 2,
      "Process-exit reconciliation performs cleanup with no model replay");
  } finally { await f.client.stop(); await f.close(); }
});

test("concurrent resume and cancel share a held terminal cleanup flight and release the original resources once", async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const old = await f.original(first.id);
    await f.control("fixture/setInterruptMode", { mode: "held" });
    const resumed = f.manager.resume(first.id, "Only confirm original terminal cleanup", f.exec);
    await sharedWaitFor(async () => {
      const current = await f.stats();
      return current.interrupts.length === 2 && current;
    }, "one held original terminal cleanup flight");
    const cancelled = f.manager.cancel(first.id, f.exec);
    await sharedWaitFor(async () => {
      const row = await f.store.load(first.id);
      return row?.phase === "cancelled" && row;
    }, "the cancel CAS while original cleanup is held");
    assert.equal((await f.stats()).interrupts.length, 2, "Cancel joins the existing interruption request");
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(f.ends, 0);
    await f.control("fixture/releaseInterrupt", { confirmed: true });
    const [resumeResult, cancelResult] = await Promise.all([resumed, cancelled]);
    assert.equal(resumeResult.phase, "cancelled");
    assert.equal(cancelResult.phase, "cancelled");
    const after = await f.stats();
    assert.equal(after.turnStartRequests.length, old.stats.turnStartRequests.length);
    assert.equal(after.interrupts.length, 2);
    assert.ok(after.interrupts.every((pair) => pair.threadId === old.pair.threadId && pair.turnId === old.pair.turnId));
    assert.deepEqual(after.active, []);
    assert.deepEqual(after.unsubscribes, [old.pair.threadId]);
    assert.deepEqual(f.rawDisposals, [old.childId]);
    assert.equal(f.ends, 1);
    await f.manager.stop(); await f.manager.stop();
    assert.deepEqual(f.rawDisposals, [old.childId]);
    assert.equal(f.ends, 1);
  } finally { await f.close(); }
});

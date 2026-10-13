import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { RetainedAuxiliaryTurn, WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { WorkflowStore } from "../src/store.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

type Pair = { threadId: string; turnId: string };
type ManagerBoundary = {
  runtime: WorkflowRuntimeState;
  withAuxiliaryReviewThread<T>(record: WorkflowRecord, model: string | undefined,
    purpose: "Alignment", signal: AbortSignal | undefined, work: (threadId: string) => Promise<T>): Promise<T>;
  confirmAuxiliaryTurns(workflowId: string, pair?: Pair, owner?: RetainedAuxiliaryTurn): Promise<boolean>;
};

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, promise, enter, release };
}

/** The real creator/confirmation/cleanup path owns the runtime entries. Only
 * the remote ACK port is scripted; no confirmation Set is populated by a test. */
async function auxiliaryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-auxiliary-confirmation-generation-"));
  const store = new WorkflowStore(join(directory, "storage"));
  const pair = { threadId: "reused-private-thread", turnId: "reused-private-turn" };
  const timestamp = new Date().toISOString();
  const record: WorkflowRecord = { schemaVersion: 1, id: "same-private-workflow",
    dshSessionId: "same-private-parent", cwd: directory, task: "Verify original auxiliary cleanup ownership",
    mode: "review_only", phase: "reviewing", createdAt: timestamp, updatedAt: timestamp,
    assumptions: [], questions: [], reviewCycles: 0, processState: "running" };
  await store.save(record);
  let generation = 0;
  let pins = 0;
  let ends = 0;
  let workCalls = 0;
  let acknowledgement: "confirmed" | "failed" = "failed";
  let held: ReturnType<typeof gate> | undefined;
  let boundary!: ManagerBoundary;
  const active = new Set<number>();
  const interrupts: Array<{ generation: number; owner: RetainedAuxiliaryTurn }> = [];
  const releases: number[] = [];
  const gates: ReturnType<typeof gate>[] = [];
  const pending: Promise<unknown>[] = [];
  const gateway: CodexGateway = {
    async startThread(options) {
      assert.equal(options.ephemeral, true);
      assert.ok(options.name?.startsWith("DSH Review Alignment"));
      generation += 1;
      return pair.threadId;
    },
    async resumeThread(): Promise<never> { throw new Error("No replacement thread is resumed by cleanup"); },
    async startTurn(): Promise<never> { throw new Error("Confirmation must not send a model continuation"); },
    async startReview(): Promise<never> { throw new Error("Confirmation must not create a visible Reviewer"); },
    async continueTurn(): Promise<never> { throw new Error("Confirmation must not submit a native answer"); },
    async normalizeInFork(options): Promise<never> {
      assert.equal(options.threadId, pair.threadId);
      workCalls += 1;
      active.add(generation);
      throw new CodexTurnInterruptionError(new Error("Original private turn timed out"),
        pair.threadId, pair.turnId, process.pid, [process.pid]);
    },
    isThreadAvailable: () => true,
    async interrupt(threadId, turnId) {
      assert.deepEqual({ threadId, turnId }, pair);
      const owner = boundary.runtime.auxiliaryTurns.get(threadId);
      assert.ok(owner, "The actual private creator registered its original cleanup owner");
      const originalGeneration = generation;
      interrupts.push({ generation: originalGeneration, owner });
      const originalAcknowledgement = acknowledgement;
      const originalGate = held;
      held = undefined;
      if (originalGate) { originalGate.enter(); await originalGate.promise; }
      if (originalAcknowledgement === "failed") throw new Error("Original interruption ACK remains unconfirmed");
      active.delete(originalGeneration);
    },
    async unsubscribeThread(threadId) {
      assert.equal(threadId, pair.threadId);
      releases.push(generation);
      assert.equal(active.has(generation), false, "Old cleanup cannot unsubscribe the newly active writer at the same address");
    },
    beginRound() { pins += 1; },
    endRound() { pins -= 1; ends += 1; },
  };
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off",
    plannerModel: "model-A", reviewerModel: "model-A", plannerEffort: "low", reviewerEffort: "low",
    maxReviewCycles: 3, maxNoChangeReviewRounds: 1, reviewDiffMaxBytes: 65536,
    bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576, callbackTimeoutMs: 1000,
    callbackMaxAttempts: 1, callbackRetryBaseMs: 1, transientRetryBaseMs: 1,
    transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000,
    reviewerReleaseTimeoutMs: 3000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config);
  boundary = manager as unknown as ManagerBoundary;
  return { manager, boundary, pair, record, interrupts, releases, active,
    snapshot() { return { pins, ends, workCalls, generation }; },
    acknowledge(value: "confirmed" | "failed") { acknowledgement = value; },
    holdAcknowledgement() { held = gate(); gates.push(held); return held; },
    failPrivateTurn() {
      const operation = boundary.withAuxiliaryReviewThread(record, "model-A", "Alignment", undefined,
        (threadId) => gateway.normalizeInFork({ threadId, cwd: directory, prompt: "Verify private alignment", outputSchema: {} }));
      const outcome = operation.then(() => { throw new Error("The scripted private turn must be interrupted"); }, (error: unknown) => {
        assert.ok(error instanceof CodexTurnInterruptionError);
        return error;
      });
      pending.push(outcome);
      return outcome;
    },
    confirm(owner?: RetainedAuxiliaryTurn) { return boundary.confirmAuxiliaryTurns(record.id, pair, owner); },
    async close() {
      acknowledgement = "confirmed";
      for (const value of gates) value.release();
      await Promise.allSettled(pending);
      await manager.stop(); store.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test("a new private execution cannot reuse an old ACK for the same workflow/thread/turn text", async () => {
  const f = await auxiliaryFixture();
  try {
    f.acknowledge("confirmed");
    await f.failPrivateTurn();
    const oldOwner = f.interrupts[0]!.owner;
    assert.equal(f.boundary.runtime.auxiliaryTurns.size, 0);
    assert.equal(await f.confirm(oldOwner), true);
    assert.equal(f.interrupts.length, 1);
    f.acknowledge("failed");
    await f.failPrivateTurn();
    const newOwner = f.boundary.runtime.auxiliaryTurns.get(f.pair.threadId);
    assert.ok(newOwner);
    assert.notEqual(newOwner, oldOwner);
    assert.deepEqual({ workflowId: newOwner.workflowId, threadId: newOwner.threadId, turnId: newOwner.turnId },
      { workflowId: oldOwner.workflowId, threadId: oldOwner.threadId, turnId: oldOwner.turnId });
    assert.equal(newOwner.originalProcessId, oldOwner.originalProcessId,
      "Even the same live PID cannot authorize another private execution");
    assert.equal(await f.confirm(newOwner), false, "The second execution requires its own successful ACK");
    assert.equal(f.interrupts.length, 3, "The second execution's failed ACK is actually retried");
    assert.equal(f.boundary.runtime.auxiliaryTurns.get(f.pair.threadId), newOwner);
    assert.deepEqual(f.releases, [1]);
    assert.equal(f.active.has(2), true);
    assert.equal(f.snapshot().pins, 1);
    assert.equal(await f.confirm(oldOwner), true, "The historical original owner retains its own receipt");
    assert.equal(f.interrupts.length, 3);
  } finally { await f.close(); }
});

test("repeated and concurrent confirmations for the original private owner share one ACK and cleanup", async () => {
  const f = await auxiliaryFixture();
  try {
    await f.failPrivateTurn();
    const owner = f.boundary.runtime.auxiliaryTurns.get(f.pair.threadId);
    assert.ok(owner);
    f.acknowledge("confirmed");
    const held = f.holdAcknowledgement();
    const first = f.confirm(owner);
    await held.entered;
    const second = f.confirm(owner);
    held.release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(await f.confirm(owner), true);
    assert.equal(f.interrupts.length, 2, "One failed original ACK plus one shared successful confirmation");
    assert.deepEqual(f.releases, [1]);
    assert.deepEqual(f.snapshot(), { pins: 0, ends: 1, workCalls: 1, generation: 1 });
    assert.equal(f.boundary.runtime.auxiliaryTurns.size, 0);
  } finally { await f.close(); }
});

test("a late old ACK cannot remove or unsubscribe the newly registered private execution", async () => {
  const f = await auxiliaryFixture();
  try {
    f.acknowledge("confirmed");
    const held = f.holdAcknowledgement();
    const oldOperation = f.failPrivateTurn();
    await held.entered;
    const oldOwner = f.interrupts[0]!.owner;
    // Simulate the registry handoff after an actual backend generation change.
    // B itself is created through the original production creator, not seeded.
    assert.equal(f.boundary.runtime.auxiliaryTurns.get(f.pair.threadId), oldOwner);
    f.boundary.runtime.auxiliaryTurns.delete(f.pair.threadId);
    f.acknowledge("failed");
    await f.failPrivateTurn();
    const newOwner = f.boundary.runtime.auxiliaryTurns.get(f.pair.threadId);
    assert.ok(newOwner);
    assert.notEqual(newOwner, oldOwner);
    f.acknowledge("confirmed");
    held.release();
    await oldOperation;
    assert.equal(f.boundary.runtime.auxiliaryTurns.get(f.pair.threadId), newOwner,
      "A cleanup flight captures A; its completion cannot delete B from the shared registry");
    assert.deepEqual(f.releases, [], "A's late ACK cannot unsubscribe B's reused address");
    assert.equal(f.active.has(2), true);
    assert.equal(f.snapshot().pins, 1, "A releases only its own completed process pin; B retains its pin");
    assert.equal(f.snapshot().ends, 1);
    assert.equal(await f.confirm(oldOwner), true);
    f.acknowledge("failed");
    assert.equal(await f.confirm(newOwner), false);
    assert.equal(f.interrupts.length, 3, "B cannot inherit A's late successful receipt");
    assert.deepEqual(f.releases, []);
    assert.equal(f.snapshot().workCalls, 2, "Cleanup never sends an additional model turn");
  } finally { await f.close(); }
});

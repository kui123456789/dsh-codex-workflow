import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TurnWaitResult } from "../src/types.js";
import { applyCodexWorkflowProjection, codexWorkflowProjectionDefinition } from "../src/review-events.js";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Stats = { processId: number; threadStarts: Array<{ threadId: string; method: string }>;
  turnStartRequests: Array<{ threadId: string; turnId?: string; scope: string }>; visibleTurns: number;
  nativeReplies: number; nativeMessages: Array<{ id: string | number; result: unknown }>; inputRequests: Array<string | number>;
  unsubscribes: string[]; writerConflicts: number; active: Array<{ threadId: string; turnId: string }> };
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-native-receipt-app-server.mjs", import.meta.url));
const TASK = "Plan read-only local configuration diagnostics without changing user data.";
const ANSWERS = { scope: ["Inspect existing configuration only"] };
const PLAN = "<proposed_plan>\n# Goal\nImplement read-only local configuration and storage diagnostics.\n# Changes\n- Add narrow health adapters with explicit unavailable-input handling.\n- Preserve current persistence, cancellation and ownership rules.\n# Verification\n- Verify valid, missing and malformed configuration in isolated storage.\n# Risks\n- Never initialize or mutate an existing database during inspection.\n</proposed_plan>";
function displayedPlan(parent: { session: { snapshotEvents(): readonly unknown[] } }) {
  let state = codexWorkflowProjectionDefinition.init();
  for (const event of parent.session.snapshotEvents()) state = applyCodexWorkflowProjection(state, event as never);
  assert.equal(state.failure, null);
  return state.plan;
}

async function fixture() {
  const f = await sharedReviewerFixture();
  const options = (f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number } }).options;
  options.args = [protocol, "--interrupt-mode", "confirmed"];
  options.rpcTimeoutMs = 15_000;
  const control = (method: string, params: object = {}) => f.control(method, params) as unknown as Promise<Stats>;
  const stats = () => control("fixture/stats");
  await control("fixture/configure", { responses: { visible: [{ kind: "needs_input" }] } });
  let begins = 0;
  let ends = 0;
  const begin = f.client.beginRound.bind(f.client);
  const end = f.client.endRound.bind(f.client);
  f.client.beginRound = () => { begins += 1; return begin(); };
  f.client.endRound = () => { ends += 1; return end(); };
  const exec = (signal = new AbortController().signal) => Object.assign(Object.create(f.exec), { signal });
  const released = async (threadId: string, childId: string) => {
    const current = await stats();
    assert.equal(current.threadStarts.length, 1);
    assert.equal(f.children.length, 1);
    assert.ok(current.turnStartRequests.every((request) => request.threadId === threadId));
    assert.equal(current.active.length, 0);
    assert.equal(current.writerConflicts, 0);
    assert.deepEqual(current.unsubscribes, [threadId]);
    assert.deepEqual(f.subscriptionsReleased, [threadId]);
    assert.deepEqual(f.rawDisposals, [childId]);
    assert.equal(f.runtime.pending.size, 0);
    assert.equal(f.runtime.plannerInputs.size, 0);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(f.runtime.activeTurns.size, 0);
    assert.equal(begins, 1);
    assert.equal(ends, 1);
    const events = f.children[0]!.snapshotEvents();
    const starts = events.filter((event: any) => event.type === "turn/start") as any[];
    const finishes = events.filter((event: any) => event.type === "turn/end") as any[];
    assert.deepEqual(starts.map((event) => event.data.turn), Array.from({ length: starts.length }, (_, i) => i + 1));
    assert.deepEqual(finishes.map((event) => event.data.turn), starts.map((event) => event.data.turn));
    return current;
  };
  const assertExactAnswer = (stats: Stats, nativeRequestId: string | number) => {
    assert.equal(stats.nativeReplies, 1);
    assert.deepEqual(stats.nativeMessages, [{ id: nativeRequestId, result: { answers: { scope: { answers: ANSWERS.scope } } } }],
      "The original native request receives its exact answer once, with no duplicate or fabricated request");
  };
  const finalChildText = () => {
    const messages = f.children[0]!.snapshotEvents().filter((event: any) => event.type === "assistant/message") as any[];
    return messages.at(-1)?.data.message.content.find((block: any) => block.type === "text")?.text;
  };
  return { ...f, control, stats, exec, released, assertExactAnswer, finalChildText,
    get begins() { return begins; }, get ends() { return ends; },
    async close() { await f.close(); f.client.beginRound = begin; f.client.endRound = end; } };
}

test("an initial native clarification receipt survives caller abort and answers the same live request", async (t) => {
  const f = await fixture();
  const caller = new AbortController();
  const native = f.client.startTurn;
  let tripped = false;
  f.client.startTurn = async (...args) => {
    const result = await native.apply(f.client, args);
    if (!tripped && result.kind === "needs_input") {
      tripped = true;
      caller.abort(new Error("operation aborted"));
    }
    return result;
  };
  try {
    const waiting = await f.manager.start({ task: TASK }, f.exec(caller.signal));
    assert.equal(tripped, true, "Abort occurs after the real SDK returns the original native request");
    assert.equal(waiting.phase, "waiting_input");
    assert.equal(waiting.processState, undefined);
    assert.equal(waiting.retryState, undefined);
    assert.equal(waiting.questions.length, 1);
    assert.equal(waiting.questions[0]?.question, "Which local configuration?");
    const original = await f.stats();
    const pending = f.runtime.pending.get(waiting.id);
    const input = f.runtime.plannerInputs.get(waiting.id);
    assert.ok(pending && input);
    assert.equal(input.pending, pending);
    assert.deepEqual(original.active, [{ threadId: pending.threadId, turnId: pending.turnId }]);
    assert.deepEqual(original.inputRequests, [pending.request.requestId]);
    assert.deepEqual(waiting.pendingInput, { turnId: pending.turnId, itemId: pending.request.itemId });
    assert.equal(input.child?.id, f.children[0]?.id);
    assert.equal(original.nativeReplies, 0);
    assert.equal(original.visibleTurns, 1);
    assert.equal(original.turnStartRequests.length, 1);
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(f.begins, 1);
    assert.equal(f.ends, 0);
    const row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    await assert.rejects(f.manager.resume(waiting.id, "Continue original planning", f.exec()), /no.*continuation|not.*waiting/i);
    const refused = await f.stats();
    assert.deepEqual(refused.turnStartRequests, original.turnStartRequests,
      "Manual recovery cannot open another turn while the exact native input request is active");
    assert.deepEqual(refused.active, original.active);
    assert.equal(refused.writerConflicts, 0);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row);
    const success = await f.manager.continue(waiting.id, ANSWERS, f.exec());
    assert.equal(success.id, waiting.id);
    assert.equal(success.phase, "executing");
    const final = await f.released(pending.threadId, input.child!.id);
    assert.equal(final.visibleTurns, 1, "The answer completes the original open turn rather than opening another visible turn");
    assert.equal(final.turnStartRequests.filter((request) => request.scope === "status").length, 1);
    assert.equal(final.inputRequests.length, 0);
    f.assertExactAnswer(final, pending.request.requestId);
    assert.equal(f.finalChildText(), PLAN);
    t.diagnostic(JSON.stringify({ originalRequestId: pending.request.requestId, visible: final.visibleTurns,
      conversion: final.turnStartRequests.filter((request) => request.scope === "status").length,
      nativeReplies: final.nativeReplies, threadStarts: final.threadStarts.length, children: f.children.length }));
  } finally { f.client.startTurn = native; await f.close(); }
});

test("a submitted native answer's successful receipt survives caller abort and resumes only conversion", async (t) => {
  const f = await fixture();
  const caller = new AbortController();
  const native = f.client.continueTurn;
  let tripped = false;
  f.client.continueTurn = async (...args) => {
    const result = await native.apply(f.client, args);
    if (!tripped && result.kind === "completed" && result.status === "completed") {
      tripped = true;
      caller.abort(new Error("operation aborted"));
    }
    return result;
  };
  try {
    const initial = await f.manager.start({ task: TASK }, f.exec());
    assert.equal(initial.phase, "waiting_input");
    const original = await f.stats();
    const pending = f.runtime.pending.get(initial.id);
    const input = f.runtime.plannerInputs.get(initial.id);
    assert.ok(pending && input?.child);
    const waiting = await f.manager.continue(initial.id, ANSWERS, f.exec(caller.signal));
    assert.equal(tripped, true);
    assert.equal(waiting.phase, "planning");
    assert.equal(waiting.processState, "waiting");
    assert.equal(waiting.retryState?.awaitingContinuation, true);
    assert.equal(waiting.retryState?.plannerCheckpoint?.nextStep, "conversion");
    assert.equal(displayedPlan(f.parent)?.status, "planning");
    assert.equal(displayedPlan(f.parent)?.processState, "waiting", "caller abort after an original native answer publishes a pause");
    const completedReceipt = await f.stats();
    assert.equal(completedReceipt.visibleTurns, 1);
    assert.equal(completedReceipt.turnStartRequests.filter((request) => request.scope === "status").length, 0);
    assert.equal(completedReceipt.active.length, 0);
    f.assertExactAnswer(completedReceipt, pending.request.requestId);
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(f.runtime.recoverableRuns.get(initial.id)?.child?.id, input.child.id);
    const success = await f.manager.resume(initial.id, "Continue only the original private conversion", f.exec());
    assert.equal(success.phase, "executing");
    assert.equal(displayedPlan(f.parent)?.status, "ready");
    assert.equal(displayedPlan(f.parent)?.processState, "completed");
    const final = await f.released(pending.threadId, input.child.id);
    assert.equal(final.visibleTurns, original.visibleTurns);
    assert.equal(final.turnStartRequests.length, original.turnStartRequests.length + 1);
    assert.equal(final.turnStartRequests.filter((request) => request.scope === "status").length, 1);
    f.assertExactAnswer(final, pending.request.requestId);
    assert.equal(f.finalChildText(), PLAN);
    t.diagnostic(JSON.stringify({ originalRequestId: pending.request.requestId, visible: final.visibleTurns,
      conversion: final.turnStartRequests.filter((request) => request.scope === "status").length,
      nativeReplies: final.nativeReplies, childId: input.child.id }));
  } finally { f.client.continueTurn = native; await f.close(); }
});

for (const action of ["cancel", "stop"] as const) {
  test(`${action} before adopting an initial native receipt prevents a late waiting_input commit`, async (t) => {
    const f = await fixture();
    const receipt = sharedGate();
    const release = sharedGate();
    const native = f.client.startTurn;
    let actual: TurnWaitResult | undefined;
    f.client.startTurn = async (...args) => {
      const result = await native.apply(f.client, args);
      if (result.kind === "needs_input") { actual = result; receipt.enter(); await release.promise; }
      return result;
    };
    try {
      const starting = f.manager.start({ task: TASK }, f.exec());
      const settled = Promise.allSettled([starting]);
      await receipt.entered;
      assert.ok(actual?.kind === "needs_input");
      const row = (await f.store.list())[0];
      assert.ok(row);
      const original = await f.stats();
      assert.equal(row.phase, "planning");
      assert.equal(original.active.length, 1);
      assert.equal(original.nativeReplies, 0);
      const lifecycle = action === "cancel" ? f.manager.cancel(row.id, f.exec()) : f.manager.stop();
      const observedLifecycle = Promise.allSettled([lifecycle]);
      if (action === "cancel") {
        await sharedWaitFor(async () => (await f.store.load(row.id))?.phase === "cancelled", "the actual cancel CAS before adopting input");
      } else assert.equal(f.runtime.stopped, true);
      release.release();
      await settled;
      await observedLifecycle;
      const finalRow = await f.store.load(row.id);
      assert.ok(finalRow);
      assert.notEqual(finalRow.phase, "waiting_input", "Lifecycle ownership defeats the late receipt commit");
      if (action === "cancel") assert.equal(finalRow.phase, "cancelled");
      else assert.equal(finalRow.phase, "failed");
      assert.equal(finalRow.pendingInput, undefined);
      const final = await f.released(actual.threadId, f.children[0]!.id);
      assert.deepEqual(final.turnStartRequests, original.turnStartRequests);
      assert.equal(final.nativeReplies, 0);
      assert.equal(final.nativeMessages.length, 0);
      await f.manager.stop();
      const again = await f.stats();
      assert.deepEqual(again.unsubscribes, final.unsubscribes);
      assert.deepEqual(f.rawDisposals, [f.children[0]!.id]);
      assert.equal(f.ends, 1);
      t.diagnostic(JSON.stringify({ action, finalPhase: finalRow.phase, nativeReplies: final.nativeReplies,
        visible: final.visibleTurns, disposed: f.rawDisposals.length, processPinReleases: f.ends }));
    } finally { release.release(); f.client.startTurn = native; await f.close(); }
  });
}

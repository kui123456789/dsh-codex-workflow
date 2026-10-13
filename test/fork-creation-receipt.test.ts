import assert from "node:assert/strict";
import test from "node:test";
import { forkCreationReceiptFixture, observeForkCall } from "./fixtures/fork-creation-receipt-fixture.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";

type Fixture = Awaited<ReturnType<typeof forkCreationReceiptFixture>>;
async function usingFixture(work: (f: Fixture) => Promise<void>) {
  const f = await forkCreationReceiptFixture(); let primaryError: unknown;
  try { await work(f); }
  catch (error) { primaryError = error; f.fail(); await f.snapshot("failure", { error: String(error), stack: error instanceof Error ? error.stack : undefined }); }
  finally { try { await f.close(); } catch (error) { primaryError ??= error; } }
  if (primaryError) throw primaryError;
}
const allowObserversToEnter = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const mode of ["failed", "invalid"] as const) {
  test(`completed conversion with ${mode} unsubscribe retains its output for cleanup-only recovery`, async () => usingFixture(async (f) => {
    await f.control("fixture/setOriginalReleaseMode", { mode, result: { status: "accepted" } });
    let originalCallbacks = 0, recoveryCallbacks = 0;
    const first = observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { originalCallbacks += 1; } }));
    await f.accepted(); await f.control("fixture/releaseOriginal");
    const initial = await first;
    const retry = await observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { recoveryCallbacks += 1; } }));
    const sourceWork = await observeForkCall(f.client.startTurn(f.source, { prompt: "Blocked until the original conversion subscription is released", model: "model-A" }));
    const changed = await observeForkCall(f.client.normalizeInFork({ ...f.options, prompt: "Different conversion material" }));
    const before = await f.stats();
    await f.snapshot("completed-conversion-release-unconfirmed", { mode, stats: before,
      initial: initial.error ? String(initial.error) : initial.value,
      retry: retry.error ? String(retry.error) : retry.value,
      sourceWork: sourceWork.error ? String(sourceWork.error) : sourceWork.value,
      changed: changed.error ? String(changed.error) : changed.value });
    assert.equal(initial.error, undefined, "An auxiliary release failure must not discard the completed model result");
    assert.equal(initial.value?.kind, "completed");
    const originalText = initial.value!.kind === "completed" ? initial.value!.text : "";
    if (initial.value!.kind === "completed") initial.value!.text = "Caller edited its returned copy";
    assert.ok(retry.error, "An unsuccessful cleanup retry cannot report the conversion as settled");
    assert.ok(sourceWork.error); assert.ok(changed.error);
    assert.equal(before.forks.length, 1); assert.equal(before.models.length, 1);
    assert.deepEqual(before.unsubscribes, []); assert.ok(before.loaded.includes("actual-fork-1"));
    const originalOwner = f.client.captureThreadOwner("actual-fork-1"); assert.ok(originalOwner);
    assert.equal(originalCallbacks, 1); assert.equal(recoveryCallbacks, 0);
    await f.control("fixture/setOriginalReleaseMode", { mode: "held" });
    const recovered = observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { recoveryCallbacks += 1; } }));
    await sharedWaitFor(async () => (await f.stats()).unsubscribeAttempts.some((entry) => entry.mode === "held"),
      "the original completed fork's cleanup retry awaits its real ACK");
    const joined = observeForkCall(f.client.normalizeInFork(f.options));
    await allowObserversToEnter();
    const held = await f.stats();
    assert.equal(held.forks.length, 1); assert.equal(held.models.length, 1);
    assert.equal(held.unsubscribeAttempts.filter((entry) => entry.mode === "held").length, 1);
    assert.equal(f.client.captureThreadOwner("actual-fork-1"), originalOwner);
    await f.control("fixture/releaseOriginalUnsubscribe");
    const outcomes = await Promise.all([recovered, joined]);
    assert.ok(outcomes.every((outcome) => outcome.value?.kind === "completed" && !outcome.error));
    assert.deepEqual(outcomes[0]!.value, outcomes[1]!.value);
    assert.equal(outcomes[0]!.value!.threadId, before.models[0]!.threadId);
    assert.equal(outcomes[0]!.value!.turnId, before.models[0]!.turnId);
    if (outcomes[0]!.value!.kind === "completed") assert.equal(outcomes[0]!.value!.text, originalText);
    assert.equal(recoveryCallbacks, 0, "Cached completion delivery must not replay model callbacks");
    assert.equal(f.client.captureThreadOwner("actual-fork-1"), undefined);
    await assertOriginalOnly(f);
    const independent = await f.client.normalizeInFork(f.options);
    assert.equal(independent.kind, "completed");
    const final = await f.stats();
    assert.equal(final.forks.length, 2); assert.equal(final.models.length, 2);
    assert.deepEqual(final.unsubscribes, ["actual-fork-1", "actual-fork-2"]);
  }));
}

test("an aborted cleanup observer cannot cancel another observer or repeat the completed conversion", async () => usingFixture(async (f) => {
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const initial = f.client.normalizeInFork(f.options); await f.accepted(); await f.control("fixture/releaseOriginal"); await initial;
  await f.control("fixture/setOriginalReleaseMode", { mode: "held" });
  const controller = new AbortController();
  const abandoned = observeForkCall(f.client.normalizeInFork(f.options, controller.signal));
  await sharedWaitFor(async () => (await f.stats()).unsubscribeAttempts.some((entry) => entry.mode === "held"), "original cleanup held");
  const joined = observeForkCall(f.client.normalizeInFork(f.options));
  controller.abort(new Error("operation aborted")); assert.ok((await abandoned).error);
  const held = await f.stats(); assert.equal(held.forks.length, 1); assert.equal(held.models.length, 1);
  assert.equal(held.unsubscribeAttempts.filter((entry) => entry.mode === "held").length, 1);
  await f.control("fixture/releaseOriginalUnsubscribe"); assert.equal((await joined).value?.kind, "completed");
  await assertOriginalOnly(f);
}));

test("unconfirmed completed-fork release prevents idle process loss until the original cleanup succeeds", async () => usingFixture(async (f) => {
  (f.port.options as { idleProcessMs?: number }).idleProcessMs = 25;
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const initial = f.client.normalizeInFork(f.options); await f.accepted(); await f.control("fixture/releaseOriginal"); await initial;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(f.original.exitCode, null); assert.equal(f.original.signalCode, null);
  (f.port.options as { idleProcessMs?: number }).idleProcessMs = 0;
  await f.control("fixture/setOriginalReleaseMode", { mode: "confirmed" });
  assert.equal((await f.client.normalizeInFork(f.options)).kind, "completed"); await assertOriginalOnly(f);
}));

test("failed auxiliary release preserves the primary model error and recovery never reruns its model", async () => usingFixture(async (f) => {
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const primary = new Error("Original conversion callback failed");
  const initial = observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { throw primary; } }));
  await f.accepted(); await f.control("fixture/releaseOriginal"); assert.equal((await initial).error, primary);
  await f.control("fixture/setOriginalReleaseMode", { mode: "confirmed" });
  assert.equal((await observeForkCall(f.client.normalizeInFork(f.options))).error, primary);
  await assertOriginalOnly(f);
}));

test("explicit source unsubscribe cleans its original conversion fork without replaying the completed model", async () => usingFixture(async (f) => {
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const initial = f.client.normalizeInFork(f.options); await f.accepted(); await f.control("fixture/releaseOriginal"); await initial;
  await f.control("fixture/setOriginalReleaseMode", { mode: "confirmed" });
  assert.equal(await f.client.unsubscribeThread(f.source, undefined, f.options.expectedOwner), "unsubscribed");
  const final = await f.stats();
  assert.equal(final.forks.length, 1); assert.equal(final.models.length, 1);
  assert.deepEqual(final.unsubscribes, ["actual-fork-1", f.source]); assert.deepEqual(final.loaded, []);
}));

test("external handoff cannot discard an unconfirmed original conversion release", async () => usingFixture(async (f) => {
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const initial = f.client.normalizeInFork(f.options); await f.accepted(); await f.control("fixture/releaseOriginal"); await initial;
  const rejected = await observeForkCall(f.client.releaseThreadForExternal(f.source, undefined, f.options.expectedOwner));
  assert.ok(rejected.error, "External handoff must not hide unconfirmed cleanup or retire the original process");
  assert.equal(f.original.exitCode, null); assert.equal(f.original.signalCode, null);
  const before = await f.stats(); assert.equal(before.forks.length, 1); assert.equal(before.models.length, 1);
  assert.deepEqual(before.unsubscribes, []);
  await f.control("fixture/setOriginalReleaseMode", { mode: "confirmed" });
  await f.client.releaseThreadForExternal(f.source, undefined, f.options.expectedOwner);
  assert.notEqual(f.original.exitCode, null);
  const wire = await f.wire();
  assert.equal(wire.filter((entry) => entry.kind === "conversion-model").length, 1);
}));

test("stop retires the captured completed-fork release without restarting its process or model", async () => usingFixture(async (f) => {
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const initial = f.client.normalizeInFork(f.options); await f.accepted(); await f.control("fixture/releaseOriginal"); await initial;
  await f.client.stop(); await assert.rejects(f.client.normalizeInFork(f.options));
  const wire = await f.wire();
  assert.equal(wire.filter((entry) => entry.kind === "process-start").length, 1);
  assert.equal(wire.filter((entry) => entry.kind === "fork-accepted").length, 1);
  assert.equal(wire.filter((entry) => entry.kind === "conversion-model").length, 1);
}));

test("uncertain conversion interruption confirms the original pair before subscription cleanup without another model", async () => usingFixture(async (f) => {
  await f.control("fixture/setFirstModelMode", { mode: "active" });
  await f.control("fixture/setInterruptMode", { mode: "failed" });
  const primary = new Error("Original conversion callback contract failed");
  const initial = observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { throw primary; } }));
  await f.accepted(); await f.control("fixture/releaseOriginal");
  const failure = await initial; assert.ok(failure.error instanceof CodexTurnInterruptionError);
  assert.equal((await f.stats()).unsubscribes.length, 0);
  const retry = await observeForkCall(f.client.normalizeInFork(f.options)); assert.ok(retry.error);
  const unconfirmed = await f.stats();
  assert.equal(unconfirmed.forks.length, 1); assert.equal(unconfirmed.models.length, 1);
  assert.equal(unconfirmed.unsubscribes.length, 0);
  await f.control("fixture/setInterruptMode", { mode: "confirmed" });
  const recovered = await observeForkCall(f.client.normalizeInFork(f.options)); assert.equal(recovered.error, primary);
  await assertOriginalOnly(f);
  const interrupts = (await f.wire()).filter((entry) => entry.kind === "interrupt");
  assert.ok(interrupts.length >= 2);
  assert.ok(interrupts.every((entry) => entry.threadId === unconfirmed.models[0]!.threadId && entry.turnId === unconfirmed.models[0]!.turnId));
}));

async function assertOriginalOnly(f: Fixture) {
  const stats = await f.stats();
  assert.equal(stats.forks.length, 1, "Recovery must keep the actual original fork creation");
  assert.equal(stats.forks[0]!.ephemeral, true); assert.equal(stats.forks[0]!.excludeTurns, true);
  assert.equal(stats.models.length, 1); assert.equal(stats.models[0]!.threadId, stats.forks[0]!.forkId);
  assert.deepEqual(stats.unsubscribes, [stats.forks[0]!.forkId]);
  assert.deepEqual(stats.loaded, [f.source]);
  return stats;
}

test("a healthy delayed fork receipt creates, converts and releases one original fork", async () => usingFixture(async (f) => {
  let started = 0;
  const waiting = f.client.normalizeInFork({ ...f.options, onStarted: () => { started += 1; } });
  await f.accepted(); await f.control("fixture/releaseOriginal");
  const result = await waiting;
  assert.equal(result.kind, "completed"); if (result.kind === "completed") assert.equal(result.status, "completed");
  assert.equal(started, 1); await assertOriginalOnly(f);
}));

for (const cause of ["abort", "timeout"] as const) test(`${cause} before a fork creation reply permits only original-fork adoption`, async () => usingFixture(async (f) => {
  const caller = new AbortController(); let oldCallbacks = 0, freshCallbacks = 0;
  if (cause === "timeout") f.port.options.rpcTimeoutMs = 80;
  const first = observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { oldCallbacks += 1; } }, caller.signal));
  await f.accepted(); if (cause === "abort") caller.abort(new Error("operation aborted"));
  const abandoned = await first;
  assert.ok(abandoned.error, "The original cancelled/timed-out observer must remain failed");
  f.port.options.rpcTimeoutMs = 4000;
  const freshOptions = { ...f.options, onStarted: () => { freshCallbacks += 1; } };
  const second = observeForkCall(f.client.normalizeInFork(freshOptions));
  await allowObserversToEnter();
  const unknown = await f.stats();
  await f.snapshot("unknown-original-reply", { stats: unknown, oldCallbacks, freshCallbacks });
  assert.equal(unknown.forks.length, 1, "Another observer while the original reply is unknown cannot issue a replacement fork");
  assert.equal(unknown.models.length, 0, "An unknown fork id cannot authorize a model turn");
  await f.control("fixture/releaseOriginal");
  const resumed = await second;
  const completed = resumed.value ?? await f.client.normalizeInFork(freshOptions);
  assert.equal(completed.kind, "completed"); if (completed.kind === "completed") assert.equal(completed.status, "completed");
  assert.equal(oldCallbacks, 0); assert.equal(freshCallbacks, 1);
  await assertOriginalOnly(f);
}));

test("a pending original normalization fork cannot be borrowed with different material", async () => usingFixture(async (f) => {
  const caller = new AbortController();
  const initial = observeForkCall(f.client.normalizeInFork(f.options, caller.signal));
  await f.accepted(); caller.abort(new Error("operation aborted")); assert.ok((await initial).error);
  const variants = [{ prompt: "A different normalization task" }, { cwd: `${f.directory}/different` },
    { model: "different-admitted-model" }, { outputSchema: { type: "object", properties: { other: { type: "string" } } } }];
  for (const changed of variants) {
    await assert.rejects(f.client.normalizeInFork({ ...f.options, ...changed }),
      "Different normalization material cannot claim the original unknown fork");
  }
  const waiting = await f.stats();
  assert.equal(waiting.forks.length, 1); assert.equal(waiting.models.length, 0);
  await f.control("fixture/releaseOriginal");
  const result = await f.client.normalizeInFork(f.options);
  assert.equal(result.kind, "completed"); await assertOriginalOnly(f);
}));

test("two simultaneous normalization observers cannot consume the same original fork twice", async () => usingFixture(async (f) => {
  let callbacks = 0;
  const options = { ...f.options, onStarted: () => { callbacks += 1; } };
  const first = observeForkCall(f.client.normalizeInFork(options));
  await f.accepted();
  const second = observeForkCall(f.client.normalizeInFork(options));
  await allowObserversToEnter();
  const unknown = await f.stats();
  assert.equal(unknown.forks.length, 1); assert.equal(unknown.models.length, 0);
  await f.control("fixture/releaseOriginal");
  const outcomes = await Promise.all([first, second]);
  assert.equal(outcomes.filter((outcome) => outcome.value).length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.error).length, 1);
  assert.equal(callbacks, 1); await assertOriginalOnly(f);
}));

test("an abandoned public fork call cleans its original late subscription while later calls stay independent", async () => usingFixture(async (f) => {
  const caller = new AbortController();
  const first = observeForkCall(f.client.forkThread(f.source, f.directory, caller.signal, f.options.expectedOwner));
  await f.accepted(); caller.abort(new Error("operation aborted")); assert.ok((await first).error);
  await f.control("fixture/releaseOriginal");
  await sharedWaitFor(async () => (await f.stats()).unsubscribes.includes("actual-fork-1"), "the abandoned original fork released once");
  const fresh = await f.client.forkThread(f.source, f.directory, undefined, f.options.expectedOwner);
  assert.equal(fresh, "actual-fork-2"); await f.client.unsubscribeThread(fresh, undefined, f.client.captureThreadOwner(fresh));
  const stats = await f.stats();
  assert.equal(stats.forks.length, 2); assert.equal(stats.models.length, 0);
  assert.deepEqual(stats.unsubscribes, ["actual-fork-1", "actual-fork-2"]); assert.deepEqual(stats.loaded, [f.source]);
}));

test("stop with an unknown original fork closes only its real process without starting a model or respawning", async () => usingFixture(async (f) => {
  let callbacks = 0;
  const first = observeForkCall(f.client.normalizeInFork({ ...f.options, onStarted: () => { callbacks += 1; } }));
  await f.accepted(); await f.client.stop(); assert.ok((await first).error);
  await assert.rejects(f.client.normalizeInFork(f.options));
  const wire = await f.wire();
  assert.equal(wire.filter((row) => row.kind === "process-start").length, 1);
  assert.equal(wire.filter((row) => row.kind === "fork-accepted").length, 1);
  assert.equal(wire.filter((row) => row.kind === "conversion-model").length, 0);
  assert.equal(wire.filter((row) => row.kind === "interrupt").length, 0, "No nonexistent model pair can be fabricated for cleanup");
  assert.equal(callbacks, 0); assert.notEqual(f.original.exitCode, null);
}));

test("failed cleanup of an abandoned late fork retains its source barrier until one real unsubscribe ACK", async () => usingFixture(async (f) => {
  await f.control("fixture/setOriginalReleaseMode", { mode: "failed" });
  const caller = new AbortController();
  const abandoned = observeForkCall(f.client.forkThread(f.source, f.directory, caller.signal, f.options.expectedOwner));
  await f.accepted(); caller.abort(new Error("operation aborted")); assert.ok((await abandoned).error);
  await f.control("fixture/releaseOriginal");
  await sharedWaitFor(async () => (await f.stats()).unsubscribeAttempts.some((entry) => entry.threadId === "actual-fork-1" && entry.mode === "failed"),
    "the original unsubscribe really rejected its ACK");
  const sourceWork = await observeForkCall(f.client.startTurn(f.source, { prompt: "Wait for the original abandoned fork cleanup", model: "model-A" }));
  const newPublic = await observeForkCall(f.client.forkThread(f.source, f.directory, undefined, f.options.expectedOwner));
  const unconfirmed = await f.stats();
  await f.snapshot("original-cleanup-unconfirmed", { stats: unconfirmed,
    sourceWork: sourceWork.error ? String(sourceWork.error) : sourceWork.value,
    newPublic: newPublic.error ? String(newPublic.error) : newPublic.value });
  assert.ok(sourceWork.error, "The source cannot start model work while its original fork cleanup remains unconfirmed");
  assert.ok(newPublic.error, "Public fork creation cannot bypass an unconfirmed original subscription cleanup");
  assert.equal(unconfirmed.forks.length, 1); assert.equal(unconfirmed.models.length, 0);
  assert.deepEqual(unconfirmed.unsubscribes, []); assert.ok(unconfirmed.loaded.includes("actual-fork-1"));
  await f.control("fixture/setOriginalReleaseMode", { mode: "held" });
  const firstFresh = observeForkCall(f.client.forkThread(f.source, f.directory, undefined, f.options.expectedOwner));
  await sharedWaitFor(async () => (await f.stats()).unsubscribeAttempts.some((entry) => entry.mode === "held"),
    "the original cleanup retry owns a real held ACK");
  const secondFresh = observeForkCall(f.client.forkThread(f.source, f.directory, undefined, f.options.expectedOwner));
  await allowObserversToEnter();
  const held = await f.stats();
  assert.equal(held.unsubscribeAttempts.filter((entry) => entry.mode === "held").length, 1,
    "Concurrent public callers share the original cleanup flight instead of issuing duplicate unsubscriptions");
  assert.equal(held.forks.length, 1); assert.deepEqual(held.unsubscribes, []);
  await f.control("fixture/releaseOriginalUnsubscribe");
  const fresh = await Promise.all([firstFresh, secondFresh]);
  assert.ok(fresh.every((result) => result.value));
  assert.equal(new Set(fresh.map((result) => result.value)).size, 2, "Public callers remain independent after original cleanup confirmation");
  for (const result of fresh) await f.client.unsubscribeThread(result.value!, undefined, f.client.captureThreadOwner(result.value!));
  const final = await f.stats();
  assert.equal(final.unsubscribes.filter((id) => id === "actual-fork-1").length, 1);
  assert.equal(final.forks.length, 3); assert.equal(final.models.length, 0); assert.deepEqual(final.loaded, [f.source]);
}));

for (const [shape, result] of [["missing status", {}], ["unknown status", { status: "accepted" }], ["null result", null]] as const) {
  test(`${shape} unsubscribe reply retains the abandoned original fork and its cleanup barrier`, async () => usingFixture(async (f) => {
    await f.control("fixture/setOriginalReleaseMode", { mode: "invalid", result });
    const caller = new AbortController();
    const abandoned = observeForkCall(f.client.forkThread(f.source, f.directory, caller.signal, f.options.expectedOwner));
    await f.accepted(); caller.abort(new Error("operation aborted")); assert.ok((await abandoned).error);
    await f.control("fixture/releaseOriginal");
    await sharedWaitFor(async () => (await f.stats()).unsubscribeAttempts.some((entry) => entry.mode === "invalid"),
      "the original backend returned its invalid unsubscribe result");
    const sourceWork = await observeForkCall(f.client.startTurn(f.source, { prompt: "Wait for confirmed original cleanup", model: "model-A" }));
    const newPublic = await observeForkCall(f.client.forkThread(f.source, f.directory, undefined, f.options.expectedOwner));
    const unconfirmed = await f.stats();
    await f.snapshot("invalid-unsubscribe-receipt", { shape, result, stats: unconfirmed,
      sourceWork: sourceWork.error ? String(sourceWork.error) : sourceWork.value,
      newPublic: newPublic.error ? String(newPublic.error) : newPublic.value });
    const retainedOwner = f.client.captureThreadOwner("actual-fork-1");
    assert.ok(retainedOwner, "An invalid ACK cannot discard the original subscription owner");
    assert.ok(sourceWork.error, "Source model work cannot bypass unconfirmed original cleanup");
    assert.ok(newPublic.error, "An invalid ACK cannot authorize a replacement fork");
    assert.equal(unconfirmed.forks.length, 1); assert.equal(unconfirmed.models.length, 0);
    assert.deepEqual(unconfirmed.unsubscribes, []); assert.ok(unconfirmed.loaded.includes("actual-fork-1"));
    await f.control("fixture/setOriginalReleaseMode", { mode: "held" });
    const fresh = observeForkCall(f.client.forkThread(f.source, f.directory, undefined, f.options.expectedOwner));
    await sharedWaitFor(async () => (await f.stats()).unsubscribeAttempts.some((entry) => entry.mode === "held"),
      "the retained original subscription retry awaits a real ACK");
    assert.equal(f.client.captureThreadOwner("actual-fork-1"), retainedOwner);
    await f.control("fixture/releaseOriginalUnsubscribe");
    const outcome = await fresh; assert.equal(outcome.error, undefined); assert.equal(outcome.value, "actual-fork-2");
    assert.equal(f.client.captureThreadOwner("actual-fork-1"), undefined);
    await f.client.unsubscribeThread(outcome.value!, undefined, f.client.captureThreadOwner(outcome.value!));
    const confirmed = await f.stats();
    assert.equal(confirmed.forks.length, 2); assert.equal(confirmed.models.length, 0);
    assert.deepEqual(confirmed.unsubscribes, ["actual-fork-1", "actual-fork-2"]); assert.deepEqual(confirmed.loaded, [f.source]);
  }));
}

test("synchronous caller abort before public fork submission sends no creation or model RPC", async () => usingFixture(async (f) => {
  const caller = new AbortController();
  const waiting = observeForkCall(f.client.forkThread(f.source, f.directory, caller.signal, f.options.expectedOwner));
  caller.abort(new Error("operation aborted"));
  assert.ok((await waiting).error);
  const stats = await f.stats();
  await f.snapshot("synchronous-abort-before-submission", { stats });
  assert.equal(stats.forks.length, 0, "A cancelled public caller cannot submit thread/fork after its ready-start await");
  assert.equal(stats.models.length, 0); assert.deepEqual(stats.unsubscribes, []);
}));

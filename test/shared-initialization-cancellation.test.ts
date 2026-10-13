import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-model-catalog-app-server.mjs", import.meta.url));
type Wire = { kind: string; processId: number; method?: string };
type Stats = { processId: number; initializations: number; heldInitializations: number; initializedReady: boolean;
  threadStarts: unknown[]; turnStartRequests: unknown[] };
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function observe<T>(promise: Promise<T>) {
  let outcome: PromiseSettledResult<T> | undefined;
  const settled = promise.then((value) => outcome = { status: "fulfilled", value },
    (reason: unknown) => outcome = { status: "rejected", reason });
  return { settled, get outcome() { return outcome; } };
}

async function fixture() {
  const f = await sharedReviewerFixture();
  const wireLog = join(f.directory, "shared-initialization-wire.jsonl");
  const port = f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number }; child?: object;
    requestRaw<T>(method: string, params: object, signal?: AbortSignal, expectedProcess?: object): Promise<T> };
  port.options.args = [protocol, "--catalog-model", "model-A", "--catalog-effort", "low", "--initialize-mode", "held", "--process-log", wireLog];
  port.options.rpcTimeoutMs = 15_000;
  const raw = <T = Stats>(method: string) => port.child ? port.requestRaw<T>(method, {}, undefined, port.child)
    : Promise.reject(new Error("No original diagnostic child for raw control"));
  const wire = async (): Promise<Wire[]> => {
    try { return (await readFile(wireLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Wire); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const joined = sharedGate();
  let originalProcess: object | undefined;
  const originalStart = f.client.start.bind(f.client);
  f.client.start = (signal) => {
    // Observe B's actual SDK receipt-collector entry. Child creation alone
    // cannot establish that B joined the original held initialize operation.
    if (!signal && originalProcess && port.child === originalProcess) joined.enter();
    return originalStart(signal);
  };
  return { ...f, raw, wire, joined,
    markOriginalProcess() { originalProcess = port.child; assert.ok(originalProcess); },
    configureReady() { port.options.args = [protocol, "--catalog-model", "model-A", "--initialize-mode", "valid", "--process-log", wireLog]; },
    delayOriginalExit() { port.options.args.push("--eof-delay-ms", "1500"); },
    async close() {
      await raw("fixture/releaseInitialize").catch(() => undefined);
      await raw("fixture/completeActive").catch(() => undefined);
      // Latch before the generic fixture's public controls: cleanup cannot
      // accidentally initialize another held diagnostic process after loss.
      await f.client.stop();
      const processes = (await wire()).filter((entry) => entry.kind === "start");
      await f.close();
      f.client.start = originalStart;
      assert.ok(processes.every((entry) => exited(entry.processId)));
    } };
}

test("cancelling the first metadata observer preserves the real native Planner's shared original initialization", async (t) => {
  const f = await fixture();
  const a = new AbortController();
  const b = new AbortController();
  let planner: ReturnType<typeof observe<Awaited<ReturnType<typeof f.manager.start>>>> | undefined;
  try {
    const metadata = observe(f.client.listModels(a.signal));
    const before = await f.raw("fixture/stats");
    assert.equal(before.heldInitializations, 1);
    f.markOriginalProcess();
    const exec = Object.assign(Object.create(f.exec), { signal: b.signal });
    planner = observe(f.manager.start({ task: "Plan read-only local configuration diagnostics without changing user data" }, exec));
    await f.joined.entered;
    const joined = await f.raw("fixture/stats");
    assert.equal(joined.processId, before.processId);
    assert.equal(joined.initializations, 1);
    assert.equal(joined.initializedReady, false);
    assert.equal(f.children.length, 1);
    const child = f.children[0]!.id;
    a.abort(new Error("A metadata caller-only abort"));
    await metadata.settled;
    assert.equal(metadata.outcome?.status, "rejected");
    if (metadata.outcome?.status === "rejected") assert.match(String(metadata.outcome.reason), /A metadata caller-only abort/);
    t.diagnostic(JSON.stringify({ originalPid: before.processId, originalPidAlive: !exited(before.processId), bAborted: b.signal.aborted,
      nativeChild: child, plannerSettled: planner.outcome?.status }));
    assert.equal(b.signal.aborted, false);
    assert.equal(exited(before.processId), false, "A's cancelled waiter cannot terminate B's original shared initializer");
    assert.equal(planner.outcome, undefined);
    assert.deepEqual(f.rawDisposals, []);
    await f.raw("fixture/releaseInitialize");
    const plannerResult = await planner.settled;
    assert.equal(plannerResult.status, "fulfilled");
    if (plannerResult.status === "fulfilled") assert.equal(plannerResult.value.phase, "executing");
    const after = await f.raw("fixture/stats");
    assert.equal(after.processId, before.processId);
    assert.equal(after.initializations, 1);
    assert.equal(after.threadStarts.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.id, child);
    assert.equal((await f.wire()).filter((entry) => entry.kind === "start").length, 1);
  } finally { await f.close(); await planner?.settled; }
});

test("a joining caller cancels its own wait before ACK while the original initializer remains admitted", async () => {
  const f = await fixture();
  const a = new AbortController();
  const b = new AbortController();
  let first: ReturnType<typeof observe<void>> | undefined;
  let second: ReturnType<typeof observe<void>> | undefined;
  try {
    first = observe(f.client.start(a.signal));
    const held = await f.raw("fixture/stats");
    assert.equal(held.heldInitializations, 1);
    second = observe(f.client.start(b.signal));
    b.abort(new Error("B joining caller-only abort"));
    await f.raw("fixture/stats");
    const before = await f.raw("fixture/stats");
    assert.equal(second.outcome?.status, "rejected", "B must stop waiting without awaiting the initializer ACK");
    if (second.outcome?.status === "rejected") assert.match(String(second.outcome.reason), /B joining caller-only abort/);
    assert.equal(first.outcome, undefined);
    assert.equal(exited(held.processId), false);
    assert.equal(before.initializedReady, false);
    await f.raw("fixture/releaseInitialize");
    const [firstResult, secondResult] = await Promise.all([first.settled, second.settled]);
    assert.equal(firstResult.status, "fulfilled");
    assert.equal(secondResult.status, "rejected");
    const after = await f.raw("fixture/stats");
    assert.equal(after.processId, held.processId);
    assert.equal(after.initializations, 1);
    assert.deepEqual(after.threadStarts, []);
    assert.equal(await f.client.resolveDefaultModel(), "model-A");
  } finally { await f.close(); await Promise.allSettled([first?.settled, second?.settled]); }
});

test("all cancelled startup observers retire only their original process before a fresh explicit metadata admission", async () => {
  const f = await fixture();
  const a = new AbortController();
  const b = new AbortController();
  let first: ReturnType<typeof observe<void>> | undefined;
  let second: ReturnType<typeof observe<void>> | undefined;
  let fresh: ReturnType<typeof observe<string | undefined>> | undefined;
  let withdrawn: ReturnType<typeof observe<string | undefined>> | undefined;
  try {
    f.delayOriginalExit();
    first = observe(f.client.start(a.signal));
    const held = await f.raw("fixture/stats");
    second = observe(f.client.start(b.signal));
    await f.raw("fixture/stats");
    b.abort(new Error("B startup observer abandoned"));
    a.abort(new Error("A startup observer abandoned"));
    const closing = await sharedWaitFor(async () => {
      const calls = await f.wire();
      return calls.some((entry) => entry.kind === "stdin-eof") && calls;
    }, "the actual original EOF before its delayed exit");
    assert.equal(exited(held.processId), false, "Fresh admission occurs during a real original cleanup");
    assert.equal(closing.filter((entry) => entry.kind === "start").length, 1);
    f.configureReady();
    const cleanupObserver = new AbortController();
    withdrawn = observe(f.client.resolveDefaultModel(cleanupObserver.signal));
    cleanupObserver.abort(new Error("Only this cleanup-wait observer cancelled"));
    await Promise.race([withdrawn.settled, new Promise<void>((resolve) => setImmediate(resolve))]);
    assert.equal(withdrawn.outcome?.status, "rejected", "A fresh caller may cancel its own wait for the exact old cleanup");
    if (withdrawn.outcome?.status === "rejected") assert.match(String(withdrawn.outcome.reason), /Only this cleanup-wait observer cancelled/);
    assert.equal(exited(held.processId), false, "Cancelling an observer does not cancel or fabricate the original cleanup receipt");
    assert.equal((await f.wire()).filter((entry) => entry.kind === "start").length, 1);
    fresh = observe(f.client.resolveDefaultModel());
    await Promise.all([first.settled, second.settled, fresh.settled]);
    assert.equal(first.outcome?.status, "rejected");
    assert.equal(second.outcome?.status, "rejected");
    if (first.outcome?.status === "rejected") assert.match(String(first.outcome.reason), /A startup observer abandoned/);
    if (second.outcome?.status === "rejected") assert.match(String(second.outcome.reason), /B startup observer abandoned/);
    assert.equal(fresh.outcome?.status, "fulfilled", "A fresh caller never adopts the abandoned original startup's error");
    if (fresh.outcome?.status === "fulfilled") assert.equal(fresh.outcome.value, "model-A");
    const after = await f.raw("fixture/stats");
    assert.notEqual(after.processId, held.processId);
    assert.equal(exited(held.processId), true);
    assert.deepEqual(after.threadStarts, []);
    assert.deepEqual(after.turnStartRequests, []);
    assert.equal(f.children.length, 0, "Independent metadata cannot replace a Planner");
    const calls = await f.wire();
    assert.equal(calls.filter((entry) => entry.kind === "start").length, 2);
    assert.equal(calls.filter((entry) => entry.kind === "stdin-eof" && entry.processId === held.processId).length, 1);
  } finally { await f.close(); await Promise.allSettled([first?.settled, second?.settled, fresh?.settled, withdrawn?.settled]); }
});

test("an already cancelled cold caller creates no initialization process", async () => {
  const f = await fixture();
  const caller = new AbortController();
  caller.abort(new Error("Cancelled before startup admission"));
  try {
    await assert.rejects(f.client.start(caller.signal), /Cancelled before startup admission/);
    assert.deepEqual(await f.wire(), []);
    assert.equal(f.children.length, 0);
  } finally { await f.close(); }
});

test("an already cancelled joining caller cannot acquire or cancel the original initializer", async () => {
  const f = await fixture();
  let first: ReturnType<typeof observe<void>> | undefined;
  let joining: ReturnType<typeof observe<void>> | undefined;
  try {
    first = observe(f.client.start());
    const held = await f.raw("fixture/stats");
    const caller = new AbortController();
    caller.abort(new Error("Cancelled before joining admission"));
    joining = observe(f.client.start(caller.signal));
    await f.raw("fixture/stats");
    await f.raw("fixture/stats");
    assert.equal(joining.outcome?.status, "rejected");
    if (joining.outcome?.status === "rejected") assert.match(String(joining.outcome.reason), /Cancelled before joining admission/);
    assert.equal(first.outcome, undefined);
    assert.equal(exited(held.processId), false);
    await f.raw("fixture/releaseInitialize");
    const firstResult = await first.settled;
    assert.equal(firstResult.status, "fulfilled");
    assert.equal((await f.raw("fixture/stats")).processId, held.processId);
    assert.equal((await f.wire()).filter((entry) => entry.kind === "start").length, 1);
  } finally { await f.close(); await Promise.allSettled([first?.settled, joining?.settled]); }
});

test("plugin stop ends every admitted startup observer and only the original child", async () => {
  const f = await fixture();
  const a = observe(f.client.start());
  let b: ReturnType<typeof observe<void>> | undefined;
  try {
    const held = await f.raw("fixture/stats");
    b = observe(f.client.start(new AbortController().signal));
    const stopping = f.client.stop();
    assert.equal(stopping, f.client.stop());
    await stopping;
    await Promise.all([a.settled, b.settled]);
    assert.equal(a.outcome?.status, "rejected");
    assert.equal(b.outcome?.status, "rejected");
    if (a.outcome?.status === "rejected") assert.match(String(a.outcome.reason), /stopped/);
    if (b.outcome?.status === "rejected") assert.match(String(b.outcome.reason), /stopped/);
    assert.equal(exited(held.processId), true);
    const calls = await f.wire();
    assert.equal(calls.filter((entry) => entry.kind === "start").length, 1);
    assert.equal(calls.filter((entry) => entry.kind === "stdin-eof").length, 1);
    assert.equal(calls.filter((entry) => entry.method === "thread/start" || entry.method === "turn/start").length, 0);
    await assert.rejects(f.client.resolveDefaultModel(), /stopped/);
  } finally { await f.close(); await Promise.allSettled([a.settled, b?.settled]); }
});

test("late cancellation after initialization completion cannot revoke the ready original process", async () => {
  const f = await fixture();
  const caller = new AbortController();
  const first = observe(f.client.start(caller.signal));
  try {
    const held = await f.raw("fixture/stats");
    await f.raw("fixture/releaseInitialize");
    await first.settled;
    assert.equal(first.outcome?.status, "fulfilled");
    caller.abort(new Error("The completed observer is no longer admitted"));
    assert.equal(await f.client.resolveDefaultModel(), "model-A");
    const thread = await f.client.startThread({ cwd: f.directory, ephemeral: true });
    assert.ok(f.client.captureThreadOwner(thread));
    const after = await f.raw("fixture/stats");
    assert.equal(after.processId, held.processId);
    assert.equal(after.initializations, 1);
    assert.equal(after.threadStarts.length, 1);
    assert.equal((await f.wire()).filter((entry) => entry.kind === "start").length, 1);
  } finally { await f.close(); await first.settled; }
});

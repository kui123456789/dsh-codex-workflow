import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";
import { AppServerCodexCallbackDispatcher } from "../../src/app-server-callback.js";
import type { CodexCallbackRequest } from "../../src/codex-callback.js";
const [directory, mode, laterReceiptDelay = "0", heldReceiptDelay = "0"] = process.argv.slice(2);
assert.ok(directory && mode);
mkdirSync(directory, { recursive: true });
const journal = join(directory, "wire.jsonl"), gates = join(directory, "gates.jsonl");
const f = await sharedReviewerFixture();
(f.client as any).options.args = [fileURLToPath(new URL("./fake-callback-start-receipt.mjs", import.meta.url)), journal, gates, mode, laterReceiptDelay, heldReceiptDelay];
const dispatcher = new AppServerCodexCallbackDispatcher(f.client);
const rows = (): any[] => readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row));
const observe = <T>(task: Promise<T>) => task.then((value) => ({ value }), (error) => ({ error: { name: error.name, message: error.message } }));
async function gate(kind: string) {
  const count = rows().filter((row) => row.kind === "gate-processed").length;
  appendFileSync(gates, JSON.stringify({ kind }) + "\n");
  await sharedWaitFor(() => rows().filter((row) => row.kind === "gate-processed").length > count, "original backend gate");
}
const child = await f.factory.create(f.parent, f.directory, "Original callback Reviewer", "Review local lifecycle requirements", new AbortController().signal);
const started: object[] = [], continuations: string[] = [], progress: object[] = [];
const request: CodexCallbackRequest = { workflowId: "original-callback-workflow", submissionId: "original-submission", codexThreadId: "original-source",
  cwd: f.directory, prompt: "Review local lifecycle requirements", task: "Review local lifecycle requirements", model: "model-A", effort: "low",
  ephemeral: !mode.startsWith("fork"), onStarted: (pair: object) => { started.push(pair); },
  onEphemeralStarted: (pair: object) => { started.push(pair); }, onProgress: (event) => { progress.push(event); child.progress(event); },
  onContinuation: (text: string) => { continuations.push(text); child.beginContinuation(text); } };
const controller = new AbortController();
const states: object[] = [];
let timeoutFault: { requestId: number; timeoutMs: number } | undefined;
try {
  if (mode.endsWith("timeout")) {
    const port = f.client as any;
    const requestRaw = port.requestRaw.bind(port);
    const normalTimeout = port.options.rpcTimeoutMs;
    assert.notEqual(requestRaw.constructor.name, "AsyncFunction", "The fixture samples RPC timeouts synchronously");
    port.requestRaw = (method: string, params: any, ...rest: any[]) => {
      const target = !timeoutFault && method === "turn/start"
        && Boolean(params.outputSchema) === mode.startsWith("conversion");
      if (target) timeoutFault = { requestId: rest[3].requestId, timeoutMs: 80 };
      port.options.rpcTimeoutMs = target ? 80 : normalTimeout;
      try { return requestRaw(method, params, ...rest); }
      finally { port.options.rpcTimeoutMs = normalTimeout; }
    };
  }
  await f.client.start();
  const firstTask = observe(dispatcher.send(request, controller.signal));
  await sharedWaitFor(() => rows().find((row) => row.kind === "model-accepted" && row.held), "actual original pending stage");
  if (!mode.endsWith("timeout")) controller.abort(new Error("original observer stopped waiting"));
  const first = await firstTask;
  const snapshot = () => ({ available: dispatcher.availableContinuation(request.workflowId), pending: dispatcher.hasPendingStartReceipt?.(request.workflowId),
    pin: (f.client as any).pinned, children: f.children.map((entry) => entry.id), disposals: [...f.rawDisposals],
    wire: rows(), started: [...started], continuations: [...continuations], progress: [...progress] });
  states.push({ kind: "first", first, timeoutFault, ...snapshot() });
  assert.equal(dispatcher.availableContinuation(request.workflowId), false);
  assert.equal(dispatcher.hasPendingStartReceipt(request.workflowId), true);
  assert.equal((f.client as any).pinned, 1); assert.equal(f.children.length, 1); assert.deepEqual(f.rawDisposals, []);
  const beforeStarts = rows().filter((row) => row.kind === "model-start-rpc").length;
  const early = await observe(dispatcher.send(request)); states.push({ kind: "early", early, ...snapshot() });
  assert.equal(rows().filter((row) => row.kind === "model-start-rpc").length, beforeStarts);
  if (mode.endsWith("cancel")) {
    dispatcher.cancel(request.workflowId);
    await sharedWaitFor(() => (dispatcher as any).cleanups.size === 0, "initial pending cleanup check completed");
    states.push({ kind: "cancel-before-receipt", ...snapshot() });
    assert.equal((f.client as any).pinned, 1); assert.equal(rows().filter((row) => row.kind === "actual-unsubscribe").length, 0);
    await gate("receipt"); await gate("confirm"); await dispatcher.stop();
    assert.equal((f.client as any).pinned, 0); assert.equal(dispatcher.hasPendingStartReceipt(request.workflowId), false);
    states.push({ kind: "cancel-confirmed", ...snapshot() });
  } else if (mode.endsWith("stop")) {
    await dispatcher.stop(); states.push({ kind: "stop-before-exit", ...snapshot() });
    assert.equal((f.client as any).pinned, 1);
    await f.client.stop(); await dispatcher.stop();
    assert.equal((f.client as any).pinned, 0); assert.equal(dispatcher.hasPendingStartReceipt(request.workflowId), false);
    states.push({ kind: "stop-after-exit", ...snapshot() });
  } else if (mode.endsWith("unavailable")) {
    await f.client.stop();
    const waiting = await observe(dispatcher.send(request));
    states.push({ kind: "unavailable-waiting", waiting, terminal: dispatcher.getPendingTerminalCleanup(request.workflowId)?.terminalFailure,
      ...snapshot() });
    const finished = await observe(dispatcher.send(request));
    states.push({ kind: "unavailable-finished", finished, ...snapshot() });
    assert.equal((finished as any).error?.name, "CodexInvalidThreadError");
    assert.equal((f.client as any).pinned, 0); assert.equal(dispatcher.hasPendingStartReceipt(request.workflowId), false);
  } else {
    await gate("receipt");
    // The backend gate log does not prove this SDK has consumed its stdio
    // reply. Wait for the original capability, without sending another RPC.
    await sharedWaitFor(() => dispatcher.availableContinuation(request.workflowId), "the original receipt is ready in this SDK");
    assert.equal(dispatcher.availableContinuation(request.workflowId), true);
    if (mode.endsWith("finished")) await gate("complete");
    const resumedTask = observe(dispatcher.send(request));
    if (!mode.endsWith("finished")) await gate("complete"); const resumed = await resumedTask;
    states.push({ kind: "resumed", resumed, ...snapshot() });
    assert.equal((resumed as any).value?.kind, "verdict");
    const starts = rows().filter((row) => row.kind === "model-start-rpc");
    assert.equal(starts.filter((row) => row.stage === (mode.startsWith("rewrite") ? "rewrite" : mode.startsWith("conversion") || mode.startsWith("fork") ? "conversion" : "visible")).length, 1);
    assert.ok(starts.every((row) => !row.originalActive));
    assert.equal(rows().filter((row) => row.kind === "thread-created" && row.method === "thread/start").length, 1);
    assert.equal((f.client as any).pinned, 0); assert.equal(f.children.length, 1); assert.deepEqual(f.rawDisposals, []);
    if (mode.startsWith("fork")) assert.equal(rows().filter((row) => row.kind === "thread-created" && row.method === "thread/fork").length, 1);
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ mode, states }, null, 2));
  console.log(JSON.stringify({ mode, status: "completed", first, wireCount: rows().length }));
} catch (error) {
  writeFileSync(join(directory, "failure.json"), JSON.stringify({ mode, states,
    available: dispatcher.availableContinuation(request.workflowId), pending: dispatcher.hasPendingStartReceipt(request.workflowId),
    wire: rows(), error: String(error) }, null, 2));
  throw error;
} finally {
  await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
  await f.control("fixture/completeActive").catch(() => undefined);
  await dispatcher.stop(); await f.client.stop(); await dispatcher.stop();
  child.finish("Original diagnostic completed"); await child.dispose();
  await f.close();
}

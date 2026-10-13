import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";
import { sharedGate, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";

const [directory, mode = "ready"] = process.argv.slice(2); assert.ok(directory);
const states = join(directory, "states.jsonl");
const log = (kind: string, detail: object = {}) => appendFileSync(states, JSON.stringify({ kind, ...detail }) + "\n");
process.on("uncaughtExceptionMonitor", (error: Error) => log("uncaught-monitor", { message: error.message }));
const protocol = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const client = new CodexAppServerClient({ command: process.execPath, args: [protocol], requestTimeoutMs: 5000,
  rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 100, killGraceMs: 100 });
const port = client as unknown as { child: ChildProcess; turnWaitersList: Map<unknown, unknown>;
  initializedProcessTrees: WeakMap<ChildProcess, Promise<ProcessTreeEvidence>> };
let evidence: ProcessTreeEvidence | undefined;
const census = sharedGate(), originalExecFile = childProcess.execFile;
let held = false;
if (mode === "initializing") {
  childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
    if (!held && (args.some(value => value.includes("Get-CimInstance Win32_Process") && !value.includes("-Filter")) || command === "ps")) {
      held = true;
      return Reflect.apply(originalExecFile, childProcess, [command, args, options,
        (error: Error | null, stdout: string, stderr: string) => { census.enter(); void census.promise.then(() =>
          Reflect.apply(callback as (...values: unknown[]) => unknown, undefined, [error, stdout, stderr])); }]);
    }
    return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
  }) as typeof childProcess.execFile; syncBuiltinESMExports();
}
let active: Promise<Error | undefined> | undefined;
log("actor-start");
try {
  let original: ChildProcess;
  if (mode === "initializing") {
    const startup = client.start(); await census.entered; original = port.child;
    const originalEvidence = port.initializedProcessTrees.get(original); assert.ok(originalEvidence);
    original.stderr!.destroy(new Error("Diagnostic read failure during actual identity collection"));
    await new Promise<void>(resolve => setImmediate(resolve)); census.release();
    await startup; evidence = await originalEvidence;
  } else { await client.start(); original = port.child;
    evidence = { processId: original.pid, ...await captureProcessTreeEvidence(original.pid) }; }
  const source = await client.startThread({ cwd: directory, ephemeral: true });
  const owner = client.captureThreadOwner(source);
  log("original-ready", { evidence, stderrErrorListeners: original.stderr!.listenerCount("error") });
  const cancel = new AbortController();
  if (mode === "active" || mode === "exit-diagnostic") {
    active = client.startTurn(source, { prompt: "HANG", expectedOwner: owner }, cancel.signal)
      .then(() => undefined, (error: Error) => error);
    await sharedWaitFor(() => port.turnWaitersList.size === 1, "original actual model waiter registered");
  }
  const fault = new Error("Diagnostic pipe read failed while JSON-RPC remained healthy");
  if (!original.stderr!.destroyed) {
    const closed = new Promise<void>(resolve => original.stderr!.once("close", resolve));
    original.stderr!.destroy(fault); await closed;
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(port.child, original); assert.equal(client.isThreadAvailable(source, owner), true);
  assert.ok((await client.health()).modelCount > 0);
  log("rpc-still-healthy", { sameProcess: port.child === original, available: client.isThreadAvailable(source, owner) });
  if (mode === "active") {
    assert.equal(client.isThreadAvailable(source, owner), true);
    const cancellation = new Error("Only this local model control cancelled"); cancel.abort(cancellation);
    assert.equal(await active, cancellation);
  }
  if (mode === "exit-diagnostic") {
    original.kill(); const error = await active; assert.ok(error);
    assert.match(error.message, /^codex app-server exited/i);
    assert.match(error.message, /stderr diagnostic stream unavailable/);
    assert.equal(error.message.includes(fault.message), false, "The private stream error content is not echoed into model diagnostics");
    log("exit-diagnostic", { currentExitPrefix: true, unavailableAnnotation: true });
  }
} catch (error) { log("actor-error", { message: String(error) }); process.exitCode = 1; }
finally {
  census.release(); childProcess.execFile = originalExecFile; syncBuiltinESMExports();
  await client.stop();
  await active;
  if (evidence) assert.equal(await originalProcessTreeExited(evidence), true);
  log("actor-complete");
}

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import { isRecoverableModelFailure, isTransientFailure } from "../src/transient-retry.js";
import { originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { sharedGate, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

for (const mode of ["initializing", "joined", "caller-abort", "ready", "first-cause", "active-turn"] as const) {
test(`original stdin failure preserves startup and transport ownership: ${mode}`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-initialize-input-failure-"));
  const protocol = join(directory, "backend.mjs"), journal = join(directory, "wire.jsonl");
  await writeFile(journal, "");
  await writeFile(protocol, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log=(kind,detail={})=>appendFileSync(${JSON.stringify(journal)},JSON.stringify({kind,processId:process.pid,...detail})+"\\n");
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\\n");
log("process-start");const input=createInterface({input:process.stdin});
input.on("line",line=>{const {id,method}=JSON.parse(line);log("rpc",{method});
 if(method==="initialize")return reply(id,{userAgent:"input-failure-local"});
 if(method==="initialized"){log("initialize-acknowledged");return;}
 if(method==="model/list")return reply(id,{data:[{id:"model-A",isDefault:true}]});
 if(method==="thread/start")return reply(id,{thread:{id:"original-source"}});
 if(method==="thread/unsubscribe")return reply(id,{status:"unsubscribed"});
 if(method==="collaborationMode/list")return reply(id,{data:[]});
 if(method==="turn/start"){log("model-start");return reply(id,{turn:{id:"original-turn"}});}
 reply(id,{});
});input.on("close",()=>log("input-ended"));setInterval(()=>{},1000);
`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [protocol], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 100, killGraceMs: 100 });
  const port = client as unknown as { child: ChildProcess; initialization?: { settled: boolean };
    initializedProcessTrees: WeakMap<ChildProcess, Promise<ProcessTreeEvidence>>; turnWaitersList: Map<unknown, unknown> };
  let failed = false, evidence: ProcessTreeEvidence | undefined;
  let startup: Promise<{ error?: Error }> | undefined;
  let joined: Promise<{ error?: Error }> | undefined;
  let turn: Promise<{ error?: Error }> | undefined;
  const controller = new AbortController(), collector = sharedGate();
  const originalExecFile = childProcess.execFile;
  let captureHeld = false;
  const pendingInitialization = mode !== "ready" && mode !== "first-cause" && mode !== "active-turn";
  const inspection = t.mock.method(childProcess, "execFile", ((command: string, args: string[], options: object, callback: unknown) => {
    const isCensus = args.some(value => value.includes("Get-CimInstance Win32_Process") && !value.includes("-Filter")) || command === "ps";
    if (!pendingInitialization || captureHeld || !isCensus) return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
    captureHeld = true;
    return Reflect.apply(originalExecFile, childProcess, [command, args, options,
      (error: Error | null, stdout: string, stderr: string) => {
        collector.enter();
        void collector.promise.then(() => Reflect.apply(callback as (...values: unknown[]) => unknown, undefined, [error, stdout, stderr]));
      }]);
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    startup = client.start(controller.signal).then(() => ({}), (error: Error) => ({ error }));
    await sharedWaitFor(async () => (await readFile(journal, "utf8")).includes('"kind":"initialize-acknowledged"'), "actual original handshake acknowledged");
    if (pendingInitialization) await collector.entered;
    else await startup;
    if (mode === "joined" || mode === "caller-abort") joined = client.listModels().then(() => ({}), (error: Error) => ({ error }));
    const original = port.child;
    if (pendingInitialization) assert.equal(port.initialization?.settled, false, "The physical original is still collecting its initialization identity");
    let source: string | undefined, owner: object | undefined;
    if (!pendingInitialization) { source = await client.startThread({ cwd: directory, ephemeral: true }); owner = client.captureThreadOwner(source); }
    if (mode === "active-turn") {
      turn = client.startTurn(source!, { prompt: "Hold the original local model turn", model: "model-A", expectedOwner: owner })
        .then(() => ({}), (error: Error) => ({ error }));
      await sharedWaitFor(() => port.turnWaitersList.size === 1, "original actual turn waiter registered");
    }
    const identities = port.initializedProcessTrees.get(original);
    assert.ok(identities);
    const fault = new Error("stream disconnected after original initialize ACK");
    original.stdin!.destroy(fault);
    await new Promise<void>(resolve => setImmediate(resolve));
    const cancelled = new Error("Only one startup observer cancelled");
    if (mode === "caller-abort") controller.abort(cancelled);
    if (mode === "first-cause") {
      original.stdout!.destroy(new Error("Secondary stdout connection reset"));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    collector.release();
    let outcome: { error?: Error };
    if (pendingInitialization) {
      const first = await startup;
      const second = await joined;
      if (mode === "caller-abort") { assert.equal(first.error, cancelled); outcome = second!; }
      else {
        outcome = first;
        if (second) assert.equal(second.error, first.error, "Joined observers receive the same original physical failure");
      }
    } else outcome = turn ? await turn : await client.health().then(() => ({}), (error: Error) => ({ error }));
    evidence = await identities;
    await writeFile(join(directory, "input-result.json"), JSON.stringify({ evidence, ready: !outcome.error,
      error: String(outcome.error), originalExited: original.exitCode !== null || original.signalCode !== null }, null, 2));
    assert.ok(outcome.error, "Broken original stdin must reject the shared startup instead of reporting ready");
    const primary = mode === "active-turn" ? outcome.error.cause as Error : outcome.error;
    assert.match(primary.message, /codex app-server stdin is unavailable/i);
    assert.equal(primary.cause, fault, "Original physical failure is preserved after cleanup");
    assert.equal(isRecoverableModelFailure(primary.message), false);
    assert.equal(isTransientFailure(primary.message), false);
    if (mode === "active-turn") {
      assert.ok(outcome.error instanceof CodexTurnInterruptionError);
      assert.equal(outcome.error.threadId, source); assert.equal(outcome.error.turnId, "original-turn");
      assert.equal(await originalProcessTreeExited({ processId: outcome.error.originalProcessId,
        processIds: outcome.error.originalProcessIds, processIdentities: outcome.error.originalProcessIdentities }), false);
    }
    if (!pendingInitialization) {
      assert.equal(original.exitCode, null, "Transport failure cannot report physical termination");
      await assert.rejects(client.health(), error => error === primary);
      await assert.rejects(client.startThread({ cwd: directory }), error => error === primary);
      assert.equal(client.isThreadAvailable(source!, owner), false);
      await client.stop();
    }
    assert.equal(await originalProcessTreeExited(evidence), true, "Original physical retirement completes before cleanup is reported");
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.kind === "process-start").length, 1);
    assert.equal(rows.filter(row => row.method === "thread/start").length, pendingInitialization ? 0 : 1);
    assert.equal(rows.filter(row => row.kind === "model-start").length, mode === "active-turn" ? 1 : 0);
    assert.equal(rows.filter(row => row.method === "turn/interrupt" || row.method === "review/start").length, 0);
    if (mode !== "active-turn") assert.equal(rows.filter(row => row.method === "model/list").length, 0);
  } catch (error) { failed = true; throw error; }
  finally {
    collector.release(); inspection.mock.restore(); syncBuiltinESMExports();
    await client.stop().catch(() => undefined); await startup; await joined; await turn;
    if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "input-failure original fixture instances exited");
    if (failed) console.error(`Input failure evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});
}

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import { CodexTurnReceiptPendingError } from "../src/pending-turn-receipt.js";
import { isRecoverableModelFailure, isTransientFailure } from "../src/transient-retry.js";

for (const mode of ["closed", "read-error", "active-turn", "pending-start", "retired-error"] as const) {
test(`original stdout failure retains cleanup responsibility: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-output-close-"));
  const protocol = join(directory, "backend.mjs"), journal = join(directory, "wire.jsonl");
  await writeFile(journal, "");
  await writeFile(protocol, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log=(kind,detail={})=>appendFileSync(${JSON.stringify(journal)},JSON.stringify({kind,processId:process.pid,...detail})+"\\n");
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\\n");
log("process-start");
const input=createInterface({input:process.stdin});
input.on("line",line=>{
 const {id,method}=JSON.parse(line);log("rpc",{method});
 if(method==="initialize")return reply(id,{userAgent:"output-close-local"});
 if(method==="initialized")return;
 if(method==="thread/start")return reply(id,{thread:{id:"original-source"}});
 if(method==="fixture/hold"){log("request-held");return;}
 if(method==="collaborationMode/list")return reply(id,{data:[]});
 if(method==="thread/unsubscribe")return reply(id,{status:"unsubscribed"});
 if(method==="turn/start"){
   log("model-start");
   if(${JSON.stringify(mode)}==="pending-start")return;
   return reply(id,{turn:{id:"original-turn"}});
 }
 if(method==="model/list")return reply(id,{data:[{id:"model-A",isDefault:true}]});
 reply(id,{});
});
input.on("close",()=>process.exit(0));
setInterval(()=>{},1000);
`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [protocol], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 100, killGraceMs: 100 });
  const port = client as unknown as { child: ChildProcess; pending: Map<unknown, unknown>;
    request<T>(method: string, params: object): Promise<T> };
  let failed = false, evidence: ProcessTreeEvidence | undefined;
  let operation: Promise<unknown> | undefined;
  try {
    const source = await client.startThread({ cwd: directory, ephemeral: true });
    const owner = client.captureThreadOwner(source), original = port.child;
    evidence = { processId: original.pid, ...await captureProcessTreeEvidence(original.pid) };
    if (mode === "retired-error") {
      const retiredOutput = original.stdout!;
      await client.releaseThreadForExternal(source, undefined, owner);
      const successor = await client.startThread({ cwd: directory, ephemeral: true });
      const nextOwner = client.captureThreadOwner(successor);
      // A real retired Socket destroy consumes any late stream error without
      // invalidating the current SDK generation; no event is fabricated.
      retiredOutput.destroy(new Error("Retired stdout stream disconnected"));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(client.isThreadAvailable(successor, nextOwner), true);
      assert.ok((await client.health()).modelCount > 0);
      await client.stop();
      assert.equal(await originalProcessTreeExited(evidence), true);
      const rows = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rows.filter(row => row.kind === "process-start").length, 2);
      assert.equal(rows.filter(row => row.kind === "model-start").length, 0);
      return;
    }
    let outcome: unknown;
    let started = false;
    const request = mode === "active-turn" || mode === "pending-start"
      ? client.startTurn(source, { prompt: "Hold the original local synthetic turn", expectedOwner: owner,
        onStarted: () => { started = true; } }) : port.request("fixture/hold", {});
    operation = request.then(() => { throw new Error("Closed pipe has no result"); }, error => { outcome = error; });
    await sharedWaitFor(async () => mode === "active-turn" ? started
      : (await readFile(journal, "utf8")).includes(mode === "pending-start" ? '"kind":"model-start"' : '"kind":"request-held"'),
      "original backend actually holds the operation");
    const closed = new Promise<void>(resolve => original.stdout!.once("close", resolve));
    const readError = new Error("transport error: stream disconnected on original output");
    original.stdout!.destroy(mode === "read-error" ? readError : undefined);
    await closed;
    await sharedWaitFor(() => outcome !== undefined, "original output-close observation settled");
    const result = { outputClosed: original.stdout!.destroyed, originalAlive: original.exitCode === null && original.signalCode === null,
      pending: port.pending.size, settled: outcome !== undefined, error: String(outcome), available: client.isThreadAvailable(source, owner) };
    await writeFile(join(directory, "output-result.json"), JSON.stringify({ evidence, result }, null, 2));
    assert.equal(result.outputClosed, true);
    assert.equal(result.originalAlive, true, "Transport loss is distinct from process termination");
    assert.equal(result.settled, true, "The actual stdout closure must settle original observers without waiting out their RPC budget");
    assert.match(String(outcome), /codex app-server.*(?:output|stdout).*(?:closed|unavailable)/i);
    assert.equal(result.pending, 0);
    assert.equal(result.available, false);
    const primary = mode === "active-turn" || mode === "pending-start" ? (outcome as Error).cause : outcome;
    assert.ok(primary instanceof Error);
    assert.equal(isRecoverableModelFailure(primary.message), false);
    assert.equal(isTransientFailure(primary.message), false);
    if (mode === "read-error") assert.equal((outcome as Error).cause, readError, "The first real Readable error remains the primary cause");
    if (mode === "active-turn") {
      assert.ok(outcome instanceof CodexTurnInterruptionError);
      assert.equal(outcome.threadId, source); assert.equal(outcome.turnId, "original-turn");
      assert.equal(await originalProcessTreeExited({ processId: outcome.originalProcessId,
        processIds: outcome.originalProcessIds, processIdentities: outcome.originalProcessIdentities }), false,
        "Local waiter failure cannot claim the remote model terminated");
    }
    if (mode === "pending-start") assert.ok(outcome instanceof CodexTurnReceiptPendingError);
    await assert.rejects(client.health(), /stdout/i);
    await assert.rejects(client.startThread({ cwd: directory, ephemeral: true }), /stdout/i);
    await assert.rejects(client.startTurn(source, { prompt: "Never retry through a lost output", expectedOwner: owner }), /stdout|original.*owner.*unavailable/i);
    assert.equal(port.child, original, "Broken output retains the same physical process for cleanup");
    await client.stop();
    assert.equal(await originalProcessTreeExited(evidence), true);
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.kind === "process-start").length, 1);
    assert.equal(rows.filter(row => row.kind === "model-start").length, mode === "active-turn" || mode === "pending-start" ? 1 : 0);
    assert.equal(rows.filter(row => row.method === "turn/interrupt" || row.method === "thread/fork").length, 0);
  } catch (error) { failed = true; throw error; }
  finally {
    await client.stop().catch(() => undefined); await operation;
    if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "output-close original fixture instances exited");
    if (failed) console.error(`Output-close evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});
}

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

for (const mode of ["rejected", "cancelled", "denied", "launcher-lost", "racing-start"] as const) {
test(`initialization retains original backend ownership: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-initialization-stop-tree-"));
  const journal = join(directory, "wire.jsonl"), backend = join(directory, "backend.mjs"), launcher = join(directory, "launcher.mjs");
  const rejectionMarker = join(directory, "reject-original-initialization"), exitMarker = join(directory, "release-owned-backends");
  const readyMarker = join(directory, "allow-explicit-replacement");
  let failed = false, evidence: ProcessTreeEvidence | undefined;
  await writeFile(journal, "");
  await writeFile(backend, `
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const log=(kind, detail={})=>appendFileSync(${JSON.stringify(journal)}, JSON.stringify({kind,processId:process.pid,...detail})+"\\n");
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\\n");
let initializeId, rejected=false;
const replacement=existsSync(${JSON.stringify(readyMarker)});
const tolerate=(error)=>{if(!["EPIPE","ECONNRESET","EBADF","ERR_STREAM_DESTROYED"].includes(error.code))throw error;};
process.stdin.on("error",tolerate);process.stdout.on("error",tolerate);
log("process-start");
const input=createInterface({input:process.stdin});input.on("error",tolerate);
input.on("line",line=>{
 const {id,method}=JSON.parse(line);log("rpc",{method});
 if(method==="initialize"){initializeId=id;log("initialize-held");if(replacement){rejected=true;reply(id,{userAgent:"explicit-replacement"});}return;}
 if(method==="initialized")return;
 if(method==="turn/start"||method==="review/start")log("unexpected-model");
 if(method==="thread/start"){log("thread-start");reply(id,{thread:{id:"explicit-source"}});return;}
 if(method==="model/list"){reply(id,{data:[{id:"model-A",isDefault:true}]});return;}
 if(method==="thread/unsubscribe"){reply(id,{status:"unsubscribed"});return;}
 reply(id,{});
});
input.on("close",()=>log("stdin-eof"));
setInterval(()=>{
 if(existsSync(${JSON.stringify(exitMarker)}))process.exit(0);
 if(initializeId&&!rejected&&existsSync(${JSON.stringify(rejectionMarker)})){rejected=true;reply(initializeId,{userAgent:17});log("initialize-rejected");}
},10);
`);
  await writeFile(launcher, `
import { spawn } from "node:child_process";
const child=spawn(process.execPath,[${JSON.stringify(backend)}],{stdio:"inherit",detached:true,windowsHide:true});
child.once("error",()=>process.exit(1));child.once("exit",code=>process.exit(code??1));
`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [launcher], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 50, killGraceMs: 50 });
  const port = client as unknown as { child: ChildProcess; idleRetirement?: object; initialization: { promise: Promise<void> } };
  const originalExecFile = childProcess.execFile;
  try {
    const controller = new AbortController();
    const startup = client.start(controller.signal).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await sharedWaitFor(async () => (await readFile(journal, "utf8")).includes('"kind":"initialize-held"'), "original backend has accepted initialize");
    const original = port.child, captured = await captureProcessTreeEvidence(original.pid);
    evidence = captured && { processId: original.pid, ...captured };
    assert.ok(evidence?.processIdentities && evidence.processIdentities.length >= 2);
    const originalFlight = port.initialization;
    if (mode === "denied") {
      childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
        if (args.includes("-EncodedCommand") || command === "python3") return Reflect.apply(originalExecFile, childProcess,
          [process.execPath, ["-e", "process.exit(13)"], options, callback]);
        return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
      }) as typeof childProcess.execFile; syncBuiltinESMExports();
    }
    const cancellation = new Error("Only the original initialization observer cancelled");
    if (mode === "cancelled") controller.abort(cancellation);
    else if (mode === "launcher-lost") original.kill();
    else await writeFile(rejectionMarker, "reject");
    let raced: Promise<{ value?: string; error?: unknown }> | undefined;
    if (mode === "racing-start") {
      await sharedWaitFor(() => Boolean(port.idleRetirement), "rejected original initializer is actually retiring");
      await writeFile(readyMarker, "ready");
      raced = client.startThread({ cwd: directory }).then((value) => ({ value }), (error: unknown) => ({ error }));
    }
    const outcome = await startup;
    if (mode === "cancelled") assert.equal(outcome.error, cancellation);
    else assert.match(String(outcome.error), mode === "launcher-lost" ? /codex app-server exited/i : /invalid Codex initialize response/);
    await originalFlight.promise.catch(() => undefined);
    if (mode === "denied" || mode === "launcher-lost") {
      assert.ok(port.idleRetirement);
      assert.equal(await originalProcessTreeExited(evidence), false);
      await assert.rejects(client.startThread({ cwd: directory }), /cleanup.*unconfirmed/i);
      const blockedRows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(blockedRows.filter((row) => row.kind === "process-start").length, 1);
      if (mode === "denied") {
        childProcess.execFile=originalExecFile;syncBuiltinESMExports();
        await (client as unknown as { idleShutdown(): Promise<void> }).idleShutdown();
      }
    }
    const treeExited = await originalProcessTreeExited(evidence);
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await writeFile(join(directory, "rejected-result.json"), JSON.stringify({ evidence, treeExited, rows }, null, 2));
    assert.equal(rows.filter((row) => row.kind === "unexpected-model").length, 0);
    if (mode === "launcher-lost") assert.equal(treeExited, false, "Lost census remains unknown rather than authorizing a replacement");
    else {
      assert.equal(treeExited, true, "A rejected initializer cannot discard ownership while its original backend remains live");
      await writeFile(readyMarker, "ready");
      const successor: { value?: string; error?: unknown } = raced ? await raced
        : await client.startThread({ cwd: directory }).then((value) => ({ value }), (error: unknown) => ({ error }));
      assert.equal(successor.error, undefined, "A later explicit metadata request follows cleanup instead of joining a failed initializer");
      assert.ok(successor.value); assert.notEqual(port.child.pid, original.pid);
      await client.releaseThreadForExternal(successor.value!, undefined, client.captureThreadOwner(successor.value!));
      const finalRows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(finalRows.filter((row) => row.kind === "process-start").length, 2);
      assert.equal(finalRows.filter((row) => row.kind === "thread-start").length, 1);
    }
  } catch (error) { failed = true; throw error; }
  finally {
    childProcess.execFile=originalExecFile;syncBuiltinESMExports();
    await writeFile(exitMarker, "release"); await client.stop().catch(() => undefined);
    if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "all original initialization fixture instances exited");
    if (failed) console.error(`Initialization tree evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});
}

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { isCompleteProcessIdentityEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

for (const mode of ["late", "held", "successor", "stop"] as const) {
  test(`original exit diagnostic drains with bounded ownership: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-exit-stderr-"));
    const backend = join(directory, "backend.mjs"), writer = join(directory, "writer.mjs");
    const wire = join(directory, "wire.jsonl"), heartbeat = join(directory, "heartbeat.txt");
    await writeFile(writer, `import {writeFileSync} from "node:fs";
let count=0;
process.stderr.write("inherited-writer-ready\\n",()=>{
 writeFileSync(process.argv[2],String(count));
 setInterval(()=>writeFileSync(process.argv[2],String(++count)),20);
});`);
    await writeFile(backend, `import {createInterface} from "node:readline";
import {appendFileSync,existsSync} from "node:fs";import {spawn} from "node:child_process";
const [wire,writer,heartbeat,mode]=process.argv.slice(2);
appendFileSync(wire,JSON.stringify({kind:"start",pid:process.pid})+"\\n");
const input=createInterface({input:process.stdin});
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\\n");
input.on("line",line=>{const {id,method,params={}}=JSON.parse(line);
 if(method==="initialize"){
  if(mode!=="held")return reply(id,{userAgent:"exit-stderr-local"});
  const child=spawn(process.execPath,[writer,heartbeat],{stdio:"inherit",detached:true,windowsHide:true});
  appendFileSync(wire,JSON.stringify({kind:"writer",pid:child.pid})+"\\n");
  const ready=setInterval(()=>{if(existsSync(heartbeat)){clearInterval(ready);reply(id,{userAgent:"exit-stderr-local"});}},5);
  return;
 }
 if(method==="initialized")return;
 if(method==="thread/start")return reply(id,{thread:{id:"original-address"}});
 if(method==="model/list")return reply(id,{data:[]});
 if(method==="fixture/exit")return process.stderr.write(params.text,()=>process.exit(42));
 reply(id,{});
});input.on("close",()=>process.exit(0));`);
    const client = new CodexAppServerClient({ command: process.execPath, args: [backend, wire, writer, heartbeat, mode],
      requestTimeoutMs: 5000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
    const port = client as unknown as { child: ChildProcess; request(method: string, params: object): Promise<unknown>;
      initializedProcessTrees: WeakMap<ChildProcess, Promise<ProcessTreeEvidence>> };
    const text = "原进程退出后完整读出的诊断：模型连接中断😀";
    const events: string[] = [], chunks: Buffer[] = [];
    let evidence: ProcessTreeEvidence | undefined, failed = false;
    let successor: Promise<unknown> | undefined, stopping: Promise<void> | undefined;
    let exitAt = 0, unavailableAtExit = false;
    try {
      const threadId = await client.startThread({ cwd: directory, ephemeral: true });
      const original = port.child;
      evidence = await port.initializedProcessTrees.get(original);
      assert.equal(isCompleteProcessIdentityEvidence(evidence!), true, "Require actual original births before exit");
      if (mode === "held") {
        const rows = (await readFile(wire, "utf8")).trim().split("\n").map(row => JSON.parse(row));
        const writerPid = rows.find(row => row.kind === "writer")?.pid;
        assert.ok(evidence!.processIds!.includes(writerPid), "Capture the actual inherited-pipe writer before the root exits");
      }
      original.stderr!.on("data", chunk => { chunks.push(Buffer.from(chunk)); events.push("data"); });
      if (mode !== "held") original.stderr!.pause();
      original.once("exit", () => {
        exitAt = Date.now(); events.push("exit");
        unavailableAtExit = !client.isThreadAvailable(threadId);
        if (mode === "successor") { successor = client.health().then(() => { events.push("successor"); }); void successor.catch(() => undefined); }
        if (mode === "stop") { stopping = client.stop(); void stopping.catch(() => undefined); }
      });
      const outcome = await port.request("fixture/exit", { text }).then(() => {
        throw new Error("Actual exited process cannot reply");
      }, (error: Error) => { events.push("failure"); return error; });
      const elapsedAfterExit = Date.now() - exitAt;
      const pipeOpenAtFailure = !original.stderr!.readableEnded;
      await writeFile(join(directory, "exit-result.json"), JSON.stringify({ mode, evidence, events, error: outcome.message,
        exitAt, elapsedAfterExit, pipeOpenAtFailure, bytes: Buffer.concat(chunks).length, unavailableAtExit }, null, 2));
      assert.equal(unavailableAtExit, true, "Actual exit invalidates the original thread before diagnostic draining");
      assert.ok(outcome.message.includes(text), "Original complete stderr must reach its exit failure");
      assert.ok(elapsedAfterExit < 1000, "Inherited stderr cannot hold the failure until the 4s RPC deadline");
      if (mode === "held") {
        assert.equal(pipeOpenAtFailure, true);
        assert.match(outcome.message, /stderr diagnostic stream did not finish before exit deadline/);
        const count = Number(await readFile(heartbeat, "utf8"));
        await sharedWaitFor(async () => Number(await readFile(heartbeat, "utf8")) > count, "actual inherited-pipe writer remains alive");
        assert.equal(await originalProcessTreeExited(evidence!), false, "Diagnostic timeout is not physical descendant exit proof");
      } else {
        assert.ok(events.indexOf("exit") < events.indexOf("data"), "Actual buffered pipe data follows actual OS exit");
        assert.ok(events.indexOf("data") < events.indexOf("failure"));
      }
      if (successor) {
        await successor;
        assert.ok(events.indexOf("failure") < events.indexOf("successor"));
        assert.notEqual(port.child.pid, original.pid);
        assert.equal(await client.startThread({ cwd: directory, ephemeral: true }), threadId);
        assert.equal(client.isThreadAvailable(threadId), true, "Old exit notification cannot clear the same-address successor");
      }
      if (stopping) {
        await stopping;
        await assert.rejects(client.health(), /stopped/);
      }
      const starts = (await readFile(wire, "utf8")).trim().split("\n").map(row => JSON.parse(row)).filter(row => row.kind === "start");
      assert.equal(starts.length, mode === "successor" ? 2 : 1);
    } catch (error) {
      failed = true;
      await writeFile(join(directory, "assertion-failure.json"), JSON.stringify({ mode, evidence, events,
        error: error instanceof Error ? error.stack : String(error) }, null, 2));
      throw error;
    }
    finally {
      await successor?.catch(() => undefined); await stopping?.catch(() => undefined);
      await client.stop();
      if (evidence && isCompleteProcessIdentityEvidence(evidence)) {
        await sharedWaitFor(() => originalProcessTreeExited(evidence!), "original exit fixture tree retired");
      }
      if (failed) console.error(`Exit stderr evidence retained: ${directory}`);
      else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
    }
  });
}

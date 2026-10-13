import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require=createRequire(import.meta.url),tsx=require.resolve("tsx/cli");
const actor=fileURLToPath(new URL("./fixtures/lease-heartbeat-error-actor.ts",import.meta.url));
for(const mode of ["busy","busy-unobserved","error","revoked","healthy","stop","peer","live-busy"]){
 test("lease heartbeat contains renewal failure and retires only its original observation: "+mode,{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"dsh-lease-heartbeat-error-"));
  const worker=spawn(process.execPath,[tsx,actor,directory,mode],{windowsHide:true,stdio:["ignore","pipe","pipe"]});worker.stdout.resume();worker.stderr.resume();
  const code=await new Promise<number|null>((resolve,reject)=>{worker.once("error",reject);worker.once("close",resolve);});
  const rows=(await readFile(join(directory,"states.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(code,0,"Heartbeat actor failed; evidence retained "+directory);assert.equal(rows.filter(row=>row.kind==="uncaught-timer").length,0);assert.equal(rows.at(-1).kind,"actor-complete");
  assert.equal(rows.at(-1).peerLost,0);assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});
 });
}

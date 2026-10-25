import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require=createRequire(import.meta.url),tsx=require.resolve("tsx/cli");
const actor=fileURLToPath(new URL("./fixtures/shared-reviewer-cancellation-actor.ts",import.meta.url));
for(const mode of ["notice","forwarded","background","healthy","pre-aborted","double-close","native-timeout"]) {
  test(`Shared Reviewer test cancellation leaves held phases and owns cleanup: ${mode}`,{timeout:20000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),"dsh-shared-test-cancel-"));
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const worker=spawn(process.execPath,[tsx,actor,directory,mode],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    worker.stdout.resume();worker.stderr.resume();
    const code=await new Promise<number|null>((resolve,reject)=>{worker.once("error",reject);worker.once("close",resolve);});
    const rows=(await readFile(join(directory,"states.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(code,mode === "native-timeout" ? 1 : 0,`Original fixture actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row=>row.kind === "uncaught-monitor").length,0);
    assert.equal(rows.at(-1).kind,"actor-complete",`Fixture did not finish its own cleanup; evidence retained ${directory}; final events ${JSON.stringify(rows.slice(-3))}`);
    if(mode === "native-timeout") {
      assert.ok(rows.some(row=>row.kind === "held-native-notice"),"Native timeout occurred at the intended held lease phase");
      const cleaned=rows.find(row=>row.kind === "native-after-cleaned");
      assert.equal(cleaned.aborted,true);assert.equal(cleaned.nativeCalls,1);assert.equal(cleaned.phase,"lease loss observation");
    }
    else if(["notice","forwarded","background"].includes(mode)) assert.equal(rows.find(row=>row.kind === "cancelled-original-wait").originalCause,true);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});
  });
}

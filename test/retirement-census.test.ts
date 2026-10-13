import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isRecoverableModelFailure, isTransientFailure } from "../src/transient-retry.js";

const require=createRequire(import.meta.url),tsx=require.resolve("tsx/cli");
const actor=new URL("./fixtures/retirement-census-actor.mjs",import.meta.url).href;
const scenario=fileURLToPath(new URL("./app-server-callback.test.ts",import.meta.url));
for(const mode of ["once","always","retired-owner"] as const){
  test(`original SDK retirement census recovery: ${mode}`,{timeout:45000,skip:process.platform!=="win32"},async()=>{
    const directory=await mkdtemp(join(tmpdir(),"dsh-retirement-census-"));
    const env:NodeJS.ProcessEnv={...process.env,DSH_WORKFLOW_RETIREMENT_CENSUS_MODE:mode,DSH_WORKFLOW_RETIREMENT_CENSUS_REPORT:join(directory,"report.jsonl")};
    delete env.NODE_TEST_CONTEXT;
    const worker=spawn(process.execPath,[tsx,"--test","--import",actor,"--test-reporter=tap",
      "--test-name-pattern=^creates and reuses a dedicated Reviewer task for every background review, never touching the origin task$",scenario],
      {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";worker.stdout.setEncoding("utf8");worker.stderr.setEncoding("utf8");
    worker.stdout.on("data",chunk=>{stdout+=chunk;});worker.stderr.on("data",chunk=>{stderr+=chunk;});
    const code=await new Promise<number|null>((resolve,reject)=>{worker.once("error",reject);worker.once("close",resolve);});
    await writeFile(join(directory,"worker.log"),stdout+stderr);
    const rows=(await readFile(join(directory,"report.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    const stop=rows.find(row=>row.kind==="stop"),censuses=rows.filter(row=>row.kind==="census");
    assert.ok(stop?.originalPid,`Original native stop was not reached; evidence retained ${directory}`);
    assert.equal(code,mode==="once"?0:1,`Original census fault was mishandled; evidence retained ${directory}`);
    assert.equal(stop.censuses,mode==="retired-owner"?1:2);
    assert.equal(censuses.length,stop.censuses);
    assert.ok(censuses.every(row=>row.originalPid===stop.originalPid&&row.stillOwned&&row.originalAlive),"Only the same live, still-owned original child can authorize a census retry");
    assert.equal(stop.originalExited,true);assert.equal(stop.additionalModelRequests,0);assert.equal(stop.stoppedFence,true);
    assert.equal(/Warning: A resource generated asynchronous activity|unhandledRejection|uncaughtException/.test(stdout+stderr),false);
    if(mode==="once"){
      assert.equal(stop.error,undefined);assert.equal(stop.capturedRoot,true);assert.equal(stop.capturedBirth,true);assert.equal(stop.retainedTrees,0);
      assert.match(stdout,/^# pass 1$/m);
    }else{
      assert.match(stop.error,/Original fork creation or App Server process tree cleanup is unconfirmed/);
      assert.equal(stop.retainedTrees,1);assert.equal(stop.capturedRoot,false);assert.equal(stop.capturedBirth,false);
      assert.deepEqual(stop.cleanupDiagnostics?.map((value:{code:string})=>value.code),
        mode==="always"?["query_failed","query_failed"]:["query_failed","owner_retired"],
        "The actual rejected retirement retains safe observations instead of losing their cause");
      assert.equal(stop.diagnosticsFrozen,true);
      assert.ok(stop.cleanupDiagnostics.every((value:{processId:number;limitMs:number})=>value.processId===stop.originalPid&&value.limitMs===4000));
      assert.equal(isTransientFailure(stop.error),false,"Local census diagnostics cannot enter model backoff");
      assert.equal(isRecoverableModelFailure(stop.error),false,"Cleanup evidence cannot authorize model continuation");
      assert.match(stdout,/^# fail 1$/m);
      const owned=resolve(stop.originalDirectory);assert.ok(owned.startsWith(resolve(tmpdir())+sep));
      assert.ok(basename(owned).startsWith("dsh-app-server-callback-"));await rm(owned,{recursive:true,force:true});
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});
  });
}

import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { captureProcessTreeEvidence, type ProcessTreeCaptureObservation } from "../src/infrastructure/process-transport.js";

const root=88788,birth="win32:134357732495098540";
const valid=JSON.stringify([{ProcessId:root,ParentProcessId:3788,Birth:birth}]);
const privateMarker="PRIVATE_CENSUS_DIAGNOSTIC_TOKEN";
const cases=[
  {name:"permission errno",error:{code:"EACCES"},output:valid,code:"permission_denied"},
  {name:"terminated query",error:{code:null,killed:true,signal:"SIGTERM"},output:valid,code:"query_terminated"},
  {name:"command exit",error:{code:13},output:valid,code:"query_failed",exitCode:13},
  {name:"launch failure",error:{code:"ENOENT"},output:valid,code:"query_failed"},
  {name:"output bound",error:{code:"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"},output:valid,code:"output_limit"},
  {name:"unknown private error fields",error:{code:privateMarker,signal:privateMarker},output:valid,code:"query_failed"},
  {name:"malformed response",output:privateMarker,code:"invalid_response"},
  {name:"missing original root",output:"[]",code:"root_missing"},
  {name:"incomplete birth",output:JSON.stringify([{ProcessId:root,ParentProcessId:3788}]),code:"identity_incomplete",partial:true},
  {name:"complete original capture",output:valid,code:"captured",complete:true},
];
for(const scenario of cases){
  test(`Windows census reports sanitized original observation: ${scenario.name}`,{skip:process.platform!=="win32"},async(t)=>{
    let elapsed=0;
    t.mock.method(performance,"now",()=>elapsed);
    const observed:ProcessTreeCaptureObservation[]=[];
    const stub=((_file:string,args:string[],options:ExecFileOptions,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>{
      assert(args.some(arg=>arg.includes("Get-CimInstance Win32_Process")));assert.equal(options.timeout,4000);
      queueMicrotask(()=>{elapsed=4100;callback(scenario.error?Object.assign(new Error(privateMarker),scenario.error):null,scenario.output,privateMarker);});
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile;
    const mock=t.mock.method(childProcess,"execFile",stub);syncBuiltinESMExports();
    try{
      const result=await captureProcessTreeEvidence(root,note=>observed.push(note));
      assert.equal(observed.length,1,"The actual producer must preserve one observation for this original capture");
      assert.equal(observed[0]!.processId,root);assert.equal(observed[0]!.code,scenario.code);
      assert.equal(observed[0]!.elapsedMs,4100);assert.equal(observed[0]!.limitMs,4000);
      if(scenario.exitCode!==undefined)assert.equal(observed[0]!.exitCode,scenario.exitCode);
      assert.equal(JSON.stringify(observed).includes(privateMarker),false,"Raw stderr, output and error text must never enter diagnostics");
      assert.equal(Object.isFrozen(observed[0]),true);
      if(scenario.complete){assert.deepEqual(result?.processIds,[root]);assert.deepEqual(result?.processIdentities,[{processId:root,birth}]);}
      else if(scenario.partial){assert.deepEqual(result?.processIds,[root]);assert.equal(result?.processIdentities,undefined);}
      else assert.equal(result,undefined,"Diagnostic delivery cannot create usable evidence from a rejected observation");
    }finally{mock.mock.restore();syncBuiltinESMExports();}
  });
}

test("an invalid census root reports no invented identity or native query",async(t)=>{
  let calls=0;
  const mock=t.mock.method(childProcess,"execFile",(()=>{calls++;throw new Error("Invalid roots cannot launch a census");}) as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try{
    const observed:ProcessTreeCaptureObservation[]=[];
    assert.equal(await captureProcessTreeEvidence(0,note=>observed.push(note)),undefined);
    assert.equal(calls,0);assert.equal(observed.length,1);assert.equal(observed[0]!.code,"invalid_root");
    assert.equal(Object.hasOwn(observed[0]!,"processId"),false);assert.equal(Object.isFrozen(observed[0]),true);
  }finally{mock.mock.restore();syncBuiltinESMExports();}
});

test("census diagnostic observer failures cannot change original evidence or escape the host",{skip:process.platform!=="win32"},async(t)=>{
  const mock=t.mock.method(childProcess,"execFile",((_file:string,_args:string[],_options:ExecFileOptions,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>{
    queueMicrotask(()=>callback(null,valid,""));return new childProcess.ChildProcess();
  }) as typeof childProcess.execFile);syncBuiltinESMExports();
  try{
    for(const observer of [()=>{throw new Error(privateMarker);},async()=>{throw new Error(privateMarker);}]){
      const result=await captureProcessTreeEvidence(root,observer);
      assert.deepEqual(result?.processIdentities,[{processId:root,birth}]);
    }
    await new Promise<void>(resolve=>setImmediate(resolve));
  }finally{mock.mock.restore();syncBuiltinESMExports();}
});

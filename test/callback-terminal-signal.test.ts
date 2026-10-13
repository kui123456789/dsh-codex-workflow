import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import type {ChildProcess} from "node:child_process";
import test from "node:test";
import {CodexCallbackDispatcher, CodexCallbackProcessError} from "../src/codex-callback.js";

function fixture(diagnostic:string,code:number|null){
 let calls=0;
 const dispatcher=new CodexCallbackDispatcher({command:"local-synthetic-callback",schemaFile:"review.json",timeoutMs:1000,maxOutputBytes:4096,
  spawn:()=>{calls+=1;const child=new EventEmitter(),stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();let closed=false;
   const close=(exitCode:number|null)=>{if(closed)return;closed=true;queueMicrotask(()=>child.emit("close",exitCode,exitCode===null?"SIGTERM":null));};
   stdin.once("finish",()=>{stdout.end();stderr.end(diagnostic);close(code);});Object.assign(child,{pid:515151,stdin,stdout,stderr,kill:()=>{close(null);return true;}});return child as unknown as ChildProcess;}
 });
 return {dispatcher,get calls(){return calls;}};
}
const request={workflowId:"wf-signal",submissionId:"submission-signal",codexThreadId:"reviewer-signal",cwd:process.cwd(),prompt:"Review the approved implementation",ephemeral:true};
for(const diagnostic of ["403 Forbidden: stream disconnected","Schema validation failed: rate limit","visible output violates the display contract: server overloaded","thread does not exist: already has an active writer"]){
 test(`signal-exit terminal callback diagnostic stays terminal: ${diagnostic}`,async t=>{const f=fixture(diagnostic,null);let error:unknown,result:unknown;
  try{try{result=await f.dispatcher.send(request);}catch(value){error=value;}t.diagnostic(JSON.stringify({diagnostic,calls:f.calls,resultKind:result&&typeof result === "object"?(result as {kind?:string}).kind:undefined,errorType:error instanceof Error?error.constructor.name:typeof error,message:error instanceof Error?error.message:String(error)}));
   assert(error instanceof CodexCallbackProcessError);assert.ok(!error.recoverableModelFailure);assert(error.message.includes(diagnostic));assert.equal(f.calls,1);
  }finally{await f.dispatcher.stop();}
 });
}
test("signal-exit unknown/transient callback diagnostics keep existing retryable behavior",async()=>{for(const diagnostic of ["503 Service Unavailable",""]){const f=fixture(diagnostic,null);try{const result=await f.dispatcher.send(request);assert.equal(result.kind,"retryable_busy");assert.equal(f.calls,1);}finally{await f.dispatcher.stop();}}});

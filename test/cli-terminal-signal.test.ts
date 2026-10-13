import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import type {ChildProcess} from "node:child_process";
import test from "node:test";
import {CodexCliAuditDispatcher} from "../src/codex-cli-audit.js";
import {CodexCallbackProcessError} from "../src/codex-callback.js";

function fixture(diagnostic:string,code:number|null){
 let calls=0;
 const dispatcher=new CodexCliAuditDispatcher({command:"local-synthetic-signal",reviewSchemaFile:"review.json",alignmentSchemaFile:"alignment.json",timeoutMs:1000,
  retry:{baseMs:1,maxMs:1,budgetMs:0,jitterRatio:0},spawn:()=>{
   calls+=1;const child=new EventEmitter(),stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();
   let closed=false;
   const close=(exitCode:number|null)=>{if(closed)return;closed=true;queueMicrotask(()=>child.emit("close",exitCode,exitCode===null?"SIGTERM":null));};
   stdin.once("finish",()=>{stdout.end();stderr.end(diagnostic);close(code);});
   Object.assign(child,{pid:424242,stdin,stdout,stderr,kill:()=>{close(null);return true;}});
   return child as unknown as ChildProcess;
  }});
 return {dispatcher,get calls(){return calls;}};
}
for(const diagnostic of ["403 Forbidden: stream disconnected","Schema validation failed: rate limit","visible output violates the display contract: server overloaded","thread does not exist: already has an active writer"]){
 test(`terminal CLI signal-exit keeps its original typed failure: ${diagnostic}`,async t=>{
  const f=fixture(diagnostic,null);let error:unknown;
  try{
   try{await f.dispatcher.normalize({visibleText:"Original readable review",cwd:process.cwd(),workflowId:"terminal-signal"});}catch(value){error=value;}
   t.diagnostic(JSON.stringify({diagnostic,exitCode:null,errorType:error instanceof Error?error.constructor.name:typeof error,
    message:error instanceof Error?error.message:String(error),calls:f.calls}));
   assert(error instanceof CodexCallbackProcessError,"A terminal diagnostic must not become busy just because close has no numeric exit code");
   assert.equal(error.recoverableModelFailure,false);assert(error.message.includes(diagnostic));assert.equal(f.calls,1);
  }finally{await f.dispatcher.stop();}
 });
}
test("ordinary nonzero CLI terminal diagnostics retain existing classification",async()=>{
 const f=fixture("403 Forbidden: stream disconnected",1);
 try{await assert.rejects(f.dispatcher.normalize({visibleText:"Review",cwd:process.cwd(),workflowId:"terminal-nonzero"}),
  error=>error instanceof CodexCallbackProcessError&&!error.recoverableModelFailure);assert.equal(f.calls,1);}finally{await f.dispatcher.stop();}
});
for(const diagnostic of ["503 Service Unavailable",""]){
 test(`unknown CLI signal-exit retains existing retryable behavior: ${diagnostic||"no diagnostic"}`,async()=>{
  const f=fixture(diagnostic,null);
  try{await assert.rejects(f.dispatcher.normalize({visibleText:"Review",cwd:process.cwd(),workflowId:"signal-control"}),
   error=>error instanceof Error&&!(error instanceof CodexCallbackProcessError)&&/audit busy/.test(error.message));assert.equal(f.calls,1);}finally{await f.dispatcher.stop();}
 });
}

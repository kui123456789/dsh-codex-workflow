import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { CodexAppServerClient } from "../../src/app-server.js";

const mode=process.env.DSH_WORKFLOW_RETIREMENT_CENSUS_MODE;
const report=process.env.DSH_WORKFLOW_RETIREMENT_CENSUS_REPORT;
if(!["once","always","retired-owner"].includes(mode)||!report)throw new Error("Missing retirement census probe setup");
const log=value=>appendFileSync(report,JSON.stringify(value)+"\n","utf8");
const originalExecFile=childProcess.execFile, originalStop=CodexAppServerClient.prototype.stop;
const originalRequest=CodexAppServerClient.prototype.requestRaw;
let sdk,child,insideStop=false,censuses=0,modelRequests=0;
CodexAppServerClient.prototype.requestRaw=function(method,...args){
  if(["thread/start","thread/fork","thread/resume","turn/start","review/start"].includes(method))modelRequests+=1;
  return originalRequest.call(this,method,...args);
};
childProcess.execFile=function(...args){
  const values=args[1];
  const full=Array.isArray(values)&&values.some(value=>String(value).includes("Get-CimInstance Win32_Process -ErrorAction Stop"));
  if(!insideStop||!full)return Reflect.apply(originalExecFile,childProcess,args);
  censuses+=1;
  log({kind:"census",attempt:censuses,originalPid:child?.pid,stillOwned:sdk.child===child,
    originalAlive:Boolean(child&&child.exitCode===null&&child.signalCode===null)});
  const unavailable=mode==="always"||censuses===1;
  if(!unavailable)return Reflect.apply(originalExecFile,childProcess,args);
  const callback=args.at(-1);
  return Reflect.apply(originalExecFile,childProcess,[...args.slice(0,-1),(error,stdout,stderr)=>{
    if(mode==="retired-owner")sdk.child=undefined;
    callback(new Error("Controlled original retirement census unavailable"),"",stderr);
  }]);
};
syncBuiltinESMExports();
CodexAppServerClient.prototype.stop=function(...args){
  sdk=this;child??=this.child;insideStop=true;
  const before=modelRequests;
  const observe=async(error)=>{
    const retirement=this.processRetirements.get(child);
    const evidence=retirement?await retirement.evidence:undefined;
    let stoppedFence=false;
    try{await this.start();}catch(cause){stoppedFence=/stopped/i.test(String(cause));}
    log({kind:"stop",mode,censuses,originalPid:child?.pid,error:error?String(error):undefined,
      originalExited:Boolean(child&&(child.exitCode!==null||child.signalCode!==null)),
      capturedRoot:Boolean(evidence?.processIds?.includes(child?.pid)),
      capturedBirth:Boolean(evidence?.processIdentities?.find(value=>value.processId===child?.pid)?.birth),
      retainedTrees:this.stopForkTrees.size,additionalModelRequests:modelRequests-before,stoppedFence,
      cleanupDiagnostics:error?.cleanupDiagnostics,
      diagnosticsFrozen:Boolean(error&&Object.isFrozen(error.cleanupDiagnostics)&&error.cleanupDiagnostics?.every(value=>Object.isFrozen(value))),
      originalDirectory:dirname(this.options.env.FAKE_CODEX_THREAD_PARAMS_MARKER)});
  };
  return originalStop.apply(this,args).then(async value=>{await observe();return value;},async error=>{await observe(error);throw error;})
    .finally(()=>{insideStop=false;});
};

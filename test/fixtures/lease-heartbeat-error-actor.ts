import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";
import type { ManagerLease } from "../../src/workflow.js";

const [directory,mode]=process.argv.slice(2);assert.ok(directory&&mode);
const log=(kind:string,detail:object={})=>appendFileSync(join(directory,"states.jsonl"),JSON.stringify({kind,...detail})+"\n");
async function main() {
const f=await sharedReviewerFixture({mode:mode==="live-busy"?"active":"retained"});
const leasePort=f.manager as unknown as {acquireSubmissionLease(workflowId:string,submissionId:string):Promise<ManagerLease|undefined>};
let lease:ManagerLease|undefined;
f.store.coordinationHandle.db.exec("PRAGMA busy_timeout=10");
const peer=new DatabaseSync(join(f.directory,"coord.sqlite"));
const renew=f.store.coordinationHandle.renewLease.bind(f.store.coordinationHandle);
let calls=0,uncaught=0,lost=0,peerLost=0,locked=false;
let other:ManagerLease|undefined;
const onUncaught=(error:Error)=>{uncaught++;log("uncaught-timer",{message:error.message});};
// Diagnostic interception records the old timer fault without taking down the
// actor before it releases its own SQLite transaction and fixture.
process.on("uncaughtException",onUncaught);
try{
 if(mode==="live-busy"){
    await f.start();lease=f.firstLease;assert.ok(lease);
   const initial=await f.control("fixture/stats");assert.equal(initial.turnStartRequests.length,1);
   peer.exec("BEGIN IMMEDIATE");locked=true;
   await f.lossSeen.entered;
   peer.exec("ROLLBACK");locked=false;
   f.lossRelease.release();await f.lossForwarded.entered;
   await sharedWaitFor(()=>f.runtime.backgroundTasks.size===0,"failed renewal cancels its original active Reviewer");
   const after=await f.control("fixture/stats");
   log("observed-live-renewal-loss",{uncaught,nativeCalls:f.nativeOptions.length,activeTurns:after.active.length,children:f.children.length,disposals:f.rawDisposals.length});
   assert.equal(uncaught,0);assert.equal(after.active.length,0);assert.equal(after.turnStartRequests.length,initial.turnStartRequests.length);
   assert.equal(f.rawDisposals.length,1);assert.equal(f.children.length,1);
   log("actor-complete",{mode,calls,uncaught,lost:1,peerLost});return;
 }
 lease=await leasePort.acquireSubmissionLease("heartbeat-probe","original-submission");assert.ok(lease);
 f.store.coordinationHandle.renewLease=(...args)=>{calls++;if(mode==="error")throw new Error("controlled renewal failure");return renew(...args);};
 if(mode==="peer"){other=await leasePort.acquireSubmissionLease("peer-workflow","peer-submission");assert.ok(other);other.heartbeat(100,()=>{peerLost++;});}
 if(mode==="busy"||mode==="busy-unobserved"){peer.exec("BEGIN IMMEDIATE");locked=true;}
 if(mode==="revoked"||mode==="peer")assert.equal(await lease.release(),true);
 lease.heartbeat(100,mode==="busy-unobserved"?undefined:()=>{lost++;log("original-lease-lost");});
 if(mode==="stop")lease.stopHeartbeat();
 await new Promise(resolve=>setTimeout(resolve,320));
 log("observed-heartbeat",{mode,calls,uncaught,lost,peerLost,modelCalls:f.nativeOptions.length});
 assert.equal(uncaught,0,"A failed renewal is contained by its original heartbeat");
 if(mode==="healthy"||mode==="stop"){assert.equal(lost,0);if(mode==="stop")assert.equal(calls,0);else assert.ok(calls>=1);}
 else if(mode==="busy-unobserved"){assert.equal(calls,1);assert.equal(lost,0);}
 else {assert.equal(lost,1);if(mode!=="peer")assert.equal(calls,1);}
 assert.equal(peerLost,0);assert.equal(f.nativeOptions.length,0);
 if(locked){peer.exec("ROLLBACK");locked=false;}
 const previousCalls=calls;
 if(mode==="healthy")await sharedWaitFor(()=>calls>previousCalls,"healthy heartbeat continues renewal");
 else {
   await new Promise(resolve=>setTimeout(resolve,120));
   if(mode!=="peer")assert.equal(calls,mode==="stop"?0:1,"A retired heartbeat cannot renew after the lock clears");
 }
 log("actor-complete",{mode,calls,uncaught,lost,peerLost});
}finally{
 lease?.stopHeartbeat();other?.stopHeartbeat();if(locked)peer.exec("ROLLBACK");peer.close();
 f.store.coordinationHandle.renewLease=renew;await lease?.release();await other?.release();await f.close();process.off("uncaughtException",onUncaught);
}
}
await main();

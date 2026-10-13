import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sharedReviewerFixture, unavailableSharedReviewer } from "./bridge-shared-reviewer-fixture.js";

const [directory, mode] = process.argv.slice(2); assert.ok(directory && mode);
const log = (kind: string, detail: object = {}) => appendFileSync(join(directory, "states.jsonl"), JSON.stringify({ kind, ...detail })+"\n");
process.on("uncaughtExceptionMonitor", error => log("uncaught-monitor", {message:error.message}));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function main() {
  const controller = new AbortController(), cause = new Error("original test cancellation");
  const options = {mode:"active" as const, signal:controller.signal};
  if (mode === "pre-aborted") {
    controller.abort(cause);
    let created: Awaited<ReturnType<typeof sharedReviewerFixture>> | undefined;
    let error: unknown;
    try { created = await sharedReviewerFixture(options); } catch(value) {error=value;}
    try {assert.equal(error,cause);assert.equal(created,undefined);}
    finally {if(created)await created.close();}
    log("actor-complete",{created:false,originalCause:true});return;
  }
  if (mode === "native-timeout") {
    let f: Awaited<ReturnType<typeof sharedReviewerFixture>> | undefined;
    let callbackCleaned = false, aborted = false;
    await test("controlled native timeout with a held lease notice", {timeout:4000}, async t => {
      const nativeOptions={mode:"active" as const,signal:t.signal};
      f=await sharedReviewerFixture(nativeOptions);
      t.after(async()=>{
        aborted=t.signal.aborted;await f!.close();callbackCleaned=true;
        log("native-after-cleaned",{aborted,phase:f!.phase,nativeCalls:f!.nativeOptions.length});
      });
      f.lossSeen.enter=()=>{log("held-native-notice");};
      try {await unavailableSharedReviewer(f);}
      finally {await f.close();}
    });
    assert.ok(f);assert.equal(aborted,true);assert.equal(callbackCleaned,true);assert.equal(existsSync(f.directory),false);
    assert.equal(f.runtime.backgroundTasks.size,0);assert.equal(f.nativeOptions.length,1);
    log("actor-complete",{nativeTimeout:true,callbackCleaned,aborted});return;
  }
  const f=await sharedReviewerFixture(options);
  let operation:Promise<unknown>|undefined,manualHold:Promise<void>|undefined;
  let releaseManual!:()=>void;
  let enterNotice!:()=>void;
  const notice=new Promise<void>(resolve=>{enterNotice=resolve;});
  const gate=mode === "forwarded" ? f.lossForwarded : f.lossSeen;
  const originalEnter=gate.enter;
  const originalForwarded=f.lossForwarded.enter;
  let settled=false,error:unknown;
  let closing:Promise<void>[]=[];
  try {
    if(mode === "double-close") {
      await f.control("fixture/stats");
      closing=[f.close(),f.close()];assert.equal(closing[0],closing[1],"Concurrent fixture cleanup joins one owned disposal");
      await Promise.all(closing);assert.equal(existsSync(f.directory),false);
      log("actor-complete",{cleanupJoined:true});return;
    }
    if(mode === "healthy") {
      const result=await unavailableSharedReviewer(f);assert.equal(result.failed.submissionState,"failed");
      assert.equal(f.children.length,1);assert.equal(f.rawDisposals.length,1);
    } else {
      if(mode === "background") {
        manualHold=new Promise<void>(resolve=>{releaseManual=resolve;});f.runtime.backgroundTasks.add(manualHold);
        f.lossForwarded.enter=()=>{originalForwarded();enterNotice();};
      } else gate.enter=()=>{enterNotice();};
      operation=unavailableSharedReviewer(f).then(()=>{settled=true;},value=>{settled=true;error=value;});
      await notice;
      // Give the awaited continuation a turn before cancellation, including
      // the join of the explicitly held background task.
      await tick();controller.abort(cause);await tick();await tick();
      log("cancelled-original-wait",{settled,originalCause:error===cause,nativeCalls:f.nativeOptions.length,children:f.children.length});
      assert.equal(settled,true,"The original helper observes cancellation at its held phase");assert.equal(error,cause);
    }
  } finally {
    gate.enter=originalEnter;f.lossForwarded.enter=originalForwarded;originalEnter();f.lossRelease.release();originalForwarded();
    if(manualHold){releaseManual();f.runtime.backgroundTasks.delete(manualHold);}
    if(closing.length) await Promise.allSettled(closing);
    else {await f.client.stop();await operation;await f.close();}
  }
  assert.equal(existsSync(f.directory),false);assert.equal(f.runtime.backgroundTasks.size,0);
  log("actor-complete",{cleanupComplete:true,originalCause:mode !== "healthy" ? error===cause : undefined});
}
void main().catch(error=>{log("actor-failure",{message:error instanceof Error?error.message:String(error)});process.exitCode=1;});

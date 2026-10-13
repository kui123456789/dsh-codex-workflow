import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";
import { originalProcessTreeExited, type ProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";

const [directory, mode = "EMFILE"] = process.argv.slice(2);
assert.ok(directory);
const states = join(directory, "states.jsonl");
const log = (kind: string, detail: object = {}) => appendFileSync(states, JSON.stringify({ kind, ...detail }) + "\n");
const fault = Object.assign(new Error("spawn controlled native " + mode), { code: mode === "ENFILE" ? "ENFILE" : "EMFILE" });
const originalSpawn = childProcess.spawn;
let starts = 0;
let placeholder: childProcess.ChildProcess | undefined;
const releaseError = () => {
  assert.ok(placeholder);
  Reflect.set(placeholder, "exitCode", -24); // Controlled replay of Node's native onexit assignment.
  log("native-error-receipt", { listeners: placeholder.listenerCount("error"), code: fault.code });
  placeholder.emit("error", fault); placeholder.emit("close", -24, null);
};
const held = ["cancel-one", "cancel-last", "stop"].includes(mode);
childProcess.spawn = ((command: string, args: string[], options: object) => {
  starts++;
  if (starts > 1) return Reflect.apply(originalSpawn, childProcess, [command, args, options]);
  if (mode === "sync-throw") throw fault;
  if (mode === "actual-pid") {
    placeholder = originalSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    log("actual-missing-stdio-child", { pid: placeholder.pid }); return placeholder;
  }
  const child = new childProcess.ChildProcess();
  placeholder = child;
  log("placeholder", { stdin: Boolean(child.stdin), stdout: Boolean(child.stdout), stderr: Boolean(child.stderr), pid: child.pid });
  if (mode === "close-only") process.nextTick(() => { Reflect.set(child, "exitCode", -24); child.emit("close", -24, null); });
  else if (!held && mode !== "timeout") process.nextTick(releaseError);
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
process.on("uncaughtExceptionMonitor", (error: NodeJS.ErrnoException) => log("uncaught-monitor", { code: error.code, message: error.message }));
const options = { command: process.execPath, args: ["-e", ""], requestTimeoutMs: 5000,
  rpcTimeoutMs: 1000, idleProcessMs: 0, quitGraceMs: 100, killGraceMs: 100 };
const client = new CodexAppServerClient(options);
const port = client as unknown as { child?: childProcess.ChildProcess; idleRetirement?: object;
  initialization?: { promise: Promise<void> }; lostProcesses: Set<unknown>; stopForkTrees: Set<unknown>;
  processRetirements: WeakMap<childProcess.ChildProcess, { evidence: Promise<ProcessTreeEvidence> }> };
try {
  const controller = new AbortController();
  const startup = client.start(controller.signal).then(() => ({ error: undefined }), (error: Error) => ({ error }));
  const physical = port.initialization?.promise;
  const joined = mode === "joined" || mode === "cancel-one"
    ? client.listModels().then(() => ({ error: undefined }), (error: Error) => ({ error })) : undefined;
  const cancelled = new Error("Only the original missing-stdio observer cancelled");
  let stopping: Promise<void> | undefined;
  if (mode === "cancel-one" || mode === "cancel-last") controller.abort(cancelled);
  if (mode === "cancel-last") {
    assert.equal((await startup).error, cancelled); await physical?.catch(() => undefined);
    options.args = [fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url))];
    assert.ok((await client.health()).modelCount > 0);
    const successor = port.child; assert.ok(successor?.pid);
    releaseError();
    assert.equal(port.child, successor, "Late missing-stdio receipt cannot detach the independent successor");
    assert.ok((await client.health()).modelCount > 0);
  } else {
    if (mode === "stop") { stopping = client.stop(); assert.equal(client.stop(), stopping); }
    if (held) releaseError();
    const outcome = await startup, second = await joined;
    log("startup-outcome", { sameError: outcome.error === fault, message: outcome.error?.message,
      code: (outcome.error as NodeJS.ErrnoException)?.code, sameJoinedError: second?.error === outcome.error });
    if (mode === "cancel-one") { assert.equal(outcome.error, cancelled); assert.equal(second?.error, fault); }
    else if (mode === "stop") { assert.match(String(outcome.error), /stopped/); await stopping; await assert.rejects(client.health(), /stopped/); }
    else if (mode === "close-only" || mode === "actual-pid") assert.match(String(outcome.error), /stdio is unavailable/);
    else if (mode === "timeout") assert.match(String(outcome.error), /spawn receipt timed out/);
    else { assert.equal(outcome.error, fault, "The asynchronous native spawn cause cannot be replaced by a readline TypeError");
      if (second) assert.equal(second.error, fault); }
  }
  await client.stop();
  assert.equal(port.child, undefined); assert.equal(port.idleRetirement, undefined);
  assert.equal(port.lostProcesses.size, 0); assert.equal(port.stopForkTrees.size, 0);
  if (mode === "actual-pid") {
    assert.ok(placeholder?.pid);
    const evidence = await port.processRetirements.get(placeholder)!.evidence;
    assert.equal(await originalProcessTreeExited(evidence), true, "An actual incomplete transport retains and retires its physical original");
    log("actual-child-retired", { pid: placeholder.pid, capturedInstances: evidence.processIds!.length });
  }
  log("actor-complete", { starts, phantomProcessRecords: port.lostProcesses.size + port.stopForkTrees.size });
} catch (error) {
  log("actor-error", { message: String(error) }); process.exitCode = 1;
} finally {
  childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await client.stop().catch(() => undefined);
}

import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileOptions } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence, type ProcessTreeObservation } from "../src/infrastructure/process-transport.js";
import { isRecoverableModelFailure, isTransientFailure } from "../src/transient-retry.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

test("a startup census delivered after original launcher retirement preserves its observations without adopting the discarded tree", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-startup-census-ownership-"));
  const journal = join(directory, "wire.jsonl"), backend = join(directory, "backend.mjs"), launcher = join(directory, "launcher.mjs");
  const exitMarker = join(directory, "release-original-backend");
  const priorityMarker = "ORIGINAL_STARTUP_CENSUS_EXIT_PRIORITY";
  await writeFile(journal, "");
  await writeFile(backend, `
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (kind, detail = {}) => appendFileSync(${JSON.stringify(journal)}, JSON.stringify({kind, processId: process.pid, ...detail}) + "\\n");
const tolerate = error => { if (!["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };
process.stdin.on("error", tolerate); process.stdout.on("error", tolerate); process.stderr.on("error", tolerate);
setInterval(() => { if (existsSync(${JSON.stringify(exitMarker)})) process.exit(0); }, 10);
log("process-start");
const input = createInterface({input: process.stdin});
input.on("error", tolerate);
input.on("line", line => {
  const {id, method} = JSON.parse(line); log("rpc", {method});
  if (method === "initialize") process.stdout.write(JSON.stringify({id, result: {userAgent: "startup-census-original"}}) + "\\n");
  else if (method !== "initialized") process.stdout.write(JSON.stringify({id, result: {}}) + "\\n");
});
input.on("close", () => log("process-eof"));
`);
  await writeFile(launcher, `
import { spawn } from "node:child_process";
process.stderr.write(${JSON.stringify(priorityMarker + "\n")});
const child = spawn(process.execPath, [${JSON.stringify(backend)}], {stdio: "inherit", detached: true, windowsHide: true});
child.once("error", () => process.exit(1)); child.once("exit", code => process.exit(code ?? 1));
`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [launcher], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 50, killGraceMs: 50 });
  const port = client as unknown as {
    child?: ChildProcess;
    idleRetirement?: { process: ChildProcess; evidence: Promise<ProcessTreeEvidence> };
    initializedProcessTrees: WeakMap<ChildProcess, Promise<ProcessTreeEvidence>>;
  };
  const asynchronousFailures: Array<{ kind: string; error: unknown }> = [];
  const rejected = (error: unknown) => { asynchronousFailures.push({ kind: "unhandledRejection", error }); };
  const uncaught = (error: unknown) => { asynchronousFailures.push({ kind: "uncaughtException", error }); };
  process.on("unhandledRejection", rejected); process.on("uncaughtExceptionMonitor", uncaught);
  const originalExecFile = childProcess.execFile;
  let original: ChildProcess | undefined, evidence: ProcessTreeEvidence | undefined;
  let startup: Promise<unknown> | undefined, failed = true, censusRequests = 0;
  let held: { error: Error | null; stdout: string; deliver(): void; delivered: boolean } | undefined;
  try {
    childProcess.execFile = ((command: string, args: string[], options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const census = args.some(value => value.includes("Get-CimInstance Win32_Process") && !value.includes("-Filter"));
      if (!census || ++censusRequests !== 1) return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
      return Reflect.apply(originalExecFile, childProcess, [command, args, options,
        (error: Error | null, stdout: string, stderr: string) => {
          // Preserve the actual native reply unchanged; only its delivery is held.
          const reply = { error, stdout, delivered: false, deliver() {
            if (reply.delivered) return;
            reply.delivered = true; callback(error, stdout, stderr);
          } };
          held = reply;
        }]);
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    startup = client.start().then(() => undefined, (error: unknown) => error);
    const capturedReply = await sharedWaitFor(() => held, "the first native startup census reply held");
    assert.equal(capturedReply.error, null, "The held reply must be a successful actual CIM census");
    original = port.child;
    assert.ok(original && Number.isSafeInteger(original.pid));
    assert.equal(original.exitCode, null); assert.equal(original.signalCode, null);
    const captured = await captureProcessTreeEvidence(original.pid);
    evidence = captured && { processId: original.pid, ...captured };
    assert.ok(evidence?.processIdentities && evidence.processIdentities.length >= 2);
    const nativeRows = JSON.parse(capturedReply.stdout) as Array<{ ProcessId: number; Birth: string }>;
    for (const identity of evidence.processIdentities) {
      assert.equal(nativeRows.find(row => row.ProcessId === identity.processId)?.Birth, identity.birth,
        "The held native reply captured these exact original instances while still owned");
    }
    const initializedEvidence = port.initializedProcessTrees.get(original);
    assert.ok(initializedEvidence);
    assert.equal(original.kill(), true, "Retire the exact native SDK ChildProcess, never a numeric replacement PID");
    await sharedWaitFor(() => original!.exitCode !== null || original!.signalCode !== null, "the original launcher retired before census delivery");
    assert.equal(port.child, undefined);
    assert.equal(await originalProcessTreeExited(evidence), false, "The original backend survives its retired launcher");
    capturedReply.deliver();
    const startupError = await startup;
    assert.ok(startupError instanceof Error);
    assert.match(startupError.message, /^codex app-server exited /i);
    assert.ok(startupError.message.includes(priorityMarker), "Original startup exit diagnostics keep priority over auxiliary cleanup");
    assert.doesNotMatch(startupError.message, /cleanup.*unconfirmed/i);
    assert.equal(isTransientFailure(startupError.message), false); assert.equal(isRecoverableModelFailure(startupError.message), false);
    assert.deepEqual(await initializedEvidence, { processId: original.pid }, "A stale census cannot backfill original ownership");
    const retirement = port.idleRetirement;
    assert.ok(retirement); assert.equal(retirement.process, original);
    const retiredEvidence = await retirement.evidence;
    assert.deepEqual(retiredEvidence, { processId: original.pid }, "The retirement retains PID-only uncertainty, excluding discarded descendants and births");
    const cleanupErrors: Error[] = [];
    for (const attempt of [() => client.health(), () => client.health(), () => client.startThread({ cwd: directory, ephemeral: true })]) {
      const error = await attempt().then(() => undefined, (value: unknown) => value);
      assert.ok(error instanceof Error); assert.match(error.message, /cleanup.*unconfirmed/i);
      assert.equal(isTransientFailure(error.message), false); assert.equal(isRecoverableModelFailure(error.message), false);
      cleanupErrors.push(error);
      assert.equal(port.idleRetirement, retirement); assert.equal(await retirement.evidence, retiredEvidence);
    }
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.kind === "process-start").length, 1, "No successor may run while original ownership is unconfirmed");
    assert.deepEqual(rows.filter(row => row.kind === "rpc").map(row => row.method), ["initialize", "initialized"],
      "Cleanup refusal cannot start a model, create a thread, or retry startup RPCs");
    const observations = cleanupErrors.map(error => (error as Error & { cleanupDiagnostics?: readonly ProcessTreeObservation[] }).cleanupDiagnostics);
    for (const [index, values] of observations.entries()) {
      assert.deepEqual(values?.map(value => value.code), ["captured", "owner_retired"],
        "The PID-only idle retirement preserves frozen startup observations without accumulating repeat cleanup receipts");
      assert.ok(Object.isFrozen(values) && values!.every(value => Object.isFrozen(value)));
      assert.equal(Object.getOwnPropertyDescriptor(cleanupErrors[index]!, "cleanupDiagnostics")!.writable, false);
      assert.ok(values!.every(value => value.processId === original!.pid && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0));
      assert.equal(JSON.stringify(values).includes(evidence.processIdentities![0]!.birth), false);
      assert.equal(values, observations[0], "Repeated cleanup shares the immutable original receipt");
    }
    failed = false;
  } finally {
    childProcess.execFile = originalExecFile; syncBuiltinESMExports();
    held?.deliver();
    try {
      original ??= port.child;
      if (!evidence && original?.pid) {
        const captured = await captureProcessTreeEvidence(original.pid);
        if (captured) evidence = { processId: original.pid, ...captured };
      }
      await writeFile(exitMarker, "release");
      await startup; await client.stop().catch(() => undefined);
      assert.ok(evidence?.processIdentities, "Fixture cleanup needs independently captured complete original identity evidence");
      await sharedWaitFor(() => originalProcessTreeExited(evidence!), "all externally captured original startup fixture instances exited");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(asynchronousFailures, [], "The original late callback and cleanup produce no uncaught or unhandled events");
      const cleanupProof = { metadata: "actual native CIM reply held unchanged", originalEvidence: evidence,
        originalTreeExitConfirmed: true, asynchronousFailures: asynchronousFailures.length };
      await writeFile(join(directory, "fixture-cleanup-proof.json"), JSON.stringify(cleanupProof, null, 2));
      console.log(JSON.stringify({ startupCensusFixtureCleanup: true, retainedEvidenceDirectory: failed ? directory : undefined,
        originalProcessIds: evidence.processIds, originalTreeExitConfirmed: true, unhandledEvents: asynchronousFailures.length }));
      if (!failed) {
        assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      process.off("unhandledRejection", rejected); process.off("uncaughtExceptionMonitor", uncaught);
    }
  }
});

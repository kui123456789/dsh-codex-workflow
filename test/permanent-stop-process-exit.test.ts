import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";
import { isRecoverableModelFailure, isTransientFailure } from "../src/transient-retry.js";

for (const mode of ["initialized", "denied-then-retry", "initializing", "idle-collision", "missing-census", "launcher-exited", "launcher-exited-late-child", "launcher-exited-health", "launcher-exited-denied", "launcher-exited-census-denied", "startup-missing-census"] as const) {
test(`permanent stop retains ordinary backend ownership without any fork: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-permanent-stop-tree-"));
  const journal = join(directory, "wire.jsonl"), backend = join(directory, "backend.mjs"), launcher = join(directory, "launcher.mjs");
  const exitMarker = join(directory, "release-owned-backend");
  const lateMarker = join(directory, "spawn-late-owned-child"), latePid = join(directory, "late-child.pid");
  let failed = false, evidence: ProcessTreeEvidence | undefined;
  await writeFile(journal, "");
  const source = await readFile(new URL("./fixtures/fake-fork-creation-receipt-app-server.mjs", import.meta.url), "utf8");
  await writeFile(backend, [
    'import { existsSync } from "node:fs";',
    `setInterval(() => { if (existsSync(${JSON.stringify(exitMarker)})) process.exit(0); }, 50);`,
    'const tolerate = (error) => { if (!["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };',
    'process.stdin.on("error", tolerate); process.stdout.on("error", tolerate);',
    ...(mode === "launcher-exited-late-child" ? [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'let lateStarted = false;',
      `setInterval(() => { if (!lateStarted && existsSync(${JSON.stringify(lateMarker)})) { lateStarted = true;`,
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitMarker)}))process.exit(0);},50);`)}], {stdio:"ignore",detached:true,windowsHide:true});`,
      `writeFileSync(${JSON.stringify(latePid)}, String(child.pid)); } }, 10);`,
    ] : []),
    mode === "initializing" ? source.replace('if (method === "initialize") return reply(id, { userAgent: "original-fork-creation-receipt" });',
      'if (method === "initialize") { log("initialize-held"); return; }') : source,
    'input.on("error", tolerate);',
  ].join("\n"));
  await writeFile(launcher, `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(backend)}, ${JSON.stringify(journal)}], { stdio: "inherit", detached: true, windowsHide: true });
child.once("error", () => process.exit(1)); child.once("exit", code => process.exit(code ?? 1));
`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [launcher], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 50, killGraceMs: 50 });
  const port = client as unknown as {
    child: ChildProcess; idleShutdown(): Promise<void>; idleRetirement?: { evidence: Promise<ProcessTreeEvidence> };
    initialization?: { promise: Promise<void> }; stopForkTrees: Set<ProcessTreeEvidence>;
    initializedProcessTrees: WeakMap<ChildProcess, Promise<ProcessTreeEvidence>>;
    lostProcesses: Set<object>;
  };
  const originalExecFile = childProcess.execFile;
  let startup: Promise<unknown> | undefined;
  const assertStartupDiagnostics = (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /cleanup.*unconfirmed/i);
    const observations = (error as Error & { cleanupDiagnostics?: readonly {
      code: string; processId?: number; elapsedMs: number; exitCode?: number;
    }[] }).cleanupDiagnostics;
    assert.deepEqual(observations?.map(value => value.code), ["query_failed", "original_identity_incomplete"],
      "Every cleanup retains the original startup capture cause once and only its current refresh attempt");
    assert.equal(observations![0]!.exitCode, 13);
    assert.ok(observations!.every(value => value.processId === evidence!.processId && Object.isFrozen(value)));
    assert.ok(Object.isFrozen(observations));
    assert.equal(Object.getOwnPropertyDescriptor(error, "cleanupDiagnostics")!.writable, false);
    assert.equal(isTransientFailure(error.message), false); assert.equal(isRecoverableModelFailure(error.message), false);
    return true;
  };
  try {
    if (mode === "startup-missing-census") {
      childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
        if (args.some(value => value.includes("Get-CimInstance Win32_Process")) || command === "ps") {
          return Reflect.apply(originalExecFile, childProcess, [process.execPath, ["-e", "process.exit(13)"], options, callback]);
        }
        return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
      }) as typeof childProcess.execFile; syncBuiltinESMExports();
    }
    if (mode === "initializing") {
      startup = client.start().then(() => undefined, (error: unknown) => error);
      await sharedWaitFor(async () => (await readFile(journal, "utf8")).includes('"kind":"initialize-held"'), "original initializer held");
    } else await client.start();
    childProcess.execFile = originalExecFile; syncBuiltinESMExports();
    const original = port.child, initialization = port.initialization;
    let sourceThread: string | undefined, sourceOwner: object | undefined;
    if (mode !== "initializing") {
      sourceThread = await client.startThread({ cwd: directory, ephemeral: true });
      sourceOwner = client.captureThreadOwner(sourceThread);
    }
    if (mode === "launcher-exited-late-child") {
      await writeFile(lateMarker, "spawn");
      await sharedWaitFor(async () => (await readFile(latePid, "utf8").catch(() => "")) !== "", "backend started its later child");
    }
    const captured = await captureProcessTreeEvidence(original.pid);
    evidence = captured && { processId: original.pid, ...captured };
    assert.ok(evidence?.processIdentities && evidence.processIdentities.length >= 2);
    if (mode === "launcher-exited-late-child") {
      const lateChild = Number(await readFile(latePid, "utf8"));
      assert.ok(evidence.processIds!.includes(lateChild), "Actual census includes the later backend child");
      assert.ok(!(await port.initializedProcessTrees.get(original)!).processIds!.includes(lateChild), "Later child was absent from initialization evidence");
    }
    if (mode.startsWith("launcher-exited") || mode === "startup-missing-census") {
      original.kill();
      await sharedWaitFor(() => original.exitCode !== null || original.signalCode !== null, "original ordinary launcher exited");
      assert.equal(await originalProcessTreeExited(evidence), false, "Original backend remains live after launcher exit");
    }
    let censuses = 0;
    childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
      const census = args.some(value => value.includes("Get-CimInstance Win32_Process") && !value.includes("-Filter"))
        || command === "ps";
      if (census) censuses++;
      if (((mode === "denied-then-retry" || mode === "launcher-exited-denied") && (args.includes("-EncodedCommand") || command === "python3"))
        || ((mode === "missing-census" || mode === "launcher-exited-census-denied") && census)) {
        return Reflect.apply(originalExecFile, childProcess, [process.execPath, ["-e", "process.exit(13)"], options, callback]);
      }
      return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    if (mode === "launcher-exited-denied" || mode === "launcher-exited-census-denied" || mode === "startup-missing-census") {
      await assert.rejects(client.health(), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, /cleanup.*unconfirmed/i);
        if (mode === "startup-missing-census") return assertStartupDiagnostics(error);
        const observations = (error as Error & { cleanupDiagnostics?: readonly { code: string; processId?: number; elapsedMs: number }[] }).cleanupDiagnostics;
        const codes = observations?.map(value => value.code);
        if (mode === "launcher-exited-census-denied") assert.deepEqual(codes,
          ["captured", "query_failed", "capture_unavailable"]);
        else {
          assert.equal(codes?.at(-1), "refreshed");
          assert.ok(codes?.filter(code => code === "captured").length >= 2,
            "A lost original retains startup and current refresh observations");
        }
        assert.ok(Object.isFrozen(observations) && observations!.every(value => Object.isFrozen(value)));
        assert.equal(Object.getOwnPropertyDescriptor(error, "cleanupDiagnostics")!.writable, false);
        assert.ok(observations!.every(value => typeof value.elapsedMs === "number" && value.elapsedMs >= 0));
        assert.equal(isTransientFailure(error.message), false); assert.equal(isRecoverableModelFailure(error.message), false);
        return true;
      });
      assert.equal(await originalProcessTreeExited(evidence), false, "Unconfirmed original cleanup cannot bootstrap a successor");
    }
    if (mode === "launcher-exited-health") {
      assert.ok((await client.health()).modelCount > 0);
      assert.equal(await originalProcessTreeExited(evidence), true, "Explicit metadata waits for the surviving original backend to exit");
      assert.notEqual(port.child.pid, original.pid);
      await assert.rejects(client.startTurn(sourceThread!, { prompt: "Never reconstruct a lost ephemeral thread", expectedOwner: sourceOwner }), /original.*owner.*unavailable/i);
    }
    const idle = mode === "idle-collision" ? port.idleShutdown() : undefined;
    const stopping = client.stop();
    assert.equal(client.stop(), stopping, "Concurrent stop shares the original cleanup promise");
    if (mode === "denied-then-retry" || mode === "missing-census" || mode === "launcher-exited-denied" || mode === "launcher-exited-census-denied" || mode === "startup-missing-census") {
      await assert.rejects(stopping, mode === "startup-missing-census" ? assertStartupDiagnostics : /cleanup.*unconfirmed/i);
      assert.equal(await originalProcessTreeExited(evidence), false);
      const pendingTrees = mode === "launcher-exited-denied" || mode === "launcher-exited-census-denied" || mode === "startup-missing-census" ? port.lostProcesses : port.stopForkTrees;
      assert.equal(pendingTrees.size, 1, "Permanent stop retains the ordinary original tree");
      const pending = [...pendingTrees][0]!;
      childProcess.execFile = originalExecFile; syncBuiltinESMExports();
      await assert.rejects(client.health(), /stopped/);
      await assert.rejects(client.startThread({ cwd: directory }), /stopped/);
      const first = client.stop(), second = client.stop();
      assert.equal(first, second); assert.notEqual(first, stopping);
      if (mode === "missing-census" || mode === "startup-missing-census") {
        await assert.rejects(first, mode === "startup-missing-census" ? assertStartupDiagnostics : /cleanup.*unconfirmed/i);
        assert.equal([...pendingTrees][0], pending, "A lost census cannot be backfilled after launcher exit");
      } else { await first; assert.equal(client.stop(), first); }
    } else {
      await stopping; await idle;
      assert.equal(client.stop(), stopping);
      assert.equal(port.stopForkTrees.size, 0);
      assert.equal(port.idleRetirement, undefined);
    }
    if (startup) { assert.match(String(await startup), /stopped/); await initialization!.promise.catch(() => undefined); }
    const treeExited = await originalProcessTreeExited(evidence);
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    await writeFile(join(directory, "stop-result.json"), JSON.stringify({ evidence, treeExited, rows, censuses }, null, 2));
    assert.equal(treeExited, mode !== "missing-census" && mode !== "startup-missing-census", "Only confirmed original backend exit can complete teardown");
    if (mode.startsWith("launcher-exited")) assert.ok(censuses > 0, "Cleanup refreshes surviving birth-matched original backends");
    else assert.equal(censuses, mode === "startup-missing-census" ? 0 : mode === "missing-census" ? 2 : 1,
      "An owned live retirement can retry one unavailable census; unknown origins cannot be backfilled after closure");
    assert.equal(rows.filter(row => row.kind === "process-start").length, mode === "launcher-exited-health" ? 2 : 1);
    assert.equal(rows.filter(row => row.kind === "fork-accepted" || row.kind === "conversion-model").length, 0);
    assert.equal(rows.filter(row => row.kind === "process-eof").length, mode === "launcher-exited-health" ? 2 : 1, "Each owned backend receives one close");
    await assert.rejects(client.health(), /stopped/);
  } catch (error) { failed = true; throw error; }
  finally {
    childProcess.execFile = originalExecFile; syncBuiltinESMExports();
    await writeFile(exitMarker, "release"); await client.stop().catch(() => undefined); await startup;
    if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "original permanent-stop fixture instances exited");
    if (failed) console.error(`Permanent stop evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});
}

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

test("SDK completed conversion release stops the original backend after launcher exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-completed-fork-stop-tree-"));
  const journal = join(directory, "wire.jsonl"), backend = join(directory, "backend.mjs"), launcher = join(directory, "launcher.mjs");
  const exitMarker = join(directory, "release-original-backend");
  let failed = false, evidence: ProcessTreeEvidence | undefined;
  await writeFile(journal, "");
  await writeFile(backend, [
    'import { existsSync } from "node:fs";',
    `setInterval(() => { if (existsSync(${JSON.stringify(exitMarker)})) process.exit(0); }, 50);`,
    'const tolerateRetiredPipe = (error) => { if (!["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };',
    'process.stdin.on("error", tolerateRetiredPipe); process.stdout.on("error", tolerateRetiredPipe);',
    await readFile(new URL("./fixtures/fake-fork-creation-receipt-app-server.mjs", import.meta.url), "utf8"),
    'input.on("error", tolerateRetiredPipe);',
  ].join("\n"));
  await writeFile(launcher, [
    'import { spawn } from "node:child_process";',
    `const child = spawn(process.execPath, [${JSON.stringify(backend)}, ${JSON.stringify(journal)}], { stdio: "inherit", detached: true, windowsHide: true });`,
    'child.once("error", () => process.exit(1)); child.once("exit", (code) => process.exit(code ?? 1));',
  ].join("\n"));
  const client = new CodexAppServerClient({ command: process.execPath, args: [launcher], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 50, killGraceMs: 50 });
  const port = client as unknown as { child: ChildProcess; request(method: string, params: object): Promise<unknown> };
  try {
    await client.start(); const original = port.child;
    const source = await client.startThread({ cwd: directory });
    await port.request("fixture/setOriginalReleaseMode", { mode: "failed" });
    const initial = client.normalizeInFork({ threadId: source, expectedOwner: client.captureThreadOwner(source), cwd: directory,
      prompt: "Preserve this completed synthetic conversion", model: "model-A", outputSchema: { type: "object" } });
    await sharedWaitFor(async () => (await readFile(journal, "utf8")).includes('"kind":"fork-accepted"'), "original conversion fork accepted");
    const creation = [...(client as unknown as { forkCreations: Set<{ evidence?: Promise<ProcessTreeEvidence> }> }).forkCreations][0];
    assert.ok(creation?.evidence); const captured = await creation.evidence;
    evidence = captured; assert.ok(evidence.processIdentities && evidence.processIdentities.length >= 2);
    await port.request("fixture/releaseOriginal", {}); assert.equal((await initial).kind, "completed");
    original.kill(); await sharedWaitFor(() => original.exitCode !== null || original.signalCode !== null, "original launcher exited");
    assert.equal(await originalProcessTreeExited(evidence), false, "Completed model output does not prove its backend released the fork");
    await client.stop();
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const treeExited = await originalProcessTreeExited(evidence);
    await writeFile(join(directory, "stop-result.json"), JSON.stringify({ evidence, treeExited, rows }, null, 2));
    assert.equal(rows.filter((row) => row.kind === "fork-accepted").length, 1);
    assert.equal(rows.filter((row) => row.kind === "conversion-model").length, 1);
    assert.equal(rows.filter((row) => row.kind === "unsubscribe").length, 0);
    assert.equal(treeExited, true, "Stop must retain and retire the completed fork's original backend instances");
  } catch (error) { failed = true; throw error; }
  finally {
    await writeFile(exitMarker, "release"); await client.stop().catch(() => undefined);
    if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "original completed-fork fixture instances exited");
    if (failed) console.error(`Completed fork stop evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});

for (const mode of ["stop-live-launcher", "launcher-exited", "denied-then-retry"] as const) {
  test(`SDK unknown fork cleanup confirms the original backend tree: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-fork-creation-stop-tree-"));
    const journal = join(directory, "wire.jsonl"), backend = join(directory, "backend.mjs"), launcher = join(directory, "launcher.mjs");
    const exitMarker = join(directory, "release-original-backend");
    let failed = false, evidence: ProcessTreeEvidence | undefined;
    await writeFile(journal, "");
    await writeFile(backend, [
      'import { existsSync } from "node:fs";',
      `setInterval(() => { if (existsSync(${JSON.stringify(exitMarker)})) process.exit(0); }, 50);`,
      'const tolerateRetiredPipe = (error) => { if (!["EPIPE", "ECONNRESET", "EBADF", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };',
      'process.stdin.on("error", tolerateRetiredPipe); process.stdout.on("error", tolerateRetiredPipe);',
      await readFile(new URL("./fixtures/fake-fork-creation-receipt-app-server.mjs", import.meta.url), "utf8"),
      'input.on("error", tolerateRetiredPipe);',
    ].join("\n"));
    await writeFile(launcher, [
      'import { spawn } from "node:child_process";',
      `const child = spawn(process.execPath, [${JSON.stringify(backend)}, ${JSON.stringify(journal)}], { stdio: "inherit", detached: true, windowsHide: true });`,
      'child.once("error", () => process.exit(1)); child.once("exit", (code) => process.exit(code ?? 1));',
    ].join("\n"));
    const client = new CodexAppServerClient({ command: process.execPath, args: [launcher],
      requestTimeoutMs: 5000, rpcTimeoutMs: 4000, idleProcessMs: 0, quitGraceMs: 50, killGraceMs: 50 });
    const port = client as unknown as { child: ChildProcess };
    const originalExecFile = childProcess.execFile;
    try {
      await client.start();
      const original = port.child;
      const source = await client.startThread({ cwd: directory });
      const result = client.normalizeInFork({ threadId: source, expectedOwner: client.captureThreadOwner(source), cwd: directory,
        prompt: "Convert only the original local synthetic result", model: "model-A", outputSchema: { type: "object" } })
        .then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      await sharedWaitFor(async () => (await readFile(journal, "utf8")).includes('"kind":"fork-accepted"'), "the real backend has created its original fork");
      const captured = await captureProcessTreeEvidence(original.pid);
      evidence = captured && { processId: original.pid, ...captured };
      assert.ok(evidence?.processIdentities && evidence.processIdentities.length >= 2,
        "The original launcher and surviving backend have real birth identities");
      if (mode === "launcher-exited") {
        const creation = [...(client as unknown as { forkCreations: Set<{ evidence?: Promise<ProcessTreeEvidence> }> }).forkCreations][0];
        assert.ok(creation?.evidence);
        const owned = await creation.evidence;
        assert.ok(owned.processIdentities?.length && owned.processIdentities.length >= 2);
        original.kill(); await sharedWaitFor(() => original.exitCode !== null || original.signalCode !== null, "the actual original launcher exited before stop");
        assert.equal(await originalProcessTreeExited(evidence), false, "The backend is actually still alive when its launcher is gone");
      }
      if (mode === "denied-then-retry") {
        // Only the native termination helper is replaced with a real rejected
        // helper process. Census queries and backend transport stay unchanged.
        childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
          if (args.includes("-EncodedCommand") || command === "python3") {
            return Reflect.apply(originalExecFile, childProcess, [process.execPath, ["-e", "process.exit(13)"], options, callback]);
          }
          return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
        }) as typeof childProcess.execFile;
        syncBuiltinESMExports();
        await assert.rejects(client.stop(), /original fork.*cleanup.*unconfirmed/i);
        assert.equal(await originalProcessTreeExited(evidence), false, "Denied cleanup cannot claim the live original backend ended");
        await assert.rejects(client.start(), /stopped/);
        childProcess.execFile = originalExecFile; syncBuiltinESMExports();
        const firstRetry = client.stop(), secondRetry = client.stop();
        assert.equal(firstRetry, secondRetry, "Concurrent cleanup retries own one original flight");
        await firstRetry;
      } else await client.stop();
      assert.ok((await result).error);
      const rows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const treeExited = await originalProcessTreeExited(evidence);
      await writeFile(join(directory, "stop-result.json"), JSON.stringify({ launcherPid: original.pid, launcherExitCode: original.exitCode,
        launcherSignalCode: original.signalCode,
        evidence, treeExited, rows }, null, 2));
      assert.equal(rows.filter((row) => row.kind === "fork-accepted").length, 1);
      assert.equal(rows.filter((row) => row.kind === "conversion-model").length, 0);
      assert.equal(rows.filter((row) => row.kind === "interrupt").length, 0);
      assert.equal(treeExited, true, "Launcher exit alone cannot report success while its original backend still owns the fork");
    } catch (error) { failed = true; throw error; }
    finally {
      childProcess.execFile = originalExecFile; syncBuiltinESMExports();
      // Only this fixture's original backend understands the unique exit marker.
      await writeFile(exitMarker, "release");
      await client.stop().catch(() => undefined);
      if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "the original fixture process instances exited");
      if (failed) console.error(`Fork creation stop evidence retained: ${directory}`);
      else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
    }
  });
}

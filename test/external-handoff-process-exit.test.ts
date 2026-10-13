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

for (const mode of ["handoff", "denied-then-retry", "start-race", "denied-then-stop", "observer-abort"] as const) {
test(`external handoff confirms the original idle backend exited: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-external-handoff-tree-"));
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
  const port = client as unknown as { child: ChildProcess; idleRetirement?: object };
  const originalExecFile = childProcess.execFile;
  try {
    await client.start(); const original = port.child;
    const source = await client.startThread({ cwd: directory }); const owner = client.captureThreadOwner(source);
    const captured = await captureProcessTreeEvidence(original.pid);
    evidence = captured && { processId: original.pid, ...captured };
    assert.ok(evidence?.processIdentities && evidence.processIdentities.length >= 2);
    if (mode.startsWith("denied")) {
      childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
        if (args.includes("-EncodedCommand") || command === "python3") {
          return Reflect.apply(originalExecFile, childProcess, [process.execPath, ["-e", "process.exit(13)"], options, callback]);
        }
        return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
      }) as typeof childProcess.execFile;
      syncBuiltinESMExports();
      await assert.rejects(client.releaseThreadForExternal(source, undefined, owner), /idle.*cleanup.*unconfirmed/i);
      assert.equal(await originalProcessTreeExited(evidence), false);
      assert.ok(port.idleRetirement, "Unconfirmed cleanup retains its original private tree");
      await assert.rejects(client.startThread({ cwd: directory }), /idle.*cleanup.*unconfirmed/i);
      const pendingRows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(pendingRows.filter((row) => row.kind === "process-start").length, 1, "Metadata cannot bootstrap a successor before proof");
      if (mode === "denied-then-stop") {
        await assert.rejects(client.stop(), /idle.*cleanup.*unconfirmed/i);
        await assert.rejects(client.health(), /stopped/);
        assert.equal(await originalProcessTreeExited(evidence), false);
      }
      childProcess.execFile = originalExecFile; syncBuiltinESMExports();
      if (mode === "denied-then-stop") {
        const first = client.stop(), second = client.stop(); assert.equal(first, second);
        await first; await assert.rejects(client.health(), /stopped/);
      } else await Promise.all([client.releaseThreadForExternal(source, undefined, owner), client.releaseThreadForExternal(source, undefined, owner)]);
    } else if (mode === "observer-abort") {
      const controller = new AbortController();
      const observed = client.releaseThreadForExternal(source, controller.signal, owner).then(() => undefined, (error: unknown) => error);
      await sharedWaitFor(() => Boolean(port.idleRetirement), "original handoff cleanup actually began");
      const joined = client.releaseThreadForExternal(source, undefined, owner);
      const reason = new Error("Only the original handoff observer stopped waiting");
      controller.abort(reason);
      assert.equal(await observed, reason);
      await joined;
    } else if (mode === "start-race") {
      const closing = client.releaseThreadForExternal(source, undefined, owner);
      await sharedWaitFor(() => Boolean(port.idleRetirement), "actual original tree retirement began");
      const [successor] = await Promise.all([client.startThread({ cwd: directory }), client.health(), closing]);
      assert.equal(await originalProcessTreeExited(evidence), true);
      assert.notEqual(port.child.pid, original.pid);
      await client.releaseThreadForExternal(successor, undefined, client.captureThreadOwner(successor));
    } else await client.releaseThreadForExternal(source, undefined, owner);
    const treeExited = await originalProcessTreeExited(evidence);
    const rows = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await writeFile(join(directory, "handoff-result.json"), JSON.stringify({ launcherPid: original.pid,
      launcherExitCode: original.exitCode, launcherSignalCode: original.signalCode, evidence, treeExited, rows }, null, 2));
    assert.equal(rows.filter((row) => row.kind === "unsubscribe").length, mode === "start-race" ? 2 : 1);
    assert.equal(rows.filter((row) => row.kind === "conversion-model").length, 0);
    assert.equal(rows.filter((row) => row.kind === "process-start").length, mode === "start-race" ? 2 : 1);
    assert.equal(port.idleRetirement, undefined);
    assert.equal(treeExited, true, "External writer handoff cannot finish while the captured original backend remains live");
  } catch (error) { failed = true; throw error; }
  finally {
    childProcess.execFile = originalExecFile; syncBuiltinESMExports();
    await writeFile(exitMarker, "release"); await client.stop().catch(() => undefined);
    if (evidence) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "original external-handoff fixture instances exited");
    if (failed) console.error(`External handoff evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});
}

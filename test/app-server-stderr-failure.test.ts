import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { originalProcessTreeExited } from "../src/infrastructure/process-transport.js";
import { stopCapturedProcessTree } from "../src/infrastructure/process-tree-cleanup.js";

const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/stderr-read-failure-actor.ts", import.meta.url));
for (const mode of ["ready", "initializing", "active", "exit-diagnostic"] as const) {
test(`diagnostic stderr failure preserves original control ownership: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-stderr-read-failure-"));
  const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  worker.stdout.resume(); worker.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const evidence = rows.find(row => row.kind === "original-ready")?.evidence;
  try {
    assert.equal(code, 0, `SDK diagnostic error actor failed; retained evidence ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.find(row => row.kind === "rpc-still-healthy")?.sameProcess, true);
    assert.equal(rows.find(row => row.kind === "rpc-still-healthy")?.available, true);
    assert.equal(rows.at(-1)?.kind, "actor-complete");
    if (mode === "exit-diagnostic") assert.equal(rows.find(row => row.kind === "exit-diagnostic")?.unavailableAnnotation, true);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  } catch (error) { console.error(`Stderr read failure evidence retained: ${directory}`); throw error; }
  finally {
    if (evidence && !await originalProcessTreeExited(evidence)) assert.equal(await stopCapturedProcessTree(evidence, 2000), true,
      "Only captured diagnostic original instances may be cleaned after a failed actor");
  }
});
}

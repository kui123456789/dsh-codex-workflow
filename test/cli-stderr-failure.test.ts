import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-stderr-failure-actor.ts", import.meta.url));
for (const mode of ["control", "success", "transient-exit", "terminal-exit", "invalid-thread", "retired-error", "successor", "small-bound", "stop"]) {
  test(`CLI diagnostic stderr error keeps original process ownership: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-stderr-actor-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `CLI stderr actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.filter(row => row.kind === "backend-start").length, mode === "successor" ? 2 : 1);
    assert.equal(rows.at(-1).kind, "actor-complete");
    assert.equal(rows.at(-1).starts, mode === "successor" ? 2 : 1);
    if (mode === "retired-error") assert.ok(rows.some(row => row.kind === "retired-error-consumed"));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
}

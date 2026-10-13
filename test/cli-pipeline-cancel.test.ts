import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-pipeline-cancel-actor.ts", import.meta.url));
for (const mode of ["workflow", "submission", "stop", "caller", "caller-first", "api-first", "wrong-target", "peer", "reuse", "repeated",
  "cached-workflow", "cached-submission", "cached-stop", "capture-error", "review-callback", "cached-pre-abort"]) {
  test(`CLI pipeline cancellation remains owned across admitted callbacks: ${mode}`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-pipeline-cancel-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `Pipeline cancellation actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.at(-1).kind, "actor-complete");
    assert.equal(rows.at(-1).captureCalls, mode === "cached-pre-abort" ? 0 : 1);
    if (mode !== "cached-pre-abort") { const held = rows.find(row => row.kind === "held-admitted-callback"); assert.equal(held.settled, false); assert.equal(held.stopSettled, false); }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
}

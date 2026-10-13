import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-model-stream-actor.ts", import.meta.url));
for (const mode of ["control", "stdin", "sync-stdin", "stdout", "completed-stdout", "identity-stdout", "cancel-stdin", "cancel-stdout",
  "retired-stdin", "retired-stdout", "successor-stdin", "successor-stdout"]) {
  test(`CLI model stream error preserves original process and cause: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-model-stream-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `CLI model stream actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.filter(row => row.kind === "backend-start").length, mode.startsWith("successor") ? 2 : 1);
    assert.equal(rows.at(-1).kind, "actor-complete");
    if (["stdin", "sync-stdin", "stdout", "completed-stdout", "identity-stdout", "cancel-stdin", "cancel-stdout"].includes(mode)) {
      assert.ok(rows.some(row => row.kind === "original-failed" && row.sameCause === true));
    }
    if (mode === "identity-stdout") {
      const boundary = rows.find(row => row.kind === "original-close-awaiting-binding");
      assert.equal(boundary?.callerSettled, false); assert.equal(boundary?.children, 1);
      assert.ok(rows.some(row => row.kind === "original-binding-finished"));
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
}

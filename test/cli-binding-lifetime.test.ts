import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-binding-lifetime-actor.ts", import.meta.url));
for (const mode of ["caller", "caller-success", "caller-rejected-binding", "workflow-cancel", "submission-cancel", "stop",
  "binding-reject-control", "terminal-control", "success-control"]) {
  test(`CLI original identity binding observes cancellation after process close: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-binding-lifetime-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `CLI binding actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    const held = rows.find(row => row.kind === "original-closed-binding-held");
    assert.equal(held.children, 1); assert.equal(held.callerSettled, false);
    assert.equal(rows.at(-1).kind, "actor-complete"); assert.equal(rows.at(-1).listenerCount, 0);
    if (mode.startsWith("caller")) assert.equal(rows.at(-1).sameCause, true);
    assert.equal(rows.filter(row => row.kind === "backend-start").length, mode === "success-control" ? 2 : 1);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-targeted-queued-cancel-actor.ts", import.meta.url));
for (const mode of ["workflow", "submission", "public-workflow", "public-submission", "peer", "workflow-binding",
  "stop-binding", "wrong-target", "reuse", "repeated-workflow", "caller-first", "api-first", "onspawn-cancel", "spawn-cancel"]) {
  test(`CLI targeted cancellation finds queued calls without cancelling another owner: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-targeted-queue-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `Targeted CLI actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.at(-1).kind, "actor-complete");
    if (mode === "spawn-cancel") assert.ok(rows.at(-1).killRequests >= 1); else assert.equal(rows.at(-1).killRequests, 0);
    assert.equal(rows.at(-1).pendingRuns, 0);
    if (mode !== "wrong-target" && mode !== "onspawn-cancel" && mode !== "spawn-cancel") {
      const boundary = rows.find(row => row.kind === "target-cancelled-before-owner");
      assert.equal(boundary.queuedSettled, true); assert.equal(boundary.starts, 1); assert.equal(boundary.killRequests, 0);
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
}

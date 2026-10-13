import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-queued-waiter-actor.ts", import.meta.url));
for (const mode of ["caller", "public-caller", "preaborted", "default-reason", "binding-owner", "peer-waiter",
  "release-race", "different-thread", "control"]) {
  test(`CLI queued caller cancels without disturbing its original owner: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-queued-waiter-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `CLI queued actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.at(-1).kind, "actor-complete"); assert.equal(rows.at(-1).listenerCount, 0);
    assert.equal(rows.at(-1).killRequests, 0);
    if (!["different-thread", "control"].includes(mode)) {
      const waiting = rows.find(row => row.kind === "cancelled-before-owner-finished");
      assert.equal(waiting.settled, true); assert.equal(waiting.sameCause, true); assert.equal(waiting.starts, 1);
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
}

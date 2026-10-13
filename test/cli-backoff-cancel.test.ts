import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/cli-backoff-cancel-actor.ts", import.meta.url));
for (const mode of ["workflow", "submission", "stop", "wrong-target", "peer", "reuse", "caller-first", "api-first",
  "review", "create-review", "align", "reconcile", "repeated", "late-wakeup", "stop-wait", "no-caller", "default-delay"]) {
  test(`CLI cancellation owns the complete retry operation including backoff: ${mode}`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-cli-backoff-cancel-"));
    const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    worker.stdout.resume(); worker.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(code, 0, `Backoff cancellation actor failed; evidence retained ${directory}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    assert.equal(rows.at(-1).kind, "actor-complete");
    if (mode !== "wrong-target") {
      const boundary = rows.find(row => row.kind === (mode === "late-wakeup" || mode === "stop-wait" ? "held-sleep-after-cancellation" : "cancelled-before-wakeup"));
      if (mode === "default-delay") assert.equal(boundary.productionDelay, true);
      else assert.equal(boundary.signalAborted, true);
      assert.equal(boundary.childStarts, mode === "peer" ? 2 : 1);
      assert.equal(boundary.settled, mode !== "late-wakeup" && mode !== "stop-wait");
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
}

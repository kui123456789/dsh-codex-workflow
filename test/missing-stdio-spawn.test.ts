import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url), tsx = require.resolve("tsx/cli");
const actor = fileURLToPath(new URL("./fixtures/missing-stdio-spawn-actor.ts", import.meta.url));
for (const mode of ["EMFILE", "ENFILE", "joined", "cancel-one", "cancel-last", "stop", "sync-throw", "close-only", "timeout", "actual-pid"] as const) {
test(`missing-stdio spawn lifecycle preserves original ownership: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-missing-stdio-spawn-"));
  const worker = spawn(process.execPath, [tsx, actor, directory, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  worker.stdout.resume(); let stderrBytes = 0;
  worker.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  const rows = (await readFile(join(directory, "states.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  try {
    assert.equal(code, 0, `Isolated SDK actor failed; retained evidence ${directory}, stderr bytes ${stderrBytes}`);
    assert.equal(rows.filter(row => row.kind === "uncaught-monitor").length, 0);
    if (["EMFILE", "ENFILE", "joined", "sync-throw"].includes(mode)) assert.equal(rows.find(row => row.kind === "startup-outcome")?.sameError, true);
    assert.equal(rows.find(row => row.kind === "actor-complete")?.starts, mode === "cancel-last" ? 2 : 1);
    assert.equal(rows.find(row => row.kind === "actor-complete")?.phantomProcessRecords, 0);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  } catch (error) { console.error(`Missing-stdio evidence retained: ${directory}`); throw error; }
});
}

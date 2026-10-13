import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const actor = new URL("./fixtures/foreground-cleanup-failure-actor.mjs", import.meta.url).href;
const scenario = fileURLToPath(new URL("./foreground-new-review-round.test.ts", import.meta.url));

test("foreground cleanup attempts every original resource and preserves the failing native test verdict", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-foreground-cleanup-failure-"));
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_WORKFLOW_CLEANUP_PROBE_REPORT: join(directory, "report.jsonl") };
  delete env.NODE_TEST_CONTEXT;
  const worker = spawn(process.execPath, [tsx, "--test", "--import", actor, "--test-reporter=tap",
    "--test-name-pattern=^a second manager with no runtime cannot replace another manager.s still-live unconfirmed Reviewer$", scenario],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  worker.stdout.setEncoding("utf8"); worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", chunk => { stdout += chunk; });
  worker.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("close", resolve); });
  await writeFile(join(directory, "worker.log"), stdout + stderr);
  const rows = (await readFile(join(directory, "report.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(code, 1, `The original test failure must remain visible; evidence retained ${directory}`);
  assert.match(stdout, /Original fork creation or App Server process tree cleanup is unconfirmed/);
  assert.match(stdout, /^# fail 1$/m);
  assert.equal(/Warning: A resource generated asynchronous activity|unhandledRejection|uncaughtException/.test(stdout + stderr), false);
  const observed = rows.find(row => row.kind === "cleanup-observed");
  assert.ok(observed?.originalPid);
  assert.equal(observed.injectedStopCalls, 2, "Finally and after share one cleanup; the original failed stop is never replayed by another hook");
  assert.equal(observed.originalProcessAlive, false, `A rejecting manager stop cannot skip the SDK's original process; evidence retained ${directory}`);
  assert.equal(observed.originalStoreClosed, true, "Original fixture storage is closed after independent cleanup steps");
  assert.equal(observed.originalNativeChildrenRemaining, 0);
  assert.equal(rows.at(-1)?.kind, "probe-finished");
  assert.equal(rows.at(-1)?.originalExited, true);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
});

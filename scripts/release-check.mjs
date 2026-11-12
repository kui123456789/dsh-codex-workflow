import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCompleteTestReceipt } from "./test-receipt.mjs";

const root = process.cwd();
const evidenceRoot = resolve(root, "..", ".codex-workflow-verification");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "release-"));
const runId = randomUUID();
const receiptPath = join(evidence, "tests.jsonl");
const summary = { complete: false, repositoryRoot: root, evidenceDirectory: evidence, nodeVersion: process.version, steps: [] };
const pnpm = process.env.npm_execpath;
async function run(name, command, args, env = {}, cwd = root) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true, detached: process.platform !== "win32" });
  let log = "", stdout = "";
  child.stdout.on("data", chunk => { log += chunk; stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { log += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  }, 15 * 60_000);
  let code;
  try { code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", code => accept(code ?? 1)); }); }
  finally { clearTimeout(timer); await writeFile(join(evidence, name + ".log"), log); }
  summary.steps.push({ name, exitCode: code });
  if (code !== 0) throw new Error(name + " failed with exit " + code);
  return stdout;
}
try {
  if (!pnpm) throw new Error("Run the release gate through pnpm release:check");
  await run("verify", process.execPath, [pnpm, "verify"], {
    CODEX_WORKFLOW_TEST_RECEIPT: receiptPath, CODEX_WORKFLOW_TEST_RECEIPT_ID: runId, CODEX_WORKFLOW_TEST_REPORTER: "tap",
  });
  summary.receipt = await readCompleteTestReceipt({ receiptPath, runId, repositoryRoot: root, exitCode: 0 });
  const offline = JSON.parse((await run("doctor", process.execPath, ["scripts/workflow.mjs", "doctor", "--offline", "--home", join(evidence, "doctor-home")])).trim());
  if (typeof offline.continuation?.available !== "boolean") throw new Error("Offline doctor did not return the public JSON envelope");
  await run("package", process.execPath, ["scripts/package-skill.mjs"]);
  const packageRoot = resolve("dist/codex-workflow");
  const files = [];
  async function inspect(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relative = prefix + entry.name;
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Package contains a symbolic link: " + relative);
      if (entry.isDirectory()) {
        if (["node_modules", "src", ".git", "test"].includes(entry.name)) throw new Error("Package contains development files: " + relative);
        await inspect(path, relative + "/");
      } else files.push({ path: relative, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
    }
  }
  await inspect(packageRoot);
  for (const required of ["SKILL.md", "scripts/workflow.mjs"]) {
    if (!files.some(file => file.path === required)) throw new Error("Package missing " + required);
  }
  const standalone = join(evidence, "standalone-package");
  await cp(packageRoot, standalone, { recursive: true });
  const packageDoctor = JSON.parse((await run("package-doctor", process.execPath, [join(standalone, "scripts/workflow.mjs"), "doctor", "--offline", "--home", join(evidence, "package-home")], {}, tmpdir())).trim());
  if (typeof packageDoctor.continuation?.available !== "boolean") throw new Error("Packaged CLI is not independently runnable");
  await writeFile(join(evidence, "artifacts.json"), JSON.stringify({ packageRoot, files }, null, 2) + "\n");
  async function assertNoStrays(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", ".migration-evidence", ".codegraph", ".mnemon", ".verification"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name.endsWith(".tgz") || entry.name === ".codex-pack-review") throw new Error("Packaging left a stray artifact: " + path);
      if (entry.isDirectory()) await assertNoStrays(path);
    }
  }
  await assertNoStrays(root);
  summary.complete = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(evidence, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ complete: summary.complete, evidenceDirectory: evidence, error: summary.error }));
}

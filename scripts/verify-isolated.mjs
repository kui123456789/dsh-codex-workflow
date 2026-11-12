import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const evidenceRoot = resolve(root, "..", ".codex-workflow-verification");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "isolated-"));
const stage = join(evidence, "snapshot");
const sourceEntries = new Set(["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json", "src", "test", "scripts", "SKILL.md", "agents", "references", "LICENSE"]);
const included = (local) => !local || (sourceEntries.has(local.split(sep)[0])
  && local.replaceAll("\\", "/") !== "scripts/workflow.mjs");
async function fingerprint(directory) {
  const hash = createHash("sha256");
  async function visit(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ((!prefix && !sourceEntries.has(entry.name)) || prefix + entry.name === "scripts/workflow.mjs") continue;
      if (entry.isSymbolicLink()) throw new Error("Source snapshot contains an unexpected symlink: " + prefix + entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), name + "/");
      else if (entry.isFile()) { hash.update(name); hash.update(await readFile(join(path, entry.name))); }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}
const before = await fingerprint(root);
const summary = { complete: false, repositoryRoot: root, stageDirectory: stage, evidenceDirectory: evidence, sourceHashBefore: before, runs: [] };
try {
  await cp(root, stage, { recursive: true, filter: path => {
    const local = relative(root, path);
    return included(local);
  } });
  await symlink(resolve(root, "node_modules"), join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error("Run this gate through pnpm verify:isolated");
  for (let index = 1; index <= 2; index++) {
    const child = spawn(process.execPath, [pnpm, "release:check"], { cwd: stage,
      env: { ...process.env, CODEX_WORKFLOW_TEST_REPORTER: "tap" }, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, detached: process.platform !== "win32" });
    let log = "";
    child.stdout.on("data", chunk => { log += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => { log += chunk; process.stderr.write(chunk); });
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    }, 30 * 60_000);
    let code;
    try { code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", code => accept(code ?? 1)); }); }
    finally { clearTimeout(timer); await writeFile(join(evidence, "release-" + index + ".log"), log); }
    summary.runs.push({ index, exitCode: code });
    if (code !== 0) throw new Error("Isolated release gate " + index + " failed with exit " + code);
  }
  summary.complete = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  summary.sourceHashAfter = await fingerprint(root);
  if (summary.sourceHashAfter !== before) {
    summary.complete = false; summary.error = "Original source changed during isolated verification"; process.exitCode = 1;
  }
  await writeFile(join(evidence, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}

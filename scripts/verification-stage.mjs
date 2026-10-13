import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import crossSpawn from "cross-spawn";
import { readCompleteTestReceipt } from "./test-receipt.mjs";

const REQUIRED_FILES = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE"];
const OPTIONAL_FILES = ["AGENTS.md", ".gitignore"];
const CHECKS = ["verify", "release:check", "host:check", "host:recovery:check"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) => { const path = relative(root, target); return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)); };

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function filesIn(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Verification inputs and outputs must not contain symbolic links");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("Unsupported verification file entry");
    }
  }
  if (await exists(root)) {
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Verification input directory must not be a symbolic link");
    await walk(root);
  }
  return files.sort();
}

async function inputManifest(root) {
  const paths = [];
  for (const name of ["src", "test", "scripts"]) {
    if (!await exists(join(root, name))) throw new Error("Missing verification input directory: " + name);
    paths.push(...await filesIn(join(root, name)));
  }
  paths.push(...await filesIn(join(root, ".github")));
  for (const name of REQUIRED_FILES) { await access(join(root, name)); paths.push(join(root, name)); }
  for (const name of OPTIONAL_FILES) if (await exists(join(root, name))) paths.push(join(root, name));
  const rows = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!(await lstat(path)).isFile()) throw new Error("Verification input must be a regular file");
    rows.push({ path: relative(root, path), sha256: digest(await readFile(path)) });
  }
  return rows;
}

async function buildFingerprint(root) {
  const directory = join(root, "lib"), present = await exists(directory), files = [];
  for (const path of await filesIn(directory)) {
    const info = await stat(path, { bigint: true });
    files.push({ path: relative(root, path), sha256: digest(await readFile(path)), bytes: String(info.size),
      mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
  }
  return { present, files };
}

function defaultExecute(check) {
  console.log("Running isolated check: " + check.name);
  const descriptor = openSync(check.logPath, "wx");
  try {
    const result = crossSpawn.sync(check.command, check.args, { cwd: check.cwd,
      stdio: ["ignore", descriptor, descriptor], windowsHide: true,
      env: { ...process.env, ...(check.testReceiptPath ? { DSH_WORKFLOW_TEST_RECEIPT: check.testReceiptPath,
        DSH_WORKFLOW_TEST_RECEIPT_ROOT: check.cwd, DSH_WORKFLOW_TEST_RECEIPT_ID: check.testRunId } : {}) } });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally { closeSync(descriptor); }
}

async function assertCheckEvidence(check) {
  const text = (await readFile(check.logPath, "utf8")).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  if (/Warning: A resource generated asynchronous activity|unhandledRejection|uncaughtException/.test(text)) {
    throw new Error("Isolated check produced asynchronous warnings: " + check.name);
  }
  if (check.name !== "verify" && check.name !== "release:check") return;
  const receipt = await readCompleteTestReceipt({ receiptPath: check.testReceiptPath, runId: check.testRunId,
    repositoryRoot: check.cwd, exitCode: check.exitCode });
  check.testCounts = receipt.counts;
  check.testFileCount = receipt.fileCount;
  check.testNodeVersion = receipt.nodeVersion;
}

/** Run the complete gate chain in an independent source snapshot; return its verified artifact location. */
export async function runIsolatedVerification({ repositoryRoot, evidenceDirectory, execute = defaultExecute }) {
  const repository = await realpath(repositoryRoot), evidence = resolve(evidenceDirectory);
  const actualEvidence = await exists(evidence) ? await realpath(evidence)
    : join(await realpath(dirname(evidence)), basename(evidence));
  if (inside(repository, actualEvidence) || inside(actualEvidence, repository)) throw new Error("Verification stage must be outside the repository");
  await mkdir(actualEvidence, { recursive: true });
  if ((await readdir(actualEvidence)).length !== 0) throw new Error("Verification evidence directory must be empty; preserve its previous results");
  const stage = join(actualEvidence, "stage");
  await mkdir(stage); // An existing stage is never reset or reused.
  await mkdir(join(actualEvidence, "logs"));
  const inputs = await inputManifest(repository), protectedBuild = await buildFingerprint(repository);
  const summary = { schemaVersion: 1, repositoryRoot: repository, stageDirectory: stage, inputFiles: inputs.length,
    startedAt: new Date().toISOString(), complete: false, checks: [] };
  const save = () => writeFile(join(actualEvidence, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(actualEvidence, "inputs.json"), JSON.stringify(inputs, null, 2), { flag: "wx" });
  await writeFile(join(actualEvidence, "protected-build.json"), JSON.stringify(protectedBuild, null, 2), { flag: "wx" });
  await save();
  const assertIntegrity = async () => {
    if (JSON.stringify(await inputManifest(repository)) !== JSON.stringify(inputs)) throw new Error("Original verification inputs changed");
    if (JSON.stringify(await inputManifest(stage)) !== JSON.stringify(inputs)) throw new Error("Isolated verification inputs changed");
    if (JSON.stringify(await buildFingerprint(repository)) !== JSON.stringify(protectedBuild)) throw new Error("Canonical build content or metadata changed");
  };
  try {
    for (const row of inputs) {
      const bytes = await readFile(join(repository, row.path));
      if (digest(bytes) !== row.sha256) throw new Error("Original input changed during snapshot preparation");
      const target = join(stage, row.path);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" });
    }
    const dependencies = join(repository, "node_modules");
    if (!(await stat(dependencies)).isDirectory()) throw new Error("Install development dependencies before isolated verification");
    await symlink(dependencies, join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await assertIntegrity();
    const checks = [...CHECKS.map(script => ({ name: script, command: "pnpm", args: [script], cwd: stage })),
      { name: "diff-check", command: "git", args: ["-c", "core.safecrlf=false", "diff", "--check"], cwd: repository }];
    for (const check of checks) {
      await assertIntegrity();
      const entry = { ...check, logPath: join(actualEvidence, "logs", check.name.replaceAll(":", "-") + ".log"), startedAt: new Date().toISOString() };
      if (["verify", "release:check"].includes(check.name)) {
        entry.testReceiptPath = join(actualEvidence, "logs", check.name.replaceAll(":", "-") + ".tests.jsonl");
        entry.testRunId = randomUUID();
      }
      summary.checks.push(entry); await save();
      entry.exitCode = await execute(entry); entry.completedAt = new Date().toISOString(); await save();
      await assertIntegrity();
      if (entry.exitCode !== 0) throw new Error("Isolated verification check failed: " + check.name);
      await assertCheckEvidence(entry); await save();
    }
    for (const entry of ["lib/index.js", "lib/client.js"]) if (!await exists(join(stage, entry))) throw new Error("Verified build artifact is incomplete");
    const artifacts = (await buildFingerprint(stage)).files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
    await assertIntegrity();
    await writeFile(join(actualEvidence, "artifacts.json"), JSON.stringify(artifacts, null, 2), { flag: "wx" });
    summary.complete = true; summary.artifactFiles = artifacts.length; summary.completedAt = new Date().toISOString(); await save();
    return { stageDirectory: stage, artifactDirectory: join(stage, "lib"), evidenceDirectory: actualEvidence,
      inputFiles: inputs.length, artifactFiles: artifacts.length, checks: summary.checks.map(({ name, exitCode }) => ({ name, exitCode })) };
  } catch (error) {
    summary.completedAt = new Date().toISOString(); summary.failure = error instanceof Error ? error.message : "Unknown verification failure";
    await save(); throw error;
  }
}

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";

type Check = { name: string; command: string; args: string[]; cwd: string; logPath: string; testReceiptPath?: string; testRunId?: string };
type Result = { stageDirectory: string; artifactDirectory: string; evidenceDirectory: string;
  inputFiles: number; artifactFiles: number; checks: Array<{ name: string; exitCode: number }> };
type Options = { repositoryRoot: string; evidenceDirectory: string; execute(check: Check): number | Promise<number> };
const completeCounts = "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const verificationModule = await import(new URL("../scripts/verification-stage.mjs", import.meta.url).href);
const { runIsolatedVerification } = verificationModule as { runIsolatedVerification(options: Options): Promise<Result> };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-verification-stage-test-")), repository = join(root, "source"), evidence = join(root, "evidence");
  for (const directory of ["src", "test", "scripts", "node_modules", "lib", ".github/workflows"]) await mkdir(join(repository, directory), { recursive: true });
  const content: Record<string, string> = {
    "src/index.ts": "export const original = true;", "src/client.js": "original client source",
    "test/local.test.ts": "original test", "scripts/build.mjs": "original script",
    "package.json": JSON.stringify({ name: "local-fixture", type: "module", main: "lib/index.js" }),
    "pnpm-lock.yaml": "lockfileVersion: 9", "tsconfig.json": "{}", "tsconfig.build.json": "{}", "cordis.patch.yml": "name: local",
    "README.md": "Local verification fixture", "CHANGELOG.md": "Local changelog", "LICENSE": "Local license",
    "AGENTS.md": "Local guide", ".gitignore": "lib/", ".github/workflows/check.yml": "name: local",
    "lib/client.js": "verified canonical client",
  };
  for (const [path, text] of Object.entries(content)) await writeFile(join(repository, path), text);
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const checks: Check[] = [];
  const build = async (check: Check) => {
    checks.push({ ...check, args: [...check.args] });
    await writeFile(check.logPath, completeCounts, { flag: "wx" });
    if (check.testReceiptPath) {
      const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 1 };
      const rows = [{ type: "start", schemaVersion: 1, runId: check.testRunId, repositoryRoot: check.cwd, nodeVersion: process.version },
        { type: "summary", scope: "file", file: join(check.cwd, "test/local.test.ts"), success: true, counts },
        { type: "summary", scope: "cumulative", file: null, success: true, counts },
        { type: "complete", runId: check.testRunId }];
      await writeFile(check.testReceiptPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
    }
    if (check.name === "verify") {
      await mkdir(join(check.cwd, "lib"));
      await writeFile(join(check.cwd, "lib/index.js"), "verified isolated backend");
      await writeFile(join(check.cwd, "lib/client.js"), "verified isolated client");
    }
    return 0;
  };
  const options: Options = { repositoryRoot: repository, evidenceDirectory: evidence, execute: build };
  return { root, repository, evidence, checks, build, options };
}

test("complete isolated verification returns independent artifacts and protects the canonical client metadata", async t => {
  const f = await fixture(t), target = join(f.repository, "lib/client.js");
  const before = await stat(target, { bigint: true });
  const result = await runIsolatedVerification(f.options);
  assert.equal(await readFile(target, "utf8"), "verified canonical client");
  const after = await stat(target, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
  assert.equal(await readFile(join(result.artifactDirectory, "client.js"), "utf8"), "verified isolated client");
  assert.equal(result.artifactFiles, 2);
  assert.deepEqual(result.checks.map(row => row.name), ["verify", "release:check", "host:check", "host:recovery:check", "diff-check"]);
  assert(f.checks.slice(0, 4).every(check => check.cwd === result.stageDirectory && check.command === "pnpm"));
  assert.equal(f.checks[4]!.cwd, await realpath(f.repository)); assert.equal(f.checks[4]!.command, "git");
  assert.equal(await realpath(join(result.stageDirectory, "node_modules")), await realpath(join(f.repository, "node_modules")));
  for (const path of ["AGENTS.md", ".gitignore", ".github/workflows/check.yml"]) {
    assert.equal(await readFile(join(result.stageDirectory, path), "utf8"), await readFile(join(f.repository, path), "utf8"));
  }
  const summary = JSON.parse(await readFile(join(f.evidence, "summary.json"), "utf8"));
  assert.equal(summary.complete, true);
});

test("an isolated check failure stops later checks and retains its result and diagnostics", async t => {
  const f = await fixture(t);
  f.options.execute = async check => { await f.build(check); return 7; };
  await assert.rejects(runIsolatedVerification(f.options), /check failed: verify/);
  assert.equal(f.checks.length, 1);
  const summary = JSON.parse(await readFile(join(f.evidence, "summary.json"), "utf8"));
  assert.equal(summary.complete, false); assert.equal(summary.checks[0].exitCode, 7);
  assert.equal(await readFile(f.checks[0]!.logPath, "utf8"), completeCounts);
});

test("an original execute error is propagated without starting a fallback verifier", async t => {
  const f = await fixture(t), cause = new Error("original command launch rejected");
  f.options.execute = () => { throw cause; };
  await assert.rejects(runIsolatedVerification(f.options), error => error === cause);
  assert.equal(f.checks.length, 0);
});

for (const change of ["content", "inventory"] as const) {
  test(`original source ${change} drift prevents further verification`, async t => {
    const f = await fixture(t);
    f.options.execute = async check => { await f.build(check);
      await writeFile(join(f.repository, change === "content" ? "src/index.ts" : "src/added.ts"), "displaced source"); return 0; };
    await assert.rejects(runIsolatedVerification(f.options), /Original verification inputs changed/);
    assert.equal(f.checks.length, 1);
  });
}

test("mutating the isolated source cannot silently change which inputs were verified", async t => {
  const f = await fixture(t);
  f.options.execute = async check => { await f.build(check); await writeFile(join(check.cwd, "src/index.ts"), "changed snapshot"); return 0; };
  await assert.rejects(runIsolatedVerification(f.options), /Isolated verification inputs changed/);
  assert.equal(f.checks.length, 1);
});

for (const change of ["content", "metadata", "inventory"] as const) {
  test(`canonical build ${change} changes are detected before another check or artifact handoff`, async t => {
    const f = await fixture(t);
    f.options.execute = async check => {
      await f.build(check);
      if (change === "metadata") await utimes(join(f.repository, "lib/client.js"), 1, 1);
      else await writeFile(join(f.repository, change === "content" ? "lib/client.js" : "lib/added.js"), "unexpected canonical build");
      return 0;
    };
    await assert.rejects(runIsolatedVerification(f.options), /Canonical build content or metadata changed/);
    assert.equal(f.checks.length, 1);
  });
}

test("a stage located inside the source repository is rejected before creating it", async t => {
  const f = await fixture(t), nested = join(f.repository, "verification-output");
  f.options.evidenceDirectory = nested;
  await assert.rejects(runIsolatedVerification(f.options), /outside the repository/);
  await assert.rejects(access(nested)); assert.equal(f.checks.length, 0);
});

test("an existing stage is preserved rather than reset", async t => {
  const f = await fixture(t);
  await mkdir(join(f.evidence, "stage"), { recursive: true });
  await writeFile(join(f.evidence, "stage", "original-marker"), "preserve me");
  await assert.rejects(runIsolatedVerification(f.options), /evidence directory must be empty/);
  assert.equal(await readFile(join(f.evidence, "stage", "original-marker"), "utf8"), "preserve me");
});

test("a previous evidence summary is preserved even if its stage directory is absent", async t => {
  const f = await fixture(t); await mkdir(f.evidence);
  await writeFile(join(f.evidence, "summary.json"), "original interrupted result");
  await assert.rejects(runIsolatedVerification(f.options), /evidence directory must be empty/);
  assert.equal(await readFile(join(f.evidence, "summary.json"), "utf8"), "original interrupted result");
  await assert.rejects(access(join(f.evidence, "stage")));
  assert.equal(f.checks.length, 0);
});

test("symbolic source directories cannot pull external files into the stage", async t => {
  const f = await fixture(t), external = join(f.root, "external"); await mkdir(external);
  await writeFile(join(external, "unrelated.txt"), "unrelated file");
  await symlink(external, join(f.repository, "src", "external-link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runIsolatedVerification(f.options), /symbolic links/);
  assert.equal(f.checks.length, 0);
});

test("green commands cannot claim a completed build without the required artifact entrypoints", async t => {
  const f = await fixture(t);
  f.options.execute = async check => { await f.build(check);
    if (check.name === "verify") {
      await unlink(join(check.cwd, "lib/index.js")); await unlink(join(check.cwd, "lib/client.js"));
    }
    return 0; };
  await assert.rejects(runIsolatedVerification(f.options), /artifact is incomplete/);
  assert.equal(f.checks.length, 5);
});

test("a green verifier without its native receipt cannot use TAP counts to hand off an artifact", async t => {
  const f = await fixture(t);
  f.options.execute = async check => { await f.build(check); await unlink(check.testReceiptPath!); return 0; };
  await assert.rejects(runIsolatedVerification(f.options), /missing native receipt/);
  assert.equal(f.checks.length, 1);
});

test("reported cancellations reject a green command's incomplete test result", async t => {
  const f = await fixture(t);
  f.options.execute = async check => { await f.build(check);
    const rows = (await readFile(check.testReceiptPath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    rows[1].counts.cancelled = 1; rows[1].counts.passed = 0; rows[1].success = false;
    await writeFile(check.testReceiptPath!, rows.map(row => JSON.stringify(row)).join("\n")); return 0; };
  await assert.rejects(runIsolatedVerification(f.options), /incomplete test results/);
  assert.equal(f.checks.length, 1);
});

test("asynchronous warnings reject otherwise complete green test counters", async t => {
  const f = await fixture(t);
  f.options.execute = async check => { await f.build(check); await writeFile(check.logPath, completeCounts + "unhandledRejection\n"); return 0; };
  await assert.rejects(runIsolatedVerification(f.options), /asynchronous warnings/);
  assert.equal(f.checks.length, 1);
});

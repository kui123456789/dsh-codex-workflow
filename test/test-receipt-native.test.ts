import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const module = await import(new URL("../scripts/test-receipt.mjs", import.meta.url).href);
const { readCompleteTestReceipt } = module as { readCompleteTestReceipt(options: {
  receiptPath: string; runId: string; repositoryRoot: string; exitCode: number | null;
}): Promise<{ counts: Record<string, number>; fileCount: number }> };

async function fixture(t: TestContext, code: string) {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-test-receipt-")), repository = join(root, "source"), receiptPath = join(root, "original.jsonl");
  await mkdir(join(repository, "test"), { recursive: true }); await mkdir(join(repository, "scripts"));
  await writeFile(join(repository, "package.json"), JSON.stringify({ type: "module" }));
  for (const name of ["run-tests.mjs", "test-receipt.mjs", "test-receipt-reporter.mjs"]) await copyFile(join(sourceRoot, "scripts", name), join(repository, "scripts", name));
  await symlink(join(sourceRoot, "node_modules"), join(repository, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(repository, "test/one.test.ts"), code);
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const run = (flags: string[] = [], scope = repository) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_WORKFLOW_TEST_CONCURRENCY: "1", DSH_WORKFLOW_TEST_REPORTER: "tap",
      DSH_WORKFLOW_TEST_RECEIPT: receiptPath, DSH_WORKFLOW_TEST_RECEIPT_ROOT: scope, DSH_WORKFLOW_TEST_RECEIPT_ID: "original-run" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", ...flags], { cwd: repository, env, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.error, undefined);
    return result;
  };
  const read = (exitCode: number | null) => readCompleteTestReceipt({ receiptPath, runId: "original-run", repositoryRoot: repository, exitCode });
  return { root, repository, receiptPath, run, read };
}

test("the real launcher records a single file's native totals alongside dot output", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("original passing case", () => {});');
  const native = f.run(["--test-reporter=dot"]); assert.equal(native.status, 0);
  assert.doesNotMatch(native.stdout, /# tests/);
  assert.deepEqual((await f.read(native.status)).counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
});

test("the real companion preserves nested suite counts without counting suites as tests", async t => {
  const f = await fixture(t, 'import { test, describe } from "node:test"; describe("group", () => { test("one", () => {}); test("two", () => {}); });');
  const native = f.run(); assert.equal(native.status, 0);
  const receipt = await f.read(native.status); assert.equal(receipt.counts.tests, 2); assert.equal(receipt.counts.pass, 2);
});

test("the real companion distinguishes every file summary from the cumulative run", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("first file", () => {});');
  await writeFile(join(f.repository, "test/two.test.ts"), 'import test from "node:test"; test("second file", () => {});');
  const native = f.run(); assert.equal(native.status, 0);
  const receipt = await f.read(native.status); assert.equal(receipt.fileCount, 2); assert.equal(receipt.counts.tests, 2);
});

for (const kind of ["skip", "todo"] as const) {
  test(`zero-exit native ${kind} results still reject a full gate`, async t => {
    const f = await fixture(t, `import test from "node:test"; test.${kind}("unfinished case", () => {});`);
    const native = f.run(); assert.equal(native.status, 0);
    await assert.rejects(f.read(native.status), /incomplete test results/);
  });
}

test("a real failing test retains its original nonzero launcher exit and summary", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("original failure", () => { throw new Error("controlled original failure"); });');
  const native = f.run(); assert.equal(native.status, 1);
  await assert.rejects(f.read(native.status), /command did not exit/);
  const rows = (await readFile(f.receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.scope === "cumulative").success, false);
});

test("a real cancelled test retains both file and cumulative negative outcomes", async t => {
  const f = await fixture(t, 'import test from "node:test"; const c = new AbortController(); c.abort(); test("original cancellation", { signal: c.signal }, () => {});');
  const native = f.run(); assert.equal(native.status, 1);
  const rows = (await readFile(f.receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.scope === "file").counts.cancelled, 1);
  assert.equal(rows.find(row => row.scope === "cumulative").success, false);
  await assert.rejects(f.read(native.status), /command did not exit/);
});

test("a zero-exit worker before assertions cannot claim complete native file evidence", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("unfinished assertion", () => { process.exit(0); throw new Error("never reached"); });');
  const native = f.run(); assert.equal(native.status, 0);
  await assert.rejects(f.read(native.status), /incomplete event stream|file summaries/);
});

test("an empty native file cannot become a fully tested file through its synthetic pass", async t => {
  const f = await fixture(t, 'export const noTests = true;');
  const native = f.run(); assert.equal(native.status, 0);
  await assert.rejects(f.read(native.status), /incomplete test results|incomplete event stream/);
});

test("natural late activity is retained as a machine diagnostic and the real command fails", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("late activity", () => { setImmediate(() => { throw new Error("controlled late activity"); }); });');
  const native = f.run(); assert.equal(native.status, 1);
  const rows = (await readFile(f.receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.type === "async-warning"));
  await assert.rejects(f.read(native.status), /command did not exit/);
});

test("explicit human reporter destinations remain paired with a separate native receipt", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("original human output", () => {});');
  const native = f.run(["--test-reporter=spec", "--test-reporter=dot", "--test-reporter-destination=stdout", "--test-reporter-destination=stderr"]);
  assert.equal(native.status, 0); assert.match(native.stdout, /original human output/); assert.ok(native.stderr.length > 0);
  assert.equal((await f.read(native.status)).counts.pass, 1);
});

test("an independent descendant launcher cannot claim its parent's receipt scope", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("independent child", () => {});');
  const native = f.run([], join(f.root, "different-source")); assert.equal(native.status, 0);
  await assert.rejects(readFile(f.receiptPath), { code: "ENOENT" });
  assert.match(native.stdout, /# tests 1/);
});

test("an existing receipt rejects the actual launcher before starting tests and stays intact", async t => {
  const f = await fixture(t, 'import test from "node:test"; test("must not start", () => {});');
  await writeFile(f.receiptPath, "original retained receipt");
  const native = f.run(); assert.equal(native.status, 1); assert.doesNotMatch(native.stdout, /Running/);
  assert.equal(await readFile(f.receiptPath, "utf8"), "original retained receipt");
});

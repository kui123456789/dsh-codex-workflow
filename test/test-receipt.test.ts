import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";

type ReadOptions = { receiptPath: string; runId: string; repositoryRoot: string; exitCode: number };
type ArgOptions = { flags: string[]; receiptPath: string; runId: string; repositoryRoot: string; defaultReporter?: string };
const module = await import(new URL("../scripts/test-receipt.mjs", import.meta.url).href);
const { readCompleteTestReceipt, testReceiptArguments } = module as {
  readCompleteTestReceipt(options: ReadOptions): Promise<{ counts: Record<string, number>; fileCount: number }>;
  testReceiptArguments(options: ArgOptions): Promise<string[]>;
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-test-receipt-")), repository = join(root, "source"), path = join(root, "events.jsonl");
  await mkdir(join(repository, "test"), { recursive: true });
  await writeFile(join(repository, "test/one.test.ts"), "controlled fixture");
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 1 };
  const rows: Array<Record<string, unknown>> = [
    { type: "start", schemaVersion: 1, runId: "original-run", repositoryRoot: repository, nodeVersion: process.version },
    { type: "summary", scope: "file", file: join(repository, "test/one.test.ts"), success: true, counts: { ...counts } },
    { type: "summary", scope: "cumulative", file: null, success: true, counts: { ...counts } },
    { type: "complete", runId: "original-run" },
  ];
  const options = { receiptPath: path, runId: "original-run", repositoryRoot: repository, exitCode: 0 };
  const save = () => writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { root, repository, path, rows, options, save };
}

test("native receipt counts come from one completed original run and its complete file inventory", async t => {
  const f = await fixture(t); await f.save();
  const result = await readCompleteTestReceipt(f.options);
  assert.deepEqual(result.counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(result.fileCount, 1);
});

const corruptions: Array<[string, (rows: Array<Record<string, unknown>>) => void, RegExp]> = [
  ["foreign run", rows => { rows[0]!.runId = "other-run"; }, /identity mismatch/],
  ["foreign root", rows => { rows[0]!.repositoryRoot = tmpdir(); }, /identity mismatch/],
  ["missing completion", rows => { rows.pop(); }, /incomplete event stream/],
  ["duplicate completion", rows => { rows.splice(3, 0, { ...rows[3]! }); }, /repeated stream markers/],
  ["duplicate cumulative", rows => { rows.splice(3, 0, { ...rows[2]! }); }, /ambiguous cumulative/],
  ["duplicate file", rows => { rows.splice(2, 0, { ...rows[1]! }); }, /file summaries/],
  ["summary after cumulative", rows => { [rows[1]!, rows[2]!] = [rows[2]!, rows[1]!]; }, /not final/],
  ["wrong total", rows => { rows[2]!.counts = { ...(rows[2]!.counts as object), tests: 2, passed: 2 }; }, /totals differ/],
  ["string counter", rows => { rows[1]!.counts = { ...(rows[1]!.counts as object), passed: "1" }; }, /invalid summary/],
  ["negative counter", rows => { rows[1]!.counts = { ...(rows[1]!.counts as object), failed: -1 }; }, /invalid summary/],
  ["unsafe counter", rows => { rows[1]!.counts = { ...(rows[1]!.counts as object), tests: Number.MAX_SAFE_INTEGER + 1 }; }, /invalid summary/],
  ["unknown scope", rows => { rows[1]!.scope = "guessed"; }, /ambiguous cumulative/],
  ["foreign file", rows => { rows[1]!.file = join(tmpdir(), "foreign.test.ts"); }, /foreign test file/],
  ["relative file", rows => { rows[1]!.file = "test/one.test.ts"; }, /foreign test file/],
  ["wrong completion owner", rows => { rows[3]!.runId = "other-run"; }, /identity mismatch/],
  ["successful skipped file", rows => { rows[1]!.counts = { ...(rows[1]!.counts as object), passed: 0, skipped: 1 }; }, /incomplete test results/],
  ["native warning", rows => { rows.splice(2, 0, { type: "async-warning" }); }, /asynchronous diagnostics/],
];
for (const [name, corrupt, expected] of corruptions) {
  test(`native receipt rejects ${name} without inferring a replacement result`, async t => {
    const f = await fixture(t); corrupt(f.rows); await f.save();
    await assert.rejects(readCompleteTestReceipt(f.options), expected);
  });
}

test("a green native stream cannot override the original command's nonzero exit", async t => {
  const f = await fixture(t); await f.save();
  await assert.rejects(readCompleteTestReceipt({ ...f.options, exitCode: 7 }), /command did not exit/);
});

test("a missing or malformed native file cannot fall back to human counters", async t => {
  const f = await fixture(t);
  await assert.rejects(readCompleteTestReceipt(f.options), /missing native receipt/);
  await writeFile(f.path, '# tests 1\n# pass 1\n{"type":');
  await assert.rejects(readCompleteTestReceipt(f.options), /malformed event stream/);
});

test("human reporter flags retain their ordered destinations while the companion records exclusively", async t => {
  const f = await fixture(t);
  const flags = ["--test-reporter=spec", "--test-reporter", "dot", "--test-reporter-destination=stdout", "--test-reporter-destination", "stderr"];
  const result = await testReceiptArguments({ ...f.options, flags });
  assert.deepEqual(result.slice(0, flags.length), flags);
  assert.match(result.at(-2)!, /^--test-reporter=file:\/\/.+test-receipt-reporter\.mjs$/);
  assert.equal(result.at(-1), "--test-reporter-destination=stdout");
});

test("unpaired human reporter destinations are rejected rather than repaired", async t => {
  const f = await fixture(t);
  await assert.rejects(testReceiptArguments({ ...f.options, flags: ["--test-reporter=spec", "--test-reporter=dot"] }), /unpaired reporter/);
});

test("an existing original receipt is preserved before any test startup", async t => {
  const f = await fixture(t); await writeFile(f.path, "original receipt");
  await assert.rejects(testReceiptArguments({ ...f.options, flags: [] }), /already exists/);
  assert.equal(await readFile(f.path, "utf8"), "original receipt");
});

test("an output parent alias into the repository is rejected before creating a receipt", async t => {
  const f = await fixture(t), alias = join(f.root, "source-alias");
  await symlink(join(f.repository, "test"), alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(testReceiptArguments({ ...f.options, flags: [], receiptPath: join(alias, "new.jsonl") }), /aliases the source/);
});

test("the reporter's exclusive creation preserves a receipt introduced after argument admission", async t => {
  const f = await fixture(t);
  await testReceiptArguments({ ...f.options, flags: [] });
  await writeFile(f.path, "original owner won admission");
  const prior = { path: process.env.DSH_WORKFLOW_TEST_RECEIPT, id: process.env.DSH_WORKFLOW_TEST_RECEIPT_ID, root: process.env.DSH_WORKFLOW_TEST_RECEIPT_ROOT };
  process.env.DSH_WORKFLOW_TEST_RECEIPT = f.path; process.env.DSH_WORKFLOW_TEST_RECEIPT_ID = f.options.runId;
  process.env.DSH_WORKFLOW_TEST_RECEIPT_ROOT = f.repository;
  try {
    const reporter = await import(new URL("../scripts/test-receipt-reporter.mjs", import.meta.url).href);
    async function* empty() { /* Actual file collision occurs before any event can be consumed. */ }
    await assert.rejects(async () => { for await (const _ of reporter.default(empty())) { /* No human output. */ } }, { code: "EEXIST" });
    assert.equal(await readFile(f.path, "utf8"), "original owner won admission");
  } finally {
    for (const [key, value] of Object.entries({ DSH_WORKFLOW_TEST_RECEIPT: prior.path, DSH_WORKFLOW_TEST_RECEIPT_ID: prior.id, DSH_WORKFLOW_TEST_RECEIPT_ROOT: prior.root })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

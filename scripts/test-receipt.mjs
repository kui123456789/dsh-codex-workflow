import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const FIELDS = ["tests", "passed", "failed", "cancelled", "skipped", "todo", "suites", "topLevel"];
const inside = (root, target) => { const path = relative(root, target); return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)); };
const reject = reason => { throw new Error("Invalid test receipt: " + reason); };

/** Add a machine reporter without reordering explicit human reporter/destination pairs. */
export async function testReceiptArguments({ flags, receiptPath, runId, repositoryRoot, defaultReporter = "tap" }) {
  if (typeof runId !== "string" || !runId || !isAbsolute(receiptPath) || inside(resolve(repositoryRoot), resolve(receiptPath))) reject("unscoped output path or run identity");
  if (!(await stat(dirname(receiptPath))).isDirectory()) reject("output directory is unavailable");
  if (inside(await realpath(repositoryRoot), join(await realpath(dirname(receiptPath)), basename(receiptPath)))) reject("output aliases the source repository");
  try { await lstat(receiptPath); reject("output already exists; preserve the original receipt"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const result = [...flags];
  let reporters = 0, destinations = 0;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    for (const [key, count] of [["--test-reporter", "reporter"], ["--test-reporter-destination", "destination"]]) {
      if (flag === key || flag.startsWith(key + "=")) {
        const value = flag === key ? flags[++index] : flag.slice(key.length + 1);
        if (!value || value.startsWith("--")) reject("missing reporter argument");
        if (count === "reporter") reporters++; else destinations++;
        break;
      }
    }
  }
  if (reporters === 0) {
    if (destinations !== 0) reject("unpaired reporter destinations");
    result.push("--test-reporter=" + defaultReporter); reporters = 1;
  }
  if (reporters === 1 && destinations === 0) { result.push("--test-reporter-destination=stdout"); destinations = 1; }
  if (reporters !== destinations) reject("unpaired reporter destinations");
  result.push("--test-reporter=" + new URL("./test-receipt-reporter.mjs", import.meta.url).href,
    "--test-reporter-destination=stdout"); // The companion emits no human text and creates its own file exclusively.
  return result;
}

/** Read the original native event receipt only after its command actually exits. */
export async function readCompleteTestReceipt({ receiptPath, runId, repositoryRoot, exitCode }) {
  if (exitCode !== 0) reject("command did not exit successfully");
  if (typeof runId !== "string" || !runId || !isAbsolute(repositoryRoot)) reject("original run identity mismatch");
  let info;
  try { info = await lstat(receiptPath); } catch (error) { if (error.code === "ENOENT") reject("missing native receipt"); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > 4 * 1024 * 1024) reject("missing or unsupported receipt file");
  let rows;
  try { rows = (await readFile(receiptPath, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { reject("malformed event stream"); }
  if (rows.length < 4 || rows[0]?.type !== "start" || rows.at(-1)?.type !== "complete") reject("incomplete event stream");
  const start = rows[0];
  if (start.schemaVersion !== 1 || start.runId !== runId || rows.at(-1).runId !== runId
    || typeof start.repositoryRoot !== "string" || relative(resolve(repositoryRoot), resolve(start.repositoryRoot)) !== ""
    || typeof start.nodeVersion !== "string" || !/^v\d+\.\d+\.\d+/.test(start.nodeVersion)) reject("original run identity mismatch");
  const summaries = rows.slice(1, -1);
  if (summaries.some(row => row?.type === "async-warning")) reject("asynchronous diagnostics");
  if (summaries.some(row => row?.type !== "summary")) reject("unexpected or repeated stream markers");
  const cumulative = summaries.filter(row => row.scope === "cumulative"), files = summaries.filter(row => row.scope === "file");
  if (cumulative.length !== 1 || cumulative.length + files.length !== summaries.length || cumulative[0].file !== null) reject("ambiguous cumulative summary");
  if (summaries.at(-1) !== cumulative[0]) reject("cumulative summary is not final");
  for (const row of summaries) {
    if (typeof row.success !== "boolean" || !row.counts || FIELDS.some(key => !Number.isSafeInteger(row.counts[key]) || row.counts[key] < 0)) reject("invalid summary fields");
    if (!row.success || row.counts.tests <= 0 || row.counts.passed !== row.counts.tests
      || ["failed", "cancelled", "skipped", "todo"].some(key => row.counts[key] !== 0)) reject("incomplete test results");
  }
  const expected = (await readdir(resolve(repositoryRoot, "test"))).filter(name => name.endsWith(".test.ts")).sort().map(name => "test/" + name);
  const actual = files.map(row => {
    if (typeof row.file !== "string" || !isAbsolute(row.file) || !inside(resolve(repositoryRoot), resolve(row.file))) reject("foreign test file summary");
    return relative(resolve(repositoryRoot), resolve(row.file)).replaceAll("\\", "/");
  }).sort();
  if (expected.length === 0 || JSON.stringify(actual) !== JSON.stringify(expected)) reject("missing, duplicate or foreign file summaries");
  const native = cumulative[0].counts;
  if (files.reduce((sum, row) => sum + row.counts.tests, 0) !== native.tests) reject("cumulative totals differ from completed files");
  return { counts: { tests: native.tests, pass: native.passed, fail: native.failed, cancelled: native.cancelled,
    skipped: native.skipped, todo: native.todo }, fileCount: files.length, nodeVersion: start.nodeVersion };
}

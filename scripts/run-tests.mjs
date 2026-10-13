import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const concurrency = process.env.DSH_WORKFLOW_TEST_CONCURRENCY ?? "4";
if (!/^[1-4]$/.test(concurrency)) {
  console.error("DSH_WORKFLOW_TEST_CONCURRENCY must be an integer from 1 to 4.");
  process.exit(2);
}
const reporter = process.env.DSH_WORKFLOW_TEST_REPORTER;
if (reporter && reporter !== "spec" && reporter !== "tap") {
  console.error("DSH_WORKFLOW_TEST_REPORTER must be spec or tap.");
  process.exit(2);
}
const files = readdirSync(new URL("../test/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts")).sort().map((name) => `test/${name}`);
const flags = process.argv.slice(2);
if (flags[0] === "--") flags.shift();
const hasExplicitReporter = flags.some((flag) => flag === "--test-reporter" || flag.startsWith("--test-reporter="));
const reporterFlags = reporter && !hasExplicitReporter ? [`--test-reporter=${reporter}`] : [];
let testFlags = [...reporterFlags, ...flags];
const receiptRoot = process.env.DSH_WORKFLOW_TEST_RECEIPT_ROOT;
if (process.env.DSH_WORKFLOW_TEST_RECEIPT && receiptRoot && relative(resolve(root), resolve(receiptRoot)) === "") {
  const { testReceiptArguments } = await import("./test-receipt.mjs");
  testFlags = await testReceiptArguments({ flags: testFlags, receiptPath: process.env.DSH_WORKFLOW_TEST_RECEIPT,
    runId: process.env.DSH_WORKFLOW_TEST_RECEIPT_ID, repositoryRoot: root, defaultReporter: reporter || "tap" });
}
console.log(`Running ${files.length} test files with concurrency ${concurrency}.`);
const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")),
  "--test", `--test-concurrency=${concurrency}`, ...testFlags, ...files], {
  cwd: root, stdio: "inherit", windowsHide: true,
});
if (result.error) console.error("Unable to launch the test runner.");
process.exitCode = result.status ?? 1;

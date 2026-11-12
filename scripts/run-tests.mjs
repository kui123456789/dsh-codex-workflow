import { spawn } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readCompleteTestReceipt, testReceiptArguments } from "./test-receipt.mjs";

const root = process.cwd();
const concurrency = process.env.CODEX_WORKFLOW_TEST_CONCURRENCY ?? "1";
if (!/^[1-4]$/.test(concurrency)) throw new Error("CODEX_WORKFLOW_TEST_CONCURRENCY must be 1–4");
const runId = process.env.CODEX_WORKFLOW_TEST_RECEIPT_ID ?? randomUUID();
const receiptPath = process.env.CODEX_WORKFLOW_TEST_RECEIPT
  ?? join(await mkdtemp(join(tmpdir(), "codex-workflow-tests-")), "tests.jsonl");
const flags = await testReceiptArguments({ flags: process.argv.slice(2), receiptPath, runId,
  repositoryRoot: root, defaultReporter: process.env.CODEX_WORKFLOW_TEST_REPORTER ?? "tap" });
const files = (await readdir("test")).filter(name => name.endsWith(".test.ts")).sort().map(name => "test/" + name);
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=" + concurrency, ...flags, ...files], {
  stdio: "inherit", env: { ...process.env, CODEX_WORKFLOW_TEST_RECEIPT: receiptPath,
    CODEX_WORKFLOW_TEST_RECEIPT_ID: runId, CODEX_WORKFLOW_TEST_RECEIPT_ROOT: resolve(root) },
});
const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("exit", code => accept(code ?? 1)); });
if (code !== 0) process.exitCode = Number(code);
else {
  const receipt = await readCompleteTestReceipt({ receiptPath, runId, repositoryRoot: root, exitCode: code });
  console.log(JSON.stringify({ receiptPath, ...receipt }));
}

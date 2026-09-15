#!/usr/bin/env node
// Real CLI acceptance for first review-only creation and same-task repair.
// The DSH tool execution context is a fixture; model calls and persistence are real.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Config, PLUGIN_VERSION, WorkflowStore, WorkflowManager, CodexAppServerClient, CodexCliAuditDispatcher } from "../lib/index.js";
import { REVIEW_OUTPUT_SCHEMA } from "../lib/schemas.js";
import { ALIGN_OUTPUT_SCHEMA } from "../lib/review-authority.js";

const root = await mkdtemp(join(tmpdir(), "dsh-review-only-accept-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
const model = process.env.DSH_CODEX_LIFECYCLE_MODEL || undefined;
const config = { ...Config({ storageDir: join(root, "state"), reviewerModel: model ?? "" }), rpcTimeoutMs: 60_000 };
await writeFile(join(root, "review.json"), JSON.stringify(REVIEW_OUTPUT_SCHEMA));
await writeFile(join(root, "alignment.json"), JSON.stringify(ALIGN_OUTPUT_SCHEMA));
const calls = [];
const audit = new CodexCliAuditDispatcher({ command: config.codexCommand,
  reviewSchemaFile: join(root, "review.json"), alignmentSchemaFile: join(root, "alignment.json"),
  timeoutMs: config.callbackTimeoutMs, maxOutputBytes: 4 * 1024 * 1024,
  onSpawn: (args) => { calls.push(args); console.log(JSON.stringify({ stage: args.includes("--ephemeral") ? "internal" : args.includes("resume") ? "resume" : "create", at: new Date().toISOString() })); },
});
const codex = new CodexAppServerClient({ command: config.codexCommand, requestTimeoutMs: config.turnTimeoutMs, rpcTimeoutMs: config.rpcTimeoutMs, idleProcessMs: 0 });
codex.startReviewerThread = async () => { throw new Error("first CLI review must not create an empty App Server task"); };
const store = new WorkflowStore(config.storageDir);
const manager = new WorkflowManager(store, codex, config, audit, undefined, audit);
const exec = { agent: { id: "review-only-live-acceptance", session: { header: { cwd } } }, signal: new AbortController().signal, deferContext: () => {} };
const run = (command, args) => spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
console.log(JSON.stringify({ root, version: PLUGIN_VERSION, model }));
try {
  await writeFile(join(cwd, "sum.mjs"), "export const add = (a, b) => 0;\n");
  await writeFile(join(cwd, "sum.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './sum.mjs';\ntest('positive', () => assert.equal(add(2, 3), 5));\ntest('negative', () => assert.equal(add(-2, 3), 1));\ntest('zero', () => assert.equal(add(0, 0), 0));\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Compatibility Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"]]) {
    const result = run("git", args); assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(join(cwd, "sum.mjs"), "export const add = (a, b) => a - b;\n");
  const failing = run(process.execPath, ["--test", "sum.test.mjs"]);
  assert.notEqual(failing.status, 0);
  const first = await manager.reviewOnly({ task: "实现 add(a,b)，对有限 number 返回 a+b。只需 sum.mjs 的命名导出和现有 sum.test.mjs 三个 Node 内置测试通过。不需要输入校验、额外文档或其他测试。只读审查当前候选实现，给出真实结论，不修改文件。", implementationSummary: "当前候选实现待审查。", changedFiles: ["sum.mjs"], testResults: failing.stdout + failing.stderr, ...(model ? { reviewerModel: model } : {}) }, exec);
  assert.equal(first.phase, "fixing", JSON.stringify(first.latestReview));
  assert.equal(first.latestReview.verdict, "changes_requested");
  console.log(JSON.stringify({ stage: "first-result", workflowId: first.id, threadId: first.reviewerThreadId, phase: first.phase }));
  await writeFile(join(cwd, "sum.mjs"), "export const add = (a, b) => a + b;\n");
  const passing = run(process.execPath, ["--test", "sum.test.mjs"]);
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  const second = await manager.review(first.id, { implementationSummary: "已将减法修正为加法，只修改 sum.mjs。", changedFiles: ["sum.mjs"], testResults: passing.stdout + passing.stderr }, exec);
  assert.equal(second.phase, "passed", JSON.stringify(second.latestReview));
  assert.equal(second.reviewerThreadId, first.reviewerThreadId);
  assert.equal(second.reviewCycles, 2);
  const visible = calls.filter((args) => !args.includes("--ephemeral"));
  assert.ok(!visible[0].includes("resume"));
  for (const args of visible.slice(1)) assert.deepEqual(args.slice(-3), ["resume", first.reviewerThreadId, "-"]);
  const report = { ok: true, version: PLUGIN_VERSION, workflowId: first.id, threadId: first.reviewerThreadId, firstVerdict: first.latestReview.verdict, secondVerdict: second.latestReview.verdict, reviewCycles: second.reviewCycles, calls };
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log("REVIEW_ONLY_ACCEPTANCE_OK " + JSON.stringify(report));
} finally {
  await manager.stop(); await audit.stop(); await codex.stop(); store.close();
}

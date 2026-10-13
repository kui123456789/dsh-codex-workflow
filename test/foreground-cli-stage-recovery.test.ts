import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CodexCliAuditDispatcher } from "../src/codex-cli-audit.js";
import { ALIGN_OUTPUT_SCHEMA } from "../src/review-authority.js";
import { REVIEW_OUTPUT_SCHEMA } from "../src/schemas.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { ReviewInput, WorkflowConfig } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Fixture = Awaited<ReturnType<typeof sharedReviewerFixture>>;
type Failure = "model" | "stream" | "schema" | "permission" | "none";
interface CliCall { stage: "initial_normalization" | "alignment" | "reconciliation_readable" | "corrected_normalization"; pid: number; args: string[]; }
const input: ReviewInput = { implementationSummary: "Read-only local diagnostics implemented", changedFiles: ["changed.txt"], testResults: "Valid and unavailable inputs verified" };
const originalReadable = "VERDICT: changes_requested\nFINDINGS: high/blocking: require an unrelated persistence migration\nTEST GAPS: none\nSUMMARY: Require unrelated migration.";
const correctedReadable = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Corrected final readable review.";
const originalVerdict = { verdict: "changes_requested", findings: [{ severity: "high", blocking: true,
  title: "Require unrelated persistence migration", body: "Generic suggestion exceeds read-only diagnostic scope", file: "changed.txt", line: 1 }],
  testGaps: [], summary: "Requested unrelated migration" };
const correctedVerdict = { verdict: "pass", findings: [], testGaps: [], summary: "Corrected final readable review" };
const conflict = { aligned: false, conflicts: [{ kind: "finding", index: 0, reason: "Unrelated migration exceeds scope",
  violated: "Original task requires read-only diagnostics", highSeverityException: false }] };
const internal = (manager: WorkflowManager) => manager as unknown as { config: WorkflowConfig; runtime: WorkflowRuntimeState };

async function actualCli(f: Fixture, failure: Failure) {
  // Local process initialization can be delayed when the repository's suites
  // share a busy Windows host. Model failures remain explicit protocol replies.
  (f.client as unknown as { options: { rpcTimeoutMs: number } }).options.rpcTimeoutMs = 15_000;
  const protocol = join(f.directory, "local-cli-protocol.mjs");
  const ledger = join(f.directory, "local-cli-calls.json");
  const reviewSchema = join(f.directory, "review-schema.json");
  const alignmentSchema = join(f.directory, "alignment-schema.json");
  await Promise.all([writeFile(ledger, "[]"), writeFile(reviewSchema, JSON.stringify(REVIEW_OUTPUT_SCHEMA)),
    writeFile(alignmentSchema, JSON.stringify(ALIGN_OUTPUT_SCHEMA)), writeFile(protocol, `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const ledger = ${JSON.stringify(ledger)};
  const calls = JSON.parse(readFileSync(ledger, "utf8"));
  const schema = args[args.indexOf("--output-schema") + 1];
  const stage = args.includes("--output-schema")
    ? schema.endsWith("alignment-schema.json") ? "alignment"
      : prompt.includes("Corrected final readable review") ? "corrected_normalization" : "initial_normalization"
    : "reconciliation_readable";
  calls.push({ stage, pid: process.pid, args });
  writeFileSync(ledger, JSON.stringify(calls));
  const message = (text) => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  if (stage === "corrected_normalization") {
    const attempt = calls.filter((call) => call.stage === stage).length;
    if (["model", "stream"].includes(${JSON.stringify(failure)}) && attempt <= 2) {
      process.stderr.write(${JSON.stringify(failure)} === "model" ? "turn failed" : "stream disconnected"); process.exitCode = 1; return;
    }
    if (${JSON.stringify(failure)} === "permission") {
      process.stderr.write("permission denied: local CLI normalization control"); process.exitCode = 1; return;
    }
    if (${JSON.stringify(failure)} === "schema") { message("{invalid schema output}"); return; }
  }
  if (stage === "reconciliation_readable") return message(${JSON.stringify(correctedReadable)});
  if (stage === "initial_normalization") return message(JSON.stringify(${JSON.stringify(originalVerdict)}));
  if (stage === "corrected_normalization") return message(JSON.stringify(${JSON.stringify(correctedVerdict)}));
  const alignmentNumber = calls.filter((call) => call.stage === "alignment").length;
  return message(JSON.stringify(alignmentNumber === 1 ? ${JSON.stringify(conflict)} : { aligned: true, conflicts: [] }));
});
`, "utf8")]);
  const audit = new CodexCliAuditDispatcher({ command: process.execPath, reviewSchemaFile: reviewSchema,
    alignmentSchemaFile: alignmentSchema, timeoutMs: 15_000,
    retry: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
    spawn: (_command, args, options) => spawn(process.execPath, [protocol, ...args], options as SpawnOptions),
  });
  return { audit, calls: async (): Promise<CliCall[]> => JSON.parse(await readFile(ledger, "utf8")) };
}

function foreground(f: Fixture, audit: CodexCliAuditDispatcher) {
  return new WorkflowManager(f.store, f.client, { ...internal(f.manager).config, conversionTransport: "cli", conversionFallback: "fail" },
    undefined, undefined, audit, {}, { get: (id) => id === f.parent.id ? f.parent : undefined }, f.factory);
}

async function completeOriginalReview(f: Fixture) {
  await sharedWaitFor(async () => {
    const stats = await f.control("fixture/stats");
    return stats.active.length === 1 && stats.turnStartRequests.length === 1 && stats;
  }, "the original SDK readable Reviewer turn");
  await f.control("fixture/completeActive", { text: originalReadable });
}

for (const failure of ["stream", "model"] as const) test(`foreground CLI corrected normalization ${failure} failure recovers without repeating its successful readable reconciliation`, async (t) => {
  const f = await sharedReviewerFixture();
  const cli = await actualCli(f, failure);
  const manager = foreground(f, cli.audit);
  try {
    const pending = manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
    await completeOriginalReview(f);
    const [outcome] = await Promise.allSettled([pending]);
    if (outcome?.status === "rejected") {
      t.diagnostic(JSON.stringify({ failure, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        calls: (await cli.calls()).map((call) => call.stage) }));
    }
    assert.equal(outcome?.status, "fulfilled", "A recoverable CLI model diagnostic must preserve the original waiting stage");
    assert.ok(outcome?.status === "fulfilled");
    const waiting = outcome.value;
    assert.equal(waiting.processState, "waiting");
    assert.equal(waiting.reviewCycles, 0);
    const child = internal(manager).runtime.codexChildSessions.get(waiting.id);
    const originalRun = internal(manager).runtime.recoverableRuns.get(waiting.id);
    assert.ok(child && originalRun);
    const before = await cli.calls();
    assert.equal(before.filter((call) => call.stage === "corrected_normalization").length, 2,
      "The failed stage spends exactly one automatic continuation before waiting");
    const result = await manager.resume(waiting.id, undefined, f.exec);
    const after = await cli.calls();
    const sdk = await f.control("fixture/stats");
    t.diagnostic(JSON.stringify({ phase: result.phase, before: before.map((call) => call.stage), after: after.map((call) => call.stage),
      nativeChildren: f.children.length, nativeReviewCalls: sdk.turnStartRequests.filter((request) => request.method === "review/start").length }));
    assert.equal(result.phase, "passed");
    assert.equal(result.reviewCycles, 1);
    assert.equal(after.filter((call) => call.stage === "initial_normalization").length, 1);
    assert.equal(after.filter((call) => call.stage === "alignment").length, 2);
    assert.equal(after.filter((call) => call.stage === "corrected_normalization").length, 3);
    assert.equal(after.filter((call) => call.stage === "reconciliation_readable").length, 1,
      "A successful one-shot CLI correction cannot be reissued because its private normalization failed");
    assert.ok(after.every((call) => Number.isSafeInteger(call.pid) && call.pid > 0 && call.pid !== process.pid),
      "Every CLI call executed in a genuine isolated child process");
    assert.ok(after.every((call) => call.args.includes("--ephemeral") && !call.args.includes("resume")),
      "CLI private work creates only ephemeral calls and never resumes a synthetic or durable Reviewer id");
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.id, child.id);
    assert.equal(f.rawDisposals.length, 1);
    assert.equal(sdk.turnStartRequests.filter((request) => request.method === "review/start").length, 1);
    assert.equal(sdk.threadStarts.length, 1, "CLI private work does not replace the original SDK Reviewer");
    assert.equal(sdk.active.length, 0);
    assert.equal(sdk.writerConflicts, 0);
  } finally { await manager.stop(); await cli.audit.stop(); await f.close(); }
});

for (const failure of ["schema", "permission"] as const) {
  test(`CLI corrected normalization ${failure} failure remains terminal without automatic correction replay`, async () => {
    const f = await sharedReviewerFixture();
    const cli = await actualCli(f, failure);
    const manager = foreground(f, cli.audit);
    try {
      const pending = manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
      void pending.catch(() => undefined);
      await completeOriginalReview(f);
      await assert.rejects(pending, failure === "schema" ? /invalid|schema/i : /permission denied/i);
      const record = (await f.store.list())[0];
      assert.ok(record);
      assert.equal(record.processState, "failed");
      assert.equal(record.reviewCycles, 0);
      assert.equal(internal(manager).runtime.recoverableRuns.size, 0);
      const before = await cli.calls();
      assert.equal(before.filter((call) => call.stage === "reconciliation_readable").length, 1);
      assert.equal(before.filter((call) => call.stage === "corrected_normalization").length, 1);
      const row = f.store.coordinationHandle.loadWorkflow(record.id);
      await assert.rejects(manager.review(record.id, input, f.exec));
      assert.deepEqual(await cli.calls(), before);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(record.id), row);
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 1);
    } finally { await manager.stop(); await cli.audit.stop(); await f.close(); }
  });
}

test("the existing two-argument CLI reconciliation contract still returns readable text and a verdict", async () => {
  const f = await sharedReviewerFixture();
  const cli = await actualCli(f, "none");
  try {
    const result = await cli.audit.reconcile({ workflowId: "isolated-bridge-compatibility", submissionId: "isolated-submission",
      codexThreadId: "ephemeral", ephemeral: true, cwd: f.directory, prompt: "Resolve this authority conflict once",
      task: "Review read-only local diagnostics", model: "model-A", effort: "low" }, new AbortController().signal);
    assert.deepEqual(result, { visibleText: correctedReadable, verdict: correctedVerdict });
    const calls = await cli.calls();
    assert.deepEqual(calls.map((call) => call.stage), ["reconciliation_readable", "corrected_normalization"]);
    assert.ok(calls.every((call) => call.args.includes("--ephemeral") && !call.args.includes("resume")));
    assert.equal(f.children.length, 0);
  } finally { await cli.audit.stop(); await f.close(); }
});

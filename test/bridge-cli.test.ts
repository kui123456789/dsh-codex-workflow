import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseBridgeCommand, newRequestId } from "../src/bridge-protocol.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "bridge-cli.ts");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], stdin: string, dshHome: string, envOverrides: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, cli, ...args], {
      env: { ...process.env, DSH_HOME: dshHome, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function makeHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-cli-home-"));
  await mkdir(join(directory, "storages", "dsh-codex-workflow"), { recursive: true });
  return directory;
}

/** Register live sessions the way a real runtime would: into the shared
 * SQLite live_sessions table with a long lease starting NOW. */
async function registerSessions(home: string, sessions: Array<{ id: string; cwd: string }>): Promise<void> {
  const { BridgeStore } = await import("../src/bridge-store.js");
  const store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
  await store.init();
  store.coordinationHandle.refreshOwnerSessions(
    "cli-test-owner",
    sessions.map((s) => ({ sessionId: s.id, cwd: s.cwd })),
    60 * 60 * 1000,
  );
  store.close();
}

const payload = JSON.stringify({
  task: "实现搜索功能",
  planMarkdown: "<proposed_plan>\n修改 src/search.ts\n</proposed_plan>",
  assumptions: ["测试可用"],
});

const verdict = JSON.stringify({
  verdict: "changes_requested",
  findings: [
    { severity: "high", blocking: true, title: "缺陷", body: "修复", file: "src/a.ts", line: 10 },
  ],
  testGaps: [],
  summary: "需要修复",
});

test("sessions lists live sessions matching the cwd as exact JSON without ANSI", async () => {
  const home = await makeHome();
  try {
    const cwd = "C:\\Users\\张三\\project with spaces";
    await registerSessions(home, [
      { id: "session-a", cwd },
      { id: "session-b", cwd: "D:\\other" },
    ]);
    const result = await runCli(["sessions", "--cwd", cwd, "--json"], "", home);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as Array<{ id: string; cwd: string; updatedAt: string }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.id, "session-a");
    assert.equal(parsed[0]!.cwd, cwd);
    assert.ok(typeof parsed[0]!.updatedAt === "string" && !Number.isNaN(Date.parse(parsed[0]!.updatedAt)), "updatedAt is an ISO timestamp");
    assert.ok(!/\u001b\[/.test(result.stdout), "no ANSI escapes in --json output");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatch enqueues a validated plan for the unique session matching the cwd", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const cwd = "C:\\Users\\张三\\project with spaces";
    await registerSessions(home, [{ id: "session-exact", cwd }]);
    const threadId = newRequestId();
    const result = await runCli(
      ["dispatch", "--cwd", cwd, "--codex-thread", threadId, "--stdin", "--json"],
      payload,
      home,
    );
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as { requestId: string; dshSessionId: string };
    assert.equal(out.dshSessionId, "session-exact");
    // The CLI (a separate process) persisted the command into the shared DB.
    store = new (await import("../src/bridge-store.js")).BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    const inbox = store.coordinationHandle.queueRowsByStatus("inbox");
    assert.equal(inbox.length, 1);
    const command = parseBridgeCommand(JSON.parse(inbox[0]!.commandJson)) as Extract<ReturnType<typeof parseBridgeCommand>, { kind: "dispatch_plan" }>;
    assert.equal(command.codexThreadId, threadId);
    assert.equal(command.target.dshSessionId, "session-exact");
    assert.match(command.task, /搜索/);
    assert.match(command.planMarkdown, /proposed_plan/);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatch fails without a matching session and on ambiguous cwd", async () => {
  const home = await makeHome();
  try {
    const threadId = newRequestId();
    const noMatch = await runCli(
      ["dispatch", "--cwd", "C:\\nowhere", "--codex-thread", threadId, "--stdin"],
      payload,
      home,
    );
    assert.notEqual(noMatch.code, 0);
    assert.match(noMatch.stderr, /no live DSH session/);

    await registerSessions(home, [
      { id: "session-1", cwd: "C:\\same" },
      { id: "session-2", cwd: "C:\\same" },
    ]);
    const ambiguous = await runCli(
      ["dispatch", "--cwd", "C:\\same", "--codex-thread", threadId, "--stdin"],
      payload,
      home,
    );
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.stderr, /multiple live DSH sessions/);

    // An explicit --dsh-session resolves the ambiguity.
    const explicit = await runCli(
      ["dispatch", "--cwd", "C:\\same", "--dsh-session", "session-2", "--codex-thread", threadId, "--stdin"],
      payload,
      home,
    );
    assert.equal(explicit.code, 0, explicit.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatch derives the thread from CODEX_THREAD_ID and fails without one", async () => {
  const home = await makeHome();
  try {
    const cwd = "C:\\work";
    await registerSessions(home, [{ id: "session-a", cwd }]);
    const missing = await new Promise<CliResult>((resolvePromise) => {
      const child = spawn(process.execPath, [tsxCli, cli, "dispatch", "--cwd", cwd, "--stdin"], {
        env: { ...process.env, DSH_HOME: home, CODEX_THREAD_ID: "" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (code) => resolvePromise({ code, stdout: "", stderr }));
      child.stdin.end(payload);
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /never invents a thread id/);

    const fromEnv = await runCli(
      ["dispatch", "--cwd", cwd, "--stdin"],
      payload,
      home,
      { CODEX_THREAD_ID: newRequestId() },
    );
    assert.equal(fromEnv.code, 0, fromEnv.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatch rejects oversized stdin payloads", async () => {
  const home = await makeHome();
  try {
    const cwd = "C:\\work";
    await registerSessions(home, [{ id: "session-a", cwd }]);
    const big = JSON.stringify({ task: "x".repeat(1024 * 1024), planMarkdown: "p" });
    const result = await runCli(
      ["dispatch", "--cwd", cwd, "--codex-thread", newRequestId(), "--stdin"],
      big,
      home,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /exceeds .* bytes/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("respond enqueues a validated verdict bound to the exact workflow and thread", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const workflowId = "wf-123";
    const threadId = newRequestId();
    const result = await runCli(
      ["respond", "--workflow", workflowId, "--codex-thread", threadId, "--stdin", "--json"],
      verdict,
      home,
    );
    assert.equal(result.code, 0, result.stderr);
    store = new (await import("../src/bridge-store.js")).BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    const inbox = store.coordinationHandle.queueRowsByStatus("inbox");
    assert.equal(inbox.length, 1);
    const command = parseBridgeCommand(JSON.parse(inbox[0]!.commandJson)) as Extract<ReturnType<typeof parseBridgeCommand>, { kind: "submit_verdict" }>;
    assert.equal(command.workflowId, workflowId);
    assert.equal(command.codexThreadId, threadId);
    assert.equal(command.verdict.findings[0]?.blocking, true);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("respond rejects invalid verdicts", async () => {
  const home = await makeHome();
  try {
    const result = await runCli(
      ["respond", "--workflow", "wf-1", "--codex-thread", newRequestId(), "--stdin"],
      JSON.stringify({ verdict: "maybe", findings: [], testGaps: [], summary: "" }),
      home,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /verdict must be pass or changes_requested/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status reports receipts as JSON and exits nonzero when absent", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const requestId = newRequestId();
    const missing = await runCli(["status", "--request", requestId, "--json"], "", home);
    assert.equal(missing.code, 0);
    assert.deepEqual(JSON.parse(missing.stdout), { requestId, receipt: null });

    const missingPlain = await runCli(["status", "--request", requestId], "", home);
    assert.notEqual(missingPlain.code, 0);

    // Deliver a receipt through the store and re-check (SQLite queue row).
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    store.coordinationHandle.importLegacyReceipt(
      requestId,
      "",
      `${JSON.stringify({ requestId, status: "delivered", deliveredAt: "2026-08-18T00:00:00.000Z" })}\n`,
    );
    const present = await runCli(["status", "--request", requestId, "--json"], "", home);
    assert.equal(present.code, 0);
    assert.equal(JSON.parse(present.stdout).receipt.status, "delivered");
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function seedWorkflowRecord(store: import("../src/bridge-store.js").BridgeStore, id: string, phase: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const now = "2026-08-18T00:00:00.000Z";
  const record = {
    schemaVersion: 1,
    id,
    dshSessionId: "session-ops",
    cwd: "C:\\ops",
    task: "Ops task",
    mode: "planned",
    phase,
    origin: "codex_bridge",
    reviewCycles: overrides.reviewCycles ?? 1,
    noChangeReviewRounds: 0,
    createdAt: now,
    updatedAt: now,
    planMarkdown: "<proposed_plan>\nDo\n</proposed_plan>",
    assumptions: [],
    questions: [],
    ...overrides,
  };
  store.coordinationHandle.saveWorkflow(id, JSON.stringify(record));
}

test("workflows lists and filters workflow summaries without payloads", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    await seedWorkflowRecord(store, "wf-ops-1", "executing", { reviewCycles: 2, dshSessionId: "session-a", cwd: "C:\\ops" });
    await seedWorkflowRecord(store, "wf-ops-2", "passed", { dshSessionId: "session-b", cwd: "D:\\done" });

    const all = await runCli(["workflows", "--json"], "", home);
    assert.equal(all.code, 0, all.stderr);
    const parsed = JSON.parse(all.stdout) as Array<{ id: string; phase: string; reviewCycles: number; dshSessionId?: string }>;
    assert.equal(parsed.length, 2);
    assert.equal(parsed.every((entry) => !("planMarkdown" in entry) && !("task" in entry)), true, "no payload fields leaked");

    const filtered = await runCli(["workflows", "--phase", "passed", "--json"], "", home);
    const only = JSON.parse(filtered.stdout) as Array<{ id: string }>;
    assert.deepEqual(only.map((entry) => entry.id), ["wf-ops-2"]);

    const bySession = await runCli(["workflows", "--dsh-session", "session-a", "--json"], "", home);
    assert.deepEqual((JSON.parse(bySession.stdout) as Array<{ id: string }>).map((entry) => entry.id), ["wf-ops-1"]);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("show reports one workflow's stage/submission/review/evidence summary", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    await seedWorkflowRecord(store, "wf-show", "fixing", {
      codexThreadId: "codex-source-task",
      reviewerThreadId: "codex-reviewer-task",
      reviewerTurnId: "codex-reviewer-turn",
      submissionId: "sub-1",
      submissionState: "received",
      submissionError: "boom",
      latestReview: { verdict: "changes_requested", findings: [{ blocking: true }, { blocking: false }], testGaps: [], summary: "nits" },
      latestReviewEvidence: { kind: "files", fingerprint: "abc", insufficient: false, diffBytes: 42 },
    });

    const result = await runCli(["show", "--workflow", "wf-show", "--json"], "", home);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed.pluginVersion, "1.0.6");
    assert.equal(parsed.phase, "fixing");
    assert.equal(parsed.originatingCodexTaskId, "codex-source-task");
    assert.equal(parsed.reviewerCodexTaskId, "codex-reviewer-task");
    assert.equal(parsed.reviewerTurnId, "codex-reviewer-turn");
    assert.equal((parsed.latestReview as Record<string, unknown>).findings, 2);
    assert.equal((parsed.latestReview as Record<string, unknown>).blockingFindings, 1);
    assert.equal((parsed.evidence as Record<string, unknown>).fingerprint, true);
    assert.equal((parsed.submission as Record<string, unknown>).error, "boom");
    assert.ok(!JSON.stringify(parsed).includes("planMarkdown"), "show must not dump the plan");

    const missing = await runCli(["show", "--workflow", "nope", "--json"], "", home);
    assert.notEqual(missing.code, 0);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("queue lists rows without payloads and filters by status", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    await store.enqueue({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: "C:\\ops" },
      task: "SECRET_PAYLOAD_DO_NOT_LEAK",
      planMarkdown: "<proposed_plan>\nX\n</proposed_plan>",
      assumptions: [],
    });

    const all = await runCli(["queue", "--json"], "", home);
    assert.equal(all.code, 0, all.stderr);
    const parsed = JSON.parse(all.stdout) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.status, "inbox");
    assert.ok(!JSON.stringify(all.stdout).includes("SECRET_PAYLOAD_DO_NOT_LEAK"), "queue must not leak command payloads");

    const filtered = await runCli(["queue", "--status", "inbox", "--json"], "", home);
    assert.equal((JSON.parse(filtered.stdout) as unknown[]).length, 1);
    const empty = await runCli(["queue", "--status", "done", "--json"], "", home);
    assert.deepEqual(JSON.parse(empty.stdout), []);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("retry requeues dead-letter/failed requests, is idempotent, and rejects live claims", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    const requestId = newRequestId();
    await store.enqueue({
      version: 1,
      kind: "dispatch_plan",
      requestId,
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: "C:\\ops" },
      task: "T",
      planMarkdown: "<proposed_plan>\nX\n</proposed_plan>",
      assumptions: [],
    });
    const claim = await store.claimNext("ops-tester");
    assert.ok(claim && claim.requestId === requestId);
    // While processing, retry must refuse (a waiter may have side effects).
    const refused = await runCli(["retry", "--request", requestId, "--json"], "", home);
    assert.notEqual(refused.code, 0, "retry refuses a live processing claim");
    assert.match(refused.stderr, /cannot requeue request in status processing/);

    await store.deadLetter(claim, "boom");
    const dead = store.coordinationHandle.queueRow(requestId);
    assert.equal(dead?.status, "dead-letter");

    const requeued = await runCli(["retry", "--request", requestId, "--json"], "", home);
    assert.equal(requeued.code, 0, requeued.stderr);
    assert.equal((JSON.parse(requeued.stdout) as { changed: boolean; from: string }).changed, true);
    assert.equal(store.coordinationHandle.queueRow(requestId)?.status, "retry");

    // Idempotent: a second retry is a no-op success.
    const again = await runCli(["retry", "--request", requestId, "--json"], "", home);
    assert.equal(again.code, 0, again.stderr);
    assert.equal((JSON.parse(again.stdout) as { changed: boolean; from: string }).changed, false);

    const missing = await runCli(["retry", "--request", newRequestId(), "--json"], "", home);
    assert.notEqual(missing.code, 0);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("prune is dry-run by default, applies only terminal data, and cleans up", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    // A terminal done receipt (older than 0 retention) that MUST be prunable.
    const doneId = newRequestId();
    await store.enqueue({
      version: 1,
      kind: "dispatch_plan",
      requestId: doneId,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: "C:\\ops" },
      task: "T",
      planMarkdown: "<proposed_plan>\nX\n</proposed_plan>",
      assumptions: [],
    });
    const doneClaim = await store.claimNext("ops-prune");
    assert.ok(doneClaim && doneClaim.requestId === doneId);
    await store.ack(doneClaim, {
      status: "delivered",
      requestId: doneId,
      deliveredAt: new Date(Date.now() - 10_000).toISOString(),
    });

    // An old enqueue that completed only now must not be pruned by a five-second
    // retention window: retention is measured from terminal delivery, not queue creation.
    const freshDoneId = newRequestId();
    await store.enqueue({
      version: 1,
      kind: "dispatch_plan",
      requestId: freshDoneId,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: "C:\\ops" },
      task: "T2",
      planMarkdown: "<proposed_plan>\nY\n</proposed_plan>",
      assumptions: [],
    });
    const freshClaim = await store.claimNext("ops-prune-fresh");
    assert.ok(freshClaim && freshClaim.requestId === freshDoneId);
    await store.ack(freshClaim, { status: "delivered", requestId: freshDoneId });
    const retained = await store.pruneCandidates(5_000);
    assert.deepEqual(retained.requests.map((row) => row.requestId), [doneId]);

    // A terminal passed workflow and an ACTIVE executing workflow.
    await seedWorkflowRecord(store, "wf-old-passed", "passed");
    await seedWorkflowRecord(store, "wf-active", "executing", { dshSessionId: "session-live" });

    const dryRun = await runCli(["prune", "--older-than", "0", "--json"], "", home);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const preview = JSON.parse(dryRun.stdout) as { dryRun: boolean; requests: Array<{ requestId: string }>; workflows: Array<{ id: string; phase: string }> };
    assert.equal(preview.dryRun, true, "prune is dry-run by default");
    assert.deepEqual(preview.requests.map((row) => row.requestId), [doneId, freshDoneId]);
    assert.deepEqual(preview.workflows.map((workflow) => workflow.phase), ["passed"]);
    assert.ok(!preview.workflows.some((workflow) => workflow.id === "wf-active"), "active workflow never a candidate");
    // Dry-run must not delete anything.
    assert.equal(store.coordinationHandle.queueRow(doneId)?.status, "done");

    const commit = await runCli(["prune", "--older-than", "0", "--commit", "--json"], "", home);
    assert.equal(commit.code, 0, commit.stderr);
    const committed = JSON.parse(commit.stdout) as { dryRun: boolean; removedRequests: number; removedWorkflows: number };
    assert.equal(committed.dryRun, false);
    assert.equal(committed.removedRequests, 2);
    assert.equal(committed.removedWorkflows, 1);
    assert.equal(store.coordinationHandle.queueRow(doneId), undefined);
    assert.equal(store.coordinationHandle.queueRow(freshDoneId), undefined);
    assert.equal(store.coordinationHandle.loadWorkflow("wf-old-passed"), undefined);
    assert.ok(store.coordinationHandle.loadWorkflow("wf-active"), "active workflow survives prune");
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("prune apply skips queue and workflow rows changed after preview", async () => {
  const home = await makeHome();
  let store: import("../src/bridge-store.js").BridgeStore | undefined;
  try {
    const { BridgeStore } = await import("../src/bridge-store.js");
    store = new BridgeStore(join(home, "storages", "dsh-codex-workflow"));
    await store.init();
    const now = Date.now();
    const old = now - 10_000;
    const requestId = newRequestId();
    await store.enqueue({
      version: 1,
      kind: "dispatch_plan",
      requestId,
      createdAt: new Date(old).toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: "C:\\ops" },
      task: "T",
      planMarkdown: "<proposed_plan>\nX\n</proposed_plan>",
      assumptions: [],
    });
    const claim = await store.claimNext("ops-prune-race");
    assert.ok(claim);
    await store.ack(claim, { status: "delivered", requestId, deliveredAt: new Date(old).toISOString() });

    await seedWorkflowRecord(store, "wf-prune-race", "passed");
    store.coordinationHandle.db.prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run(old, "wf-prune-race");
    const candidates = store.coordinationHandle.pruneCandidates(5_000, now);
    assert.deepEqual(candidates.requests.map((row) => row.requestId), [requestId]);
    assert.deepEqual(candidates.workflows.map((row) => row.id), ["wf-prune-race"]);

    const freshReceipt = JSON.stringify({ requestId, status: "delivered", deliveredAt: new Date(now).toISOString() });
    store.coordinationHandle.db.prepare("UPDATE queue SET receipt_json = ? WHERE request_id = ?").run(freshReceipt, requestId);
    await seedWorkflowRecord(store, "wf-prune-race", "executing", { submissionState: "sending" });

    const applied = store.coordinationHandle.pruneApply(candidates.requests, candidates.workflows, 5_000, now);
    assert.deepEqual(applied, { removedRequests: 0, removedWorkflows: 0 });
    assert.ok(store.coordinationHandle.queueRow(requestId), "freshened receipt survives stale preview");
    assert.equal(JSON.parse(store.coordinationHandle.loadWorkflow("wf-prune-race")!.recordJson).phase, "executing");
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("help lists the operations commands", async () => {
  const home = await makeHome();
  try {
    const result = await runCli(["help"], "", home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /workflows/);
    assert.match(result.stdout, /retry/);
    assert.match(result.stdout, /prune/);
    assert.match(result.stdout, /queue/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

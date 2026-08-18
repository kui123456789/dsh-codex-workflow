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

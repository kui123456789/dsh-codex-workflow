import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { CodexNoVerdictError } from "../src/codex-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

test("forks the originating task once and reuses the same read-only Reviewer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    let reviewerThreadId = "";
    const started: Array<{ threadId: string; turnId: string }> = [];
    const request = {
      workflowId: "workflow-1",
      submissionId: "submission-1",
      codexThreadId: "origin-task-1",
      cwd: directory,
      prompt: "Review this implementation.",
      reviewerName: "DSH Reviewer: workflow-1",
      effort: "high" as const,
      onThread: (threadId: string) => { reviewerThreadId = threadId; },
      onStarted: (entry: { threadId: string; turnId: string }) => { started.push(entry); },
    };
    const first = await callback.send(request);
    assert.deepEqual(first, { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });
    assert.ok(reviewerThreadId);
    assert.notEqual(reviewerThreadId, request.codexThreadId);
    assert.equal(started[0]?.threadId, reviewerThreadId);

    const second = await callback.send({
      ...request,
      submissionId: "submission-2",
      reviewerThreadId,
      onThread: () => { throw new Error("an existing reviewer must not be forked again"); },
    });
    assert.equal(second.kind, "verdict");

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const forks = calls.filter((call) => call.method === "thread/fork");
    const resumes = calls.filter((call) => call.method === "thread/resume");
    const turns = calls.filter((call) => call.method === "turn/start");
    const settings = calls.find((call) => call.method === "thread/settings/update");
    const name = calls.find((call) => call.method === "thread/name/set");
    assert.equal(forks.length, 1);
    assert.equal(forks[0]?.params.threadId, request.codexThreadId);
    assert.equal(forks[0]?.params.cwd, directory);
    assert.deepEqual(forks[0]?.params.runtimeWorkspaceRoots, [directory]);
    assert.equal(forks[0]?.params.approvalPolicy, "never");
    assert.equal(forks[0]?.params.sandbox, "read-only");
    assert.equal(forks[0]?.params.ephemeral, false);
    assert.equal(settings?.params.threadId, reviewerThreadId);
    assert.deepEqual(settings?.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(name?.params.name, request.reviewerName);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.params.threadId, reviewerThreadId);
    assert.equal(turns.length, 2);
    assert.ok(turns.every((call) => call.params.threadId === reviewerThreadId));
    assert.ok(turns.every((call) => call.params.outputSchema?.properties?.verdict));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid forked Reviewer verdict is terminal", async () => {
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_REVIEW_VERDICT: "not-json" },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    await assert.rejects(callback.send({
      workflowId: "workflow-invalid",
      submissionId: "submission-invalid",
      codexThreadId: "origin-invalid",
      cwd: process.cwd(),
      prompt: "Review it.",
    }), CodexNoVerdictError);
  } finally {
    await callback.stop();
    await codex.stop();
  }
});

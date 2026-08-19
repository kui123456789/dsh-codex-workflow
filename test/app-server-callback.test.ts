import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { CodexInvalidThreadError, CodexNoVerdictError } from "../src/codex-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

async function waitForValue<T>(producer: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = producer();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for value");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("validates the source read-only and creates one fresh Reviewer, then reuses it", async () => {
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
      model: "reviewer-model",
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
      onThread: () => { throw new Error("an existing Reviewer must not be created again"); },
    });
    assert.equal(second.kind, "verdict");

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const reads = calls.filter((call) => call.method === "thread/read");
    const starts = calls.filter((call) => call.method === "thread/start");
    const forks = calls.filter((call) => call.method === "thread/fork");
    const resumes = calls.filter((call) => call.method === "thread/resume");
    const turns = calls.filter((call) => call.method === "turn/start");
    const settings = calls.find((call) => call.method === "thread/settings/update");
    const name = calls.find((call) => call.method === "thread/name/set");

    // First review: exactly one read-only source validation + one fresh start,
    // and NOT a single fork anywhere in the whole run.
    assert.equal(reads.length, 1);
    assert.equal(reads[0]?.params.threadId, request.codexThreadId);
    assert.equal(reads[0]?.params.includeTurns, false, "source validation must not load turns");
    assert.equal(starts.length, 1);
    assert.equal(forks.length, 0, "reviewers are created with thread/start, never forked");

    // The fresh Reviewer inherits the cwd, name, model, and read-only/durable
    // settings of the workflow.
    assert.equal(starts[0]?.params.cwd, directory);
    assert.deepEqual(starts[0]?.params.runtimeWorkspaceRoots, [directory]);
    assert.equal(starts[0]?.params.approvalPolicy, "never");
    assert.equal(starts[0]?.params.sandbox, "read-only");
    assert.equal(starts[0]?.params.ephemeral, false);
    assert.equal(starts[0]?.params.model, "reviewer-model");
    assert.equal(settings?.params.threadId, reviewerThreadId);
    assert.equal(settings?.params.cwd, directory);
    assert.equal(settings?.params.approvalPolicy, "never");
    assert.deepEqual(settings?.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(name?.params.name, request.reviewerName);

    // The source task id is never resumed or turned; only the persisted
    // Reviewer is resumed on later cycles.
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.params.threadId, reviewerThreadId);
    assert.ok(!resumes.some((call) => call.params.threadId === request.codexThreadId));
    assert.equal(turns.length, 2);
    assert.ok(turns.every((call) => call.params.threadId === reviewerThreadId));
    assert.ok(turns.every((call) => call.params.outputSchema?.properties?.verdict));
    assert.ok(turns.every((call) => call.params.sandboxPolicy.type === "readOnly" && call.params.sandboxPolicy.networkAccess === false));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing source task is a terminal invalid thread", async () => {
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_MISSING_SOURCE: "1" },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    await assert.rejects(callback.send({
      workflowId: "workflow-missing",
      submissionId: "submission-missing",
      codexThreadId: "origin-that-never-existed",
      cwd: process.cwd(),
      prompt: "Review it.",
    }), CodexInvalidThreadError);
  } finally {
    await callback.stop();
    await codex.stop();
  }
});

test("an active writer on the source task never makes the review busy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-writer-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      FAKE_CODEX_SOURCE_THREAD: "origin-task-writer",
      FAKE_CODEX_SOURCE_ACTIVE_WRITER: "1",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    let reviewerThreadId = "";
    const result = await callback.send({
      workflowId: "workflow-writer",
      submissionId: "submission-writer",
      codexThreadId: "origin-task-writer",
      cwd: directory,
      prompt: "Review the implementation.",
      onThread: (threadId: string) => { reviewerThreadId = threadId; },
    });
    assert.equal(result.kind, "verdict");
    assert.ok(reviewerThreadId);

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    // The read-only source validation and the fresh Reviewer never touch the
    // source's writer, so the simulated active writer cannot surface as busy.
    assert.deepEqual(calls.filter((call) => call.method === "thread/read").map((call) => call.method), ["thread/read"]);
    assert.equal(calls.find((call) => call.method === "thread/read")?.params.threadId, "origin-task-writer");
    assert.equal(calls.filter((call) => call.method === "thread/resume").length, 0);
    assert.ok(calls.some((call) => call.method === "thread/start"));
    assert.ok(calls.some((call) => call.method === "turn/start"));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing reviewerThreadId resumes only that Reviewer (old-record compat)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-resume-"));
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
    const request = {
      workflowId: "workflow-old",
      submissionId: "submission-old",
      codexThreadId: "origin-task-old",
      cwd: directory,
      prompt: "Review again.",
      reviewerThreadId: "reviewer-from-a-previous-version",
    };
    const result = await callback.send(request);
    assert.equal(result.kind, "verdict");

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    assert.equal(calls.filter((call) => call.method === "thread/read").length, 0, "a persisted Reviewer is resumed, the source is never re-validated");
    assert.equal(calls.filter((call) => call.method === "thread/start").length, 0, "a persisted Reviewer is never recreated");
    const resumes = calls.filter((call) => call.method === "thread/resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.params.threadId, "reviewer-from-a-previous-version");
    assert.equal(calls.filter((call) => call.method === "turn/start")[0]?.params.threadId, "reviewer-from-a-previous-version");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel interrupts only the Reviewer turn, never the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-cancel-"));
  const marker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_INTERRUPT_MARKER: marker },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  const controller = new AbortController();
  let started: { threadId: string; turnId: string } | undefined;
  const request = {
    workflowId: "workflow-cancel",
    submissionId: "submission-cancel",
    codexThreadId: "origin-task-cancel",
    cwd: directory,
    prompt: "HANG",
    onStarted: (entry: { threadId: string; turnId: string }) => { started = entry; },
  };
  try {
    const sending = callback.send(request, controller.signal);
    await waitForValue(() => started);
    assert.notEqual(started!.threadId, request.codexThreadId, "the active turn must be the Reviewer, not the source");
    // Cancelling the workflow interrupts ONLY the running Reviewer turn.
    callback.cancel(request.workflowId);
    // Unblock the hanging turn so teardown and the rejection settle.
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(sending);
    await waitForFile(marker);
    const [thread, turn] = (await readFile(marker, "utf8")).trim().split(":");
    assert.equal(thread, started!.threadId, "interrupt must target the Reviewer turn");
    assert.ok(turn);
    assert.notEqual(thread, request.codexThreadId, "the source task must never be interrupted");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid Reviewer verdict is terminal", async () => {
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

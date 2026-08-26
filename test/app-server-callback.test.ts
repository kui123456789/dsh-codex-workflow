import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "../src/codex-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

async function waitForValue<T>(producer: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = producer();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for value");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFileText(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.length > 0) return text;
    } catch {
      // The writer may not have created the marker yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for content in ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");

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

    // Every Reviewer turn is pinned to the non-collaborative "default" mode
    // with the silent single-verdict developer instructions, both on the first
    // review and on the resumed re-review.
    for (const call of turns) {
      assert.equal(call.params.collaborationMode?.mode, "default");
      const instructions = call.params.collaborationMode?.settings?.developer_instructions;
      assert.equal(typeof instructions, "string");
      assert.match(instructions, /ONLY one final message|no commentary/i);
      assert.match(instructions, /do NOT/i);
    }

    // The Reviewer thread is released exactly once per review cycle (one per
    // send) and the source task is never unsubscribed.
    assert.equal(unsubs.length, 2);
    assert.ok(unsubs.every((call) => call.params.threadId === reviewerThreadId));
    assert.ok(!unsubs.some((call) => call.params.threadId === request.codexThreadId));
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
  const callsFile = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_INTERRUPT_MARKER: marker,
      FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile,
    },
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
    const [thread, turn] = (await waitForFileText(marker)).trim().split(":");
    assert.equal(thread, started!.threadId, "interrupt must target the Reviewer turn");
    assert.ok(turn);
    assert.notEqual(thread, request.codexThreadId, "the source task must never be interrupted");
    // Cancellation still releases the Reviewer thread exactly once, and the
    // source task is never unsubscribed.
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 1, "a cancelled review releases its thread exactly once");
    assert.equal(unsubs[0]?.params.threadId, started!.threadId);
    assert.ok(!unsubs.some((call) => call.params.threadId === request.codexThreadId));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid Reviewer verdict is terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-invalid-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      FAKE_CODEX_REVIEW_VERDICT: "not-json",
    },
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
    // Terminal failure still releases the Reviewer thread exactly once and
    // never touches the source task.
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 1, "terminal failure must unsubscribe exactly once");
    assert.ok(!unsubs.some((call) => call.params.threadId === "origin-invalid"), "the source task is never unsubscribed");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provisional pass messages are never applied; only the final changes_requested verdict wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-provisional-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      FAKE_CODEX_PROVISIONAL_SEQ: JSON.stringify([
        JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "provisional 1" }),
        JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "provisional 2" }),
      ]),
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({
        verdict: "changes_requested",
        findings: [{ severity: "high", blocking: true, title: "final", body: "b", file: null, line: null }],
        testGaps: [],
        summary: "final changes_requested",
      }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const result = await callback.send({
      workflowId: "workflow-prov",
      submissionId: "submission-prov",
      codexThreadId: "origin-prov",
      cwd: directory,
      prompt: "Review.",
    });
    assert.deepEqual(result, {
      kind: "verdict",
      verdict: {
        verdict: "changes_requested",
        findings: [{ severity: "high", blocking: true, title: "final", body: "b" }],
        testGaps: [],
        summary: "final changes_requested",
      },
    });
    // The changes_requested path still releases the Reviewer thread exactly once.
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 1, "a changes_requested verdict releases its thread exactly once");
    assert.ok(!unsubs.some((call) => call.params.threadId === "origin-prov"));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provisional changes_requested is ignored when the final verdict is pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-provisional-reverse-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_PROVISIONAL_SEQ: JSON.stringify([
        JSON.stringify({
          verdict: "changes_requested",
          findings: [{ severity: "high", blocking: true, title: "early", body: "b", file: null, line: null }],
          testGaps: [],
          summary: "provisional changes",
        }),
      ]),
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "final pass" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const result = await callback.send({
      workflowId: "workflow-prov2",
      submissionId: "submission-prov2",
      codexThreadId: "origin-prov2",
      cwd: directory,
      prompt: "Review.",
    });
    assert.deepEqual(result, { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "final pass" } });
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted turn that already streamed a complete pass JSON never produces a verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-interrupted-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_PROVISIONAL_SEQ: JSON.stringify([
        JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "streamed before interrupt" }),
      ]),
      FAKE_CODEX_TURN_STATUS: "interrupted",
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const result = await callback.send({
      workflowId: "workflow-int",
      submissionId: "submission-int",
      codexThreadId: "origin-int",
      cwd: directory,
      prompt: "Review.",
    });
    assert.equal(result.kind, "retryable_busy");
    assert.match(result.reason, /interrupted/, "the interrupt cause must be attributed, not lumped as generic busy");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed turn that already streamed a complete pass JSON never produces a verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-failed-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_PROVISIONAL_SEQ: JSON.stringify([
        JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "streamed before failure" }),
      ]),
      FAKE_CODEX_TURN_STATUS: "failed",
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    await assert.rejects(callback.send({
      workflowId: "workflow-failed",
      submissionId: "submission-failed",
      codexThreadId: "origin-failed",
      cwd: directory,
      prompt: "Review.",
    }), CodexCallbackProcessError);
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh Reviewer setup failures after thread/start still unsubscribe the new thread once", async () => {
  for (const mode of ["settings", "name", "onThread"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `dsh-callback-setup-${mode}-`));
    const marker = join(directory, "calls.jsonl");
    const env: Record<string, string> = {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
    };
    if (mode === "settings") env.FAKE_CODEX_FAIL_SETTINGS = "1";
    if (mode === "name") env.FAKE_CODEX_FAIL_NAME = "1";
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 5_000,
      idleProcessMs: 0,
      env,
    });
    const callback = new AppServerCodexCallbackDispatcher(codex);
    try {
      const base = {
        workflowId: `workflow-${mode}`,
        submissionId: `submission-${mode}`,
        codexThreadId: `origin-${mode}`,
        cwd: directory,
        prompt: "Review.",
      };
      if (mode === "onThread") {
        await assert.rejects(callback.send({
          ...base,
          onThread: async () => { throw new Error("ownership persistence failed"); },
        }), /ownership persistence failed/);
      } else {
        await assert.rejects(callback.send(base), CodexCallbackProcessError);
      }
      const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
        method: string;
        params: Record<string, any>;
      });
      assert.equal(calls.filter((call) => call.method === "thread/start").length, 1, `${mode}: one fresh thread was created`);
      const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
      assert.equal(unsubs.length, 1, `${mode}: the half-configured fresh Reviewer must be unsubscribed exactly once`);
      assert.ok(!unsubs.some((call) => call.params.threadId === `origin-${mode}`), `${mode}: the source task is never unsubscribed`);
    } finally {
      await callback.stop();
      await codex.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("two concurrent reviewers on separate threads release each thread independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-concurrent-"));
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
    const sendFor = (workflowId: string, submissionId: string, codexThreadId: string, cwd: string) =>
      callback.send({ workflowId, submissionId, codexThreadId, cwd, prompt: "Review." });
    const [a, b] = await Promise.all([
      sendFor("wf-a", "sub-a", "origin-a", directory),
      sendFor("wf-b", "sub-b", "origin-b", directory),
    ]);
    assert.equal(a.kind, "verdict");
    assert.equal(b.kind, "verdict");

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const starts = calls.filter((call) => call.method === "thread/start");
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    // Two fresh Reviewer threads, each released exactly once; the source tasks
    // are never subscribed or unsubscribed.
    assert.equal(starts.length, 2);
    assert.equal(unsubs.length, 2);
    const unsubThreads = new Set(unsubs.map((call) => call.params.threadId));
    assert.equal(unsubThreads.size, 2);
    assert.ok(!unsubs.some((call) => call.params.threadId.startsWith("origin-")));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the silent Reviewer pins the App Server's isDefault model and its defaultReasoningEffort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-default-model-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      FAKE_CODEX_DEFAULT_MODEL: "default-model",
      FAKE_CODEX_DEFAULT_EFFORT: "medium",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    // No reviewerModel and no effort: the server's isDefault model wins over the
    // list-first entry, and the model's defaultReasoningEffort is used instead
    // of a fixed null.
    await callback.send({ workflowId: "wf-default", submissionId: "s-default", codexThreadId: "origin-default", cwd: directory, prompt: "Review." });
    // A second workflow with an explicit effort: the explicit effort wins.
    await callback.send({ workflowId: "wf-eff", submissionId: "s-eff", codexThreadId: "origin-eff", cwd: directory, prompt: "Review.", effort: "ultra" });

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 2);
    const [first, second] = turns.map((call) => call.params.collaborationMode);
    // isDefault selection: "default-model" (marked isDefault), NOT "first-model".
    assert.equal(first.settings.model, "default-model");
    assert.equal(first.settings.reasoning_effort, "medium");
    assert.match(first.settings.developer_instructions, /no commentary/i);
    // Explicit effort overrides the model default; the model stays the default.
    assert.equal(second.settings.model, "default-model");
    assert.equal(second.settings.reasoning_effort, "ultra");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed operation on a shared Reviewer never releases another active review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-refcount-"));
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
    // A holds the ONLY reference on the shared Reviewer thread and runs a turn.
    const senderA = callback.send({
      workflowId: "wf-a",
      submissionId: "sub-a",
      codexThreadId: "origin-a",
      reviewerThreadId: "shared-reviewer",
      cwd: directory,
      prompt: "Review.",
    });
    // B targets the SAME thread but aborts before it ever acquires a reference.
    const abortB = new AbortController();
    abortB.abort(new Error("aborted before its turn"));
    const senderB = callback.send({
      workflowId: "wf-b",
      submissionId: "sub-b",
      codexThreadId: "origin-b",
      reviewerThreadId: "shared-reviewer",
      cwd: directory,
      prompt: "Review.",
    }, abortB.signal);

    const [a, b] = await Promise.allSettled([senderA, senderB]);
    assert.equal(a.status, "fulfilled", "the active review must complete");
    assert.equal((a as PromiseFulfilledResult<any>).value.kind, "verdict");
    assert.equal(b.status, "rejected", "the aborted operation must fail");
    assert.match(String((b as PromiseRejectedResult).reason), /aborted/);

    // Exactly ONE unsubscribe, from A's turn completing. B never decremented
    // A's live reference, so the shared thread was not released under the
    // active turn.
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 1, "a failed pre-turn operation must not release another thread's live turn");
    assert.equal(unsubs[0]?.params.threadId, "shared-reviewer");
    assert.ok(!unsubs.some((call) => call.params.threadId === "origin-a" || call.params.threadId === "origin-b"));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

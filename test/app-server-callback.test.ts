import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "../src/codex-callback.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

test("validates and reuses the source Codex task for every background review", async () => {
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    let reviewerThreadId = "";
    const started: Array<{ threadId: string; turnId: string }> = [];
    const ephemeralStarted: Array<{ threadId: string; turnId: string }> = [];
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
      onEphemeralStarted: (entry: { threadId: string; turnId: string }) => { ephemeralStarted.push(entry); },
    };
    const first = await callback.send(request);
    assert.deepEqual(first, { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });
    assert.equal(reviewerThreadId, request.codexThreadId);
    // request.onStarted fires ONLY for the visible Reviewer turn — the
    // ephemeral conversion fork reports through onEphemeralStarted, so the
    // persisted Reviewer ids are never overwritten by a fork id.
    assert.equal(started.length, 1);
    assert.equal(started[0]?.threadId, reviewerThreadId);
    assert.equal(ephemeralStarted.length, 1);
    assert.notEqual(ephemeralStarted[0]?.threadId, reviewerThreadId, "the fork is a separate ephemeral thread");

    const second = await callback.send({
      ...request,
      submissionId: "submission-2",
      reviewerThreadId,
      onThread: () => { throw new Error("the already-bound source task must not be registered again"); },
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

    // First review validates the source read-only, then resumes that SAME task.
    // No second durable Codex task is created or renamed.
    const sourceReads = reads.filter((call) => call.params.includeTurns !== true);
    assert.equal(sourceReads.length, 1);
    assert.equal(sourceReads[0]?.params.threadId, request.codexThreadId);
    assert.equal(sourceReads[0]?.params.includeTurns, false, "source validation must not load turns");
    assert.equal(starts.length, 0, "review never creates another visible Codex task");
    assert.equal(settings, undefined, "the callback does not replace the source task settings");
    assert.equal(name, undefined, "the source task keeps its original name");

    // One ephemeral conversion fork per review cycle, always created from the
    // SAME persistent source task.
    assert.equal(forks.length, 2, "one ephemeral conversion fork per review cycle");
    assert.ok(forks.every((call) => call.params.ephemeral === true), "conversion forks are always ephemeral");
    assert.ok(forks.every((call) => call.params.threadId === request.codexThreadId), "forks are created from the shared workflow task");
    assert.ok(forks.every((call) => call.params.cwd === directory), "forks bind the workflow cwd");

    assert.equal(resumes.length, 2, "each review resumes the shared task before writing its visible turn");
    assert.ok(resumes.every((call) => call.params.threadId === request.codexThreadId));

    // FOUR turns per two cycles: two VISIBLE review turns (no outputSchema,
    // safe settings) and two EPHEMERAL conversion turns (with the schema,
    // effort low, same model, safe settings).
    assert.equal(turns.length, 4);
    const visible = turns.filter((call) => !call.params.outputSchema);
    const conversions = turns.filter((call) => call.params.outputSchema);
    assert.equal(visible.length, 2, "the persistent Reviewer turns never carry an outputSchema");
    assert.equal(conversions.length, 2, "only the ephemeral conversion turns carry the schema");
    assert.ok(visible.every((call) => call.params.threadId === reviewerThreadId));
    assert.ok(visible.every((call) => call.params.sandboxPolicy.type === "readOnly" && call.params.sandboxPolicy.networkAccess === false));
    assert.ok(visible.every((call) => call.params.approvalPolicy === "never"));
    for (const call of conversions) {
      assert.notEqual(call.params.threadId, reviewerThreadId, "conversion turns run on the FORK thread");
      assert.ok(call.params.outputSchema?.properties?.verdict, "conversions carry the review schema");
      assert.equal(call.params.model, "reviewer-model", "the fork reuses the SAME model as the source task");
      assert.equal(call.params.effort, "low", "conversion effort is fixed at low");
      assert.equal(call.params.sandboxPolicy.type, "readOnly");
      assert.equal(call.params.sandboxPolicy.networkAccess, false);
      assert.equal(call.params.approvalPolicy, "never");
    }

    // Every Reviewer turn (visible and conversion) is pinned to the
    // non-collaborative "default" mode with protocol developer instructions.
    for (const call of turns) {
      assert.equal(call.params.collaborationMode?.mode, "default");
      const instructions = call.params.collaborationMode?.settings?.developer_instructions;
      assert.equal(typeof instructions, "string");
      assert.match(instructions, /no commentary/i);
      assert.match(instructions, /do NOT/i);
    }
    // Conversion instructions demand exactly one schema-conforming JSON object.
    for (const call of conversions) {
      assert.match(call.params.collaborationMode?.settings?.developer_instructions, /JSON object conforming to the enforced output schema/);
    }

    // The plugin releases its App Server subscription after each review; this
    // does not delete or hide the persistent Codex task. Each ephemeral fork is
    // also released exactly once.
    assert.equal(unsubs.length, 4, "2 shared-task releases + 2 fork releases");
    assert.equal(unsubs.filter((call) => call.params.threadId === request.codexThreadId).length, 2);
    const forkUnsubs = unsubs.filter((call) => call.params.threadId !== request.codexThreadId);
    assert.equal(forkUnsubs.length, 2, "each ephemeral fork is released exactly once");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the background path rewrites a display-violating visible review on the SAME Reviewer before conversion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-display-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      // Visible review 1 = English one-liner (violates a Chinese task's
      // display contract), visible review 2 = the display-rewrite reply.
      FAKE_CODEX_PLAIN_REVIEW_TURNS: JSON.stringify([
        "The uncommitted implementation strips sync and all 11 tests pass.",
        "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试全部通过",
      ]),
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    let reviewerThreadId = "";
    const started: Array<{ threadId: string; turnId: string }> = [];
    const result = await callback.send({
      workflowId: "workflow-display",
      submissionId: "submission-display",
      codexThreadId: "origin-task-display",
      cwd: directory,
      prompt: "Review this implementation.",
      task: "实现用户登录功能",
      planMarkdown: "<proposed_plan>\n实现登录\n</proposed_plan>",
      model: "reviewer-model",
      effort: "high",
      onThread: (threadId) => { reviewerThreadId = threadId; },
      onStarted: (entry) => { started.push(entry); },
    });
    assert.deepEqual(result, { kind: "verdict", verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" } });

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const starts = calls.filter((call) => call.method === "thread/start");
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(starts.length, 0, "the review reuses the source task instead of creating another visible task");
    const visible = turns.filter((call) => !call.params.outputSchema);
    const conversions = turns.filter((call) => call.params.outputSchema);
    // Visible review turn + one display-rewrite turn on the SAME thread, then
    // the ephemeral conversion fork.
    assert.equal(visible.length, 2, "visible review + display rewrite turn");
    assert.equal(conversions.length, 1);
    assert.ok(visible.every((call) => call.params.threadId === reviewerThreadId), "the rewrite stays on the SAME Reviewer task");
    // The rewrite turn is visible (no schema), low effort, same model, silent
    // and only re-presents the raw review in the task's language.
    const rewrite = visible[1]!;
    assert.equal(rewrite.params.outputSchema, undefined, "the rewrite turn never carries the JSON schema");
    assert.equal(rewrite.params.effort, "low", "the rewrite runs at low effort");
    assert.equal(rewrite.params.model, "reviewer-model", "the rewrite reuses the same model");
    assert.match(rewrite.params.input?.[0]?.text ?? "", /display contract/, "the rewrite prompt demands the display contract");
    assert.match(rewrite.params.input?.[0]?.text ?? "", /实现用户登录功能/, "the rewrite prompt carries the original task for language");
    assert.match(rewrite.params.input?.[0]?.text ?? "", /all 11 tests pass/, "the raw violating review is embedded verbatim");
    assert.match(rewrite.params.input?.[0]?.text ?? "", /strips sync/, "the raw violating review is embedded verbatim");
    assert.equal(rewrite.params.collaborationMode?.mode, "default");
    // The conversion consumes the AUTHORITATIVE corrected review.
    const conversion = conversions[0]!;
    assert.match(conversion.params.input?.[0]?.text ?? "", /实现符合计划，测试全部通过/, "the authoritative rewrite text drives the conversion");
    assert.ok(!/strips sync/.test(conversion.params.input?.[0]?.text ?? ""), "the English one-liner never reaches the conversion");
    // The visible-turn ownership contract covers the rewrite too (same thread).
    assert.equal(started.length, 2, "onStarted fires for the visible review AND the rewrite turn");
    assert.ok(started.every((entry) => entry.threadId === reviewerThreadId));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a background review that still violates the display contract after the rewrite is retryable, never a verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-display-bad-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      // Visible review 1 AND the display-rewrite turn both stay
      // display-violating (English one-liners, Chinese task).
      FAKE_CODEX_PLAIN_REVIEW_TURNS: JSON.stringify([
        "The uncommitted implementation works.",
        "Another English sentence without sections.",
      ]),
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const result = await callback.send({
      workflowId: "workflow-display-bad",
      submissionId: "submission-display-bad",
      codexThreadId: "origin-task-display-bad",
      cwd: directory,
      prompt: "Review this implementation.",
      task: "实现搜索功能",
      planMarkdown: "<proposed_plan>\n改 a.ts\n</proposed_plan>",
    });
    assert.equal(result.kind, "retryable_busy");
    if (result.kind === "retryable_busy") {
      assert.match(result.reason, /display contract/, `reason=${result.reason}`);
    }
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the background path rewrites on the PERSISTED read-back: compliant streamed but violating persisted text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-rb-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      // STREAMED texts: the native review is fully compliant; the rewrite is
      // the corrected Chinese review.
      FAKE_CODEX_PLAIN_REVIEW_TURNS: JSON.stringify([
        "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现符合计划，测试全部通过",
        "VERDICT: changes_requested\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 实现需调整，测试需补齐",
      ]),
      // PERSISTED (thread/read) texts: the native turn persists as Chinese
      // prose WITHOUT the four sections — the display-truth that must trigger
      // the rewrite; the rewrite turn then persists its (compliant) text.
      FAKE_CODEX_PERSISTED_TEXT_SEQ: JSON.stringify([
        "Full review comments：实现存在若干问题，需调整后再合入。",
      ]),
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "changes_requested", findings: [], testGaps: [], summary: "Needs work" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    let reviewerThreadId = "";
    const result = await callback.send({
      workflowId: "workflow-readback",
      submissionId: "submission-readback",
      codexThreadId: "origin-task-readback",
      cwd: directory,
      prompt: "Review this implementation.",
      task: "扩展normalizeWindowsPath",
      planMarkdown: "<proposed_plan>\n扩展路径归一化\n</proposed_plan>",
      onThread: (threadId) => { reviewerThreadId = threadId; },
    });
    assert.equal(result.kind, "verdict");

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    // The persisted read-back reads the durable Reviewer history with turns.
    const readbacks = calls.filter((call) => call.method === "thread/read" && call.params.includeTurns === true);
    assert.ok(readbacks.length >= 1, "the native turn is read back from the persisted history");
    assert.ok(readbacks.every((call) => call.params.threadId === reviewerThreadId), "read-backs target the SAME durable Reviewer");
    // Native visible turn + display rewrite turn on the SAME thread.
    const visible = calls.filter((call) => call.method === "turn/start" && !call.params.outputSchema);
    assert.equal(visible.length, 2, "the violating PERSISTED text triggered exactly one rewrite");
    assert.ok(visible.every((call) => call.params.threadId === reviewerThreadId), "the rewrite stays on the SAME Reviewer task");
    // The rewrite rewrites the PERSISTED text, not the compliant streamed one.
    // (The rewrite prompt legitimately carries the display-contract template
    // lines, so the assertion targets the STREAMED review's text body.)
    const rewritePrompt = visible[1]?.params.input?.[0]?.text ?? "";
    assert.match(rewritePrompt, /Full review comments/, "the rewrite input is the PERSISTED violating text");
    assert.ok(!rewritePrompt.includes("实现符合计划，测试全部通过"), "the compliant streamed native text is never the rewrite input");
    const forks = calls.filter((call) => call.method === "thread/fork");
    assert.equal(forks.length, 1, "exactly one conversion fork");
    const conversions = calls.filter((call) => call.method === "turn/start" && call.params.outputSchema);
    assert.equal(conversions.length, 1);
    assert.match(conversions[0]?.params.input?.[0]?.text ?? "", /实现需调整，测试需补齐/, "the conversion consumes the rewrite's persisted final message");
    assert.equal(calls.filter((call) => call.method === "thread/start").length, 0, "no second visible task is created");
    // The persisted rollout ids DELIBERATELY differ from the RPC turn ids
    // (real App Server evidence) — the read-back located the appended turns
    // via the baseline id set, never by RPC-id equality.
    const persistedThread = await codex.readThread(reviewerThreadId, true);
    const persistedTurns = (persistedThread.turns ?? []) as Array<{ id: string }>;
    assert.ok(persistedTurns.length >= 2, "native review AND rewrite are both persisted");
    assert.ok(persistedTurns.every((turn) => /^persisted-/.test(turn.id)), "persisted rollout ids differ from the RPC turn ids");
    assert.ok(!persistedTurns.some((turn) => /^turn-/.test(turn.id)), "no RPC turn id ever equals a persisted rollout id");
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a PERSISTED read-back that still violates after the rewrite is retryable in the background path (no conversion runs)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-app-server-callback-rb-bad-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: marker,
      // Streamed texts are compliant; BOTH persisted texts violate (the native
      // round AND the rewrite round).
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_PERSISTED_TEXT_SEQ: JSON.stringify([
        "Full review comments：第一轮中文长文，无四段。",
        "rewrite persisted still an English sentence without sections",
      ]),
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const result = await callback.send({
      workflowId: "workflow-rb-bad",
      submissionId: "submission-rb-bad",
      codexThreadId: "origin-task-rb-bad",
      cwd: directory,
      prompt: "Review this implementation.",
      task: "实现搜索功能",
      planMarkdown: "<proposed_plan>\n改 a.ts\n</proposed_plan>",
    });
    assert.equal(result.kind, "retryable_busy");
    if (result.kind === "retryable_busy") {
      assert.match(result.reason, /display contract/, `reason=${result.reason}`);
    }
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    // The still-violating persisted rewrite is retryable: no conversion fork,
    // no pass verdict can ride a violating history.
    assert.equal(calls.filter((call) => call.method === "thread/fork").length, 0, "no conversion fork ran");
    // Two BASELINE captures (before native and rewrite) + two APPENDED
    // read-backs (native and rewrite): every visible turn is audited against
    // the persisted history.
    const readbacks = calls.filter((call) => call.method === "thread/read" && call.params.includeTurns === true);
    assert.equal(readbacks.length, 4, "native + rewrite baselines and appended read-backs");
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

test("an active writer on the shared source task is retried instead of creating another task", async () => {
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const result = await callback.send({
      workflowId: "workflow-writer",
      submissionId: "submission-writer",
      codexThreadId: "origin-task-writer",
      cwd: directory,
      prompt: "Review the implementation.",
      onThread: () => { throw new Error("a busy source task must not be persisted as active"); },
    });
    assert.deepEqual(result, { kind: "retryable_busy", reason: "active writer" });

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    // Validation remains read-only, but review must resume the exact source
    // task. A writer conflict is therefore an explicit retry condition; the
    // plugin never escapes it by creating a second visible task.
    const sourceReads = calls.filter((call) => call.method === "thread/read" && call.params.includeTurns !== true);
    assert.deepEqual(sourceReads.map((call) => call.method), ["thread/read"]);
    assert.equal(sourceReads.find((call) => call.method === "thread/read")?.params.threadId, "origin-task-writer");
    assert.equal(calls.filter((call) => call.method === "thread/resume").length, 1);
    assert.equal(calls.filter((call) => call.method === "thread/start").length, 0);
    assert.equal(calls.filter((call) => call.method === "turn/start").length, 0);
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
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
    assert.equal(
      calls.filter((call) => call.method === "thread/read" && call.params.includeTurns !== true).length,
      0,
      "a persisted Reviewer is resumed, the source is never re-validated",
    );
    assert.equal(calls.filter((call) => call.method === "thread/start").length, 0, "a persisted Reviewer is never recreated");
    const resumes = calls.filter((call) => call.method === "thread/resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.params.threadId, "reviewer-from-a-previous-version");
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(turns[0]?.params.threadId, "reviewer-from-a-previous-version");
    assert.equal(turns[0]?.params.outputSchema, undefined, "the visible Reviewer turn carries no schema even for old records");
    // The conversion fork is created from the SAME persisted Reviewer id.
    const forks = calls.filter((call) => call.method === "thread/fork");
    assert.equal(forks.length, 1);
    assert.equal(forks[0]?.params.threadId, "reviewer-from-a-previous-version");
    assert.equal(forks[0]?.params.ephemeral, true);
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel interrupts the active review turn on the shared source task", async () => {
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
    assert.equal(started!.threadId, request.codexThreadId, "the active review is appended to the source task");
    // Cancelling the workflow interrupts the running review turn on that task.
    callback.cancel(request.workflowId);
    // Unblock the hanging turn so teardown and the rejection settle.
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(sending);
    const [thread, turn] = (await waitForFileText(marker)).trim().split(":");
    assert.equal(thread, started!.threadId, "interrupt must target the active review turn");
    assert.ok(turn);
    assert.equal(thread, request.codexThreadId);
    // Cancellation releases the plugin's subscription exactly once.
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 1, "a cancelled review releases its thread exactly once");
    assert.equal(unsubs[0]?.params.threadId, started!.threadId);
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel latches the visible->fork window: a fork that starts after cancel is interrupted immediately and never occupies the writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-latch-"));
  const gateFile = join(directory, "fork-held.txt");
  const callsFile = join(directory, "calls.jsonl");
  const interruptFile = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 10_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile,
      FAKE_CODEX_FORK_GATE_FILE: gateFile,
      FAKE_CODEX_INTERRUPT_MARKER: interruptFile,
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    const request = {
      workflowId: "wf-latch",
      submissionId: "sub-latch",
      codexThreadId: "origin-latch",
      cwd: directory,
      prompt: "Review.",
    };
    const sending = callback.send(request);
    // The visible turn has COMPLETED and the fork RPC is now HELD: we are
    // exactly in the visible->normalization window.
    await waitForFileText(gateFile);
    callback.cancel(request.workflowId);
    // 1.0.8: a cancel in this window must NOT interrupt the already-COMPLETED
    // visible turn on the source task — the completed turn was removed from
    // the active map the moment it finished, and the fork gets stopped by the
    // cancellation LATCH only when it actually starts.
    assert.equal(await fileExists(interruptFile), false, "no interrupt is sent for the completed visible turn");
    await writeFile(`${gateFile}.release`, "go");
    // The latched run must be retryable with the attributed origin, never a
    // verdict and never a terminal failure.
    const result = await sending;
    assert.equal(result.kind, "retryable_busy");
    assert.match(result.reason, /cancelled by user/);

    // The freshly started FORK turn was interrupted (the marker reflects the
    // last interrupt: the fork's thread/turn — never the source task).
    const [thread, turn] = (await waitForFileText(interruptFile)).trim().split(":");
    assert.notEqual(thread, request.codexThreadId, "the source task is never interrupted");
    assert.ok(thread && turn, "the fork turn was interrupted");

    // Both the durable Reviewer and the ephemeral fork were released exactly
    // once; the old owner's fork never kept running.
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 2, "the fork AND the durable Reviewer are each released once");
    const unsubThreads = new Set(unsubs.map((call) => call.params.threadId));
    assert.equal(unsubThreads.size, 2, "two distinct threads were released");
    assert.ok(unsubs.some((call) => call.params.threadId === request.codexThreadId));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid normalization output is RETRYABLE, never a terminal failure", async () => {
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_REVIEW_VERDICT: "not-json",
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    // 1.0.7: a missing/invalid ephemeral-conversion output is an
    // infrastructure-class failure — retryable with backoff, NEVER a terminal
    // submission failure/notice, and it consumes no review cycle. Only an
    // invalid SOURCE task (CodexInvalidThreadError) stays terminal.
    const result = await callback.send({
      workflowId: "workflow-invalid",
      submissionId: "submission-invalid",
      codexThreadId: "origin-invalid",
      cwd: process.cwd(),
      prompt: "Review it.",
    });
    assert.equal(result.kind, "retryable_busy");
    assert.match(result.reason, /normalization output invalid/);
    // The fork (and its fail-safe cleanups) still release exactly once.
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 2, "the fork AND the durable Reviewer are released exactly once");
    assert.ok(unsubs.some((call) => call.params.threadId === "origin-invalid"), "the shared task subscription is released");
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
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
    // The changes_requested path still releases the Reviewer thread and the
    // ephemeral fork exactly once each.
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 2, "a changes_requested verdict releases the Reviewer and the fork once each");
    assert.ok(unsubs.some((call) => call.params.threadId === "origin-prov"));
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
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

test("a failed normalization turn never produces a verdict and stays retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-callback-failed-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_PROVISIONAL_SEQ: JSON.stringify([
        JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "streamed before failure" }),
      ]),
      FAKE_CODEX_TURN_STATUS: "failed",
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    // The failed EPHEMERAL conversion (even one that streamed a full pass JSON)
    // is infrastructure-class: retryable, never a verdict or a terminal error.
    const result = await callback.send({
      workflowId: "workflow-failed",
      submissionId: "submission-failed",
      codexThreadId: "origin-failed",
      cwd: directory,
      prompt: "Review.",
    });
    assert.equal(result.kind, "retryable_busy");
    assert.match(result.reason, /normalization turn failed/);
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source-task binding persistence failure releases the resumed subscription once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-callback-source-bind-"));
    const marker = join(directory, "calls.jsonl");
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 5_000,
      idleProcessMs: 0,
      env: { ...process.env, FAKE_CODEX_THREAD_PARAMS_MARKER: marker },
    });
    const callback = new AppServerCodexCallbackDispatcher(codex);
    try {
      const base = {
        workflowId: "workflow-bind",
        submissionId: "submission-bind",
        codexThreadId: "origin-bind",
        cwd: directory,
        prompt: "Review.",
      };
      await assert.rejects(callback.send({
        ...base,
        onThread: async () => { throw new Error("ownership persistence failed"); },
      }), CodexCallbackProcessError);
      const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
        method: string;
        params: Record<string, any>;
      });
      assert.equal(calls.filter((call) => call.method === "thread/start").length, 0, "no replacement task was created");
      const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
      assert.equal(unsubs.length, 1, "the resumed source subscription is released exactly once");
      assert.equal(unsubs[0]?.params.threadId, "origin-bind");
    } finally {
      await callback.stop();
      await codex.stop();
      await rm(directory, { recursive: true, force: true });
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
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
    const forks = calls.filter((call) => call.method === "thread/fork");
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    // Two source tasks are resumed and released independently, plus two
    // ephemeral conversion forks.
    assert.equal(starts.length, 0);
    assert.equal(forks.length, 2);
    assert.equal(unsubs.length, 4);
    const unsubThreads = new Set(unsubs.map((call) => call.params.threadId));
    assert.equal(unsubThreads.size, 4, "2 source tasks + 2 fork threads all released");
    assert.ok(unsubs.some((call) => call.params.threadId === "origin-a"));
    assert.ok(unsubs.some((call) => call.params.threadId === "origin-b"));
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
      FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" }),
    },
  });
  const callback = new AppServerCodexCallbackDispatcher(codex);
  try {
    // No reviewerModel and no effort: the server's isDefault model wins over the
    // list-first entry, and the model's defaultReasoningEffort is used instead
    // of a fixed null.
    await callback.send({ workflowId: "wf-default", submissionId: "s-default", codexThreadId: "origin-default", cwd: directory, prompt: "Review." });
    // A second workflow with an explicit effort: the explicit effort wins on
    // the VISIBLE turn; the conversion fork stays at the fixed low effort.
    await callback.send({ workflowId: "wf-eff", submissionId: "s-eff", codexThreadId: "origin-eff", cwd: directory, prompt: "Review.", effort: "ultra" });

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 4);
    const visible = turns.filter((call) => !call.params.outputSchema);
    const conversions = turns.filter((call) => call.params.outputSchema);
    assert.equal(visible.length, 2);
    assert.equal(conversions.length, 2);
    // Visible turns: isDefault selection ("default-model", NOT "first-model");
    // the model's defaultReasoningEffort when no effort is configured.
    assert.equal(visible[0]!.params.collaborationMode!.settings.model, "default-model");
    assert.equal(visible[0]!.params.collaborationMode!.settings.reasoning_effort, "medium");
    assert.match(visible[0]!.params.collaborationMode!.settings.developer_instructions, /no commentary/i);
    // Explicit effort overrides the model default on the visible turn.
    assert.equal(visible[1]!.params.collaborationMode!.settings.model, "default-model");
    assert.equal(visible[1]!.params.collaborationMode!.settings.reasoning_effort, "ultra");
    // Conversion turns: SAME default model, effort FIXED at low, JSON-only
    // developer instructions.
    for (const conversion of conversions) {
      assert.equal(conversion.params.collaborationMode.settings.model, "default-model");
      assert.equal(conversion.params.collaborationMode.settings.reasoning_effort, "low");
      assert.equal(conversion.params.effort, "low");
      assert.match(conversion.params.collaborationMode.settings.developer_instructions, /JSON object conforming/);
    }
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
      FAKE_CODEX_PLAIN_REVIEW_MARKDOWN: "1",
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

    // A's cycle releases the shared Reviewer exactly once AND unsubscribes its
    // own ephemeral fork exactly once. B never decremented A's live reference,
    // so the shared thread was not released under the active turn.
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 2, "a failed pre-turn operation must not add or remove any release");
    assert.ok(unsubs.some((call) => call.params.threadId === "shared-reviewer"));
    assert.ok(unsubs.some((call) => call.params.threadId !== "shared-reviewer"), "A's ephemeral fork is released");
    assert.ok(!unsubs.some((call) => call.params.threadId === "origin-a" || call.params.threadId === "origin-b"));
  } finally {
    await callback.stop();
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 1.0.8 invariant on the BRIDGE path, REAL order: the App Server reports the
 * review task id through `startTurn.onStarted` — a mismatched id reaches the
 * callback BEFORE any return value is inspected. The rogue turn must be
 * interrupted immediately, never enter the active map, never reach
 * `request.onStarted` (so the wrong id is never persisted), never start a
 * normalization fork, and never produce a verdict — the round stays retryable
 * exactly like writer conflicts/timeouts. */
test("a review/start reporting a different task id IN onStarted is interrupted, never tracked, and stays retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-callback-rogue-"));
  try {
    const calls: string[] = [];
    const interrupts: Array<{ threadId: string; turnId: string }> = [];
    const streamedOnStarted: Array<{ threadId: string; turnId: string }> = [];
    let normalizeCalls = 0;
    const codex = {
      resumeThread: async () => { calls.push("resume"); },
      captureTurnBaseline: async () => { calls.push("baseline"); return { ids: [] }; },
      interrupt: async (threadId: string, turnId: string) => { interrupts.push({ threadId, turnId }); },
      unsubscribeThread: async () => { calls.push("unsubscribe"); },
      startTurn: async (_threadId: string, options: { onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void }) => {
        calls.push("startTurn");
        // The REAL App Server reports the id it actually started through
        // onStarted — from the very first callback it is a DIFFERENT task.
        if (options.onStarted) {
          await options.onStarted({ threadId: "rogue-thread", turnId: "rogue-turn-1" });
        }
        return { kind: "completed", threadId: "rogue-thread", turnId: "rogue-turn-1", status: "completed", text: "" };
      },
      normalizeInFork: async () => { normalizeCalls += 1; return { kind: "completed", threadId: "fork", turnId: "t", status: "completed", text: "{}" }; },
      resolveDefaultModel: async () => "model-x",
    } as unknown as CodexAppServerClient;
    const callback = new AppServerCodexCallbackDispatcher(codex);
    try {
      const result = await callback.send({
        workflowId: "workflow-rogue",
        submissionId: "submission-rogue",
        codexThreadId: "origin-task",
        reviewerThreadId: "workflow-task",
        cwd: directory,
        prompt: "Review this implementation.",
        task: "扩展normalizeWindowsPath",
        planMarkdown: "<proposed_plan>\n路径归一化\n</proposed_plan>",
        onStarted: async (started) => { streamedOnStarted.push(started); },
      });
      // Fail-closed per the existing callback contract: the mismatch is an
      // infrastructure-class anomaly, retryable with backoff — never a
      // terminal failure and never a verdict.
      assert.equal(result.kind, "retryable_busy");
    } finally {
      await callback.stop();
    }
    assert.deepEqual(
      interrupts,
      [{ threadId: "rogue-thread", turnId: "rogue-turn-1" }],
      "the rogue turn is interrupted immediately, before anything is tracked",
    );
    assert.equal(streamedOnStarted.length, 0, "request.onStarted never runs — the wrong reviewerThreadId is never persisted");
    assert.equal(callback.activeReview("workflow-rogue"), false, "the rogue turn never stays in the active map");
    assert.equal(normalizeCalls, 0, "no normalization fork ever starts for the rogue task");
    assert.ok(calls.includes("startTurn"), "the visible turn RPC was attempted");
    assert.equal(calls.filter((c) => c === "startTurn").length, 1, "no rewrite/conversion turn either");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

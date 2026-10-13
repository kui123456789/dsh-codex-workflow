import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { CodexCliAuditDispatcher, extractAgentMessage } from "../src/codex-cli-audit.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "../src/codex-callback.js";

const PASS_REVIEW = { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" };
const VISIBLE_REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ok";

type CliRunEntry = {
  run(workflowId: string, submissionId: string | undefined, args: string[], prompt: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

for (const maxOutputBytes of [64, 65]) {
  test(`CLI stderr byte bound ${maxOutputBytes} retains complete emoji within its byte budget`, async () => {
    const fake = spawned([{ stdout: "ok", stderr: "😀".repeat(100) }]);
    const audit = dispatcher(fake.spawn, { maxOutputBytes });
    try {
      const result = await (audit as unknown as CliRunEntry).run("unicode-stderr-bound", undefined, [], "Local probe");
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "ok");
      assert.ok(Buffer.byteLength(result.stderr, "utf8") <= maxOutputBytes);
      assert.equal(result.stderr, "😀".repeat(16));
      assert.equal(Buffer.from(result.stderr).toString("utf8"), result.stderr);
      assert.equal(fake.calls.length, 1);
    } finally { await audit.stop(); }
  });
}

test("CLI stderr byte bound retains its newest complete suffix when the preceding code point cannot fit", async () => {
  const fake = spawned([{ stdout: "", stderr: "头".repeat(100) + "尾😀" }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 5 });
  try {
    const result = await (audit as unknown as CliRunEntry).run("unicode-stderr-suffix", undefined, [], "Local probe");
    assert.equal(result.stderr, "😀");
    assert.equal(Buffer.byteLength(result.stderr), 4);
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI stderr byte bound handles UTF-8 characters split across separate data events", async () => {
  const original = Buffer.from("开始".repeat(100) + "尾😀");
  const fake = spawned([{ stdout: "", stderrChunks: Array.from(original, byte => Buffer.from([byte])) }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 7 });
  try {
    const result = await (audit as unknown as CliRunEntry).run("unicode-stderr-chunks", undefined, [], "Local probe");
    assert.equal(result.stderr, "尾😀");
    assert.equal(Buffer.byteLength(result.stderr), 7);
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI stderr byte bound applies after decoder finalization of incomplete source bytes", async () => {
  const fake = spawned([{ stdout: "", stderrChunks: [Buffer.from("ABC"), Buffer.from([0xe4])] }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 4 });
  try {
    const result = await (audit as unknown as CliRunEntry).run("unicode-stderr-finalize", undefined, [], "Local probe");
    assert.equal(result.stderr, "C�");
    assert.equal(Buffer.byteLength(result.stderr), 4);
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI stderr byte bound zero discards diagnostic bytes without aborting a silent successful process", async () => {
  const fake = spawned([{ stdout: "", stderr: "检查😀".repeat(100) }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 0 });
  try {
    const result = await (audit as unknown as CliRunEntry).run("unicode-stderr-zero", undefined, [], "Local probe");
    assert.equal(result.stderr, "");
    assert.equal(result.code, 0);
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI stderr byte bound preserves the existing exact ASCII tail", async () => {
  const fake = spawned([{ stdout: "ok", stderr: "older-ASCII-ENDTAIL" }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 7 });
  try {
    const result = await (audit as unknown as CliRunEntry).run("ascii-stderr-tail", undefined, [], "Local probe");
    assert.equal(result.stderr, "ENDTAIL");
    assert.equal(result.stdout, "ok");
  } finally { await audit.stop(); }
});

test("CLI stderr byte bound preserves the retained terminal diagnostic through the public review path", async () => {
  const fake = spawned([{ stdout: "", stderr: "😀".repeat(100) + "permission denied", code: 1 }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 64, retry: { budgetMs: 0 } });
  try {
    await assert.rejects(audit.review({ workflowId: "unicode-terminal-bound", submissionId: "original-submission", codexThreadId: "original-reviewer",
      cwd: "C:\\repo", prompt: "Original review" }), error => {
      assert.ok(error instanceof CodexCallbackProcessError);
      const prefix = "codex CLI audit exited with code 1: ";
      assert.ok(error.message.startsWith(prefix));
      const diagnostic = error.message.slice(prefix.length);
      assert.ok(Buffer.byteLength(diagnostic) <= 64);
      assert.ok(diagnostic.endsWith("permission denied"));
      assert.equal(Buffer.from(diagnostic).toString("utf8"), diagnostic);
      return true;
    });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0]!.args.slice(-3), ["resume", "original-reviewer", "-"]);
  } finally { await audit.stop(); }
});

test("CLI stdout byte bound rejects overflow introduced only by final decoder flush", async () => {
  const fake = spawned([{ stdout: "", stdoutChunks: ["ABC", Buffer.from([0xe4])] }]);
  const audit = dispatcher(fake.spawn, { maxOutputBytes: 4 });
  try {
    await assert.rejects((audit as unknown as CliRunEntry).run("unicode-stdout-finalize", undefined, [], "Local probe"),
      error => error instanceof CodexNoVerdictError && /output exceeded retention bound/.test(error.message));
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI stdout byte bound finalization preserves a prior original cancellation cause", async () => {
  const controller = new AbortController(), cause = new Error("original CLI caller cancelled");
  const fake = spawned([{ stdout: "", stdoutChunks: ["ABC", Buffer.from([0xe4])] }]);
  const audit = dispatcher((command, args) => {
    const child = fake.spawn(command, args);
    child.stdin!.once("finish", () => controller.abort(cause));
    return child;
  }, { maxOutputBytes: 4 });
  try {
    await assert.rejects((audit as unknown as CliRunEntry).run("unicode-stdout-cancel", undefined, [], "Local probe", controller.signal),
      error => error === cause);
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI positive jitter honors its delay ceiling and recovers the original Reviewer within budget", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const fake = spawned([
    { stdout: "", stderr: "503 Service Unavailable", code: 1 },
    { stdout: agentMessage(VISIBLE_REVIEW) },
    { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
  ]);
  const audit = dispatcher(fake.spawn, { retry: { baseMs: 60_000, maxMs: 60_000, budgetMs: 65_000, jitterRatio: 0.25 },
    now: () => clock, random: () => 0.999999, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  try {
    const result = await audit.review({ workflowId: "retry-delay-ceiling", submissionId: "original-submission",
      codexThreadId: "original-reviewer", cwd: "C:\\repo", prompt: "Original review" });
    assert.equal(result.kind, "verdict");
    assert.equal(result.threadId, "original-reviewer");
    assert.deepEqual(sleeps, [60_000]);
    assert.equal(fake.calls.length, 3, "Two original Reviewer calls followed by its existing normalization stage");
    for (const call of fake.calls.slice(0, 2)) assert.deepEqual(call.args.slice(-3), ["resume", "original-reviewer", "-"]);
  } finally { await audit.stop(); }
});

for (const wakeAt of [50, 210]) {
  test(`CLI retry wake-up at ${wakeAt}ms returns the last original transient failure without spawning another turn`, async () => {
    let clock = 0;
    const fake = spawned([
      { stdout: "", stderr: "503 Service Unavailable", code: 1 },
      { stdout: agentMessage(VISIBLE_REVIEW) },
      { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
    ]);
    const audit = dispatcher(fake.spawn, { retry: { baseMs: 10, maxMs: 10, budgetMs: 50, jitterRatio: 0 },
      now: () => clock, sleep: async () => { clock = wakeAt; } });
    try {
      await assert.rejects(audit.review({ workflowId: "retry-wake-up", submissionId: "original-submission",
        codexThreadId: "original-reviewer", cwd: "C:\\repo", prompt: "Original review" }), error => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof CodexCallbackProcessError), "Exhausted transient failure stays retryable");
        assert.match(error.message, /503 Service Unavailable/);
        return true;
      });
      assert.equal(fake.calls.length, 1, "No replacement or another model stage starts after the original retry deadline");
    } finally { await audit.stop(); }
  });
}

test("CLI wake-up preserves caller cancellation before returning a spent transient result", async () => {
  let clock = 0;
  const controller = new AbortController(), cause = new Error("original CLI caller cancelled");
  const fake = spawned([{ stdout: "", stderr: "503 Service Unavailable", code: 1 }]);
  const audit = dispatcher(fake.spawn, { retry: { baseMs: 10, maxMs: 10, budgetMs: 50, jitterRatio: 0 },
    now: () => clock, sleep: async () => { clock = 210; controller.abort(cause); } });
  try {
    await assert.rejects(audit.review({ workflowId: "retry-cancelled-wake-up", submissionId: "original-submission",
      codexThreadId: "original-reviewer", cwd: "C:\\repo", prompt: "Original review" }, controller.signal), error => error === cause);
    assert.equal(fake.calls.length, 1);
  } finally { await audit.stop(); }
});

test("CLI terminal Unicode diagnostics retain original ends within the shared byte bound", async () => {
  const original = "permission denied: " + "检查😀".repeat(1000) + "原错误尾部🔥";
  const fake = spawned([{ stdout: "", stderr: original, code: 2 }]);
  const audit = dispatcher(fake.spawn, { retry: { budgetMs: 0 } });
  try {
    await assert.rejects(audit.normalize({ visibleText: VISIBLE_REVIEW, cwd: "C:\\repo", workflowId: "wf-unicode-diagnostic" }), (error: unknown) => {
      assert.ok(error instanceof CodexCallbackProcessError);
      const prefix = "codex CLI audit exited with code 2: ";
      assert.ok(error.message.startsWith(prefix));
      const diagnostic = error.message.slice(prefix.length);
      assert.ok(Buffer.byteLength(diagnostic, "utf8") <= 2048);
      assert.ok(diagnostic.startsWith("permission denied:"));
      assert.ok(diagnostic.endsWith("原错误尾部🔥"));
      assert.equal(Buffer.from(diagnostic).toString("utf8"), diagnostic);
      return true;
    });
    assert.equal(fake.calls.length, 1, "Terminal classification still occurs on the original full diagnostic");
  } finally { await audit.stop(); }
});

function agentMessage(text: string): string {
  return `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`;
}

function spawned(responses: Array<{ stdout: string; stdoutChunks?: Array<string | Buffer>; stderr?: string; stderrChunks?: Array<string | Buffer>; code?: number }>) {
  const calls: Array<{ command: string; args: string[]; prompt: string }> = [];
  const spawn = (command: string, args: string[]): ChildProcess => {
    const response = responses.shift();
    assert.ok(response, "fake spawn response exhausted");
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const call = { command, args: [...args], prompt: "" };
    calls.push(call);
    stdin.on("data", (chunk) => { call.prompt += String(chunk); });
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => emitter.emit("close", code));
    };
    stdin.on("finish", () => {
      if (response.stdoutChunks) {
        for (const chunk of response.stdoutChunks) stdout.write(chunk);
        stdout.end();
      } else stdout.end(response.stdout);
      if (response.stderrChunks) {
        for (const chunk of response.stderrChunks) stderr.write(chunk);
        stderr.end();
      } else stderr.end(response.stderr ?? "");
      close(response.code ?? 0);
    });
    Object.assign(emitter, {
      pid: 1234 + calls.length,
      stdin,
      stdout,
      stderr,
      kill: () => { close(null); return true; },
    });
    return emitter as unknown as ChildProcess;
  };
  return { calls, spawn };
}

function dispatcher(
  spawn: (command: string, args: string[]) => ChildProcess,
  overrides: Partial<ConstructorParameters<typeof CodexCliAuditDispatcher>[0]> = {},
): CodexCliAuditDispatcher {
  return new CodexCliAuditDispatcher({
    command: "codex-test",
    reviewSchemaFile: "review-schema.json",
    alignmentSchemaFile: "alignment-schema.json",
    timeoutMs: 5_000,
    spawn,
    ...overrides,
  });
}

function stubbornSpawn(signals: Array<NodeJS.Signals | undefined>, starts: string[] = []) {
  return (_command: string, args: string[]): ChildProcess => {
    starts.push(args.join(" "));
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(emitter, {
      pid: 9876,
      exitCode: null,
      signalCode: null,
      stdin,
      stdout,
      stderr,
      kill: (signal?: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          Object.assign(emitter, { signalCode: "SIGKILL" });
          queueMicrotask(() => emitter.emit("close", null));
        }
        return true;
      },
    });
    return emitter as unknown as ChildProcess;
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("CLI audit extracts the last completed agent message and ignores noise", () => {
  const stdout = [
    "warning: noisy stderr-like line",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    "not json",
    JSON.stringify({ type: "item.completed", item: { type: "plan", text: "ignored plan" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ok" } }),
  ].join("\n");
  assert.equal(extractAgentMessage(stdout), "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ok");
});

const CREATED_ID = "12345678-1234-1234-1234-123456789abc";
const startedEvent = (id = CREATED_ID) => JSON.stringify({ type: "thread.started", thread_id: id });

test("new CLI review persists a split thread.started identity before normalization and resumes it", async () => {
  const event = startedEvent();
  const fake = spawned([
    { stdout: "", stdoutChunks: [event.slice(0, 20), event.slice(20) + "\n", event + "\n", agentMessage(VISIBLE_REVIEW)] },
    { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
    { stdout: agentMessage(VISIBLE_REVIEW) },
    { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
  ]);
  const audit = dispatcher(fake.spawn);
  let bound: string | undefined;
  let bindings = 0;
  const request = { workflowId: "fresh-review", submissionId: "first", cwd: "C:\\repo", prompt: "review", model: "gpt-6-astra", effort: "high" as const };
  const first = await audit.createReview({ ...request, onThread: async (id) => {
    assert.equal(fake.calls.length, 1, "bind before any normalization child starts");
    await new Promise((resolve) => setTimeout(resolve, 10));
    bound = id; bindings++;
  } });
  assert.equal(first.threadId, CREATED_ID);
  assert.equal(bound, CREATED_ID);
  assert.equal(bindings, 1);
  const fresh = fake.calls[0]!.args;
  assert.ok(!fresh.includes("resume") && !fresh.includes("--ephemeral") && !fresh.includes("--output-schema"));
  assert.ok(fresh.includes("read-only") && fresh.includes("approval_policy=never"));
  assert.ok(fresh.includes("gpt-6-astra") && fresh.includes('model_reasoning_effort="high"'));
  const second = await audit.review({ ...request, submissionId: "second", codexThreadId: bound! });
  assert.equal(second.threadId, CREATED_ID);
  assert.deepEqual(fake.calls[2]!.args.slice(-3), ["resume", CREATED_ID, "-"]);
  await audit.stop();
});

test("new CLI review retains its task identity even if the first process fails", async () => {
  const fake = spawned([{ stdout: startedEvent(), stderr: "request failed", code: 1 }]);
  const audit = dispatcher(fake.spawn);
  let bound: string | undefined;
  await assert.rejects(audit.createReview({ workflowId: "failed-first", submissionId: "first", cwd: "C:\\repo", prompt: "review", onThread: (id) => { bound = id; } }), /request failed/);
  assert.equal(bound, CREATED_ID);
  assert.equal(fake.calls.length, 1, "never auto-create a replacement task");
  await audit.stop();
});

for (const stdout of [agentMessage(VISIBLE_REVIEW), startedEvent("bad-id") + "\n" + agentMessage(VISIBLE_REVIEW), startedEvent() + "\n" + startedEvent("abcdef12-1234-1234-1234-123456789abc") + "\n"]) {
  test("new CLI review fails closed without one valid task identity: " + stdout.slice(0, 55), async () => {
    const fake = spawned([{ stdout }]);
    const audit = dispatcher(fake.spawn);
    await assert.rejects(audit.createReview({ workflowId: "invalid-id", submissionId: "first", cwd: "C:\\repo", prompt: "review", onThread: () => {} }), /identity/);
    assert.equal(fake.calls.length, 1);
    await audit.stop();
  });
}

test("new CLI review does not normalize when task persistence is rejected", async () => {
  const fake = spawned([{ stdout: startedEvent() + "\n" + agentMessage(VISIBLE_REVIEW) }]);
  const audit = dispatcher(fake.spawn);
  await assert.rejects(audit.createReview({ workflowId: "cancelled-first", submissionId: "first", cwd: "C:\\repo", prompt: "review", onThread: async () => { throw new Error("workflow cancelled"); } }), /workflow cancelled/);
  assert.equal(fake.calls.length, 1);
  await audit.stop();
});

test("stop waits for new-task persistence and suppresses normalization", async () => {
  const fake = spawned([{ stdout: startedEvent() + "\n" + agentMessage(VISIBLE_REVIEW) }]);
  const audit = dispatcher(fake.spawn);
  let release!: () => void;
  let entered = false;
  const pending = audit.createReview({ workflowId: "stop-first", submissionId: "first", cwd: "C:\\repo", prompt: "review", onThread: () => {
    entered = true;
    return new Promise<void>((resolve) => { release = resolve; });
  } });
  const rejected = assert.rejects(pending, /stopped/);
  await waitFor(() => entered);
  let stopped = false;
  const stopping = audit.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  release();
  await Promise.all([rejected, stopping]);
  assert.equal(fake.calls.length, 1);
});

test("CLI audit returns undefined when no completed agent message exists", () => {
  assert.equal(extractAgentMessage(JSON.stringify({ type: "turn.completed" })), undefined);
});

test("visible CLI review resumes the legacy Reviewer task and propagates model/effort", async () => {
  const fake = spawned([
    { stdout: agentMessage(VISIBLE_REVIEW) },
    { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
  ]);
  const audit = dispatcher(fake.spawn);
  let persistedThread: string | undefined;
  const result = await audit.review({
    workflowId: "wf-visible",
    submissionId: "sub-visible",
    codexThreadId: "source-task",
    reviewerThreadId: "legacy-reviewer-task",
    cwd: "C:\\repo",
    prompt: "review prompt",
    task: "Review the implementation",
    model: "gpt-5.6-sol",
    effort: "high",
    onThread: (threadId) => { persistedThread = threadId; },
  });

  assert.equal(result.threadId, "legacy-reviewer-task");
  assert.equal(persistedThread, "legacy-reviewer-task");
  assert.equal(fake.calls.length, 2);
  const visible = fake.calls[0]!.args;
  assert.deepEqual(visible.slice(-3), ["resume", "legacy-reviewer-task", "-"]);
  assert.ok(!visible.includes("source-task"));
  assert.deepEqual(visible.slice(visible.indexOf("-m"), visible.indexOf("-m") + 2), ["-m", "gpt-5.6-sol"]);
  assert.ok(visible.includes('model_reasoning_effort="high"'));
  assert.ok(!visible.includes("--output-schema"));

  const normalization = fake.calls[1]!.args;
  assert.ok(normalization.includes("--ephemeral"));
  assert.deepEqual(normalization.slice(normalization.indexOf("--output-schema"), normalization.indexOf("--output-schema") + 2), ["--output-schema", "review-schema.json"]);
  assert.deepEqual(normalization.slice(normalization.indexOf("-m"), normalization.indexOf("-m") + 2), ["-m", "gpt-5.6-sol"]);
  assert.ok(normalization.includes('model_reasoning_effort="low"'));
  assert.ok(!normalization.includes("resume"));
  assert.ok(!normalization.includes("legacy-reviewer-task"));
});

test("visible CLI omits -m for a blank model but still passes reviewer effort", async () => {
  const fake = spawned([
    { stdout: agentMessage(VISIBLE_REVIEW) },
    { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
  ]);
  const audit = dispatcher(fake.spawn);
  await audit.review({
    workflowId: "wf-default-model",
    submissionId: "sub-default-model",
    codexThreadId: "visible-task",
    cwd: "C:\\repo",
    prompt: "review prompt",
    task: "Review the implementation",
    model: "   ",
    effort: "xhigh",
  });
  assert.ok(!fake.calls[0]!.args.includes("-m"));
  assert.ok(fake.calls[0]!.args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(!fake.calls[1]!.args.includes("-m"));
  assert.ok(fake.calls[1]!.args.includes('model_reasoning_effort="low"'));
});

test("authority alignment is ephemeral, uses the configured model at low effort, and never resumes", async () => {
  const fake = spawned([{ stdout: agentMessage(JSON.stringify({ aligned: true, conflicts: [] })) }]);
  const audit = dispatcher(fake.spawn);
  const result = await audit.align({
    result: PASS_REVIEW,
    task: "Task",
    cwd: "C:\\repo",
    workflowId: "wf-align",
    model: "gpt-5.6",
    prompt: "alignment prompt",
  });
  assert.equal(result.aligned, true);
  const args = fake.calls[0]!.args;
  assert.ok(args.includes("--ephemeral"));
  assert.deepEqual(args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2), ["--output-schema", "alignment-schema.json"]);
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.6"]);
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(!args.includes("resume"));
});

test("CLI audit preserves invalid-thread, process-error and no-final-message classifications", async () => {
  const invalid = spawned([{ stdout: "", stderr: "No rollout found for thread id old-task", code: 1 }]);
  await assert.rejects(
    dispatcher(invalid.spawn).review({ workflowId: "wf-invalid", submissionId: "sub", codexThreadId: "old-task", cwd: "C:\\repo", prompt: "review" }),
    CodexInvalidThreadError,
  );

  const processFailure = spawned([{ stdout: "", stderr: "authentication failed", code: 2 }]);
  await assert.rejects(
    dispatcher(processFailure.spawn).review({ workflowId: "wf-process", submissionId: "sub", codexThreadId: "task", cwd: "C:\\repo", prompt: "review" }),
    CodexCallbackProcessError,
  );

  const noMessage = spawned([{ stdout: JSON.stringify({ type: "turn.completed" }) }]);
  await assert.rejects(
    dispatcher(noMessage.spawn).review({ workflowId: "wf-empty", submissionId: "sub", codexThreadId: "task", cwd: "C:\\repo", prompt: "review" }),
    CodexNoVerdictError,
  );
});

test("CLI audit retries busy results within the retry budget and keeps the final outcome retryable", async () => {
  // 1.1.1: the retry loop is now bounded by the shared TIME budget instead of a
  // hard-coded 9 attempts, so the test drives an injected clock.
  const busy = spawned(Array.from({ length: 3 }, () => ({ stdout: "", stderr: "thread already has an active writer", code: 1 })));
  let clock = 0;
  await assert.rejects(
    dispatcher(busy.spawn, {
      retry: { baseMs: 5, maxMs: 5, budgetMs: 12, jitterRatio: 0 },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }).review({ workflowId: "wf-busy", submissionId: "sub", codexThreadId: "task", cwd: "C:\\repo", prompt: "review" }),
    /codex CLI audit busy/,
  );
  assert.equal(busy.calls.length, 3, "retried until the budget was spent, then stayed retryable");
});

test("CLI audit output overflow kills the child and fails without normalization", async () => {
  const oversized = spawned([{ stdout: agentMessage(VISIBLE_REVIEW.repeat(20)) }]);
  await assert.rejects(
    dispatcher(oversized.spawn, { maxOutputBytes: 64 }).review({ workflowId: "wf-overflow", submissionId: "sub", codexThreadId: "task", cwd: "C:\\repo", prompt: "review" }),
    /exceeded retention bound/,
  );
  assert.equal(oversized.calls.length, 1);
});

test("timeout escalates to SIGKILL and stop observes the confirmed child exit", async () => {
  const signals: Array<NodeJS.Signals | undefined> = [];
  const audit = dispatcher(stubbornSpawn(signals), { timeoutMs: 10, killGraceMs: 5, killKillGraceMs: 20 });
  await assert.rejects(
    audit.review({ workflowId: "wf-timeout", submissionId: "sub", codexThreadId: "task", cwd: "C:\\repo", prompt: "review" }),
    /timed out/,
  );
  assert.deepEqual(signals.slice(0, 2), [undefined, "SIGKILL"]);
  await audit.stop();
});

test("cancelSubmission terminates the matching ephemeral child and stop waits for remaining children", async () => {
  const signals: Array<NodeJS.Signals | undefined> = [];
  const starts: string[] = [];
  const audit = dispatcher(stubbornSpawn(signals, starts), { killGraceMs: 5, killKillGraceMs: 20 });
  const normalization = audit.normalize({
    visibleText: VISIBLE_REVIEW,
    cwd: "C:\\repo",
    workflowId: "wf-lease",
    submissionId: "sub-lease",
  });
  await waitFor(() => starts.length === 1);
  audit.cancelSubmission("wf-lease", "sub-lease");
  await assert.rejects(normalization, /lease lost/);
  assert.deepEqual(signals.slice(0, 2), [undefined, "SIGKILL"]);

  const stoppedChild = audit.normalize({ visibleText: VISIBLE_REVIEW, cwd: "C:\\repo", workflowId: "wf-stop" });
  await waitFor(() => starts.length === 2);
  await audit.stop();
  await assert.rejects(stoppedChild, /dispatcher stopped/);
  assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 2);
});

/** The EXACT upstream reply observed on 2026-09-24 02:24 (see
 * docs/reviewer-thread-lock-2026-09-24.md and transient-retry.ts): a temporary
 * capacity problem that used to be reported as a terminal process failure. */
const OVERLOADED = `${JSON.stringify({ type: "thread.started", thread_id: "01a0cf65-3580-73a1-8565-f89d451b0527" })}\n`
  + `${JSON.stringify({ type: "turn.started" })}\n`
  + `${JSON.stringify({ type: "task_complete", last_agent_message: null, error: { message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" } })}\n`;

test("1.1.1: a server_overloaded audit is RETRIED on the same task and can still produce a verdict", async () => {
  const fake = spawned([
    { stdout: OVERLOADED, code: 1 },
    { stdout: agentMessage(VISIBLE_REVIEW) },
    { stdout: agentMessage(JSON.stringify(PASS_REVIEW)) },
  ]);
  const sleeps: number[] = [];
  const audit = dispatcher(fake.spawn, {
    retry: { baseMs: 5, maxMs: 5, budgetMs: 60_000, jitterRatio: 0 },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const result = await audit.review({
    workflowId: "wf-overload",
    submissionId: "sub-overload",
    codexThreadId: "reviewer-task",
    cwd: "C:\\repo",
    prompt: "review prompt",
    task: "Review the implementation",
  });
  assert.equal(result.kind, "verdict");
  assert.equal(result.verdict.verdict, "pass");
  assert.deepEqual(sleeps, [5], "the transient failure backed off once before retrying");
  assert.equal(fake.calls.length, 3, "review retried, then normalization ran");
  // The retry RESUMED the same durable task — it never opened a second one.
  const retried = fake.calls[1]!.args;
  assert.deepEqual(retried.slice(-3), ["resume", "reviewer-task", "-"]);
});

test("1.1.1: an overload that never clears stays RETRYABLE, never a terminal process failure", async () => {
  const fake = spawned([
    { stdout: OVERLOADED, code: 1 },
    { stdout: OVERLOADED, code: 1 },
    { stdout: OVERLOADED, code: 1 },
  ]);
  let clock = 0;
  const audit = dispatcher(fake.spawn, {
    retry: { baseMs: 10, maxMs: 10, budgetMs: 25, jitterRatio: 0 },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  await assert.rejects(
    audit.review({
      workflowId: "wf-overload-always",
      submissionId: "sub-overload-always",
      codexThreadId: "reviewer-task",
      cwd: "C:\\repo",
      prompt: "review prompt",
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof CodexCallbackProcessError), "an exhausted transient retry must NOT be a terminal failure");
      assert.match((error as Error).message, /busy/);
      // The diagnostic keeps the TAIL: the old slice(0, 2048) only kept the
      // head of the JSONL and hid the real reason.
      assert.match((error as Error).message, /at capacity/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 3, "retried until the budget ran out");
});

test("1.1.1: a NON-transient process failure is not retried", async () => {
  const fake = spawned([{ stdout: "boom: unexpected tool use", code: 1 }]);
  const sleeps: number[] = [];
  const audit = dispatcher(fake.spawn, {
    retry: { baseMs: 5, maxMs: 5, budgetMs: 60_000, jitterRatio: 0 },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await assert.rejects(
    audit.review({
      workflowId: "wf-terminal",
      submissionId: "sub-terminal",
      codexThreadId: "reviewer-task",
      cwd: "C:\\repo",
      prompt: "review prompt",
    }),
    CodexCallbackProcessError,
  );
  assert.equal(fake.calls.length, 1, "terminal failures fail fast, exactly as before");
  assert.deepEqual(sleeps, []);
});

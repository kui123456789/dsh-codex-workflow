import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { CodexCliAuditDispatcher, extractAgentMessage } from "../src/codex-cli-audit.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "../src/codex-callback.js";

const PASS_REVIEW = { verdict: "pass" as const, findings: [], testGaps: [], summary: "ok" };
const VISIBLE_REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ok";

function agentMessage(text: string): string {
  return `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`;
}

function spawned(responses: Array<{ stdout: string; stderr?: string; code?: number }>) {
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
      stdout.end(response.stdout);
      stderr.end(response.stderr ?? "");
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

test("CLI audit retries busy results and keeps the final busy outcome retryable", async () => {
  const busy = spawned(Array.from({ length: 10 }, () => ({ stdout: "", stderr: "thread already has an active writer", code: 1 })));
  await assert.rejects(
    dispatcher(busy.spawn, { retryBaseMs: 0 }).review({ workflowId: "wf-busy", submissionId: "sub", codexThreadId: "task", cwd: "C:\\repo", prompt: "review" }),
    /codex CLI audit busy/,
  );
  assert.equal(busy.calls.length, 10);
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

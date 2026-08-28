import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "../src/schemas.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

function client() {
  return new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
  });
}

test("starts a read-only planning thread and collects structured output", async () => {
  const codex = client();
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Test plan" });
    const result = await codex.startTurn(threadId, {
      prompt: "Plan it",
      planMode: true,
      outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });
    assert.equal(result.kind, "completed");
    assert.match(result.kind === "completed" ? result.text : "", /proposed_plan/);
    // 1.0.7: a completed turn reports the FINAL visible item type so the
    // planner contract can distinguish Plan-mode `plan` items from plain
    // agentMessages (the fake server emits agentMessage items).
    assert.equal(result.kind === "completed" ? result.itemType : undefined, "agentMessage");
  } finally {
    await codex.stop();
  }
});

test("startTurn invokes onStarted with the turn id before waiting for completion", async () => {
  const codex = client();
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "onStarted plan" });
    const started: Array<{ threadId: string; turnId: string }> = [];
    const result = await codex.startTurn(threadId, {
      prompt: "Plan it",
      planMode: true,
      outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      onStarted: (entry) => {
        started.push(entry);
      },
    });
    assert.equal(result.kind, "completed");
    assert.equal(started.length, 1);
    assert.equal(started[0]?.threadId, threadId);
    assert.ok(started[0]?.turnId);
  } finally {
    await codex.stop();
  }
});

test("startTurn interrupts the turn when onStarted fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-onstarted-turn-"));
  const marker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_INTERRUPT_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Failing onStarted" });
    await assert.rejects(codex.startTurn(threadId, {
      prompt: "Plan it",
      planMode: true,
      outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      onStarted: async () => { throw new Error("onStarted failed"); },
    }), /onStarted failed/);
    await waitForFile(marker);
    const [thread, turn] = (await readFile(marker, "utf8")).trim().split(":");
    assert.equal(thread, threadId);
    assert.ok(turn);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startReview interrupts the reviewer turn when onStarted fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-onstarted-review-"));
  const marker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_INTERRUPT_MARKER: marker },
  });
  try {
    const planner = await codex.startThread({ cwd: process.cwd(), name: "Review source" });
    await assert.rejects(codex.startReview({
      threadId: planner,
      cwd: process.cwd(),
      target: { type: "custom", instructions: "Review it" },
      detached: true,
      onStarted: async () => { throw new Error("onStarted failed"); },
    }), /onStarted failed/);
    await waitForFile(marker);
    const [thread, turn] = (await readFile(marker, "utf8")).trim().split(":");
    assert.notEqual(thread, planner, "interrupt must target the detached reviewer thread");
    assert.ok(turn);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startReview interrupts the reviewer turn when thread settings fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-settingsfail-"));
  const marker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_FAIL_SETTINGS: "1",
      FAKE_CODEX_INTERRUPT_MARKER: marker,
    },
  });
  try {
    const planner = await codex.startThread({ cwd: process.cwd(), name: "Review source" });
    await assert.rejects(codex.startReview({
      threadId: planner,
      cwd: process.cwd(),
      target: { type: "custom", instructions: "Review it" },
      detached: true,
    }), /settings failed/);
    await waitForFile(marker);
    const [thread, turn] = (await readFile(marker, "utf8")).trim().split(":");
    assert.notEqual(thread, planner, "interrupt must target the detached reviewer thread");
    assert.ok(turn);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridges request_user_input and resumes the same turn", async () => {
  const codex = client();
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Question plan" });
    const paused = await codex.startTurn(threadId, { prompt: "ASK_INPUT", planMode: true });
    assert.equal(paused.kind, "needs_input");
    if (paused.kind !== "needs_input") return;
    assert.equal(paused.request.questions[0]?.id, "scope");
    const completed = await codex.continueTurn(paused, { scope: ["Focused"] });
    assert.equal(completed.kind, "completed");
    assert.match(completed.kind === "completed" ? completed.text : "", /Answered plan/);
  } finally {
    await codex.stop();
  }
});

test("idle shutdown waits for an active turn and releases the task after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-turn-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 50,
    env: {
      ...process.env,
      FAKE_CODEX_PROCESS_MARKER: marker,
      FAKE_CODEX_TURN_DELAY_MS: "250",
    },
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Idle release" });
    const turn = codex.startTurn(threadId, { prompt: "Slow plan", planMode: true });
    const pid = Number(await readFile(marker, "utf8"));
    await sleep(125);
    assert.equal(processAlive(pid), true, "idle timer must not kill a running turn");
    const completed = await turn;
    assert.equal(completed.kind, "completed");
    await waitForProcessExit(pid);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle shutdown keeps a clarification turn alive until answers are submitted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-input-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 50,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Idle clarification" });
    const paused = await codex.startTurn(threadId, { prompt: "ASK_INPUT", planMode: true });
    assert.equal(paused.kind, "needs_input");
    if (paused.kind !== "needs_input") return;
    const pid = Number(await readFile(marker, "utf8"));
    await sleep(125);
    assert.equal(processAlive(pid), true, "pending clarification must retain its App Server");
    const completed = await codex.continueTurn(paused, { scope: ["Focused"] });
    assert.equal(completed.kind, "completed");
    await waitForProcessExit(pid);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle shutdown releases an interrupted turn even without a completion event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-interrupt-"));
  const processMarker = join(directory, "process.txt");
  const interruptMarker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 50,
    env: {
      ...process.env,
      FAKE_CODEX_PROCESS_MARKER: processMarker,
      FAKE_CODEX_INTERRUPT_MARKER: interruptMarker,
    },
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Idle interrupted" });
    const controller = new AbortController();
    const turn = codex.startTurn(threadId, {
      prompt: "HANG",
      onStarted: () => controller.abort(new Error("cancelled")),
    }, controller.signal);
    const rejected = assert.rejects(turn, /cancelled/);
    const pid = Number(await readFile(processMarker, "utf8"));
    await rejected;
    await waitForFile(interruptMarker);
    await waitForProcessExit(pid);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("starts a detached review and normalizes its result", async () => {
  const codex = client();
  try {
    const planner = await codex.startThread({ cwd: process.cwd(), name: "Review source" });
    const review = await codex.startReview({
      threadId: planner,
      cwd: process.cwd(),
      target: { type: "custom", instructions: "Review the current changes" },
      detached: true,
    });
    assert.notEqual(review.threadId, planner);
    assert.equal(review.result.kind, "completed");
    const normalized = await codex.startTurn(review.threadId, {
      prompt: "Normalize",
      outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });
    const text = normalized.kind === "completed" ? normalized.text : "";
    assert.match(text, /"verdict":"pass"/);
    // New review schema round-trips the blocking flag on findings.
    assert.match(text, /"blocking":true/);
  } finally {
    await codex.stop();
  }
});

test("normalizeInFork forks ephemeral and converts with safe low-effort settings, unsubscribing exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-fork-ok-"));
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
  try {
    const source = await codex.startThread({ cwd: directory, name: "Plan source" });
    const started: Array<{ threadId: string; turnId: string }> = [];
    const converted = await codex.normalizeInFork({
      threadId: source,
      cwd: directory,
      prompt: "Convert the plan",
      model: "source-model",
      outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      onStarted: (entry) => { started.push(entry); },
    });
    assert.equal(converted.kind, "completed", "the fork conversion completes with the schema output");
    assert.match(converted.kind === "completed" ? converted.text : "", /"verdict":"pass"/);
    const forkThread = started[0]?.threadId;
    assert.ok(forkThread);
    assert.notEqual(forkThread, source, "the conversion runs on a NEW fork thread");

    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const forks = calls.filter((call) => call.method === "thread/fork");
    assert.equal(forks.length, 1);
    assert.equal(forks[0]?.params.threadId, source, "the fork is created from the persistent source task");
    assert.equal(forks[0]?.params.ephemeral, true, "the conversion fork is ALWAYS ephemeral");
    assert.equal(forks[0]?.params.cwd, directory);
    assert.deepEqual(forks[0]?.params.runtimeWorkspaceRoots, [directory]);

    const turn = calls.find((call) => call.method === "turn/start");
    assert.equal(turn?.params.threadId, forkThread);
    assert.ok(turn?.params.outputSchema?.properties?.verdict, "the conversion turn carries the output schema");
    assert.equal(turn?.params.model, "source-model", "the fork reuses the SAME model as the source task");
    assert.equal(turn?.params.effort, "low", "conversion effort is fixed at low");
    // Per-turn safety settings: read-only, network disabled, approval never.
    assert.equal(turn?.params.approvalPolicy, "never");
    assert.deepEqual(turn?.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(turn?.params.collaborationMode?.mode, "default");
    assert.match(turn?.params.collaborationMode?.settings?.developer_instructions, /JSON object conforming to the enforced output schema/);
    assert.equal(turn?.params.collaborationMode?.settings?.model, "source-model");
    assert.equal(turn?.params.collaborationMode?.settings?.reasoning_effort, "low");

    // Exactly one unsubscribe — the fork is released once on success.
    const unsubs = calls.filter((call) => call.method === "thread/unsubscribe");
    assert.equal(unsubs.length, 1, "the ephemeral fork is unsubscribed exactly once on success");
    assert.equal(unsubs[0]?.params.threadId, forkThread, "the fork (never the source) is unsubscribed");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizeInFork interrupts the fork and unsubscribes exactly once when onStarted fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-fork-onstarted-"));
  const marker = join(directory, "interrupt.txt");
  const callsFile = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile,
      FAKE_CODEX_INTERRUPT_MARKER: marker,
    },
  });
  try {
    const source = await codex.startThread({ cwd: directory, name: "Plan source" });
    await assert.rejects(codex.normalizeInFork({
      threadId: source,
      cwd: directory,
      prompt: "Convert",
      outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      onStarted: async () => { throw new Error("onStarted failed"); },
    }), /onStarted failed/);
    await waitForFile(marker);
    const [thread, turn] = (await readFile(marker, "utf8")).trim().split(":");
    assert.notEqual(thread, source, "the interrupt targets the FORK turn, never the source task");
    assert.ok(turn);
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    assert.equal(calls.filter((call) => call.method === "thread/unsubscribe").length, 1, "onStarted failure still releases the fork exactly once");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizeInFork interrupts the fork and unsubscribes exactly once on cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-fork-cancel-"));
  const marker = join(directory, "interrupt.txt");
  const callsFile = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile,
      FAKE_CODEX_INTERRUPT_MARKER: marker,
    },
  });
  try {
    const source = await codex.startThread({ cwd: directory, name: "Plan source" });
    const controller = new AbortController();
    let forkThread = "";
    const converting = codex.normalizeInFork({
      threadId: source,
      cwd: directory,
      prompt: "HANG",
      outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      onStarted: (started) => { forkThread = started.threadId; controller.abort(new Error("cancelled during conversion")); },
    }, controller.signal);
    await assert.rejects(converting, /cancelled during conversion/);
    assert.ok(forkThread);
    assert.notEqual(forkThread, source);
    await waitForFile(marker);
    const [thread, turn] = (await readFile(marker, "utf8")).trim().split(":");
    assert.equal(thread, forkThread, "cancellation interrupts the actual active FORK turn");
    assert.ok(turn);
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    assert.equal(calls.filter((call) => call.method === "thread/unsubscribe").length, 1, "cancellation still releases the fork exactly once");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizeInFork unsubscribes exactly once when the fork turn fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-fork-failed-"));
  const callsFile = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: {
      ...process.env,
      FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile,
      FAKE_CODEX_TURN_STATUS: "interrupted",
    },
  });
  try {
    const source = await codex.startThread({ cwd: directory, name: "Plan source" });
    const result = await codex.normalizeInFork({
      threadId: source,
      cwd: directory,
      prompt: "Convert",
      outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });
    assert.equal(result.kind, "completed");
    if (result.kind === "completed") assert.equal(result.status, "interrupted", "a failed fork turn is surfaced, never a verdict");
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    assert.equal(calls.filter((call) => call.method === "thread/unsubscribe").length, 1, "a failed fork turn still releases the fork exactly once");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizeInFork unsubscribes exactly once when the fork turn times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-fork-timeout-"));
  const callsFile = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 2_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile },
  });
  try {
    const source = await codex.startThread({ cwd: directory, name: "Plan source" });
    await assert.rejects(codex.normalizeInFork({
      threadId: source,
      cwd: directory,
      prompt: "HANG",
      outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    }), /Codex turn timed out/);
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    assert.equal(calls.filter((call) => call.method === "thread/unsubscribe").length, 1, "a timed-out fork turn still releases the fork exactly once");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle shutdown waits for BOTH concurrent turns; the App Server stops only after the last", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-two-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 80,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker, FAKE_CODEX_SLOW_DELAY_MS: "700" },
  });
  try {
    const ta = await codex.startThread({ cwd: process.cwd(), name: "Slow reviewer" });
    const tb = await codex.startThread({ cwd: process.cwd(), name: "Fast reviewer" });
    const pid = Number(await readFile(marker, "utf8"));
    // The slow turn is still running while the fast one completes.
    const slow = codex.startTurn(ta, { prompt: "SLOW Plan it" });
    const fast = await codex.startTurn(tb, { prompt: "Plan it" });
    assert.equal(fast.kind, "completed");
    // The fast review completed but the slow one is still active: the shared
    // App Server must NOT be stopped in the meantime.
    await sleep(250);
    assert.equal(processAlive(pid), true, "completing one review must not stop the App Server while another runs");
    await slow;
    await waitForProcessExit(pid);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumes a persisted Reviewer thread id after the App Server restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-restart-"));
  try {
    const first = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 5_000,
      idleProcessMs: 0,
    });
    const reviewerId = await first.startReviewerThread({ cwd: process.cwd(), name: "Durable Reviewer" });
    await first.stop(); // the managed App Server "restarts"

    const second = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 5_000,
      idleProcessMs: 0,
    });
    try {
      // Re-review resumes the EXACT persisted Reviewer id after restart.
      await second.resumeThread(reviewerId, process.cwd());
      const result = await second.startTurn(reviewerId, { prompt: "Plan it" });
      assert.equal(result.kind, "completed");
      assert.equal(await second.unsubscribeThread(reviewerId), "unsubscribed");
      assert.equal(await second.unsubscribeThread(reviewerId), "notSubscribed");
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses strict Codex-compatible object schemas", () => {
  assertStrictObjectSchema(PLANNER_OUTPUT_SCHEMA);
  assertStrictObjectSchema(REVIEW_OUTPUT_SCHEMA);
});

test("interrupts an active Codex turn when DSH cancels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-interrupt-"));
  const marker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_INTERRUPT_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Cancelled turn" });
    const controller = new AbortController();
    const turn = codex.startTurn(threadId, { prompt: "HANG" }, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled by DSH")), 50);
    await assert.rejects(turn, /cancelled by DSH/);
    await waitForFile(marker);
    assert.match(await readFile(marker, "utf8"), /^thread-\d+:turn-\d+$/);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupts an active Codex turn when it times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-timeout-"));
  const marker = join(directory, "interrupt.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    // This timeout also covers process startup and initialize. Keep it long
    // enough for a loaded Windows CI host while still proving the hung turn is
    // interrupted by the client's own timeout.
    requestTimeoutMs: 2_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_INTERRUPT_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Timed out turn" });
    await assert.rejects(codex.startTurn(threadId, { prompt: "HANG" }), /Codex turn timed out/);
    await waitForFile(marker);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds planner and reviewer threads to the DSH workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workspace-"));
  const marker = join(directory, "thread-params.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_THREAD_PARAMS_MARKER: marker },
  });
  try {
    const planner = await codex.startThread({ cwd: directory, name: "Workspace plan" });
    const review = await codex.startReview({
      threadId: planner,
      cwd: directory,
      target: { type: "custom", instructions: "Review it" },
      detached: true,
    });
    await codex.resumeThread(review.threadId, directory);
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, unknown>;
    });
    const start = calls.find((call) => call.method === "thread/start");
    const settings = calls.find((call) => call.method === "thread/settings/update");
    const resume = calls.find((call) => call.method === "thread/resume");
    assert.deepEqual(start?.params.runtimeWorkspaceRoots, [directory]);
    assert.equal(settings?.params.cwd, directory);
    assert.deepEqual(resume?.params.runtimeWorkspaceRoots, [directory]);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsubscribeThread is idempotent, never deletes the thread, and distinguishes notLoaded", async () => {
  const codex = client();
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Unsubscribe probe" });
    // First release: we were the subscribed writer -> unsubscribed.
    assert.equal(await codex.unsubscribeThread(threadId), "unsubscribed");
    // Idempotent duplicate on a loaded-but-not-subscribed thread -> notSubscribed.
    assert.equal(await codex.unsubscribeThread(threadId), "notSubscribed");
    // A thread the App Server has never loaded -> notLoaded (still success, no
    // writer hold to release), matching the real `ThreadUnsubscribeResponse`.
    assert.equal(await codex.unsubscribeThread("00000000-0000-0000-0000-000000000000"), "notLoaded");
    // The persisted thread is not deleted or archived: a later turn still runs.
    const result = await codex.startTurn(threadId, { prompt: "Plan it" });
    assert.equal(result.kind, "completed");
  } finally {
    await codex.stop();
  }
});

test("stop() drains the app-server stdin gracefully and the process exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-graceful-stop-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    quitGraceMs: 3_000,
    killGraceMs: 1_000,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    await codex.startThread({ cwd: process.cwd(), name: "Graceful stop" });
    const pid = Number(await readFile(marker, "utf8"));
    await codex.stop();
    assert.equal(processAlive(pid), false, "graceful stop must let the app-server exit on stdin EOF");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("control RPCs use their own tighter timeout: a slow RPC is cut short, never the host budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-rpc-timeout-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 30_000,
    rpcTimeoutMs: 800,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_RPC_DELAY_MS: "2000" },
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(codex.startThread({ cwd: directory, name: "Slow RPC" }), /Codex request timed out/);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 10_000, `an RPC timeout must settle in ~800ms, took ${elapsed}ms`);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("control RPCs within the rpc timeout complete normally despite delays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-rpc-ok-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 10_000,
    rpcTimeoutMs: 2_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_RPC_DELAY_MS: "300" },
  });
  try {
    const threadId = await codex.startThread({ cwd: directory, name: "Delayed RPC" });
    const result = await codex.startTurn(threadId, { prompt: "Plan it", planMode: true });
    assert.equal(result.kind, "completed");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop() settles a pending turn waiter immediately (teardown never waits out the turn timeout)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-stop-pending-"));
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 60_000,
    idleProcessMs: 0,
  });
  try {
    const threadId = await codex.startThread({ cwd: directory, name: "Pending turn" });
    const pending = codex.startTurn(threadId, { prompt: "HANG" });
    await sleep(120); // the turn is genuinely running inside waitForTurn now
    // Attach the rejection handler BEFORE stop() so the settle is observed,
    // never an unhandled rejection.
    const pendingAssertion = assert.rejects(pending, /Codex app-server stopped/);
    const startedAt = Date.now();
    await codex.stop();
    await pendingAssertion;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 10_000, `stop must settle the waiter immediately (not after the 60s turn timeout), took ${elapsed}ms`);
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("planMode resolves a concrete model and onModel reports the effective model for reuse", async () => {
  const codex = client();
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), name: "Plan model" });
    const reported: string[] = [];
    const result = await codex.startTurn(threadId, {
      prompt: "Plan it",
      planMode: true,
      onModel: (model) => reported.push(model),
    });
    assert.equal(result.kind, "completed");
    // The Plan collaboration mode's model is resolved and reported even
    // though NO explicit model was configured — the ephemeral conversion fork
    // can therefore reuse the SAME effective model.
    assert.deepEqual(reported, ["fake-model"]);
    // An explicit model wins and is reported as-is.
    const reportedExplicit: string[] = [];
    await codex.startTurn(threadId, { prompt: "Plan it", model: "explicit-model", planMode: true, onModel: (m) => reportedExplicit.push(m) });
    assert.deepEqual(reportedExplicit, ["explicit-model"]);
  } finally {
    await codex.stop();
  }
});

test("a Plan-mode turn/start carries the plan collaboration mode on the wire", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-planmode-wire-"));
  const marker = join(directory, "calls.jsonl");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_THREAD_PARAMS_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: directory, name: "Plan wire" });
    await codex.startTurn(threadId, { prompt: "Plan it", planMode: true });
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, any>;
    });
    const turn = calls.find((call) => call.method === "turn/start");
    assert.equal(turn?.params.collaborationMode?.mode, "plan", "Plan mode is the wire contract for the visible planner turn");
    assert.equal(turn?.params.collaborationMode?.settings?.model, "fake-model");
    assert.equal(turn?.params.collaborationMode?.settings?.reasoning_effort, "high", "the Plan collaboration mode's own effort");
    assert.equal(turn?.params.outputSchema, undefined, "no outputSchema on the visible Planner turn");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop() with a live turn waiter never respawns the App Server and leaves no child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-stop-norestart-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 60_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: directory, name: "Live waiter" });
    const pending = codex.startTurn(threadId, { prompt: "HANG" });
    await sleep(120); // the turn is genuinely running: a live waiter is registered
    const pid = Number(await readFile(marker, "utf8"));
    // Handler attached BEFORE stop so the settle is observed, never unhandled.
    const pendingAssertion = assert.rejects(pending, /Codex app-server stopped/);
    await codex.stop();
    await pendingAssertion;
    // The waiter settle during stop() must NOT have crashed into a fresh
    // start()/respawn: any replacement child would have overwritten the
    // process marker with ITS pid.
    await sleep(400);
    const after = Number((await readFile(marker, "utf8")).trim());
    assert.equal(after, pid, "stop() must never respawn a replacement App Server (marker pid changed)");
    await waitForProcessExit(pid); // the ORIGINAL child is gone: no leftover
    // stop() is idempotent AND post-stop start/request FAIL explicitly instead
    // of restarting the process.
    await codex.stop();
    await assert.rejects(codex.startThread({ cwd: directory, name: "Late caller" }), /Codex app-server stopped/);
    const still = Number((await readFile(marker, "utf8")).trim());
    assert.equal(still, pid, "a post-stop start must never spawn a process");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent stop() calls share ONE teardown: both settle only after the old child exits, no replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-stop-singleflight-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 60_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    const threadId = await codex.startThread({ cwd: directory, name: "Single flight" });
    const pending = codex.startTurn(threadId, { prompt: "HANG" });
    await sleep(120); // live waiter registered so the teardown has work to settle
    const pid = Number(await readFile(marker, "utf8"));
    const pendingAssertion = assert.rejects(pending, /Codex app-server stopped/);
    const first = codex.stop();
    const second = codex.stop();
    // Deterministic single-flight: both callers await the SAME promise, so the
    // second can never resolve before the first finishes tearing down.
    assert.strictEqual(second, first, "concurrent stop() calls share ONE settle promise");
    let doneBeforeExit = false;
    void first.then(() => { doneBeforeExit = processAlive(pid); });
    await Promise.all([first, second, pendingAssertion]);
    assert.equal(doneBeforeExit, false, "stop() settles only AFTER the old child exited");
    await waitForProcessExit(pid); // the ORIGINAL child is gone: no leftover
    // Repeated stop() after completion stays idempotent on the same promise.
    const third = codex.stop();
    assert.strictEqual(third, first, "stop() stays idempotent after completion");
    // No replacement child was ever spawned.
    const after = Number((await readFile(marker, "utf8")).trim());
    assert.equal(after, pid, "no replacement App Server child was spawned");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle shutdown is recoverable: the child exits but the next health() respawns a fresh App Server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-recoverable-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 50,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    // health() starts the App Server; with nothing else outstanding the client
    // goes idle and the RECOVERABLE idle shutdown closes the child.
    await codex.health();
    const firstPid = Number(await readFile(marker, "utf8"));
    await waitForProcessExit(firstPid);
    // The client was NOT permanently stopped (1.0.7 regression: an idle close
    // used to latch the client forever with "Codex app-server stopped"): the
    // very next call spawns a FRESH App Server and succeeds.
    await codex.health();
    const secondPid = Number(await readFile(marker, "utf8"));
    assert.notEqual(secondPid, firstPid, "idle shutdown must be followed by a NEW App Server process");
    assert.equal(processAlive(secondPid), true);
    // A completed RPC on the respawned server works and no THIRD process
    // appears while the replacement is healthy.
    await codex.health();
    assert.equal(Number((await readFile(marker, "utf8")).trim()), secondPid, "no third process may be spawned while the replacement is healthy");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("start() racing an in-flight idle shutdown waits for the old child and spawns exactly ONE replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-race-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    quitGraceMs: 1_000,
    killGraceMs: 1_000,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    await codex.health();
    const firstPid = Number(await readFile(marker, "utf8"));
    const internals = codex as unknown as { idleShutdown(): Promise<void> };
    // Begin the RECOVERABLE idle shutdown and race it with TWO concurrent
    // start()-driven calls: both must WAIT for the old child to exit, then
    // share ONE replacement spawn.
    const shuttingDown = internals.idleShutdown();
    const concurrent = await Promise.all([codex.health(), codex.health()]);
    await shuttingDown;
    assert.equal(concurrent.length, 2);
    await waitForProcessExit(firstPid);
    const secondPid = Number((await readFile(marker, "utf8")).trim());
    assert.notEqual(secondPid, firstPid, "a fresh App Server replaced the idle-closed one");
    assert.equal(processAlive(secondPid), true);
    // The race settled: exactly ONE replacement may exist, never more.
    await sleep(300);
    assert.equal(Number((await readFile(marker, "utf8")).trim()), secondPid, "exactly ONE replacement may be spawned by the race");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle shutdown then final stop(): the permanent teardown still latches and refuses restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-idle-then-stop-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    await codex.health();
    const pid = Number(await readFile(marker, "utf8"));
    // Recoverable idle shutdown completes first; the client stays usable.
    await (codex as unknown as { idleShutdown(): Promise<void> }).idleShutdown();
    await waitForProcessExit(pid);
    // The FINAL stop still latches the client: no restart is possible after.
    await codex.stop();
    await assert.rejects(codex.health(), /Codex app-server stopped/, "the FINAL stop must still refuse any restart");
    assert.equal(Number((await readFile(marker, "utf8")).trim()), pid, "no process may ever be spawned after the final stop");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("final stop() colliding with an in-flight idle shutdown stays single-flight with no leftover child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-stop-idle-race-"));
  const marker = join(directory, "process.txt");
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    idleProcessMs: 0,
    quitGraceMs: 1_000,
    killGraceMs: 1_000,
    env: { ...process.env, FAKE_CODEX_PROCESS_MARKER: marker },
  });
  try {
    await codex.health();
    const pid = Number(await readFile(marker, "utf8"));
    const internals = codex as unknown as { idleShutdown(): Promise<void> };
    const shuttingDown = internals.idleShutdown();
    // The final stop lands WHILE the recoverable idle shutdown closes the
    // child: it must WAIT for that close, stay single-flight, and leave no
    // child behind.
    const first = codex.stop();
    const second = codex.stop();
    assert.strictEqual(second, first, "concurrent final stop() calls share ONE settle promise");
    await Promise.all([first, second, shuttingDown]);
    await waitForProcessExit(pid);
    // No replacement was ever spawned and the latch refuses restarts.
    await sleep(300);
    assert.equal(Number((await readFile(marker, "utf8")).trim()), pid, "no replacement App Server may be spawned by the race");
    await assert.rejects(codex.health(), /Codex app-server stopped/);
    const third = codex.stop();
    assert.strictEqual(third, first, "stop() stays idempotent after the idle-shutdown collision");
  } finally {
    await codex.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function assertStrictObjectSchema(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const value = schema as Record<string, unknown>;
  if (value.type === "object") {
    const properties = value.properties as Record<string, unknown> | undefined;
    assert.deepEqual(value.required, Object.keys(properties ?? {}));
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(assertStrictObjectSchema);
    else assertStrictObjectSchema(child);
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (!processAlive(pid)) return;
    if (Date.now() > deadline) break;
    await sleep(25);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

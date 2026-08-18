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
      target: { type: "uncommittedChanges" },
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
      target: { type: "uncommittedChanges" },
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

test("starts a detached review and normalizes its result", async () => {
  const codex = client();
  try {
    const planner = await codex.startThread({ cwd: process.cwd(), name: "Review source" });
    const review = await codex.startReview({
      threadId: planner,
      cwd: process.cwd(),
      target: { type: "uncommittedChanges" },
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
    requestTimeoutMs: 200,
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

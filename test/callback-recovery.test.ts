import assert from "node:assert/strict";
import test from "node:test";
import type { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import type { CodexCallbackRequest } from "../src/codex-callback.js";
import type { TurnWaitResult } from "../src/types.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Requirements verified.";
const VERDICT = { verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified." };

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { enter = resolve; });
  return { started, enter, release,
    async wait(signal?: AbortSignal): Promise<void> {
      enter();
      signal?.throwIfAborted();
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error("operation aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try { await Promise.race([promise, aborted]); }
      finally { signal?.removeEventListener("abort", onAbort); }
    },
  };
}

type Gate = ReturnType<typeof gate>;
interface ScriptStep { fail?: boolean; hold?: Gate; text?: string; error?: string; loseThread?: boolean; }

/** No model process or disk I/O: only the dispatcher's lifecycle and protocol are under test. */
class ScriptedCallbackClient {
  readonly created: string[] = [];
  readonly resumed: string[] = [];
  readonly unsubscribed: string[] = [];
  readonly visible: Array<{ threadId: string; prompt: string }> = [];
  readonly turnSignals: Array<AbortSignal | undefined> = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly steps: ScriptStep[] = [];
  readonly creationSignals: Array<AbortSignal | undefined> = [];
  creationGate?: Gate;
  unsubscriptionGate?: Gate;
  pins = 0;
  beginCount = 0;
  endCount = 0;
  threadLost = false;
  conversionFailures = 0;
  conversions = 0;
  private turnNumber = 0;

  beginRound(): void { this.pins += 1; this.beginCount += 1; }
  endRound(): void { this.pins -= 1; this.endCount += 1; }
  isThreadAvailable(): boolean { return !this.threadLost; }
  async startReviewerThread(options: Parameters<CodexAppServerClient["startReviewerThread"]>[0], signal?: AbortSignal): Promise<string> {
    return this.startReviewerThreadShell(options, signal);
  }
  async startReviewerThreadShell(_options: Parameters<CodexAppServerClient["startReviewerThreadShell"]>[0], signal?: AbortSignal): Promise<string> {
    const threadId = `reviewer-${this.created.length + 1}`;
    this.created.push(threadId);
    this.creationSignals.push(signal);
    return threadId;
  }
  async configureReviewerThread(_threadId: string, _options: Parameters<CodexAppServerClient["configureReviewerThread"]>[1], signal?: AbortSignal): Promise<void> {
    await this.creationGate?.wait(signal);
  }
  async resumeThread(threadId: string): Promise<void> { this.resumed.push(threadId); }
  async unsubscribeThread(threadId: string): Promise<void> {
    this.unsubscribed.push(threadId);
    await this.unsubscriptionGate?.wait();
  }
  async interrupt(threadId: string, turnId: string): Promise<void> { this.interrupts.push({ threadId, turnId }); }
  async resolveDefaultModel(): Promise<string> { return "test-model"; }
  async captureTurnBaseline(): Promise<{ ids: string[] }> { return { ids: [] }; }
  async readAppendedTurnText(): Promise<{ text: string }> { return { text: REVIEW }; }
  async normalizeInFork(options: Parameters<CodexAppServerClient["normalizeInFork"]>[0]): Promise<TurnWaitResult> {
    const turnId = `conversion-${++this.turnNumber}`;
    await options.onStarted?.({ threadId: "private-conversion", turnId });
    return { kind: "completed", threadId: "private-conversion", turnId, status: "completed", text: JSON.stringify(VERDICT) };
  }
  async startTurn(threadId: string, options: Parameters<CodexAppServerClient["startTurn"]>[1], signal?: AbortSignal): Promise<TurnWaitResult> {
    const turnId = `turn-${++this.turnNumber}`;
    if (options.conversion) {
      this.conversions += 1;
      await options.onStarted?.({ threadId, turnId });
      if (this.conversionFailures > 0) {
        this.conversionFailures -= 1;
        return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
      }
      return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
    }
    this.visible.push({ threadId, prompt: options.prompt });
    this.turnSignals.push(signal);
    await options.onStarted?.({ threadId, turnId });
    const step = this.steps.shift() ?? {};
    await step.hold?.wait(signal);
    if (step.loseThread) this.threadLost = true;
    if (step.error) throw new Error(step.error);
    return step.fail
      ? { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" }
      : { kind: "completed", threadId, turnId, status: "completed", text: step.text ?? REVIEW };
  }
}

function fixture() {
  const client = new ScriptedCallbackClient();
  const dispatcher = new AppServerCodexCallbackDispatcher(client as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const request: CodexCallbackRequest = {
    workflowId: "workflow", submissionId: "submission", codexThreadId: "origin-thread", cwd: process.cwd(),
    task: "Review the health command", prompt: "INITIAL REVIEW CONTRACT: Inspect the health command and all requirements.",
    ephemeral: true,
  };
  const retain = async () => {
    client.steps.push({ fail: true }, { fail: true });
    assert.equal((await dispatcher.send(request)).kind, "retryable_busy");
    assert.equal(client.created.length, 1);
    assert.equal(client.unsubscribed.length, 0);
    return request;
  };
  return { client, dispatcher, request, retain };
}

test("a repeated submission continues its retained Reviewer with one process pin", async () => {
  const f = fixture();
  try {
    await f.retain();
    assert.equal(f.client.pins, 1);
    f.client.steps.push({ fail: true }, { fail: true });
    assert.equal((await f.dispatcher.send(f.request)).kind, "retryable_busy");
    assert.equal(f.client.pins, 1, "another failed continuation must reuse the existing pin");
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.equal(f.client.created.length, 1);
    assert.ok(f.client.visible.every((turn) => turn.threadId === "reviewer-1"));
    assert.deepEqual(f.client.resumed, [], "a retained ephemeral thread is already loaded");
    assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
    assert.equal(f.client.beginCount, 1);
    assert.equal(f.client.endCount, 1);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

test("automatic and manual callback continuation prompts omit the initial review payload", async () => {
  const f = fixture();
  try {
    await f.retain();
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.equal(f.client.visible.length, 3);
    assert.equal(f.client.visible[0]?.prompt, f.request.prompt);
    for (const turn of f.client.visible.slice(1)) {
      assert.ok(!turn.prompt.includes("INITIAL REVIEW CONTRACT"), "continuation must not re-send the complete original task");
      assert.match(turn.prompt, /继续|continue/i);
      assert.ok(turn.prompt.length < 300);
    }
  } finally { await f.dispatcher.stop(); }
});

test("two identical sends for a submission join one active Reviewer turn", async () => {
  const f = fixture();
  const hold = gate();
  try {
    f.client.steps.push({ hold });
    const first = f.dispatcher.send(f.request);
    await hold.started;
    const second = f.dispatcher.send({ ...f.request });
    const settled = Promise.allSettled([first, second]);
    hold.release();
    const outcomes = await settled;
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"));
    assert.equal(f.client.created.length, 1);
    assert.equal(f.client.visible.length, 1);
    assert.equal(f.client.beginCount, 1);
    assert.equal(f.client.endCount, 1);
    assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
  } finally { hold.release(); await f.dispatcher.stop(); }
});

for (const field of ["prompt", "cwd", "codexThreadId", "task", "model", "effort"] as const) {
  test(`the same submission rejects a changed ${field} before consuming its retained Reviewer`, async () => {
    const f = fixture();
    try {
      await f.retain();
      const changed = { ...f.request, [field]: field === "effort" ? "low" : `different-${field}` } as CodexCallbackRequest;
      const turns = f.client.visible.length;
      await assert.rejects(f.dispatcher.send(changed), /identity|different|changed|mismatch|conflict/i);
      assert.equal(f.client.visible.length, turns);
      assert.equal(f.client.created.length, 1);
      assert.equal(f.client.pins, 1);
      assert.equal((await f.dispatcher.send(f.request)).kind, "verdict", "the matching request can still continue");
    } finally { await f.dispatcher.stop(); }
  });
}

test("an active submission also rejects a mismatched identity before joining its result", async () => {
  const f = fixture();
  const hold = gate();
  try {
    f.client.steps.push({ hold });
    const running = f.dispatcher.send(f.request);
    await hold.started;
    const forbidden = f.dispatcher.send({ ...f.request, codexThreadId: "different-origin" });
    const settled = Promise.allSettled([running, forbidden]);
    hold.release();
    const outcomes = await settled;
    assert.equal(outcomes[0]?.status, "fulfilled");
    assert.equal(outcomes[1]?.status, "rejected", "a mismatched caller cannot receive the active result");
    if (outcomes[1]?.status === "rejected") assert.match(String(outcomes[1].reason), /identity|different|changed|mismatch|conflict/i);
    assert.equal(f.client.visible.length, 1);
  } finally { hold.release(); await f.dispatcher.stop(); }
});

for (const action of ["cancel", "cancelSubmission", "stop"] as const) {
  test(`${action} releases a waiting retained callback Reviewer and pin exactly once`, async () => {
    const f = fixture();
    try {
      await f.retain();
      if (action === "stop") await f.dispatcher.stop();
      else if (action === "cancel") f.dispatcher.cancel(f.request.workflowId);
      else f.dispatcher.cancelSubmission(f.request.workflowId, f.request.submissionId);
      await f.dispatcher.stop();
      assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
      assert.equal(f.client.endCount, 1);
      assert.equal(f.client.pins, 0);
      assert.equal(f.dispatcher.activeReview(f.request.workflowId), false);
    } finally { await f.dispatcher.stop(); }
  });
}

test("stop waits for cancellation's pending retained-thread cleanup without releasing it twice", async () => {
  const f = fixture();
  const hold = gate();
  let cleanupReleased = false;
  try {
    await f.retain();
    f.client.unsubscriptionGate = hold;
    f.dispatcher.cancel(f.request.workflowId);
    await hold.started;
    const stopped = f.dispatcher.stop().then(() => {
      assert.equal(cleanupReleased, true, "stop must await unsubscribe begun by cancel");
    });
    const settled = Promise.allSettled([stopped]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    cleanupReleased = true;
    hold.release();
    const outcome = (await settled)[0]!;
    if (outcome.status === "rejected") throw outcome.reason;
    assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
    assert.equal(f.client.endCount, 1);
    assert.equal(f.client.pins, 0);
  } finally { hold.release(); await f.dispatcher.stop(); }
});

for (const gap of ["creation", "onThread"] as const) {
  test(`cancel during the ${gap} gap prevents the first model turn from starting`, async () => {
    const f = fixture();
    const hold = gate();
    try {
      if (gap === "creation") f.client.creationGate = hold;
      else f.request.onThread = () => hold.wait();
      const running = f.dispatcher.send(f.request);
      const settled = Promise.allSettled([running]);
      await hold.started;
      f.dispatcher.cancel(f.request.workflowId);
      hold.release();
      await settled;
      assert.equal(f.client.visible.length, 0, "the cancellation latch must be checked before turn/start");
      assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
      assert.equal(f.client.endCount, 1);
      assert.equal(f.client.pins, 0);
    } finally { hold.release(); await f.dispatcher.stop(); }
  });
}

test("stop aborts the signal of a waiting send and awaits its transport cleanup", async () => {
  const f = fixture();
  const hold = gate();
  try {
    f.client.steps.push({ hold });
    const running = f.dispatcher.send(f.request);
    const settledSend = Promise.allSettled([running]);
    await hold.started;
    const stopped = f.dispatcher.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const signal = f.client.turnSignals[0];
    hold.release(); // Prevent a broken implementation from leaving the test hanging.
    await Promise.allSettled([stopped, settledSend]);
    assert.equal(signal?.aborted, true, "stop must propagate a lifecycle signal even when send supplied none");
    assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
    assert.equal(f.client.pins, 0);
    await assert.rejects(f.dispatcher.send(f.request), /stopped/);
  } finally { hold.release(); await f.dispatcher.stop(); }
});

test("legacy durable callbacks keep resuming their original dedicated Reviewer", async () => {
  const f = fixture();
  try {
    const result = await f.dispatcher.send({ ...f.request, ephemeral: false, reviewerThreadId: "durable-reviewer" });
    assert.equal(result.kind, "verdict");
    assert.deepEqual(f.client.created, []);
    assert.deepEqual(f.client.resumed, ["durable-reviewer"]);
    assert.equal(f.client.visible[0]?.threadId, "durable-reviewer");
    assert.deepEqual(f.client.unsubscribed, ["durable-reviewer"]);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

test("a conversion retry reuses a validated readable review instead of reviewing the workspace again", async () => {
  const f = fixture();
  try {
    f.client.conversionFailures = 1;
    assert.equal((await f.dispatcher.send(f.request)).kind, "retryable_busy");
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.equal(f.client.visible.length, 1);
    assert.equal(f.client.conversions, 2);
    assert.equal(f.client.created.length, 1);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

test("a timed-out display rewrite cannot cache unchecked text as a valid review", async () => {
  const f = fixture();
  try {
    f.client.steps.push({ text: "Everything looks good." }, { error: "Codex turn timed out: rewrite" });
    assert.equal((await f.dispatcher.send(f.request)).kind, "retryable_busy");
    assert.equal(f.client.conversions, 0);
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.equal(f.client.visible.length, 3, "a valid readable continuation is required before conversion");
    assert.equal(f.client.created.length, 1);
    assert.equal(f.client.conversions, 1);
  } finally { await f.dispatcher.stop(); }
});

test("losing the original ephemeral process cannot turn a retry into a replacement Reviewer", async () => {
  const f = fixture();
  try {
    f.client.steps.push({ fail: true, loseThread: true });
    await assert.rejects(f.dispatcher.send(f.request), /process was lost/);
    await assert.rejects(f.dispatcher.send(f.request), /process was lost/);
    assert.equal(f.client.created.length, 1);
    assert.equal(f.client.visible.length, 1);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

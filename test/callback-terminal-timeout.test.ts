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


for (const detail of ["Schema validation failed: Codex turn timed out: original-turn","permission denied: Codex turn timed out: original-turn","401 Unauthorized: Codex turn timed out: original-turn","no rollout found for thread id: Codex turn timed out: original-turn","violates the display contract: Codex turn timed out: original-turn","concrete unreadable workspace: Codex turn timed out: original-turn"]) test("terminal detail takes priority over embedded timeout: " + detail.split(":")[0], async () => {
  const f = fixture(); let continuations = 0;
  f.request.onContinuation = async () => { continuations++; };
  try {
    f.client.steps.push({ error: detail });
    await assert.rejects(f.dispatcher.send(f.request), error => error instanceof Error
      && (error.message.includes(detail) || detail.startsWith("no rollout found") && /does not exist/.test(error.message)));
    assert.equal(f.client.visible.length, 1, "no second visible model request may run after an original terminal failure");
    assert.equal(continuations, 0); assert.equal(f.client.created.length, 1); assert.equal(f.client.conversions, 0);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});
for (const detail of ["Codex turn timed out: original-turn", "Codex run failed"]) test("original recoverable failure still continues once: " + detail, async () => {
  const f = fixture(); let continuations = 0;
  f.request.onContinuation = async () => { continuations++; };
  try {
    f.client.steps.push({ error: detail }); assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.equal(f.client.visible.length, 2); assert.equal(continuations, 1); assert.equal(f.client.created.length, 1);
    assert(f.client.visible.every(turn => turn.threadId === f.client.visible[0]!.threadId));
  } finally { await f.dispatcher.stop(); }
});

for (const detail of ["Schema validation failed: 429 Too Many Requests", "permission denied: rate limit",
  "403 Forbidden: already has an active writer", "Control RPC timed out: thread/read"]) {
  test("terminal or concrete control detail cannot be parked by a fallback hint: " + detail.split(":")[0], async () => {
    const f = fixture(); let continuations = 0; f.request.onContinuation = async () => { continuations++; };
    try {
      f.client.steps.push({ error: detail });
      await assert.rejects(f.dispatcher.send(f.request), error => error instanceof Error && error.message.includes(detail));
      assert.equal(f.client.visible.length, 1); assert.equal(f.client.conversions, 0); assert.equal(continuations, 0);
      assert.equal(f.client.pins, 0); assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
    } finally { await f.dispatcher.stop(); }
  });
}

test("exhausted generic thrown failures park the same Reviewer without resetting automatic continuation", async () => {
  const f = fixture(); let continuations = 0; f.request.onContinuation = async () => { continuations++; };
  try {
    f.client.steps.push({ error: "Codex run failed" }, { error: "Codex run failed" });
    const waiting = await f.dispatcher.send(f.request); assert.equal(waiting.kind, "retryable_busy");
    assert.equal(f.client.visible.length, 2); assert.equal(continuations, 1); assert.equal(f.client.conversions, 0);
    assert.equal(f.client.created.length, 1); assert.equal(f.client.pins, 1); assert.deepEqual(f.client.unsubscribed, []);
    const resumed = await f.dispatcher.send(f.request); assert.equal(resumed.kind, "verdict");
    assert.equal(f.client.created.length, 1); assert.equal(f.client.visible.length, 3);
    assert(f.client.visible.every(turn => turn.threadId === "reviewer-1"));
    assert(!f.client.visible[2]!.prompt.includes("INITIAL REVIEW CONTRACT")); assert.equal(f.client.pins, 0);
    assert.deepEqual(f.client.unsubscribed, ["reviewer-1"]);
  } finally { await f.dispatcher.stop(); }
});

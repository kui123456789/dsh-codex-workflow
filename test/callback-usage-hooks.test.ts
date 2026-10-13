import assert from "node:assert/strict";
import test from "node:test";
import type { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import type { CodexCallbackRequest } from "../src/codex-callback.js";
import type { TurnWaitResult } from "../src/types.js";

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The implementation follows the approved requirements.";
const VERDICT = { verdict: "pass", findings: [], testGaps: [], summary: "The approved requirements are verified." };

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { started, promise, enter, release };
}

class Client {
  readonly events: string[] = [];
  failures = 0;
  claimError?: Error;
  turnError?: string;
  hold?: ReturnType<typeof gate>;
  pins = 0;
  private turns = 0;
  private threads = 0;
  beginRound(): void { this.pins += 1; }
  endRound(): void { this.pins -= 1; }
  isThreadAvailable(): boolean { return true; }
  async startReviewerThread(): Promise<string> { const id = `reviewer-${++this.threads}`; this.events.push(`create:${id}`); return id; }
  async resumeThread(threadId: string): Promise<void> {
    this.events.push(`resume:${threadId}`);
    if (this.claimError) throw this.claimError;
  }
  async unsubscribeThread(threadId: string): Promise<void> { this.events.push(`unsubscribe:${threadId}`); }
  async interrupt(threadId: string): Promise<void> { this.events.push(`interrupt:${threadId}`); }
  async captureTurnBaseline(): Promise<{ ids: string[] }> { return { ids: [] }; }
  async readAppendedTurnText(): Promise<{ text: string }> { return { text: REVIEW }; }
  async resolveDefaultModel(): Promise<string> { return "test-model"; }
  async startTurn(threadId: string, options: Parameters<CodexAppServerClient["startTurn"]>[1], signal?: AbortSignal): Promise<TurnWaitResult> {
    const turnId = `turn-${++this.turns}`;
    await options.onStarted?.({ threadId, turnId });
    if (options.conversion) return { kind: "completed", threadId, turnId, status: "completed", text: JSON.stringify(VERDICT) };
    this.events.push(`visible:${threadId}`);
    if (this.hold) {
      this.hold.enter();
      if (signal) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("operation aborted"));
          signal.addEventListener("abort", abort, { once: true });
          void this.hold!.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        });
      } else await this.hold.promise;
    }
    if (this.turnError) return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed", error: this.turnError };
    if (this.failures > 0) { this.failures -= 1; return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" }; }
    return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
  }
  async normalizeInFork(options: Parameters<CodexAppServerClient["normalizeInFork"]>[0]): Promise<TurnWaitResult> {
    await options.onStarted?.({ threadId: "private-conversion", turnId: "conversion" });
    return { kind: "completed", threadId: "private-conversion", turnId: "conversion", status: "completed", text: JSON.stringify(VERDICT) };
  }
}

function fixture(ephemeral = true) {
  const client = new Client();
  const dispatcher = new AppServerCodexCallbackDispatcher(client as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const request: CodexCallbackRequest = {
    workflowId: "workflow", submissionId: "submission", codexThreadId: "foreign-origin", cwd: process.cwd(),
    prompt: "Review the implementation against its approved requirements.", task: "Review the implementation", ephemeral,
    onOriginalThread: async (id: string) => { client.events.push(`bind:${id}`); },
    onThreadReleased: async (id: string) => { client.events.push(`flush:${id}`); },
  };
  return { client, dispatcher, request };
}

test("callback usage binds once across retained continuation and flushes before original unsubscribe", async () => {
  const f = fixture();
  try {
    f.client.failures = 2;
    assert.equal((await f.dispatcher.send(f.request)).kind, "retryable_busy");
    assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), ["bind:reviewer-1"]);
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), [
      "bind:reviewer-1", "flush:reviewer-1", "unsubscribe:reviewer-1",
    ]);
    assert.ok(f.client.events.indexOf("bind:reviewer-1") < f.client.events.indexOf("visible:reviewer-1"));
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

test("cancel and stop wait for final usage flush before releasing a retained claim once", async () => {
  for (const action of ["cancel", "stop"] as const) {
    const f = fixture();
    const flush = gate();
    f.request.onThreadReleased = async (id) => { f.client.events.push(`flush:${id}`); flush.enter(); await flush.promise; };
    try {
      f.client.failures = 2;
      await f.dispatcher.send(f.request);
      if (action === "cancel") { f.dispatcher.cancel("workflow"); f.dispatcher.cancel("workflow"); }
      const stopping = f.dispatcher.stop();
      await flush.started;
      assert.equal(f.client.events.some((entry) => entry.startsWith("unsubscribe:")), false);
      flush.release();
      await stopping;
      assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), [
        "bind:reviewer-1", "flush:reviewer-1", "unsubscribe:reviewer-1",
      ]);
      assert.equal(f.client.pins, 0);
    } finally { flush.release(); await f.dispatcher.stop(); }
  }
});

test("usage observation failure never retries a model or blocks owned cleanup", async () => {
  const f = fixture();
  f.request.onOriginalThread = async (id) => { f.client.events.push(`bind:${id}`); throw new Error("metric persistence unavailable"); };
  f.request.onThreadReleased = async (id) => { f.client.events.push(`flush:${id}`); throw new Error("metric final flush unavailable"); };
  try {
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.equal(f.client.events.filter((entry) => entry.startsWith("visible:")).length, 1);
    assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), [
      "bind:reviewer-1", "flush:reviewer-1", "unsubscribe:reviewer-1",
    ]);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

test("terminal model failure still flushes the claimed original thread before release", async () => {
  const f = fixture();
  f.client.turnError = "permission denied";
  try {
    await assert.rejects(f.dispatcher.send(f.request), /permission denied/);
    assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), [
      "bind:reviewer-1", "flush:reviewer-1", "unsubscribe:reviewer-1",
    ]);
  } finally { await f.dispatcher.stop(); }
});

test("active cancellation and teardown flush claimed usage after the model settles and before unsubscribe", async () => {
  for (const action of ["cancel", "stop"] as const) {
    const f = fixture();
    const hold = gate(); f.client.hold = hold;
    try {
      const sending = f.dispatcher.send(f.request);
      await hold.started;
      if (action === "cancel") f.dispatcher.cancel("workflow");
      const stopping = f.dispatcher.stop();
      await Promise.all([sending, stopping]);
      assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), [
        "bind:reviewer-1", "flush:reviewer-1", "unsubscribe:reviewer-1",
      ]);
      assert.equal(f.client.events.filter((entry) => entry.startsWith("visible:")).length, 1);
      assert.equal(f.client.pins, 0);
    } finally { hold.release(); await f.dispatcher.stop(); }
  }
});

test("a successful pre-existing Reviewer claim binds its source and excludes the origin and conversion fork", async () => {
  const f = fixture(false);
  f.request.reviewerThreadId = "existing-reviewer";
  try {
    assert.equal((await f.dispatcher.send(f.request)).kind, "verdict");
    assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), [
      "bind:existing-reviewer", "flush:existing-reviewer", "unsubscribe:existing-reviewer",
    ]);
    assert.equal(f.client.events.some((entry) => entry === "bind:foreign-origin" || entry === "bind:private-conversion"), false);
  } finally { await f.dispatcher.stop(); }
});

test("a failed transient claim never binds or flushes another holder's Reviewer", async () => {
  const f = fixture(false);
  f.request.reviewerThreadId = "foreign-held-reviewer";
  f.client.claimError = new Error("already has an active writer");
  try {
    assert.equal((await f.dispatcher.send(f.request)).kind, "retryable_busy");
    assert.deepEqual(f.client.events.filter((entry) => /bind|flush|unsubscribe/.test(entry)), []);
    assert.equal(f.client.pins, 0);
  } finally { await f.dispatcher.stop(); }
});

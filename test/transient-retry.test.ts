import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelayMs,
  compactDiagnostic,
  isTransientFailure,
  retryTransient,
  TransientRetryExhaustedError,
  transientReason,
} from "../src/transient-retry.js";

test("1.1.1: the incident signature (server_overloaded / at capacity) is transient", () => {
  // The EXACT upstream reply that used to end a workflow terminally.
  assert.equal(isTransientFailure('{"type":"task_complete","error":{"message":"Selected model is at capacity. Please try a different model.","codex_error_info":"server_overloaded"}}'), true);
  assert.equal(transientReason('"codex_error_info":"server_overloaded"'), "overloaded");
  assert.equal(transientReason("Selected model is at capacity."), "overloaded");
  assert.equal(transientReason("codexErrorInfo: serverOverloaded"), "overloaded");

  assert.equal(isTransientFailure("429 Too Many Requests"), true);
  assert.equal(transientReason("429 Too Many Requests"), "rate limit");
  assert.equal(isTransientFailure("rate limit exceeded"), true);
  assert.equal(isTransientFailure("usage limit reached"), true);
  assert.equal(isTransientFailure("502 Bad Gateway"), true);
  assert.equal(isTransientFailure("503 Service Unavailable"), true);
  assert.equal(isTransientFailure("stream disconnected before completion"), true);
  assert.equal(isTransientFailure("thread-store conflict: thread x already has an active writer"), true);
  assert.equal(transientReason("thread x already has an active writer"), "active writer");
});

test("1.1.1: terminal failures are NEVER retried, even when they mention a transient word", () => {
  assert.equal(isTransientFailure("codex thread 01a0 does not exist"), false);
  assert.equal(isTransientFailure("no rollout found for thread id 01a0"), false);
  assert.equal(isTransientFailure("CLI review violates the display contract: missing section"), false);
  assert.equal(isTransientFailure("CLI normalization output invalid: schema"), false);
  assert.equal(isTransientFailure("cancelled by user (latch)"), false);
  // A transient word inside a terminal diagnostic must not win.
  assert.equal(isTransientFailure("no rollout found for thread id 01a0 (rate limit note)"), false);
  assert.equal(transientReason(""), undefined);
});

test("1.1.1: backoff is exponential, capped and jittered within bounds", () => {
  const policy = { baseMs: 1_000, maxMs: 8_000, budgetMs: 60_000, jitterRatio: 0 };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, policy)), [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);

  const jittered = backoffDelayMs(0, { ...policy, jitterRatio: 0.25 }, () => 1);
  assert.equal(jittered, 1_250, "upper jitter bound");
  const low = backoffDelayMs(0, { ...policy, jitterRatio: 0.25 }, () => 0);
  assert.equal(low, 750, "lower jitter bound");
});

test("1.1.1: retryTransient retries transient failures, rethrows terminal ones immediately", async () => {
  const sleeps: number[] = [];
  const policy = { baseMs: 10, maxMs: 100, budgetMs: 10_000, jitterRatio: 0 };
  let attempts = 0;
  const value = await retryTransient(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Selected model is at capacity.");
      return "verdict";
    },
    (error) => transientReason(error instanceof Error ? error.message : String(error)),
    policy,
    { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 },
  );
  assert.equal(value, "verdict");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20], "exponential schedule");

  let terminalAttempts = 0;
  await assert.rejects(
    retryTransient(
      async () => { terminalAttempts += 1; throw new Error("codex thread 01a0 does not exist"); },
      (error) => transientReason(error instanceof Error ? error.message : String(error)),
      policy,
      { sleep: async () => undefined },
    ),
    /does not exist/,
  );
  assert.equal(terminalAttempts, 1, "a terminal failure is never retried");
});

test("1.1.1: the retry budget is bounded and reported, never silently swallowed", async () => {
  const policy = { baseMs: 10, maxMs: 10, budgetMs: 35, jitterRatio: 0 };
  let now = 0;
  const sleeps: number[] = [];
  let attempts = 0;
  await assert.rejects(
    retryTransient(
      async () => { attempts += 1; throw new Error("server_overloaded"); },
      (error) => transientReason(error instanceof Error ? error.message : String(error)),
      policy,
      {
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms; },
        random: () => 0.5,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TransientRetryExhaustedError);
      assert.equal(error.reason, "overloaded");
      return true;
    },
  );
  assert.deepEqual(sleeps, [10, 10, 10], "waits stop before exceeding the 35ms budget");
  assert.equal(attempts, 4, "three backoffs then the final attempt");
});

test("1.1.1: cancellation interrupts a pending backoff immediately", async () => {
  const controller = new AbortController();
  const policy = { baseMs: 5_000, maxMs: 5_000, budgetMs: 60_000, jitterRatio: 0 };
  let attempts = 0;
  const pending = retryTransient(
    async () => { attempts += 1; throw new Error("429 Too Many Requests"); },
    (error) => transientReason(error instanceof Error ? error.message : String(error)),
    policy,
    { sleep: (ms, signal) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("slept the full delay")), ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(pending, /cancelled by user/);
  assert.equal(attempts, 1, "no further attempt starts after cancellation");
});

test("1.1.1: a long diagnostic keeps BOTH ends (the fatal record is the LAST line)", () => {
  const head = "x".repeat(4_000);
  const tail = '{"type":"task_complete","error":{"message":"Selected model is at capacity."}}';
  const compact = compactDiagnostic(`${head}${tail}`, 400);
  assert.ok(compact.length <= 400, `length ${compact.length}`);
  assert.ok(compact.startsWith("x".repeat(50)), "head retained");
  assert.ok(compact.includes("Selected model is at capacity."), "TAIL retained — this is what the old slice(0,2048) hid");
  assert.match(compact, /bytes omitted/);
  assert.equal(compactDiagnostic("short"), "short");
});

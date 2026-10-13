import assert from "node:assert/strict";
import test from "node:test";
import { retryTransient, TransientRetryExhaustedError, transientReason } from "../src/transient-retry.js";

for (const wakeAt of [50, 210]) {
  test(`a retry wake-up at ${wakeAt}ms cannot admit another operation with a 50ms budget`, async () => {
    let clock = 0, attempts = 0;
    const original = new Error("503 Service Unavailable");
    await assert.rejects(retryTransient(async () => {
      attempts++; if (attempts === 1) throw original;
      return "unbudgeted result";
    }, error => transientReason((error as Error).message), { baseMs: 10, maxMs: 10, budgetMs: 50, jitterRatio: 0 },
    { now: () => clock, sleep: async () => { clock = wakeAt; } }), (error: unknown) => {
      assert.ok(error instanceof TransientRetryExhaustedError);
      assert.equal(error.attempts, 1);
      assert.equal(error.lastError, original);
      assert.equal(error.reason, "upstream unavailable");
      return true;
    });
    assert.equal(attempts, 1);
  });
}

test("a retry awake inside its budget admits its next original operation", async () => {
  let clock = 0, attempts = 0;
  const result = await retryTransient(async () => {
    attempts++; if (attempts === 1) throw new Error("server_overloaded");
    return "original result";
  }, error => transientReason((error as Error).message), { baseMs: 10, maxMs: 10, budgetMs: 50, jitterRatio: 0 },
  { now: () => clock, sleep: async () => { clock = 49; } });
  assert.equal(result, "original result");
  assert.equal(attempts, 2);
});

test("cancellation during a late resolved sleep keeps its original cause ahead of retry exhaustion", async () => {
  let clock = 0, attempts = 0;
  const controller = new AbortController(), cause = new Error("original caller cancelled");
  await assert.rejects(retryTransient(async () => {
    attempts++; throw new Error("server_overloaded");
  }, error => transientReason((error as Error).message), { baseMs: 10, maxMs: 10, budgetMs: 50, jitterRatio: 0 },
  { now: () => clock, sleep: async () => { clock = 210; controller.abort(cause); } }, controller.signal), error => error === cause);
  assert.equal(attempts, 1);
});

test("zero retry budget allows the initial success and never delays or repeats an initial transient failure", async () => {
  let calls = 0, sleeps = 0;
  const policy = { baseMs: 10, maxMs: 10, budgetMs: 0, jitterRatio: 0 };
  const hooks = { now: () => 0, sleep: async () => { sleeps++; } };
  assert.equal(await retryTransient(async () => { calls++; return "first"; }, () => "overloaded", policy, hooks), "first");
  const original = new Error("server_overloaded");
  await assert.rejects(retryTransient(async () => { calls++; throw original; }, () => "overloaded", policy, hooks),
    error => error instanceof TransientRetryExhaustedError && error.lastError === original && error.attempts === 1);
  assert.equal(calls, 2); assert.equal(sleeps, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { backoffDelayMs, retryTransient, transientReason } from "../src/transient-retry.js";

const policy = { baseMs: 3_000, maxMs: 60_000, budgetMs: 65_000, jitterRatio: 0.25 };

test("positive jitter obeys the actual per-attempt delay ceiling, including saturated exponential growth", () => {
  for (const attempt of [4, 5, 20, 1_024]) {
    assert.ok(backoffDelayMs(attempt, policy, () => 0.999999) <= 60_000, `attempt ${attempt}`);
  }
  assert.equal(backoffDelayMs(0, { ...policy, baseMs: 90_000 }, () => 0.999999), 60_000);
});

test("fractional delay ceilings cannot be exceeded by millisecond rounding or disabled jitter", () => {
  const fractional = { ...policy, baseMs: 1_000.8, maxMs: 1_000.8 };
  assert.equal(backoffDelayMs(0, fractional, () => 0.999999), 1_000);
  assert.equal(backoffDelayMs(0, { ...fractional, jitterRatio: 0 }), 1_000);
});

test("delay ceiling preserves symmetric jitter below the cap and negative jitter at the cap", () => {
  assert.equal(backoffDelayMs(0, policy, () => 0), 2_250);
  assert.equal(backoffDelayMs(0, policy, () => 0.5), 3_000);
  assert.equal(backoffDelayMs(0, policy, () => 0.999999), 3_750);
  assert.equal(backoffDelayMs(20, policy, () => 0), 45_000);
  assert.equal(backoffDelayMs(20, { ...policy, jitterRatio: 1 }, () => 0), 1);
});

test("capped positive jitter permits the original retry within its remaining budget", async () => {
  let clock = 0, attempts = 0;
  const sleeps: number[] = [];
  const result = await retryTransient(async () => {
    attempts++;
    if (attempts === 1) throw new Error("503 Service Unavailable");
    return "original result";
  }, error => transientReason((error as Error).message), { ...policy, baseMs: 60_000 }, {
    now: () => clock, random: () => 0.999999,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
  });
  assert.equal(result, "original result");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(clock, 60_000);
});

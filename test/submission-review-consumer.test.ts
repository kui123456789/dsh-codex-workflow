import assert from "node:assert/strict";
import test from "node:test";
import type { CodexChildSessionHandle } from "../src/codex-child-session.js";
import { SubmissionReviewConsumers } from "../src/application/submission-review-consumer.js";

function consumerFixture() {
  const registry = new SubmissionReviewConsumers();
  // The registry treats the resource as opaque; integration suites supply
  // the actual native child and its real lifecycle operations.
  const child = { id: "original-consumer-child" } as CodexChildSessionHandle;
  const prepare = (owner: string, epoch: number, overrides: Partial<Parameters<typeof registry.prepare>[0]> = {}) =>
    registry.prepare({ workflowId: "workflow", submissionId: "submission", owner, epoch,
      identity: "original-immutable-context", child, canAdopt: () => true, ...overrides });
  return { registry, child, prepare };
}

test("preparing a successor preserves the original consumer until explicit valid adoption", async () => {
  const f = consumerFixture();
  const a = f.prepare("A", 1);
  a.adopt();
  const b = f.prepare("B", 2);
  assert.equal(a.isCurrent(), true);
  assert.equal(b.isCurrent(), false);
  assert.equal(a.signal.aborted, false);
  let cleaned = 0;
  await b.close(async () => { cleaned += 1; });
  assert.equal(cleaned, 0, "An unadopted successor cannot close the original consumer's resource");
  assert.equal(a.isCurrent(), true);
  b.adopt();
  assert.equal(a.signal.aborted, true, "Handoff ends only the old consumer's wait");
  assert.equal(a.isCurrent(), false);
  assert.equal(b.isCurrent(), true);
  assert.equal(b.signal.aborted, false);
  await a.close(async () => { cleaned += 1; });
  assert.equal(cleaned, 0, "Late original cleanup cannot close an adopted resource");
  await b.close(async () => { cleaned += 1; });
  assert.equal(cleaned, 1);
  assert.equal(b.isCurrent(), false);
});

test("consumer closing is claimed synchronously and native cleanup runs once", async () => {
  const f = consumerFixture();
  const a = f.prepare("A", 1);
  a.adopt();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let cleaned = 0;
  const first = a.close(async () => { cleaned += 1; await held; });
  try {
    assert.throws(() => f.prepare("B", 2), /closing|unavailable|retired/);
    const second = a.close(async () => { cleaned += 100; });
    assert.equal(second, first);
  } finally { release(); await first; }
  assert.equal(cleaned, 1);
  assert.equal(a.isCurrent(), false);
  assert.throws(() => f.prepare("C", 3), /closing|unavailable|retired/,
    "The same closed native child cannot be adopted as a replacement conversation");
});

test("a rejected consumer context does not revoke the original registration", async () => {
  const f = consumerFixture();
  const a = f.prepare("A", 1);
  a.adopt();
  assert.throws(() => f.prepare("B", 2, { identity: "changed-pending-input" }), /context changed/);
  assert.throws(() => f.prepare("B", 2, { child: { id: "replacement-child" } as CodexChildSessionHandle }), /context changed/);
  assert.equal(a.isCurrent(), true);
  assert.equal(a.signal.aborted, false);
  let cleaned = 0;
  await a.close(async () => { cleaned += 1; });
  assert.equal(cleaned, 1);
});

test("an obsolete generation cannot adopt or dispose the current consumer's child", async () => {
  const f = consumerFixture();
  const current = f.prepare("B", 2);
  current.adopt();
  const old = f.prepare("A", 1);
  assert.throws(() => old.adopt(), /obsolete lease generation/);
  assert.equal(current.isCurrent(), true);
  assert.equal(current.signal.aborted, false);
  let cleaned = 0;
  await old.close(async () => { cleaned += 100; });
  await current.close(async () => { cleaned += 1; });
  assert.equal(cleaned, 1);
});

test("failed live admission preserves the registered private owner for cleanup", async () => {
  const f = consumerFixture();
  const a = f.prepare("A", 1);
  a.adopt();
  const b = f.prepare("B", 2, { canAdopt: () => false });
  assert.throws(() => b.adopt(), /adoption no longer owns/);
  assert.equal(a.isCurrent(), true);
  assert.equal(a.signal.aborted, false);
  let cleaned = 0;
  await b.close(async () => { cleaned += 100; });
  await a.close(async () => { cleaned += 1; });
  assert.equal(cleaned, 1, "SQL loss does not strand a private registration with no local successor");
});

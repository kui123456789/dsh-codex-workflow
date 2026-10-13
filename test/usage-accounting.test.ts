import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { parseTokenUsageSnapshot, ThreadTokenUsageLedger } from "../src/usage-accounting.js";

interface Breakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
interface Snapshot {
  threadId: string;
  turnId: string;
  total: Breakdown;
  last: Breakdown;
  modelContextWindow?: number | null;
}
interface UsageClient {
  getThreadTokenUsage(threadId: string): Snapshot | undefined;
  onTokenUsage(listener: (snapshot: Snapshot) => void): () => void;
}
const fixture = fileURLToPath(new URL("./fixtures/fake-usage-app-server.mjs", import.meta.url));
const makeClient = (noise = false) => new CodexAppServerClient({ command: process.execPath, args: [fixture],
  requestTimeoutMs: 5_000, idleProcessMs: 0, env: { ...process.env, FAKE_USAGE_NOISE: noise ? "1" : "0" } });
const first = { inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 5,
  outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 120 };

test("the App Server preserves authoritative usage totals and cache breakdowns from real stdio notifications", async () => {
  const codex = makeClient();
  const usage = codex as unknown as UsageClient;
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), ephemeral: true });
    const reply = await codex.startTurn(threadId, { prompt: "Inspect", model: "test-model" });
    assert.equal(reply.kind, "completed");
    assert.equal(typeof usage.getThreadTokenUsage, "function", "thread/tokenUsage/updated must not be silently discarded");
    assert.deepEqual(usage.getThreadTokenUsage(threadId)?.total, first);
    await codex.startTurn(threadId, { prompt: "Continue", model: "test-model" });
    const snapshot = usage.getThreadTokenUsage(threadId)!;
    assert.equal(snapshot.total.totalTokens, 215, "replace the thread's cumulative snapshot instead of adding notifications");
    assert.equal(snapshot.total.cachedInputTokens, 130);
    assert.equal(snapshot.total.cacheWriteInputTokens, 9);
    assert.equal(snapshot.total.reasoningOutputTokens, 11);
    assert.equal(snapshot.last.totalTokens, 95);
    assert.equal(snapshot.modelContextWindow, 128000);
  } finally { await codex.stop(); }
});

test("repeated usage notifications emit once per changed snapshot and cannot mutate the stored counters", async () => {
  const codex = makeClient();
  const usage = codex as unknown as UsageClient;
  try {
    assert.equal(typeof usage.onTokenUsage, "function");
    const seen: Snapshot[] = [];
    const removeMutator = usage.onTokenUsage((snapshot) => { snapshot.total.totalTokens = 999999; });
    const removeObserver = usage.onTokenUsage((snapshot) => seen.push(snapshot));
    const threadId = await codex.startThread({ cwd: process.cwd(), ephemeral: true });
    await codex.startTurn(threadId, { prompt: "Inspect", model: "test-model" });
    assert.equal(seen.length, 1, "three identical notifications are one cumulative snapshot");
    assert.equal(seen[0]?.total.totalTokens, 120, "listeners get isolated snapshots");
    const returned = usage.getThreadTokenUsage(threadId)!;
    returned.total.cachedInputTokens = 123456;
    assert.equal(usage.getThreadTokenUsage(threadId)?.total.cachedInputTokens, 70);
    removeMutator();
    removeObserver();
    await codex.startTurn(threadId, { prompt: "Continue", model: "test-model" });
    assert.equal(seen.length, 1, "the unsubscribe callback removes the notification observer");
    assert.equal(usage.getThreadTokenUsage(threadId)?.total.totalTokens, 215);
  } finally { await codex.stop(); }
});

test("unknown and malformed usage cannot evict an owned thread, and unsubscribe and stop clear its snapshots", async () => {
  const codex = makeClient(true);
  const usage = codex as unknown as UsageClient;
  try {
    assert.equal(typeof usage.getThreadTokenUsage, "function");
    const firstThread = await codex.startThread({ cwd: process.cwd(), ephemeral: true });
    await codex.startTurn(firstThread, { prompt: "Inspect", model: "test-model" });
    const secondThread = await codex.startThread({ cwd: process.cwd(), ephemeral: true });
    await codex.startTurn(secondThread, { prompt: "Inspect", model: "test-model" });
    assert.equal(usage.getThreadTokenUsage(firstThread)?.total.totalTokens, 120);
    assert.equal(usage.getThreadTokenUsage(secondThread)?.total.cachedInputTokens, 70);
    assert.equal(usage.getThreadTokenUsage("foreign-159"), undefined);
    await codex.unsubscribeThread(firstThread);
    assert.equal(usage.getThreadTokenUsage(firstThread), undefined);
    await codex.startTurn(secondThread, { prompt: "Continue", model: "test-model" });
    assert.equal(usage.getThreadTokenUsage(firstThread), undefined, "a late unloaded-thread notification cannot resurrect usage state");
    await codex.stop();
    assert.equal(usage.getThreadTokenUsage(secondThread), undefined);
  } finally { await codex.stop(); }
});

test("the usage ledger stays bounded at 128 thread snapshots and treats repeats as replacement", () => {
  const ledger = new ThreadTokenUsageLedger();
  const params = (threadId: string) => ({ threadId, turnId: "turn", tokenUsage: { total: first, last: first, modelContextWindow: null } });
  for (let id = 0; id < 130; id += 1) ledger.record(params(`thread-${id}`));
  assert.equal(ledger.size, 128);
  assert.equal(ledger.get("thread-0"), undefined);
  assert.equal(ledger.get("thread-1"), undefined);
  assert.deepEqual(ledger.get("thread-129")?.total, first);
  assert.equal(ledger.record(params("thread-129")), undefined, "a repeat does not create a second snapshot or increment counters");
  ledger.forget("thread-129");
  assert.equal(ledger.size, 127);
  ledger.clear();
  assert.equal(ledger.size, 0);
});

test("optional cache-write counters remain unknown on older servers and malformed counters are ignored", () => {
  const { cacheWriteInputTokens: _omitted, ...legacy } = first;
  const params = { threadId: "thread", turnId: "turn", tokenUsage: { total: legacy, last: legacy } };
  assert.equal(parseTokenUsageSnapshot(params)?.total.cacheWriteInputTokens, undefined, "unknown is never fabricated as zero");
  for (const invalid of [-1, 1.5, "100", null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseTokenUsageSnapshot({ ...params, tokenUsage: { total: { ...legacy, cachedInputTokens: invalid }, last: legacy } }), undefined);
  }
});

test("an unexpected App Server process exit clears usage from that process", async () => {
  const codex = makeClient();
  const usage = codex as unknown as UsageClient;
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), ephemeral: true });
    await codex.startTurn(threadId, { prompt: "Inspect", model: "test-model" });
    assert.equal(usage.getThreadTokenUsage(threadId)?.total.totalTokens, 120);
    await assert.rejects(codex.startTurn(threadId, { prompt: "Exit process", model: "test-model" }), /app-server exited/);
    assert.equal(usage.getThreadTokenUsage(threadId), undefined);
  } finally { await codex.stop(); }
});

import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const histories = new Map();
const forked = new Set();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadNumber = 0;
const review = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Requirements verified.";

input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") return;
  if (method === "initialize") return send({ id, result: { userAgent: "workflow-usage-test" } });
  if (method === "model/list") return send({ id, result: { data: [{ id: "test-model", isDefault: true }] } });
  if (method === "thread/start" || method === "thread/fork") {
    const threadId = `usage-thread-${++threadNumber}`;
    histories.set(threadId, []);
    if (method === "thread/fork") forked.add(threadId);
    return send({ id, result: { thread: { id: threadId } } });
  }
  if (method === "thread/unsubscribe") return send({ id, result: { status: "unsubscribed" } });
  if (method === "thread/read") return send({ id, result: { thread: { id: params.threadId, turns: histories.get(params.threadId) ?? [] } } });
  if (method === "turn/start" || method === "review/start") {
    const threadId = params.threadId;
    const history = histories.get(threadId) ?? [];
    const number = history.length + 1;
    const turnId = `${threadId}:turn-${number}`;
    const scale = forked.has(threadId) ? 10 : 1;
    const first = { totalTokens: 120 * scale, inputTokens: 100 * scale, cachedInputTokens: 70 * scale,
      cacheWriteInputTokens: 5 * scale, outputTokens: 20 * scale, reasoningOutputTokens: 6 * scale };
    const total = number === 1 ? first : { totalTokens: 215, inputTokens: 180, cachedInputTokens: 130,
      cacheWriteInputTokens: 9, outputTokens: 35, reasoningOutputTokens: 11 };
    const last = number === 1 ? first : { totalTokens: 95, inputTokens: 80, cachedInputTokens: 60,
      cacheWriteInputTokens: 4, outputTokens: 15, reasoningOutputTokens: 5 };
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 128000 } } });
    send({ id, result: { reviewThreadId: threadId, turn: { id: turnId } } });
    const status = process.env.FAKE_WORKFLOW_USAGE_SUCCESS === "1" ? "completed" : "failed";
    const text = params.outputSchema
      ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified." }) : review;
    const items = status === "completed" ? [{ type: "agentMessage", id: turnId, text }] : [];
    history.push({ id: turnId, status, items });
    histories.set(threadId, history);
    if (items.length) send({ method: "item/completed", params: { threadId, turnId, item: items[0] } });
    return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items } } });
  }
  return send({ id, result: {} });
});

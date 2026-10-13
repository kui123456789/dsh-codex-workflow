import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const loaded = new Set();
const turns = new Map();
let threads = 0;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const first = { inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 5,
  outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 120 };
const second = { inputTokens: 180, cachedInputTokens: 130, cacheWriteInputTokens: 9,
  outputTokens: 35, reasoningOutputTokens: 11, totalTokens: 215 };
const last = { inputTokens: 80, cachedInputTokens: 60, cacheWriteInputTokens: 4,
  outputTokens: 15, reasoningOutputTokens: 5, totalTokens: 95 };

input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") return;
  if (method === "initialize") return send({ id, result: { userAgent: "usage-test" } });
  if (method === "thread/start") {
    const threadId = `usage-thread-${++threads}`;
    loaded.add(threadId);
    return send({ id, result: { thread: { id: threadId } } });
  }
  if (method === "thread/unsubscribe") {
    loaded.delete(params.threadId);
    return send({ id, result: { status: "unsubscribed" } });
  }
  if (method === "turn/start") {
    if (params.input?.[0]?.text === "Exit process") process.exit(17);
    const threadId = params.threadId;
    const number = (turns.get(threadId) ?? 0) + 1;
    turns.set(threadId, number);
    const turnId = `${threadId}:turn-${number}`;
    const tokenUsage = { total: number === 1 ? first : second, last: number === 1 ? first : last, modelContextWindow: 128000 };
    // The server may emit a notification before acknowledging turn/start.
    for (let duplicate = 0; duplicate < 3; duplicate += 1) {
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage } });
    }
    if (process.env.FAKE_USAGE_NOISE === "1") {
      for (let foreign = 0; foreign < 160; foreign += 1) {
        send({ method: "thread/tokenUsage/updated", params: { threadId: `foreign-${foreign}`, turnId, tokenUsage } });
      }
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId,
        tokenUsage: { ...tokenUsage, total: { ...first, cachedInputTokens: -1 } } } });
      for (const oldThread of turns.keys()) {
        if (!loaded.has(oldThread)) send({ method: "thread/tokenUsage/updated", params: { threadId: oldThread, turnId, tokenUsage } });
      }
    }
    send({ id, result: { turn: { id: turnId } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: turnId, text: "Completed." } } });
    return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }
  return send({ id, result: {} });
});

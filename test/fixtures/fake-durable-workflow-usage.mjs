import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const histories = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadNumber = 0;
let reviews = 0;
const plan = ["# Goal", "Implement read-only configuration and health inspection with explicit failure handling.",
  "# Changes", "- Add narrow health adapters while preserving persistence ownership and cancellation rules.",
  "# Verification", "- Check success, malformed configuration and unavailable storage deterministically.",
  "# Risks", "- Do not initialize or mutate an existing database during inspection; return useful diagnostics."].join("\n");
const verdict = (blocking) => ({ verdict: blocking ? "changes_requested" : "pass",
  findings: blocking ? [{ severity: "high", blocking: true, title: "Missing failure branch",
    body: "changed.txt:1 omits a required unavailable-storage branch.", file: "changed.txt", line: 1 }] : [],
  testGaps: [], summary: blocking ? "Implement the required failure branch." : "Requirements verified." });
const visible = (blocking) => `VERDICT: ${blocking ? "changes_requested" : "pass"}\nFINDINGS: ${blocking ? "high blocking changed.txt:1 Missing failure branch" : "none"}\nTEST GAPS: none\nSUMMARY: ${blocking ? "Implement the required failure branch." : "Requirements verified."}`;

input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") return;
  if (method === "initialize") return send({ id, result: { userAgent: "durable-workflow-usage-test" } });
  if (method === "model/list") return send({ id, result: { data: [{ id: "test-model", isDefault: true }] } });
  if (method === "collaborationMode/list") return send({ id, result: { data: [
    { name: "Plan", mode: "plan", model: "test-model", reasoning_effort: "high" },
    { name: "Default", mode: "default", model: "test-model", reasoning_effort: "high" },
  ] } });
  if (method === "thread/start" || method === "thread/fork") {
    const threadId = `raw-durable-usage-thread-${++threadNumber}`;
    histories.set(threadId, []);
    return send({ id, result: { thread: { id: threadId } } });
  }
  if (method === "thread/read") return send({ id, result: { thread: { id: params.threadId, turns: histories.get(params.threadId) ?? [] } } });
  if (method === "thread/unsubscribe") return send({ id, result: { status: "unsubscribed" } });
  if (method === "turn/start" || method === "review/start") {
    const threadId = params.threadId;
    const history = histories.get(threadId) ?? [];
    const number = history.length + 1;
    const turnId = `${threadId}:raw-turn-${number}`;
    const schema = params.outputSchema?.properties ?? {};
    const internalAlignment = "aligned" in schema;
    const scale = internalAlignment ? 100 : 1;
    const usage = { totalTokens: 120 * number * scale, inputTokens: 100 * number * scale,
      cachedInputTokens: 70 * number * scale, outputTokens: 20 * number * scale,
      reasoningOutputTokens: 6 * number * scale };
    const last = { totalTokens: 120 * scale, inputTokens: 100 * scale, cachedInputTokens: 70 * scale,
      outputTokens: 20 * scale, reasoningOutputTokens: 6 * scale };
    if (process.env.FAKE_DURABLE_USAGE_OMIT_CACHE_WRITE !== "1") {
      usage.cacheWriteInputTokens = 5 * number * scale;
      last.cacheWriteInputTokens = 5 * scale;
    }
    if (process.env.FAKE_DURABLE_USAGE_UNKNOWN !== "1") {
      // Exercise notifications arriving before RPC acknowledgement and duplicates.
      for (let duplicate = 0; duplicate < 2; duplicate += 1) send({ method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: { total: usage, last, modelContextWindow: 128000 } } });
    }
    send({ id, result: { reviewThreadId: threadId, turn: { id: turnId } } });
    const privateTurn = Object.keys(schema).length > 0;
    const failure = !privateTurn && number <= Number(process.env.FAKE_DURABLE_USAGE_FAIL_FIRST ?? 0);
    if (method === "review/start") reviews += 1;
    const blocking = process.env.FAKE_DURABLE_USAGE_FIRST_REVIEW_BLOCKS === "1" && reviews === 1;
    const text = "status" in schema ? JSON.stringify({ status: "ready", planMarkdown: plan, questions: [], assumptions: [] })
      : internalAlignment ? JSON.stringify({ aligned: true, conflicts: [] })
        : "verdict" in schema ? JSON.stringify(verdict(blocking))
          : params.collaborationMode?.mode === "plan" ? plan : visible(blocking);
    const status = failure ? "failed" : "completed";
    const items = failure ? [] : [{ type: "agentMessage", id: turnId, text }];
    history.push({ id: turnId, status, items });
    histories.set(threadId, history);
    if (items.length) send({ method: "item/completed", params: { threadId, turnId, item: items[0] } });
    return send({ method: "turn/completed", params: { threadId,
      turn: { id: turnId, status, items, ...(failure ? { error: { message: "turn failed" } } : {}) } } });
  }
  return send({ id, result: {} });
});

import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";

const lines = createInterface({ input: process.stdin });
let threadCounter = 0;
let turnCounter = 0;
const pendingQuestions = new Map();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function complete(threadId, turnId, text) {
  send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${turnId}`, text, phase: "final_answer", memoryCitation: null } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("method" in message)) {
    const pending = pendingQuestions.get(message.id);
    if (pending) {
      pendingQuestions.delete(message.id);
      setTimeout(() => complete(pending.threadId, pending.turnId, JSON.stringify({ status: "ready", planMarkdown: "<proposed_plan>\nAnswered plan\n</proposed_plan>", questions: [], assumptions: [] })), 0);
    }
    return;
  }
  const { id, method, params = {} } = message;
  if (process.env.FAKE_CODEX_THREAD_PARAMS_MARKER && ["thread/start", "thread/resume", "thread/settings/update"].includes(method)) {
    appendFileSync(process.env.FAKE_CODEX_THREAD_PARAMS_MARKER, `${JSON.stringify({ method, params })}\n`);
  }
  if (method === "initialized") return;
  if (method === "initialize") return send({ id, result: { userAgent: "fake", codexHome: "C:/fake", platformFamily: "windows", platformOs: "windows" } });
  if (method === "model/list") return send({ id, result: { data: [{ id: "fake-model" }] } });
  if (method === "collaborationMode/list") return send({ id, result: { data: [{ name: "Plan", mode: "plan", model: "fake-model", reasoning_effort: "high" }] } });
  if (method === "thread/start") {
    const threadId = `thread-${++threadCounter}`;
    return send({ id, result: { thread: { id: threadId, preview: "", modelProvider: "openai", createdAt: 1 } } });
  }
  if (method === "thread/name/set" || method === "thread/resume" || method === "thread/settings/update") return send({ id, result: {} });
  if (method === "turn/interrupt") {
    if (process.env.FAKE_CODEX_INTERRUPT_MARKER) {
      writeFileSync(process.env.FAKE_CODEX_INTERRUPT_MARKER, `${params.threadId}:${params.turnId}`);
    }
    return send({ id, result: {} });
  }
  if (method === "turn/start") {
    const turnId = `turn-${++turnCounter}`;
    send({ id, result: { turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    const prompt = params.input?.[0]?.text ?? "";
    if (prompt.includes("HANG")) return;
    if (prompt.includes("ASK_INPUT")) {
      const requestId = `question-${turnId}`;
      pendingQuestions.set(requestId, { threadId: params.threadId, turnId });
      return setTimeout(() => send({ method: "item/tool/requestUserInput", id: requestId, params: { threadId: params.threadId, turnId, itemId: `item-${turnId}`, autoResolutionMs: null, questions: [{ id: "scope", header: "Scope", question: "Which scope?", isOther: false, isSecret: false, options: [{ label: "Focused", description: "Only requested files" }] }] } }), 0);
    }
    const reviewSchema = params.outputSchema?.properties?.verdict;
    const text = reviewSchema
      ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Looks good" })
      : JSON.stringify({ status: "ready", planMarkdown: "<proposed_plan>\nImplement safely\n</proposed_plan>", questions: [], assumptions: [] });
    return setTimeout(() => complete(params.threadId, turnId, text), 0);
  }
  if (method === "review/start") {
    const turnId = `turn-${++turnCounter}`;
    const reviewThreadId = params.delivery === "detached" ? `thread-${++threadCounter}` : params.threadId;
    send({ id, result: { reviewThreadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    return setTimeout(() => complete(reviewThreadId, turnId, "No actionable findings."), 0);
  }
  send({ id, error: { code: -32601, message: `unknown ${method}` } });
});

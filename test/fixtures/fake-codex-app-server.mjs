import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";

const lines = createInterface({ input: process.stdin });
let threadCounter = 0;
let turnCounter = 0;
const pendingQuestions = new Map();
// Threads the plugin has subscribed to as its writer; mirrors the real server's
// idempotent thread/unsubscribe semantics.
const subscribed = new Set();
// Threads this fake has ever "loaded" (started/forked/resumed). Unsubscribing a
// loaded-but-not-subscribed thread is `notSubscribed`; a never-loaded thread is
// `notLoaded` — mirroring the real Codex App Server.
const knownThreads = new Set();

if (process.env.FAKE_CODEX_PROCESS_MARKER) {
  writeFileSync(process.env.FAKE_CODEX_PROCESS_MARKER, String(process.pid));
}

// Simulate an active writer on ONE specific thread (the source task). Metadata
// reads (`thread/read`) are never blocked by it; only `thread/resume` and
// `turn/start` against that exact thread would be busy — proving the reviewer
// flow never touches the source's writer.
const sourceThreadForWriter = process.env.FAKE_CODEX_SOURCE_THREAD || "";
const sourceHasActiveWriter = process.env.FAKE_CODEX_SOURCE_ACTIVE_WRITER === "1";
function sourceBusy(threadId) {
  return sourceHasActiveWriter && sourceThreadForWriter && threadId === sourceThreadForWriter;
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function complete(threadId, turnId, text, status = "completed") {
  if (text !== null && text !== undefined) {
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${turnId}`, text, phase: "final_answer", memoryCitation: null } } });
  }
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
}

function provisionalTexts() {
  try {
    return JSON.parse(process.env.FAKE_CODEX_PROVISIONAL_SEQ || "[]");
  } catch {
    return [];
  }
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
  if (process.env.FAKE_CODEX_THREAD_PARAMS_MARKER && ["thread/read", "thread/start", "thread/fork", "thread/resume", "thread/settings/update", "thread/name/set", "thread/unsubscribe", "turn/start"].includes(method)) {
    appendFileSync(process.env.FAKE_CODEX_THREAD_PARAMS_MARKER, `${JSON.stringify({ method, params })}\n`);
  }
  if (method === "initialized") return;
  if (method === "initialize") return send({ id, result: { userAgent: "fake", codexHome: "C:/fake", platformFamily: "windows", platformOs: "windows" } });
  if (method === "model/list") {
    // Optional default-model override: list a non-default first entry plus an
    // explicit isDefault entry with a defaultReasoningEffort, matching the real
    // model/list schema.
    if (process.env.FAKE_CODEX_DEFAULT_MODEL) {
      const def = process.env.FAKE_CODEX_DEFAULT_MODEL;
      const defaultEffort = process.env.FAKE_CODEX_DEFAULT_EFFORT || "high";
      return send({ id, result: { data: [
        { id: "first-model", model: "first-model", hidden: false, displayName: "First", defaultReasoningEffort: "low" },
        { id: def, model: def, hidden: false, isDefault: true, displayName: "Default", defaultReasoningEffort: defaultEffort },
      ] } });
    }
    return send({ id, result: { data: [{ id: "fake-model" }] } });
  }
  if (method === "collaborationMode/list") return send({ id, result: { data: [
    { name: "Plan", mode: "plan", model: "fake-model", reasoning_effort: "high" },
    { name: "Default", mode: "default", model: null, reasoning_effort: null },
  ] } });
  if (method === "thread/read") {
    if (process.env.FAKE_CODEX_MISSING_SOURCE === "1") {
      return send({ id, error: { code: -32000, message: `no rollout found for thread id ${params.threadId}` } });
    }
    // Metadata reads never contend with an active writer on the source.
    return send({ id, result: { thread: { id: params.threadId, preview: "", modelProvider: "openai", createdAt: 1 } } });
  }
  if (method === "thread/start") {
    const threadId = `thread-${++threadCounter}`;
    subscribed.add(threadId);
    knownThreads.add(threadId);
    return send({ id, result: { thread: { id: threadId, preview: "", modelProvider: "openai", createdAt: 1 } } });
  }
  if (method === "thread/fork") {
    const threadId = `thread-${++threadCounter}`;
    subscribed.add(threadId);
    knownThreads.add(threadId);
    return send({ id, result: { thread: { id: threadId, forkedFromId: params.threadId, preview: "", modelProvider: "openai", createdAt: 1 } } });
  }
  if (method === "thread/name/set" || method === "thread/resume" || method === "thread/settings/update") {
    if (method === "thread/settings/update" && process.env.FAKE_CODEX_FAIL_SETTINGS === "1") {
      return send({ id, error: { code: -32000, message: "settings failed (injected)" } });
    }
    if (method === "thread/name/set" && process.env.FAKE_CODEX_FAIL_NAME === "1") {
      return send({ id, error: { code: -32000, message: "name set failed (injected)" } });
    }
    if (method === "thread/resume" && sourceBusy(params.threadId)) {
      return send({ id, error: { code: -32000, message: `thread-store conflict: thread ${params.threadId} already has an active writer` } });
    }
    if (method === "thread/resume") {
      subscribed.add(params.threadId);
      knownThreads.add(params.threadId);
    }
    return send({ id, result: {} });
  }
  if (method === "thread/unsubscribe") {
    // Idempotent like the real server: subscribed -> unsubscribed, loaded but
    // not subscribed -> notSubscribed, never seen -> notLoaded. The thread is
    // never deleted or archived.
    if (subscribed.delete(params.threadId)) return send({ id, result: { status: "unsubscribed" } });
    if (knownThreads.has(params.threadId)) return send({ id, result: { status: "notSubscribed" } });
    return send({ id, result: { status: "notLoaded" } });
  }
  if (method === "turn/interrupt") {
    if (process.env.FAKE_CODEX_INTERRUPT_MARKER) {
      writeFileSync(process.env.FAKE_CODEX_INTERRUPT_MARKER, `${params.threadId}:${params.turnId}`);
    }
    return send({ id, result: {} });
  }
  if (method === "turn/start") {
    if (sourceBusy(params.threadId)) {
      return send({ id, error: { code: -32000, message: `thread-store conflict: thread ${params.threadId} already has an active writer` } });
    }
    const turnId = `turn-${++turnCounter}`;
    send({ id, result: { turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    const prompt = params.input?.[0]?.text ?? "";
    if (prompt === "HANG") return;
    if (prompt.includes("ASK_INPUT")) {
      const requestId = `question-${turnId}`;
      pendingQuestions.set(requestId, { threadId: params.threadId, turnId });
      return setTimeout(() => send({ method: "item/tool/requestUserInput", id: requestId, params: { threadId: params.threadId, turnId, itemId: `item-${turnId}`, autoResolutionMs: null, questions: [{ id: "scope", header: "Scope", question: "Which scope?", isOther: false, isSecret: false, options: [{ label: "Focused", description: "Only requested files" }] }] } }), 0);
    }
    const reviewSchema = params.outputSchema?.properties?.verdict;
    const provisions = reviewSchema ? provisionalTexts() : [];
    for (const text of provisions) {
      send({ method: "item/completed", params: { threadId: params.threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${turnId}-prov`, text, phase: "streaming", memoryCitation: null } } });
    }
    const finalStatus = process.env.FAKE_CODEX_TURN_STATUS || "completed";
    const finalText = reviewSchema
      ? (process.env.FAKE_CODEX_REVIEW_VERDICT || JSON.stringify({ verdict: "pass", findings: [{ severity: "high", blocking: true, title: "t", body: "b", file: null, line: null }], testGaps: ["gap"], summary: "Looks good" }))
      : JSON.stringify({ status: "ready", planMarkdown: "<proposed_plan>\nImplement safely\n</proposed_plan>", questions: [], assumptions: [] });
    const delay = (prompt.includes("SLOW") ? Number(process.env.FAKE_CODEX_SLOW_DELAY_MS || 0) : 0)
      || Number(process.env.FAKE_CODEX_TURN_DELAY_MS || 0);
    // Interrupted/failed turns carry NO final agent message: a provisional pass
    // alone must never become a verdict.
    const emission = !reviewSchema || finalStatus === "completed" ? finalText : null;
    return setTimeout(() => complete(params.threadId, turnId, emission, reviewSchema ? finalStatus : "completed"), delay);
  }
  if (method === "review/start") {
    const turnId = `turn-${++turnCounter}`;
    const reviewThreadId = params.delivery === "detached" ? `thread-${++threadCounter}` : params.threadId;
    subscribed.add(reviewThreadId);
    knownThreads.add(reviewThreadId);
    send({ id, result: { reviewThreadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    return setTimeout(() => complete(reviewThreadId, turnId, "No actionable findings."), 0);
  }
  send({ id, error: { code: -32601, message: `unknown ${method}` } });
});

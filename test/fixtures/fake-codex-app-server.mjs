import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";

const lines = createInterface({ input: process.stdin });
let threadCounter = 0;
let turnCounter = 0;
let persistedTurnCounter = 0;
const pendingQuestions = new Map();
// Threads the plugin has subscribed to as its writer; mirrors the real server's
// idempotent thread/unsubscribe semantics.
const subscribed = new Set();
// Threads this fake has ever "loaded" (started/forked/resumed). Unsubscribing a
// loaded-but-not-subscribed thread is `notSubscribed`; a never-loaded thread is
// `notLoaded` — mirroring the real Codex App Server.
const knownThreads = new Set();
// Consumable queue of visible (non-schema) turn replies for display-contract
// scenarios: the first VISIBLE review turn takes entry 0, the display-rewrite
// turn takes entry 1, and so on. Absent -> the static PLAIN_REVIEW_MARKDOWN
// reply (which is display-contract compliant: four sections AND Chinese text,
// so Chinese tasks never spuriously trigger the rewrite turn).
const plainReviewTurns = process.env.FAKE_CODEX_PLAIN_REVIEW_TURNS
  ? JSON.parse(process.env.FAKE_CODEX_PLAIN_REVIEW_TURNS)
  : [];
// Consumable queue of PERSISTED (thread/read) final texts, one per completed
// turn, in turn order. This is the display-contract test seam: the text the
// server STREAMS (item/completed + turn/completed) can differ from what
// thread/read(includeTurns:true) actually PERSISTS. When the queue is
// exhausted the persisted text falls back to the streamed one.
const persistedTextSeq = process.env.FAKE_CODEX_PERSISTED_TEXT_SEQ
  ? JSON.parse(process.env.FAKE_CODEX_PERSISTED_TEXT_SEQ)
  : [];
// Persisted turn history per thread, mirroring the real server's rollout
// store for thread/read(includeTurns: true).
const threadTurnHistory = new Map();

if (process.env.FAKE_CODEX_PROCESS_MARKER) {
  writeFileSync(process.env.FAKE_CODEX_PROCESS_MARKER, String(process.pid));
}

/** Consume the next review verdict from a mutable SEQUENCE FILE (shared across
 * fake-server processes, so restart-recovery tests see the same queue) or the
 * static env var. Empty queue -> the default verdict. */
function nextReviewVerdict() {
  const seqFile = process.env.FAKE_CODEX_REVIEW_VERDICT_SEQ_FILE;
  const staticSeq = process.env.FAKE_CODEX_REVIEW_VERDICT_SEQ;
  if (seqFile) {
    let remainder = [];
    try {
      remainder = JSON.parse(readFileSync(seqFile, "utf8") || "[]");
    } catch {
      remainder = [];
    }
    const next = remainder.shift();
    writeFileSync(seqFile, JSON.stringify(remainder));
    if (typeof next === "string" && next.length > 0) return next;
    return undefined;
  }
  if (staticSeq) {
    try {
      const entries = JSON.parse(staticSeq);
      const next = entries.shift();
      if (typeof next === "string" && next.length > 0) return next;
    } catch {
      return undefined;
    }
  }
  return undefined;
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
  // Persist the turn into the thread history BEFORE the completion events are
  // streamed, so an immediate thread/read(includeTurns:true) read-back sees
  // the REAL persisted text (which may differ from the streamed one via
  // FAKE_CODEX_PERSISTED_TEXT_SEQ). The PERSISTED turn id deliberately DIFFERS
  // from the RPC turn id (real App Server evidence: native review/start RPC
  // turn ids never appear in the persisted rollout history), so read-back code
  // must locate the appended turn by baseline, never by id equality.
  const history = threadTurnHistory.get(threadId) ?? [];
  const persistedId = `persisted-${++persistedTurnCounter}`;
  const persistedText = persistedTextSeq.length > 0 ? persistedTextSeq.shift() : text;
  history.push({
    id: persistedId,
    status,
    items: persistedText !== null && persistedText !== undefined
      ? [{ type: "agentMessage", id: `persisted-item-${persistedId}`, text: persistedText, phase: "final_answer", memoryCitation: null }]
      : [],
  });
  threadTurnHistory.set(threadId, history);
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
  // Deterministic slow-RPC seam: FAKE_CODEX_RPC_DELAY_MS delays every client
  // request response so control-RPC timeout behaviour can be tested.
  const rpcDelay = Number(process.env.FAKE_CODEX_RPC_DELAY_MS || 0);
  if (rpcDelay > 0 && "method" in message && "id" in message) {
    setTimeout(() => handleClientRequest(message), rpcDelay);
    return;
  }
  handleClientRequest(message);
});

function handleClientRequest(message) {
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
    const thread = { id: params.threadId, preview: "", modelProvider: "openai", createdAt: 1 };
    if (params.includeTurns === true) {
      // The PERSISTED turn history: the authoritative display text the client
      // must read back and validate (may differ from the streamed text).
      thread.turns = threadTurnHistory.get(params.threadId) ?? [];
    }
    return send({ id, result: { thread } });
  }
  if (method === "thread/start") {
    const threadId = `thread-${++threadCounter}`;
    subscribed.add(threadId);
    knownThreads.add(threadId);
    return send({ id, result: { thread: { id: threadId, preview: "", modelProvider: "openai", createdAt: 1 } } });
  }
  if (method === "thread/fork") {
    // Deterministic cancel-window seam: when FAKE_CODEX_FORK_GATE_FILE is
    // set, the fork RPC is HELD (after writing the marker) until the
    // `<gateFile>.release` file exists — so a test can cancel DURING the
    // visible-turn-completed -> fork-start window.
    const gateFile = process.env.FAKE_CODEX_FORK_GATE_FILE;
    if (gateFile) {
      writeFileSync(gateFile, "held");
      const releaseFile = `${gateFile}.release`;
      const deadline = Date.now() + 15_000;
      while (!existsSync(releaseFile)) {
        if (Date.now() > deadline) {
          return send({ id, error: { code: -32000, message: "fork gate timed out" } });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      try { unlinkSync(gateFile); } catch { /* already gone */ }
    }
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
    const plannerSchema = params.outputSchema?.properties?.status;
    // 1.0.10 REVIEW AUTHORITY alignment fork: the INTERNAL align schema
    // (properties.aligned) is served its own deterministic JSON — never the
    // review verdict queue (the alignment output is NOT a review verdict).
    const alignSchema = params.outputSchema?.properties?.aligned;
    const provisions = reviewSchema ? provisionalTexts() : [];
    for (const text of provisions) {
      send({ method: "item/completed", params: { threadId: params.threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${turnId}-prov`, text, phase: "streaming", memoryCitation: null } } });
    }
    const finalStatus = process.env.FAKE_CODEX_TURN_STATUS || "completed";
    // 1.0.7 contract: turns WITHOUT an outputSchema are VISIBLE planner/reviewer
    // turns and reply with readable Markdown — a planner <proposed_plan> block
    // by default, or a review Markdown when FAKE_CODEX_PLAIN_REVIEW_MARKDOWN is
    // set (the bridge Reviewer flow). Turns WITH an outputSchema are the
    // EPHEMERAL conversion forks and reply with the structured JSON.
    const finalText = alignSchema
      ? (process.env.FAKE_CODEX_ALIGN_RESULTS_JSON || JSON.stringify({ aligned: true, conflicts: [] }))
      : reviewSchema
        ? ((nextReviewVerdict() ?? process.env.FAKE_CODEX_REVIEW_VERDICT) || JSON.stringify({ verdict: "pass", findings: [{ severity: "high", blocking: true, title: "t", body: "b", file: null, line: null }], testGaps: ["gap"], summary: "Looks good" }))
      : plannerSchema
        ? JSON.stringify({ status: "ready", planMarkdown: "<proposed_plan>\nImplement safely\n</proposed_plan>", questions: [], assumptions: [] })
        : plainReviewTurns.length > 0
          ? plainReviewTurns.shift()
          : process.env.FAKE_CODEX_PLAIN_REVIEW_MARKDOWN === "1"
            ? "VERDICT: pass\nFINDINGS:\n- [high, blocking] t (file:line unknown): b\nTEST GAPS:\n- gap\nSUMMARY: 实现符合计划，测试全部通过"
            : "<proposed_plan>\nImplement safely\n</proposed_plan>";
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
}

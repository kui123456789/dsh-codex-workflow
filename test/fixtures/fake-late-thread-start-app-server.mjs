import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1]);
let interruptMode = flags.get("--interrupt-mode") ?? "held";
let turnMode = flags.get("--turn-mode") ?? "active";
let activeVisibleTurns = Number(flags.get("--active-visible-turns") ?? 1);
const processLog = flags.get("--process-log");
const log = (kind, detail = {}) => {
  if (processLog) appendFileSync(processLog, `${JSON.stringify({ kind, processId: process.pid, ...detail })}\n`, "utf8");
};
log("start");
const threads = new Map();
const threadStarts = [];
const turnStartRequests = [];
const interrupts = [];
const heldInterrupts = [];
const heldThreadStarts = [];
const heldThreadObservers = [];
const threadStartRequests = [];
const unsubscribes = [];
let holdFirstThreadStart = true;
const interruptObservers = [];
let initializations = 0;
let visibleTurns = 0;
let turnNumber = 0;
let writerConflicts = 0;
let heldSchema;
let nextThreadError;
let nextTurnError;
const plan = "<proposed_plan>\n# Goal\nImplement read-only local configuration and storage diagnostics.\n# Changes\n- Add narrow health adapters with explicit unavailable-input handling.\n- Preserve current persistence, cancellation and ownership rules.\n# Verification\n- Verify valid, missing and malformed configuration in isolated storage.\n# Risks\n- Never initialize or mutate an existing database during inspection.\n</proposed_plan>";
const review = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved local diagnostic requirements are verified.";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32000, message } });
const stats = () => ({ processId: process.pid, initializations, threadStarts, turnStartRequests, interrupts,
  writerConflicts, visibleTurns, heldInterrupts: heldInterrupts.length, heldThreadStarts: heldThreadStarts.length, threadStartRequests, unsubscribes,
  active: [...threads].flatMap(([threadId, state]) => state.active ? [{ threadId, turnId: state.active }] : []) });

function finish(threadId, turnId, status, text = "") {
  const state = threads.get(threadId);
  if (state?.active === turnId) state.active = undefined;
  const items = text ? [{ type: "agentMessage", id: `${turnId}:message`, text }] : [];
  const turn = { id: turnId, status, items };
  state?.history.push(turn);
  if (items.length) send({ method: "item/completed", params: { threadId, turnId, item: items[0] } });
  send({ method: "turn/completed", params: { threadId, turn } });
}

function acknowledgeInterrupt(request, confirmed) {
  if (!confirmed) return error(request.id, "fixture interruption acknowledgement failed");
  finish(request.threadId, request.turnId, "interrupted");
  reply(request.id, {});
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") return;
  if (method === "initialize") { initializations += 1; return reply(id, { userAgent: "turn-interruption-fixture" }); }
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "collaborationMode/list") return reply(id, { data: [
    { name: "Plan", mode: "plan", model: "model-A", reasoning_effort: "low" },
    { name: "Default", mode: "default", model: "model-A", reasoning_effort: "low" },
  ] });
  if (method === "thread/start" || method === "thread/fork") {
    threadStartRequests.push({ method, ephemeral: params.ephemeral });
    if (nextThreadError) { const message = nextThreadError; nextThreadError = undefined; return error(id, message); }
    const threadId = `fixture-thread-${threads.size + 1}`;
    threads.set(threadId, { active: undefined, history: [] });
    threadStarts.push({ method, threadId, ephemeral: params.ephemeral, model: params.model });
    if (method === "thread/start" && holdFirstThreadStart) {
      holdFirstThreadStart = false;
      heldThreadStarts.push({ id, threadId });
      log("thread-created-held", { threadId });
      for (const observer of heldThreadObservers.splice(0)) reply(observer, stats());
      return;
    }
    return reply(id, { thread: { id: threadId } });
  }
  if (method === "thread/read") return reply(id, { thread: { id: params.threadId, turns: threads.get(params.threadId)?.history ?? [] } });
  if (method === "thread/unsubscribe") {
    unsubscribes.push(params.threadId);
    log("unsubscribe", { threadId: params.threadId });
    return reply(id, { status: "unsubscribed" });
  }
  if (method === "turn/start" || method === "review/start") {
    const threadId = params.threadId;
    const state = threads.get(threadId);
    turnStartRequests.push({ method, threadId, model: params.model,
      effort: params.effort ?? params.collaborationMode?.settings?.reasoning_effort,
      prompt: params.input?.[0]?.text ?? params.target?.instructions });
    if (nextTurnError) { const message = nextTurnError; nextTurnError = undefined; return error(id, message); }
    if (!state) return error(id, "thread does not exist");
    if (state.active) {
      writerConflicts += 1;
      return error(id, `thread-store conflict: ${threadId} already has an active writer`);
    }
    const turnId = `fixture-turn-${++turnNumber}`;
    state.active = turnId;
    state.activeText = method === "review/start" || params.collaborationMode?.mode === "default" ? review : plan;
    reply(id, { turn: { id: turnId }, ...(method === "review/start" ? { reviewThreadId: threadId } : {}) });
    const schema = params.outputSchema?.properties ?? {};
    const privateTurn = Object.keys(schema).length > 0;
    if (!privateTurn) visibleTurns += 1;
    if (!privateTurn && turnMode === "active" && visibleTurns <= activeVisibleTurns) return;
    const text = "status" in schema ? JSON.stringify({ status: "ready", planMarkdown: plan, questions: [], assumptions: [] })
      : "aligned" in schema ? JSON.stringify({ aligned: true, conflicts: [] })
        : "verdict" in schema ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified" })
          : method === "review/start" || params.collaborationMode?.mode === "default" ? review : plan;
    if (heldSchema && heldSchema in schema) { state.activeText = text; return; }
    return finish(threadId, turnId, "completed", text);
  }
  if (method === "turn/interrupt") {
    const request = { id, threadId: params.threadId, turnId: params.turnId };
    interrupts.push({ threadId: request.threadId, turnId: request.turnId, mode: interruptMode });
    log("interrupt", { threadId: request.threadId, turnId: request.turnId });
    if (interruptMode === "held") heldInterrupts.push(request);
    else acknowledgeInterrupt(request, interruptMode === "confirmed");
    for (let i = interruptObservers.length - 1; i >= 0; i -= 1) {
      const observer = interruptObservers[i];
      if (interrupts.length >= observer.minimumCount) { interruptObservers.splice(i, 1); reply(observer.id, stats()); }
    }
    return;
  }
  if (method === "fixture/waitForThreadCreation") {
    if (heldThreadStarts.length) return reply(id, stats());
    heldThreadObservers.push(id); return;
  }
  if (method === "fixture/releaseThreadStart") {
    for (const held of heldThreadStarts.splice(0)) {
      log("thread-start-replied", { threadId: held.threadId });
      reply(held.id, { thread: { id: held.threadId } });
    }
    return reply(id, stats());
  }
  if (method === "fixture/stats") return reply(id, stats());
  if (method === "fixture/waitForInterrupt") {
    const minimumCount = params.minimumCount ?? 1;
    if (interrupts.length >= minimumCount) return reply(id, stats());
    interruptObservers.push({ id, minimumCount });
    return;
  }
  if (method === "fixture/releaseInterrupt") {
    for (const request of heldInterrupts.splice(0)) acknowledgeInterrupt(request, params.confirmed !== false);
    return reply(id, stats());
  }
  if (method === "fixture/setInterruptMode") { interruptMode = params.mode; return reply(id, stats()); }
  if (method === "fixture/setTurnMode") { turnMode = params.mode; return reply(id, stats()); }
  if (method === "fixture/setActiveVisibleTurns") { activeVisibleTurns = params.count; return reply(id, stats()); }
  if (method === "fixture/setHeldSchema") { heldSchema = params.property; return reply(id, stats()); }
  if (method === "fixture/setNextThreadError") { nextThreadError = params.message; return reply(id, stats()); }
  if (method === "fixture/setNextTurnError") { nextTurnError = params.message; return reply(id, stats()); }
  if (method === "fixture/emitMessage") {
    const state = threads.get(params.threadId);
    if (!state?.active) return error(id, "fixture message requires its original active turn");
    send({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: state.active,
      itemId: `${state.active}:message`, delta: params.text } });
    return reply(id, stats());
  }
  if (method === "fixture/completeActive") {
    for (const [threadId, state] of threads) {
      if (state.active && (!params.threadId || params.threadId === threadId)) {
        const status = params.status ?? "completed";
        finish(threadId, state.active, status, status === "completed" ? params.text ?? state.activeText : "");
      }
    }
    return reply(id, stats());
  }
  if (method === "fixture/exit") {
    log("exit");
    process.stdout.write(`${JSON.stringify({ id, result: stats() })}\n`, () => process.exit(0));
    return;
  }
  return reply(id, {});
});
input.on("close", () => log("stdin-eof"));

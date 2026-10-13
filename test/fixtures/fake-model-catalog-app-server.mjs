import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Model metadata changes only in this local protocol. Tests exercise the real
// App Server client without changing any installed provider or profile.
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1]);
const processLog = flags.get("--process-log");
const noCatalog = flags.get("--catalog-mode") === "none";
const catalogueModel = flags.get("--catalog-model") ?? "catalog-A";
const catalogueEffort = flags.get("--catalog-effort") ?? "low";
const planModel = flags.get("--plan-model") === "none" ? null : catalogueModel;
const initializeMode = flags.get("--initialize-mode") ?? "valid";
const rpcCalls = [];
const heldInitializationIds = [];
const log = (kind, detail = {}) => {
  if (processLog) appendFileSync(processLog, `${JSON.stringify({ kind, processId: process.pid, ...detail })}\n`, "utf8");
};
log("start");
const threads = new Map();
const responses = new Map();
const threadStarts = [];
const turnStartRequests = [];
const interrupts = [];
const unsubscribes = [];
const heldInterrupts = [];
const inputRequests = new Map();
const nativeMessages = [];
let nativeReplies = 0;
let interruptMode = flags.get("--interrupt-mode") ?? "confirmed";
let initializations = 0;
let initializedReady = false;
let visibleTurns = 0;
let turnNumber = 0;
let writerConflicts = 0;
const plan = "<proposed_plan>\n# Goal\nImplement read-only local configuration and storage diagnostics.\n# Changes\n- Add narrow health adapters with explicit unavailable-input handling.\n- Preserve current persistence, cancellation and ownership rules.\n# Verification\n- Verify valid, missing and malformed configuration in isolated storage.\n# Risks\n- Never initialize or mutate an existing database during inspection.\n</proposed_plan>";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32000, message } });
const stats = () => ({ processId: process.pid, initializations, initializedReady, heldInitializations: heldInitializationIds.length,
  catalogueModel, catalogueEffort, planModel, rpcCalls, threadStarts, turnStartRequests, interrupts,
  unsubscribes, writerConflicts, visibleTurns, nativeReplies, nativeMessages, inputRequests: [...inputRequests.keys()],
  active: [...threads].flatMap(([threadId, state]) => state.active ? [{ threadId, turnId: state.active }] : []) });

function finish(threadId, turnId, status, text = "", message) {
  const state = threads.get(threadId);
  if (state?.active === turnId) state.active = undefined; for (const [requestId, pending] of inputRequests) { if (pending.threadId === threadId && pending.turnId === turnId) inputRequests.delete(requestId); }
  const items = text ? [{ type: "agentMessage", id: `${turnId}:message`, text }] : [];
  const turn = { id: turnId, status, items, ...(message ? { error: { message } } : {}) };
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
  const wire = JSON.parse(line);
  if (!wire.method) {
    nativeMessages.push(wire);
    const pending = inputRequests.get(wire.id);
    // A denial/error is not an answer and does not prove the native writer
    // ended. Only an actual reply to its original question advances the turn.
    const answers = wire.result?.answers?.scope?.answers;
    if (pending && Array.isArray(answers) && answers.every((answer) => typeof answer === "string")) {
      nativeReplies += 1;
      inputRequests.delete(wire.id);
      finish(pending.threadId, pending.turnId, "completed", plan);
    }
    return;
  }
  const { id, method, params = {} } = wire;
  rpcCalls.push({ method, params });
  log("rpc", { method, params });
  if (method === "initialized") { initializedReady = true; return; }
  if (method === "initialize") {
    initializations += 1;
    if (initializeMode === "held") { heldInitializationIds.push(id); return; }
    if (initializeMode === "error") return error(id, "fixture initialization rejected");
    if (initializeMode === "invalid") return reply(id, {});
    return reply(id, { userAgent: "model-catalog-fixture" });
  }
  if (method === "model/list") return reply(id, { data: noCatalog ? [] : [{ id: catalogueModel, isDefault: true, defaultReasoningEffort: catalogueEffort }] });
  if (method === "collaborationMode/list") return reply(id, { data: noCatalog ? [] : [
    { name: "Plan", mode: "plan", model: planModel, reasoning_effort: catalogueEffort },
    { name: "Default", mode: "default", model: planModel, reasoning_effort: catalogueEffort },
  ] });
  if (method === "thread/start" || method === "thread/fork") {
    const threadId = `fixture-thread-${threads.size + 1}`;
    threads.set(threadId, { active: undefined, history: [] });
    threadStarts.push({ method, threadId, ephemeral: params.ephemeral, model: params.model });
    log("thread-start", { threadId });
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
    const schemaKeys = Object.keys(params.outputSchema?.properties ?? {});
    const scope = schemaKeys[0] ?? "visible";
    const scripted = responses.get(scope)?.shift();
    const request = { method, threadId, model: params.model,
      effort: params.effort ?? params.collaborationMode?.settings?.reasoning_effort,
      collaborationModel: params.collaborationMode?.settings?.model,
      prompt: params.input?.[0]?.text ?? params.target?.instructions, scope, schemaKeys };
    turnStartRequests.push(request);
    log("turn-start", { threadId, scope });
    if (scripted?.kind === "rpc-error") return error(id, scripted.message);
    if (!state) return error(id, "thread does not exist");
    if (state.active) {
      writerConflicts += 1;
      return error(id, `thread-store conflict: ${threadId} already has an active writer`);
    }
    const turnId = `fixture-turn-${++turnNumber}`;
    request.turnId = turnId;
    state.active = turnId;
    const text = scripted?.text ?? (scripted?.result ? JSON.stringify(scripted.result)
      : scope === "status" ? JSON.stringify({ status: "ready", planMarkdown: plan, questions: [], assumptions: [] }) : plan);
    state.activeText = text;
    reply(id, { turn: { id: turnId }, ...(method === "review/start" ? { reviewThreadId: threadId } : {}) });
    if (scope === "visible") visibleTurns += 1;
    if (scripted?.kind === "needs_input") {
      const requestId = `native-${turnId}`;
      inputRequests.set(requestId, { threadId, turnId });
      return send({ id: requestId, method: "item/tool/requestUserInput", params: { threadId, turnId,
        itemId: `item-${turnId}`, questions: [{ id: "scope", header: "Scope", question: "Which local configuration?",
          isOther: true, isSecret: false, options: [] }] } });
    }
    if (scripted?.kind === "hold") return;
    if (scripted?.kind === "failed") return finish(threadId, turnId, "failed", scripted.text ?? "", scripted.message);
    return finish(threadId, turnId, "completed", text);
  }
  if (method === "turn/interrupt") {
    const request = { id, threadId: params.threadId, turnId: params.turnId };
    interrupts.push({ threadId: request.threadId, turnId: request.turnId, mode: interruptMode });
    log("interrupt", { threadId: request.threadId, turnId: request.turnId });
    if (interruptMode === "held") heldInterrupts.push(request);
    else acknowledgeInterrupt(request, interruptMode === "confirmed");
    return;
  }
  if (method === "fixture/stats") return reply(id, stats());
  if (method === "fixture/releaseInitialize") {
    for (const pending of heldInitializationIds.splice(0)) reply(pending, { userAgent: "model-catalog-fixture" });
    return reply(id, stats());
  }
  if (method === "fixture/configure") {
    for (const [scope, queue] of Object.entries(params.responses ?? {})) responses.set(scope, [...queue]);
    return reply(id, stats());
  }
  if (method === "fixture/setInterruptMode") { interruptMode = params.mode; return reply(id, stats()); }
  if (method === "fixture/releaseInterrupt") {
    for (const request of heldInterrupts.splice(0)) acknowledgeInterrupt(request, params.confirmed !== false);
    return reply(id, stats());
  }
  if (method === "fixture/completeActive") {
    for (const [threadId, state] of threads) {
      if (state.active && (!params.threadId || params.threadId === threadId)) {
        const status = params.status ?? "completed";
        finish(threadId, state.active, status, status === "completed" ? params.text ?? state.activeText : "", params.message);
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
input.on("close", () => {
  log("stdin-eof");
  const exitDelay = Number(flags.get("--eof-delay-ms") ?? "0");
  if (exitDelay > 0) setTimeout(() => process.exit(0), exitDelay);
});



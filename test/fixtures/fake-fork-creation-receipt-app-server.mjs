import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Create and subscribe the first fork before withholding its actual RPC reply.
const [journal] = process.argv.slice(2);
const loaded = new Set(), forks = [], models = [], unsubscribes = [], unsubscribeAttempts = [], heldUnsubscribes = [];
let original, turnNumber = 0, originalReleaseMode = "confirmed", originalReleaseResult = {};
let firstModelMode = "completed", interruptMode = "confirmed";
const log = (kind, detail = {}) => appendFileSync(journal, JSON.stringify({ kind, processId: process.pid, ...detail }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const stats = () => ({ processId: process.pid, forks, models, unsubscribes, unsubscribeAttempts, loaded: [...loaded] });
function acknowledgeUnsubscribe(id, threadId) {
  loaded.delete(threadId); unsubscribes.push(threadId);
  log("unsubscribe", { threadId }); reply(id, { status: "unsubscribed" });
}
function receipt(value) {
  if (value.replied) throw new Error("The original fork reply cannot be repeated");
  value.replied = true;
  log("fork-receipt", { requestId: value.requestId, sourceThreadId: value.sourceThreadId, forkId: value.forkId });
  reply(value.requestId, { thread: { id: value.forkId } });
}
function completeModel(value) {
  value.active = false;
  send({ method: "turn/completed", params: { threadId: value.threadId,
    turn: { id: value.turnId, status: "completed", items: [{ id: value.turnId, type: "agentMessage", text: '{"verdict":"pass"}' }] } } });
}
log("process-start");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") return;
  if (method === "initialize") return reply(id, { userAgent: "original-fork-creation-receipt" });
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "collaborationMode/list") return reply(id, { data: [] });
  if (method === "thread/start") {
    loaded.add("original-source"); return reply(id, { thread: { id: "original-source" } });
  }
  if (method === "thread/fork") {
    const value = { requestId: id, sourceThreadId: params.threadId, forkId: `actual-fork-${forks.length + 1}`,
      ephemeral: params.ephemeral, excludeTurns: params.excludeTurns, replied: false };
    loaded.add(value.forkId); forks.push(value); log("fork-accepted", value);
    if (!original) { original = value; return; }
    receipt(value); return;
  }
  if (method === "turn/start") {
    const value = { threadId: params.threadId, turnId: `actual-turn-${++turnNumber}`, schema: params.outputSchema,
      model: params.model, prompt: params.input?.[0]?.text, active: true };
    models.push(value); log("conversion-model", value);
    reply(id, { turn: { id: value.turnId } });
    if (models.length !== 1 || firstModelMode !== "active") completeModel(value);
    return;
  }
  if (method === "thread/unsubscribe") {
    const mode = params.threadId === original?.forkId ? originalReleaseMode : "confirmed";
    unsubscribeAttempts.push({ threadId: params.threadId, mode });
    log("unsubscribe-attempt", { threadId: params.threadId, mode });
    if (mode === "failed") return send({ id, error: { code: -32000, message: "Original fork unsubscribe acknowledgement unconfirmed" } });
    if (mode === "invalid") return reply(id, originalReleaseResult);
    if (mode === "held") { heldUnsubscribes.push({ id, threadId: params.threadId }); return; }
    return acknowledgeUnsubscribe(id, params.threadId);
  }
  if (method === "turn/interrupt") {
    log("interrupt", { threadId: params.threadId, turnId: params.turnId, mode: interruptMode });
    if (interruptMode === "failed") return send({ id, error: { code: -32000, message: "Original conversion interruption unconfirmed" } });
    const active = models.find((value) => value.threadId === params.threadId && value.turnId === params.turnId);
    if (active) active.active = false;
    return reply(id, {});
  }
  if (method === "fixture/setFirstModelMode") firstModelMode = params.mode;
  if (method === "fixture/setInterruptMode") interruptMode = params.mode;
  if (method === "fixture/releaseOriginal") receipt(original);
  if (method === "fixture/setOriginalReleaseMode") {
    originalReleaseMode = params.mode;
    if ("result" in params) originalReleaseResult = params.result;
  }
  if (method === "fixture/releaseOriginalUnsubscribe") {
    originalReleaseMode = "confirmed";
    for (const value of heldUnsubscribes.splice(0)) acknowledgeUnsubscribe(value.id, value.threadId);
  }
  if (method?.startsWith("fixture/")) return reply(id, stats());
  return reply(id, {});
});
input.on("close", () => log("process-eof", { loaded: [...loaded] }));

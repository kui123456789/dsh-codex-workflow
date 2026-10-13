import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Hold two successive real model replies on one unchanged Reviewer thread.
const [journal, observationDelay = "0"] = process.argv.slice(2);
const threads = new Map(), accepted = [], requests = [], interrupts = [], unsubscribes = [];
let writerConflicts = 0, interruptMode = "failed";
const review = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Read-only lifecycle requirements verified.";
const log = (kind, detail = {}) => appendFileSync(journal, JSON.stringify({ kind, processId: process.pid, ...detail }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32000, message } });
const stats = () => ({ processId: process.pid, threadStarts: [...threads.values()].map(({ turns, ...thread }) => thread),
  turnStartRequests: requests, interrupts, unsubscribes, writerConflicts,
  active: accepted.filter((value) => value.active).map(({ threadId, turnId }) => ({ threadId, turnId })) });
function receipt(value) {
  if (value.replied) return;
  value.replied = true;
  reply(value.requestId, { turn: { id: value.turnId }, ...(value.method === "review/start" ? { reviewThreadId: value.threadId } : {}) });
  log("original-receipt", { requestId: value.requestId, threadId: value.threadId, turnId: value.turnId, stage: value.stage });
}
function complete(value, status = "completed") {
  if (!value.active) return;
  value.active = false;
  const text = value.stage === "alignment" ? JSON.stringify({ aligned: true, conflicts: [] })
    : value.stage === "conversion" ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "Read-only lifecycle requirements verified." }) : review;
  const turn = { id: value.turnId, status, items: status === "completed" ? [{ id: `${value.turnId}:result`, type: "agentMessage", text }] : [] };
  threads.get(value.threadId).turns.push(turn);
  if (status === "completed") send({ method: "item/agentMessage/delta", params: {
    threadId: value.threadId, turnId: value.turnId, itemId: `${value.turnId}:result`, delta: text } });
  send({ method: "turn/completed", params: { threadId: value.threadId, turn } });
  log("original-completed", { threadId: value.threadId, turnId: value.turnId, status, stage: value.stage });
}
log("process-start");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") return;
  if (method === "initialize") return reply(id, { userAgent: "bridge-successive-receipts" });
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "collaborationMode/list") return reply(id, { data: [{ name: "Plan", mode: "plan", model: "model-A", reasoning_effort: "low" }] });
  if (method === "thread/start" || method === "thread/fork") {
    const thread = { threadId: `generation-thread-${threads.size + 1}`, method, ephemeral: params.ephemeral, turns: [] };
    threads.set(thread.threadId, thread); log("thread-created", { threadId: thread.threadId, method });
    return reply(id, { thread: { id: thread.threadId, turns: [] } });
  }
  if (method === "thread/read" || method === "thread/resume") return reply(id, { thread: { id: params.threadId, turns: threads.get(params.threadId)?.turns ?? [] } });
  if (method === "turn/start" || method === "review/start") {
    const stage = params.outputSchema?.properties?.aligned ? "alignment" : params.outputSchema?.properties?.verdict ? "conversion" : "visible";
    const originalActive = accepted.some((value) => value.active && value.threadId === params.threadId);
    const request = { requestId: id, method, threadId: params.threadId, stage, originalActive };
    requests.push(request); log("model-start-rpc", request);
    if (originalActive) { writerConflicts += 1; return error(id, "The original local model writer is still active"); }
    if (!threads.has(params.threadId)) return error(id, "thread does not exist");
    const value = { ...request, turnId: `generation-turn-${accepted.length + 1}`, active: true, replied: false,
      held: stage === "visible" || stage === "conversion" };
    accepted.push(value); log("model-accepted", value);
    if (!value.held) { receipt(value); complete(value); }
    return;
  }
  if (method === "turn/interrupt") {
    const value = accepted.find((entry) => entry.threadId === params.threadId && entry.turnId === params.turnId);
    const entry = { threadId: params.threadId, turnId: params.turnId, mode: interruptMode };
    interrupts.push(entry); log("actual-interrupt", entry);
    if (!value || interruptMode !== "confirmed") return error(id, "Original fixture interrupt ACK unconfirmed");
    complete(value, "interrupted"); return reply(id, {});
  }
  if (method === "thread/unsubscribe") {
    unsubscribes.push(params.threadId); log("actual-unsubscribe", { threadId: params.threadId }); return reply(id, { status: "unsubscribed" });
  }
  if (method === "fixture/releaseReceipt") receipt(accepted.find((value) => value.stage === params.stage));
  if (method === "fixture/completeOriginal") complete(accepted.find((value) => value.stage === params.stage));
  if (method === "fixture/setInterruptMode") interruptMode = params.mode;
  if (method === "fixture/completeActive") for (const value of accepted) { receipt(value); complete(value); }
  if (method === "fixture/stats" && Number(observationDelay) > 0) {
    return setTimeout(() => reply(id, stats()), Number(observationDelay));
  }
  if (method?.startsWith("fixture/")) return reply(id, stats());
  return reply(id, {});
});
input.on("close", () => log("process-eof"));

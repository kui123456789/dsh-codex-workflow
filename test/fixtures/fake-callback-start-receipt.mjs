import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [journal, gates, mode, laterReceiptDelay = "0", heldReceiptDelay = "0"] = process.argv.slice(2);
const accepted = [], threads = new Map();
let processed = 0, pendingHeld = false;
const review = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Requirements verified.";
const verdict = { verdict: "pass", findings: [], testGaps: [], summary: "Requirements verified." };
const log = (kind, detail = {}) => appendFileSync(journal, JSON.stringify({ kind, pid: process.pid, ...detail }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
function receipt(value) {
  value.replied = true;
  reply(value.id, { turn: { id: value.turnId } });
  log("original-receipt", { index: value.index, threadId: value.threadId, turnId: value.turnId });
}
function complete(value, status = "completed") {
  if (!value.active) return;
  value.active = false;
  const text = value.stage === "conversion" ? JSON.stringify(verdict)
    : value.stage === "visible" && mode.startsWith("rewrite") ? "pass" : review;
  const turn = { id: value.turnId, status, items: status === "completed" ? [{ id: "result", type: "agentMessage", text }] : [] };
  threads.get(value.threadId).turns.push(turn);
  if (status === "completed") send({ method: "item/agentMessage/delta", params: {
    threadId: value.threadId, turnId: value.turnId, itemId: "result", delta: text } });
  send({ method: "turn/completed", params: { threadId: value.threadId, turn } });
  log("original-completed", { index: value.index, threadId: value.threadId, turnId: value.turnId, status });
}
log("process-start");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialize") return reply(id, { userAgent: "callback-receipt-diagnostic" });
  if (method === "initialized") return;
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "thread/start" || method === "thread/fork") {
    const threadId = "actual-diagnostic-thread-" + (threads.size + 1);
    threads.set(threadId, { id: threadId, turns: [] });
    log("thread-created", { method, threadId });
    return reply(id, { thread: threads.get(threadId) });
  }
  if (method === "thread/read" || method === "thread/resume") return reply(id, { thread: threads.get(params.threadId) });
  if (method === "turn/start") {
    const stage = params.outputSchema ? "conversion" : mode.startsWith("rewrite") && accepted.length > 0 ? "rewrite" : "visible";
    const value = { id, index: accepted.length, threadId: params.threadId, turnId: "actual-diagnostic-turn-" + (accepted.length + 1),
      stage, active: true, replied: false, interruptConfirmed: false };
    log("model-start-rpc", { requestId: id, threadId: params.threadId, stage,
      originalActive: accepted.some((old) => old.active && old.threadId === params.threadId) });
    accepted.push(value);
    const holdStage = mode.startsWith("rewrite") ? "rewrite" : mode.startsWith("conversion") || mode.startsWith("fork") ? "conversion" : "visible";
    if (!pendingHeld && stage === holdStage) { pendingHeld = true; value.held = true; }
    else if (stage === "conversion" && Number(laterReceiptDelay) > 0) {
      setTimeout(() => { receipt(value); complete(value); }, Number(laterReceiptDelay));
    } else { receipt(value); complete(value); }
    log("model-accepted", value);
    return;
  }
  if (method === "turn/interrupt") {
    const value = accepted.find((old) => old.threadId === params.threadId && old.turnId === params.turnId);
    log("actual-interrupt", { threadId: params.threadId, turnId: params.turnId, confirmed: value?.interruptConfirmed });
    if (!value?.interruptConfirmed) return send({ id, error: { code: -32000, message: "diagnostic interrupt ACK withheld" } });
    complete(value, "interrupted"); return reply(id, {});
  }
  if (method === "thread/unsubscribe") { log("actual-unsubscribe", { threadId: params.threadId }); return reply(id, { status: "unsubscribed" }); }
  if (method === "fixture/completeActive") { for (const value of accepted) complete(value); }
  if (method === "fixture/setInterruptMode") { for (const value of accepted) value.interruptConfirmed = true; }
  return reply(id, {});
});
const timer = setInterval(() => {
  if (!existsSync(gates)) return;
  const commands = readFileSync(gates, "utf8").trim().split("\n").filter(Boolean);
  while (processed < commands.length) {
    const command = JSON.parse(commands[processed++]);
    const value = accepted.find((entry) => entry.held);
    if (command.kind === "receipt") {
      if (Number(heldReceiptDelay) > 0) setTimeout(() => receipt(value), Number(heldReceiptDelay));
      else receipt(value);
    }
    if (command.kind === "complete") complete(value);
    if (command.kind === "confirm") value.interruptConfirmed = true;
    log("gate-processed", { ordinal: processed, gateKind: command.kind });
  }
}, 5);
input.on("close", () => { clearInterval(timer); log("process-eof"); });

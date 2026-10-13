import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Real SDK stdio upstream: only the local model's output and gates are synthetic.
const [journal, gates, mode] = process.argv.slice(2);
const threads = new Map(), accepted = [], inputs = new Map();
let processed = 0, interruptMode = "failed";
const plan = "<proposed_plan>\n# Goal\nImplement read-only local configuration diagnostics.\n# Changes\n- Inspect existing configuration without modifying user data.\n# Verification\n- Verify valid, missing and malformed local inputs.\n# Risks\n- Preserve all original files and existing storage.\n</proposed_plan>";
const log = (kind, detail = {}) => appendFileSync(journal, JSON.stringify({ kind, processId: process.pid,
  parentProcessId: process.ppid, ...detail }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32000, message } });
function receipt(value) {
  if (value.replied) throw new Error("Original receipt cannot be repeated");
  value.replied = true;
  reply(value.id, { turn: { id: value.turnId } });
  log("original-receipt", { requestId: value.id, threadId: value.threadId, turnId: value.turnId });
}
function complete(value, status = "completed") {
  if (!value.active) return;
  value.active = false;
  const text = value.schema ? JSON.stringify({ status: "ready", planMarkdown: plan, questions: [], assumptions: [] }) : plan;
  send({ method: "turn/completed", params: { threadId: value.threadId, turn: { id: value.turnId,
    status, items: status === "completed" ? [{ id: `${value.turnId}:message`, type: "agentMessage", text }] : [] } } });
  log("completion", { threadId: value.threadId, turnId: value.turnId, status });
}
function requestInput(value) {
  if (!value.replied || !value.active) throw new Error("Native input requires the original active acknowledged turn");
  const requestId = `native-input:${value.turnId}`;
  inputs.set(requestId, value);
  send({ id: requestId, method: "item/tool/requestUserInput", params: {
    threadId: value.threadId, turnId: value.turnId, itemId: `input-item:${value.turnId}`,
    questions: [{ id: "scope", header: "Scope", question: "Which existing configuration should be inspected?",
      isOther: true, isSecret: false, options: [] }],
  } });
  log("native-input", { requestId, threadId: value.threadId, turnId: value.turnId });
}
log("process-start", { mode });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const wire = JSON.parse(line);
  if (!wire.method) {
    const value = inputs.get(wire.id);
    log("native-answer", { requestId: wire.id, result: wire.result, originalActive: Boolean(value?.active) });
    if (!value) throw new Error("Native answer did not address the original outstanding request");
    inputs.delete(wire.id); complete(value); return;
  }
  const { id, method, params = {} } = wire;
  if (method === "initialize") return reply(id, { userAgent: "original-receipt-input-handoff" });
  if (method === "initialized") return;
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "collaborationMode/list") return reply(id, { data: [{ name: "Plan", mode: "plan", model: "model-A", reasoning_effort: "low" }] });
  if (method === "thread/start") {
    const threadId = `handoff-thread-${threads.size + 1}`;
    threads.set(threadId, {}); log("thread-created", { threadId }); return reply(id, { thread: { id: threadId } });
  }
  if (method === "turn/start") {
    const originalActive = accepted.some((value) => value.active && value.threadId === params.threadId);
    log("model-request", { requestId: id, threadId: params.threadId, schema: Boolean(params.outputSchema),
      prompt: params.input?.[0]?.text, originalActive });
    if (!threads.has(params.threadId)) return error(id, "thread does not exist");
    if (originalActive) return error(id, "thread-store conflict: original turn still has an active writer");
    const value = { id, threadId: params.threadId, turnId: `handoff-turn-${accepted.length + 1}`,
      schema: Boolean(params.outputSchema), active: true, replied: false };
    accepted.push(value); log("writer-accepted", { index: accepted.length - 1, ...value });
    // Keep the first actual model request's reply on its original RPC route.
    if (accepted.length > 1) { receipt(value); complete(value); }
    return;
  }
  if (method === "turn/interrupt") {
    const value = accepted.find((entry) => entry.threadId === params.threadId && entry.turnId === params.turnId);
    log("interrupt-request", { threadId: params.threadId, turnId: params.turnId, confirmed: interruptMode === "confirmed-no-completion" });
    if (!value || interruptMode === "failed") return error(id, "Original interruption acknowledgement unconfirmed");
    // A successful real ACK stops this writer without a completion notification.
    value.active = false;
    reply(id, {});
    log("interrupt-ack", { threadId: value.threadId, turnId: value.turnId, completionSent: false });
    return;
  }
  if (method === "thread/unsubscribe") { log("unsubscribe", { threadId: params.threadId }); return reply(id, { status: "unsubscribed" }); }
  if (method === "fixture/setInterruptMode") { interruptMode = params.mode === "failed" ? "failed" : "confirmed-no-completion"; return reply(id, {}); }
  if (method === "fixture/completeActive") { for (const value of accepted) complete(value); return reply(id, {}); }
  if (method === "fixture/stats") return reply(id, { processId: process.pid,
    active: accepted.filter((value) => value.active).map(({ threadId, turnId }) => ({ threadId, turnId })) });
  return reply(id, {});
});
const poll = setInterval(() => {
  if (!existsSync(gates)) return;
  const commands = readFileSync(gates, "utf8").trim().split("\n").filter(Boolean);
  while (processed < commands.length) {
    const command = JSON.parse(commands[processed++]);
    const value = accepted[command.index ?? 0];
    if (command.kind === "receipt") receipt(value);
    else if (command.kind === "input") requestInput(value);
    else if (command.kind === "confirm-without-completion") interruptMode = "confirmed-no-completion";
    else throw new Error(`Unknown input handoff gate ${command.kind}`);
    log("gate-processed", { ordinal: processed, gateKind: command.kind });
  }
}, 5);
input.on("close", () => { clearInterval(poll); log("stdin-eof"); });

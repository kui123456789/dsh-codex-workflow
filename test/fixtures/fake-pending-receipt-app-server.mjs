import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const [journal, gates] = process.argv.slice(2);
const accepted = [], threads = new Map(), interrupts = [], unsubscribes = [];
let processed = 0;
const plan = "<proposed_plan>\n# Goal\nPlan a read-only synthetic local diagnostic.\n# Changes\n- Observe local inputs without changing data.\n# Verification\n- Verify valid and unavailable local inputs.\n# Risks\n- Preserve all original local files.\n</proposed_plan>";
const log = (kind, detail = {}) => appendFileSync(journal, JSON.stringify({ kind, processId: process.pid,
  parentProcessId: process.ppid, ...detail }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
const stats = () => ({ processId: process.pid, accepted: accepted.map(({ id, ...value }) => value), interrupts, unsubscribes,
  active: accepted.filter((value) => value.active).map(({ threadId, turnId }) => ({ threadId, turnId })) });
function complete(value, status = "completed") {
  value.active = false;
  const text = value.schema ? JSON.stringify({ status: "ready", planMarkdown: plan, questions: [], assumptions: [] })
    : value.planner ? plan : "Synthetic accepted delayed-receipt output";
  send({ method: "turn/completed", params: { threadId: value.threadId,
    turn: { id: value.turnId, status, items: status === "completed" ? [{ id: "synthetic-result", type: "agentMessage", text }] : [] } } });
  log("actual-completion", { threadId: value.threadId, turnId: value.turnId, status });
}
function receipt(value) {
  value.replied = true;
  reply(value.id, { turn: { id: value.turnId }, ...(value.method === "review/start" ? { reviewThreadId: value.threadId } : {}) });
  log("actual-original-receipt", { requestId: value.id, threadId: value.threadId, turnId: value.turnId,
    sourceThreadId: value.sourceThreadId, method: value.method });
}
function frame(command) {
  const value = accepted[command.index ?? 0];
  const params = { threadId: value.threadId, turnId: value.turnId, questions: [{ id: "scope", question: "Synthetic scope" }] };
  if (command.variant === "missing-turn") { delete params.turnId; params.itemId = "synthetic-input"; }
  if (command.variant === "foreign") params.turnId = "foreign-unverified-turn";
  if (command.variant === "bad-question") { params.itemId = "synthetic-input"; params.questions = [{ id: "scope" }]; }
  if (command.variant === "no-scope") { delete params.threadId; delete params.turnId; }
  if (command.variant === "turn-only") delete params.threadId;
  const message = { id: "synthetic-early-input-" + command.variant, method: "item/tool/requestUserInput", params };
  const encoded = JSON.stringify(message) + "\n";
  log("actual-frame-before-receipt", { variant: command.variant, requestId: value.id,
    receiptAlreadySent: value.replied, bytes: Buffer.byteLength(encoded), sha256: createHash("sha256").update(encoded).digest("hex"),
    actualPair: { threadId: value.threadId, turnId: value.turnId } });
  process.stdout.write(encoded);
}
log("start");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialize") return reply(id, { userAgent: "pending-receipt-fixture" });
  if (method === "initialized") return;
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "collaborationMode/list") return reply(id, { data: [{ name: "Plan", mode: "plan", model: "model-A", reasoning_effort: "low" }] });
  if (method === "thread/start") {
    const threadId = "synthetic-source-thread-" + (threads.size + 1);
    threads.set(threadId, {}); return reply(id, { thread: { id: threadId } });
  }
  if (method === "turn/start" || method === "review/start") {
    const detached = method === "review/start" && params.delivery === "detached";
    const threadId = detached ? "synthetic-actual-review-destination" : params.threadId;
    const value = { id, method, sourceThreadId: params.threadId, threadId, turnId: "synthetic-accepted-turn-" + (accepted.length + 1),
      active: true, replied: false, schema: Boolean(params.outputSchema), planner: params.collaborationMode?.mode === "plan", interruptMode: "failed" };
    accepted.push(value); log("actual-writer-accepted", { index: accepted.length - 1, ...value });
    if (value.schema) { receipt(value); complete(value); }
    return;
  }
  if (method === "turn/interrupt") {
    const pair = { threadId: params.threadId, turnId: params.turnId };
    const value = accepted.find((entry) => entry.threadId === pair.threadId && entry.turnId === pair.turnId);
    interrupts.push({ ...pair, mode: value?.interruptMode }); log("actual-interrupt", pair);
    if (!value || value.interruptMode === "failed") return send({ id, error: { code: -32000, message: "Synthetic original ACK unconfirmed" } });
    complete(value, "interrupted"); return reply(id, {});
  }
  if (method === "thread/unsubscribe") {
    unsubscribes.push(params.threadId); log("actual-unsubscribe", { threadId: params.threadId }); return reply(id, {});
  }
  if (method === "fixture/stats") return reply(id, stats());
  return reply(id, {});
});
const poll = setInterval(() => {
  if (!existsSync(gates)) return;
  const commands = readFileSync(gates, "utf8").trim().split("\n").filter(Boolean);
  while (processed < commands.length) {
    const command = JSON.parse(commands[processed++]);
    const value = accepted[command.index ?? 0];
    if (command.kind === "frame") frame(command);
    else if (command.kind === "receipt") receipt(value);
    else if (command.kind === "complete") complete(value);
    else if (command.kind === "confirm") value.interruptMode = "confirmed";
    log("gate-processed", { ordinal: processed, gateKind: command.kind });
  }
}, 5);
input.on("close", () => { clearInterval(poll); log("stdin-eof"); });

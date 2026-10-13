import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const [journal] = process.argv.slice(2);
const threads = new Map();
const threadStarts = [], turnStartRequests = [], interrupts = [], unsubscribes = [];
let interruptMode = "confirmed", turnNumber = 0, nativeReplies = 0;
const log = (kind, detail = {}) => appendFileSync(journal,
  JSON.stringify({ kind, processId: process.pid, parentProcessId: process.ppid, ...detail }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32000, message } });
const stats = () => ({ processId: process.pid, nativeReplies, threadStarts, turnStartRequests, interrupts, unsubscribes,
  active: [...threads].flatMap(([threadId, state]) => state.active ? [{ threadId, turnId: state.active }] : []) });
const finish = (threadId, status) => {
  const state = threads.get(threadId), turnId = state?.active;
  if (!turnId) return;
  state.active = undefined;
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
};
const frame = (kind, pair) => {
  const params = { ...pair, itemId: "synthetic-input-item", questions: [{ id: "scope", header: "Scope",
    question: "Choose the synthetic local scope", options: [], isOther: true, isSecret: false }] };
  if (kind === "missing-item") delete params.itemId;
  if (kind === "missing-thread") delete params.threadId;
  if (kind === "bad-question") params.questions = [{ id: "scope" }];
  if (kind === "foreign") { params.threadId = "foreign-unregistered-thread"; delete params.itemId; }
  if (kind === "ambiguous") { delete params.threadId; delete params.turnId; delete params.itemId; }
  const message = { id: "synthetic-input-" + kind, method: "item/tool/requestUserInput", params };
  const encoded = JSON.stringify(message) + "\n";
  log("actual-frame-write", { frameKind: kind, bytes: Buffer.byteLength(encoded),
    sha256: createHash("sha256").update(encoded).digest("hex"), activePairs: stats().active });
  process.stdout.write(encoded);
};
log("start");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.result?.answers) { nativeReplies += 1; log("native-answer"); finish([...threads.keys()][0], "completed"); }
    else log("native-error-reply");
    return;
  }
  const { id, method, params = {} } = message;
  if (method === "initialize") return reply(id, { userAgent: "protocol-failure-fixture" });
  if (method === "initialized") return;
  if (method === "model/list") return reply(id, { data: [{ id: "model-A", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "collaborationMode/list") return reply(id, { data: [{ name: "Plan", mode: "plan", model: "model-A", reasoning_effort: "low" }] });
  if (method === "thread/start") {
    const threadId = "synthetic-thread-" + (threads.size + 1);
    threads.set(threadId, { active: undefined }); threadStarts.push({ threadId });
    return reply(id, { thread: { id: threadId } });
  }
  if (method === "turn/start") {
    const state = threads.get(params.threadId);
    if (state?.active) return error(id, "synthetic writer conflict");
    const turnId = "synthetic-turn-" + (++turnNumber);
    state.active = turnId;
    turnStartRequests.push({ threadId: params.threadId, turnId });
    log("turn-start", { threadId: params.threadId, turnId });
    return reply(id, { turn: { id: turnId } });
  }
  if (method === "turn/interrupt") {
    const pair = { threadId: params.threadId, turnId: params.turnId };
    interrupts.push({ ...pair, mode: interruptMode }); log("interrupt", pair);
    if (interruptMode === "failed") return error(id, "synthetic original interruption ACK failed");
    if (threads.get(pair.threadId)?.active !== pair.turnId) return error(id, "synthetic original turn mismatch");
    finish(pair.threadId, "interrupted"); return reply(id, {});
  }
  if (method === "thread/unsubscribe") { unsubscribes.push(params.threadId); return reply(id, { status: "unsubscribed" }); }
  if (method === "fixture/stats") return reply(id, stats());
  if (method === "fixture/setInterruptMode") { interruptMode = params.mode; return reply(id, stats()); }
  if (method === "fixture/sendFrame") {
    reply(id, { sent: true });
    if (params.kind === "healthy") send({ method: "future/unknownNotification", params: {} });
    frame(params.kind, params.pair ?? stats().active[0]);
    if (params.secondKind) frame(params.secondKind, params.pair ?? stats().active[0]);
    return;
  }
  if (method === "fixture/completeActive") {
    for (const [threadId] of threads) finish(threadId, "interrupted");
    return reply(id, stats());
  }
  return reply(id, {});
});
input.on("close", () => log("stdin-eof"));

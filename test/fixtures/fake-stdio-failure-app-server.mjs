import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, journal] = process.argv.slice(2);
const log = (kind, extra = {}) => appendFileSync(journal,
  JSON.stringify({ kind, processId: process.pid, parentProcessId: process.ppid, ...extra }) + "\n");
const reply = (id, result, callback) => process.stdout.write(JSON.stringify({ id, result }) + "\n", callback);
const keeper = setInterval(() => {}, 1000);
let paused = false;
const input = createInterface({ input: process.stdin });
log("start", { mode });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  log("rpc", { method, ...(typeof params.payload === "string" ? { payloadBytes: Buffer.byteLength(params.payload) } : {}) });
  if (method === "initialize") return reply(id, { userAgent: "stdio-failure-fixture" });
  if (method === "initialized") return;
  if (method === "model/list") return reply(id, { data: [{ id: "pipe-model", isDefault: true, defaultReasoningEffort: "low" }] });
  if (method === "thread/start") return reply(id, { thread: { id: "stdio-thread-1" } });
  if (method === "thread/unsubscribe") return reply(id, { status: "unsubscribed" });
  if (method === "fixture/pauseRead") return reply(id, { processId: process.pid }, () => {
    paused = true;
    input.pause(); process.stdin.pause();
    log("reader-paused", { paused: process.stdin.isPaused() });
  });
  if (method === "fixture/large") return reply(id, { receivedBytes: Buffer.byteLength(params.payload) });
  return reply(id, { ok: true });
});
input.on("close", () => { log("stdin-eof", { paused }); if (!paused) clearInterval(keeper); });
process.on("exit", (code) => log("exit", { code }));

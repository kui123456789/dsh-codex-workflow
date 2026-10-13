import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, journal] = process.argv.slice(2);
const OLD = "DSH_LOCAL_OLD_STDERR_GENERATION";
const CURRENT = "DSH_LOCAL_CURRENT_STDERR_GENERATION";
const log = (kind, detail = {}) => appendFileSync(journal,
  JSON.stringify({ kind, processId: process.pid, parentProcessId: process.ppid, mode, ...detail }) + "\n");
const reply = (id, result, callback) => process.stdout.write(JSON.stringify({ id, result }) + "\n", callback);
log("start");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  log("rpc", { method });
  if (method === "initialize") return reply(id, { userAgent: "stderr-origin-fixture" });
  if (method === "initialized") return;
  if (method === "model/list") {
    if (!mode.startsWith("current")) return reply(id, { data: [{ id: "stderr-model", isDefault: true }] });
    const fail = () => { log("current-exit", { code: 42 }); process.exit(42); };
    if (mode === "current-silent") return fail();
    log("current-external-stderr-write", { bytes: Buffer.byteLength(CURRENT) });
    return process.stderr.write(CURRENT, fail);
  }
  if (method === "fixture/flood") {
    return reply(id, { processId: process.pid, bytes: params.bytes }, () => {
      const unit = Buffer.from(OLD + "\n");
      const bytes = Buffer.alloc(params.bytes);
      for (let offset = 0; offset < bytes.length; offset += unit.length) unit.copy(bytes, offset);
      log("old-external-stderr-write-begin", { bytes: bytes.length });
      if (mode === "old-drained") {
        return process.stderr.write(bytes, () => { log("old-flushed-exit", { code: 41 }); process.exit(41); });
      }
      // On Windows this real pipe write may block with unread OS bytes. Its
      // exact parent ChildProcess is intentionally terminated by the actor
      // after the ACK and an observed readable buffer, so no timer must fire
      // in the blocked writer. No stream event is fabricated.
      const accepted = process.stderr.write(bytes);
      log("old-external-stderr-write-returned", { accepted, writableLength: process.stderr.writableLength });
    });
  }
  return reply(id, {});
});
input.on("close", () => log("stdin-eof"));
process.on("exit", (code) => log("process-exit", { code }));

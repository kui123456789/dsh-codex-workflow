import { appendFileSync, writeFileSync } from "node:fs";

// Deterministic fake `codex` executable for callback tests. The child is
// READ-ONLY: it never writes the bridge queue or invokes respond; it only
// reports argv/stdin to marker files and emits a JSONL event stream.
//   FAKE_CALLBACK_ARGS_FILE  - append argv (JSON) to this file
//   FAKE_CALLBACK_STDIN_FILE - write the full stdin to this file
//   FAKE_CALLBACK_EXIT       - exit code (default 0)
//   FAKE_CALLBACK_JSONL      - raw JSONL event stream written to stdout
//   FAKE_CALLBACK_VERDICT    - JSON verdict text wrapped in a final
//                              item.completed agent_message event
//   FAKE_CALLBACK_STDERR     - text written to stderr before exiting
//   FAKE_CALLBACK_HANG       - when "1", never exit (timeout tests)
//   FAKE_CALLBACK_CHUNK_AT   - byte offset: stdout is written in two writes
//                              split at this raw-byte boundary with a delay,
//                              so multi-byte UTF-8 crosses a chunk boundary
//   FAKE_CALLBACK_STDOUT_BYTES - write this many bytes of "x" to stdout
//                                (byte-limit overflow tests)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const argsFile = process.env.FAKE_CALLBACK_ARGS_FILE;
if (argsFile) {
  appendFileSync(argsFile, `${JSON.stringify(process.argv.slice(2))}\n`);
}
const stdinFile = process.env.FAKE_CALLBACK_STDIN_FILE;
if (stdinFile) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  writeFileSync(stdinFile, Buffer.concat(chunks).toString("utf8"));
}
let output = "";
if (process.env.FAKE_CALLBACK_JSONL) output = process.env.FAKE_CALLBACK_JSONL;
else if (process.env.FAKE_CALLBACK_VERDICT) {
  const text = process.env.FAKE_CALLBACK_VERDICT;
  output = [
    JSON.stringify({ type: "thread.started", thread_id: "00000000-0000-0000-0000-000000000000" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } }),
    JSON.stringify({ type: "turn.completed", turn: { id: "turn-1", status: "completed" } }),
  ].join("\n");
}
const stdoutBytes = Number(process.env.FAKE_CALLBACK_STDOUT_BYTES ?? "0");
if (stdoutBytes > 0) {
  // A big single write exercises the byte counter, not the string length.
  process.stdout.write(Buffer.alloc(stdoutBytes, 0x78));
  output = "";
} else if (process.env.FAKE_CALLBACK_CHUNK_AT) {
  const at = Number(process.env.FAKE_CALLBACK_CHUNK_AT);
  const buf = Buffer.from(output, "utf8");
  process.stdout.write(buf.subarray(0, at));
  await sleep(60);
  process.stdout.write(buf.subarray(at));
  output = "";
}
if (output) process.stdout.write(output);
if (process.env.FAKE_CALLBACK_STDERR) process.stderr.write(process.env.FAKE_CALLBACK_STDERR);
if (process.env.FAKE_CALLBACK_HANG === "1") {
  await new Promise(() => setTimeout(() => undefined, 2 ** 31 - 1));
}
process.exit(Number(process.env.FAKE_CALLBACK_EXIT ?? "0"));
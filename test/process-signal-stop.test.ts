import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { stopProcess } from "../src/infrastructure/process-transport.js";

async function fixture(t: TestContext, mode: "loop" | "exit" | "eof" | "eof-observed") {
  const script = mode === "exit" ? "process.exit(0);" : [
    "process.stdin.resume();",
    mode === "eof" ? 'process.stdin.once("end", () => process.exit(0));'
      : 'process.stdin.once("end", () => process.stdout.write("EOF\\n"));',
    'process.stdout.write("READY\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: "pipe" });
  const close = once(child, "close");
  const nativeKill = child.kill.bind(child);
  const ready = mode === "exit" ? Promise.resolve() : new Promise<void>(resolve => {
    let text = "";
    child.stdout!.on("data", chunk => { text += String(chunk); if (text.includes("READY\n")) resolve(); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) nativeKill("SIGKILL");
    await close;
  });
  await once(child, "spawn");
  await ready;
  const signals: Array<NodeJS.Signals | number> = [];
  const kill = t.mock.method(child, "kill", (signal?: NodeJS.Signals | number) => {
    signals.push(signal ?? "SIGTERM");
    return nativeKill(signal);
  });
  const end = t.mock.method(child.stdin!, "end");
  return { child, close, nativeKill, kill, end, signals };
}

test("stop does not touch stdin or send more signals to an already signalled original child", async t => {
  const f = await fixture(t, "loop");
  f.nativeKill("SIGTERM");
  await f.close;
  assert.equal(f.child.exitCode, null);
  assert.equal(f.child.signalCode, "SIGTERM");
  await stopProcess(f.child, 1000, 1000);
  assert.equal(f.end.mock.calls.length, 0);
  assert.deepEqual(f.signals, []);
  t.diagnostic(JSON.stringify({ exitCode: f.child.exitCode, signalCode: f.child.signalCode,
    stdinEndsAfterExit: f.end.mock.calls.length, signalsAfterExit: f.signals }));
});

test("stop does not close stdin again after a genuine numeric exit", async t => {
  const f = await fixture(t, "exit");
  await f.close;
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.child.signalCode, null);
  await stopProcess(f.child, 1000, 1000);
  assert.equal(f.end.mock.calls.length, 0);
  assert.deepEqual(f.signals, []);
});

test("a genuine signal exit during the stdin grace window prevents further escalation", async t => {
  const f = await fixture(t, "eof-observed");
  let eof = false;
  let streamed = "";
  f.child.stdout!.on("data", chunk => {
    streamed += String(chunk);
    if (!eof && streamed.includes("EOF\n")) { eof = true; f.nativeKill("SIGTERM"); }
  });
  await stopProcess(f.child, 1000, 1000);
  await f.close;
  assert.equal(eof, true);
  assert.equal(f.child.exitCode, null);
  assert.equal(f.child.signalCode, "SIGTERM");
  assert.equal(f.end.mock.calls.length, 1);
  assert.deepEqual(f.signals, []);
});

test("one real forced termination ends cleanup without a redundant SIGKILL", async t => {
  const f = await fixture(t, "loop");
  await stopProcess(f.child, 0, 1000);
  await f.close;
  assert.equal(f.child.exitCode, null);
  assert.equal(f.child.signalCode, "SIGTERM");
  assert.equal(f.end.mock.calls.length, 1);
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("a signal acknowledgement bit cannot skip SIGKILL while the original child is still live", async t => {
  const f = await fixture(t, "loop");
  const requested: Array<NodeJS.Signals | number> = [];
  t.mock.method(f.child, "kill", (signal?: NodeJS.Signals | number) => {
    requested.push(signal ?? "SIGTERM");
    if (signal === undefined) {
      // Local fault injection: signal acknowledgement has no exit event.
      Object.defineProperty(f.child, "killed", { value: true, writable: true });
      assert.equal(f.child.exitCode, null);
      assert.equal(f.child.signalCode, null);
      return true;
    }
    return f.nativeKill(signal);
  });
  await stopProcess(f.child, 0, 20);
  await f.close;
  assert.deepEqual(requested, ["SIGTERM", "SIGKILL"]);
  assert.equal(f.child.signalCode, "SIGKILL");
});

test("a normal stdin EOF shutdown keeps its original graceful completion", async t => {
  const f = await fixture(t, "eof");
  await stopProcess(f.child, 1000, 1000);
  await f.close;
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.child.signalCode, null);
  assert.equal(f.end.mock.calls.length, 1);
  assert.deepEqual(f.signals, []);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { stopCapturedProcessTree } from "../src/infrastructure/process-tree-cleanup.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, waitForExit } from "../src/infrastructure/process-transport.js";

const evidence = { processId: 100, processIds: [100, 101], processIdentities: [
  { processId: 100, birth: "win32:134052913570440000" }, { processId: 101, birth: "win32:134052913570440010" },
] };

test("tree cleanup never signals a PID-only capture while a captured original may remain live", async () => {
  let signals = 0;
  assert.equal(await stopCapturedProcessTree({ processId: 100, processIds: [100, 101] }, 0,
    { exited: async () => false, terminate: async () => { signals += 1; return true; } }), false);
  assert.equal(signals, 0);
});

test("a successful tree signal does not replace an independent exit proof", async () => {
  let signals = 0;
  assert.equal(await stopCapturedProcessTree(evidence, 0,
    { exited: async () => false, terminate: async () => { signals += 1; return true; } }), false);
  assert.equal(signals, 1);
});

test("a matching original tree is signaled once and confirmed only by subsequent exit", async () => {
  let signals = 0;
  assert.equal(await stopCapturedProcessTree(evidence, 0,
    { exited: async () => signals > 0, terminate: async (values) => {
      assert.deepEqual(values, evidence.processIdentities); signals += 1; return true;
    } }), true);
  assert.equal(signals, 1);
});

test("denied safe termination keeps the original cleanup unconfirmed", async () => {
  assert.equal(await stopCapturedProcessTree(evidence, 0, { exited: async () => false, terminate: async () => false }), false);
});

for (const direction of ["rollback", "advance"] as const) {
  test(`original tree cleanup grace follows elapsed time during wall-clock ${direction}`, async (t) => {
    let wall = 1000, elapsed = 0, signals = 0, checks = 0;
    let exitConfirmed = false;
    let outcome: boolean | undefined;
    t.mock.method(Date, "now", () => wall);
    t.mock.method(performance, "now", () => elapsed);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const work = stopCapturedProcessTree(evidence, direction === "rollback" ? 50 : 100, {
      exited: async (original) => { assert.equal(original, evidence); checks += 1; return exitConfirmed; },
      terminate: async (originals) => { assert.deepEqual(originals, evidence.processIdentities); signals += 1; return true; },
    }).then(value => { outcome = value; return value; });
    void work.catch(() => undefined);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(signals, 1); assert.equal(checks, 2);
      elapsed = 50; wall = direction === "rollback" ? 500 : 2000;
      t.mock.timers.tick(50);
      await new Promise<void>(resolve => setImmediate(resolve));
      t.diagnostic(JSON.stringify({ direction, elapsed, wall, outcome: outcome ?? "pending", signals, checks }));
      if (direction === "rollback") {
        assert.equal(outcome, false, "An exhausted original cleanup grace cannot be extended by a clock rollback");
      } else {
        assert.equal(outcome, undefined, "A wall-clock advance cannot retire the original observation before its grace expires");
        exitConfirmed = true; elapsed = 100;
        t.mock.timers.tick(50);
        assert.equal(await work, true, "Only the original independent exit confirmation completes cleanup");
      }
      assert.equal(signals, 1, "Clock corrections never repeat the signal or replace the original process target");
    } finally {
      // Settle the same RED probe without leaving a fake timer or promise.
      exitConfirmed = true;
      t.mock.timers.tick(100);
      await work;
    }
  });
}

test("a live process with a different captured birth is left alive by native tree cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "pipe" });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const captured = await captureProcessTreeEvidence(child.pid);
    assert.ok(captured?.processIdentities?.length);
    const original = captured.processIdentities.find((value) => value.processId === child.pid)!;
    const wrongBirth = process.platform === "win32" ? `win32:${BigInt(original.birth.slice(6)) - 10n}`
      : `${original.birth.slice(0, original.birth.lastIndexOf(":") + 1)}${BigInt(original.birth.slice(original.birth.lastIndexOf(":") + 1)) - 1n}`;
    assert.equal(await stopCapturedProcessTree({ processId: child.pid, processIds: [child.pid!],
      processIdentities: [{ ...original, birth: wrongBirth }] }, 0), true);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  } finally {
    child.kill(); await waitForExit(child, 5000);
    assert.equal(await originalProcessTreeExited({ processId: child.pid, processIds: [child.pid!] }), true);
  }
});

import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The approved local diagnostic is verified.";
const input = { implementationSummary: "Verified read-only local diagnostic", changedFiles: ["changed.txt"], testResults: "Local checks passed" };
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Only identities of the already captured tree; no command lines or full census. */
async function capturedIdentities(pids: readonly number[] | undefined): Promise<unknown> {
  if (process.platform !== "win32" || !pids?.length) return [];
  const valid = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (!valid.length) return [];
  const filter = valid.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  try {
    const { stdout } = await promisify(execFile)("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath | ConvertTo-Json -Compress`],
      { timeout: 4_000, maxBuffer: 65_536, windowsHide: true });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (error) {
    return { queryUnavailable: String((error as NodeJS.ErrnoException).code ?? "unknown") };
  }
}

for (const action of ["resume", "cancel", "stop"] as const) {
  test(`old terminal ${action} cannot interrupt or unsubscribe a reused address in a new SDK process`, async (t) => {
    const f = await sharedReviewerFixture();
    (f.client as unknown as { options: { args: string[] } }).options.args = [protocol, "--interrupt-mode", "failed"];
    let bThread: string | undefined;
    let bOperation: Promise<unknown[]> | undefined;
    let bPinned = false;
    try {
      await f.control("fixture/configure", { responses: { visible: [{ text: REVIEW }], verdict: [{ kind: "needs_input" }] } });
      const row = await f.manager.reviewOnly({ task: "Review read-only local configuration diagnostics", ...input }, f.exec);
      const original = await f.control("fixture/stats");
      const recovery = f.runtime.recoverableRuns.get(row.id);
      assert.ok(recovery?.terminalFailure);
      assert.equal(row.retryState?.awaitingCleanup, true);
      assert.equal(original.active.length, 1);
      assert.ok(recovery.originalProcessIds?.includes(original.processId));
      assert.deepEqual(f.rawDisposals, []);
      const originalChild = (f.client as unknown as { child?: ChildProcess }).child;
      t.diagnostic(JSON.stringify({ stage: "before-original-exit", action, originalPid: original.processId,
        capturedPids: recovery.originalProcessIds, identities: await capturedIdentities(recovery.originalProcessIds) }));
      await f.control("fixture/exit");
      try {
        await sharedWaitFor(() => recovery.originalProcessIds?.every(exited), "the captured original process tree exited");
      } catch (error) {
        t.diagnostic(JSON.stringify({ stage: "unconfirmed-original-tree-exit", action, originalPid: original.processId,
          capturedPids: recovery.originalProcessIds, aliveCapturedPids: recovery.originalProcessIds?.filter((pid) => !exited(pid)),
          originalChildExitCode: originalChild?.exitCode, originalChildSignalCode: originalChild?.signalCode,
          identities: await capturedIdentities(recovery.originalProcessIds) }));
        throw error;
      }
      await sharedWaitFor(() => !f.client.isThreadAvailable(original.active[0]!.threadId), "SDK observed the old backend exit");
      const restarted = await f.control("fixture/stats");
      assert.notEqual(restarted.processId, original.processId);
      f.client.beginRound(); bPinned = true;
      bThread = await f.client.startThread({ cwd: f.directory, ephemeral: true, model: "model-A" });
      await f.client.startTurn(bThread, { prompt: "Independent diagnostic control turn", model: "model-A" });
      await f.control("fixture/configure", { responses: { visible: [{ kind: "hold" }] } });
      await f.control("fixture/setInterruptMode", { mode: "confirmed" });
      const held = sharedGate();
      const turn = f.client.startTurn(bThread, { prompt: "Independent B generation must remain active", model: "model-A",
        onStarted: () => { held.enter(); } });
      bOperation = Promise.allSettled([turn]);
      await held.entered;
      const before = await f.control("fixture/stats");
      // Only this local protocol uses process-local IDs. No production CLI
      // UUID reuse is claimed; both SDK processes and their remote turns are real.
      assert.deepEqual(before.active, original.active);
      assert.equal((f.client as unknown as { pinned: number }).pinned, 2);
      if (action === "resume") await assert.rejects(f.manager.resume(row.id, undefined, f.exec), /unexpectedly requested user input/);
      else if (action === "cancel") await f.manager.cancel(row.id, f.exec);
      else await f.manager.stop();
      const after = await f.control("fixture/stats");
      assert.deepEqual(after.active, before.active, "The new backend's writer belongs to a different original execution");
      assert.deepEqual(after.interrupts, before.interrupts, "Cleanup of an exited original sends no interrupt to its successor process");
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests, "Original cleanup sends no model turn");
      assert.deepEqual((after as typeof after & { unsubscribes: string[] }).unsubscribes, [],
        "The exited original subscription sends no unsubscribe RPC to its reused text address");
      assert.equal(f.client.isThreadAvailable(bThread), true);
      assert.equal((f.client as unknown as { pinned: number }).pinned, 1);
      assert.deepEqual(f.rawDisposals, [recovery.child!.id]);
      assert.equal(f.runtime.recoverableRuns.has(row.id), false);
    } finally {
      await f.control("fixture/setInterruptMode", { mode: "confirmed" }).catch(() => undefined);
      await f.control("fixture/completeActive").catch(() => undefined);
      if (bOperation) await bOperation;
      if (bThread) await f.client.unsubscribeThread(bThread).catch(() => undefined);
      if (bPinned) f.client.endRound();
      await f.close();
    }
  });
}

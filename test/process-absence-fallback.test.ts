import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { WorkflowStore } from "../src/store.js";
import { TerminalCleanupGuard } from "../src/application/terminal-cleanup-guard.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, refreshOriginalProcessTreeEvidence, type ProcessTreeEvidence, type ProcessInstanceProbe } from "../src/infrastructure/process-transport.js";

const ordinary = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

for (const mode of ["retired", "live", "denied-then-retry"] as const) {
test(`Windows independent absence proof preserves original ownership: ${mode}`, {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-native-absence-guard-"));
  const store = new WorkflowStore(directory); await store.init();
  const client = new CodexAppServerClient({ command: process.execPath, args: [ordinary],
    requestTimeoutMs: 5000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const port = client as unknown as { child: ChildProcess };
  const originalKill = process.kill;
  const originalExecFile = childProcess.execFile;
  const inspections: unknown[] = [];
  const observeQueries = () => {
    childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
      const collect = (error: Error | null, stdout: string, stderr: string) => {
        if (args.some(value => value.includes("Get-CimInstance") || value.includes("[Diagnostics.Process]::GetProcessById"))) {
          let observed: unknown;
          try { const rows = JSON.parse(stdout); observed = Array.isArray(rows)
            ? rows.filter(row => capturedIds.includes(row.ProcessId)) : { invalidArray: true }; }
          catch { observed = { invalidJson: true }; }
          inspections.push({ kind: args.some(value => value.includes("Get-CimInstance")) ? "census" : "absence",
            queryError: error?.message, observed });
        }
        return Reflect.apply(callback as (...values: unknown[]) => unknown, undefined, [error, stdout, stderr]);
      };
      return Reflect.apply(originalExecFile, childProcess, [command, args, options, collect]);
    }) as typeof childProcess.execFile; syncBuiltinESMExports();
  };
  let capturedIds: readonly number[] = [];
  let intercepted: ReturnType<typeof t.mock.method> | undefined;
  try {
    await client.start();
    const child = port.child;
    const evidence = { processId: child.pid, ...await captureProcessTreeEvidence(child.pid) };
    capturedIds = evidence.processIds ?? [];
    assert.ok(evidence.processIdentities?.length);
    const guard = new TerminalCleanupGuard(store);
    const marker = guard.retain("original-workflow", { terminalFailure: "Original absence query pending",
      originalProcessId: evidence.processId, originalProcessIds: evidence.processIds,
      originalProcessIdentities: evidence.processIdentities, plannerIdentity: { dshSessionId: "original-session" } });
    assert.ok(marker);
    if (mode !== "live") {
      await client.stop();
      assert.equal(await originalProcessTreeExited(evidence), true, "Actual SDK retirement already confirmed the captured original instances exited");
    }
    intercepted = t.mock.method(process, "kill", ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && evidence.processIds!.includes(pid)) {
        throw Object.assign(new Error("Controlled Windows signal-probe permission failure"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill);
    if (mode === "retired") {
      childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
        const collect = (error: Error | null, stdout: string, stderr: string) => {
          if (args.some(value => value.includes("Get-CimInstance") || value.includes("[Diagnostics.Process]::GetProcessById"))) {
            let observed: unknown;
            try { const rows = JSON.parse(stdout); observed = Array.isArray(rows)
              ? rows.filter(row => evidence.processIds!.includes(row.ProcessId)) : { invalidArray: true }; }
            catch { observed = { invalidJson: true }; }
            inspections.push({ kind: args.some(value => value.includes("Get-CimInstance")) ? "census" : "absence",
              queryError: error?.message, observed });
          }
          return Reflect.apply(callback as (...values: unknown[]) => unknown, undefined, [error, stdout, stderr]);
        };
        return Reflect.apply(originalExecFile, childProcess, [command, args, options, collect]);
      }) as typeof childProcess.execFile; syncBuiltinESMExports();
    }
    if (mode === "denied-then-retry") {
      childProcess.execFile = ((command: string, args: string[], options: object, callback: unknown) => {
        if (args.some(value => value.includes("[Diagnostics.Process]::GetProcessById"))) {
          return Reflect.apply(originalExecFile, childProcess, [process.execPath, ["-e", "process.exit(13)"], options, callback]);
        }
        return Reflect.apply(originalExecFile, childProcess, [command, args, options, callback]);
      }) as typeof childProcess.execFile;
      syncBuiltinESMExports();
      assert.equal(await originalProcessTreeExited(evidence), false, "A rejected independent OS query cannot fabricate absence");
      await assert.rejects(guard.assertAvailable("original-session"), /unconfirmed.*cleanup/);
      assert.equal(guard.isConfirmed("original-workflow", marker), false);
      childProcess.execFile = originalExecFile; syncBuiltinESMExports();
      observeQueries();
    }
    assert.equal(await originalProcessTreeExited(evidence), mode !== "live",
      "EPERM stays unknown until a separate successful OS absence query confirms the retired original");
    if (mode === "retired") {
      const refreshed = await refreshOriginalProcessTreeEvidence(evidence);
      if (!refreshed) t.diagnostic(JSON.stringify({ originalEvidence: evidence, inspections }));
      assert.ok(refreshed, "Lost-process descendant refresh shares the independent absence proof");
    }
    if (mode === "live") assert.ok((await client.health()).modelCount > 0, "Live original remains available and is never signalled");
    if (mode === "live") {
      await assert.rejects(guard.assertAvailable("original-session"), /unconfirmed.*cleanup/);
      assert.equal(guard.isConfirmed("original-workflow", marker), false);
    } else {
      const confirmationDeadline = Date.now() + 4000; // Existing control-RPC budget, not a larger scenario allowance.
      try {
        while (true) {
          try { await guard.assertAvailable("original-session"); break; }
          catch (error) {
            assert.equal(guard.isConfirmed("original-workflow", marker), false,
              "An unknown OS query must preserve the same durable original guard on every retry");
            if (!(error instanceof Error) || !/unconfirmed.*cleanup/.test(error.message) || Date.now() >= confirmationDeadline) throw error;
          }
        }
      }
      catch (error) { t.diagnostic(JSON.stringify({ originalEvidence: evidence, inspections })); throw error; }
      assert.equal(guard.isConfirmed("original-workflow", marker), true, "Only independently proven original exit admits a durable confirmation");
    }
    assert.ok(intercepted.mock.callCount() > 0);
    t.diagnostic(JSON.stringify({ originalProcessId: child.pid, capturedInstances: evidence.processIds!.length,
      actualOriginalExited: child.exitCode !== null || child.signalCode !== null, injectedSignalProbe: "EPERM" }));
  } finally {
    intercepted?.mock.restore(); childProcess.execFile = originalExecFile; syncBuiltinESMExports();
    await client.stop(); store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  }
});
}

const originals: ProcessTreeEvidence = { processId: 100, processIds: [100, 101], processIdentities: [
  { processId: 100, birth: "win32:134358364500151140" }, { processId: 101, birth: "win32:134358364500623850" },
] };

test("an independently confirmed missing original PID can coexist with another still-live original", async () => {
  let requested: readonly number[] | undefined;
  const probe: ProcessInstanceProbe = { isAbsent: () => false,
    async readIdentities() { return [originals.processIdentities![1]!]; },
    async confirmAbsent(ids) { requested = ids; return [100]; },
  };
  assert.equal(await originalProcessTreeExited(originals, probe), false);
  assert.deepEqual(requested, [100], "Fallback never overrides a reported matching original birth");
});

for (const mode of ["denied", "empty", "partial", "foreign", "duplicate", "throws"] as const) {
test(`missing identity rows require valid independent absence proof: ${mode}`, async () => {
  const probe: ProcessInstanceProbe = { isAbsent: () => false, async readIdentities() { return []; },
    async confirmAbsent() {
      if (mode === "denied") return undefined;
      if (mode === "empty") return [];
      if (mode === "partial") return [100];
      if (mode === "foreign") return [100, 102];
      if (mode === "duplicate") return [100, 100, 101];
      throw new Error("Independent query failed");
    },
  };
  assert.equal(await originalProcessTreeExited(originals, probe), false);
});
}

test("a failed identity query and missing original births cannot be replaced with an absence receipt", async () => {
  let queries = 0;
  const probe: ProcessInstanceProbe = { isAbsent: () => false, async readIdentities() { return undefined; },
    async confirmAbsent() { queries++; return [100, 101]; },
  };
  assert.equal(await originalProcessTreeExited(originals, probe), false);
  assert.equal(await originalProcessTreeExited({ processId: 100, processIds: [100, 101] }, probe), false);
  assert.equal(queries, 0);
});

test("independent absence cannot lend a reused live PID's descendants to an original refresh", async () => {
  let queries = 0;
  const refreshed = await refreshOriginalProcessTreeEvidence(originals, { isAbsent: pid => pid === 100,
    async capture() { return { processIds: [101], processIdentities: [
      { processId: 101, birth: "win32:134358364500624000" },
    ] }; },
    async confirmAbsent() { queries++; return []; },
  });
  assert.deepEqual(refreshed, originals);
  assert.equal(queries, 1, "A live reused PID supplies no absence receipt and its descendants remain unrelated");
});

test("a complete independent absence receipt retires original roots without requiring a descendant census", async () => {
  let censuses = 0;
  const refreshed = await refreshOriginalProcessTreeEvidence(originals, { isAbsent: () => false,
    async confirmAbsent(ids) { assert.deepEqual(ids, [100, 101]); return [100, 101]; },
    async capture() { censuses++; throw new Error("An absent root has no descendant census"); },
  });
  assert.deepEqual(refreshed, originals);
  assert.equal(censuses, 0);
});

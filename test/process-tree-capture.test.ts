import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import fs, { type PathLike } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { captureProcessTreeEvidence, originalProcessTreeExited } from "../src/infrastructure/process-transport.js";

type CensusRow = { ProcessId: number; ParentProcessId: number; Birth?: string | null };
const root = 88788, capturedParent = 25332, staleChild = 84272;
const rootBirth = "win32:134357732495098540";
const capturedParentBirth = "win32:134357732495653800";
const staleBirth = "win32:134357729781063110";
const windowsOnly = { skip: process.platform !== "win32" };

for (const modernAvailable of [true, false]) {
  test(`Windows census uses the installed modern host with legacy fallback: ${modernAvailable}`, windowsOnly, async (t) => {
    const modern = join(process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    const legacy = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const exists = t.mock.method(fs, "existsSync", (path: PathLike) => String(path) === modern && modernAvailable);
    let invoked: string | undefined;
    const execute = t.mock.method(childProcess, "execFile", ((command: string, args: string[], options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      invoked = command;
      assert.equal(options.timeout, 4000);
      assert.ok(args.some(value => value.includes("Get-CimInstance Win32_Process") && value.includes("ToFileTimeUtc")));
      queueMicrotask(() => callback(null, JSON.stringify([{ ProcessId: root, ParentProcessId: 1, Birth: rootBirth }]), ""));
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    try {
      const result = await captureProcessTreeEvidence(root);
      assert.equal(invoked, modernAvailable ? modern : legacy);
      assert.deepEqual(result?.processIdentities, [{ processId: root, birth: rootBirth }]);
    } finally { execute.mock.restore(); exists.mock.restore(); syncBuiltinESMExports(); }
  });
}

/** This is a controlled metadata replay through the real producer, not a
 * claim that these PIDs are presently owned SDK processes. The real stale
 * ParentProcessId failure was recorded independently during the related gate.
 * No process is spawned or signalled; only the native census output is stubbed. */
async function capture(t: TestContext, census: CensusRow[], processId = root) {
  const stub = ((_file: string, args: string[], _options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.ok(args.some((value) => value.includes("Get-CimInstance Win32_Process")),
      "The actual Windows census adapter requests CIM metadata");
    queueMicrotask(() => callback(null, JSON.stringify(census), ""));
    return new childProcess.ChildProcess();
  }) as typeof childProcess.execFile;
  const intercepted = t.mock.method(childProcess, "execFile", stub);
  syncBuiltinESMExports();
  try {
    const result = await captureProcessTreeEvidence(processId);
    assert.equal(intercepted.mock.callCount(), 1, "The production capture function actually calls its native census adapter");
    return result;
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
}

test("controlled confirmed Windows census excludes the older stale-PPID branch and retains genuine later descendants", windowsOnly, async (t) => {
  const census: CensusRow[] = [
    { ProcessId: root, ParentProcessId: 3788, Birth: rootBirth },
    { ProcessId: capturedParent, ParentProcessId: root, Birth: capturedParentBirth },
    { ProcessId: staleChild, ParentProcessId: capturedParent, Birth: staleBirth },
    { ProcessId: 60001, ParentProcessId: root, Birth: "win32:134357732496000000" },
    { ProcessId: 60002, ParentProcessId: capturedParent, Birth: "win32:134357732496100000" },
    { ProcessId: 60003, ParentProcessId: 60001, Birth: "win32:134357732496200000" },
    { ProcessId: 60004, ParentProcessId: staleChild, Birth: "win32:134357732496300000" },
  ];
  const result = await capture(t, census);
  assert.ok(result);
  assert.deepEqual(result.processIds, [root, capturedParent, 60001, 60002, 60003],
    "An older process cannot belong to the newer parent instance at its historical numeric PPID");
  assert.deepEqual(result.processIdentities, census.filter((row) => result.processIds.includes(row.ProcessId))
    .map((row) => ({ processId: row.ProcessId, birth: row.Birth })));
});

test("controlled Windows equal-birth metadata preserves children and nested descendants", windowsOnly, async (t) => {
  const census: CensusRow[] = [
    { ProcessId: root, ParentProcessId: 3788, Birth: rootBirth },
    { ProcessId: capturedParent, ParentProcessId: root, Birth: rootBirth },
    { ProcessId: 60001, ParentProcessId: capturedParent, Birth: rootBirth },
    { ProcessId: 60002, ParentProcessId: root, Birth: "win32:134357732496100000" },
  ];
  const result = await capture(t, census);
  assert.ok(result);
  assert.deepEqual(result.processIds, [root, capturedParent, 60001, 60002],
    "CIM precision ties cannot disqualify a possible original descendant");
  assert.equal(result.processIdentities?.length, census.length);
});

test("controlled missing or malformed Windows birth metadata retains conservative PID evidence without inventing identities", windowsOnly, async (t) => {
  for (const kind of ["missing parent", "missing child", "malformed child"] as const) {
    const census: CensusRow[] = [
      { ProcessId: root, ParentProcessId: 3788, Birth: rootBirth },
      { ProcessId: capturedParent, ParentProcessId: root, Birth: capturedParentBirth },
      { ProcessId: staleChild, ParentProcessId: capturedParent, Birth: staleBirth },
    ];
    if (kind === "missing parent") census[1]!.Birth = null;
    else census[2]!.Birth = kind === "missing child" ? undefined : "win32:not-a-filetime";
    const result = await capture(t, census);
    assert.ok(result);
    assert.deepEqual(result.processIds, [root, capturedParent, staleChild],
      "Unusable edge birth data cannot prove that a potential original descendant is unrelated: " + kind);
    assert.equal(Object.hasOwn(result, "processIdentities"), false,
      "The producer omits unknown identities instead of emitting partial or fabricated births: " + kind);
    assert.equal(await originalProcessTreeExited({ processId: root, ...result }, {
      isAbsent: () => false,
      async readIdentities() { throw new Error("Unknown original births cannot be reconstructed from current instances"); },
    }), false, "Controlled live PID-only evidence cannot authorize original-tree exit: " + kind);
  }
});

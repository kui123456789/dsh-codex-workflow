import { createInterface, type Interface } from "node:readline";
import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import crossSpawn from "cross-spawn";
import type { ProcessInstanceIdentity } from "../types.js";

/** The small seam between App Server JSON-RPC and a local child process. */
export interface ProcessTransportOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedProcessTransport {
  child: ChildProcess;
  lines?: Interface;
}

/** Spawn one stdio Codex App Server and expose only its line stream. */
export function spawnProcess(options: ProcessTransportOptions): SpawnedProcessTransport {
  const child = crossSpawn(options.command, options.args ?? ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: options.env ?? process.env,
  });
  // EMFILE/ENFILE can return a ChildProcess before any stdio was assigned.
  // The owner must install its spawn-error receipt before admitting RPCs.
  return { child, ...(child.stdout ? { lines: createInterface({ input: child.stdout }) } : {}) };
}

export interface ProcessInstanceProbe {
  isAbsent(processId: number): boolean;
  readIdentities(processIds: readonly number[]): Promise<readonly ProcessInstanceIdentity[] | undefined>;
  /** Independent OS absence proof, never inference from omitted identity rows. */
  confirmAbsent?(processIds: readonly number[]): Promise<readonly number[] | undefined>;
}

export interface ProcessTreeEvidence {
  processId?: number;
  processIds?: readonly number[];
  processIdentities?: readonly ProcessInstanceIdentity[];
}

/** Sanitized observation only; it never grants process ownership or exit. */
export interface ProcessTreeCaptureObservation {
  readonly processId?: number;
  readonly code: "captured" | "query_failed" | "query_terminated" | "permission_denied" | "output_limit"
    | "invalid_response" | "root_missing" | "identity_incomplete" | "invalid_root" | "owner_retired";
  readonly elapsedMs: number;
  readonly limitMs: 4000;
  readonly exitCode?: number;
  readonly errno?: "EACCES" | "EPERM" | "ENOENT" | "EMFILE" | "ENFILE";
  readonly signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGABRT" | "SIGSEGV";
}

/** Refresh outcome only; even `refreshed` does not confirm original exit. */
export interface ProcessTreeRefreshObservation {
  readonly processId?: number;
  readonly code: "refreshed" | "original_identity_incomplete" | "capture_unavailable" | "current_identity_incomplete"
    | "birth_domain_mismatch" | "identity_conflict";
  readonly elapsedMs: number;
}

export type ProcessTreeObservation = ProcessTreeCaptureObservation | ProcessTreeRefreshObservation;

type CaptureFailure = Pick<ProcessTreeCaptureObservation, "code" | "exitCode" | "errno" | "signal">;

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validBirth(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const windows = /^win32:([1-9]\d{0,18})$/.exec(value);
  if (windows) return BigInt(windows[1]!) <= 2_650_467_743_999_999_999n;
  const linux = /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9]\d{0,19})$/.exec(value);
  return Boolean(linux && BigInt(linux[1]!) <= 18_446_744_073_709_551_615n);
}

/** New evidence is usable only when it describes every captured PID once. */
export function isCompleteProcessIdentityEvidence(value: {
  processId?: unknown; processIds?: unknown; processIdentities?: unknown;
}): boolean {
  if (!validPid(value.processId) || !Array.isArray(value.processIds) || !value.processIds.length
    || !value.processIds.every(validPid) || !value.processIds.includes(value.processId)
    || new Set(value.processIds).size !== value.processIds.length
    || !Array.isArray(value.processIdentities) || value.processIdentities.length !== value.processIds.length) return false;
  const seen = new Set<number>();
  for (const identity of value.processIdentities) {
    if (!identity || typeof identity !== "object" || !validPid(identity.processId) || !validBirth(identity.birth)
      || !value.processIds.includes(identity.processId) || seen.has(identity.processId)) return false;
    seen.add(identity.processId);
  }
  return true;
}

async function boundedOutput(command: string, args: string[], onFailure?: (failure: CaptureFailure) => void): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    try {
      execFile(command, args, { encoding: "utf8", timeout: 4_000, maxBuffer: 1_048_576, windowsHide: true },
        (error, stdout) => {
          if (error) {
            const code = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output_limit"
              : error.code === "EACCES" || error.code === "EPERM" ? "permission_denied"
              : error.killed === true ? "query_terminated" : "query_failed";
            const errno = ["EACCES", "EPERM", "ENOENT", "EMFILE", "ENFILE"].includes(String(error.code))
              ? error.code as ProcessTreeCaptureObservation["errno"] : undefined;
            const signal = ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGSEGV"].includes(String(error.signal))
              ? error.signal as ProcessTreeCaptureObservation["signal"] : undefined;
            onFailure?.({ code, ...(typeof error.code === "number" && Number.isSafeInteger(error.code) ? { exitCode: error.code } : {}),
              ...(errno ? { errno } : {}), ...(signal ? { signal } : {}) });
          }
          resolve(error ? undefined : stdout);
        });
    } catch { onFailure?.({ code: "query_failed" }); resolve(undefined); }
  });
}

async function windowsProcesses(processIds?: readonly number[], onFailure?: (failure: CaptureFailure) => void): Promise<Array<{ pid: number; parent: number; birth?: string }> | undefined> {
  const command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const filter = processIds ? ` -Filter '${processIds.map((pid) => `ProcessId = ${pid}`).join(" OR ")}'` : "";
  // Both capture and lookup use CIM CreationDate: FILETIME units do not add
  // precision to that source. ToFileTimeUtc handles its Local/UTC DateTime Kind.
  const script = "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(" +
    `Get-CimInstance Win32_Process${filter} -ErrorAction Stop | ForEach-Object { ` +
    "[PSCustomObject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; " +
    "Birth = if ($null -eq $_.CreationDate) { $null } else { 'win32:' + $_.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) } } })";
  const output = await boundedOutput(command, ["-NoProfile", "-NonInteractive", "-Command", script], onFailure);
  if (output === undefined) return;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error();
    const rows: Array<{ pid: number; parent: number; birth?: string }> = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") throw new Error();
      const value = row as { ProcessId?: unknown; ParentProcessId?: unknown; Birth?: unknown };
      if (typeof value.ProcessId !== "number" || typeof value.ParentProcessId !== "number") throw new Error();
      rows.push({ pid: value.ProcessId, parent: value.ParentProcessId,
        ...(typeof value.Birth === "string" ? { birth: value.Birth } : {}) });
    }
    return rows;
  } catch { onFailure?.({ code: "invalid_response" }); return; }
}

async function windowsAbsentProcesses(processIds: readonly number[]): Promise<readonly number[] | undefined> {
  if (!processIds.length || !processIds.every(validPid) || new Set(processIds).size !== processIds.length) return;
  const script = `
$ErrorActionPreference = 'Stop'
$requested = '${JSON.stringify(processIds)}' | ConvertFrom-Json
$rows = @(foreach ($processId in $requested) {
  $ownedProcess = $null
  $absent = $false
  try {
    try { $ownedProcess = [Diagnostics.Process]::GetProcessById([int]$processId) }
    catch [ArgumentException] { $absent = $true }
    if ($null -ne $ownedProcess) {
      $null = $ownedProcess.Handle
      $absent = $ownedProcess.HasExited
    }
  } catch { $absent = $false }
  finally { if ($null -ne $ownedProcess) { $ownedProcess.Dispose() } }
  [PSCustomObject]@{ ProcessId = [int]$processId; Absent = [bool]$absent }
})
ConvertTo-Json -Compress -InputObject $rows
`;
  const command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = await boundedOutput(command, ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!output) return;
  try {
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length !== processIds.length) return;
    const seen = new Set<number>(), absent: number[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || !validPid(row.ProcessId) || !processIds.includes(row.ProcessId)
        || seen.has(row.ProcessId) || typeof row.Absent !== "boolean") return;
      seen.add(row.ProcessId);
      if (row.Absent) absent.push(row.ProcessId);
    }
    return absent;
  } catch { return; }
}

async function confirmedAbsent(processIds: readonly number[], probe: Pick<ProcessInstanceProbe, "confirmAbsent">): Promise<Set<number>> {
  if (!processIds.length || !probe.confirmAbsent) return new Set();
  let result: readonly number[] | undefined;
  try { result = await probe.confirmAbsent(processIds); } catch { return new Set(); }
  if (!Array.isArray(result) || !result.every(pid => validPid(pid) && processIds.includes(pid))
    || new Set(result).size !== result.length) return new Set();
  return new Set(result);
}

function linuxStat(value: string): { pid: number; start: string } | undefined {
  const open = value.indexOf("("), close = value.lastIndexOf(")");
  if (open <= 0 || close <= open) return;
  const pid = Number(value.slice(0, open).trim());
  const tail = value.slice(close + 1).trim().split(/\s+/);
  if (!validPid(pid) || !tail[19] || !/^(0|[1-9]\d*)$/.test(tail[19])) return;
  return { pid, start: tail[19] };
}

async function linuxIdentities(processIds: readonly number[]): Promise<readonly ProcessInstanceIdentity[] | undefined> {
  try {
    const [boot, self] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile("/proc/self/stat", "utf8")]);
    if (linuxStat(self)?.pid !== process.pid) return;
    const bootId = boot.trim();
    if (!validBirth(`linux:${bootId}:0`)) return;
    const rows = await Promise.all(processIds.map(async (pid) => {
      try {
        const stat = linuxStat(await readFile(`/proc/${pid}/stat`, "utf8"));
        if (!stat || stat.pid !== pid) throw new Error("incomplete original process identity");
        return { processId: pid, birth: `linux:${bootId}:${stat.start}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }));
    return rows.filter((row): row is ProcessInstanceIdentity => row !== undefined);
  } catch { return; }
}

const nativeProcessProbe: ProcessInstanceProbe = {
  isAbsent(pid) {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  },
  async readIdentities(processIds) {
    if (!processIds.length || !processIds.every(validPid)) return;
    if (process.platform === "win32") {
      const rows = await windowsProcesses(processIds);
      if (!rows || rows.some((row) => !validPid(row.pid) || !validBirth(row.birth))) return;
      return rows.map((row) => ({ processId: row.pid, birth: row.birth! }));
    }
    if (process.platform === "linux") return linuxIdentities(processIds);
    return;
  },
  confirmAbsent: process.platform === "win32" ? windowsAbsentProcesses : undefined,
};

/** Confirm original instances exited, leaving any reused numeric PID intact. */
export async function originalProcessTreeExited(value: ProcessTreeEvidence, probe: ProcessInstanceProbe = nativeProcessProbe): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const ids = value.processIds;
  if (!validPid(value.processId) || !Array.isArray(ids) || !ids.length || !ids.every(validPid) || !ids.includes(value.processId)
    || new Set(ids).size !== ids.length) return false;
  if (value.processIdentities !== undefined && !isCompleteProcessIdentityEvidence(value)) return false;
  try {
    const active = ids.filter((pid) => !probe.isAbsent(pid));
    if (!active.length) return true;
    if (value.processIdentities === undefined) return false;
    const originals = new Map(value.processIdentities.map((identity) => [identity.processId, identity.birth]));
    const rows = await probe.readIdentities(active);
    if (!rows || !Array.isArray(rows)) return false;
    const current = new Map<number, string>();
    for (const row of rows) {
      if (!row || !validPid(row.processId) || !validBirth(row.birth) || !active.includes(row.processId) || current.has(row.processId)) return false;
      current.set(row.processId, row.birth);
    }
    const missing = active.filter(pid => !current.has(pid) && !probe.isAbsent(pid));
    const absent = await confirmedAbsent(missing, probe);
    return active.every((pid) => {
      if (probe.isAbsent(pid) || absent.has(pid)) return true;
      const birth = current.get(pid), original = originals.get(pid)!;
      return birth !== undefined && birth.split(":", 1)[0] === original.split(":", 1)[0] && birth !== original;
    });
  } catch { return false; }
}

/** Capture one root/process-list snapshot; never backfill an old descriptor. */
export async function captureProcessTreeEvidence(processId: number | undefined,
  onObservation?: (observation: ProcessTreeCaptureObservation) => void): Promise<{
  processIds: number[]; processIdentities?: readonly ProcessInstanceIdentity[];
} | undefined> {
  const started = performance.now();
  const report = (failure: CaptureFailure) => {
    const observation = Object.freeze({ ...(validPid(processId) ? { processId } : {}), ...failure,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)), limitMs: 4000 as const });
    try { Promise.resolve(onObservation?.(observation)).catch(() => undefined); } catch { /* Diagnostics cannot change evidence. */ }
  };
  if (!validPid(processId)) { report({ code: "invalid_root" }); return; }
  const windows = process.platform === "win32";
  const rows: Array<{ pid: number; parent: number; birth?: string }> = [];
  const nativeRows = windows ? await windowsProcesses(undefined, report) : undefined;
  const output = windows ? undefined : await boundedOutput("ps", ["-e", "-o", "pid=", "-o", "ppid="], report);
  if (windows && !nativeRows || !windows && output === undefined) return;
  if (!windows && !output?.trim()) { report({ code: "invalid_response" }); return; }
  if (nativeRows) rows.push(...nativeRows);
  else {
    for (const line of output!.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) { report({ code: "invalid_response" }); return; }
      rows.push({ pid: Number(match[1]), parent: Number(match[2]) });
    }
  }
  const processes = new Map<number, number>();
  for (const row of rows) {
    // Windows includes its system idle process (PID zero), which cannot be a child.
    if (row.pid === 0 && row.parent === 0) continue;
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parent) || row.parent < 0
      || (processes.has(row.pid) && processes.get(row.pid) !== row.parent)) { report({ code: "invalid_response" }); return; }
    processes.set(row.pid, row.parent);
  }
  if (!processes.has(processId)) { report({ code: "root_missing" }); return; }
  const births = new Map(rows.map((row) => [row.pid, row.birth]));
  const owned = new Set<number>([processId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of processes) {
      if (owned.has(parent) && !owned.has(pid)) {
        const birth = births.get(pid), parentBirth = births.get(parent);
        // Windows preserves a dead parent's numeric PID. Its reuse cannot
        // make an older child belong to the newly captured parent instance.
        if (windows && validBirth(birth) && validBirth(parentBirth)
          && birth.startsWith("win32:") && parentBirth.startsWith("win32:")
          && BigInt(birth.slice(6)) < BigInt(parentBirth.slice(6))) continue;
        owned.add(pid); changed = true;
      }
    }
  }
  const processIds = [...owned];
  if (!windows && process.platform !== "linux") { report({ code: "identity_incomplete" }); return { processIds }; }
  const identities = windows ? rows.filter((row) => owned.has(row.pid) && row.birth !== undefined)
    .map((row) => ({ processId: row.pid, birth: row.birth! })) : await linuxIdentities(processIds);
  const evidence = { processId, processIds, processIdentities: identities ?? [] };
  if (!isCompleteProcessIdentityEvidence(evidence)) { report({ code: "identity_incomplete" }); return { processIds }; }
  report({ code: "captured" });
  return { processIds, processIdentities: Object.freeze(evidence.processIdentities.map((identity) => Object.freeze({ ...identity }))) };
}

/** Refresh descendants only from still-matching original instances, never a reused PID. */
export async function refreshOriginalProcessTreeEvidence(evidence: ProcessTreeEvidence, hooks: {
  isAbsent?(pid: number): boolean;
  capture?(pid: number, onObservation?: (observation: ProcessTreeCaptureObservation) => void): ReturnType<typeof captureProcessTreeEvidence>;
  confirmAbsent?: ProcessInstanceProbe["confirmAbsent"];
  onObservation?(observation: ProcessTreeObservation): void;
} = {}): Promise<ProcessTreeEvidence | undefined> {
  const started = performance.now();
  const observe = (observation: ProcessTreeObservation) => {
    try { Promise.resolve(hooks.onObservation?.(observation)).catch(() => undefined); } catch { /* Diagnostics cannot change evidence. */ }
  };
  const report = (code: ProcessTreeRefreshObservation["code"], processId = evidence?.processId) => {
    observe(Object.freeze({ ...(validPid(processId) ? { processId } : {}), code,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)) }));
  };
  if (!isCompleteProcessIdentityEvidence(evidence)) { report("original_identity_incomplete"); return; }
  const isAbsent = hooks.isAbsent ?? nativeProcessProbe.isAbsent;
  const capture = hooks.capture ?? captureProcessTreeEvidence;
  const absenceProbe = { confirmAbsent: hooks.confirmAbsent
    ?? (hooks.capture || hooks.isAbsent ? undefined : nativeProcessProbe.confirmAbsent) };
  const identities = new Map(evidence.processIdentities!.map(identity => [identity.processId, identity]));
  // A proved absent root cannot lend a current tree, and need not run census.
  const unresolved = evidence.processIds!.filter(pid => !isAbsent(pid));
  const absent = await confirmedAbsent(unresolved, absenceProbe);
  for (const original of evidence.processIdentities!) {
    if (isAbsent(original.processId) || absent.has(original.processId)) continue;
    const current = await capture(original.processId, observe);
    if (!current) {
      if (isAbsent(original.processId) || (await confirmedAbsent([original.processId], absenceProbe)).has(original.processId)) continue;
      report("capture_unavailable", original.processId); return;
    }
    if (!isCompleteProcessIdentityEvidence({ processId: original.processId, ...current })) { report("current_identity_incomplete", original.processId); return; }
    const root = current.processIdentities!.find(identity => identity.processId === original.processId)!;
    if (root.birth.split(":", 1)[0] !== original.birth.split(":", 1)[0]) { report("birth_domain_mismatch", original.processId); return; }
    if (root.birth !== original.birth) continue;
    for (const identity of current.processIdentities!) {
      const prior = identities.get(identity.processId);
      if (prior && prior.birth !== identity.birth) { report("identity_conflict", identity.processId); return; }
      identities.set(identity.processId, identity);
    }
  }
  report("refreshed");
  return Object.freeze({ processId: evidence.processId, processIds: Object.freeze([...identities.keys()]),
    processIdentities: Object.freeze([...identities.values()].map(identity => Object.freeze({ ...identity }))) });
}

/** Preserve the diagnostic PID-only API without using it as instance evidence. */
export async function captureProcessTree(processId: number | undefined): Promise<number[] | undefined> {
  return (await captureProcessTreeEvidence(processId))?.processIds;
}

/** Gracefully close a child, escalating only after bounded deadlines. */
export async function stopProcess(child: ChildProcess, quitGraceMs: number, killGraceMs: number): Promise<void> {
  if (hasExited(child)) return;
  try { child.stdin?.end(); } catch {
    // stdin may already be closed by the child side.
  }
  if (hasExited(child)) return;
  await waitForExit(child, quitGraceMs);
  if (hasExited(child)) return;
  child.kill();
  await waitForExit(child, killGraceMs);
  if (!hasExited(child)) child.kill("SIGKILL");
}

/** `killed` acknowledges a signal request; exitCode/signalCode record exit. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once("exit", finish);
    child.once("close", finish);
  });
}

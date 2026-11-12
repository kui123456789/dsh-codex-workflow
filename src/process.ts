import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import crossSpawn from "cross-spawn";

export interface ProcessIdentity {
  pid: number;
  birth: string;
}

export interface ProcessTree {
  root: ProcessIdentity;
  members: ProcessIdentity[];
}

type State = "alive" | "dead" | "unknown";
interface ProcessRow {
  identity: ProcessIdentity;
  parent: number;
  dead?: boolean;
}

const helperTimeout = 4_000;
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
const key = (identity: ProcessIdentity) => `${identity.pid}:${identity.birth}`;
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function spawnCommand(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  return crossSpawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "pipe",
    windowsHide: true,
    shell: false,
  });
}

async function helper(command: string, args: string[], timeout = helperTimeout): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(1, Math.floor(Math.min(helperTimeout, timeout))),
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

async function powershell(script: string, timeout?: number): Promise<string | undefined> {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64");
  const modern = process.env.ProgramFiles && join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe");
  return helper(modern && existsSync(modern) ? modern : "powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], timeout);
}

async function linuxRow(pid: number, boot: string): Promise<ProcessRow | "dead" | "unknown"> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const parent = Number(fields[1]);
    const start = fields[19];
    if (!Number.isSafeInteger(parent) || !start || !/^\d+$/.test(start)) return "unknown";
    return { identity: { pid, birth: `${boot}:${start}` }, parent, dead: fields[0] === "Z" || fields[0] === "X" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "dead" : "unknown";
  }
}

async function linuxBoot(): Promise<string | undefined> {
  try {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return /^[\da-f-]+$/i.test(boot) ? boot : undefined;
  } catch {
    return undefined;
  }
}

async function snapshot(timeout?: number): Promise<ProcessRow[] | undefined> {
  if (process.platform === "linux") {
    const boot = await linuxBoot();
    if (!boot) return undefined;
    try {
      const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
      const rows = await Promise.all(pids.map((pid) => linuxRow(Number(pid), boot)));
      // Without a readable PPID, an unknown row might be an owned descendant.
      if (rows.includes("unknown")) return undefined;
      return rows.flatMap((row) => typeof row === "string" ? [] : [row]);
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const output = await helper("ps", ["-axo", "pid=,ppid=,lstart=,stat="], timeout);
    if (output === undefined) return undefined;
    const rows: ProcessRow[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)/.exec(line);
      if (!match) return undefined;
      rows.push({ identity: { pid: Number(match[1]), birth: match[3]!.replace(/\s+/g, " ") }, parent: Number(match[2]), dead: /^[ZX]/.test(match[4]!) });
    }
    return rows;
  }
  if (process.platform === "win32") {
    const output = await powershell([
      "$rows=@(Get-CimInstance Win32_Process | ForEach-Object {",
      "$item=$_; $birth=''; $p=$null;",
      "try { $p=[Diagnostics.Process]::GetProcessById([int]$item.ProcessId); $birth=$p.StartTime.ToUniversalTime().Ticks.ToString() } catch {} finally { if($null -ne $p){$p.Dispose()} };",
      "[pscustomobject]@{pid=[int]$item.ProcessId;parent=[int]$item.ParentProcessId;birth=$birth}",
      "}); ConvertTo-Json -InputObject $rows -Compress",
    ].join(" "), timeout);
    if (output === undefined) return undefined;
    try {
      const rows = JSON.parse(output.trim()) as { pid: number; parent: number; birth: string }[];
      if (!Array.isArray(rows)) return undefined;
      return rows.map((row) => ({ identity: { pid: row.pid, birth: row.birth }, parent: row.parent }));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function inspect(pid: number, timeout?: number): Promise<ProcessRow | "dead" | "unknown"> {
  if (!validPid(pid)) return "dead";
  if (process.platform === "linux") {
    const boot = await linuxBoot();
    return boot ? linuxRow(pid, boot) : "unknown";
  }
  if (process.platform === "win32") {
    const output = await powershell([
      "$p=$null; try {",
      `try { $p=[Diagnostics.Process]::GetProcessById(${pid}) } catch [ArgumentException] { 'dead'; exit };`,
      "if($p.HasExited){'dead'}else{$p.StartTime.ToUniversalTime().Ticks.ToString()}",
      "} catch { 'unknown' } finally { if($null -ne $p){$p.Dispose()} }",
    ].join(" "), timeout);
    const birth = output?.trim();
    if (birth === "dead") return "dead";
    return birth && /^\d+$/.test(birth) ? { identity: { pid, birth }, parent: -1 } : "unknown";
  }
  const rows = await snapshot(timeout);
  return rows ? rows.find((row) => row.identity.pid === pid) ?? "dead" : "unknown";
}

export async function identifyProcess(pid: number): Promise<ProcessIdentity | undefined> {
  const row = await inspect(pid);
  return typeof row === "object" && !row.dead && row.identity.birth ? row.identity : undefined;
}

function stateInRows(identity: ProcessIdentity, rows: ProcessRow[]): State {
  if (!validPid(identity.pid) || !identity.birth) return "unknown";
  const row = rows.find((candidate) => candidate.identity.pid === identity.pid);
  if (!row || row.dead) return "dead";
  if (!row.identity.birth) return "unknown";
  return row.identity.birth === identity.birth ? "alive" : "dead";
}

export async function processState(identity: ProcessIdentity): Promise<State> {
  if (!validPid(identity.pid) || !identity.birth) return "unknown";
  const row = await inspect(identity.pid);
  if (typeof row === "string") return row;
  return row.dead ? "dead" : row.identity.birth === identity.birth ? "alive" : "dead";
}

function olderOrSame(parent: ProcessIdentity, child: ProcessIdentity): boolean {
  if (process.platform === "win32") return /^\d+$/.test(parent.birth) && /^\d+$/.test(child.birth) && BigInt(parent.birth) <= BigInt(child.birth);
  if (process.platform === "linux") {
    const [parentBoot, parentStart] = parent.birth.split(":");
    const [childBoot, childStart] = child.birth.split(":");
    return parentBoot === childBoot && !!parentStart && !!childStart && /^\d+$/.test(parentStart) && /^\d+$/.test(childStart) && BigInt(parentStart) <= BigInt(childStart);
  }
  return Date.parse(parent.birth) <= Date.parse(child.birth);
}

function extendTree(pid: number, previous: ProcessTree | undefined, rows: ProcessRow[]): ProcessTree | undefined {
  if (previous && previous.root.pid !== pid) return undefined;
  const root = previous?.root ?? rows.find((row) => row.identity.pid === pid && !row.dead)?.identity;
  if (!root?.birth) return undefined;
  const known = new Map<string, ProcessIdentity>([root, ...(previous?.members ?? [])].map((identity) => [key(identity), identity]));
  if ([...known.values()].some((identity) => stateInRows(identity, rows) === "unknown")) return undefined;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.dead || known.has(key(row.identity))) continue;
      const parent = [...known.values()].find((identity) => identity.pid === row.parent && stateInRows(identity, rows) === "alive");
      if (!parent) continue;
      if (!row.identity.birth || !olderOrSame(parent, row.identity)) return undefined;
      known.set(key(row.identity), row.identity);
      changed = true;
    }
  }
  return { root, members: [...known.values()].filter((identity) => key(identity) !== key(root)) };
}

export async function captureTree(pid: number, previous?: ProcessTree): Promise<ProcessTree | undefined> {
  if (!validPid(pid)) return undefined;
  const rows = await snapshot();
  return rows ? extendTree(pid, previous, rows) : undefined;
}

async function signalWindows(identities: ProcessIdentity[], remaining: number): Promise<boolean> {
  if (identities.some((identity) => !validPid(identity.pid) || !/^\d+$/.test(identity.birth))) return false;
  const targets = identities.map((identity) => `@{pid=${identity.pid};birth='${identity.birth}'}`).join(",");
  // Acquire and verify every native handle before killing. Keep those same handles
  // through termination, without paying for a new PowerShell startup per PID.
  const output = await powershell([
    "$handles=[Collections.Generic.List[Diagnostics.Process]]::new(); $p=$null;",
    "try {",
    `foreach($target in @(${targets})){`,
    "$p=$null; try { $p=[Diagnostics.Process]::GetProcessById([int]$target.pid) } catch [ArgumentException] { continue };",
    "$null=$p.Handle;",
    "if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $target.birth){$p.Dispose();$p=$null;continue};",
    "$handles.Add($p); $p=$null;",
    "};",
    "foreach($owned in $handles){try {if(!$owned.HasExited){$owned.Kill()}} catch {if(!$owned.HasExited){throw}}};",
    "'sent'",
    "} catch { 'unknown' } finally { if($null -ne $p){$p.Dispose()}; foreach($owned in $handles){$owned.Dispose()} }",
  ].join(" "), remaining);
  return output?.trim() === "sent";
}

async function signalOwned(identity: ProcessIdentity, signal: "SIGTERM" | "SIGKILL", remaining: number): Promise<boolean> {
  const row = await inspect(identity.pid, remaining);
  if (row === "dead") return true;
  if (row === "unknown") return false;
  if (row.dead || row.identity.birth !== identity.birth) return true;
  try {
    // POSIX has no birth-aware kill syscall exposed by Node. Recheck immediately before signalling.
    process.kill(identity.pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function stopTree(tree: ProcessTree, timeoutMs = 8_000): Promise<boolean> {
  if (!Number.isFinite(timeoutMs)) return false;
  if (!validPid(tree.root.pid) || !tree.root.birth || tree.members.some((member) => !validPid(member.pid) || !member.birth)) return false;
  const deadline = performance.now() + Math.max(0, timeoutMs);
  let current = tree;
  let round = 0;
  while (performance.now() < deadline) {
    const rows = await snapshot(deadline - performance.now());
    if (!rows) return false;
    const expanded = extendTree(tree.root.pid, current, rows);
    if (!expanded) return false;
    current = expanded;
    const identities = [current.root, ...current.members];
    const states = identities.map((identity) => stateInRows(identity, rows));
    if (states.includes("unknown")) return false;
    if (states.every((state) => state === "dead")) return true;
    // Stop parents first so they cannot intentionally respawn a killed descendant.
    const alive = identities.filter((identity) => stateInRows(identity, rows) === "alive");
    if (process.platform === "win32") {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || !await signalWindows(alive, remaining)) return false;
    } else {
      for (const identity of alive) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 || !await signalOwned(identity, round ? "SIGKILL" : "SIGTERM", remaining)) return false;
      }
    }
    round++;
    await pause(Math.min(80, Math.max(0, deadline - performance.now())));
  }
  // A deadline never implies success: the caller must keep the cleanup block in place.
  return false;
}

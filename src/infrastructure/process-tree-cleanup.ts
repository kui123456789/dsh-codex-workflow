import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ProcessInstanceIdentity } from "../types.js";
import { isCompleteProcessIdentityEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "./process-transport.js";

interface CleanupHooks {
  exited?(evidence: ProcessTreeEvidence): Promise<boolean>;
  terminate?(identities: readonly ProcessInstanceIdentity[]): Promise<boolean>;
}

function runTermination(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 4000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(false); return; }
      try { resolve(JSON.parse(stdout).ok === true); } catch { resolve(false); }
    });
  });
}

async function terminateOriginalInstances(identities: readonly ProcessInstanceIdentity[]): Promise<boolean> {
  const values = [...identities].reverse();
  if (process.platform === "win32") {
    if (values.some((value) => !value.birth.startsWith("win32:"))) return false;
    // Validated numeric IDs and birth strings are data, never shell input.
    const script = `
$ErrorActionPreference = 'Stop'
$captured = '${JSON.stringify(values)}' | ConvertFrom-Json
$ok = $true
foreach ($row in $captured) {
  $ownedProcess = $null
  try {
    try { $ownedProcess = [Diagnostics.Process]::GetProcessById([int]$row.processId) }
    catch [ArgumentException] { continue }
    $null = $ownedProcess.Handle
    [long]$preciseBirth = $ownedProcess.StartTime.ToFileTimeUtc()
    $normalizedBirth = $preciseBirth - ($preciseBirth % [long]10)
    $actualBirth = 'win32:' + $normalizedBirth.ToString([Globalization.CultureInfo]::InvariantCulture)
    if ($actualBirth -ne $row.birth) { continue }
    $ownedProcess.Kill()
  } catch {
    if ($null -eq $ownedProcess -or !$ownedProcess.HasExited) { $ok = $false }
  } finally { if ($null -ne $ownedProcess) { $ownedProcess.Dispose() } }
}
ConvertTo-Json -Compress @{ ok = $ok }
`;
    const command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return runTermination(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  }
  if (process.platform === "linux") {
    if (values.some((value) => !value.birth.startsWith("linux:"))) return false;
    // pidfd pins the selected instance; a later PID reuse cannot receive its signal.
    const script = `
import json, os, signal, sys
ok = True
try:
    boot = open('/proc/sys/kernel/random/boot_id').read().strip()
    for row in json.loads(sys.argv[1]):
        fd = None
        try:
            fd = os.pidfd_open(row['processId'], 0)
            raw = open('/proc/%s/stat' % row['processId']).read()
            birth = 'linux:%s:%s' % (boot, raw[raw.rfind(')') + 1:].split()[19])
            if birth == row['birth']:
                signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
        except (ProcessLookupError, FileNotFoundError):
            pass
        except Exception:
            ok = False
        finally:
            if fd is not None: os.close(fd)
except Exception:
    ok = False
print(json.dumps({'ok': ok}))
`;
    return runTermination("python3", ["-c", script, JSON.stringify(values)]);
  }
  return false;
}

/** Stop only captured original instances, then independently verify their exit.
 * A missing birth, denied handle or unavailable safe platform API keeps cleanup
 * unconfirmed. Launcher exit and a successful signal are not a tree receipt. */
export async function stopCapturedProcessTree(evidence: ProcessTreeEvidence, waitMs: number, hooks: CleanupHooks = {}): Promise<boolean> {
  const exited = hooks.exited ?? originalProcessTreeExited;
  if (await exited(evidence)) return true;
  if (!isCompleteProcessIdentityEvidence(evidence)) return false;
  const terminate = hooks.terminate ?? terminateOriginalInstances;
  const sent = await terminate(evidence.processIdentities!);
  const deadline = performance.now() + Math.max(0, waitMs);
  do {
    if (await exited(evidence)) return true;
    if (!sent || performance.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (true);
}

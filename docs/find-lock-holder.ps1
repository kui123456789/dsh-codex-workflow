# Identify the OS-level holder of a file lock WITHOUT admin rights, via the
# Windows Restart Manager API (rstrtmgr.dll), plus a direct exclusive-open probe.
#
# Used to diagnose the 2026-09-23 thread-writer-lock incident documented in
# reviewer-thread-lock-2026-09-24.md: it proved that the lock on
# ~/.codex/thread-writer-locks/<threadId>.lock was held by Codex Desktop's own
# long-lived app-server, not by a dead process.
#
# Usage:
#   pwsh -File docs/find-lock-holder.ps1 -Path "$env:USERPROFILE\.codex\thread-writer-locks\<threadId>.lock"
#
# Reading the result:
#   - "exclusive-open probe: SUCCEEDED"  -> no OS-level holder (deleting is safe)
#   - "exclusive-open probe: DENIED" + a PID from Restart Manager -> that live
#     process holds the handle; deleting the file does NOT release it.
param([Parameter(Mandatory = $true)][string]$Path)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class LockFinder {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;
    const int ERROR_MORE_DATA = 234;

    enum RM_APP_TYPE { RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2, RmService = 3, RmExplorer = 4, RmConsole = 5, RmCritical = 1000 }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static string[] WhoLocks(string path) {
        var result = new List<string>();
        uint handle;
        string key = Guid.NewGuid().ToString();
        int rc = RmStartSession(out handle, 0, key);
        if (rc != 0) throw new Exception("RmStartSession failed: " + rc);
        try {
            rc = RmRegisterResources(handle, 1, new[] { path }, 0, null, 0, null);
            if (rc != 0) throw new Exception("RmRegisterResources failed: " + rc);
            uint needed = 0, count = 0, reasons = 0;
            rc = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (rc == ERROR_MORE_DATA) {
                var infos = new RM_PROCESS_INFO[needed];
                count = needed;
                rc = RmGetList(handle, out needed, ref count, infos, ref reasons);
                if (rc != 0) throw new Exception("RmGetList(2) failed: " + rc);
                for (int i = 0; i < count; i++) {
                    result.Add(infos[i].Process.dwProcessId + "|" + infos[i].strAppName + "|" + infos[i].ApplicationType);
                }
            } else if (rc != 0) {
                throw new Exception("RmGetList failed: " + rc);
            }
        } finally { RmEndSession(handle); }
        return result.ToArray();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null

Write-Output "target: $Path"
if (-not (Test-Path -LiteralPath $Path)) { Write-Output 'file does not exist'; exit 0 }

# Direct probe: can we take an exclusive handle right now?
try {
  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $fs.Close()
  Write-Output 'exclusive-open probe: SUCCEEDED (no OS-level holder)'
} catch {
  Write-Output "exclusive-open probe: DENIED -> $($_.Exception.GetType().Name): $($_.Exception.Message)"
}

Write-Output '--- Restart Manager holders ---'
try {
  $holders = [LockFinder]::WhoLocks($Path)
  if ($holders.Count -eq 0) {
    Write-Output '(Restart Manager reported no holding process)'
  } else {
    foreach ($h in $holders) {
      $parts = $h -split '\|'
      $proc = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
      $start = if ($proc) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($parts[0])" -ErrorAction SilentlyContinue).CreationDate } else { $null }
      Write-Output ("PID {0} | app={1} | type={2} | name={3} | start={4}" -f $parts[0], $parts[1], $parts[2], ($proc.ProcessName ?? 'gone'), $start)
    }
  }
} catch {
  Write-Output "Restart Manager failed: $($_.Exception.Message)"
}

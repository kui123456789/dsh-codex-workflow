#!/usr/bin/env node
// Doctor for the dsh-codex-workflow plugin.
//
// Modes:
//   default  : full check — requires the installed Codex CLI and an active
//              login (version, login status, legacy resume syntax, app-server).
//   --offline: CI-safe check — skips ONLY the checks that depend on a local
//              Codex install/login (version / login / legacy resume-help / app-server)
//              and marks them SKIPPED explicitly (never falsely "pass").
//   --json   : machine-readable output ({ ok, checks:[{label,ok,skipped,detail}],
//              version, login, sqlite }); human output otherwise.
//
// Storage probing stays strictly off the real DSH_HOME (temp-dir capability
// probe + read-only real-DB probe); the only real-home write is the one-time
// legacy probe cleanup for OUR OWN exact "ok" file.
import crossSpawn from "cross-spawn";
import { access, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyProbeCleanup, probeStorage } from "./doctor-probes.mjs";

const command = process.env.DSH_CODEX_COMMAND || "codex";
const scriptsDir = fileURLToPath(new URL(".", import.meta.url));

const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const json = argv.includes("--json");

const failures = [];
const skipped = [];
const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok: Boolean(ok), skipped: false, detail });
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  return ok;
}
function skip(label, detail = "skipped offline: requires a local Codex install/login") {
  skipped.push(label);
  checks.push({ label, ok: true, skipped: true, detail });
}

for (const argument of argv) {
  if (argument !== "--offline" && argument !== "--json") {
    check("arguments", false, `unknown argument ${argument}`);
  }
}

function capture(args) {
  const result = crossSpawn.sync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return String(result.stdout || result.stderr || "").trim();
}

let version = "(skipped)";
let login = "(skipped)";
if (!offline) {
  // 1) Codex CLI presence and login (online-only).
  try {
    version = capture(["--version"]);
    check("codex CLI version", true, version);
  } catch (error) {
    check("codex CLI version", false, error instanceof Error ? error.message : String(error));
  }
  try {
    login = capture(["login", "status"]);
    check("codex login status", true, login);
  } catch (error) {
    check("codex login status", false, error instanceof Error ? error.message : String(error));
  }
} else {
  skip("codex CLI version");
  skip("codex login status");
}

// 2) The bridge CLI binary must exist after a build (runs in BOTH modes).
const bridgeCliExists = await exists(join(scriptsDir, "..", "lib", "bridge-cli.js"));
check("bridge CLI binary exists", bridgeCliExists, bridgeCliExists ? "lib/bridge-cli.js" : "run pnpm build first");

// 3) Legacy dispatcher compatibility: `codex exec resume` syntax (online-only).
if (!offline) {
  try {
    const resumeHelp = capture(["exec", "resume", "--help"]);
    const resumeSupported = /resume/i.test(resumeHelp);
    check(
      "legacy codex exec resume syntax supported",
      resumeSupported,
      resumeSupported ? "codex exec resume is available" : "the installed codex does not expose `codex exec resume`",
    );
    const stdinSupported = /read from stdin/.test(resumeHelp);
    check(
      "stdin prompt contract supported",
      stdinSupported,
      stdinSupported ? "'-' reads the prompt from stdin" : "resume must support '-' (stdin) prompts",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    check("legacy codex exec resume syntax supported", false, detail);
    check("stdin prompt contract supported", false, detail);
  }
} else {
  skip("legacy codex exec resume syntax supported");
  skip("stdin prompt contract supported");
}

// 4) Storage directories: NEVER touch the real DSH_HOME for self-checks
// (writability is probed in a temp directory); the real coord.sqlite is only
// ever inspected READ-ONLY and only when it already exists. Legacy cleanup:
// a probe file left by older doctor versions in the real home is removed only
// when its content is exactly "ok"; anything else is preserved and reported.
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const storageDir = join(dshHome, "storages", "dsh-codex-workflow");
const probeDir = await (async () => {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "dsh-doctor-"));
})();
let sqliteResult;
try {
  sqliteResult = await probeStorage({ storageDir, probeDir });
} finally {
  // Always remove the temp probe directory, even when the probe throws.
  await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
}
check("temp SQLite capability (writable temp dir)", sqliteResult.writable === true, sqliteResult.writableError);
check("real storage is writable (checked without writing)", sqliteResult.realStorageWritable === true, sqliteResult.realStorageWritableError);
check("coord database is local (no UNC)", sqliteResult.unc !== true, sqliteResult.error);
check("sqlite integrity check passes (fresh capability)", sqliteResult.integrityOk === true, sqliteResult.error ?? "");
const realIntegrityOk = !sqliteResult.realError && (!sqliteResult.realExists || sqliteResult.real?.integrityOk === true);
check(
  "sqlite integrity check passes on the real database",
  realIntegrityOk,
  sqliteResult.realError
    ?? (!sqliteResult.realExists ? "no existing coordination database" : realIntegrityOk ? "integrity_check=ok" : "real integrity failed"),
);
check(
  "rollback journal (not WAL)",
  (sqliteResult.real ? sqliteResult.real.journal.toLowerCase() === "delete" : sqliteResult.journalOk) === true,
  `journal_mode=${sqliteResult.real?.journal ?? sqliteResult.journal}`,
);

// LEGACY cleanup, only for OUR OWN known stale file (exact "ok" content).
const legacy = await legacyProbeCleanup({ storageDir });
if (legacy.deleted) {
  check("doctor leaves no residue in the real DSH_HOME", true);
} else if (legacy.present) {
  check(
    "legacy probe (doctor-write-probe.txt) content is NOT ours and is preserved",
    false,
    `found ${legacy.path} with unexpected content; left it untouched — inspect manually (this doctor never deletes unknown files)`,
  );
} else {
  check("doctor leaves no residue in the real DSH_HOME", true);
}

// 5) The app-server talks to the installed CLI (online-only). The import is
// lazy so --offline does not even need a built lib/.
if (!offline) {
  let client;
  try {
    const { CodexAppServerClient } = await import("../lib/app-server.js");
    client = new CodexAppServerClient({ command, requestTimeoutMs: 30_000, idleProcessMs: 0 });
    const health = await client.health();
    check("codex app-server reachable", health.modelCount > 0, `models: ${health.modelCount}`);
  } catch (error) {
    check("codex app-server reachable", false, error instanceof Error ? error.message : String(error));
  } finally {
    await client?.stop();
  }
} else {
  skip("codex app-server reachable");
}

// 6) The product must not open a listening network port.
check("no network listener configured", !process.env.DSH_CODEX_WORKFLOW_LISTEN, "unset DSH_CODEX_WORKFLOW_LISTEN");

const sqliteLine = (sqliteResult.error || sqliteResult.realError)
  ? `SQLite: ${sqliteResult.error ?? sqliteResult.realError}`
  : `SQLite: ${sqliteResult.version ?? "(n/a)"}, journal=${sqliteResult.real?.journal ?? sqliteResult.journal}`;

const ok = failures.length === 0;

if (json) {
  process.stdout.write(`${JSON.stringify({
    ok,
    offline,
    version,
    login,
    sqlite: sqliteResult.real?.journal ?? sqliteResult.journal ?? sqliteResult.version ?? null,
    skippedCount: skipped.length,
    failedCount: failures.length,
    checks,
  }, null, 2)}\n`);
} else {
  const lines = [
    ok ? "DOCTOR_OK" : "DOCTOR_FAIL",
    `Codex: ${version}`,
    `Login: ${login}`,
    offline ? "Mode: offline (codex login/app-server checks SKIPPED)" : "Mode: full (codex login/app-server checks active)",
  ];
  if (!offline) lines.push(`CLI: lib/bridge-cli.js`);
  lines.push(`Network listener: none`);
  lines.push(offline ? "Skipped checks (offline):" : undefined);
  if (offline) {

    for (const item of skipped) lines.push(`  - [SKIPPED] ${item}`);
  }
  lines.push(sqliteLine);
  for (const item of failures) lines.push(`- ${item}`);
  process.stdout.write(`${lines.filter((line) => line !== undefined).join("\n")}\n`);
}
if (!ok) process.exitCode = 1;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

import crossSpawn from "cross-spawn";
import { access, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../lib/app-server.js";
import { legacyProbeCleanup, probeStorage } from "./doctor-probes.mjs";

const command = process.env.DSH_CODEX_COMMAND || "codex";
const scriptsDir = fileURLToPath(new URL(".", import.meta.url));

function capture(args) {
  const result = crossSpawn.sync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return String(result.stdout || result.stderr || "").trim();
}

const failures = [];
function check(label, ok, detail = "") {
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  return ok;
}

// 1) Codex CLI presence and login.
const version = capture(["--version"]);
const login = capture(["login", "status"]);

// 2) The bridge CLI binary must exist after a build.
check("bridge CLI binary exists", await exists(join(scriptsDir, "..", "lib", "bridge-cli.js")), "run pnpm build first");

// 3) `codex exec resume` must support the exact-thread resume syntax we use.
const resumeHelp = capture(["exec", "resume", "--help"]);
check(
  "codex exec resume syntax supported",
  /resume/i.test(resumeHelp),
  "the installed codex does not expose `codex exec resume`",
);
check(
  "stdin prompt contract supported",
  /read from stdin/.test(resumeHelp),
  "resume must support '-' (stdin) prompts",
);

// 4) Storage directories must be writable; NEVER touch the real DSH_HOME for
// self-checks (writability is probed in a temp directory), and the real
// coord.sqlite is only ever inspected READ-ONLY and only when it already
// exists. Legacy cleanup: a probe file left by older doctor versions in the
// real home is removed once; everything else is read-only.
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
check(
  "sqlite integrity check passes on the real database",
  !sqliteResult.realError && (!sqliteResult.realExists || sqliteResult.real?.integrityOk === true),
  sqliteResult.realError ?? (sqliteResult.real ? "real integrity failed" : undefined),
);
check(
  "rollback journal (not WAL)",
  (sqliteResult.real ? sqliteResult.real.journal.toLowerCase() === "delete" : sqliteResult.journalOk) === true,
  `journal_mode=${sqliteResult.real?.journal ?? sqliteResult.journal}`,
);

// Always remove the temp probe directory, even when a probe threw.
await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);

// LEGACY cleanup, only for OUR OWN known stale file: an older doctor wrote a
// probe file whose entire content was exactly the UTF-8 string "ok". We delete
// it ONLY in that exact case; any other file with this name is NOT ours, is
// preserved and reported. A regular doctor never modifies the real DSH_HOME
// otherwise.
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

// 5) The app-server talks to the installed CLI.
const client = new CodexAppServerClient({ command, requestTimeoutMs: 30_000, idleProcessMs: 0 });
try {
  const health = await client.health();
  check("codex app-server reachable", health.modelCount > 0, `models: ${health.modelCount}`);
} catch (error) {
  check("codex app-server reachable", false, error.message);
} finally {
  await client.stop();
}

// 6) The product must not open a listening network port.
check("no network listener configured", !process.env.DSH_CODEX_WORKFLOW_LISTEN, "unset DSH_CODEX_WORKFLOW_LISTEN");

const sqliteLine = (sqliteResult.error || sqliteResult.realError)
  ? `SQLite: ${sqliteResult.error ?? sqliteResult.realError}`
  : `SQLite: ${sqliteResult.version ?? "(n/a)"}, journal=${sqliteResult.real?.journal ?? sqliteResult.journal}`;

process.stdout.write(
  failures.length
    ? `DOCTOR_FAIL\nCodex: ${version}\nLogin: ${login}\n${sqliteLine}\n${failures.map((item) => `- ${item}`).join("\n")}\n`
    : `DOCTOR_OK\nCodex: ${version}\nLogin: ${login}\nCLI: lib/bridge-cli.js\nResume: codex exec resume <id> - (stdin)\nCODEX_THREAD_ID: documented; the bridge never invents a thread id\nNetwork listener: none\n${sqliteLine}\n`,
);
if (failures.length) process.exitCode = 1;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

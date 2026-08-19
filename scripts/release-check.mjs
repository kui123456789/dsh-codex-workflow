#!/usr/bin/env node
// Release check for dsh-codex-workflow 1.0.5.
//
// A repeatable, OFFLINE gate (no Codex login, no real DSH_HOME):
//   1. verify      : typecheck + full test suite + build
//   2. offline doctor: `doctor --offline --json` must pass; skipped codex-heavy
//      checks are reported (never falsely "pass").
//   3. pack audit  : `pnpm pack` into a temp dir, list the tarball contents
//      (gzip + ustar parse, no extra deps) and assert the `files` whitelist:
//      ONLY lib/, scripts/, package.json, README.md, CHANGELOG.md, LICENSE,
//      cordis.patch.yml — no tests/fixtures, coord.sqlite, DSH_HOME paths,
//      credentials, temp/review leftovers. The temp tarball is ALWAYS removed.
import crossSpawn from "cross-spawn";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTarGzMembers,
  RELEASE_ALLOWED_FILES,
  RELEASE_ALLOWED_PREFIXES,
  RELEASE_FORBIDDEN,
} from "./release-check-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function report(label, ok, detail = "") {
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  return ok;
}

function runPnpm(args) {
  const result = crossSpawn.sync("pnpm", args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  if (result.error) throw result.error;
  return result.status;
}

function runNode(args) {
  const result = crossSpawn.sync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const versionSource = await readFile(join(root, "src", "version.ts"), "utf8");
const sourceVersion = versionSource.match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/)?.[1];
report("runtime/package version match", sourceVersion === packageJson.version,
  `src/version.ts=${sourceVersion ?? "missing"}, package.json=${packageJson.version ?? "missing"}`);

// 1) verify
report("typecheck", runPnpm(["typecheck"]) === 0, "pnpm typecheck failed");
report("tests", runPnpm(["test"]) === 0, "pnpm test failed");
report("build", runPnpm(["build"]) === 0, "pnpm build failed");

// 2) offline doctor
const doctor = runNode([join(root, "scripts", "doctor.mjs"), "--offline", "--json"]);
report("offline doctor exits successfully", doctor.status === 0, doctor.stderr.slice(0, 400));
let doctorReport = null;
try {
  doctorReport = JSON.parse(doctor.stdout);
} catch {
  report("offline doctor parseable JSON", false, doctor.stdout.slice(0, 400));
}
if (doctorReport) {
  report("offline doctor passes", doctorReport.ok === true, JSON.stringify(doctorReport.checks.filter((c) => !c.ok).map((c) => c.label)));
  report("offline doctor reports skipped codex checks", doctorReport.skippedCount >= 4, `skippedCount=${doctorReport.skippedCount}`);
}

// 3) pack audit (temp dir always cleaned)
const tempDir = await mkdtemp(join(tmpdir(), "dsh-release-check-"));
let tgz = null;
try {
  const pack = runPnpm(["pack", "--pack-destination", tempDir]);
  report("pack succeeds", pack === 0, "pnpm pack failed");
  const files = await readdir(tempDir);
  tgz = files.find((name) => name.endsWith(".tgz"));
  report("pack produced a tarball", Boolean(tgz), "no .tgz emitted");
  if (tgz) {
    const bytes = await readFile(join(tempDir, tgz));
    const rawNames = parseTarGzMembers(bytes);
    const members = rawNames.map((name) => name.replace(/^package\//, "")).filter((name) => name.length > 0 && !name.endsWith("/"));
    report("tarball lists cleanly", members.length > 0, "no members parsed");

    const forbidden = RELEASE_FORBIDDEN;
    const outOfWhitelist = [];
    const forbiddenMatches = [];
    for (const member of members) {
      if (forbidden.some((pattern) => pattern.test(member))) forbiddenMatches.push(member);
      if (RELEASE_ALLOWED_FILES.has(member)) continue;
      if (RELEASE_ALLOWED_PREFIXES.some((prefix) => member.startsWith(prefix))) continue;
      outOfWhitelist.push(member);
    }
    report("every tarball member is on the files whitelist", outOfWhitelist.length === 0, `out-of-whitelist: ${outOfWhitelist.join(", ")}`);
    report("no forbidden/temp/credential/fixture content shipped", forbiddenMatches.length === 0, `forbidden: ${forbiddenMatches.join(", ")}`);
    report("package.json shipped", members.includes("package.json"), "package.json missing");
    report("at least one lib/ artifact shipped", members.some((name) => name.startsWith("lib/")), "lib/ missing");
    report("no tests/fixtures shipped", !members.some((name) => name.startsWith("test/") || name.includes("fixtures")), "test/ or fixtures shipped");
  }
} finally {
  // Always remove the temp pack directory; a stray tgz must never survive.
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

const ok = failures.length === 0;
process.stdout.write(ok
  ? `RELEASE_CHECK_OK\nverified: typecheck/test/build\noffline doctor: ok (${doctorReport?.skippedCount ?? 0} skipped)\npack audit: ok\ntemp tarball: cleaned\n`
  : `RELEASE_CHECK_FAIL\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
if (!ok) process.exitCode = 1;

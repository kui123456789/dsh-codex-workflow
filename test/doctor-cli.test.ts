import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseTarGzMembers } from "../scripts/release-check-lib.mjs";

const doctor = join(fileURLToPath(new URL("..", import.meta.url)), "scripts", "doctor.mjs");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface DoctorJson {
  ok: boolean;
  offline: boolean;
  version: string;
  login: string;
  skippedCount: number;
  failedCount: number;
  checks: Array<{ label: string; ok: boolean; skipped: boolean; detail: string }>;
}

test("offline doctor passes with explicit skipped codex checks and no residue", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-cli-"));
  try {
    const result = await runNode([doctor, "--offline", "--json"], { DSH_HOME: home });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout) as DoctorJson;
    assert.equal(report.ok, true);
    assert.equal(report.offline, true);
    assert.ok(report.skippedCount >= 4, `the codex-heavy checks are explicitly skipped: ${report.skippedCount}`);
    assert.ok(report.checks.some((check) => check.label === "bridge CLI binary exists" && check.ok && !check.skipped));
    assert.ok(report.checks.some((check) => check.label === "sqlite integrity check passes (fresh capability)" && check.ok && !check.skipped));
    assert.equal(report.checks.filter((check) => !check.skipped && !check.ok).length, 0);
    for (const check of report.checks.filter((entry) => entry.ok && !entry.skipped)) {
      assert.doesNotMatch(check.detail, /failed|does not expose|must support|run pnpm build first/i, `${check.label} has a success-compatible detail`);
    }
    const skipped = report.checks.filter((check) => check.skipped);
    for (const label of ["codex CLI version", "codex login status", "legacy codex exec resume syntax supported", "codex app-server reachable"]) {
      assert.ok(skipped.some((check) => check.label === label), `expected ${label} to be skipped`);
    }
    // The offline probe must not create anything under the real DSH_HOME.
    assert.equal(await exists(join(home, "storages", "dsh-codex-workflow")), false, "no storage dir created in the real home");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor JSON reports argument failures without losing successful checks", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-cli-args-"));
  try {
    const result = await runNode([doctor, "--offline", "--json", "--unknown"], { DSH_HOME: home });
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout) as DoctorJson;
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.label === "arguments" && !check.ok));
    assert.ok(report.checks.some((check) => check.label === "bridge CLI binary exists" && check.ok));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("offline doctor fails loudly (never falsely passes) when a local check is broken", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-cli-fail-"));
  try {
    const result = await runNode(
      [doctor, "--offline", "--json"],
      { DSH_HOME: home, DSH_CODEX_WORKFLOW_LISTEN: "1" }, // forbidden by the plugin
    );
    assert.equal(result.code, 1, "exit code must be nonzero on a local failure");
    const report = JSON.parse(result.stdout) as DoctorJson;
    assert.equal(report.ok, false);
    assert.ok(report.failedCount >= 1, `local failure is reported: ${report.failedCount}`);
    assert.ok(report.checks.some((check) => !check.ok && !check.skipped && check.label === "no network listener configured"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tar.gz member listing parses pnpm pack output shape", async () => {
  // A tiny hand-built ustar+gzip archive mirrors the path structure.
  const { gunzipSync, gzipSync } = await import("node:zlib");
  function ustar(name: string, content: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, "latin1");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write("00000000000", 124, "latin1");
    const sizeOctal = content.length.toString(8).padStart(11, "0");
    header.write(`${sizeOctal}\0`, 124, "latin1");
    header.write("00000000000", 136, "latin1");
    header[156] = 0x30; // '0' regular file
    const body = Buffer.from(content, "utf8");
    const pad = 512 - (body.length % 512 || 512);
    return Buffer.concat([header, body, Buffer.alloc(pad)]);
  }
  const archive = Buffer.concat([
    ustar("package/", ""),
    ustar("package/package.json", "{}"),
    ustar("package/lib/index.js", "export {}"),
    ustar("package/README.md", "# readme"),
    Buffer.alloc(1024), // end-of-archive
  ]);
  const gz = gzipSync(archive);
  const members = parseTarGzMembers(gz);
  assert.deepEqual(
    members.map((member) => member.replace(/^package\//, "")).filter((name) => name.length > 0 && !name.endsWith("/")),
    ["package.json", "lib/index.js", "README.md"],
  );
  void gunzipSync;
});

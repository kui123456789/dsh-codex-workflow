import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ReviewEvidence } from "./types.js";

export interface EvidenceOptions {
  cwd: string;
  maxDiffBytes: number;
  changedFiles?: string[];
}

/**
 * Collect auditable review evidence for a workspace. Git repositories produce
 * `kind: "git"` evidence (porcelain status + streamed `git diff HEAD`); any
 * other workspace degrades to `kind: "files"` evidence derived from
 * `changedFiles`. Evidence collection is best-effort and never throws: a git
 * failure degrades to file evidence, and per-file failures are recorded in
 * `missingFiles` / `rejectedPaths` instead of failing the review.
 */
export async function collectEvidence(options: EvidenceOptions): Promise<ReviewEvidence> {
  if (await isGitRepository(options.cwd)) {
    try {
      return await collectGitEvidence(options);
    } catch {
      // Degrade to file-based evidence instead of failing the review.
    }
  }
  return collectFileEvidence(options);
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGitCapture(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function collectGitEvidence(options: EvidenceOptions): Promise<ReviewEvidence> {
  const { stdout } = await runGitCapture(options.cwd, [
    "-c", "core.quotepath=false",
    "status", "--porcelain=v1", "-z",
    "--untracked-files=all",
  ]);
  const entries = parsePorcelain(stdout);
  const status = entries
    .map((entry) => {
      const path = entry.target ? `${entry.path} -> ${entry.target}` : entry.path;
      return `${entry.xy} ${path}`;
    })
    .join("\n");
  const changedFiles = entries.flatMap((entry) => (entry.target ? [entry.path, entry.target] : [entry.path]));
  const hasHead = await repositoryHasHead(options.cwd);
  const commands = hasHead
    ? [["diff", "HEAD", "--no-ext-diff", "--no-color"]]
    : [
        ["diff", "--cached", "--no-ext-diff", "--no-color"],
        ["diff", "--no-ext-diff", "--no-color"],
      ];
  const diff = await streamGitDiff(options.cwd, commands, options.maxDiffBytes);
  const captured = diff.captured.subarray(0, options.maxDiffBytes);
  // Untracked files never appear in any diff, but their content is still a
  // verifiable workspace change: hash it so no-change detection sees edits.
  const untrackedDigest = createHash("sha256");
  for (const entry of entries) {
    if (entry.xy !== "??") continue;
    const resolved = resolve(options.cwd, entry.path);
    if (!isWithin(options.cwd, resolved)) continue;
    try {
      const info = await stat(resolved);
      if (info.isFile()) untrackedDigest.update(await hashFile(resolved));
    } catch {
      // Entry vanished between status and hash; keep the fingerprint stable.
    }
  }
  const fingerprintHash = createHash("sha256");
  fingerprintHash.update(status);
  fingerprintHash.update("\n");
  fingerprintHash.update(diff.digest);
  fingerprintHash.update("\n");
  fingerprintHash.update(untrackedDigest.digest());
  return {
    kind: "git",
    changedFiles,
    status,
    diff: decodeUtf8Safely(captured),
    diffTruncated: diff.totalBytes > options.maxDiffBytes,
    diffBytes: diff.totalBytes,
    fingerprint: fingerprintHash.digest("hex"),
    fileHashes: [],
    missingFiles: [],
    rejectedPaths: [],
    insufficient: false,
  };
}

async function collectFileEvidence(options: EvidenceOptions): Promise<ReviewEvidence> {
  const entries = Array.isArray(options.changedFiles)
    ? options.changedFiles.filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
  // Sufficient only when at least one cwd-internal regular file was hashed;
  // all-missing / all-rejected input is unverifiable and disables no-change.
  const realCwd = await realpath(options.cwd).catch(() => options.cwd);
  const fileHashes: ReviewEvidence["fileHashes"] = [];
  const missingFiles: string[] = [];
  const rejectedPaths: string[] = [];
  const capturer = new DiffCapturer(options.maxDiffBytes);
  for (const entry of entries) {
    const target = await resolveWithinCwd(options.cwd, realCwd, entry);
    if (target === "outside") {
      rejectedPaths.push(entry);
      capturer.push(Buffer.from(`x rejected ${entry}\n`, "utf8"));
      continue;
    }
    if (target === "missing") {
      missingFiles.push(entry);
      capturer.push(Buffer.from(`! missing ${entry}\n`, "utf8"));
      continue;
    }
    let info;
    try {
      info = await stat(target.resolved);
    } catch {
      missingFiles.push(entry);
      capturer.push(Buffer.from(`! missing ${entry}\n`, "utf8"));
      continue;
    }
    if (!info.isFile()) {
      rejectedPaths.push(entry);
      capturer.push(Buffer.from(`x rejected ${entry}\n`, "utf8"));
      continue;
    }
    const sha256 = await hashFile(target.resolved);
    fileHashes.push({ path: entry, sha256 });
    capturer.push(Buffer.from(`+ ${entry}\t${sha256}\n`, "utf8"));
  }
  const insufficient = fileHashes.length === 0;
  const status = [
    ...fileHashes.map((file) => `+ ${file.path}`),
    ...missingFiles.map((path) => `! missing ${path}`),
    ...rejectedPaths.map((path) => `x rejected ${path}`),
  ].join("\n");
  const captured = capturer.buffer();
  const base = {
    kind: "files" as const,
    changedFiles: entries,
    status,
    diff: decodeUtf8Safely(captured),
    diffTruncated: capturer.total > options.maxDiffBytes,
    diffBytes: capturer.total,
    fileHashes,
    missingFiles,
    rejectedPaths,
  };
  if (insufficient) {
    // Unverifiable input still reports what was observed, but carries no
    // fingerprint so no-change detection stays disabled.
    return { ...base, fingerprint: "", insufficient: true };
  }
  const fingerprintHash = createHash("sha256");
  for (const file of [...fileHashes].sort((left, right) => left.path.localeCompare(right.path))) {
    fingerprintHash.update(`+${file.path}:${file.sha256}\n`);
  }
  for (const path of [...missingFiles].sort()) fingerprintHash.update(`!${path}\n`);
  for (const path of [...rejectedPaths].sort()) fingerprintHash.update(`x${path}\n`);
  return { ...base, fingerprint: fingerprintHash.digest("hex"), insufficient: false };
}

/** Resolve changed files against the real (symlink-free) workspace and reject
 * any entry whose canonical target lands outside it. */
async function resolveWithinCwd(cwd: string, realCwd: string, entry: string): Promise<{ resolved: string } | "outside" | "missing"> {
  const resolved = resolve(cwd, entry);
  if (!isWithin(cwd, resolved)) return "outside";
  let realTarget: string;
  try {
    realTarget = await realpath(resolved);
  } catch {
    return "missing";
  }
  if (!isWithin(realCwd, realTarget)) return "outside";
  return { resolved: realTarget };
}

interface PorcelainEntry {
  xy: string;
  path: string;
  target?: string;
}

function parsePorcelain(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  const parts = stdout.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const xy = part.slice(0, 2);
    const path = part.slice(3);
    // For renames/copies the index column (xy[0]) carries the R/C flag; xy[1]
    // is the worktree status column and is commonly a space.
    const code = xy[0];
    if ((code === "R" || code === "C") && path) {
      const other = parts[index + 1];
      if (other) {
        // In -z mode git lists the destination first and the source second;
        // render them as "source -> destination" like the human format.
        entries.push({ xy, path: other, target: path });
        index += 1;
      } else {
        entries.push({ xy, path });
      }
    } else {
      entries.push({ xy, path });
    }
  }
  return entries;
}

interface StreamedDiff {
  captured: Buffer;
  digest: string;
  totalBytes: number;
}

async function streamGitDiff(cwd: string, commands: string[][], maxBytes: number): Promise<StreamedDiff> {
  const hash = createHash("sha256");
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  for (const args of commands) {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        totalBytes += chunk.length;
        const remaining = maxBytes - capturedBytes;
        if (remaining > 0) {
          const take = Math.min(chunk.length, remaining);
          captured.push(chunk.subarray(0, take));
          capturedBytes += take;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
      });
    });
  }
  return { captured: Buffer.concat(captured), digest: hash.digest("hex"), totalBytes };
}

function runGitCapture(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    // Accumulate raw bytes and decode once: a per-chunk toString() can split a
    // multi-byte UTF-8 path across chunk boundaries and corrupt it with U+FFFD.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout: Buffer.concat(stdoutChunks).toString("utf8") });
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${Buffer.concat(stderrChunks).toString("utf8").trim()}`));
    });
  });
}

async function repositoryHasHead(cwd: string): Promise<boolean> {
  try {
    await runGitCapture(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

class DiffCapturer {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    // Count every byte pushed so diffBytes/diffTruncated reflect the full
    // observed size even when the retained text is capped.
    this.totalBytes += chunk.length;
    if (this.capturedBytes >= this.maxBytes) return;
    const take = Math.min(chunk.length, this.maxBytes - this.capturedBytes);
    this.chunks.push(chunk.subarray(0, take));
    this.capturedBytes += take;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get size(): number {
    return this.capturedBytes;
  }

  get total(): number {
    return this.totalBytes;
  }
}

function isWithin(cwd: string, target: string): boolean {
  const rel = relative(cwd, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Decode a byte buffer as UTF-8, dropping an incomplete trailing code point
 * (at most 3 bytes) instead of emitting a replacement character. */
function decodeUtf8Safely(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  let end = buffer.length;
  let start = end - 1;
  while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1;
  const lead = buffer[start]!;
  let sequenceLength = 0;
  if ((lead & 0x80) === 0) sequenceLength = 1;
  else if ((lead & 0xe0) === 0xc0) sequenceLength = 2;
  else if ((lead & 0xf0) === 0xe0) sequenceLength = 3;
  else if ((lead & 0xf8) === 0xf0) sequenceLength = 4;
  if (sequenceLength > 0 && end - start < sequenceLength) end = start;
  return buffer.subarray(0, end).toString("utf8");
}
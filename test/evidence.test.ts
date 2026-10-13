import assert from "node:assert/strict";
import childProcess, { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { collectEvidence } from "../src/evidence.js";

const execFileAsync = promisify(execFile);

test("non-git evidence rejects symlinks escaping the workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-link-"));
  const outside = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-link-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "top secret", "utf8");
    try {
      await symlink(join(outside, "secret.txt"), join(directory, "link.txt"), "file");
    } catch {
      t.skip("file symlinks are not supported on this platform");
      return;
    }
    // The escaping link must be rejected, not hashed.
    const escaping = await collectEvidence({ cwd: directory, maxDiffBytes: 65536, changedFiles: ["link.txt"] });
    assert.deepEqual(escaping.rejectedPaths, ["link.txt"]);
    assert.equal(escaping.fileHashes.length, 0);
    assert.equal(escaping.insufficient, true);

    // A symlink that stays inside the workspace is still accepted and hashed.
    await writeFile(join(directory, "real.txt"), "inside", "utf8");
    await symlink(join(directory, "real.txt"), join(directory, "inner-link.txt"), "file");
    const inside = await collectEvidence({ cwd: directory, maxDiffBytes: 65536, changedFiles: ["inner-link.txt"] });
    assert.equal(inside.insufficient, false);
    assert.ok(inside.fileHashes[0]?.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("non-git evidence accepts files when the workspace is reached through a symlink", async (t) => {
  const real = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-real-"));
  const link = join(tmpdir(), `dsh-codex-evidence-linkdir-${Date.now()}`);
  try {
    await writeFile(join(real, "a.txt"), "alpha", "utf8");
    try {
      await symlink(real, link, "dir");
    } catch {
      try {
        await symlink(real, link, "junction");
      } catch {
        t.skip("directory links are not supported on this platform");
        return;
      }
    }
    const evidence = await collectEvidence({ cwd: link, maxDiffBytes: 65536, changedFiles: ["a.txt"] });
    assert.equal(evidence.insufficient, false);
    assert.equal(evidence.fileHashes[0]?.path, "a.txt");
    assert.ok(evidence.fileHashes[0]?.sha256);
  } finally {
    await rm(real, { recursive: true, force: true });
    await rm(link, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function gitInit(directory: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: directory, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: directory, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: directory, windowsHide: true });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: directory, windowsHide: true });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: directory, windowsHide: true });
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: directory, windowsHide: true });
  return stdout;
}

async function commitAll(directory: string, message: string): Promise<void> {
  await git(directory, "add", "-A");
  await git(directory, "commit", "-q", "-m", message);
}

async function makeGitRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-"));
  await gitInit(directory);
  await writeFile(join(directory, "base.txt"), "base", "utf8");
  await commitAll(directory, "initial");
  return directory;
}

test("git evidence distinguishes different clean committed revisions and repeats the same revision", async () => {
  const directory = await makeGitRepo();
  try {
    const firstRevision = (await git(directory, "rev-parse", "HEAD")).trim();
    const first = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    const repeated = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(first.kind, "git");
    assert.equal(first.status, "");
    assert.equal(first.diffBytes, 0);
    assert.equal(first.fingerprint, repeated.fingerprint);
    await writeFile(join(directory, "base.txt"), "different committed implementation", "utf8");
    await commitAll(directory, "different implementation");
    const nextRevision = (await git(directory, "rev-parse", "HEAD")).trim();
    const next = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(next.status, "");
    assert.equal(next.diffBytes, 0);
    assert.notEqual(firstRevision, nextRevision);
    assert.notEqual(first.fingerprint, next.fingerprint, "a clean commit must not hide changed source from the review guard");
    assert.equal(first.baseRevision, firstRevision);
    assert.equal(next.baseRevision, nextRevision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence rejects a HEAD change during collection and anchors diff to the captured revision", async (t) => {
  const directory = await makeGitRepo();
  const spawn = childProcess.spawn;
  let changed = false;
  let diffBase: string | undefined;
  const firstRevision = (await git(directory, "rev-parse", "HEAD")).trim();
  // Inject at the external Git process boundary while every command still
  // runs against the real fixture repository. Other evidence tests run serially.
  const intercepted = t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof spawn>) => {
    const [command, argv] = args;
    if (!changed && command === "git" && Array.isArray(argv) && argv[0] === "diff") {
      changed = true;
      diffBase = argv[1];
      writeFileSync(join(directory, "base.txt"), "committed while collecting", "utf8");
      execFileSync("git", ["add", "base.txt"], { cwd: directory, windowsHide: true });
      execFileSync("git", ["commit", "-q", "-m", "interleaved commit"], { cwd: directory, windowsHide: true });
    }
    return Reflect.apply(spawn, childProcess, args);
  }) as typeof spawn);
  syncBuiltinESMExports();
  try {
    const evidence = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(changed, true);
    assert.notEqual((await git(directory, "rev-parse", "HEAD")).trim(), firstRevision);
    assert.equal(evidence.kind, "files", "a mixed Git snapshot is refused through the explicit fallback");
    assert.equal(evidence.insufficient, true);
    assert.equal(evidence.fingerprint, "");
    assert.equal(evidence.baseRevision, undefined);
    assert.equal(diffBase, firstRevision, "the diff cannot silently resolve a different HEAD than the captured base");
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence distinguishes an unborn clean repository from its first empty commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-first-commit-"));
  try {
    await gitInit(directory);
    const unborn = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(unborn.kind, "git");
    assert.equal(unborn.baseRevision, "unborn");
    assert.equal(unborn.status, "");
    assert.equal(unborn.diffBytes, 0);
    const repeated = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(repeated.fingerprint, unborn.fingerprint);
    await git(directory, "commit", "--allow-empty", "-q", "-m", "first empty commit");
    const committed = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(committed.kind, "git");
    assert.equal(committed.status, "");
    assert.equal(committed.diffBytes, 0);
    assert.equal(committed.baseRevision, (await git(directory, "rev-parse", "HEAD")).trim());
    assert.notEqual(committed.fingerprint, unborn.fingerprint, "an empty first commit changes the base even with no diff or status entries");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable Git HEAD reference falls back to explicit file evidence rather than unborn", async () => {
  const directory = await makeGitRepo();
  try {
    const branch = (await git(directory, "symbolic-ref", "HEAD")).trim();
    await writeFile(join(directory, ".git", ...branch.split("/")), "invalid-ref-value\n", "utf8");
    assert.equal((await git(directory, "rev-parse", "--is-inside-work-tree")).trim(), "true");
    await assert.rejects(git(directory, "rev-parse", "--verify", "--quiet", "HEAD"), (error: unknown) => {
      const failed = error as { code?: number; stderr?: string };
      assert.equal(failed.code, 1);
      assert.equal(failed.stderr?.trim(), "", "quiet HEAD resolution alone also hides this broken reference");
      return true;
    });
    await assert.rejects(git(directory, "show-ref", "--exists", branch), (error: unknown) => {
      const failed = error as { code?: number; stderr?: string };
      assert.equal(failed.code, 1, "a malformed ref is a lookup error, not the missing-ref exit code 2");
      assert.ok(failed.stderr?.trim(), "verifying the branch distinguishes a broken reference from a missing unborn ref");
      return true;
    });
    const missingScope = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(missingScope.kind, "files");
    assert.equal(missingScope.insufficient, true);
    assert.equal(missingScope.fingerprint, "");
    assert.equal(missingScope.baseRevision, undefined);
    const explicitScope = await collectEvidence({ cwd: directory, maxDiffBytes: 65536, changedFiles: ["base.txt"] });
    assert.equal(explicitScope.kind, "files");
    assert.equal(explicitScope.insufficient, false);
    assert.equal(explicitScope.fileHashes[0]?.path, "base.txt");
    assert.ok(explicitScope.fingerprint);
    assert.equal(explicitScope.baseRevision, undefined, "file evidence never claims a known Git base revision");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence covers untracked files and is stable for identical states", async () => {
  const directory = await makeGitRepo();
  try {
    await writeFile(join(directory, "new.txt"), "hello 世界", "utf8");
    const first = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(first.kind, "git");
    assert.ok(first.changedFiles.includes("new.txt"));
    assert.match(first.status, /^\?\? new\.txt$/m);
    assert.equal(first.diffTruncated, false);
    assert.ok(first.fingerprint);
    const second = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(first.fingerprint, second.fingerprint);
    // Content change moves the fingerprint even though it is untracked.
    await writeFile(join(directory, "new.txt"), "changed 内容", "utf8");
    const third = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.notEqual(second.fingerprint, third.fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence distinguishes staged and unstaged changes", async () => {
  const directory = await makeGitRepo();
  try {
    await writeFile(join(directory, "base.txt"), "modified", "utf8");
    const unstaged = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.match(unstaged.status, /^ M base\.txt$/m);
    await git(directory, "add", "base.txt");
    const staged = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.match(staged.status, /^M  base\.txt$/m);
    assert.notEqual(unstaged.fingerprint, staged.fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence records deletions and renames", async () => {
  const directory = await makeGitRepo();
  try {
    await writeFile(join(directory, "moved.txt"), "move me", "utf8");
    await commitAll(directory, "add moved");
    await git(directory, "mv", "moved.txt", "renamed.txt");
    const renamed = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.match(renamed.status, /^R +moved\.txt -> renamed\.txt$/m);
    assert.ok(renamed.changedFiles.includes("moved.txt"));
    assert.ok(renamed.changedFiles.includes("renamed.txt"));

    await git(directory, "rm", "-q", "base.txt");
    const deleted = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.match(deleted.status, /^D +base\.txt$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence truncates large diffs safely and still hashes the full output", async () => {
  const directory = await makeGitRepo();
  try {
    const large = `大 ${"x".repeat(10_000)} \u4f60\u597d`;
    await writeFile(join(directory, "base.txt"), large, "utf8");
    const evidence = await collectEvidence({ cwd: directory, maxDiffBytes: 1024 });
    assert.equal(evidence.diffTruncated, true);
    assert.ok(evidence.diff.length <= 1024 * 4); // capped, and no unbounded blowup
    assert.ok(!evidence.diff.includes("\uFFFD"), "truncated diff must not contain replacement characters");
    // Truncation changes the returned text but never the fingerprint.
    const full = await collectEvidence({ cwd: directory, maxDiffBytes: 1024 * 1024 });
    assert.equal(evidence.fingerprint, full.fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence works in a repository with no commits yet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-nocommit-"));
  try {
    await gitInit(directory);
    await writeFile(join(directory, "only.txt"), "no HEAD yet", "utf8");
    const evidence = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(evidence.kind, "git");
    assert.equal(evidence.baseRevision, "unborn");
    assert.match(evidence.status, /^\?\? only\.txt$/m);
    assert.ok(evidence.fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-git evidence hashes files inside the cwd and rejects traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-files-"));
  try {
    await writeFile(join(directory, "a.txt"), "alpha", "utf8");
    await mkdir(join(directory, "sub"));
    await writeFile(join(directory, "sub", "b.txt"), "beta", "utf8");
    const escaped = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-outside-"));
    await writeFile(join(escaped, "outside.txt"), "secret", "utf8");
    try {
      const evidence = await collectEvidence({
        cwd: directory,
        maxDiffBytes: 65536,
        changedFiles: ["a.txt", "sub\\b.txt", "missing.txt", "../outside.txt", "..\\outside.txt", join(escaped, "outside.txt")],
      });
      assert.equal(evidence.kind, "files");
      assert.equal(evidence.fileHashes.length, 2);
      assert.deepEqual(evidence.fileHashes.map((file) => file.path), ["a.txt", "sub\\b.txt"]);
      assert.ok(evidence.fileHashes[0]?.sha256);
      assert.ok(evidence.fileHashes[1]?.sha256);
      assert.deepEqual(evidence.missingFiles, ["missing.txt"]);
      assert.deepEqual(evidence.rejectedPaths, ["../outside.txt", "..\\outside.txt", join(escaped, "outside.txt")]);
      assert.equal(evidence.insufficient, false);
      const once = await collectEvidence({
        cwd: directory,
        maxDiffBytes: 65536,
        changedFiles: ["a.txt", "sub\\b.txt", "missing.txt", "../outside.txt", "..\\outside.txt", join(escaped, "outside.txt")],
      });
      assert.equal(evidence.fingerprint, once.fingerprint);
    } finally {
      await rm(escaped, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-git evidence without changed files is insufficient and never blocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-insufficient-"));
  try {
    await writeFile(join(directory, "a.txt"), "alpha", "utf8");
    const evidence = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(evidence.kind, "files");
    assert.equal(evidence.insufficient, true);
    assert.equal(evidence.fingerprint, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-git evidence never throws inside the workspace sandbox boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-missing-"));
  try {
    const evidence = await collectEvidence({ cwd: directory, maxDiffBytes: 65536, changedFiles: ["gone.txt"] });
    assert.deepEqual(evidence.missingFiles, ["gone.txt"]);
    // A lone missing file carries no hashed content, so it is unverifiable.
    assert.equal(evidence.insufficient, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence observes content changes inside untracked directories", async () => {
  const directory = await makeGitRepo();
  try {
    await mkdir(join(directory, "newdir"));
    await writeFile(join(directory, "newdir", "a.txt"), "one", "utf8");
    const first = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.ok(first.changedFiles.includes("newdir/a.txt"), `changedFiles=${JSON.stringify(first.changedFiles)}`);
    await writeFile(join(directory, "newdir", "a.txt"), "two", "utf8");
    const second = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.notEqual(first.fingerprint, second.fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git evidence handles multi-byte UTF-8 paths safely", async () => {
  const directory = await makeGitRepo();
  try {
    const unicode = "中文 文件.txt";
    await writeFile(join(directory, unicode), "内容一", "utf8");
    const first = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.ok(first.changedFiles.some((path) => path.includes("中文")), `changedFiles=${JSON.stringify(first.changedFiles)}`);
    assert.ok(!first.status.includes("\uFFFD"), "status must not contain replacement characters");
    assert.ok(!first.diff.includes("\uFFFD"), "diff must not contain replacement characters");
    const again = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.equal(first.fingerprint, again.fingerprint);
    await writeFile(join(directory, unicode), "内容二", "utf8");
    const third = await collectEvidence({ cwd: directory, maxDiffBytes: 65536 });
    assert.notEqual(again.fingerprint, third.fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-git evidence with only missing or rejected files is insufficient", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-unverifiable-"));
  try {
    const missing = await collectEvidence({
      cwd: directory,
      maxDiffBytes: 65536,
      changedFiles: ["gone-a.txt", "gone-b.txt"],
    });
    assert.equal(missing.insufficient, true);
    assert.deepEqual(missing.missingFiles, ["gone-a.txt", "gone-b.txt"]);
    assert.equal(missing.fingerprint, "");

    const rejected = await collectEvidence({
      cwd: directory,
      maxDiffBytes: 65536,
      changedFiles: ["../out.txt", "..\\out2.txt"],
    });
    assert.equal(rejected.insufficient, true);
    assert.equal(rejected.rejectedPaths.length, 2);
    assert.equal(rejected.fingerprint, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-git evidence reports total diff bytes and truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-evidence-diffbytes-"));
  try {
    const entries = Array.from({ length: 100 }, (_, index) => `missing-${index}.txt`);
    const evidence = await collectEvidence({ cwd: directory, maxDiffBytes: 1024, changedFiles: entries });
    assert.equal(evidence.insufficient, true);
    assert.ok(evidence.diffBytes > 1024, `diffBytes=${evidence.diffBytes}`);
    assert.equal(evidence.diffTruncated, true);
    // Retained text is capped while the listing is still usable.
    assert.ok(evidence.diff.length <= 1024 * 4);
    assert.equal(evidence.missingFiles.length, entries.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

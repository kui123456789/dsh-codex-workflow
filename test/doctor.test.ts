import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacyProbeCleanup, probeStorage } from "../scripts/doctor-probes.mjs";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("probeStorage rejects UNC/network storage paths", async () => {
  const probeDir = await mkdtemp(join(tmpdir(), "dsh-doctor-probe-"));
  try {
    const result = await probeStorage({ storageDir: "\\\\server\\share\\storages\\x", probeDir });
    assert.equal(result.unc, true, "UNC is flagged");
    assert.match(result.error ?? "", /local disk|UNC/, "UNC is an explicit error");
    assert.equal(result.journalOk, false, "no capability claim for a rejected path");
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("probeStorage leaves an empty real DSH_HOME untouched", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-empty-"));
  const probeDir = await mkdtemp(join(tmpdir(), "dsh-doctor-probe-"));
  try {
    const storageDir = join(home, "storages", "dsh-codex-workflow");
    const result = await probeStorage({ storageDir, probeDir });
    assert.equal(result.writable, true, "temp probe dir is writable (temp SQLite capability)");
    assert.equal(result.realStorageWritable, true, "the nearest existing ancestor is writable (no write performed)");
    assert.equal(result.realStorageWritableError, undefined);
    assert.equal(result.realExists, false, "no real database yet");
    assert.equal(result.error, undefined);
    // The probe wrote ONLY into the temp probeDir.
    assert.equal(await exists(storageDir), false, "nothing created under the real home");
    assert.equal(await exists(join(home, "storages")), false);
    assert.equal(
      await exists(join(probeDir, "storages", "dsh-codex-workflow", "doctor-write-probe.txt")),
      true,
      "the writable probe lives in the temp dir",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("real-storage access failure (EACCES) is a real doctor failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-eacces-"));
  const probeDir = await mkdtemp(join(tmpdir(), "dsh-doctor-probe-"));
  try {
    const storageDir = join(home, "storages", "dsh-codex-workflow");
    await mkdir(storageDir, { recursive: true });
    const eacces = new Error("permission denied") as NodeJS.ErrnoException;
    eacces.code = "EACCES";
    const result = await probeStorage({
      storageDir,
      probeDir,
      accessReal: async () => { throw eacces; },
    });
    assert.equal(result.realStorageWritable, false, "EACCES on real storage is reported");
    assert.match(result.realStorageWritableError ?? "", /not writable|permission denied/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("legacy probe cleanup removes ONLY our own exact 'ok' file", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-legacy-"));
  try {
    const storageDir = join(home, "storages", "dsh-codex-workflow");
    await mkdir(storageDir, { recursive: true });
    const probe = join(storageDir, "doctor-write-probe.txt");

    // Not our content: preserved and reported, never deleted.
    await writeFile(probe, "custom user data\n", "utf8");
    const kept = await legacyProbeCleanup({ storageDir });
    assert.equal(kept.present, true);
    assert.equal(kept.deleted, false, "unknown content is never deleted");
    assert.equal(await exists(probe), true, "the unknown file is preserved");

    // Our exact payload: removed.
    await writeFile(probe, "ok", "utf8");
    const removed = await legacyProbeCleanup({ storageDir });
    assert.equal(removed.deleted, true, "the old doctor's exact 'ok' probe is removed");
    assert.equal(await exists(probe), false);

    // Absent: no-op.
    const absent = await legacyProbeCleanup({ storageDir });
    assert.equal(absent.present, false);
    assert.equal(absent.deleted, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("existing real coord.sqlite is inspected read-only: content and mtime unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-real-"));
  const probeDir = await mkdtemp(join(tmpdir(), "dsh-doctor-probe-"));
  try {
    const storageDir = join(home, "storages", "dsh-codex-workflow");
    await mkdir(storageDir, { recursive: true });
    const dbPath = join(storageDir, "coord.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE t(a TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO t VALUES ('payload')").run();
    db.close();
    const beforeContent = await readFile(dbPath);
    const beforeStat = await stat(dbPath);

    const result = await probeStorage({ storageDir, probeDir });

    assert.equal(result.realExists, true);
    assert.equal(result.real?.journal, "delete");
    assert.equal(result.real?.integrityOk, true);
    assert.equal(result.realError, undefined);
    const afterContent = await readFile(dbPath);
    const afterStat = await stat(dbPath);
    assert.ok(beforeContent.equals(afterContent), "real database content is unchanged");
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "real database mtime is unchanged");
    assert.equal(await exists(`${dbPath}-wal`), false, "no -wal sidecar created");
    assert.equal(await exists(`${dbPath}-journal`), false, "no -journal sidecar created");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("a corrupt real database surfaces realError (never swallowed)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-corrupt-"));
  const probeDir = await mkdtemp(join(tmpdir(), "dsh-doctor-probe-"));
  try {
    const storageDir = join(home, "storages", "dsh-codex-workflow");
    await mkdir(storageDir, { recursive: true });
    const dbPath = join(storageDir, "coord.sqlite");
    await writeFile(dbPath, "this is definitely not a sqlite database\n", "utf8");

    const result = await probeStorage({ storageDir, probeDir });
    assert.equal(result.realExists, true);
    assert.notEqual(result.realError, undefined, "corrupt real DB must surface an error");
    assert.match(result.realError ?? "", /cannot read the real coordination database/);
    assert.equal(
      !(result.realExists && result.real?.integrityOk === true),
      true,
      "the doctor's real-integrity check condition is false for a corrupt DB",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("a caller's finally removes the probe dir even when the probe reports failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-failclean-"));
  const probeDir = await mkdtemp(join(tmpdir(), "dsh-doctor-probe-"));
  try {
    const storageDir = join(home, "storages", "dsh-codex-workflow");
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, "coord.sqlite"), "not a database\n", "utf8");
    let reportedFailure = false;
    try {
      const result = await probeStorage({ storageDir, probeDir });
      reportedFailure = result.realError !== undefined;
    } finally {
      // The probe used probeDir for its temp writable check and temp database;
      // the caller must be able to remove it even after a reported failure.
      await rm(probeDir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
    assert.equal(reportedFailure, true, "the probe reported the corrupt real DB");
    assert.equal(await exists(probeDir), false, "the caller's finally removed the probe dir");
    assert.equal(await exists(home), false, "the caller's finally removed the real-home probe too");
  } catch (error) {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
});

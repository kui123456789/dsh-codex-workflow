// Doctor storage/database probes, extracted so tests can drive them directly
// WITHOUT spawning a real doctor (and thus without paying for Codex app-server
// checks). `probeStorage` never writes to the real DSH_HOME:
//  - the writability probe and fresh SQLite capability check happen entirely
//    inside `probeDir` (a temp dir), labelled "temp SQLite capability";
//  - the REAL storage directory is checked with a no-write `access(W_OK)`
//    (walking to the nearest existing ancestor when the dir does not exist
//    yet), and an already-existing coord.sqlite is probed READ-ONLY.
// `accessReal` (default: `fs.promises.access`) is injectable so tests can
// simulate EACCES on the real storage without touching permissions.
// It resolves with a structured result (never throws for probe failures); a
// caller that needs cleanup can still rely on finally around the call.

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const W_OK = 2;

/**
 * Legacy cleanup for OUR OWN stale probe file only: an older doctor wrote
 * `doctor-write-probe.txt` with EXACTLY the UTF-8 string "ok". It is deleted
 * ONLY in that case. Any other file with the same name is not ours and is
 * left untouched (the caller reports it); a regular doctor must never modify
 * the real DSH_HOME otherwise.
 */
export async function legacyProbeCleanup({ storageDir }) {
  const path = join(storageDir, "doctor-write-probe.txt");
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { path, present: false, deleted: false, content: undefined };
  }
  if (content === "ok") {
    await rm(path, { force: true });
    return { path, present: true, deleted: true, content };
  }
  return { path, present: true, deleted: false, content };
}

export async function probeStorage({ storageDir, probeDir, accessReal }) {
  const realAccess = accessReal ?? access;
  const realDbPath = join(storageDir, "coord.sqlite");
  const result = {
    unc: false,
    writable: false, // temp-dir writability (feeds the "temp SQLite capability" check)
    writableError: undefined,
    realStorageWritable: false, // real DSH_HOME storage dir is W_OK (no write performed)
    realStorageWritableError: undefined,
    realExists: false,
    real: undefined, // { journal, integrityOk } when the real DB exists and is intact
    realError: undefined, // any failure inspecting the real DB (never swallowed)
    version: undefined,
    journal: undefined,
    integrityOk: false,
    journalOk: false,
    error: undefined, // overall SQLite probe failure (incl. UNC)
  };
  // UNC/network paths are refused outright: the database must live on local
  // disk (SQLite journals are not safe across a network share).
  if (/^[\\/]{2}/.test(storageDir)) {
    result.unc = true;
    result.error = "coordination storage must be on local disk (UNC path detected)";
    return result;
  }
  // Real storage writability WITHOUT writing anything: access(W_OK) on the
  // directory, walking up to the nearest existing ancestor when it is not
  // created yet. Any EACCES/other failure is a real failure, never swallowed.
  {
    let target = storageDir;
    for (let i = 0; i < 64; i += 1) {
      try {
        await realAccess(target, W_OK);
        result.realStorageWritable = true;
        break;
      } catch (error) {
        if (error.code === "ENOENT") {
          const parent = dirname(target);
          if (parent === target) {
            result.realStorageWritableError = `no existing ancestor for storage dir ${storageDir}`;
            break;
          }
          target = parent;
          continue;
        }
        result.realStorageWritableError = `real storage not writable: ${error.message}`;
        break;
      }
    }
  }
  try {
    // Writability probe, entirely inside the temp dir.
    try {
      const probeStorageDir = join(probeDir, "storages", "dsh-codex-workflow");
      await mkdir(join(probeStorageDir, "bridge"), { recursive: true });
      const probe = join(probeStorageDir, "doctor-write-probe.txt");
      await writeFile(probe, "ok", "utf8");
      await access(probe);
      result.writable = true;
    } catch (error) {
      result.writable = false;
      result.writableError = error.message;
    }

    const { DatabaseSync } = await import("node:sqlite");
    let temp;
    try {
      temp = new DatabaseSync(join(probeDir, "coord.sqlite"));
      temp.exec("PRAGMA journal_mode=DELETE");
      temp.exec("PRAGMA synchronous=FULL");
      result.version = temp.prepare("SELECT sqlite_version() AS v").get().v;
      result.journal = temp.prepare("PRAGMA journal_mode").get().journal_mode;
      result.integrityOk = temp.prepare("PRAGMA integrity_check").all().every((row) => row.integrity_check === "ok");
      result.journalOk = result.journal.toLowerCase() === "delete";
    } finally {
      if (temp) temp.close();
    }

    try {
      await access(realDbPath);
      result.realExists = true;
    } catch (error) {
      if (error.code === "ENOENT") {
        result.realExists = false;
      } else {
        result.realError = `cannot access the real coordination database: ${error.message}`;
      }
    }
    if (result.realExists && !result.realError) {
      let rdb;
      try {
        rdb = new DatabaseSync(realDbPath, { readOnly: true });
        const realJournal = rdb.prepare("PRAGMA journal_mode").get().journal_mode;
        const realIntegrity = rdb.prepare("PRAGMA integrity_check").all().every((row) => row.integrity_check === "ok");
        result.real = { journal: realJournal, integrityOk: realIntegrity };
      } catch (error) {
        result.realError = `cannot read the real coordination database: ${error.message}`;
      } finally {
        if (rdb) {
          try {
            rdb.close();
          } catch {
            // already closed
          }
        }
      }
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

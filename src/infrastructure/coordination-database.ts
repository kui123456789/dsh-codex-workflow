import { DatabaseSync } from "node:sqlite";
import { isAbsolute, resolve } from "node:path";

export interface CoordinationDatabaseOptions { busyTimeoutMs?: number; }

function assertLocalDisk(path: string): void {
  if (/^[\\/]{2}/.test(path)) throw new Error(`coordination database path must be on local disk, got UNC path: ${path}`);
}

/** Owns SQLite connection setup and invariant PRAGMAs; repositories use its db. */
export class CoordinationDatabase {
  readonly db: DatabaseSync;

  constructor(readonly path: string, options: CoordinationDatabaseOptions, schema: string) {
    assertLocalDisk(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 10_000}`);
      const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      if (journal.journal_mode.toLowerCase() !== "delete") this.db.exec("PRAGMA journal_mode=DELETE");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec(schema);
    } catch (error) {
      try { this.db.close(); } catch { /* preserve initialization error */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }
  sqliteVersion(): string { return String((this.db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v); }
  journalMode(): string { return String((this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode); }
  integrityCheck(): string[] {
    const messages = (this.db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    if (messages.some((message) => message !== "ok")) throw new Error(`sqlite integrity check failed: ${messages.join("; ")}`);
    return messages;
  }

  static normalizePath(path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

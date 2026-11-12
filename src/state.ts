import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { settings } from "./validation.js";
import type { WorkflowRecord } from "./types.js";

const terminal = new Set(["passed", "blocked", "failed", "cancelled"]);
export const cwdKey = (cwd: string): string => process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
export function active(record: WorkflowRecord): boolean {
  return !terminal.has(record.phase) || Boolean(record.operation && !record.operation.cleanupConfirmed && record.operation.spawnRequested);
}
export function newRecord(cwd: string, input: Record<string, unknown>, command: string, args: string[]): WorkflowRecord {
  const now = new Date().toISOString();
  const ordered = Object.fromEntries(Object.keys(input).sort().map((key) => [key, input[key]]));
  const requestKey = createHash("sha256").update(JSON.stringify({ input: ordered, command, args })).digest("hex");
  return { schemaVersion: 1, id: randomUUID(), revision: 0, cwd, task: input.task as string, requestKey, mode: "planned", phase: "planning", processState: "running", createdAt: now, updatedAt: now,
    settings: settings(input), codexCommand: command, codexArgs: args, reviewCycles: 0, noChangeReviewRounds: 0 };
}
export class StateStore {
  private readonly db: DatabaseSync;
  constructor(readonly home: string, readonly readOnly = false) {
    if (!readOnly) mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "coord.sqlite"), { readOnly });
    this.db.exec("PRAGMA busy_timeout=10000");
    if (!readOnly) this.db.exec(`CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,cwd_key TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_cwd ON workflows(cwd_key) WHERE active=1;`);
  }
  close(): void { this.db.close(); }
  private parse(row: unknown): WorkflowRecord | undefined { return row ? JSON.parse((row as { record_json: string }).record_json) as WorkflowRecord : undefined; }
  get(id: string): WorkflowRecord | undefined { return this.parse(this.db.prepare("SELECT record_json FROM workflows WHERE id=?").get(id)); }
  activeForCwd(cwd: string): WorkflowRecord | undefined { return this.parse(this.db.prepare("SELECT record_json FROM workflows WHERE cwd_key=? AND active=1").get(cwdKey(cwd))); }
  latestForCwd(cwd: string): WorkflowRecord | undefined { return this.parse(this.db.prepare("SELECT record_json FROM workflows WHERE cwd_key=? ORDER BY rowid DESC LIMIT 1").get(cwdKey(cwd))); }
  insert(record: WorkflowRecord): void {
    record.revision = 1;
    this.db.prepare("INSERT INTO workflows VALUES(?,?,?,?,?)").run(record.id, cwdKey(record.cwd), Number(active(record)), 1, JSON.stringify(record));
  }
  update(id: string, mutate: (record: WorkflowRecord) => void): WorkflowRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.get(id);
      if (!record) throw new Error("Unknown workflow");
      mutate(record);
      record.revision++;
      record.updatedAt = new Date().toISOString();
      this.db.prepare("UPDATE workflows SET revision=?,active=?,record_json=? WHERE id=?").run(record.revision, Number(active(record)), JSON.stringify(record), id);
      this.db.exec("COMMIT");
      return record;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

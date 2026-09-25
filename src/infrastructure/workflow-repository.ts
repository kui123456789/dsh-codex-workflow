import type { DatabaseSync } from "node:sqlite";
import { parseWorkflowJson } from "../state/workflow-schema.js";
import type { WorkflowRow } from "../coordination.js";

/** Durable workflow row repository. It owns revision CAS and leaves
 * serialization/migration policy to the shared schema module. */
export class WorkflowRepositorySql {
  constructor(private readonly db: DatabaseSync) {}

  loadWorkflow(id: string): WorkflowRow | undefined {
    const row = this.db.prepare("SELECT id, revision, record_json, updated_at FROM workflows WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), revision: Number(row.revision), recordJson: String(row.record_json), updatedAt: Number(row.updated_at) } : undefined;
  }

  listWorkflows(): WorkflowRow[] {
    const rows = this.db.prepare("SELECT id, revision, record_json, updated_at FROM workflows ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), revision: Number(row.revision), recordJson: String(row.record_json), updatedAt: Number(row.updated_at) }));
  }

  saveWorkflow(id: string, recordJson: string, now = Date.now()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT revision FROM workflows WHERE id = ?").get(id) as { revision: number | bigint } | undefined;
      const revision = Number(existing?.revision ?? 0) + 1;
      this.db.prepare(
        `INSERT INTO workflows (id, revision, record_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record_json = excluded.record_json, updated_at = excluded.updated_at`,
      ).run(id, revision, recordJson, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  compareAndUpdateWorkflow<T>(
    id: string,
    expectedRevision: number,
    mutate: (input: { raw: unknown; revision: number }) => { result: T; recordJson?: string },
    opts: { ignoreCancelled?: boolean },
  ): { kind: "committed" | "suppressed" | "retry"; result?: T; revision: number; recordJson: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT revision, record_json FROM workflows WHERE id = ?").get(id) as { revision: number | bigint; record_json: string } | undefined;
      if (!existing) {
        this.db.exec("ROLLBACK");
        throw new Error(`unknown workflow ${id}`);
      }
      const loadedRevision = Number(existing.revision);
      const raw = parseWorkflowJson(existing.record_json);
      if (!opts.ignoreCancelled && (raw as { phase?: string }).phase === "cancelled") {
        this.db.exec("ROLLBACK");
        return { kind: "suppressed", revision: loadedRevision, recordJson: existing.record_json };
      }
      if (loadedRevision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        return { kind: "retry", revision: loadedRevision, recordJson: existing.record_json };
      }
      const outcome = mutate({ raw, revision: loadedRevision });
      if (outcome.recordJson === undefined) {
        this.db.exec("COMMIT");
        return { kind: "committed", result: outcome.result, revision: loadedRevision, recordJson: existing.record_json };
      }
      const nextRevision = loadedRevision + 1;
      const updated = this.db.prepare(
        "UPDATE workflows SET revision = ?, record_json = ?, updated_at = ? WHERE id = ? AND revision = ?",
      ).run(nextRevision, outcome.recordJson, Date.now(), id, loadedRevision);
      if (Number(updated.changes) === 1) {
        this.db.exec("COMMIT");
        return { kind: "committed", result: outcome.result, revision: nextRevision, recordJson: outcome.recordJson };
      }
      this.db.exec("ROLLBACK");
      return { kind: "retry", revision: loadedRevision, recordJson: existing.record_json };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

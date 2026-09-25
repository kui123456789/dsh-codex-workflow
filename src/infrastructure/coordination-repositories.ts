import type { DatabaseSync } from "node:sqlite";
import type { LeaseGrant, LiveSessionRow } from "../coordination.js";
import { resolve } from "node:path";

type LeaseRow = { epoch: number | bigint; owner: string; lease_until: number | bigint };

/** SQLite implementation of the fenced callback lease repository. */
export class LeaseRepositorySql {
  constructor(private readonly db: DatabaseSync) {}

  acquireLease(resource: string, ttlMs: number, owner: string, now = Date.now()): LeaseGrant | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT epoch, owner, lease_until FROM leases WHERE resource = ?").get(resource) as LeaseRow | undefined;
      if (row && Number(row.lease_until) > now) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const epoch = Number(row?.epoch ?? 0) + 1;
      this.db.prepare(
        `INSERT INTO leases (resource, epoch, owner, lease_until) VALUES (?, ?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET epoch = excluded.epoch, owner = excluded.owner, lease_until = excluded.lease_until`,
      ).run(resource, epoch, owner, now + ttlMs);
      this.db.exec("COMMIT");
      return { epoch, owner };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(resource: string, epoch: number, owner: string, ttlMs: number, now = Date.now()): boolean {
    const result = this.db.prepare("UPDATE leases SET lease_until = ? WHERE resource = ? AND epoch = ? AND owner = ?").run(now + ttlMs, resource, epoch, owner);
    return Number(result.changes) === 1;
  }

  releaseLease(resource: string, epoch: number, owner: string): boolean {
    const result = this.db.prepare("UPDATE leases SET owner = '', lease_until = 0 WHERE resource = ? AND epoch = ? AND owner = ?").run(resource, epoch, owner);
    return Number(result.changes) === 1;
  }

  isLeaseOwner(resource: string, epoch: number, owner: string, now = Date.now()): boolean {
    const row = this.db.prepare("SELECT lease_until FROM leases WHERE resource = ? AND epoch = ? AND owner = ?").get(resource, epoch, owner) as { lease_until: number | bigint } | undefined;
    return !!row && Number(row.lease_until) > now;
  }

  leaseInfo(resource: string): { epoch: number; owner: string; leaseUntil: number } | undefined {
    const row = this.db.prepare("SELECT epoch, owner, lease_until FROM leases WHERE resource = ?").get(resource) as LeaseRow | undefined;
    return row ? { epoch: Number(row.epoch), owner: row.owner, leaseUntil: Number(row.lease_until) } : undefined;
  }
}

/** SQLite implementation of the live DSH session registry. */
export class LiveSessionRepositorySql {
  constructor(private readonly db: DatabaseSync) {}

  refreshOwnerSessions(owner: string, rows: Array<{ sessionId: string; cwd: string }>, ttlMs: number, now = Date.now()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM live_sessions WHERE runtime_owner = ?").run(owner);
      const upsert = this.db.prepare(
        `INSERT INTO live_sessions (session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET runtime_owner = excluded.runtime_owner, cwd = excluded.cwd,
           cwd_key = excluded.cwd_key, lease_until = excluded.lease_until, updated_at = excluded.updated_at`,
      );
      for (const row of rows) upsert.run(row.sessionId, owner, row.cwd, normalizeCwdKey(row.cwd), now + ttlMs, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewOwnerSessions(owner: string, ttlMs: number, now = Date.now()): number {
    const result = this.db.prepare("UPDATE live_sessions SET lease_until = ?, updated_at = ? WHERE runtime_owner = ?").run(now + ttlMs, now, owner);
    return Number(result.changes);
  }

  releaseOwnerSessions(owner: string): number {
    const result = this.db.prepare("DELETE FROM live_sessions WHERE runtime_owner = ?").run(owner);
    return Number(result.changes);
  }

  sessionsForOwner(owner: string, now = Date.now()): LiveSessionRow[] {
    return this.db.prepare("SELECT session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at FROM live_sessions WHERE runtime_owner = ? AND lease_until > ?").all(owner, now).map(mapSessionRow);
  }

  liveSessionsForCwd(cwdKeyValue: string, now = Date.now()): LiveSessionRow[] {
    return this.db.prepare("SELECT session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at FROM live_sessions WHERE cwd_key = ? AND lease_until > ?").all(cwdKeyValue, now).map(mapSessionRow);
  }

  listLiveSessions(now = Date.now()): LiveSessionRow[] {
    return this.db.prepare("SELECT session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at FROM live_sessions WHERE lease_until > ? ORDER BY session_id").all(now).map(mapSessionRow);
  }
}

function normalizeCwdKey(path: string): string {
  return resolve(path).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

function mapSessionRow(row: Record<string, unknown>): LiveSessionRow {
  return {
    sessionId: String(row.session_id),
    runtimeOwner: String(row.runtime_owner),
    cwd: String(row.cwd),
    cwdKey: String(row.cwd_key),
    leaseUntil: Number(row.lease_until),
    updatedAt: Number(row.updated_at),
  };
}

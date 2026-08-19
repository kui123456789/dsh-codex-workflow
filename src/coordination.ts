import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve } from "node:path";

/**
 * SQLite-backed coordination state shared by every DSH process and the CLI.
 * All multi-step invariants (lease acquire/takeover, queue claims, workflow
 * read-modify-write) run inside a single `BEGIN IMMEDIATE` transaction, so a
 * process killed at ANY point leaves no half state: SQLite rolls the
 * transaction back on the next open, and a live `integrity_check` guards the
 * file. Fencing is by a MONOTONIC claim generation (epoch) plus a random
 * owner token: every mutation is a conditional UPDATE `WHERE status = ... AND
 * claim_epoch = ? AND claim_owner = ?`; a stale owner's writes change 0 rows
 * and are no-ops. The epoch is NEVER reset — release only clears the
 * owner/until, and the next claim is always old_epoch + 1 — so a generation
 * can never wrap back and let a stale owner re-match a newer claim.
 *
 * Journal mode is rollback journal (DELETE), deliberately NOT WAL: multiple
 * processes open this database concurrently, and SQLite <= 3.51.2 (the
 * runtime in Node 24.14.0) has a WAL-reset bug that can corrupt the WAL
 * under concurrent writers/checkpoints. DELETE + synchronous=FULL +
 * busy_timeout is the safe multi-connection mode there.
 *
 * Layout (one file per storage directory):
 *   leases(resource PK, epoch, owner, lease_until) — rows persist; release
 *       clears owner/lease_until, it never deletes the row.
 *   queue(request_id PK, command_hash, command_json, status, attempts,
 *       claim_epoch, claim_owner, claim_until, last_error, next_attempt_at,
 *       receipt_json, dead_letter_at, created_at)
 *   workflows(id PK, revision, record_json, updated_at)
 */

export interface CoordinationOptions {
  /** SQLite busy timeout in ms (default 10000). */
  busyTimeoutMs?: number;
}

export interface LeaseGrant {
  epoch: number;
  owner: string;
}

export interface QueueRow {
  requestId: string;
  commandHash: string;
  commandJson: string;
  status: string;
  attempts: number;
  claimEpoch: number;
  claimOwner: string;
  claimUntil: number;
  createdAt: number;
  lastError?: string;
  nextAttemptAt?: number;
  receiptJson?: string;
  deadLetterAt?: number;
}

export interface WorkflowRow {
  id: string;
  revision: number;
  recordJson: string;
  updatedAt: number;
}

export type QueueStatus = "inbox" | "retry" | "processing" | "done" | "dead-letter" | "failed";

export interface PruneRequestCandidate {
  requestId: string;
  status: string;
  terminalAt: number;
}

export interface PruneWorkflowCandidate {
  id: string;
  phase: string;
  revision: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  resource    TEXT PRIMARY KEY,
  epoch       INTEGER NOT NULL,
  owner       TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue (
  request_id    TEXT PRIMARY KEY,
  command_hash  TEXT NOT NULL,
  command_json  TEXT NOT NULL,
  status        TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claim_epoch   INTEGER NOT NULL DEFAULT 0,
  claim_owner   TEXT NOT NULL DEFAULT '',
  claim_until   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at INTEGER,
  receipt_json  TEXT,
  dead_letter_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_by_status ON queue(status, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS live_sessions (
  session_id    TEXT PRIMARY KEY,
  runtime_owner TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  cwd_key       TEXT NOT NULL,
  lease_until   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

/** Refuse network/UNC storage paths: the journal must live on local disk. A
 * UNC path is `\\server\share` or `//server/share`. */
function assertLocalDisk(path: string): void {
  if (/^[\\/]{2}/.test(path)) {
    throw new Error(`coordination database path must be on local disk, got UNC path: ${path}`);
  }
  // A drive-letter path on Windows may still point at a mapped network drive,
  // which cannot be detected reliably; UNC is the definite network shape.
}

/** Live connections grouped by the NORMALIZED database path, so test cleanup
 * (and teardown helpers) can close only the handles for one storage directory
 * without disturbing concurrent tests or other plugin instances. On Windows an
 * open SQLite file cannot be deleted, so a directory can only be removed
 * after its own connections are closed. */
const LIVE_BY_PATH = new Map<string, Set<CoordinationStore>>();

function normalizeDbPath(dbPath: string): string {
  const resolved = isAbsolute(dbPath) ? resolve(dbPath) : resolve(process.cwd(), dbPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Close every live coordination connection whose database file resolves to
 * `dbPath` (idempotent). Does NOT touch connections for other directories.
 * Production stores close their own handle directly and never call this. */
export function closeCoordinationStoresForPath(dbPath: string): void {
  const key = normalizeDbPath(dbPath);
  const group = LIVE_BY_PATH.get(key);
  if (!group) return;
  for (const store of [...group]) store.close();
}

/** Close the coordination connections for a storage/workflow DIRECTORY (i.e.
 * its `coord.sqlite`). Used by test cleanup before removing the directory. */
export function closeCoordinationStoresForDirectory(directory: string): void {
  closeCoordinationStoresForPath(coordinationPath(directory));
}

export class CoordinationStore {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string, options: CoordinationOptions = {}) {
    assertLocalDisk(path);
    this.db = new DatabaseSync(path);
    try {
      // Busy handling must be installed before any PRAGMA that can acquire a
      // write lock. Two DSH processes may open/create the same database at the
      // same time during startup.
      this.db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 10_000}`);
      // Rollback journal (DELETE), NOT WAL: see the module docs — SQLite <=
      // 3.51.2 (Node 24.14.0) has a WAL-reset bug under concurrent writers.
      const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      if (journal.journal_mode.toLowerCase() !== "delete") this.db.exec("PRAGMA journal_mode=DELETE");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec(SCHEMA);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
    const key = normalizeDbPath(path);
    let group = LIVE_BY_PATH.get(key);
    if (!group) {
      group = new Set();
      LIVE_BY_PATH.set(key, group);
    }
    group.add(this);
  }

  /** The store is terminal once closed: no call may reopen the database or
   * resurrect a handle during/after plugin teardown. */
  isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("coordination store is closed");
  }

  /** Runtime SQLite version (e.g. "3.51.2"). */
  sqliteVersion(): string {
    this.assertOpen();
    const row = this.db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    return row.v;
  }

  /** Current journal mode (must be "delete" — we never use WAL). */
  journalMode(): string {
    this.assertOpen();
    const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const key = normalizeDbPath(this.path);
    const group = LIVE_BY_PATH.get(key);
    if (group) {
      group.delete(this);
      if (group.size === 0) LIVE_BY_PATH.delete(key);
    }
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** `PRAGMA integrity_check`; throws unless every row reports "ok". */
  integrityCheck(): string[] {
    this.assertOpen();
    const rows = this.db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const messages = rows.map((row) => row.integrity_check);
    if (messages.some((message) => message !== "ok")) {
      throw new Error(`sqlite integrity check failed: ${messages.join("; ")}`);
    }
    return messages;
  }

  // ------------------------------------------------------------------ leases

  /**
   * Acquire (or take over) a lease in ONE transaction: only when the resource
   * is free (owner empty) or its lease expired may epoch+1 and the new
   * owner/lease_until be written. A live lease returns undefined. Rows are
   * never deleted; release clears owner/lease_until.
   */
  acquireLease(resource: string, ttlMs: number, owner: string, now = Date.now()): LeaseGrant | undefined {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT epoch, owner, lease_until FROM leases WHERE resource = ?").get(resource) as
        | { epoch: number | bigint; owner: string; lease_until: number | bigint }
        | undefined;
      if (row && Number(row.lease_until) > now) {
        this.db.exec("ROLLBACK");
        return undefined; // live lease: never stolen
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

  /** Heartbeat: extend the lease only while THIS epoch+owner still owns it.
   * changes=0 means ownership was lost — the caller must abort immediately. */
  renewLease(resource: string, epoch: number, owner: string, ttlMs: number, now = Date.now()): boolean {
    this.assertOpen();
    const result = this.db.prepare(
      "UPDATE leases SET lease_until = ? WHERE resource = ? AND epoch = ? AND owner = ?",
    ).run(now + ttlMs, resource, epoch, owner);
    return Number(result.changes) === 1;
  }

  /** Release: clears the row (never deletes it) only while THIS epoch+owner
   * still owns it; a stale owner's release changes 0 rows. */
  releaseLease(resource: string, epoch: number, owner: string): boolean {
    this.assertOpen();
    const result = this.db.prepare(
      "UPDATE leases SET owner = '', lease_until = 0 WHERE resource = ? AND epoch = ? AND owner = ?",
    ).run(resource, epoch, owner);
    return Number(result.changes) === 1;
  }

  isLeaseOwner(resource: string, epoch: number, owner: string, now = Date.now()): boolean {
    this.assertOpen();
    const row = this.db.prepare(
      "SELECT lease_until FROM leases WHERE resource = ? AND epoch = ? AND owner = ?",
    ).get(resource, epoch, owner) as { lease_until: number | bigint } | undefined;
    return !!row && Number(row.lease_until) > now;
  }

  leaseInfo(resource: string): { epoch: number; owner: string; leaseUntil: number } | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT epoch, owner, lease_until FROM leases WHERE resource = ?").get(resource) as
      | { epoch: number | bigint; owner: string; lease_until: number | bigint }
      | undefined;
    return row ? { epoch: Number(row.epoch), owner: row.owner, leaseUntil: Number(row.lease_until) } : undefined;
  }

  // ------------------------------------------------------------------ queue

  /**
   * Idempotent enqueue in ONE transaction: identical command hash returns
   * "duplicate"; a different command under the same request id is a protocol
   * error and throws. `now` and the status of an existing row are preserved.
   */
  enqueueCommand(
    requestId: string,
    commandHash: string,
    commandJson: string,
    createdAt: number,
  ): "inserted" | "duplicate" {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT command_hash FROM queue WHERE request_id = ?").get(requestId) as
        | { command_hash: string }
        | undefined;
      if (existing) {
        if (existing.command_hash !== commandHash) {
          // Roll back via the single catch below — never a manual ROLLBACK +
          // throw that would double-rollback and mask the real error.
          throw new Error(`request id ${requestId} already queued with a different command`);
        }
        this.db.exec("COMMIT");
        return "duplicate";
      }
      this.db.prepare(
        `INSERT INTO queue (request_id, command_hash, command_json, status, attempts, created_at)
         VALUES (?, ?, ?, 'inbox', 0, ?)`,
      ).run(requestId, commandHash, commandJson, createdAt);
      this.db.exec("COMMIT");
      return "inserted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Claim the next due command that THIS consumer is eligible for, in ONE
   * transaction. A single UPDATE selects the winner — and also claims rows
   * still `processing` whose claim lease EXPIRED (a crashed handler during
   * runtime, not just at startup) — always bumping claim_epoch by exactly one
   * with a new claim_owner/claim_until.
   *
   * Eligibility routing happens BEFORE any attempts/claim_epoch mutation and
   * inside the same transaction: `eligible` receives the RAW command_json of a
   * candidate and, when it returns false, the candidate is skipped (never
   * claimed, never retried, never dead-lettered) so the WRONG runtime cannot
   * steal a command. The scan continues to later eligible rows, so a queue
   * head owned by another runtime never blocks this one (no head-of-line
   * blocking). The caller performs all size/protocol/schema checks and must
   * return true for anything malformed (so it can be quarantined by any
   * runtime); an eligibility throw is also treated as "allow" by the caller so
   * a broken router can never wedge the queue.
   */
  claimNext(
    instanceId: string,
    leaseMs: number,
    eligible?: (commandJson: string) => boolean,
    now = Date.now(),
  ): QueueRow | undefined {
    this.assertOpen();
    // An idle queue is the overwhelmingly common case. Probe it read-only so
    // a polling runtime does not repeatedly acquire SQLite's single writer
    // slot and starve a CLI process that is trying to enqueue work. The
    // candidate set is rebuilt under BEGIN IMMEDIATE below before any claim,
    // so routing and ownership remain atomic when work actually exists.
    if (this.claimCandidates(now, eligible).length === 0) return undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of this.claimCandidates(now, eligible)) {
        const result = this.db.prepare(
          `UPDATE queue SET status = 'processing', claim_epoch = claim_epoch + 1, claim_owner = ?, claim_until = ?
           WHERE request_id = ? AND (status IN ('inbox', 'retry') OR (status = 'processing' AND claim_until <= ?))`,
        ).run(instanceId, now + leaseMs, candidate, now);
        if (Number(result.changes) === 1) {
          const row = this.readQueueRow(candidate);
          this.db.exec("COMMIT");
          return row;
        }
      }
      this.db.exec("COMMIT");
      return undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private claimCandidates(now: number, eligible?: (commandJson: string) => boolean): string[] {
    const retryCandidates = this.db.prepare(
      "SELECT request_id FROM queue WHERE status = 'retry' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at, request_id",
    ).all(now) as Array<{ request_id: string }>;
    const expiredProcessing = this.db.prepare(
      "SELECT request_id FROM queue WHERE status = 'processing' AND claim_until <= ? ORDER BY claim_until, request_id",
    ).all(now) as Array<{ request_id: string }>;
    const inboxCandidates = this.db.prepare(
      "SELECT request_id FROM queue WHERE status = 'inbox' ORDER BY created_at, request_id",
    ).all() as Array<{ request_id: string }>;
    const candidates = [...retryCandidates, ...expiredProcessing, ...inboxCandidates];
    if (!eligible) return candidates.map((candidate) => candidate.request_id);
    return candidates.flatMap((candidate) => {
      const probe = this.db.prepare("SELECT command_json FROM queue WHERE request_id = ?").get(candidate.request_id) as
        | { command_json: string }
        | undefined;
      return probe && eligible(probe.command_json) ? [candidate.request_id] : [];
    });
  }

  /** Fenced claim mutations: every ack/retry/dead-letter/renew requires the
   * row to be `processing` AND match the claim_epoch+claim_owner — a stale
   * owner (or a conclusive generation that wrapped) changes 0 rows. `epoch`
   * is NEVER reset: release clears owner/until only, so the next claim is
   * always the old epoch + 1. */

  ackClaim(requestId: string, claimEpoch: number, claimOwner: string, receiptJson: string): boolean {
    this.assertOpen();
    const result = this.db.prepare(
      `UPDATE queue SET status = 'done', receipt_json = ?, claim_until = 0
       WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?`,
    ).run(receiptJson, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  retryClaim(
    requestId: string,
    claimEpoch: number,
    claimOwner: string,
    error: string,
    nextAttemptAt: number,
  ): boolean {
    this.assertOpen();
    const result = this.db.prepare(
      `UPDATE queue SET status = 'retry', attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
         claim_owner = '', claim_until = 0
       WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?`,
    ).run(error, nextAttemptAt, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  deadLetterClaim(requestId: string, claimEpoch: number, claimOwner: string, error: string, now = Date.now()): boolean {
    this.assertOpen();
    const result = this.db.prepare(
      `UPDATE queue SET status = 'dead-letter', attempts = attempts + 1, last_error = ?, dead_letter_at = ?,
         claim_owner = '', claim_until = 0
       WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?`,
    ).run(error, now, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  renewClaim(requestId: string, claimEpoch: number, claimOwner: string, claimUntil: number): boolean {
    this.assertOpen();
    const result = this.db.prepare(
      "UPDATE queue SET claim_until = ? WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?",
    ).run(claimUntil, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  /** Move processing rows whose claim lease expired back to retry, in ONE
   * transaction; live claims are never touched. The epoch is preserved (not
   * reset) so a stale owner can never re-match. Returns rows moved. */
  recoverQueueOrphans(now = Date.now()): number {
    this.assertOpen();
    const result = this.db.prepare(
      `UPDATE queue SET status = 'retry', next_attempt_at = ?, claim_owner = '', claim_until = 0
       WHERE status = 'processing' AND claim_until <= ?`,
    ).run(now, now);
    return Number(result.changes);
  }

  /**
   * Quarantine a row whose command JSON cannot be parsed (never blocks the
   * queue). If the row is `processing`, the quarantine is FENCED on the
   * current claim epoch+owner so it can never touch a row a newer owner took
   * over; inbox/retry rows carry no owner fence.
   */
  quarantineRow(requestId: string, status: string, claimEpoch: number, claimOwner: string, error: string, now = Date.now()): boolean {
    this.assertOpen();
    const result = status === "processing"
      ? this.db.prepare(
        `UPDATE queue SET status = 'dead-letter', last_error = ?, dead_letter_at = ?, claim_owner = '', claim_until = 0
         WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?`,
      ).run(error, now, requestId, claimEpoch, claimOwner)
      : this.db.prepare(
        `UPDATE queue SET status = 'dead-letter', last_error = ?, dead_letter_at = ?, claim_owner = '', claim_until = 0
         WHERE request_id = ? AND status IN ('inbox', 'retry')`,
      ).run(error, now, requestId);
    return Number(result.changes) === 1;
  }

  /** Import a legacy queue row (one transaction, idempotent by request_id):
   * preserves attempts, last_error, next_attempt_at and dead_letter_at so
   * pre-SQLite retry semantics survive the migration. */
  importLegacyRow(
    requestId: string,
    commandHash: string,
    commandJson: string,
    status: string,
    attempts: number,
    lastError: string | undefined,
    nextAttemptAt: number | undefined,
    deadLetterAt: number | undefined,
    now = Date.now(),
  ): void {
    this.assertOpen();
    this.db.prepare(
      `INSERT INTO queue (request_id, command_hash, command_json, status, attempts, last_error, next_attempt_at, dead_letter_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO NOTHING`,
    ).run(requestId, commandHash, commandJson, status, attempts, lastError ?? null, nextAttemptAt ?? null, deadLetterAt ?? null, now);
  }

  /** Import a legacy receipt directly (the legacy receipts dir stores receipt
   * JSON, not an envelope with a command). Idempotent: an existing receipt
   * wins. */
  importLegacyReceipt(requestId: string, commandHash: string, receiptJson: string, now = Date.now()): void {
    this.assertOpen();
    this.db.prepare(
      `INSERT INTO queue (request_id, command_hash, command_json, status, attempts, receipt_json, created_at)
       VALUES (?, ?, '{}', 'done', 0, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET receipt_json = excluded.receipt_json WHERE queue.receipt_json IS NULL`,
    ).run(requestId, commandHash, receiptJson, now);
  }

  queueRow(requestId: string): QueueRow | undefined {
    this.assertOpen();
    const row = this.db.prepare(
      "SELECT request_id, command_hash, command_json, status, attempts, claim_epoch, claim_owner, claim_until, last_error, next_attempt_at, receipt_json, dead_letter_at, created_at FROM queue WHERE request_id = ?",
    ).get(requestId) as Record<string, unknown> | undefined;
    return row ? mapQueueRow(row) : undefined;
  }

  queueRowsByStatus(status: string): QueueRow[] {
    this.assertOpen();
    const rows = this.db.prepare(
      "SELECT request_id, command_hash, command_json, status, attempts, claim_epoch, claim_owner, claim_until, last_error, next_attempt_at, receipt_json, dead_letter_at, created_at FROM queue WHERE status = ? ORDER BY created_at, request_id",
    ).all(status) as Array<Record<string, unknown>>;
    return rows.map(mapQueueRow);
  }

  private readQueueRow(requestId: string): QueueRow {
    const row = this.queueRow(requestId);
    if (!row) throw new Error(`queue row ${requestId} vanished mid-claim`);
    return row;
  }

  // ------------------------------------------------------------ live_sessions

  /**
   * Refresh THIS owner's live sessions in one transaction: the owner's rows
   * are replaced, other owners' rows are untouched (cross-process merge), and
   * a new owner taking over the same session_id replaces the stale one.
   * `rows` = current agent list of this runtime.
   */
  refreshOwnerSessions(owner: string, rows: Array<{ sessionId: string; cwd: string }>, ttlMs: number, now = Date.now()): void {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM live_sessions WHERE runtime_owner = ?").run(owner);
      const upsert = this.db.prepare(
        `INSERT INTO live_sessions (session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET runtime_owner = excluded.runtime_owner, cwd = excluded.cwd,
           cwd_key = excluded.cwd_key, lease_until = excluded.lease_until, updated_at = excluded.updated_at`,
      );
      for (const row of rows) {
        upsert.run(row.sessionId, owner, row.cwd, cwdKey(row.cwd), now + ttlMs, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Heartbeat: extend every live session row owned by `owner`. */
  renewOwnerSessions(owner: string, ttlMs: number, now = Date.now()): number {
    this.assertOpen();
    const result = this.db.prepare(
      "UPDATE live_sessions SET lease_until = ?, updated_at = ? WHERE runtime_owner = ?",
    ).run(now + ttlMs, now, owner);
    return Number(result.changes);
  }

  /** Release every session of `owner` (graceful stop). */
  releaseOwnerSessions(owner: string): number {
    this.assertOpen();
    const result = this.db.prepare("DELETE FROM live_sessions WHERE runtime_owner = ?").run(owner);
    return Number(result.changes);
  }

  /** Read-only: this owner's still-live sessions. */
  sessionsForOwner(owner: string, now = Date.now()): LiveSessionRow[] {
    this.assertOpen();
    return this.db.prepare(
      "SELECT session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at FROM live_sessions WHERE runtime_owner = ? AND lease_until > ?",
    ).all(owner, now).map(mapSessionRow);
  }

  /** Read-only: live sessions matching a normalized cwd. */
  liveSessionsForCwd(cwdKeyValue: string, now = Date.now()): LiveSessionRow[] {
    this.assertOpen();
    return this.db.prepare(
      "SELECT session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at FROM live_sessions WHERE cwd_key = ? AND lease_until > ?",
    ).all(cwdKeyValue, now).map(mapSessionRow);
  }

  /** Read-only: every live session (for the CLI). */
  listLiveSessions(now = Date.now()): LiveSessionRow[] {
    this.assertOpen();
    return this.db.prepare(
      "SELECT session_id, runtime_owner, cwd, cwd_key, lease_until, updated_at FROM live_sessions WHERE lease_until > ? ORDER BY session_id",
    ).all(now).map(mapSessionRow);
  }

  /** Read-only: the DSH session owning a workflow (from its record). */
  workflowSessionOf(workflowId: string): string | undefined {
    const row = this.loadWorkflow(workflowId);
    if (!row) return undefined;
    try {
      const record = JSON.parse(row.recordJson) as { dshSessionId?: string };
      return typeof record.dshSessionId === "string" ? record.dshSessionId : undefined;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------ ops: requeue

  /**
   * Ops requeue: bring a request back to 'retry' so a runtime picks it up
   * again. IDEMPOTENT: already-inbox/retry returns { changed: false } (no-op
   * success). Only 'dead-letter'/'failed' rows are re-enqueued. Processing
   * (a claim could be followed by side effects from the waiter), done (final
   * receipt), cancelled (terminal) and inbox (already queued) are never moved
   * backwards — a replayed or conflicting identity cannot resurrect a finished
   * exchange. attempts stay as an audit trail; next_attempt_at is set to now.
   */
  requeueRequest(requestId: string, now = Date.now()): { changed: boolean; from?: string } {
    this.assertOpen();
    const row = this.queueRow(requestId);
    if (!row) return { changed: false };
    if (row.status === "inbox" || row.status === "retry") return { changed: false, from: row.status };
    if (row.status === "dead-letter" || row.status === "failed") {
      const result = this.db.prepare(
        `UPDATE queue SET status = 'retry', next_attempt_at = ?, dead_letter_at = NULL, claim_owner = '', claim_until = 0
         WHERE request_id = ? AND status IN ('dead-letter', 'failed')`,
      ).run(now, requestId);
      if (Number(result.changes) === 1) return { changed: true, from: row.status };
      return { changed: false, from: row.status };
    }
    throw new Error(`cannot requeue request in status ${row.status}`);
  }

  // --------------------------------------------------------------- ops: prune

  /**
   * Safe prune candidates. Only TERMINAL evidence older than `olderThanMs` is
   * eligible — never anything live:
   *   - queue rows with a FINAL receipt (status done/cancelled with a stored
   *     receipt) older than the retention window (age by deliveredAt in the
   *     receipt, never by the original enqueue time);
   *   - workflow records in a terminal phase (passed/cancelled) older than the
   *     retention window (age by updated_at), whose submission is no longer
   *     active.
   * Failed/blocked workflows (diagnostics) and never-delivered verdicts are
   * NEVER candidates. Returns request/workflow id lists so the CLI can preview
   * (dry-run) before applying.
   */
  pruneCandidates(olderThanMs: number, now = Date.now()): {
    requests: PruneRequestCandidate[];
    workflows: PruneWorkflowCandidate[];
  } {
    this.assertOpen();
    const cutoff = now - olderThanMs;
    const requestRows = this.db.prepare(
      `SELECT request_id, status, receipt_json FROM queue
       WHERE status IN ('done', 'cancelled') AND receipt_json IS NOT NULL ORDER BY created_at`,
    ).all() as Array<{ request_id: string; status: string; receipt_json: string }>;
    const requests: PruneRequestCandidate[] = [];
    for (const row of requestRows) {
      const terminalAt = receiptDeliveredAt(row.receipt_json);
      if (terminalAt === undefined || terminalAt > cutoff) continue;
      requests.push({ requestId: String(row.request_id), status: String(row.status), terminalAt });
    }
    const workflowRows = this.db.prepare(
      "SELECT id, revision, record_json, updated_at FROM workflows WHERE updated_at <= ? ORDER BY updated_at",
    ).all(cutoff) as Array<{ id: string; revision: number; record_json: string; updated_at: number }>;
    const workflows: PruneWorkflowCandidate[] = [];
    for (const row of workflowRows) {
      let phase = "";
      let submissionActive = false;
      try {
        const record = JSON.parse(row.record_json) as {
          phase?: string;
          submissionState?: string;
          submissionActive?: boolean;
        };
        phase = record.phase ?? "";
        submissionActive = record.submissionState === "queued"
          || record.submissionState === "sending"
          || record.submissionState === "retrying"
          || record.submissionState === "verdict_ready"
          || record.submissionState === "received"
          || record.submissionState === "applied";
      } catch {
        continue;
      }
      if (submissionActive) continue;
      if (phase !== "passed" && phase !== "cancelled") continue; // keep failed/blocked diagnostics
      workflows.push({ id: String(row.id), phase, revision: Number(row.revision), updatedAt: Number(row.updated_at) });
    }
    return { requests, workflows };
  }

  /** Apply preview tokens after re-validating every mutable field inside one
   * write transaction. A row changed after preview is skipped, never deleted. */
  pruneApply(
    requests: PruneRequestCandidate[],
    workflows: PruneWorkflowCandidate[],
    olderThanMs: number,
    now = Date.now(),
  ): { removedRequests: number; removedWorkflows: number } {
    this.assertOpen();
    const cutoff = now - olderThanMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let removedRequests = 0;
      const loadRequest = this.db.prepare("SELECT status, receipt_json FROM queue WHERE request_id = ?");
      const deleteRequest = this.db.prepare("DELETE FROM queue WHERE request_id = ? AND status = ? AND receipt_json = ?");
      for (const candidate of requests) {
        const row = loadRequest.get(candidate.requestId) as { status: string; receipt_json: string | null } | undefined;
        if (!row || row.status !== candidate.status || (row.status !== "done" && row.status !== "cancelled") || !row.receipt_json) continue;
        const terminalAt = receiptDeliveredAt(row.receipt_json);
        if (terminalAt === undefined || terminalAt !== candidate.terminalAt || terminalAt > cutoff) continue;
        removedRequests += Number(deleteRequest.run(candidate.requestId, row.status, row.receipt_json).changes);
      }
      let removedWorkflows = 0;
      const loadWorkflow = this.db.prepare("SELECT revision, record_json, updated_at FROM workflows WHERE id = ?");
      const deleteWorkflow = this.db.prepare("DELETE FROM workflows WHERE id = ? AND revision = ? AND updated_at = ?");
      for (const candidate of workflows) {
        const row = loadWorkflow.get(candidate.id) as { revision: number; record_json: string; updated_at: number } | undefined;
        if (!row || Number(row.revision) !== candidate.revision || Number(row.updated_at) !== candidate.updatedAt || Number(row.updated_at) > cutoff) continue;
        const state = workflowPruneState(row.record_json);
        if (!state || state.phase !== candidate.phase || state.submissionActive) continue;
        if (state.phase !== "passed" && state.phase !== "cancelled") continue;
        removedWorkflows += Number(deleteWorkflow.run(candidate.id, candidate.revision, candidate.updatedAt).changes);
      }
      this.db.exec("COMMIT");
      return { removedRequests, removedWorkflows };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // -------------------------------------------------------------- workflows

  loadWorkflow(id: string): WorkflowRow | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT id, revision, record_json, updated_at FROM workflows WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? { id: String(row.id), revision: Number(row.revision), recordJson: String(row.record_json), updatedAt: Number(row.updated_at) } : undefined;
  }

  listWorkflows(): WorkflowRow[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT id, revision, record_json, updated_at FROM workflows ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), revision: Number(row.revision), recordJson: String(row.record_json), updatedAt: Number(row.updated_at) }));
  }

  saveWorkflow(id: string, recordJson: string, now = Date.now()): void {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT revision FROM workflows WHERE id = ?").get(id) as
        | { revision: number | bigint }
        | undefined;
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

  /**
   * Synchronous conditional revision CAS. The transaction opens, verifies the
   * row still carries `expectedRevision`, runs the (SYNCHRONOUS) mutation and
   * commits — all within one call stack, so no await ever holds the write
   * lock and no other asynchronous caller can join an open transaction on the
   * same connection. Async work (evidence, file I/O) MUST happen before this
   * call; a lost CAS returns `retry` so the caller re-loads and re-computes.
   *
   * The mutation input carries the DB row's authoritative `revision` (the
   * JSON inside record_json must never be trusted for it). `mutate` may
   * return `recordJson: undefined` for a no-op commit (e.g. idempotent
   * replay) that does NOT bump the revision. The committed/suppressed return
   * always carries the exact revision of the row as it stands.
   */
  compareAndUpdateWorkflow<T>(
    id: string,
    expectedRevision: number,
    mutate: (input: { raw: unknown; revision: number }) => { result: T; recordJson?: string },
    opts: { ignoreCancelled?: boolean },
  ): { kind: "committed" | "suppressed" | "retry"; result?: T; revision: number; recordJson: string } {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT revision, record_json FROM workflows WHERE id = ?").get(id) as
        | { revision: number | bigint; record_json: string }
        | undefined;
      if (!existing) {
        this.db.exec("ROLLBACK");
        throw new Error(`unknown workflow ${id}`);
      }
      const loadedRevision = Number(existing.revision);
      const raw = JSON.parse(existing.record_json) as unknown;
      if (!opts.ignoreCancelled && (raw as { phase?: string }).phase === "cancelled") {
        this.db.exec("ROLLBACK");
        return { kind: "suppressed", revision: loadedRevision, recordJson: existing.record_json };
      }
      if (loadedRevision !== expectedRevision) {
        // Lost the CAS race: roll back; the caller re-loads and re-computes.
        this.db.exec("ROLLBACK");
        return { kind: "retry", revision: loadedRevision, recordJson: existing.record_json };
      }
      const outcome = mutate({ raw, revision: loadedRevision });
      if (outcome.recordJson === undefined) {
        // No-op commit: the row is unchanged (same revision), untouched.
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

function receiptDeliveredAt(receiptJson: string): number | undefined {
  try {
    const receipt = JSON.parse(receiptJson) as { deliveredAt?: unknown };
    if (typeof receipt.deliveredAt !== "string") return undefined;
    const parsed = Date.parse(receipt.deliveredAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function workflowPruneState(recordJson: string): { phase: string; submissionActive: boolean } | undefined {
  try {
    const record = JSON.parse(recordJson) as { phase?: string; submissionState?: string };
    return {
      phase: record.phase ?? "",
      submissionActive: record.submissionState === "queued"
        || record.submissionState === "sending"
        || record.submissionState === "retrying"
        || record.submissionState === "verdict_ready"
        || record.submissionState === "received"
        || record.submissionState === "applied",
    };
  } catch {
    return undefined;
  }
}

function mapQueueRow(row: Record<string, unknown>): QueueRow {
  const result: QueueRow = {
    requestId: String(row.request_id),
    commandHash: String(row.command_hash),
    commandJson: String(row.command_json),
    status: String(row.status),
    attempts: Number(row.attempts),
    claimEpoch: Number(row.claim_epoch),
    claimOwner: String(row.claim_owner),
    claimUntil: Number(row.claim_until),
    createdAt: Number(row.created_at ?? 0),
  };
  if (row.last_error !== null && row.last_error !== undefined) result.lastError = String(row.last_error);
  if (row.next_attempt_at !== null && row.next_attempt_at !== undefined) result.nextAttemptAt = Number(row.next_attempt_at);
  if (row.receipt_json !== null && row.receipt_json !== undefined) result.receiptJson = String(row.receipt_json);
  if (row.dead_letter_at !== null && row.dead_letter_at !== undefined) result.deadLetterAt = Number(row.dead_letter_at);
  return result;
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

/** Database file location for a storage directory (shared by all stores). */
export function coordinationPath(directory: string): string {
  return join(directory, "coord.sqlite");
}

/** Windows/case/separator-insensitive key for a workspace path. */
export function cwdKey(path: string): string {
  return resolve(path).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

/** One live DSH session as registered by its owning runtime. */
export interface LiveSessionRow {
  sessionId: string;
  runtimeOwner: string;
  cwd: string;
  cwdKey: string;
  leaseUntil: number;
  updatedAt: number;
}

import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve } from "node:path";
import { parseWorkflowJson } from "./state/workflow-schema.js";
import { CoordinationDatabase } from "./infrastructure/coordination-database.js";
import { LeaseRepositorySql, LiveSessionRepositorySql } from "./infrastructure/coordination-repositories.js";
import { QueueRepositorySql } from "./infrastructure/queue-repository.js";

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
  private readonly database: CoordinationDatabase;
  private readonly leases: LeaseRepositorySql;
  private readonly liveSessions: LiveSessionRepositorySql;
  private readonly queue: QueueRepositorySql;
  private closed = false;

  constructor(readonly path: string, options: CoordinationOptions = {}) {
    this.database = new CoordinationDatabase(path, options, SCHEMA);
    this.db = this.database.db;
    this.leases = new LeaseRepositorySql(this.db);
    this.liveSessions = new LiveSessionRepositorySql(this.db);
    this.queue = new QueueRepositorySql(this.db);
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
    return this.database.sqliteVersion();
  }

  /** Current journal mode (must be "delete" — we never use WAL). */
  journalMode(): string {
    this.assertOpen();
    return this.database.journalMode();
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
      this.database.close();
    } catch {
      // already closed
    }
  }

  /** `PRAGMA integrity_check`; throws unless every row reports "ok". */
  integrityCheck(): string[] {
    this.assertOpen();
    return this.database.integrityCheck();
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
    return this.leases.acquireLease(resource, ttlMs, owner, now);
  }

  /** Heartbeat: extend the lease only while THIS epoch+owner still owns it.
   * changes=0 means ownership was lost — the caller must abort immediately. */
  renewLease(resource: string, epoch: number, owner: string, ttlMs: number, now = Date.now()): boolean {
    this.assertOpen();
    return this.leases.renewLease(resource, epoch, owner, ttlMs, now);
  }

  /** Release: clears the row (never deletes it) only while THIS epoch+owner
   * still owns it; a stale owner's release changes 0 rows. */
  releaseLease(resource: string, epoch: number, owner: string): boolean {
    this.assertOpen();
    return this.leases.releaseLease(resource, epoch, owner);
  }

  isLeaseOwner(resource: string, epoch: number, owner: string, now = Date.now()): boolean {
    this.assertOpen();
    return this.leases.isLeaseOwner(resource, epoch, owner, now);
  }

  leaseInfo(resource: string): { epoch: number; owner: string; leaseUntil: number } | undefined {
    this.assertOpen();
    return this.leases.leaseInfo(resource);
  }

  // ------------------------------------------------------------------ queue

  enqueueCommand(requestId: string, commandHash: string, commandJson: string, createdAt: number): "inserted" | "duplicate" {
    this.assertOpen();
    return this.queue.enqueueCommand(requestId, commandHash, commandJson, createdAt);
  }

  claimNext(instanceId: string, leaseMs: number, eligible?: (commandJson: string) => boolean, now = Date.now()): QueueRow | undefined {
    this.assertOpen();
    return this.queue.claimNext(instanceId, leaseMs, eligible, now);
  }

  ackClaim(requestId: string, claimEpoch: number, claimOwner: string, receiptJson: string): boolean {
    this.assertOpen();
    return this.queue.ackClaim(requestId, claimEpoch, claimOwner, receiptJson);
  }

  retryClaim(requestId: string, claimEpoch: number, claimOwner: string, error: string, nextAttemptAt: number): boolean {
    this.assertOpen();
    return this.queue.retryClaim(requestId, claimEpoch, claimOwner, error, nextAttemptAt);
  }

  deadLetterClaim(requestId: string, claimEpoch: number, claimOwner: string, error: string, now = Date.now()): boolean {
    this.assertOpen();
    return this.queue.deadLetterClaim(requestId, claimEpoch, claimOwner, error, now);
  }

  renewClaim(requestId: string, claimEpoch: number, claimOwner: string, claimUntil: number): boolean {
    this.assertOpen();
    return this.queue.renewClaim(requestId, claimEpoch, claimOwner, claimUntil);
  }

  recoverQueueOrphans(now = Date.now()): number {
    this.assertOpen();
    return this.queue.recoverQueueOrphans(now);
  }

  quarantineRow(requestId: string, status: string, claimEpoch: number, claimOwner: string, error: string, now = Date.now()): boolean {
    this.assertOpen();
    return this.queue.quarantineRow(requestId, status, claimEpoch, claimOwner, error, now);
  }

  importLegacyRow(requestId: string, commandHash: string, commandJson: string, status: string, attempts: number, lastError: string | undefined, nextAttemptAt: number | undefined, deadLetterAt: number | undefined, now = Date.now()): void {
    this.assertOpen();
    this.queue.importLegacyRow(requestId, commandHash, commandJson, status, attempts, lastError, nextAttemptAt, deadLetterAt, now);
  }

  importLegacyReceipt(requestId: string, commandHash: string, receiptJson: string, now = Date.now()): void {
    this.assertOpen();
    this.queue.importLegacyReceipt(requestId, commandHash, receiptJson, now);
  }

  queueRow(requestId: string): QueueRow | undefined {
    this.assertOpen();
    return this.queue.queueRow(requestId);
  }

  queueRowsByStatus(status: string): QueueRow[] {
    this.assertOpen();
    return this.queue.queueRowsByStatus(status);
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
    this.liveSessions.refreshOwnerSessions(owner, rows, ttlMs, now);
  }

  /** Heartbeat: extend every live session row owned by `owner`. */
  renewOwnerSessions(owner: string, ttlMs: number, now = Date.now()): number {
    this.assertOpen();
    return this.liveSessions.renewOwnerSessions(owner, ttlMs, now);
  }

  /** Release every session of `owner` (graceful stop). */
  releaseOwnerSessions(owner: string): number {
    this.assertOpen();
    return this.liveSessions.releaseOwnerSessions(owner);
  }

  /** Read-only: this owner's still-live sessions. */
  sessionsForOwner(owner: string, now = Date.now()): LiveSessionRow[] {
    this.assertOpen();
    return this.liveSessions.sessionsForOwner(owner, now);
  }

  /** Read-only: live sessions matching a normalized cwd. */
  liveSessionsForCwd(cwdKeyValue: string, now = Date.now()): LiveSessionRow[] {
    this.assertOpen();
    return this.liveSessions.liveSessionsForCwd(cwdKeyValue, now);
  }

  /** Read-only: every live session (for the CLI). */
  listLiveSessions(now = Date.now()): LiveSessionRow[] {
    this.assertOpen();
    return this.liveSessions.listLiveSessions(now);
  }

  /** Read-only: the DSH session owning a workflow (from its record). */
  workflowSessionOf(workflowId: string): string | undefined {
    const row = this.loadWorkflow(workflowId);
    if (!row) return undefined;
    try {
      const record = parseWorkflowJson(row.recordJson) as { dshSessionId?: string };
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
        const record = parseWorkflowJson(row.record_json) as {
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
      const raw = parseWorkflowJson(existing.record_json);
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
    const record = parseWorkflowJson(recordJson) as { phase?: string; submissionState?: string };
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

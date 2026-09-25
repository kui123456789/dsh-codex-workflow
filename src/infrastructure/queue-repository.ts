import type { DatabaseSync } from "node:sqlite";
import type { QueueRow } from "../coordination.js";

/** Concrete SQLite queue repository. CoordinationStore supplies lifecycle
 * gates; this class owns queue SQL and claim fencing. */
export class QueueRepositorySql {
  constructor(private readonly db: DatabaseSync) {}
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
        const result = this.db.prepare(
      `UPDATE queue SET status = 'retry', attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
         claim_owner = '', claim_until = 0
       WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?`,
    ).run(error, nextAttemptAt, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  deadLetterClaim(requestId: string, claimEpoch: number, claimOwner: string, error: string, now = Date.now()): boolean {
        const result = this.db.prepare(
      `UPDATE queue SET status = 'dead-letter', attempts = attempts + 1, last_error = ?, dead_letter_at = ?,
         claim_owner = '', claim_until = 0
       WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?`,
    ).run(error, now, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  renewClaim(requestId: string, claimEpoch: number, claimOwner: string, claimUntil: number): boolean {
        const result = this.db.prepare(
      "UPDATE queue SET claim_until = ? WHERE request_id = ? AND status = 'processing' AND claim_epoch = ? AND claim_owner = ?",
    ).run(claimUntil, requestId, claimEpoch, claimOwner);
    return Number(result.changes) === 1;
  }

  /** Move processing rows whose claim lease expired back to retry, in ONE
   * transaction; live claims are never touched. The epoch is preserved (not
   * reset) so a stale owner can never re-match. Returns rows moved. */
  recoverQueueOrphans(now = Date.now()): number {
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
        this.db.prepare(
      `INSERT INTO queue (request_id, command_hash, command_json, status, attempts, receipt_json, created_at)
       VALUES (?, ?, '{}', 'done', 0, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET receipt_json = excluded.receipt_json WHERE queue.receipt_json IS NULL`,
    ).run(requestId, commandHash, receiptJson, now);
  }

  queueRow(requestId: string): QueueRow | undefined {
        const row = this.db.prepare(
      "SELECT request_id, command_hash, command_json, status, attempts, claim_epoch, claim_owner, claim_until, last_error, next_attempt_at, receipt_json, dead_letter_at, created_at FROM queue WHERE request_id = ?",
    ).get(requestId) as Record<string, unknown> | undefined;
    return row ? mapQueueRow(row) : undefined;
  }

  queueRowsByStatus(status: string): QueueRow[] {
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
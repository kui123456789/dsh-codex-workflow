import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  isPlainObject,
  parseBridgeCommand,
  type BridgeCommand,
} from "./bridge-protocol.js";
import {
  CoordinationStore,
  coordinationPath,
  type PruneRequestCandidate,
  type PruneWorkflowCandidate,
} from "./coordination.js";
import { LegacyQueueImporter } from "./infrastructure/legacy-queue-import.js";

export const BRIDGE_QUEUE_DIRS = ["inbox", "processing", "retry", "receipts", "dead-letter"] as const;
export type BridgeQueueDir = (typeof BRIDGE_QUEUE_DIRS)[number];

export interface BridgeReceipt {
  requestId: string;
  status: "delivered" | "duplicate" | "no_such_workflow" | "cancelled" | "failed" | "rejected";
  workflowId?: string;
  deliveredAt?: string;
  error?: string;
  /** SHA-256 of the canonical command JSON, recorded so a later enqueue with
   * the same request id but different payload is rejected, never silently
   * treated as idempotent. */
  commandHash?: string;
}

export interface ClaimedBridgeCommand {
  requestId: string;
  instanceId: string;
  command: BridgeCommand;
  attempts: number;
  lastError?: string;
  /** Fencing identity of the claim: every mutation (ack/retry/dead-letter/
   * renew) is a conditional UPDATE on claim_epoch + claim_owner, so an old
   * owner can never complete or release a claim that was taken over. */
  claimEpoch: number;
  claimOwner: string;
  claimUntil: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical identity of a command: stable across identical payloads, distinct
 * across different ones. */
export function commandHash(command: BridgeCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

/**
 * SQLite-backed bridge queue. Every claim, ack, retry, dead-letter, renewal
 * and orphan recovery is a single atomic transaction with epoch/owner
 * fencing, so two overlapping DSH processes can never claim the same command
 * twice, and a stale owner's ack/retry/dead-letter can never affect the new
 * owner's claim. Legacy file-queue data from earlier versions is imported
 * once on init.
 */
export class BridgeStore {
  private coordination?: CoordinationStore;
  private readonly legacyImporter = new LegacyQueueImporter();
  private closed = false;

  /** `directory` is the plugin storage directory; the coordination database
   * lives at `<directory>/coord.sqlite` (shared with the workflow store). */
  constructor(
    readonly directory: string,
    readonly maxPayloadBytes: number = BRIDGE_MAX_PAYLOAD_BYTES,
    /** Claim lease lifetime; a heartbeat renews live claims so only crashed
     * owners are taken over. */
    readonly leaseMs: number = 60_000,
  ) {}

  get coordinationHandle(): CoordinationStore {
    return this.ensure();
  }

  close(): void {
    this.closed = true;
    this.coordination?.close();
    this.coordination = undefined;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private ensure(): CoordinationStore {
    if (this.closed) throw new Error("bridge store is closed");
    if (!this.coordination) {
      this.coordination = new CoordinationStore(coordinationPath(this.directory));
    }
    return this.coordination;
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.ensure();
    await this.legacyImporter.import(this.directory, this.coordination!, commandHash);
  }

  private assertRequestId(requestId: string): string {
    if (!UUID_RE.test(requestId)) throw new Error(`invalid bridge request id: ${requestId}`);
    return requestId;
  }

  /**
   * Idempotently enqueue a validated command. A request id that already
   * exists is only a no-op when the command hash matches; the same id with a
   * DIFFERENT payload is a protocol error and is rejected, never silently
   * treated as idempotent.
   */
  async enqueue(command: BridgeCommand): Promise<string> {
    await this.init();
    const requestId = this.assertRequestId(command.requestId);
    const hash = commandHash(command);
    this.coordination!.enqueueCommand(requestId, hash, JSON.stringify(command), Date.now());
    return requestId;
  }

  /**
   * Claim the next due command (due retries first, then inbox by arrival
   * order). `eligible` is an ownership router: a well-formed command that it
   * rejects is never claimed (see CoordinationStore.claimNext) so a WRONG
   * runtime cannot steal it; the scan continues past it. The claim flips the
   * row to processing with a NEW claim_epoch and this instance as claim_owner
   * inside one transaction; a row whose previous claim expired is taken over
   * by the same epoch bump. Rows whose command JSON is malformed are
   * quarantined instead of blocking the queue.
   */
  async claimNext(instanceId: string, eligible?: (command: BridgeCommand) => boolean): Promise<ClaimedBridgeCommand | undefined> {
    await this.init();
    const routed = eligible
      ? (json: string): boolean => {
        // Oversized / malformed / non-protocol commands are allowed for ANY
        // runtime to claim, so they get quarantined by the wrapper below
        // instead of wedging the queue behind a typed router.
        if (Buffer.byteLength(json, "utf8") > this.maxPayloadBytes) return true;
        let command: BridgeCommand;
        try {
          command = parseBridgeCommand(JSON.parse(json));
        } catch {
          return true;
        }
        try {
          return eligible(command);
        } catch {
          return true; // a broken router must never block the queue
        }
      }
      : undefined;
    for (;;) {
      const row = this.coordination!.claimNext(instanceId, this.leaseMs, routed);
      if (!row) return undefined;
      try {
        return this.wrapClaim(row, instanceId);
      } catch (error) {
        // Malformed command JSON: quarantine (fenced on the current claim when
        // processing) and keep scanning — never blocks the queue.
        this.coordination!.quarantineRow(
          row.requestId,
          row.status,
          row.claimEpoch,
          row.claimOwner,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Fenced ack: only the current claim owner can complete the claim and
   * write the receipt; a stale owner's ack returns false and writes nothing. */
  async ack(claim: ClaimedBridgeCommand, result: BridgeReceipt): Promise<boolean> {
    await this.init();
    const receipt: BridgeReceipt = {
      requestId: claim.requestId,
      status: result.status,
      commandHash: result.commandHash ?? commandHash(claim.command),
      ...(result.workflowId ? { workflowId: result.workflowId } : {}),
      deliveredAt: result.deliveredAt ?? new Date().toISOString(),
      ...(result.error ? { error: result.error } : {}),
    };
    return this.coordination!.ackClaim(
      claim.requestId,
      claim.claimEpoch,
      claim.claimOwner,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }

  /** Fenced retry: only the current claim owner may park the claim in retry
   * with the next attempt time. */
  async retry(claim: ClaimedBridgeCommand, error: string, nextAttemptAt: string): Promise<boolean> {
    await this.init();
    const next = Date.parse(nextAttemptAt);
    if (!Number.isFinite(next)) throw new Error("invalid bridge retry deadline");
    return this.coordination!.retryClaim(
      claim.requestId,
      claim.claimEpoch,
      claim.claimOwner,
      error,
      next,
    );
  }

  /** Fenced dead letter: only the current claim owner may record the terminal
   * failure. */
  async deadLetter(claim: ClaimedBridgeCommand, error: string): Promise<boolean> {
    await this.init();
    return this.coordination!.deadLetterClaim(claim.requestId, claim.claimEpoch, claim.claimOwner, error);
  }

  /** Heartbeat: extend the claim lease while this owner still holds it.
   * Returns false once ownership was taken over. */
  async renewClaim(claim: ClaimedBridgeCommand): Promise<boolean> {
    return this.coordination!.renewClaim(claim.requestId, claim.claimEpoch, claim.claimOwner, Date.now() + this.leaseMs);
  }

  async receipt(requestId: string): Promise<BridgeReceipt | undefined> {
    await this.init();
    this.assertRequestId(requestId);
    const row = this.coordination!.queueRow(requestId);
    if (!row?.receiptJson) return undefined;
    return JSON.parse(row.receiptJson) as BridgeReceipt;
  }

  /** Move processing rows whose claim lease expired back to retry in one
   * transaction; live claims are never touched. Returns rows moved. */
  async recoverOrphans(): Promise<number> {
    await this.init();
    return this.coordination!.recoverQueueOrphans();
  }

  /** Test/ops aid: list rows in one queue status. */
  async rowsByStatus(status: string): Promise<Array<{ requestId: string; attempts: number; lastError?: string }>> {
    await this.init();
    return this.coordination!.queueRowsByStatus(status).map((row) => ({
      requestId: row.requestId,
      attempts: row.attempts,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    }));
  }

  /** Ops: requeue a dead-letter/failed request (idempotent; see
   * CoordinationStore.requeueRequest). */
  async requeue(requestId: string): Promise<{ changed: boolean; from?: string }> {
    await this.init();
    this.assertRequestId(requestId);
    return this.coordination!.requeueRequest(requestId);
  }

  /** Ops: preview safe-prune candidates (terminal rows/workflows older than
   * `olderThanMs`; active/undelivered/diagnostic data is never a candidate). */
  async pruneCandidates(olderThanMs: number): Promise<{
    requests: PruneRequestCandidate[];
    workflows: PruneWorkflowCandidate[];
  }> {
    await this.init();
    return this.coordination!.pruneCandidates(olderThanMs);
  }

  /** Ops: revalidate and delete exactly the previewed candidates. */
  async pruneApply(
    requests: PruneRequestCandidate[],
    workflows: PruneWorkflowCandidate[],
    olderThanMs: number,
  ): Promise<{ removedRequests: number; removedWorkflows: number }> {
    await this.init();
    return this.coordination!.pruneApply(requests, workflows, olderThanMs);
  }

  // ------------------------------------------------------------ internals

  private wrapClaim(row: ReturnType<CoordinationStore["claimNext"]>, instanceId: string): ClaimedBridgeCommand {
    if (!row) throw new Error("claim vanished");
    const command = parseBridgeCommand(JSON.parse(row.commandJson));
    if (Buffer.byteLength(row.commandJson, "utf8") > this.maxPayloadBytes) {
      throw new Error(`bridge payload exceeds ${this.maxPayloadBytes} bytes`);
    }
    return {
      requestId: row.requestId,
      instanceId,
      command,
      attempts: row.attempts,
      claimEpoch: row.claimEpoch,
      claimOwner: row.claimOwner,
      claimUntil: row.claimUntil,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  }

}

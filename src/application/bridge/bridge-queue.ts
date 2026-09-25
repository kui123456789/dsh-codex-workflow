import type { BridgeStore, ClaimedBridgeCommand, BridgeReceipt } from "../../bridge-store.js";
import type { BridgeCommand } from "../../bridge-protocol.js";

/** Narrow queue contract consumed by BridgeRuntime. */
export interface BridgeQueuePort {
  readonly leaseMs: number;
  recoverOrphans(): Promise<number>;
  claimNext(owner: string, eligible?: (command: BridgeCommand) => boolean): Promise<ClaimedBridgeCommand | undefined>;
  ack(claim: ClaimedBridgeCommand, result: BridgeReceipt): Promise<boolean>;
  retry(claim: ClaimedBridgeCommand, error: string, nextAttemptAt: string): Promise<boolean>;
  deadLetter(claim: ClaimedBridgeCommand, error: string): Promise<boolean>;
  renewClaim(claim: ClaimedBridgeCommand): Promise<boolean>;
}

/** Application adapter that keeps file/SQLite queue details out of the pump. */
export class BridgeQueueCoordinator implements BridgeQueuePort {
  constructor(private readonly store: BridgeStore) {}
  get leaseMs(): number { return this.store.leaseMs; }
  recoverOrphans(): Promise<number> { return this.store.recoverOrphans(); }
  claimNext(owner: string, eligible?: (command: BridgeCommand) => boolean): Promise<ClaimedBridgeCommand | undefined> { return this.store.claimNext(owner, eligible); }
  ack(claim: ClaimedBridgeCommand, result: BridgeReceipt): Promise<boolean> { return this.store.ack(claim, result); }
  retry(claim: ClaimedBridgeCommand, error: string, nextAttemptAt: string): Promise<boolean> { return this.store.retry(claim, error, nextAttemptAt); }
  deadLetter(claim: ClaimedBridgeCommand, error: string): Promise<boolean> { return this.store.deadLetter(claim, error); }
  renewClaim(claim: ClaimedBridgeCommand): Promise<boolean> { return this.store.renewClaim(claim); }
}

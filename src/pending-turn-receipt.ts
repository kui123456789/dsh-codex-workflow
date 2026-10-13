import type { AppServerLiveEvent } from "./app-server.js";
import type { ProcessTreeEvidence } from "./infrastructure/process-transport.js";
import type { TurnWaitResult } from "./types.js";

/** The original submitted model call, without inventing its unknown turn id. */
export interface PendingTurnReceiptOperation {
  readonly sourceThreadId: string;
  readonly sourceThreadOwner?: object;
  status(): "pending" | "ready" | "invalid" | "unavailable";
  finished(): boolean;
  evidence(): Promise<ProcessTreeEvidence>;
  resume(callbacks: {
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
    onProgress?: (entry: AppServerLiveEvent) => void;
  }, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
  cleanup(signal?: AbortSignal): Promise<boolean>;
}

/** Only the caller stopped waiting; the original start reply is still owned. */
export class CodexTurnReceiptPendingError extends Error {
  declare readonly operation: PendingTurnReceiptOperation;

  constructor(original: Error, operation: PendingTurnReceiptOperation) {
    super(`Codex model start receipt unconfirmed: ${original.message}`, { cause: original });
    this.name = "CodexTurnReceiptPendingError";
    Object.defineProperty(this, "operation", { value: operation });
  }
}

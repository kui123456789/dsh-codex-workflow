import type { ProcessInstanceIdentity } from "./types.js";

/** The waiter ended, but the original server turn is not confirmed stopped. */
export class CodexTurnInterruptionError extends Error {
  declare readonly threadId: string;
  declare readonly turnId: string;
  declare readonly originalProcessId?: number;
  declare readonly originalProcessIds?: readonly number[];
  declare readonly originalProcessIdentities?: readonly ProcessInstanceIdentity[];
  declare readonly originalThreadOwner?: object;
  readonly interruptionConfirmed = false;
  readonly cleanupOnly: boolean;

  constructor(original: Error, threadId: string, turnId: string, originalProcessId?: number, originalProcessIds?: readonly number[], cleanupOnly = false, originalThreadOwner?: object, originalProcessIdentities?: readonly ProcessInstanceIdentity[]) {
    super(`Codex turn interruption unconfirmed: ${original.message}`, { cause: original });
    this.name = "CodexTurnInterruptionError";
    this.cleanupOnly = cleanupOnly;
    // Original handles belong to the current process, not serialized errors.
    Object.defineProperties(this, {
      threadId: { value: threadId }, turnId: { value: turnId },
      originalProcessId: { value: originalProcessId },
      originalProcessIds: { value: originalProcessIds && Object.freeze([...originalProcessIds]) },
      originalProcessIdentities: { value: originalProcessIdentities && Object.freeze(originalProcessIdentities.map((identity) => Object.freeze({ ...identity }))) },
      originalThreadOwner: { value: originalThreadOwner },
    });
  }
}

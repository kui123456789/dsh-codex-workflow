import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { CoordinationStore } from "../coordination.js";
import type { BridgeReceipt } from "../bridge-store.js";
import { isPlainObject, parseBridgeCommand, type BridgeCommand } from "../bridge-protocol.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Imports the pre-SQLite file queue exactly once per BridgeStore instance. */
export class LegacyQueueImporter {
  private imported = false;
  private importPromise?: Promise<void>;

  async import(directory: string, coordination: CoordinationStore, commandHash: (command: BridgeCommand) => string): Promise<void> {
    if (this.imported) return;
    if (this.importPromise) return this.importPromise;
    const task = this.performImport(directory, coordination, commandHash);
    this.importPromise = task;
    try {
      await task;
      this.imported = true;
    } finally {
      if (this.importPromise === task) this.importPromise = undefined;
    }
  }

  private async performImport(directory: string, coordination: CoordinationStore, commandHash: (command: BridgeCommand) => string): Promise<void> {
    const base = join(directory, "bridge");
    const now = Date.now();
    const importReceipts = async (): Promise<void> => {
      let names: string[] = [];
      try { names = await readdir(join(base, "receipts")); } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".error.txt"))) {
        let raw: string;
        try {
          raw = await readFile(join(base, "receipts", name), "utf8");
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        let receipt: Partial<BridgeReceipt>;
        try {
          const parsed = JSON.parse(raw);
          if (!isPlainObject(parsed)) continue;
          receipt = parsed as Partial<BridgeReceipt>;
        } catch { continue; /* malformed legacy receipts are skipped */ }
        if (typeof receipt.requestId !== "string" || !UUID_RE.test(receipt.requestId)) continue;
        const requestId = receipt.requestId;
        if (coordination.queueRow(requestId)?.receiptJson) continue;
        coordination.importLegacyReceipt(requestId, receipt.commandHash ?? "", `${JSON.stringify(receipt, null, 2)}\n`, now);
      }
    };
    const importEnvelopes = async (dir: string, status: "inbox" | "retry" | "processing" | "dead-letter"): Promise<void> => {
      let names: string[] = [];
      try { names = await readdir(join(base, dir)); } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".error.txt"))) {
        let raw: string;
        try {
          raw = await readFile(join(base, dir, name), "utf8");
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        let envelope: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw);
          if (!isPlainObject(parsed) || typeof parsed.attempts !== "number") continue;
          envelope = parsed as Record<string, unknown>;
        } catch { continue; /* malformed legacy envelopes are skipped */ }
        let command: BridgeCommand;
        try {
          command = parseBridgeCommand(envelope.command);
        } catch { continue; /* malformed legacy commands are skipped */ }
        const requestId = command.requestId;
        if (!UUID_RE.test(requestId) || coordination.queueRow(requestId)) continue;
        const attempts = Number(envelope.attempts) || 0;
        const lastError = typeof envelope.lastError === "string" ? envelope.lastError : undefined;
        let nextAttemptAt: number | undefined;
        if (typeof envelope.nextAttemptAt === "string") {
          const parsed = Date.parse(envelope.nextAttemptAt);
          if (!Number.isNaN(parsed)) nextAttemptAt = parsed;
        }
        let deadLetterAt: number | undefined;
        if (typeof envelope.deadLetterAt === "string") {
          const parsed = Date.parse(envelope.deadLetterAt);
          if (!Number.isNaN(parsed)) deadLetterAt = parsed;
        }
        coordination.importLegacyRow(
          requestId,
          commandHash(command),
          JSON.stringify(command),
          status === "processing" ? "retry" : status,
          attempts,
          lastError,
          status === "retry" || status === "processing" ? (nextAttemptAt ?? now) : nextAttemptAt,
          deadLetterAt,
          now,
        );
      }
    };
    await importReceipts();
    await importEnvelopes("inbox", "inbox");
    await importEnvelopes("processing", "processing");
    await importEnvelopes("retry", "retry");
    await importEnvelopes("dead-letter", "dead-letter");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

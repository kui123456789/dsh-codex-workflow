import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CoordinationStore, coordinationPath } from "./coordination.js";
import type { ReviewFinding, WorkflowMode, WorkflowPhase, WorkflowRecord } from "./types.js";

export interface UpdateOutcome<T> {
  /** The record as persisted after this update (or the untouched current
   * record when the update was suppressed). */
  record: WorkflowRecord;
  /** True when the mutation was skipped because the workflow was already
   * cancelled; nothing was written and the record is the cancelled state. */
  suppressed: boolean;
  result: T | undefined;
}

/**
 * SQLite-backed workflow store. Every read-modify-write cycle runs as a
 * conditional revision CAS inside one `BEGIN IMMEDIATE` transaction, so
 * overlapping DSH processes can never lose each other's writes, and a stale
 * callback can never resurrect a cancelled workflow. Legacy JSON record files
 * written by earlier versions are imported lazily on first access.
 */
export class WorkflowStore {
  private coordination?: CoordinationStore;
  private importedLegacy = false;
  private closed = false;

  constructor(readonly directory: string) {}

  /** The shared SQLite coordination handle (also hosts leases for workflow
   * submissions and the bridge queue). Throws once the store is closed. */
  get coordinationHandle(): CoordinationStore {
    return this.ensure();
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.ensure();
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
    if (this.closed) throw new Error("workflow store is closed");
    if (!this.coordination) {
      this.coordination = new CoordinationStore(coordinationPath(this.directory));
    }
    return this.coordination;
  }

  async save(record: WorkflowRecord): Promise<void> {
    await this.init();
    this.coordination!.saveWorkflow(record.id, recordJson(record));
  }

  async load(id: string): Promise<WorkflowRecord | undefined> {
    await this.init();
    const row = this.coordination!.loadWorkflow(id);
    if (row) return parseWorkflowRow(row);
    return this.importLegacyFile(id);
  }

  async list(): Promise<WorkflowRecord[]> {
    await this.init();
    await this.importLegacyFiles();
    const records = this.coordination!.listWorkflows().map(parseWorkflowRow);
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Atomic revision-CAS update shared by every workflow writer. Unless
   * `ignoreCancelled` is set, a record that is already cancelled suppresses
   * the mutation: `fn` is not called, nothing is written, and the outcome
   * reports `suppressed: true`. `cancelled` is therefore terminal — a stale
   * callback or a late verdict can never overwrite it.
   *
   * The mutation callback MUST be synchronous: the transaction opens, verifies
   * the revision, runs `fn` and commits within one call stack, so async work
   * (evidence, file I/O) must be completed before calling `update`. A lost
   * CAS (another writer advanced the record) re-runs the whole cycle against
   * the newest record, so no write is ever lost.
   */
  update<T = void>(
    id: string,
    fn: (record: WorkflowRecord) => T,
    opts: { ignoreCancelled?: boolean } = {},
  ): Promise<UpdateOutcome<T>> {
    return Promise.resolve().then(async () => {
      await this.init();
      if (!(await this.ensureRow(id))) throw new Error(`unknown workflow ${id}`);
      for (;;) {
        const loaded = this.coordination!.loadWorkflow(id);
        if (!loaded) throw new Error(`unknown workflow ${id}`);
        const outcome = this.coordination!.compareAndUpdateWorkflow<T>(
          id,
          loaded.revision,
          ({ raw, revision }) => {
            const record = parseRecord(raw);
            // The DB row's revision is the single source of truth.
            record.revision = revision;
            const result = fn(record);
            if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
              throw new Error("workflow update mutation must be synchronous: async work belongs outside the transaction");
            }
            record.updatedAt = new Date().toISOString();
            return { result, recordJson: recordJson(record) };
          },
          { ignoreCancelled: opts.ignoreCancelled === true },
        );
        if (outcome.kind === "retry") continue;
        return {
          record: parseWorkflowRow({
            id,
            revision: outcome.revision,
            recordJson: outcome.recordJson,
          }),
          suppressed: outcome.kind === "suppressed",
          result: outcome.result,
        };
      }
    });
  }

  async activeForSession(sessionId: string): Promise<WorkflowRecord | undefined> {
    const terminal = new Set<WorkflowPhase>(["passed", "blocked", "failed", "cancelled"]);
    return (await this.list()).find(
      (record) => record.dshSessionId === sessionId && !terminal.has(record.phase),
    );
  }

  /** Bridge idempotency lookup: the workflow created for a dispatch request. */
  async byBridgeRequest(requestId: string): Promise<WorkflowRecord | undefined> {
    return (await this.list()).find((record) => record.bridgeRequestId === requestId);
  }

  // ------------------------------------------------------------ internals

  private async ensureRow(id: string): Promise<boolean> {
    if (this.coordination!.loadWorkflow(id)) return true;
    const imported = await this.importLegacyFile(id);
    return imported !== undefined;
  }

  /** Import a legacy `<directory>/<id>.json` record on first access so
   * pre-SQLite data keeps working. The returned record reports the actual
   * SQLite row revision (1 after the first import). */
  private async importLegacyFile(id: string): Promise<WorkflowRecord | undefined> {
    const path = join(this.directory, `${id}.json`);
    try {
      const raw = await readFile(path, "utf8");
      const record = parseRecord(JSON.parse(raw));
      this.coordination!.saveWorkflow(id, recordJson(record));
      const row = this.coordination!.loadWorkflow(id);
      return row ? parseWorkflowRow(row) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async importLegacyFiles(): Promise<void> {
    if (this.importedLegacy) return;
    this.importedLegacy = true;
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const id = name.slice(0, -5);
      if (this.coordination!.loadWorkflow(id)) continue;
      await this.importLegacyFile(id).catch(() => undefined);
    }
  }
}

const PHASES = new Set<WorkflowPhase>([
  "planning",
  "waiting_input",
  "executing",
  "reviewing",
  "fixing",
  "waiting_review_decision",
  "passed",
  "blocked",
  "failed",
  "cancelled",
]);

const MODES: WorkflowMode[] = ["planned", "review_only"];

function parseRecord(value: unknown): WorkflowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid workflow record");
  const record = value as Partial<WorkflowRecord>;
  if (record.schemaVersion !== 1 || typeof record.id !== "string" || typeof record.dshSessionId !== "string") {
    throw new Error("unsupported workflow record");
  }
  if (!record.phase || !PHASES.has(record.phase)) throw new Error("invalid workflow phase");
  const result: Partial<WorkflowRecord> & { schemaVersion: 1 } = {
    ...record,
    schemaVersion: 1,
    // Old records predate the review gate; treat them as planner-driven workflows.
    mode: MODES.includes(record.mode as WorkflowMode) ? record.mode : "planned",
    // Old records predate the Codex bridge; treat them as DSH-originated.
    origin: record.origin === "codex_bridge" ? "codex_bridge" : "dsh",
    noChangeReviewRounds: typeof record.noChangeReviewRounds === "number" ? record.noChangeReviewRounds : 0,
    reviewContractFailures: typeof record.reviewContractFailures === "number" ? record.reviewContractFailures : 0,
    callbackAttempts: typeof record.callbackAttempts === "number" ? record.callbackAttempts : 0,
    assumptions: Array.isArray(record.assumptions) ? record.assumptions : [],
    questions: Array.isArray(record.questions) ? record.questions : [],
    reviewCycles: typeof record.reviewCycles === "number" ? record.reviewCycles : 0,
  };
  if (record.latestReview) {
    result.latestReview = {
      ...record.latestReview,
      // Old findings have no blocking flag; derive it from severity.
      findings: (record.latestReview.findings ?? []).map(normalizeFinding),
      testGaps: Array.isArray(record.latestReview.testGaps) ? record.latestReview.testGaps : [],
      summary: typeof record.latestReview.summary === "string" ? record.latestReview.summary : "",
    };
  }
  return result as WorkflowRecord;
}

function normalizeFinding(finding: ReviewFinding): ReviewFinding {
  const blocking = typeof finding.blocking === "boolean"
    ? finding.blocking
    : finding.severity === "critical" || finding.severity === "high";
  return { ...finding, blocking };
}

function recordJson(record: WorkflowRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Parse a workflow row, overriding `record.revision` with the database row's
 * revision — the JSON inside record_json must never be trusted for it. */
function parseWorkflowRow(row: { id: string; revision: number; recordJson: string }): WorkflowRecord {
  const record = parseRecord(JSON.parse(row.recordJson));
  record.revision = row.revision;
  return record;
}

import { randomUUID } from "node:crypto";
import { access, copyFile, link, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CoordinationStore, coordinationPath } from "./coordination.js";
import type { ReviewFinding, ReviewStep, WorkflowMode, WorkflowPhase, WorkflowProcessState, WorkflowRecord } from "./types.js";
import { deserializeWorkflowRecord, serializeWorkflowRecord } from "./state/workflow-schema.js";

export interface UpdateOutcome<T> {
  /** The record as persisted after this update (or the untouched current
   * record when the update was suppressed). */
  record: WorkflowRecord;
  /** True when the mutation was skipped because the workflow was already
   * cancelled; nothing was written and the record is the cancelled state. */
  suppressed: boolean;
  result: T | undefined;
}

export interface WorkflowStoreOptions {
  /** Injectable only for testing backup failure; production uses fs.copyFile. */
  copyFile?: typeof copyFile;
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
  private legacyImport?: Promise<void>;
  private closed = false;
  private migrationBackupDone = false;
  private migrationBackup?: Promise<void>;

  constructor(readonly directory: string, private readonly options: WorkflowStoreOptions = {}) {}

  /** The shared SQLite coordination handle (also hosts leases for workflow
   * submissions and the bridge queue). Throws once the store is closed. */
  get coordinationHandle(): CoordinationStore {
    return this.ensure();
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.backupBeforeSchemaMigration();
    this.ensure();
  }

  /** Keep one pre-v2 copy before the first process opens/migrates the DB. */
  private async backupBeforeSchemaMigration(): Promise<void> {
    if (this.migrationBackupDone) return;
    if (this.migrationBackup) return this.migrationBackup;
    const task = this.performMigrationBackup();
    this.migrationBackup = task;
    try {
      await task;
      this.migrationBackupDone = true;
    } finally {
      if (this.migrationBackup === task) this.migrationBackup = undefined;
    }
  }

  private async performMigrationBackup(): Promise<void> {
    const source = coordinationPath(this.directory);
    const backup = `${source}.pre-schema-v2.bak`;
    try { await access(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try { await access(backup); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${backup}.${randomUUID()}.tmp`;
      try {
        await (this.options.copyFile ?? copyFile)(source, temporary);
        // A hard link is the portable no-replace atomic install primitive in
        // Node: it publishes only a complete temp file and loses harmlessly
        // when another independent store wins the race for the backup path.
        try {
          await link(temporary, backup);
        } catch (installError) {
          if (!isAlreadyExists(installError)) throw installError;
        }
      } finally {
        try { await unlink(temporary); } catch (cleanupError) {
          if (!isMissing(cleanupError)) throw cleanupError;
        }
      }
    }
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

  /** Current SQLite snapshot for synchronous notification guards. The
   * owning execution has already initialized/imported its workflow. */
  snapshot(id: string): WorkflowRecord | undefined {
    const row = this.ensure().loadWorkflow(id);
    return row ? parseWorkflowRow(row) : undefined;
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
      (record) => record.dshSessionId === sessionId
        && (!terminal.has(record.phase) || record.retryState?.awaitingStartReceipt === true),
    );
  }

  /** A failed first Planner startup stays addressable after its tool returned
   * no id. Never skip a newer task to expose an older failure as current. */
  async failedPlannerStartupForSession(sessionId: string): Promise<WorkflowRecord | undefined> {
    const latest = (await this.list()).filter((record) => record.dshSessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return latest?.phase === "failed" && latest.mode === "planned" && !latest.planMarkdown?.trim()
      ? latest : undefined;
  }

  /**
   * Mark abandoned workflows as cancelled without deleting their audit record.
   *
   * A DSH runtime can disappear while a workflow is in an intermediate phase.
   * Those rows must not be treated as recoverable when their session is no
   * longer live, but a short grace period is required so a normal runtime
   * restart can re-register the same session before it is abandoned. Active
   * bridge submissions are left untouched because their durable recovery state
   * may still be valid if the session returns.
   */
  async abandonOrphaned(
    liveSessionIds: Iterable<string>,
    graceMs: number,
    now = Date.now(),
  ): Promise<string[]> {
    const live = new Set(liveSessionIds);
    const terminal = new Set<WorkflowPhase>(["passed", "blocked", "failed", "cancelled"]);
    const activeSubmission = new Set([
      "queued",
      "sending",
      "waiting_verdict",
      "retrying",
      "verdict_ready",
      "received",
    ]);
    const cutoff = now - Math.max(0, graceMs);
    const abandoned: string[] = [];
    for (const candidate of await this.list()) {
      if (terminal.has(candidate.phase) || live.has(candidate.dshSessionId)) continue;
      const updatedAt = Date.parse(candidate.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue;
      if (candidate.submissionState && activeSubmission.has(candidate.submissionState)) continue;
      const outcome = await this.update(candidate.id, (record) => {
        if (terminal.has(record.phase) || live.has(record.dshSessionId)) return;
        const currentUpdatedAt = Date.parse(record.updatedAt);
        if (!Number.isFinite(currentUpdatedAt) || currentUpdatedAt > cutoff) return;
        if (record.submissionState && activeSubmission.has(record.submissionState)) return;
        record.phase = "cancelled";
        const reason = `DSH session ${record.dshSessionId} is no longer live; workflow abandoned by recovery`;
        record.error = record.error ? `${record.error}; ${reason}` : reason;
        if (record.submissionId && record.submissionState !== "failed" && record.submissionState !== "applied" && record.submissionState !== "delivered") {
          record.submissionState = "failed";
          record.submissionError = "workflow abandoned because its DSH session is no longer live";
          record.callbackState = "failed";
        }
      }, { ignoreCancelled: true });
      if (outcome.record.phase === "cancelled" && !abandoned.includes(candidate.id)) abandoned.push(candidate.id);
    }
    return abandoned;
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
  private async importLegacyFile(id: string, skipMalformed = false): Promise<WorkflowRecord | undefined> {
    const path = join(this.directory, `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let record: WorkflowRecord;
    try {
      record = parseRecord(JSON.parse(raw));
    } catch (error) {
      if (skipMalformed) return undefined;
      throw error;
    }
    this.coordination!.insertWorkflowIfAbsent(id, recordJson(record));
    const row = this.coordination!.loadWorkflow(id);
    return row ? parseWorkflowRow(row) : undefined;
  }

  private async importLegacyFiles(): Promise<void> {
    if (this.importedLegacy) return;
    if (this.legacyImport) return this.legacyImport;
    const task = this.performLegacyImport();
    this.legacyImport = task;
    try {
      await task;
      this.importedLegacy = true;
    } finally {
      if (this.legacyImport === task) this.legacyImport = undefined;
    }
  }

  private async performLegacyImport(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const id = name.slice(0, -5);
      if (this.coordination!.loadWorkflow(id)) continue;
      await this.importLegacyFile(id, true);
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
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
const REVIEW_STEPS = new Set<ReviewStep>([
  "reviewing",
  "review_native_turn",
  "review_readback",
  "review_display_rewrite",
  "review_conversion",
  "review_alignment",
  "review_reconciliation",
  "review_finalizing",
]);
const PROCESS_STATES = new Set<WorkflowProcessState>([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

function parseRecord(value: unknown): WorkflowRecord {
  const record = deserializeWorkflowRecord(value) as Partial<WorkflowRecord>;
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
    reviewAttempt: typeof record.reviewAttempt === "number" ? record.reviewAttempt : 0,
    ...(typeof record.reviewStep === "string" && REVIEW_STEPS.has(record.reviewStep as ReviewStep)
      ? { reviewStep: record.reviewStep as ReviewStep }
      : {}),
    ...(typeof record.reviewStartedAt === "string" ? { reviewStartedAt: record.reviewStartedAt } : {}),
    ...(typeof record.lastProgressAt === "string" ? { lastProgressAt: record.lastProgressAt } : {}),
    ...(typeof record.activeTurnId === "string" ? { activeTurnId: record.activeTurnId } : {}),
    ...(typeof record.reviewElapsedMs === "number" && Number.isFinite(record.reviewElapsedMs)
      ? { reviewElapsedMs: Math.max(0, record.reviewElapsedMs) }
      : {}),
    ...(typeof record.lastProgressMessage === "string" ? { lastProgressMessage: record.lastProgressMessage } : {}),
    ...(typeof record.processState === "string" && PROCESS_STATES.has(record.processState as WorkflowProcessState)
      ? { processState: record.processState as WorkflowProcessState }
      : {}),
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
  return `${serializeWorkflowRecord(record)}\n`;
}

/** Parse a workflow row, overriding `record.revision` with the database row's
 * revision — the JSON inside record_json must never be trusted for it. */
function parseWorkflowRow(row: { id: string; revision: number; recordJson: string }): WorkflowRecord {
  try {
    const record = parseRecord(deserializeWorkflowRecord(JSON.parse(row.recordJson)));
    record.revision = row.revision;
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workflow ${row.id} record is invalid: ${message}`, { cause: error });
  }
}

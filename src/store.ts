import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export class WorkflowStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(readonly directory: string) {}

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async save(record: WorkflowRecord): Promise<void> {
    await this.init();
    const path = this.path(record.id);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    // Windows (and antivirus scanners) can transiently lock either file during
    // rapid temp churn; retry briefly instead of failing a workflow.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === "EPERM" || code === "EACCES" || code === "EBUSY") && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Serialize the read-modify-write cycle per workflow id so concurrent
   * mutators (cancel vs. onStarted vs. outcome commits) never lose each
   * other's writes. Unless `ignoreCancelled` is set, a record that is already
   * cancelled suppresses the mutation: `fn` is not called, nothing is written,
   * and the outcome reports `suppressed: true`. This makes `cancelled` a
   * terminal state that no late writer can resurrect.
   */
  update<T = void>(
    id: string,
    fn: (record: WorkflowRecord) => T | Promise<T>,
    opts: { ignoreCancelled?: boolean } = {},
  ): Promise<UpdateOutcome<T>> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      const record = await this.load(id);
      if (!record) throw new Error(`unknown workflow ${id}`);
      if (!opts.ignoreCancelled && record.phase === "cancelled") {
        return { record, suppressed: true, result: undefined } as UpdateOutcome<T>;
      }
      const result = await fn(record);
      record.updatedAt = new Date().toISOString();
      await this.save(record);
      return { record, suppressed: false, result };
    });
    // Keep the chain alive even when one update fails.
    this.chains.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  async load(id: string): Promise<WorkflowRecord | undefined> {
    try {
      const raw = await readFile(this.path(id), "utf8");
      return parseRecord(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<WorkflowRecord[]> {
    await this.init();
    const names = await readdir(this.directory);
    const records = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.load(name.slice(0, -5))),
    );
    return records
      .filter((record): record is WorkflowRecord => record !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async activeForSession(sessionId: string): Promise<WorkflowRecord | undefined> {
    const terminal = new Set<WorkflowPhase>(["passed", "blocked", "failed", "cancelled"]);
    return (await this.list()).find(
      (record) => record.dshSessionId === sessionId && !terminal.has(record.phase),
    );
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid workflow id: ${id}`);
    return join(this.directory, `${id}.json`);
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
    noChangeReviewRounds: typeof record.noChangeReviewRounds === "number" ? record.noChangeReviewRounds : 0,
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
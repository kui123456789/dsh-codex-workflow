import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRecord } from "./types.js";

export class WorkflowStore {
  constructor(readonly directory: string) {}

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async save(record: WorkflowRecord): Promise<void> {
    await this.init();
    const path = this.path(record.id);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, path);
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
    const terminal = new Set(["passed", "blocked", "failed", "cancelled"]);
    return (await this.list()).find(
      (record) => record.dshSessionId === sessionId && !terminal.has(record.phase),
    );
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid workflow id: ${id}`);
    return join(this.directory, `${id}.json`);
  }
}

function parseRecord(value: unknown): WorkflowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid workflow record");
  const record = value as Partial<WorkflowRecord>;
  if (record.schemaVersion !== 1 || typeof record.id !== "string" || typeof record.dshSessionId !== "string") {
    throw new Error("unsupported workflow record");
  }
  return record as WorkflowRecord;
}

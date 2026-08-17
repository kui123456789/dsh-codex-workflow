import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowRecord } from "../src/types.js";

test("persists and lists workflow records atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-store-"));
  try {
    const store = new WorkflowStore(directory);
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: "workflow-1",
      dshSessionId: "session-1",
      cwd: process.cwd(),
      task: "test",
      phase: "executing",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    await store.save(record);
    assert.deepEqual(await store.load(record.id), record);
    assert.equal((await store.activeForSession("session-1"))?.id, record.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

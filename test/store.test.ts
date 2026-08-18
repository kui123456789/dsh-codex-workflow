import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      mode: "planned",
      phase: "executing",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
    };
    await store.save(record);
    assert.deepEqual(await store.load(record.id), record);
    assert.equal((await store.activeForSession("session-1"))?.id, record.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads records written before the review gate (missing mode, noChangeReviewRounds and blocking)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-compat-"));
  try {
    const store = new WorkflowStore(directory);
    const old = {
      schemaVersion: 1,
      id: "legacy-1",
      dshSessionId: "session-legacy",
      cwd: process.cwd(),
      task: "legacy",
      phase: "fixing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 2,
      latestReview: {
        verdict: "changes_requested",
        findings: [
          { severity: "critical", title: "C", body: "critical body" },
          { severity: "medium", title: "M", body: "medium body" },
        ],
        testGaps: ["gap"],
        summary: "old summary",
      },
    };
    await writeFile(join(directory, "legacy-1.json"), `${JSON.stringify(old)}\n`, "utf8");

    const loaded = await store.load("legacy-1");
    assert.ok(loaded);
    assert.equal(loaded.mode, "planned");
    assert.equal(loaded.noChangeReviewRounds, 0);
    // Old findings get blocking derived from severity.
    assert.equal(loaded.latestReview?.findings[0]?.blocking, true);
    assert.equal(loaded.latestReview?.findings[1]?.blocking, false);
    assert.equal((await store.activeForSession("session-legacy"))?.id, "legacy-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects records with an unknown phase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-badphase-"));
  try {
    const store = new WorkflowStore(directory);
    const bad = {
      schemaVersion: 1,
      id: "bad-1",
      dshSessionId: "session-bad",
      cwd: process.cwd(),
      task: "bad",
      phase: "warping",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    await writeFile(join(directory, "bad-1.json"), `${JSON.stringify(bad)}\n`, "utf8");
    await assert.rejects(store.load("bad-1"), /invalid workflow phase/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update serializes concurrent mutations without losing writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-update-"));
  try {
    const store = new WorkflowStore(directory);
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: "wf-update",
      dshSessionId: "session-update",
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
    await Promise.all([
      store.update("wf-update", (r) => { r.noChangeReviewRounds = 1; }),
      store.update("wf-update", (r) => { r.phase = "fixing"; }),
    ]);
    const loaded = await store.load("wf-update");
    assert.equal(loaded?.phase, "fixing");
    assert.equal(loaded?.noChangeReviewRounds, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update suppresses mutations once the workflow is cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-suppress-"));
  try {
    const store = new WorkflowStore(directory);
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: "wf-suppress",
      dshSessionId: "session-suppress",
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
    await store.update("wf-suppress", (r) => { r.phase = "cancelled"; }, { ignoreCancelled: true });
    let called = false;
    const outcome = await store.update("wf-suppress", (r) => { called = true; r.phase = "passed"; });
    assert.equal(outcome.suppressed, true);
    assert.equal(called, false);
    assert.equal((await store.load("wf-suppress"))?.phase, "cancelled");
    // ignoreCancelled still allows writers such as repeated cancels.
    await store.update("wf-suppress", (r) => { r.error = "cancelled again"; }, { ignoreCancelled: true });
    assert.equal((await store.load("wf-suppress"))?.error, "cancelled again");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing update does not poison the per-workflow chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-chainfail-"));
  try {
    const store = new WorkflowStore(directory);
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: "wf-chain",
      dshSessionId: "session-chain",
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
    await assert.rejects(store.update("wf-chain", () => { throw new Error("boom"); }), /boom/);
    const outcome = await store.update("wf-chain", (r) => { r.phase = "fixing"; });
    assert.equal(outcome.suppressed, false);
    assert.equal((await store.load("wf-chain"))?.phase, "fixing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
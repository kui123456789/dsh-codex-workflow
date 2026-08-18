import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowRecord } from "../src/types.js";

async function rmClosed(path: string): Promise<void> {
  closeCoordinationStoresForDirectory(path);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(path, { recursive: true, force: true });
}

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
      origin: "dsh",
      phase: "executing",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
      callbackAttempts: 0,
    };
    await store.save(record);
    // The first save assigns revision 1 in the database row; the public record
    // reflects it, and the ORIGINAL input object is never mutated.
    const saved = await store.load(record.id);
    assert.equal(saved?.revision, 1, "first save assigns revision 1");
    assert.equal(record.revision, undefined, "save must not mutate the caller's input");
    assert.equal(saved?.task, record.task);
    assert.equal((await store.activeForSession("session-1"))?.id, record.id);
    assert.equal((await store.list())[0]?.revision, 1);
  } finally {
    await rmClosed(directory);
  }
});

test("revision advances on real updates and stays put on cancelled suppression", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-revision-"));
  try {
    const store = new WorkflowStore(directory);
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: "wf-rev",
      dshSessionId: "session-rev",
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
    assert.equal((await store.load("wf-rev"))?.revision, 1);

    // A real update: both the returned outcome.record and the reload agree on
    // the incremented DB revision.
    const first = await store.update("wf-rev", (r) => { r.noChangeReviewRounds = 1; });
    assert.equal(first.record.revision, 2, "outcome.record reports the committed revision");
    assert.equal((await store.load("wf-rev"))?.revision, 2);
    assert.equal((await store.load("wf-rev"))?.noChangeReviewRounds, 1);
    const second = await store.update("wf-rev", (r) => { r.phase = "fixing"; });
    assert.equal(second.record.revision, 3);
    assert.equal((await store.load("wf-rev"))?.revision, 3);

    // Cancelled: the suppressed update does NOT bump the revision.
    await store.update("wf-rev", (r) => { r.phase = "cancelled"; }, { ignoreCancelled: true });
    assert.equal((await store.load("wf-rev"))?.revision, 4);
    const suppressed = await store.update("wf-rev", (r) => { r.phase = "passed"; });
    assert.equal(suppressed.suppressed, true);
    assert.equal(suppressed.record.revision, 4, "suppressed updates never increment");
    assert.equal((await store.load("wf-rev"))?.revision, 4);
    assert.equal((await store.load("wf-rev"))?.phase, "cancelled");
  } finally {
    await rmClosed(directory);
  }
});

test("an explicit no-op commit (recordJson undefined) does not bump the revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-revision-noop-"));
  try {
    const { CoordinationStore } = await import("../src/coordination.js");
    const coordination = new CoordinationStore(join(directory, "coord.sqlite"));
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: "wf-noop",
      dshSessionId: "session-noop",
      cwd: process.cwd(),
      task: "noop",
      phase: "executing",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    coordination.saveWorkflow("wf-noop", `${JSON.stringify(record)}\n`);
    assert.equal(coordination.loadWorkflow("wf-noop")?.revision, 1);
    // Explicit no-op: mutate returns recordJson: undefined -> committed, same revision.
    const noop = coordination.compareAndUpdateWorkflow<unknown>(
      "wf-noop",
      1,
      () => ({ result: undefined, recordJson: undefined }),
      { ignoreCancelled: false },
    );
    assert.equal(noop.kind, "committed");
    assert.equal(noop.revision, 1, "no-op commit does not bump the revision");
    // A real mutation after it bumps to 2.
    const real = coordination.compareAndUpdateWorkflow<unknown>(
      "wf-noop",
      1,
      ({ raw, revision }) => {
        if (revision !== 1) throw new Error("mutation input must carry the authoritative revision");
        const parsed = raw as { phase?: string };
        parsed.phase = "fixing";
        return { result: undefined, recordJson: `${JSON.stringify(parsed)}\n` };
      },
      { ignoreCancelled: false },
    );
    assert.equal(real.revision, 2);
    assert.equal(coordination.loadWorkflow("wf-noop")?.revision, 2);
    coordination.close();
  } finally {
    await rmClosed(directory);
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
    assert.equal(loaded.origin, "dsh");
    assert.equal(loaded.callbackAttempts, 0);
    assert.equal(loaded.revision, 1, "legacy import reports the actual SQLite row revision 1");
    // Old findings get blocking derived from severity.
    assert.equal(loaded.latestReview?.findings[0]?.blocking, true);
    assert.equal(loaded.latestReview?.findings[1]?.blocking, false);
    assert.equal((await store.activeForSession("session-legacy"))?.id, "legacy-1");
  } finally {
    await rmClosed(directory);
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
    await rmClosed(directory);
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
    await rmClosed(directory);
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
    await rmClosed(directory);
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
    await rmClosed(directory);
  }
});
import assert from "node:assert/strict";
import { access, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeCoordinationStoresForDirectory, CoordinationStore } from "../src/coordination.js";
import { WorkflowStore } from "../src/store.js";
import type { CodexWorkflowSessionEvent } from "../src/review-events.js";
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

test("workflow UI state merges independent writers and survives cold recovery without advancing workflow revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-ui-"));
  const first = new WorkflowStore(directory);
  const second = new WorkflowStore(directory);
  let reopened: WorkflowStore | undefined;
  try {
    await first.save({
      schemaVersion: 1, id: "wf-ui", dshSessionId: "session-ui", cwd: process.cwd(), task: "sidecar",
      phase: "executing", createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
      assumptions: [], questions: [], reviewCycles: 0,
    });
    await second.init();
    const original = await first.load("wf-ui");
    assert.equal(first.uiProjection("session-ui"), undefined);
    first.appendUiEvent("session-ui", { type: "dsh-codex-workflow/plan-updated", data: {
      workflowId: "wf-ui", status: "ready", planMarkdown: "Retained plan", questions: [], assumptions: [],
    } });
    second.appendUiEvent("session-ui", { type: "dsh-codex-workflow/review-start", data: {
      workflowId: "wf-ui", reviewId: "review-ui", attempt: 1, startedAt: "2026-10-25T00:00:01.000Z", mode: "planned",
    } });
    first.appendUiEvent("session-ui", { type: "dsh-codex-workflow/live", data: {
      workflowId: "wf-ui", stage: "reviewing", reviewId: "review-ui", at: "2026-10-25T00:00:02.000Z",
      entries: [{ kind: "tool", itemId: "tool-ui", text: "Checking ", command: "pnpm typecheck", cwd: directory, files: ["src/store.ts"] }],
    } });
    second.appendUiEvent("session-ui", { type: "dsh-codex-workflow/live", data: {
      workflowId: "wf-ui", stage: "reviewing", reviewId: "review-ui", at: "2026-10-25T00:00:03.000Z",
      entries: [{ kind: "tool", itemId: "tool-ui", text: "complete", exitCode: 0, status: "completed" }],
    } });
    first.close();
    second.close();
    reopened = new WorkflowStore(directory);
    await reopened.init();
    const view = reopened.uiProjection("session-ui");
    assert.equal(view?.plan?.planMarkdown, "Retained plan");
    assert.equal(view?.activeReview?.reviewId, "review-ui");
    assert.equal(view?.reviews.length, 1);
    assert.deepEqual(view?.reviews[0]?.live, [{ kind: "tool", itemId: "tool-ui", text: "Checking complete",
      command: "pnpm typecheck", cwd: directory, files: ["src/store.ts"], exitCode: 0, status: "completed" }]);
    assert.deepEqual(await reopened.load("wf-ui"), original);
    assert.equal(reopened.uiProjection("other-session"), undefined);
    assert.deepEqual(reopened.coordinationHandle.integrityCheck(), ["ok"]);
  } finally {
    first.close();
    second.close();
    reopened?.close();
    await rmClosed(directory);
  }
});

test("workflow UI state rejects invalid folds and rolls back failed persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-ui-rollback-"));
  const store = new WorkflowStore(directory);
  try {
    await store.init();
    const event: CodexWorkflowSessionEvent = { type: "dsh-codex-workflow/plan-updated", data: {
      workflowId: "wf-ui", status: "planning", questions: [], assumptions: [],
    } };
    store.appendUiEvent("session-ui", event);
    const original = store.uiProjection("session-ui");
    assert.throws(() => store.appendUiEvent("session-ui", {
      ...event, data: { ...event.data, status: "invalid" },
    } as unknown as CodexWorkflowSessionEvent));
    assert.deepEqual(store.uiProjection("session-ui"), original);
    store.coordinationHandle.db.exec(`CREATE TRIGGER reject_ui_write BEFORE UPDATE ON workflow_ui
      BEGIN SELECT RAISE(ABORT, 'scripted UI persistence failure'); END`);
    assert.throws(() => store.appendUiEvent("session-ui", {
      ...event, data: { ...event.data, status: "ready", planMarkdown: "Committed after recovery" },
    }), /scripted UI persistence failure/);
    assert.deepEqual(store.uiProjection("session-ui"), original);
    store.coordinationHandle.db.exec("DROP TRIGGER reject_ui_write");
    store.appendUiEvent("session-ui", {
      ...event, data: { ...event.data, status: "ready", planMarkdown: "Committed after recovery" },
    });
    assert.equal(store.uiProjection("session-ui")?.plan?.planMarkdown, "Committed after recovery");
    assert.deepEqual(store.coordinationHandle.integrityCheck(), ["ok"]);
  } finally {
    store.close();
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

test("concurrent first lists wait for the same legacy import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-legacy-concurrent-"));
  try {
    const legacy = {
      schemaVersion: 1,
      id: "zzzz-legacy-target",
      dshSessionId: "session-legacy-concurrent",
      cwd: process.cwd(),
      task: "legacy concurrent import",
      phase: "executing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    await Promise.all([
      ...Array.from({ length: 128 }, (_, index) =>
        writeFile(join(directory, `legacy-noise-${index.toString().padStart(3, "0")}.json`), "not json\n", "utf8")),
      writeFile(join(directory, "zzzz-legacy-target.json"), `${JSON.stringify(legacy)}\n`, "utf8"),
    ]);
    const store = new WorkflowStore(directory);
    const [first, second] = await Promise.all([store.list(), store.list()]);
    assert.equal(first.some((record) => record.id === legacy.id), true);
    assert.equal(second.some((record) => record.id === legacy.id), true);
  } finally {
    await rmClosed(directory);
  }
});

test("legacy workflow import retries a one-shot coordination failure and skips malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-legacy-retry-"));
  try {
    const legacy = {
      schemaVersion: 1,
      id: "legacy-retry-target",
      dshSessionId: "session-legacy-retry",
      cwd: process.cwd(),
      task: "legacy retry after coordination failure",
      phase: "executing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    await Promise.all([
      writeFile(join(directory, "000-malformed.json"), "not json\n", "utf8"),
      writeFile(join(directory, `${legacy.id}.json`), `${JSON.stringify(legacy)}\n`, "utf8"),
    ]);

    const store = new WorkflowStore(directory);
    const coordination = store.coordinationHandle;
    const originalInsert = coordination.insertWorkflowIfAbsent.bind(coordination);
    const mutable = coordination as unknown as {
      insertWorkflowIfAbsent: (...args: Parameters<CoordinationStore["insertWorkflowIfAbsent"]>) => boolean;
    };
    let failed = false;
    mutable.insertWorkflowIfAbsent = (...args) => {
      if (!failed) {
        failed = true;
        const error = new Error("legacy workflow migration failed once") as NodeJS.ErrnoException;
        error.code = "SQLITE_BUSY";
        throw error;
      }
      return originalInsert(...args);
    };

    await assert.rejects(store.list(), /legacy workflow migration failed once/);
    const records = await store.list();
    assert.equal(records.some((record) => record.id === legacy.id), true);
    assert.equal(records.length, 1, "malformed records remain skipped");
  } finally {
    await rmClosed(directory);
  }
});

test("legacy import never overwrites a workflow row created by another store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-legacy-no-clobber-"));
  try {
    const legacy = {
      schemaVersion: 1,
      id: "legacy-no-clobber",
      dshSessionId: "session-legacy-no-clobber",
      cwd: process.cwd(),
      task: "legacy task",
      phase: "executing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    await writeFile(join(directory, `${legacy.id}.json`), `${JSON.stringify(legacy)}\n`, "utf8");
    const first = new WorkflowStore(directory);
    const second = new WorkflowStore(directory);
    await first.init();
    await second.save({ ...legacy, task: "newer SQLite task", updatedAt: "2026-01-03T00:00:00.000Z" } as WorkflowRecord);
    const imported = await (first as unknown as { importLegacyFile(id: string): Promise<WorkflowRecord | undefined> })
      .importLegacyFile(legacy.id);
    assert.equal(imported?.task, "newer SQLite task");
    assert.equal((await first.load(legacy.id))?.task, "newer SQLite task");
    first.close();
    second.close();
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

test("workflow store creates a pre-schema-v2 database backup before opening an existing DB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-schema-backup-"));
  try {
    const first = new WorkflowStore(directory);
    await first.init();
    first.close();
    const second = new WorkflowStore(directory);
    await second.init();
    await access(join(directory, "coord.sqlite.pre-schema-v2.bak"));
    second.close();
  } finally {
    await rmClosed(directory);
  }
});

test("workflow store fails closed when the pre-schema-v2 backup cannot be written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-schema-backup-failure-"));
  try {
    const first = new WorkflowStore(directory);
    await first.init();
    first.close();
    const second = new WorkflowStore(directory, {
      copyFile: async () => { throw new Error("backup destination is unavailable"); },
    });
    await assert.rejects(second.init(), /backup destination is unavailable/);
    second.close();
  } finally {
    await rmClosed(directory);
  }
});

test("workflow store retries a failed pre-schema-v2 backup on the same instance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-schema-backup-retry-"));
  try {
    const first = new WorkflowStore(directory);
    await first.init();
    first.close();
    let attempts = 0;
    const second = new WorkflowStore(directory, {
      copyFile: async (source, destination) => {
        attempts += 1;
        if (attempts === 1) throw new Error("backup destination is temporarily unavailable");
        await copyFile(source, destination);
      },
    });
    await assert.rejects(second.init(), /temporarily unavailable/);
    await second.init();
    assert.equal(attempts, 2);
    await access(join(directory, "coord.sqlite.pre-schema-v2.bak"));
    second.close();
  } finally {
    await rmClosed(directory);
  }
});

test("workflow store shares an in-flight pre-schema-v2 backup across concurrent init calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-schema-backup-concurrent-"));
  try {
    const first = new WorkflowStore(directory);
    await first.init();
    first.close();
    let copies = 0;
    let releaseCopy!: () => void;
    let copyStarted!: () => void;
    const copyGate = new Promise<void>((resolve) => { releaseCopy = resolve; });
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    const second = new WorkflowStore(directory, {
      copyFile: async (source, destination) => {
        copies += 1;
        copyStarted();
        await copyGate;
        await copyFile(source, destination);
      },
    });
    const firstInit = second.init();
    await started;
    const secondInit = second.init();
    let secondResolved = false;
    void secondInit.then(() => { secondResolved = true; });
    await Promise.resolve();
    assert.equal(secondResolved, false, "the second init waits for the first backup");
    releaseCopy();
    await Promise.all([firstInit, secondInit]);
    assert.equal(copies, 1, "concurrent init calls copy the pre-migration database once");
    await access(join(directory, "coord.sqlite.pre-schema-v2.bak"));
    second.close();
  } finally {
    await rmClosed(directory);
  }
});

test("independent workflow stores create one complete non-overwriting pre-schema backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-schema-backup-independent-"));
  try {
    const seed = new WorkflowStore(directory);
    await seed.init();
    seed.close();
    const source = await readFile(join(directory, "coord.sqlite"));
    const firstBytes = Buffer.concat([source, Buffer.from("\nfirst-candidate\n")]);
    const secondBytes = Buffer.concat([source, Buffer.from("\nsecond-candidate\n")]);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
    const first = new WorkflowStore(directory, {
      copyFile: async (_source, destination) => {
        await writeFile(destination, firstBytes);
        firstStarted();
        await firstGate;
      },
    });
    const second = new WorkflowStore(directory, {
      copyFile: async (_source, destination) => {
        await writeFile(destination, secondBytes);
        secondStarted();
        await secondGate;
      },
    });

    const firstInit = first.init();
    const secondInit = second.init();
    await Promise.all([firstReady, secondReady]);
    releaseFirst();
    await firstInit;
    releaseSecond();
    await secondInit;

    const backupPath = join(directory, "coord.sqlite.pre-schema-v2.bak");
    assert.deepEqual(await readFile(backupPath), firstBytes, "the first atomic installer wins without being overwritten");
    const leftovers = (await readdir(directory)).filter((name) => name.startsWith("coord.sqlite.pre-schema-v2.bak.") && name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "temporary backup files are cleaned up");
    first.close();
    second.close();
  } finally {
    await rmClosed(directory);
  }
});

test("workflow store reports the workflow id when a persisted schema is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-schema-corrupt-"));
  try {
    const store = new WorkflowStore(directory);
    await store.init();
    store.coordinationHandle.saveWorkflow("wf-corrupt", JSON.stringify({ schemaVersion: 99 }));
    await assert.rejects(store.load("wf-corrupt"), /workflow wf-corrupt record is invalid: unsupported workflow schemaVersion 99/);
    store.close();
  } finally {
    await rmClosed(directory);
  }
});

test("abandonOrphaned cancels stale session-less workflows but preserves active submissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-orphan-recovery-"));
  try {
    const store = new WorkflowStore(directory);
    const old = "2026-08-20T00:00:00.000Z";
    const base = (id: string, session: string, phase: WorkflowRecord["phase"]): WorkflowRecord => ({
      schemaVersion: 1,
      id,
      dshSessionId: session,
      cwd: process.cwd(),
      task: id,
      mode: "planned",
      origin: "dsh",
      phase,
      createdAt: old,
      updatedAt: old,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
    });
    await store.save(base("orphan-executing", "session-gone", "executing"));
    await store.save({
      ...base("orphan-retrying", "session-gone", "fixing"),
      origin: "codex_bridge",
      submissionId: "submission-1",
      submissionState: "retrying",
    });
    await store.save(base("live-executing", "session-live", "executing"));

    const abandoned = await store.abandonOrphaned(["session-live"], 60_000, Date.parse("2026-08-29T00:00:00.000Z"));
    assert.deepEqual(abandoned, ["orphan-executing"]);
    assert.equal((await store.load("orphan-executing"))?.phase, "cancelled");
    assert.equal((await store.load("orphan-retrying"))?.phase, "fixing");
    assert.equal((await store.load("live-executing"))?.phase, "executing");
    assert.match((await store.load("orphan-executing"))?.error ?? "", /session-gone.*no longer live/);
  } finally {
    await rmClosed(directory);
  }
});

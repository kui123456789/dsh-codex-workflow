import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import crossSpawn from "cross-spawn";
import { BridgeStore } from "../src/bridge-store.js";
import { WorkflowStore } from "../src/store.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { CodexCallbackDispatcher } from "../src/codex-callback.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const actor = join(root, "test", "fixtures", "process-fault-actor.ts");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

async function runActor(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, actor, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    timeout.unref();
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function spawnActor(args: string[]): ChildProcess {
  return spawn(process.execPath, [tsxCli, actor, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function spawnActorCaptured(args: string[]): { proc: ChildProcess; stderr: () => Promise<string> } {
  const proc = spawn(process.execPath, [tsxCli, actor, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const chunks: Buffer[] = [];
  proc.stderr.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  return { proc, stderr: async () => Buffer.concat(chunks).toString("utf8") };
}

async function collectedLines(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  child.kill();
  await Promise.race([closed, delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, delay(1_000)]);
  }
}

/** A real child process claims a row and is then terminated; a SECOND real
 * process (or this test driving the shared DB) must recover and complete it —
 * exactly once, with a fresh claim_epoch. */
test("a killed claimer's stale processing row is recovered and completed exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-proc-crash-"));
  try {
    const store = new BridgeStore(directory, 1024 * 1024, 200); // short lease -> quick expiry
    await store.init();
    const command = {
      version: 1 as const,
      kind: "dispatch_plan" as const,
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: directory },
      task: "Task",
      planMarkdown: "<proposed_plan>\nDo\n</proposed_plan>",
      assumptions: [],
    };
    await store.enqueue(command);

    const outA = join(directory, "crash-a.jsonl");
    const first = await runActor(["claim-crash", directory, "200", outA]);
    assert.equal(first.code, 0, first.stderr);
    const lines = await collectedLines(outA);
    assert.equal(lines.length, 1, "claim-crash actor claimed one row");
    assert.equal(lines[0]!.kind, "claimed");
    const requestId = String(lines[0]!.requestId);

    // The crashed claim is a stale 'processing' row owned by the dead actor.
    const rowAfterCrash = store.coordinationHandle.queueRow(requestId);
    assert.equal(rowAfterCrash?.status, "processing", "stale processing row survives the crash");
    assert.equal(rowAfterCrash?.claimOwner, "actor-crash");
    const epochAtCrash = rowAfterCrash!.claimEpoch;

    // After the lease expires, orphan recovery + a takeover completes it.
    await delay(500);
    store.coordinationHandle.recoverQueueOrphans();
    const claim = await store.claimNext("recoverer");
    assert.ok(claim && claim.requestId === requestId, "the takeover claims the stale row");
    assert.equal(claim.claimEpoch, epochAtCrash + 1, "takeover bumps the claim epoch exactly once");
    const acked = await store.ack(claim, { status: "delivered", requestId });
    assert.equal(acked, true);
    const receipt = await store.receipt(requestId);
    assert.equal(receipt?.status, "delivered");
    const finalRow = store.coordinationHandle.queueRow(requestId);
    assert.equal(finalRow?.claimEpoch, epochAtCrash + 1, "no extra claims");
    assert.equal((await store.rowsByStatus("dead-letter")).length, 0, "no dead letter for a recoverable crash");
  } finally {
    await closeAndRemove(directory);
  }
});

/** Two REAL processes race the same SQLite queue: every row is claimed by
 * exactly one process (disjoint, atomic claim), never duplicated. */
test("two real processes racing claims never double-claim a row", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-proc-race-"));
  let racerA: ReturnType<typeof spawnActorCaptured> | undefined;
  let racerB: ReturnType<typeof spawnActorCaptured> | undefined;
  try {
    const store = new BridgeStore(directory, 1024 * 1024, 60_000);
    await store.init();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const requestId = newRequestId();
      await store.enqueue({
        version: 1,
        kind: "dispatch_plan",
        requestId,
        createdAt: new Date().toISOString(),
        codexThreadId: newRequestId(),
        target: { cwd: directory },
        task: `T${i}`,
        planMarkdown: "<proposed_plan>\nx\n</proposed_plan>",
        assumptions: [],
      });
      ids.push(requestId);
    }
    const outA = join(directory, "racer-a.jsonl");
    const outB = join(directory, "racer-b.jsonl");
    const spawnedA = spawnActorCaptured(["claimer", directory, "60000", "actorA", "20", outA]);
    const spawnedB = spawnActorCaptured(["claimer", directory, "60000", "actorB", "20", outB]);
    racerA = spawnedA;
    racerB = spawnedB;
    const [codeA, codeB] = await Promise.all([
      new Promise<number | null>((resolvePromise) => spawnedA.proc.on("close", resolvePromise)),
      new Promise<number | null>((resolvePromise) => spawnedB.proc.on("close", resolvePromise)),
    ]);
    const errA = await spawnedA.stderr();
    const errB = await spawnedB.stderr();
    assert.deepEqual([codeA, codeB], [0, 0], `raced children crashed\nA: ${errA}\nB: ${errB}`);
    const claimsA = (await collectedLines(outA)).filter((line) => line.kind === "claim");
    const claimsB = (await collectedLines(outB)).filter((line) => line.kind === "claim");
    const claimedByIdsA = new Set(claimsA.map((line) => String(line.requestId)));
    const claimedByIdsB = new Set(claimsB.map((line) => String(line.requestId)));
    for (const id of claimedByIdsA) assert.ok(!claimedByIdsB.has(id), `row claimed by both processes: ${id}`);
    assert.equal(claimedByIdsA.size, claimsA.length, "no duplicate claim within a process");
    for (const id of ids) {
      const row = store.coordinationHandle.queueRow(id);
      assert.ok(row, `row ${id} exists`);
      assert.equal(row?.claimEpoch, 1, "each row claimed exactly once (epoch 1)");
      assert.ok(row?.claimOwner === "actorA" || row?.claimOwner === "actorB", "row owned by one of the racing processes");
    }
    assert.equal(ids.length, claimedByIdsA.size + claimedByIdsB.size, "all rows claimed across the two racers exactly once");
  } finally {
    await Promise.all([terminateChild(racerA?.proc), terminateChild(racerB?.proc)]);
    await closeAndRemove(directory);
  }
});

/** A real codex-callback child that IGNORES SIGTERM must be SIGKILL-escalated
 * by stop() (real child process, real signals, injectable grace timers). */
test("stop() SIGKILL-escalates a real child that ignores SIGTERM", { timeout: 20_000 }, async () => {
  const schemaFile = join(root, "test", "fixtures", "review-schema.json");
  const fixture = join(root, "test", "fixtures", "trap-sigterm.mjs");
  let captured: ChildProcess | undefined;
  const dispatch = new CodexCallbackDispatcher({
    command: process.execPath,
    args: [fixture],
    schemaFile,
    timeoutMs: 30_000,
    killGraceMs: 80,
    killKillGraceMs: 250,
    spawn: (cmd, args, options) => {
      captured = crossSpawn(String(cmd), args as string[], options as Record<string, unknown>);
      return captured;
    },
  });
  const sending = dispatch.send({
    workflowId: newRequestId(),
    submissionId: newRequestId(),
    codexThreadId: newRequestId(),
    cwd: root,
    prompt: "review this",
  }).catch(() => undefined);
  try {
    // Let the spawn happen and the child register.
    await delay(250);
    assert.ok(captured, "a real child process was spawned");
    assert.equal(captured!.exitCode, null, "child is alive before stop");
    const started = Date.now();
    await dispatch.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `SIGKILL escalation completed without stalling (${elapsed}ms)`);
    // The child must be dead. Windows reports ANY forced termination (including
    // TerminateProcess from the SIGKILL escalation) as SIGTERM, so accept both
    // there; on POSIX the escalation is observable as SIGKILL. The deterministic
    // kill escalation order (TERM -> SIGKILL) is asserted separately with a fake
    // child in codex-callback.test.ts.
    assert.ok(
      captured!.signalCode === "SIGKILL" || (process.platform === "win32" && captured!.signalCode === "SIGTERM"),
      `the stubborn child was terminated (signalCode=${captured!.signalCode})`,
    );
    await sending;
    await delay(50); // let the child process fully reap
  } finally {
    await dispatch.stop().catch(() => undefined);
    await terminateChild(captured);
  }
});

/** A verdict staged by a REAL child process that died between staging and
 * enqueue is recovered by a second REAL process with EXACT identity and is
 * idempotent (no duplicate queue row). */
test("a staged verdict from a killed process is re-enqueued with exact identity, idempotently", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-proc-staged-"));
  let child: ChildProcess | undefined;
  try {
    const marker = join(directory, "staged-marker.txt");
    const meta = join(directory, "meta.json");
    const stagedChild = spawnActor(["stage-die", directory, marker, meta]);
    child = stagedChild;
    await waitForFile(marker);
    await waitForFile(meta);
    const stageRequestId = (await readFile(marker, "utf8")).trim();
    const metaJson = await readJson(meta);
    // The durable artifact: the workflow has a staged verdict but the enqueue
    // never committed (the child is still alive, blocked in enqueue). Kill it
    // to simulate the mid-enqueue crash.
    // Register the close waiter before signalling. On Windows a fast
    // TerminateProcess can otherwise emit `close` between kill() and once(),
    // leaving the test hung until its outer timeout.
    await terminateChild(stagedChild);

    const outR = join(directory, "recover.jsonl");
    const recovery = await runActor(["recover-staged", directory, outR]);
    assert.equal(recovery.code, 0, recovery.stderr);
    const lines = await collectedLines(outR);
    const queueRows = lines.filter((line) => line.kind === "queue-row");
    assert.equal(queueRows.length, 1, "exactly one queue row after recovery");
    assert.equal(String(queueRows[0]!.requestId), stageRequestId, "recovery re-enqueued the EXACT staged request id");
    assert.equal(queueRows[0]!.status, "inbox");
    const record = await new WorkflowStore(directory).load(String(metaJson.workflowId));
    assert.equal(record?.phase, "executing", "workflow state intact after recovery");
    assert.equal(record?.submissionState, "received", "submission reached received after the exact-identity enqueue");

    // Idempotency: a second recovery must not duplicate the row.
    const outR2 = join(directory, "recover2.jsonl");
    const recovery2 = await runActor(["recover-staged", directory, outR2]);
    assert.equal(recovery2.code, 0, recovery2.stderr);
    const lines2 = await collectedLines(outR2);
    const queueRows2 = lines2.filter((line) => line.kind === "queue-row");
    assert.equal(queueRows2.length, 1, "idempotent recovery keeps a single queue row");
    assert.equal(String(queueRows2[0]!.requestId), stageRequestId);
  } finally {
    await terminateChild(child);
    await closeAndRemove(directory);
  }
});

async function closeAndRemove(directory: string): Promise<void> {
  const { closeCoordinationStoresForDirectory } = await import("../src/coordination.js");
  closeCoordinationStoresForDirectory(directory);
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

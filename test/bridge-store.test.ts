import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { newRequestId, parseBridgeCommand, type DispatchPlanCommand } from "../src/bridge-protocol.js";
import { BridgeStore, type ClaimedBridgeCommand } from "../src/bridge-store.js";
import { CoordinationStore, closeCoordinationStoresForDirectory, coordinationPath } from "../src/coordination.js";

async function rmClosed(path: string): Promise<void> {
  // Close only this directory's coordination connections first (Windows locks
  // an open SQLite file); other directories stay untouched.
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

const uuid = () => newRequestId();

function plan(overrides: Partial<DispatchPlanCommand> = {}): DispatchPlanCommand {
  return {
    version: 1,
    kind: "dispatch_plan",
    requestId: uuid(),
    createdAt: new Date().toISOString(),
    codexThreadId: uuid(),
    target: { cwd: "C:\\work" },
    task: "实现功能",
    planMarkdown: "<proposed_plan>\n计划\n</proposed_plan>",
    assumptions: [],
    ...overrides,
  };
}

function verdictCommand(overrides: Record<string, unknown> = {}): DispatchPlanCommand | Record<string, unknown> {
  return {
    version: 1,
    kind: "submit_verdict",
    requestId: uuid(),
    createdAt: new Date().toISOString(),
    workflowId: "wf-1",
    codexThreadId: uuid(),
    submissionId: uuid(),
    verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    ...overrides,
  };
}

test("enqueue persists a validated command with its hash; no partial state is ever observed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-atomic-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    const requestId = await store.enqueue(command);
    assert.equal(requestId, command.requestId);
    const row = store.coordinationHandle.queueRow(command.requestId);
    assert.ok(row, "row persisted");
    assert.equal(row!.status, "inbox");
    assert.deepEqual(parseBridgeCommand(JSON.parse(row!.commandJson)), command);
    // No stray temp files anywhere in the queue area.
    const { readdirSync, existsSync } = await import("node:fs");
    const leftovers: string[] = [];
    const scan = (path: string): void => {
      if (!existsSync(path)) return;
      for (const name of readdirSync(path)) {
        if (name.endsWith(".tmp")) leftovers.push(name);
      }
    };
    scan(directory);
    assert.deepEqual(leftovers, []);
  } finally {
    await rmClosed(directory);
  }
});

test("two consumers racing for one file: exactly one wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-race-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const [first, second] = await Promise.all([
      store.claimNext("consumer-a"),
      store.claimNext("consumer-b"),
    ]);
    const winners = [first, second].filter((claim): claim is ClaimedBridgeCommand => claim !== undefined);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]!.command.requestId, command.requestId);
    assert.ok(["consumer-a", "consumer-b"].includes(winners[0]!.claimOwner));
  } finally {
    await rmClosed(directory);
  }
});

test("an empty claim scan stays read-only while another connection owns the write lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-empty-read-"));
  const path = coordinationPath(directory);
  let contender: CoordinationStore | undefined;
  let locker: DatabaseSync | undefined;
  try {
    contender = new CoordinationStore(path, { busyTimeoutMs: 50 });
    locker = new DatabaseSync(path);
    locker.exec("PRAGMA busy_timeout=50");
    locker.exec("BEGIN IMMEDIATE");

    assert.equal(contender.claimNext("idle-consumer", 60_000), undefined);
  } finally {
    try { locker?.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
    locker?.close();
    contender?.close();
    await rmClosed(directory);
  }
});

test("duplicate requestId is idempotent and receipts suppress re-delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-dedup-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    await store.enqueue(command); // duplicate
    assert.equal(store.coordinationHandle.queueRowsByStatus("inbox").length, 1);
    const claim = await store.claimNext("consumer-a");
    assert.ok(claim);
    assert.equal(await store.ack(claim, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() }), true);
    // Enqueueing again after a receipt is a no-op that returns the same id.
    const again = await store.enqueue(command);
    assert.equal(again, command.requestId);
    assert.equal(await store.claimNext("consumer-b"), undefined);
    assert.equal((await store.receipt(command.requestId))?.status, "delivered");
  } finally {
    await rmClosed(directory);
  }
});

test("retry keeps attempts and only becomes due after nextAttemptAt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-retry-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const claim1 = await store.claimNext("consumer-a");
    assert.ok(claim1);
    const later = new Date(Date.now() + 60_000).toISOString();
    assert.equal(await store.retry(claim1, "busy", later), true);
    assert.equal(await store.claimNext("consumer-a"), undefined, "not due yet");
    // Not due: force the queue to make it due, then the fenced flow is
    // claim -> retry -> (due) -> re-claim -> retry again (attempts accumulate
    // from the row, never from re-retrying a stale claim that is no longer
    // `processing`).
    const dueMs = String(Date.now() - 1_000);
    store.coordinationHandle.db.prepare("UPDATE queue SET next_attempt_at = ? WHERE request_id = ?").run(dueMs, command.requestId);
    const claim2 = await store.claimNext("consumer-b");
    assert.ok(claim2);
    assert.equal(claim2!.attempts, 1);
    assert.equal(await store.retry(claim2, "still busy", new Date().toISOString()), true);
    const claim3 = await store.claimNext("consumer-c");
    assert.ok(claim3);
    assert.equal(claim3.attempts, 2);
    assert.equal(claim3.lastError, "still busy");
    assert.equal(claim3.command.requestId, command.requestId);
  } finally {
    await rmClosed(directory);
  }
});

test("dead letter records the terminal failure and frees the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-dead-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const claim = await store.claimNext("consumer-a");
    assert.ok(claim);
    assert.equal(await store.deadLetter(claim, "no rollout found"), true);
    assert.equal(store.coordinationHandle.queueRowsByStatus("dead-letter").length, 1);
    assert.equal(await store.claimNext("consumer-a"), undefined);
  } finally {
    await rmClosed(directory);
  }
});

test("malformed command JSON is quarantined without blocking the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-malformed-"));
  try {
    const store = new BridgeStore(directory);
    const good = plan();
    await store.enqueue(good);
    // A row with corrupt command_json (as if a legacy import or manual write).
    const badId = uuid();
    store.coordinationHandle.db.prepare(
      "INSERT INTO queue (request_id, command_hash, command_json, status, attempts, created_at) VALUES (?, 'x', 'not json', 'inbox', 0, ?)",
    ).run(badId, Date.now());
    const claim = await store.claimNext("consumer-a");
    assert.ok(claim);
    assert.equal(claim.command.requestId, good.requestId);
    // A later claim pass hits the malformed row: it is quarantined (fenced on
    // its own claim) and never blocks the queue.
    assert.equal(await store.claimNext("consumer-a"), undefined);
    assert.equal(store.coordinationHandle.queueRow(badId)?.status, "dead-letter");
  } finally {
    await rmClosed(directory);
  }
});

test("crash recovery moves orphaned (expired-lease) processing rows back to retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-recover-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const claim = await store.claimNext("crashed-instance");
    assert.ok(claim);
    // Simulate a crash whose lease EXPIRED: the claim row is still processing
    // but its claim_until is in the past.
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
    const recovered = await store.recoverOrphans();
    assert.equal(recovered, 1);
    const again = await store.claimNext("new-instance");
    assert.ok(again);
    assert.equal(again.command.requestId, command.requestId);
  } finally {
    await rmClosed(directory);
  }
});

test("recoverOrphans never steals a live claim but reclaims an expired one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-lease-"));
  try {
    const store = new BridgeStore(directory, 1024 * 1024, 60_000);
    const command = plan();
    await store.enqueue(command);
    const claim = await store.claimNext("live-consumer");
    assert.ok(claim);
    assert.equal(await store.recoverOrphans(), 0, "live claim is never stolen");
    assert.equal(await store.claimNext("intruder"), undefined, "live claim is not re-claimable");

    // Expire the claim lease: the same row becomes recoverable.
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
    assert.equal(await store.recoverOrphans(), 1);
    const reclaimed = await store.claimNext("taker");
    assert.ok(reclaimed);
    assert.equal(reclaimed.command.requestId, command.requestId);
    assert.notEqual(reclaimed.claimEpoch, claim.claimEpoch, "takeover bumps the claim epoch");
  } finally {
    await rmClosed(directory);
  }
});

test("same request id with a different payload is rejected in every queue location", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-hash-"));
  try {
    const store = new BridgeStore(directory);
    const original = plan();
    await store.enqueue(original);
    // Inbox: same id, different task -> protocol error, never silent idempotency.
    await assert.rejects(
      store.enqueue(plan({ requestId: original.requestId, task: "different task" })),
      /already queued with a different command/,
    );
    // Identical payload re-enqueue stays idempotent.
    assert.equal(await store.enqueue(original), original.requestId);
    assert.equal(store.coordinationHandle.queueRowsByStatus("inbox").length, 1);

    // Processing: claim then re-enqueue with a different payload.
    const claim = await store.claimNext("consumer-a");
    assert.ok(claim);
    await assert.rejects(
      store.enqueue(plan({ requestId: original.requestId, task: "changed while processing" })),
      /already queued with a different command/,
    );

    // Retry: fail the claim into retry, then re-enqueue with a different payload.
    await store.retry(claim, "busy", new Date().toISOString());
    await assert.rejects(
      store.enqueue(plan({ requestId: original.requestId, task: "changed while retrying" })),
      /already queued with a different command/,
    );

    // Receipt: ack, then a different payload for the same id is rejected.
    const due = await store.claimNext("consumer-b");
    assert.ok(due);
    await store.ack(due, { requestId: original.requestId, status: "delivered", deliveredAt: new Date().toISOString() });
    await assert.rejects(
      store.enqueue(plan({ requestId: original.requestId, task: "changed after receipt" })),
      /already queued with a different command/,
    );
    // Identical payload after a receipt remains idempotent.
    assert.equal(await store.enqueue(original), original.requestId);
  } finally {
    await rmClosed(directory);
  }
});

test("rejects invalid request ids on enqueue and receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-invalid-"));
  try {
    const store = new BridgeStore(directory);
    await assert.rejects(store.enqueue(plan({ requestId: "../escape" as never })), /invalid bridge request id/);
    await assert.rejects(store.receipt("not-a-uuid"), /invalid bridge request id/);
  } finally {
    await rmClosed(directory);
  }
});

test("ack writes a durable receipt that survives a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-restart-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const claim = await store.claimNext("consumer-a");
    assert.ok(claim);
    await store.ack(claim, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() });
    // A fresh store instance (process restart) still sees the receipt.
    const restarted = new BridgeStore(directory);
    assert.equal((await restarted.receipt(command.requestId))?.status, "delivered");
    assert.equal(await restarted.claimNext("consumer-b"), undefined);
  } finally {
    await rmClosed(directory);
  }
});

/** Fencing: after B takes over A's expired claim, A's ack/retry/dead-letter/
 * renew must change 0 rows and never affect B. */
test("A's fenced operations are no-ops after B takes over the claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-fence-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const claimA = await store.claimNext("consumer-a");
    assert.ok(claimA);
    // A's lease expires; B claims (epoch bumped, owner = B).
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
    const claimB = await store.claimNext("consumer-b");
    assert.ok(claimB);
    assert.equal(claimB!.claimOwner, "consumer-b");
    assert.notEqual(claimB!.claimEpoch, claimA.claimEpoch);

    // A's stale operations: all must be no-ops.
    assert.equal(await store.ack(claimA, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() }), false);
    assert.equal(await store.retry(claimA, "stale retry", new Date().toISOString()), false);
    assert.equal(await store.deadLetter(claimA, "stale dead letter"), false);
    assert.equal(await store.renewClaim(claimA), false);
    assert.equal(await store.receipt(command.requestId), undefined, "A's ack wrote no receipt");
    assert.equal(store.coordinationHandle.queueRow(command.requestId)?.status, "processing");

    // B still owns the claim and completes it.
    assert.equal(await store.ack(claimB, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() }), true);
    assert.equal((await store.receipt(command.requestId))?.status, "delivered");
  } finally {
    await rmClosed(directory);
  }
});

/** Heartbeat: a live handler renewing its claim keeps ownership well past the
 * original TTL; recoverOrphans and claimNext cannot take it over. */
test("heartbeat renews the claim lease past its original TTL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-heartbeat-"));
  try {
    const store = new BridgeStore(directory, 1024 * 1024, 200); // 200ms TTL
    const command = plan();
    await store.enqueue(command);
    const claim = await store.claimNext("heartbeat-owner");
    assert.ok(claim);
    // Renew past the original TTL multiple times.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(await store.renewClaim(claim!), true, "renew keeps ownership");
    }
    // The claim outlived its original TTL many times over: still not stealable.
    assert.equal(await store.recoverOrphans(), 0);
    assert.equal(await store.claimNext("intruder"), undefined);
    assert.equal(store.coordinationHandle.queueRow(command.requestId)?.status, "processing");
  } finally {
    await rmClosed(directory);
  }
});

/** Multi-contender stale takeover must never produce two owners (no ABA). */
test("multi-contender takeover of an expired claim yields exactly one owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-takeover-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const first = await store.claimNext("owner-1");
    assert.ok(first);
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
    // N contenders race to take over the expired claim.
    const contenders = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.claimNext(`contender-${i}`)),
    );
    const winners = contenders.filter((claim): claim is ClaimedBridgeCommand => claim !== undefined);
    assert.equal(winners.length, 1, "exactly one contender takes over");
    const row = store.coordinationHandle.queueRow(command.requestId);
    assert.equal(row!.claimOwner, winners[0]!.claimOwner);
    assert.equal(row!.claimEpoch, winners[0]!.claimEpoch);
    // The winner completes; every other contender's ops are no-ops.
    for (const loser of contenders.filter((claim): claim is ClaimedBridgeCommand => claim !== undefined && claim.claimEpoch !== winners[0]!.claimEpoch)) {
      assert.equal(await store.ack(loser, { requestId: command.requestId, status: "delivered" }), false);
    }
    assert.equal(await store.ack(winners[0]!, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() }), true);
  } finally {
    await rmClosed(directory);
  }
});

/** Force-kill a transaction mid-flight: no half state survives, and
 * integrity_check stays clean. */
test("a killed transaction leaves no half state and the database stays intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-crash-"));
  try {
    const path = coordinationPath(directory);
    // Simulate a process killed inside BEGIN IMMEDIATE after a write: open a
    // raw connection, begin, insert, and abort WITHOUT commit or rollback.
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, epoch INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL)");
    raw.exec("BEGIN IMMEDIATE");
    raw.prepare("INSERT INTO leases VALUES ('crash-test', 1, 'half-owner', 9999999999999)").run();
    raw.close(); // "crash": connection closed mid-transaction

    // Reopen: the partial write must be gone (rolled back), never half state.
    const store = new BridgeStore(directory);
    assert.equal(store.coordinationHandle.leaseInfo("crash-test"), undefined, "no half state survives");
    // And the database itself is healthy.
    store.coordinationHandle.integrityCheck();
    // Normal operation continues.
    const grant = store.coordinationHandle.acquireLease("crash-test", 60_000, "fresh-owner");
    assert.ok(grant);
    assert.equal(grant!.epoch, 1);
    assert.equal(store.coordinationHandle.integrityCheck().every((m) => m === "ok"), true);
  } finally {
    await rmClosed(directory);
  }
});

/** Legacy file-queue data from the previous file-based version is imported. */
test("legacy file-queue envelopes are imported on init", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-legacy-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const inbox = join(directory, "bridge", "inbox");
    const receipts = join(directory, "bridge", "receipts");
    await mkdir(inbox, { recursive: true });
    await mkdir(receipts, { recursive: true });
    const command = plan();
    await writeFile(join(inbox, `${command.requestId}.json`), `${JSON.stringify({ command, attempts: 0 })}\n`, "utf8");
    const store = new BridgeStore(directory);
    const claim = await store.claimNext("post-upgrade");
    assert.ok(claim);
    assert.equal(claim.command.requestId, command.requestId);
  } finally {
    await rmClosed(directory);
  }
});

/** Migration must preserve legacy receipts (which are receipts, not envelopes)
 * and envelope fields: attempts, lastError, nextAttemptAt, deadLetterAt. */
test("legacy migration preserves receipts and retry semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-legacy-fields-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const receiptsDir = join(directory, "bridge", "receipts");
    const retryDir = join(directory, "bridge", "retry");
    await mkdir(receiptsDir, { recursive: true });
    await mkdir(retryDir, { recursive: true });

    // A legacy receipt (no command field).
    const receiptId = uuid();
    await writeFile(join(receiptsDir, `${receiptId}.json`), JSON.stringify({
      requestId: receiptId,
      status: "delivered",
      workflowId: "wf-old",
      deliveredAt: new Date().toISOString(),
    }), "utf8");

    // A legacy retry envelope with recoverable semantics to preserve.
    const retryCommand = plan({ task: "retried task" });
    const nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(join(retryDir, `${retryCommand.requestId}.json`), JSON.stringify({
      command: retryCommand,
      attempts: 4,
      lastError: "busy: 429",
      nextAttemptAt,
    }), "utf8");

    const store = new BridgeStore(directory);
    // Receipt survived and is readable via the standard API.
    const savedReceipt = await store.receipt(receiptId);
    assert.equal(savedReceipt?.status, "delivered");
    assert.equal(savedReceipt?.workflowId, "wf-old");
    // Retry semantics preserved (attempts + lastError + schedule).
    const claim = await store.claimNext("migrator");
    assert.ok(claim);
    assert.equal(claim.command.requestId, retryCommand.requestId);
    assert.equal(claim.attempts, 4, "legacy attempts preserved");
    assert.equal(claim.lastError, "busy: 429");
  } finally {
    await rmClosed(directory);
  }
});

/** Runtime expired-claim takeover: claimNext alone (no recoverOrphans) must
 * atomically reclaim a processing row whose lease expired. */
test("claimNext takes over an expired processing claim at runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-runtime-takeover-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const claimA = await store.claimNext("owner-a");
    assert.ok(claimA);
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
    // No recoverOrphans call: claimNext itself reclaims the expired row.
    const claimB = await store.claimNext("owner-b");
    assert.ok(claimB);
    assert.equal(claimB!.claimOwner, "owner-b");
    assert.equal(claimB!.claimEpoch, claimA.claimEpoch + 1, "monotonic epoch on takeover");
    const row = store.coordinationHandle.queueRow(command.requestId);
    assert.equal(row?.status, "processing");
  } finally {
    await rmClosed(directory);
  }
});

/** The monotonic epoch never wraps: multiple claim/expire/reclaim cycles
 * produce strictly increasing generations, so a stale owner can never
 * re-match. */
test("claim generations are strictly monotonic across cycles and never wrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-epoch-"));
  try {
    const store = new BridgeStore(directory);
    const command = plan();
    await store.enqueue(command);
    const epochs: number[] = [];
    const claims: ClaimedBridgeCommand[] = [];
    for (let i = 0; i < 4; i += 1) {
      if (claims.length) {
        store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
      }
      const claim = await store.claimNext(`owner-${i}`);
      assert.ok(claim);
      epochs.push(claim!.claimEpoch);
      claims.push(claim!);
    }
    assert.deepEqual(epochs, [1, 2, 3, 4], "epoch advances by one every claim");
    // A stale frame from cycle 1 (epoch 1) can no longer act on cycle 4's claim.
    assert.equal(
      await store.ack(claims[0]!, { requestId: command.requestId, status: "delivered" }),
      false,
      "the earliest stale claim's ack is a no-op against the newest generation",
    );
    // The current owner (epoch 4) still completes it.
    assert.equal(
      await store.ack(claims[3]!, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() }),
      true,
    );
  } finally {
    await rmClosed(directory);
  }
});

/** Even with a FORCED same owner, an old generation can never re-match a
 * newer claim: the epoch alone fences it. */
test("a forced same owner at a stale epoch cannot re-match the new claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-ownerdup-"));
  try {
    const store = new BridgeStore(directory);
    const sameOwner = "dsh-host";
    const command = plan();
    await store.enqueue(command);
    const claimA = await store.claimNext(sameOwner);
    assert.ok(claimA);
    assert.equal(claimA!.claimEpoch, 1);
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(command.requestId);
    const claimB = await store.claimNext(sameOwner);
    assert.ok(claimB);
    assert.equal(claimB!.claimEpoch, 2, "same owner, new generation");
    assert.equal(claimB!.claimOwner, sameOwner);
    // A's operations (epoch 1) are no-ops against B's (epoch 2) claim.
    assert.equal(await store.ack(claimA, { requestId: command.requestId, status: "delivered" }), false);
    assert.equal(await store.retry(claimA, "stale", new Date().toISOString()), false);
    assert.equal(await store.deadLetter(claimA, "stale"), false);
    assert.equal(await store.renewClaim(claimA), false);
    assert.equal(await store.receipt(command.requestId), undefined);
  } finally {
    await rmClosed(directory);
  }
});

/** Quarantine of a claim-taken row is fenced on the current epoch+owner: a
 * stale owner cannot quarantine (or otherwise touch) the new owner's row. */
test("quarantine of a processing row is fenced on the current claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-quarantine-fence-"));
  try {
    const store = new BridgeStore(directory);
    const badId = uuid();
    store.coordinationHandle.db.prepare(
      "INSERT INTO queue (request_id, command_hash, command_json, status, attempts, created_at) VALUES (?, 'x', '{}', 'inbox', 0, ?)",
    ).run(badId, Date.now());
    const claimA = await store.coordinationHandle.claimNext("owner-a", 60_000);
    assert.ok(claimA && claimA.requestId === badId);
    // B takes over the same (unparseable) row after A's lease expires.
    store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(badId);
    const claimB = await store.coordinationHandle.claimNext("owner-b", 60_000);
    assert.ok(claimB && claimB.requestId === badId);
    assert.equal(claimB!.claimEpoch, claimA!.claimEpoch + 1);
    // A's stale quarantine must not touch B's row.
    assert.equal(
      store.coordinationHandle.quarantineRow(badId, "processing", claimA!.claimEpoch, claimA!.claimOwner, "stale quarantine"),
      false,
    );
    const row = store.coordinationHandle.queueRow(badId);
    assert.equal(row?.status, "processing");
    assert.equal(row?.claimOwner, "owner-b");
    // B's own quarantine works.
    assert.equal(
      store.coordinationHandle.quarantineRow(badId, "processing", claimB!.claimEpoch, claimB!.claimOwner, "can't parse"),
      true,
    );
    assert.equal(store.coordinationHandle.queueRow(badId)?.status, "dead-letter");
  } finally {
    await rmClosed(directory);
  }
});

/** Rollback journal under multiple concurrent writers and force-kill windows
 * leaves the database intact (P0-A). */
test("multi-connection concurrent writes stay intact on the rollback journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-rollback-"));
  try {
    const store = new BridgeStore(directory);
    assert.equal(store.coordinationHandle.journalMode().toLowerCase(), "delete", "never WAL");
    const writer = (id: number) => async () => {
      const command = plan({ task: `w-${id}` });
      await store.enqueue(command);
      const claim = await store.claimNext(`w-${id}`);
      if (claim) await store.ack(claim, { requestId: command.requestId, status: "delivered", deliveredAt: new Date().toISOString() });
      return command.requestId;
    };
    // Many concurrent writers on the SAME store connection plus a few fresh
    // connections racing to read/write (simulating multiple processes).
    const writers = Array.from({ length: 24 }, (_, i) => writer(i));
    const ids = await Promise.all(writers.map((fn) => fn()));
    const freshReaders = Array.from({ length: 8 }, async () => {
      const other = new BridgeStore(directory);
      for (const id of ids) await other.receipt(id);
      other.close();
    });
    await Promise.all(freshReaders);
    for (const id of ids) {
      assert.equal((await store.receipt(id))?.status, "delivered");
    }
    store.coordinationHandle.integrityCheck();
  } finally {
    await rmClosed(directory);
  }
});

/** Closing one directory's coordination group never disturbs another
 * directory's live connections (directory-scoped teardown). */
test("closing dirA's connections leaves dirB fully usable", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "dsh-bridge-store-closeA-"));
  const dirB = await mkdtemp(join(tmpdir(), "dsh-bridge-store-closeB-"));
  try {
    const storeA = new BridgeStore(dirA);
    const storeB = new BridgeStore(dirB);
    const commandA = plan();
    const commandB = plan();
    await storeA.enqueue(commandA);
    await storeB.enqueue(commandB);

    // Clean dirA's connections only: dirB must keep working. Note: the
    // directory-scoped close terminates the UNDERLYING coordination handle,
    // not the BridgeStore wrapper's own closed flag — operations through A
    // must now reject at the coordination layer.
    const rmClosedA = async (): Promise<void> => {
      closeCoordinationStoresForDirectory(dirA);
      await rm(dirA, { recursive: true, force: true });
    };
    await rmClosedA();
    assert.equal(storeA.coordinationHandle.isClosed(), true, "A's coordination handle is closed");
    await assert.rejects(storeA.enqueue(plan()), /coordination store is closed/);
    assert.equal(storeB.isClosed(), false, "B is untouched");
    assert.equal(storeB.coordinationHandle.isClosed(), false, "B's coordination handle is untouched");
    assert.equal(storeB.coordinationHandle.queueRowsByStatus("inbox").length, 1, "B still readable");
    const claimB = await storeB.claimNext("consumer-b");
    assert.ok(claimB);
    assert.equal(await storeB.ack(claimB, { requestId: commandB.requestId, status: "delivered", deliveredAt: new Date().toISOString() }), true);
    assert.equal((await storeB.receipt(commandB.requestId))?.status, "delivered");
    // Explicitly close B afterwards (no global close-all; nothing leaks).
    const handleB = storeB.coordinationHandle;
    storeB.close();
    assert.equal(storeB.isClosed(), true);
    assert.equal(handleB.isClosed(), true, "B's coordination handle is closed after B.close()");
    assert.throws(() => storeB.coordinationHandle, /bridge store is closed/, "the wrapper getter rejects after close");
  } finally {
    closeCoordinationStoresForDirectory(dirA);
    closeCoordinationStoresForDirectory(dirB);
    await rm(dirA, { recursive: true, force: true }).catch(() => undefined);
    await rm(dirB, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Closing the store makes every operation reject without reopening. */
test("closing the store makes every operation reject without reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-store-closed-"));
  try {
    const store = new BridgeStore(directory);
    await store.enqueue(plan());
    store.close();
    assert.equal(store.isClosed(), true);
    await assert.rejects(store.enqueue(plan()), /bridge store is closed/);
    await assert.rejects(store.claimNext("late"), /bridge store is closed/);
    assert.throws(() => store.coordinationHandle, /bridge store is closed/);
    // A late task cannot silently reopen a new handle.
    assert.throws(() => store["ensure"]() as unknown, /bridge store is closed/);
  } finally {
    await rmClosed(directory);
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { TerminalCleanupGuard } from "../src/application/terminal-cleanup-guard.js";
import { captureProcessTree, originalProcessTreeExited, type ProcessInstanceProbe } from "../src/infrastructure/process-transport.js";
import { WorkflowStore } from "../src/store.js";
import { deserializeWorkflowRecord, serializeWorkflowRecord } from "../src/state/workflow-schema.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";
import type { ProcessInstanceIdentity } from "../src/types.js";
import { sharedGate, sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Probe = ProcessInstanceProbe;
type Descriptor = { processId: number; processIds: number[]; processIdentities?: ProcessInstanceIdentity[] };
const exited = originalProcessTreeExited;
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-terminal-app-server.mjs", import.meta.url));
const oldBirth = "win32:134052913570440000";
const newBirth = "win32:134052913620790000";
function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-process-instance-exit-"));
  const sdk = new CodexAppServerClient({ command: process.execPath, args: [protocol],
    requestTimeoutMs: 10000, rpcTimeoutMs: 10000, idleProcessMs: 0 });
  await sdk.start();
  const pid = (sdk as unknown as { child: { pid: number } }).child.pid;
  const tree = await captureProcessTree(pid);
  assert.ok(tree, "The local SDK produced a genuinely captured process tree");
  assert.ok(tree.includes(pid));
  const capturedTree = tree;
  const store = new WorkflowStore(directory);
  await store.init();
  const descriptor = (birth: string): Descriptor => ({ processId: pid, processIds: [...capturedTree],
    processIdentities: capturedTree.map((processId) => ({ processId, birth })) });
  const retain = (id: string, value: Descriptor, probe: Probe) => {
    const guard = new TerminalCleanupGuard(store, probe);
    const run = { terminalFailure: "Deterministic observed original cleanup", originalProcessId: value.processId,
      originalProcessIds: value.processIds, originalProcessIdentities: value.processIdentities,
      plannerIdentity: { dshSessionId: id } };
    const marker = guard.retain(id, run);
    return { guard, marker };
  };
  return { sdk, pid, tree: capturedTree, store, descriptor, retain,
    async close() {
      await sdk.stop(); store.close();
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    } };
}

test("fixed birth-query PID reuse releases only the obsolete SQLite claim and leaves the actual SDK peer intact", async () => {
  const f = await fixture();
  try {
    const value = f.descriptor(oldBirth);
    const readPids: number[][] = [];
    // This port intentionally models old/new births at the same numeric IDs.
    // It does not claim these synthetic births describe the live SDK process.
    // Actual Windows PID reuse was independently observed in the TEMP feedback.
    const probe: Probe = { isAbsent: () => false, async readIdentities(pids) {
      readPids.push([...pids]); return pids.map((processId) => ({ processId, birth: newBirth }));
    } };
    const { guard, marker } = f.retain("simulated-pid-reuse", value, probe);
    await assert.doesNotReject(async () => { await guard.assertAvailable("simulated-pid-reuse"); },
      "New live instances at reused numeric IDs cannot keep the modeled old original claim alive");
    assert.equal(await exited(value, probe), true);
    assert.ok(readPids.length > 0);
    assert.ok(readPids.every((pids) => pids.every((pid) => value.processIds.includes(pid))));
    assert.equal(guard.isConfirmed("simulated-pid-reuse", marker), true);
    assert.equal(absent(f.pid), false, "The actual SDK peer is never killed to make the birth-query assertion pass");
    assert.deepEqual(await f.sdk.health(), { modelCount: 1 });
  } finally { await f.close(); }
});

test("missing captured births and denied or partial current queries retain a live original cleanup claim", async () => {
  const f = await fixture();
  try {
    for (const kind of ["missing", "denied", "partial"] as const) {
      const value = f.descriptor(oldBirth);
      if (kind === "missing") value.processIdentities = undefined;
      const probe: Probe = { isAbsent: () => false, async readIdentities(pids) {
        return kind === "denied" ? undefined : (kind === "partial" ? [] : pids.map((processId) => ({ processId, birth: newBirth })));
      } };
      const id = "unknown-" + kind;
      const { guard, marker } = f.retain(id, value, probe);
      await assert.rejects(async () => { await guard.assertAvailable(id); }, /unconfirmed.*cleanup/);
      assert.equal(await exited(value, probe), false);
      assert.equal(guard.isConfirmed(id, marker), false);
    }
    assert.equal(absent(f.pid), false);
  } finally { await f.close(); }
});

test("a matching live original or a matching surviving descendant cannot confirm whole-tree exit", async () => {
  const f = await fixture();
  try {
    const value = f.descriptor(oldBirth);
    const same: Probe = { isAbsent: () => false, async readIdentities(pids) {
      return pids.map((processId) => ({ processId, birth: oldBirth }));
    } };
    const root = f.retain("original-still-live", value, same);
    await assert.rejects(async () => { await root.guard.assertAvailable("original-still-live"); }, /unconfirmed.*cleanup/);
    assert.equal(await exited(value, same), false);
    // This is an observation-protocol model, not a claim that the test runner
    // is the SDK child's OS descendant. Both IDs belong to real live peers,
    // so lack of a platform-specific console child cannot create a false pass.
    const modeledTree: Descriptor = { processId: f.pid, processIds: [f.pid, process.pid],
      processIdentities: [f.pid, process.pid].map((processId) => ({ processId, birth: oldBirth })) };
    const descendant: Probe = { ...same, isAbsent: (pid) => pid === modeledTree.processId };
    const child = f.retain("original-descendant-live", modeledTree, descendant);
    await assert.rejects(async () => { await child.guard.assertAvailable("original-descendant-live"); }, /unconfirmed.*cleanup/);
    assert.equal(await exited(modeledTree, descendant), false);
    assert.equal(absent(f.pid), false);
  } finally { await f.close(); }
});

test("legacy all-ESRCH evidence confirms the genuinely retired SDK original without inventing missing births", async () => {
  const f = await fixture();
  try {
    const value: Descriptor = { processId: f.pid, processIds: [...f.tree] };
    const probe: Probe = { isAbsent: absent, async readIdentities() { throw new Error("An absent legacy tree needs no birth query"); } };
    const { guard, marker } = f.retain("legacy-original-retired", value, probe);
    await f.sdk.stop();
    const deadline = Date.now() + 15000;
    while (!value.processIds.every(absent)) {
      if (Date.now() > deadline) throw new Error("Actual original tree did not exit within its existing bound");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(await exited(value, probe), true);
    await guard.assertAvailable("legacy-original-retired");
    assert.equal(guard.isConfirmed("legacy-original-retired", marker), true);
  } finally { await f.close(); }
});

test("malformed captured identities never downgrade to all-ESRCH legacy evidence or cross birth domains", async () => {
  const f = await fixture();
  try {
    const complete = f.descriptor(oldBirth);
    const invalid: Array<{ kind: string; value: Descriptor }> = [
      { kind: "malformed birth", value: { ...complete,
        processIdentities: complete.processIds.map((processId) => ({ processId, birth: "" })) } },
      { kind: "missing root", value: { processId: f.pid, processIds: [process.pid],
        processIdentities: [{ processId: process.pid, birth: oldBirth }] } },
      { kind: "duplicate PID", value: { ...complete, processIds: [...complete.processIds, f.pid],
        processIdentities: [...complete.processIdentities!, { processId: f.pid, birth: oldBirth }] } },
      { kind: "conflicting duplicate identity", value: { ...complete,
        processIdentities: [...complete.processIdentities!, { processId: f.pid, birth: newBirth }] } },
      { kind: "unsupported birth domain", value: { ...complete,
        processIdentities: complete.processIds.map((processId) => ({ processId, birth: "unknown:123" })) } },
      { kind: "explicit partial evidence", value: { ...complete, processIdentities: [] } },
    ];
    const allAbsent: Probe = { isAbsent: () => true, async readIdentities() {
      throw new Error("Malformed original evidence must be rejected before a lookup");
    } };
    for (const { kind, value } of invalid) {
      assert.equal(await exited(value, allAbsent), false, kind);
      const raw = { schemaVersion: 1, retryState: { interruption: value } };
      assert.throws(() => deserializeWorkflowRecord(raw), /invalid original process identity evidence/, kind);
      assert.throws(() => serializeWorkflowRecord(raw as unknown as Parameters<typeof serializeWorkflowRecord>[0]),
        /invalid original process identity evidence/, kind);
    }
    const differentDomain: Probe = { isAbsent: () => false, async readIdentities(pids) {
      return pids.map((processId) => ({ processId, birth: "linux:01234567-89ab-cdef-0123-456789abcdef:42" }));
    } };
    assert.equal(await exited(complete, differentDomain), false,
      "A current identity from another observation domain cannot prove the original Windows instance exited");
    assert.equal(absent(f.pid), false);
  } finally { await f.close(); }
});

test("an awaited birth lookup cannot confirm changed SQLite owners, epochs, added guards or ignored CAS updates", async () => {
  const f = await fixture();
  try {
    for (const kind of ["owner", "epoch", "added guard", "ignored CAS"] as const) {
      const gate = sharedGate();
      const value = f.descriptor(oldBirth);
      const probe: Probe = { isAbsent: () => false, async readIdentities(pids) {
        gate.enter(); await gate.promise;
        return pids.map((processId) => ({ processId, birth: newBirth }));
      } };
      const id = "lookup-race-" + kind;
      const { guard, marker } = f.retain(id, value, probe);
      assert.ok(marker);
      const db = f.store.coordinationHandle.db;
      const resource = `terminal-cleanup:${id}:${id}`;
      const pending = guard.assertAvailable(id);
      const rejection = assert.rejects(pending, /guard generation changed/);
      await gate.entered;
      const other = new TerminalCleanupGuard(f.store, probe);
      if (kind === "owner") {
        const row = db.prepare("SELECT owner FROM leases WHERE resource = ?").get(resource) as { owner: string };
        db.prepare("UPDATE leases SET owner = ? WHERE resource = ?")
          .run(JSON.stringify({ ...JSON.parse(row.owner), token: "successor-owner" }), resource);
      } else if (kind === "epoch") {
        db.prepare("UPDATE leases SET lease_until = 0 WHERE resource = ?").run(resource);
        other.retain(id, { terminalFailure: "Successor original cleanup", originalProcessId: value.processId,
          originalProcessIds: value.processIds, originalProcessIdentities: value.processIdentities,
          plannerIdentity: { dshSessionId: id } });
      } else if (kind === "added guard") {
        other.retain(id + "-new", { terminalFailure: "Another relevant original cleanup", originalProcessId: value.processId,
          originalProcessIds: value.processIds, originalProcessIdentities: value.processIdentities,
          plannerIdentity: { dshSessionId: id } });
      } else {
        db.exec("CREATE TEMP TRIGGER ignore_terminal_receipt BEFORE UPDATE OF owner ON leases " +
          "WHEN NEW.resource LIKE 'terminal-cleanup:%' BEGIN SELECT RAISE(IGNORE); END");
      }
      const before = db.prepare("SELECT resource, owner, epoch FROM leases ORDER BY resource").all();
      gate.release();
      await rejection;
      assert.deepEqual(db.prepare("SELECT resource, owner, epoch FROM leases ORDER BY resource").all(), before,
        "The predecessor lookup cannot rewrite the successor or fabricate a confirmation receipt: " + kind);
      assert.equal(guard.isConfirmed(id, marker), false, kind);
      if (kind === "ignored CAS") db.exec("DROP TRIGGER ignore_terminal_receipt");
    }
    assert.equal(absent(f.pid), false);
  } finally { await f.close(); }
});

test("actual terminal Reviewer carries frozen original births into runtime and durable retry, then cleans only the exited original",
  { skip: process.platform !== "win32" && process.platform !== "linux" }, async () => {
  const f = await sharedReviewerFixture();
  const processLog = join(f.directory, "process-instance-reviewer.jsonl");
  (f.client as unknown as { options: { args: string[] } }).options.args =
    [protocol, "--interrupt-mode", "failed", "--process-log", processLog];
  const startTurn = f.client.startTurn.bind(f.client);
  let captured: CodexTurnInterruptionError | undefined;
  f.client.startTurn = async (...args) => {
    try { return await startTurn(...args); }
    catch (error) { if (error instanceof CodexTurnInterruptionError) captured = error; throw error; }
  };
  try {
    await f.control("fixture/configure", { responses: {
      visible: [{ text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Local diagnostic verified." }],
      verdict: [{ kind: "needs_input" }],
    } });
    const row = await f.manager.reviewOnly({ task: "Review read-only local diagnostic requirements",
      implementationSummary: "Read-only diagnostic checked", changedFiles: ["changed.txt"], testResults: "Local checks passed" }, f.exec);
    assert.equal(row.processState, "waiting");
    assert.equal(row.retryState?.awaitingCleanup, true);
    const error = captured;
    assert.ok(error, "The actual SDK turn produces the retained interruption error");
    assert.ok(error.originalProcessId);
    const processIds = error.originalProcessIds;
    assert.ok(processIds);
    assert.ok(processIds.includes(error.originalProcessId));
    const identities = error.originalProcessIdentities;
    assert.ok(identities, "Supported local OS provides complete original birth identities");
    assert.deepEqual(identities.map((identity) => identity.processId).sort((a, b) => a - b),
      [...processIds].sort((a, b) => a - b));
    assert.ok(Object.isFrozen(identities));
    assert.ok(identities.every(Object.isFrozen));
    assert.throws(() => { (identities[0] as { birth: string }).birth = newBirth; }, TypeError);
    const snapshot = identities.map((identity) => ({ ...identity }));
    const mutable = snapshot.map((identity) => ({ ...identity }));
    const cloned = new CodexTurnInterruptionError(new Error("Original clone input"), error.threadId, error.turnId,
      error.originalProcessId, error.originalProcessIds, true, error.originalThreadOwner, mutable);
    mutable[0]!.birth = "changed-after-error-construction";
    assert.deepEqual(cloned.originalProcessIdentities, snapshot, "An error freezes its own clone instead of the caller's mutable rows");
    const runtime = f.runtime.recoverableRuns.get(row.id);
    assert.ok(runtime?.terminalFailure);
    assert.equal(runtime.originalProcessId, error.originalProcessId);
    assert.deepEqual(runtime.originalProcessIds, error.originalProcessIds);
    assert.deepEqual(runtime.originalProcessIdentities, snapshot);
    const persisted = await f.store.load(row.id);
    assert.ok(persisted?.retryState?.interruption);
    const descriptor = persisted.retryState.interruption;
    assert.equal(descriptor.processId, error.originalProcessId);
    assert.deepEqual(descriptor.processIds, error.originalProcessIds);
    assert.deepEqual(descriptor.processIdentities, snapshot);
    const encoded = serializeWorkflowRecord(persisted);
    assert.deepEqual((deserializeWorkflowRecord(JSON.parse(encoded)).retryState as typeof persisted.retryState)
      ?.interruption, descriptor);
    const legacy = { ...persisted, retryState: { ...persisted.retryState,
      interruption: { processId: descriptor.processId, processIds: descriptor.processIds, target: descriptor.target } } };
    const roundtrip = deserializeWorkflowRecord(JSON.parse(serializeWorkflowRecord(legacy)));
    assert.deepEqual((roundtrip.retryState as typeof legacy.retryState).interruption, legacy.retryState.interruption,
      "A legacy roundtrip does not invent birth identities");
    assert.equal(await exited(descriptor), false, "Actual OS same-birth lookup still sees the original live instance");
    const before = await f.control("fixture/stats");
    assert.equal(before.threadStarts.length, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 0);
    const child = (f.client as unknown as { child: { once(event: string, callback: () => void): void } }).child;
    const closed = new Promise<void>((resolve) => child.once("exit", resolve));
    await f.control("fixture/exit");
    await closed;
    await sharedWaitFor(() => exited(descriptor), "the actual original Reviewer instances to exit");
    await f.manager.stop();
    await f.manager.stop();
    await f.client.stop();
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.deepEqual(f.rawDisposals, [f.children[0]!.id]);
    const journal = (await readFile(processLog, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    assert.equal(journal.filter((event) => event.kind === "start").length, 1);
    assert.equal(journal.filter((event) => event.kind === "turn-start").length, before.turnStartRequests.length,
      "Original process exit reconciliation performs no model replay or replacement startup");
  } finally {
    f.client.startTurn = startTurn;
    await f.close();
  }
});

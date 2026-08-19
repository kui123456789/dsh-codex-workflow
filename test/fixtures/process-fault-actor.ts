// Real child-process fault actor for the process-level fault/recovery suite.
// Run with `tsx` in child processes so each case exercises a REAL Node process
// against the SAME SQLite coordination file (never the real DSH_HOME).
//
//   claim-crash <dir> <leaseMs> <out>
//     Claim the next inbox row under instance "actor-crash" and EXIT without
//     acking — simulating a process killed mid-claim (stale processing row).
//   claimer <dir> <leaseMs> <instanceId> <rounds> <out>
//     Claim up to <rounds> rows; append each claim to <out>. Used twice
//     concurrently to race two processes over the same queue.
//   stage-die <dir> <marker> <metaFile>
//     Create a codex_bridge workflow, submit it with a pass verdict callback
//     and a BLOCKING queue: the manager persists the staged verdict (phase A)
//     BEFORE enqueueing; the blocking enqueue writes <marker>=requestId then
//     never returns, so killing this process mimics death between staging and
//     enqueue. <metaFile> receives JSON { workflowId, submissionId, requestId }.
//   recover-staged <dir> <out>
//     Real BridgeStore queue; run WorkflowManager.recoverCallbacks() to
//     re-enqueue any staged verdict with its EXACT identity; append queue rows.
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeStore } from "../../src/bridge-store.js";
import { WorkflowStore } from "../../src/store.js";
import { WorkflowManager } from "../../src/workflow.js";
import { newRequestId } from "../../src/bridge-protocol.js";

const [subcommand, dir, ...rest] = process.argv.slice(2);

function arg(index: number): string {
  const value = rest[index];
  if (value === undefined) throw new Error(`missing argument #${index}`);
  return value;
}

function outSink(out: string) {
  return (line: unknown) => appendFile(out, `${JSON.stringify(line)}\n`, "utf8").catch(() => undefined);
}

const baseConfig = {
  codexCommand: "codex",
  plannerModel: "",
  reviewerModel: "",
  plannerEffort: "high",
  reviewerEffort: "high",
  maxReviewCycles: 3,
  maxNoChangeReviewRounds: 1,
  reviewDiffMaxBytes: 65536,
  bridgePollMs: 1000,
  bridgeMaxPayloadBytes: 1048576,
  callbackTimeoutMs: 10_000,
  callbackMaxAttempts: 3,
  callbackRetryBaseMs: 50,
  leaseTtlMs: 60_000,
  turnTimeoutMs: 60_000,
  idleProcessMs: 0,
  storageDir: "",
} as const;

async function main(): Promise<number> {
  if (subcommand === undefined || dir === undefined) {
    throw new Error("missing subcommand/dir arguments");
  }
  if (subcommand === "claim-crash") {
    const leaseMs = arg(0);
    const out = arg(1);
    const store = new BridgeStore(dir, 1024 * 1024, Number(leaseMs));
    await store.init();
    const claim = await store.claimNext("actor-crash");
    if (claim) {
      await outSink(out)({ kind: "claimed", requestId: claim.requestId, claimEpoch: claim.claimEpoch, claimOwner: claim.claimOwner });
    } else {
      await outSink(out)({ kind: "no-claim" });
    }
    // Simulate a crash: exit WITHOUT ack/release. The row stays 'processing'.
    return 0;
  }

  if (subcommand === "claimer") {
    const leaseMs = arg(0);
    const instanceId = arg(1);
    const roundsRaw = arg(2);
    const out = arg(3);
    const store = new BridgeStore(dir, 1024 * 1024, Number(leaseMs));
    await store.init();
    const rounds = Number(roundsRaw);
    for (let i = 0; i < rounds; i += 1) {
      const claim = await store.claimNext(instanceId);
      if (!claim) break;
      await outSink(out)({ kind: "claim", instanceId, requestId: claim.requestId, claimEpoch: claim.claimEpoch });
      // Leave the row processing (no ack) so we can check disjointness and
      // takeover across processes without extra delivery plumbing.
    }
    return 0;
  }

  if (subcommand === "stage-die") {
    const marker = arg(0);
    const metaFile = arg(1);
    let stagedRequest: string | undefined;
    const blockingQueue = {
      enqueue: async (command: { requestId: string }): Promise<string> => {
        stagedRequest = command.requestId;
        await writeFile(marker, command.requestId, "utf8");
        // Block forever: the process is killed here (crash between phase A
        // staging and phase B enqueue commit).
        await new Promise<void>(() => undefined);
        return command.requestId;
      },
    };
    const callback = {
      send: async (): Promise<{ kind: "verdict"; verdict: { verdict: "pass"; findings: []; testGaps: []; summary: string } }> => ({
        kind: "verdict",
        verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
      }),
      cancel: () => undefined,
      cancelSubmission: () => undefined,
      stop: () => Promise.resolve(),
    };
    const store = new WorkflowStore(dir);
    const manager = new WorkflowManager(store, {} as never, baseConfig as never, callback, blockingQueue);
    // submit() requires observable changed files inside the workspace.
    await writeFile(join(dir, "changed.txt"), "v1", "utf8");
    const agent = {
      id: "session-actor",
      session: { header: { cwd: dir }, messages: [] },
      steer: () => undefined,
      interrupt: () => undefined,
    } as never;
    const codexThreadId = newRequestId();
    const record = await manager.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId,
      target: { cwd: dir, dshSessionId: "session-actor" },
      task: "Bridge task",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    }, agent);
    const exec = {
      signal: new AbortController().signal,
      deferContext: () => undefined,
      agent: { id: "session-actor" },
    } as never;
    const submitting = manager.submit(record.id, { implementationSummary: "done", changedFiles: ["changed.txt"] }, exec);
    void submitting; // never resolves while the queue blocks
    await writeFile(metaFile, JSON.stringify({ workflowId: record.id, codexThreadId }), "utf8");
    // The manager stages the verdict (phase A) then blocks inside the fake
    // enqueue (phase B never commits). Stay alive until the test kills us so
    // the durable artifact left behind is EXACTLY "staged, but enqueue did not
    // commit" — the crash-between-staging-and-enqueue state recovery must fix.
    await new Promise<void>(() => undefined);
    return 0;
  }

  if (subcommand === "recover-staged") {
    const out = arg(0);
    const bridgeStore = new BridgeStore(dir, 1024 * 1024, 60_000);
    await bridgeStore.init();
    const store = new WorkflowStore(dir);
    const callback = { send: async () => ({ kind: "retryable_busy" as const }), cancel: () => undefined, cancelSubmission: () => undefined, stop: () => Promise.resolve() };
    const manager = new WorkflowManager(store, {} as never, baseConfig as never, callback, bridgeStore);
    const count = await manager.recoverCallbacks();
    await outSink(out)({ kind: "recovered", count });
    for (const row of bridgeStore.coordinationHandle.queueRowsByStatus("inbox")) {
      await outSink(out)({ kind: "queue-row", requestId: row.requestId, status: row.status });
    }
    for (const row of bridgeStore.coordinationHandle.queueRowsByStatus("done")) {
      await outSink(out)({ kind: "queue-row", requestId: row.requestId, status: row.status });
    }
    return 0;
  }

  throw new Error(`unknown subcommand ${subcommand}`);
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`actor error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

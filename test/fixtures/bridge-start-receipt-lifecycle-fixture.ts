import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowConfig, WorkflowRecord } from "../../src/types.js";
import { WorkflowManager } from "../../src/workflow.js";
import { WorkflowStore } from "../../src/store.js";
import { AppServerCodexCallbackDispatcher } from "../../src/app-server-callback.js";
import { sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";

export interface ReceiptStats {
  processId: number;
  threadStarts: Array<{ threadId: string; method: string }>;
  turnStartRequests: Array<{ requestId: number; threadId: string; stage: string; originalActive: boolean }>;
  interrupts: Array<{ threadId: string; turnId: string; mode: string }>;
  unsubscribes: string[];
  writerConflicts: number;
  active: Array<{ threadId: string; turnId: string }>;
}

export async function bridgeStartReceiptFixture() {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-start-receipt-evidence-"));
  const journal = join(evidenceDirectory, "wire.jsonl");
  await writeFile(journal, "");
  const f = await sharedReviewerFixture();
  const clientPort = f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number }; pinned: number;
    requestRaw(method: string, ...args: any[]): Promise<unknown> };
  const requestRaw = clientPort.requestRaw.bind(f.client);
  assert.notEqual(requestRaw.constructor.name, "AsyncFunction");
  clientPort.requestRaw = (method, ...args) => {
    // This synchronous seam samples each timer before returning its Promise.
    // Fixture observation keeps its normal 4s budget; actual model RPCs retain
    // the caller's injected 200ms timeout and all original scenario deadlines.
    const timeout = clientPort.options.rpcTimeoutMs;
    if (method.startsWith("fixture/")) clientPort.options.rpcTimeoutMs = 4000;
    try { return requestRaw(method, ...args); }
    finally { clientPort.options.rpcTimeoutMs = timeout; }
  };
  clientPort.options.args = [fileURLToPath(new URL("./fake-bridge-start-receipt-app-server.mjs", import.meta.url)), journal];
  const config = (f.manager as unknown as { config: WorkflowConfig }).config;
  const control = (method: string, params: object = {}) => f.control(method, params) as unknown as Promise<ReceiptStats>;
  const stats = () => control("fixture/stats");
  const wire = async () => (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let begins = 0, ends = 0;
  const begin = f.client.beginRound.bind(f.client), end = f.client.endRound.bind(f.client);
  f.client.beginRound = () => { begins += 1; return begin(); };
  f.client.endRound = () => { ends += 1; return end(); };
  let failed = false;
  const checkpoint = async (kind: string, extra: object = {}) => {
    const state = { kind, row: f.record && await f.store.load(f.record.id), wire: await wire(),
      children: f.children.map((child) => child.id), disposals: [...f.rawDisposals], begins, ends, pin: clientPort.pinned,
      guards: f.store.coordinationHandle.db.prepare("SELECT resource, owner, epoch FROM leases WHERE resource LIKE 'terminal-cleanup:%'").all(), ...extra };
    await writeFile(join(evidenceDirectory, `${kind}.json`), JSON.stringify(state, null, 2));
    return state;
  };
  const drain = async () => {
    await Promise.allSettled([...f.runtime.backgroundTasks]);
    const sends = (f.dispatcher as unknown as { sends: Set<Promise<unknown>> }).sends;
    await Promise.allSettled([...sends]);
  };
  const retry = async (id: string) => {
    await f.store.update(id, (record) => { record.submissionRetryAt = 0; });
    return f.manager.recoverCallbacks();
  };
  const waitRetry = (id: string) => sharedWaitFor(async () => {
    const row = await f.store.load(id);
    return row?.submissionState === "retrying" && !row.submissionLeaseToken && row;
  }, "the durable original submission retry");
  const coldStore = new WorkflowStore(f.store.directory);
  const cold = new WorkflowManager(coldStore, f.client, { ...config }, new AppServerCodexCallbackDispatcher(f.client),
    f.queue, undefined, {}, { get: (id) => id === f.parent.id ? f.parent : undefined }, f.factory);
  return { ...f, control, stats, wire, checkpoint, drain, retry, waitRetry, cold, coldStore, evidenceDirectory, clientPort,
    get begins() { return begins; }, get ends() { return ends; },
    fail() { failed = true; },
    async close() {
      try { await cold.stop(); coldStore.close(); await f.close(); }
      finally {
        f.client.beginRound = begin; f.client.endRound = end;
        if (!failed) {
          assert.ok(resolve(evidenceDirectory).startsWith(resolve(tmpdir()) + sep));
          await rm(evidenceDirectory, { recursive: true, force: true });
        } else console.error(`Bridge receipt evidence retained: ${evidenceDirectory}`);
      }
    },
  };
}

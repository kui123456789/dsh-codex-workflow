import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../src/app-server.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";
import { sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";

export interface ForkReceiptStats {
  processId: number;
  forks: Array<{ requestId: number; sourceThreadId: string; forkId: string; ephemeral: boolean; excludeTurns: boolean; replied: boolean }>;
  models: Array<{ threadId: string; turnId: string; prompt: string; schema: object }>;
  unsubscribes: string[];
  unsubscribeAttempts: Array<{ threadId: string; mode: string }>;
  loaded: string[];
}
export async function forkCreationReceiptFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-fork-creation-receipt-")), journal = join(directory, "wire.jsonl");
  await writeFile(journal, "");
  const client = new CodexAppServerClient({ command: process.execPath,
    args: [fileURLToPath(new URL("./fake-fork-creation-receipt-app-server.mjs", import.meta.url)), journal],
    requestTimeoutMs: 5000, rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const port = client as unknown as { child: ChildProcess; options: { rpcTimeoutMs: number };
    request(method: string, params: object): Promise<ForkReceiptStats> };
  let failed = false;
  await client.start();
  const original = port.child, captured = await captureProcessTreeEvidence(original.pid);
  const evidence: ProcessTreeEvidence | undefined = captured && { processId: original.pid, ...captured };
  const source = await client.startThread({ cwd: directory });
  const options = { threadId: source, expectedOwner: client.captureThreadOwner(source), cwd: directory,
    prompt: "Normalize the original local result once", model: "model-A",
    outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } };
  const control = (method: string, params: object = {}) => port.request(method, params);
  const stats = () => control("fixture/stats");
  const wire = async (): Promise<any[]> => (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const accepted = () => sharedWaitFor(async () => (await wire()).find((row) => row.kind === "fork-accepted"), "the original fork actually accepted before reply");
  const snapshot = async (kind: string, extra: object = {}) => {
    await writeFile(join(directory, `${kind}.json`), JSON.stringify({ kind, wire: await wire(), ...extra }, null, 2));
  };
  return { directory, client, port, original, evidence, source, options, control, stats, wire, accepted, snapshot,
    fail() { failed = true; },
    async close() {
      try {
        await client.stop();
        assert.ok(evidence?.processIdentities?.length, "The isolated original process has real birth evidence");
        await sharedWaitFor(() => originalProcessTreeExited(evidence!), "the captured original fork process instances exited");
      } catch (error) { failed = true; throw error; }
      finally {
        if (failed) console.error(`Fork creation receipt evidence retained: ${directory}`);
        else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
      }
    },
  };
}

export const observeForkCall = <T>(task: Promise<T>) => task.then((value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }));

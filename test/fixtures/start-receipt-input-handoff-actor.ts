import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureProcessTreeEvidence, originalProcessTreeExited, type ProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";
import type { WorkflowRecord } from "../../src/types.js";
import { sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";

const [directory, mode] = process.argv.slice(2);
assert.ok(directory && (mode === "native-input" || mode === "reabort-no-completion"));
const wirePath = join(directory, "wire.jsonl"), gatePath = join(directory, "gates.jsonl"), statePath = join(directory, "states.jsonl");
const f = await sharedReviewerFixture();
const port = f.client as unknown as { child: ChildProcess; pinned: number; options: { args: string[] } };
port.options.args = [fileURLToPath(new URL("./fake-start-receipt-input-handoff.mjs", import.meta.url)), wirePath, gatePath, mode];
let begins = 0, ends = 0;
const begin = f.client.beginRound.bind(f.client), end = f.client.endRound.bind(f.client);
f.client.beginRound = () => { begins += 1; return begin(); };
f.client.endRound = () => { ends += 1; return end(); };
const rows = (): any[] => !existsSync(wirePath) ? [] : readFileSync(wirePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const guardRows = () => f.store.coordinationHandle.db.prepare("SELECT resource, owner, epoch, lease_until FROM leases WHERE resource LIKE ?")
  .all("terminal-cleanup:%") as Array<{ resource: string; owner: string; epoch: number; lease_until: number }>;
const log = (kind: string, detail: object = {}) => appendFileSync(statePath, JSON.stringify({ kind, mode,
  actorPid: process.pid, pin: port.pinned, begins, ends, children: f.children.map((child) => child.id),
  disposals: [...f.rawDisposals], recoverable: f.runtime.recoverableRuns.size,
  plannerInputs: f.runtime.plannerInputs.size, pendingInputs: f.runtime.pending.size,
  guards: guardRows(), wire: rows(), ...detail }) + "\n");
const register = f.runtime.activeTurns.set.bind(f.runtime.activeTurns);
f.runtime.activeTurns.set = (workflowId, turn) => {
  const result = register(workflowId, turn);
  log("registered-pair", { workflowId, threadId: turn.threadId, turnId: turn.turnId });
  return result;
};
const exec = (signal = new AbortController().signal) => Object.assign(Object.create(f.exec), { signal });
const observe = <T>(task: Promise<T>) => task.then((value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }));
const failure = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
async function gate(command: object) {
  const previous = rows().filter((row) => row.kind === "gate-processed").length;
  appendFileSync(gatePath, JSON.stringify(command) + "\n");
  await sharedWaitFor(() => rows().filter((row) => row.kind === "gate-processed").length > previous, "original upstream gate");
}
const tasks: Promise<unknown>[] = [];
let evidence: ProcessTreeEvidence | undefined;
let primaryError: unknown;
let finalRecord: WorkflowRecord | undefined;
try {
  await f.client.start();
  const processId = port.child.pid, captured = await captureProcessTreeEvidence(processId);
  evidence = captured && { processId, ...captured };
  log("original-process", { evidence });
  const caller = new AbortController();
  const starting = observe(f.manager.start({ task: "Plan read-only local configuration diagnostics without changing user data." }, exec(caller.signal)));
  tasks.push(starting);
  const original = await sharedWaitFor(() => rows().find((row) => row.kind === "writer-accepted"), "original writer accepted before reply");
  caller.abort(new Error("operation aborted"));
  const first = await starting;
  assert.ok(first.value, JSON.stringify(failure(first.error)));
  const id = first.value.id;
  const retained = f.runtime.recoverableRuns.get(id);
  assert.ok(retained?.pendingStart);
  log("initial-waiting", { row: first.value, original });
  await gate({ kind: "receipt" });
  await sharedWaitFor(() => retained.pendingStart?.operation.status() === "ready", "original receipt routed without a caller");
  if (mode === "native-input") {
    const resuming = observe(f.manager.resume(id, "Observe the original Planner request", exec())); tasks.push(resuming);
    await sharedWaitFor(() => f.runtime.activeTurns.get(id)?.turnId === original.turnId, "original pair adopted by new callbacks");
    await gate({ kind: "input" });
    const native = await resuming;
    assert.ok(native.value, JSON.stringify(failure(native.error)));
    const input = f.runtime.plannerInputs.get(id), pending = f.runtime.pending.get(id);
    assert.ok(input?.pending && pending && input.pending === pending);
    log("native-input-handoff", { row: native.value, metadataOnly: f.runtime.recoverableRuns.get(id)?.metadataOnly,
      nativeRequestId: pending.request.requestId, childId: input.child?.id });
    const status = await f.manager.status(id, exec());
    log("native-input-status", { row: await f.store.load(id), continuation: status.continuation });
    finalRecord = await f.manager.continue(id, { scope: ["Inspect existing configuration only"] }, exec());
  } else {
    const secondCaller = new AbortController();
    const resuming = observe(f.manager.resume(id, "Observe the original pending Planner request", exec(secondCaller.signal)));
    tasks.push(resuming);
    await sharedWaitFor(() => f.runtime.activeTurns.get(id)?.turnId === original.turnId, "original pair adopted before second caller abort");
    secondCaller.abort(new Error("operation aborted"));
    const waiting = await resuming;
    assert.ok(waiting.value, JSON.stringify(failure(waiting.error)));
    log("second-waiting", { row: waiting.value,
      sameOwner: f.runtime.recoverableRuns.get(id) === retained,
      interruptionTurnId: f.runtime.recoverableRuns.get(id)?.interruptionTurnId });
    await gate({ kind: "confirm-without-completion" });
    // Successful original interruption ACK intentionally emits no turn/completed.
    // The same public resume must proceed after that ACK without waiting for it.
    finalRecord = await f.manager.resume(id, "Continue planning after confirming the original stopped turn", exec());
  }
  log("completed", { row: finalRecord, activeTurns: f.runtime.activeTurns.size,
    childEvents: f.children[0]!.snapshotEvents().map((event) => ({ type: event.type, data: event.data })) });
  await f.manager.stop();
  log("stopped-after-completion", { row: await f.store.load(id) });
} catch (error) {
  primaryError = error; log("actor-error", { error: failure(error) });
} finally {
  // Only our isolated original process can be stopped; retain real exit proof.
  try {
    await f.close(); await Promise.allSettled(tasks);
    assert.ok(evidence?.processIdentities?.length, "Original process evidence must identify the real fixture process");
    await sharedWaitFor(() => originalProcessTreeExited(evidence!), "all original diagnostic process instances exited");
    appendFileSync(statePath, JSON.stringify({ kind: "actor-completed", originalProcessesExited: true,
      begins, ends, pin: port.pinned, children: f.children.map((child) => child.id), disposals: [...f.rawDisposals] }) + "\n");
  } catch (error) {
    appendFileSync(statePath, JSON.stringify({ kind: "actor-cleanup-error", error: failure(error) }) + "\n");
    primaryError ??= error;
  }
}
if (primaryError) throw primaryError;

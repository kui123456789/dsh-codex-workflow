import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureProcessTreeEvidence } from "../../src/infrastructure/process-transport.js";
import { sharedReviewerFixture, sharedWaitFor } from "./bridge-shared-reviewer-fixture.js";
import { applyCodexWorkflowProjection, codexWorkflowProjectionDefinition } from "../../src/review-events.js";

const [directory, mode] = process.argv.slice(2);
assert.ok(directory && mode);
const wire = join(directory, "wire.jsonl"), gates = join(directory, "gates.jsonl");
const journal = join(directory, "states.jsonl");
const f = await sharedReviewerFixture();
const port = f.client as unknown as { child: ChildProcess; options: { args: string[]; rpcTimeoutMs: number };
  pending: Map<unknown, unknown>; pendingTurnReceipts: Set<unknown>; pinned: number };
port.options.args = [fileURLToPath(new URL("./fake-start-receipt-lifecycle-app-server.mjs", import.meta.url)), wire, gates, mode];
let adopted = 0;
const register = f.runtime.activeTurns.set.bind(f.runtime.activeTurns);
f.runtime.activeTurns.set = (workflowId, turn) => {
  adopted += 1;
  log("adopted-original-receipt", { threadId: turn.threadId, turnId: turn.turnId });
  return register(workflowId, turn);
};
const rows = (): any[] => readFileSync(wire, "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row));
const displayedPlan = () => {
  let state = codexWorkflowProjectionDefinition.init();
  for (const event of f.parent.session.snapshotEvents()) state = applyCodexWorkflowProjection(state, event);
  assert.equal(state.failure, null);
  return state.plan;
};
const log = (kind: string, detail: object = {}) => appendFileSync(journal, JSON.stringify({ kind, actorPid: process.pid,
  at: new Date().toISOString(), adopted, rawPending: port.pending.size, pin: port.pinned,
  children: f.children.map((child) => child.id), disposals: [...f.rawDisposals], planDisplay: displayedPlan(),
  planWaitingEvents: f.parent.session.snapshotEvents().filter(event => event.type === "dsh-codex-workflow/plan-updated"
    && event.data.processState === "waiting").length, ...detail }) + "\n");
const errors = (error: unknown) => {
  const result: object[] = [];
  while (error instanceof Error && result.length < 4) {
    result.push({ name: error.name, message: error.message }); error = error.cause;
  }
  return result;
};
const observe = <T>(task: Promise<T>) => task.then((value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }));
async function gate(command: object) {
  const previous = rows().filter((row) => row.kind === "gate-processed").length;
  appendFileSync(gates, JSON.stringify(command) + "\n");
  await sharedWaitFor(() => rows().filter((row) => row.kind === "gate-processed").length > previous, "actual upstream gate");
}
const controller = new AbortController();
const tasks: Promise<unknown>[] = [];
let evidence: Awaited<ReturnType<typeof captureProcessTreeEvidence>>;
log("actor-start", { mode });
try {
  await f.client.start(); evidence = await captureProcessTreeEvidence(port.child.pid);
  log("original-process", { processId: port.child.pid, evidence });
  if (mode.startsWith("review-")) {
    const reviewing = observe(f.manager.reviewOnly({ task: "Review a read-only local lifecycle check",
      implementationSummary: "Original lifecycle implementation", changedFiles: ["changed.txt"], testResults: "Local checks passed" },
    { ...f.exec, signal: controller.signal }));
    tasks.push(reviewing);
    const first = await sharedWaitFor(() => rows().find((row) => row.kind === "actual-writer-accepted" && !row.replied
      && (mode === "review-native" ? row.method === "review/start" : row.property === (mode === "review-alignment" ? "aligned" : "verdict"))),
    "the actual pending review stage accepted");
    controller.abort(new Error("operation aborted"));
    const initial = await reviewing;
    log("review-waiting", { row: initial.value, errors: errors(initial.error), original: first,
      continuation: initial.value && (await f.manager.status(initial.value.id, f.exec)).continuation, wire: rows() });
    if (initial.value) {
      const early = await observe(f.manager.resume(initial.value.id, "Continue the original review operation", f.exec));
      log("review-before-receipt", { row: early.value, errors: errors(early.error), wire: rows() });
      await gate({ kind: "receipt", index: first.index });
      const resuming = observe(f.manager.resume(initial.value.id, "Continue the original review operation", f.exec));
      tasks.push(resuming);
      await gate({ kind: "complete", index: first.index });
      const completed = await resuming;
      log("review-completed", { row: completed.value, errors: errors(completed.error), wire: rows() });
    }
  } else {
  if (mode === "timeout") port.options.rpcTimeoutMs = 80;
  const starting = observe(f.manager.start({ task: "Plan a read-only local lifecycle check" }, { ...f.exec, signal: controller.signal }));
  tasks.push(starting);
  await sharedWaitFor(() => rows().some((row) => row.kind === "actual-writer-accepted"), "original operation accepted");
  const original = rows().find((row) => row.kind === "actual-writer-accepted");
  log("accepted-pending-receipt", { original });
  if (mode === "healthy") {
    await gate({ kind: "receipt" }); await gate({ kind: "complete" });
    const outcome = await starting;
    log("healthy-outcome", { row: outcome.value, errors: errors(outcome.error), wire: rows() });
  } else {
    if (mode !== "timeout") controller.abort(new Error("operation aborted"));
    const initial = await starting;
    log("first-observer-outcome", { row: initial.value, errors: errors(initial.error) });
    if (!initial.value) returnFromFixture();
    else {
      const id = initial.value.id;
      const status = await f.manager.status(id, f.exec);
      log("receipt-waiting", { row: initial.value, continuation: status.continuation, wire: rows() });
      if (mode === "cancel") {
        const cancelled = await f.manager.cancel(id, f.exec);
        log("cancelled-before-receipt", { row: cancelled, wire: rows() });
        await gate({ kind: "receipt" }); await gate({ kind: "confirm" });
        const cleaned = await observe(f.manager.resume(id, "Only clean the original operation", f.exec));
        log("cancelled-after-receipt", { row: cleaned.value, errors: errors(cleaned.error), wire: rows() });
      } else if (mode === "stop") {
        await f.manager.stop();
        log("stopped-before-receipt", { row: await f.store.load(id), wire: rows() });
        await f.client.stop(); await f.manager.stop();
        log("stopped-after-original-exit", { row: await f.store.load(id), wire: rows(),
          recoverable: f.runtime.recoverableRuns.size });
      } else if (mode === "resume-cancel") {
        await gate({ kind: "receipt" });
        let entered!: () => void, release!: () => void;
        const startedUpdate = new Promise<void>((resolve) => { entered = resolve; });
        const allowUpdate = new Promise<void>((resolve) => { release = resolve; });
        const update = f.store.update.bind(f.store);
        let armed = true;
        f.store.update = async (...args) => {
          if (armed && args[0] === id) { armed = false; entered(); await allowUpdate; }
          return update(...args);
        };
        const resumed = observe(f.manager.resume(id, "Reattach the original operation", f.exec));
        tasks.push(resumed); await startedUpdate;
        const cancelled = await f.manager.cancel(id, f.exec);
        log("resume-cancel-before-handoff", { row: cancelled, wire: rows() });
        release(); const returned = await resumed;
        log("resume-cancel-returned", { row: returned.value, errors: errors(returned.error), wire: rows() });
        f.store.update = update;
        await gate({ kind: "confirm" });
        const cleaned = await f.manager.cancel(id, f.exec);
        log("resume-cancel-cleaned", { row: await f.store.load(id), returnedRow: cleaned, wire: rows() });
      } else {
      const early = await observe(f.manager.resume(id, "Continue the original operation", f.exec));
      log("before-receipt-resume", { row: early.value, errors: errors(early.error), wire: rows() });
      await gate({ kind: "receipt" });
      const resuming = observe(f.manager.resume(id, "Continue the original operation", f.exec));
      tasks.push(resuming);
      await gate({ kind: "complete" });
      const completed = await resuming;
      log("after-receipt-resume", { row: completed.value ?? await f.store.load(id), errors: errors(completed.error), wire: rows(),
        childTurns: f.children[0]!.snapshotEvents().filter((event) => event.type === "turn/start").length });
      }
    }
  }
  }
} finally {
  // Finish only this fixture's synthetic operation before closing its services.
  if (mode !== "stop" && readFileSync(wire, "utf8").includes("actual-writer-accepted")) {
    await gate({ kind: "complete" }).catch(() => undefined);
  }
  await f.close(); await Promise.allSettled(tasks);
  if (evidence?.processIds) await sharedWaitFor(() => evidence!.processIds.every((pid) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }), "all owned diagnostic processes exited");
  log("actor-completed");
}
function returnFromFixture() { log("unretained-start", { wire: rows() }); }


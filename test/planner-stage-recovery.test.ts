import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { sharedReviewerFixture, sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

type Response = { kind?: "failed" | "hold" | "rpc-error"; message?: string; text?: string; result?: object };
type Request = { threadId: string; turnId?: string; scope: string; prompt?: string; schemaKeys: string[];
  model?: string; collaborationModel?: string; effort?: string };
type Stats = { processId: number; initializations: number; threadStarts: Array<{ threadId: string; method: string; ephemeral: boolean; model?: string }>;
  turnStartRequests: Request[]; visibleTurns: number; unsubscribes: string[]; writerConflicts: number;
  active: Array<{ threadId: string; turnId: string }>; interrupts: Array<{ threadId: string; turnId: string; mode: string }> };
type Outcome = { record: WorkflowRecord; error?: never } | { record?: never; error: unknown };
const TASK = "Plan read-only local configuration diagnostics without changing user data.";
const ACK = "Acknowledged; I will inspect local configuration and prepare the requested plan.";
const PLAN = "<proposed_plan>\n# Goal\nImplement read-only local configuration and storage diagnostics.\n# Changes\n- Add narrow health adapters with explicit unavailable-input handling.\n- Preserve current persistence, cancellation and ownership rules.\n# Verification\n- Verify valid, missing and malformed configuration in isolated storage.\n# Risks\n- Never initialize or mutate an existing database during inspection.\n</proposed_plan>";
const protocol = fileURLToPath(new URL("./fixtures/fake-planner-stage-app-server.mjs", import.meta.url));
const ready = (planMarkdown = PLAN): Response => ({ result: { status: "ready", planMarkdown, questions: [], assumptions: [] } });

async function fixture(options: { noCatalog?: boolean; timeoutMs?: number } = {}) {
  const f = await sharedReviewerFixture();
  const processLog = join(f.directory, "protocol-processes.jsonl");
  const native = (f.client as unknown as { options: { args: string[]; rpcTimeoutMs: number; requestTimeoutMs: number } }).options;
  native.args = [protocol, "--interrupt-mode", "confirmed", "--process-log", processLog,
    ...(options.noCatalog ? ["--catalog-mode", "none"] : [])];
  native.rpcTimeoutMs = 15_000;
  native.requestTimeoutMs = options.timeoutMs ?? 30_000;
  const config = (f.manager as unknown as { config: WorkflowConfig }).config;
  if (options.noCatalog) config.plannerModel = "";
  const control = (method: string, params: object = {}) => f.control(method, params) as unknown as Promise<Stats>;
  const stats = () => control("fixture/stats");
  const configure = (responses: Record<string, Response[]>) => control("fixture/configure", { responses });
  let begins = 0;
  let ends = 0;
  const begin = f.client.beginRound.bind(f.client);
  const end = f.client.endRound.bind(f.client);
  f.client.beginRound = () => { begins += 1; return begin(); };
  f.client.endRound = () => { ends += 1; return end(); };
  const exec = (signal = new AbortController().signal) => Object.assign(Object.create(f.exec), { signal });
  const start = () => f.manager.start({ task: TASK }, exec());
  const outcome = (task: Promise<WorkflowRecord>): Promise<Outcome> => task.then((record) => ({ record }), (error: unknown) => ({ error }));
  const counts = async () => {
    const current = await stats();
    return { visible: current.visibleTurns, conversion: current.turnStartRequests.filter((r) => r.scope === "status").length,
      starts: current.threadStarts.length, children: f.children.length, disposals: f.rawDisposals.length,
      processId: current.processId, begins, ends };
  };
  const waiting = async (record: WorkflowRecord) => {
    assert.equal(record.phase, "planning");
    assert.equal(record.processState, "waiting");
    assert.equal(record.retryState?.stage, "planning");
    assert.equal(record.retryState?.awaitingContinuation, true);
    assert.equal(record.planMarkdown, undefined, "Unconverted readable output cannot authorize implementation");
    assert.equal(record.reviewCycles, 0);
    const current = await stats();
    const recovery = f.runtime.recoverableRuns.get(record.id);
    assert.ok(recovery?.plannerIdentity);
    assert.equal(current.threadStarts.length, 1);
    assert.equal(current.threadStarts[0]?.method, "thread/start");
    assert.equal(current.threadStarts[0]?.ephemeral, true);
    assert.equal(recovery.threadId, current.threadStarts[0]?.threadId);
    assert.equal(f.children.length, 1);
    assert.equal(recovery.child?.id, f.children[0]?.id);
    assert.equal(f.rawDisposals.length, 0, "The same native DSH child stays available for continuation");
    assert.equal(begins, 1);
    assert.equal(ends, 0, "The original round keeps its process pin while waiting");
    return { current, recovery, childId: f.children[0]!.id, threadId: recovery.threadId };
  };
  const released = async (threadId: string, childId: string) => {
    const current = await stats();
    assert.equal(current.threadStarts.length, 1);
    assert.ok(current.turnStartRequests.every((r) => r.threadId === threadId));
    assert.equal(current.active.length, 0);
    assert.equal(current.writerConflicts, 0);
    assert.deepEqual(current.unsubscribes, [threadId]);
    assert.deepEqual(f.subscriptionsReleased, [threadId]);
    assert.deepEqual(f.rawDisposals, [childId]);
    assert.equal(f.runtime.recoverableRuns.size, 0);
    assert.equal(f.runtime.codexChildSessions.size, 0);
    assert.equal(f.runtime.activeTurns.size, 0);
    assert.equal(begins, 1);
    assert.equal(ends, 1);
    const events = f.children[0]!.snapshotEvents();
    const starts = events.filter((event: any) => event.type === "turn/start") as any[];
    const finishes = events.filter((event: any) => event.type === "turn/end") as any[];
    assert.deepEqual(starts.map((event) => event.data.turn), Array.from({ length: starts.length }, (_, i) => i + 1));
    assert.deepEqual(finishes.map((event) => event.data.turn), starts.map((event) => event.data.turn),
      "Continuation preserves a balanced, sequential native child conversation");
    return current;
  };
  const finalChildText = () => {
    const messages = f.children[0]!.snapshotEvents().filter((event: any) => event.type === "assistant/message") as any[];
    return messages.at(-1)?.data.message.content.find((block: any) => block.type === "text")?.text;
  };
  const processStarts = async () => (await readFile(processLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { kind: string; processId: number }).filter((line) => line.kind === "start");
  return { ...f, control, configure, stats, config, exec, start, outcome, counts, waiting, released, finalChildText, processStarts,
    get begins() { return begins; }, get ends() { return ends; },
    async close() { await f.close(); f.client.beginRound = begin; f.client.endRound = end; } };
}

test("manual Planner continuation cannot renew its original automatic budget", async (t) => {
  const f = await fixture();
  try {
    await f.configure({ visible: [{ kind: "failed" }, { kind: "failed" }, { kind: "failed" }] });
    const first = await f.start();
    const original = await f.waiting(first);
    assert.equal(original.current.visibleTurns, 2);
    const manual = await f.manager.resume(first.id, "Continue the original unfinished planning in this conversation.", f.exec());
    const second = await f.stats();
    t.diagnostic(JSON.stringify({ stage: "first manual", ...await f.counts(), phase: manual.phase, processState: manual.processState }));
    assert.equal(second.visibleTurns, 3, "The failed manual call cannot silently send a fourth model turn");
    await f.waiting(manual);
    assert.equal(f.runtime.recoverableRuns.get(first.id)?.threadId, original.threadId);
    assert.equal(f.runtime.recoverableRuns.get(first.id)?.child?.id, original.childId);
    const success = await f.manager.resume(first.id, "Continue the same original planning once more.", f.exec());
    assert.equal(success.id, first.id);
    assert.equal(success.phase, "executing");
    const final = await f.released(original.threadId, original.childId);
    assert.equal(final.visibleTurns, 4);
    assert.equal(final.turnStartRequests.filter((r) => r.scope === "status").length, 1);
    assert.equal(f.finalChildText(), PLAN);
    const starts = f.children[0]!.snapshotEvents().filter((event: any) => event.type === "turn/start");
    assert.equal(starts.length, 4);
  } finally { await f.close(); }
});

test("completed readable Planner survives two conversion model failures and resumes only conversion", async (t) => {
  const f = await fixture();
  try {
    await f.configure({ status: [{ kind: "failed" }, { kind: "failed" }] });
    const result = await f.outcome(f.start());
    t.diagnostic(JSON.stringify({ ...await f.counts(), error: result.error instanceof Error ? result.error.message : undefined }));
    assert.ok(result.record, "A recoverable conversion returns its original waiting workflow");
    const original = await f.waiting(result.record);
    assert.equal(original.current.visibleTurns, 1);
    assert.equal(original.current.turnStartRequests.filter((r) => r.scope === "status").length, 2);
    const success = await f.manager.resume(undefined, "Continue only original conversion", f.exec());
    assert.equal(success.id, result.record.id);
    assert.equal(success.phase, "executing");
    const final = await f.released(original.threadId, original.childId);
    assert.equal(final.visibleTurns, 1, "A completed visible plan is never repeated during private recovery");
    assert.equal(final.turnStartRequests.filter((r) => r.scope === "status").length, 3);
    const conversions = final.turnStartRequests.filter((r) => r.scope === "status");
    assert.ok(conversions[0]?.prompt?.includes(PLAN));
    assert.ok(conversions.slice(1).every((r) => !r.prompt?.includes(PLAN)),
      "Failed-stage continuation reuses its original thread context rather than retransmitting the plan");
    assert.equal(f.finalChildText(), PLAN);
  } finally { await f.close(); }
});

test("conversion after a successful controlled completion resumes without repeating the acknowledgement or completion", async (t) => {
  const f = await fixture();
  try {
    await f.configure({ visible: [{ text: ACK }, { text: PLAN }], status: [ready(ACK), { kind: "failed" }, { kind: "failed" }] });
    const result = await f.outcome(f.start());
    t.diagnostic(JSON.stringify({ ...await f.counts(), error: result.error instanceof Error ? result.error.message : undefined }));
    assert.ok(result.record);
    const original = await f.waiting(result.record);
    assert.equal(original.current.visibleTurns, 2);
    assert.equal(original.current.turnStartRequests.filter((r) => r.scope === "status").length, 3);
    const success = await f.manager.resume(result.record.id, "Continue only the failed conversion of the completed plan", f.exec());
    assert.equal(success.phase, "executing");
    assert.equal(success.planMarkdown, PLAN);
    const final = await f.released(original.threadId, original.childId);
    assert.equal(final.visibleTurns, 2);
    assert.equal(final.turnStartRequests.filter((r) => r.scope === "status").length, 4);
    assert.equal(final.turnStartRequests.filter((r) => r.scope === "status" && r.prompt?.includes(PLAN)).length, 1,
      "Only the original conversion of the successful completion sends that visible plan");
    assert.equal(f.finalChildText(), PLAN, "The native child ends with the actual plan, never its initial acknowledgement");
  } finally { await f.close(); }
});

test("successful controlled completion publishes the actual plan as the native child's final answer", async (t) => {
  const f = await fixture();
  try {
    await f.configure({ visible: [{ text: ACK }, { text: PLAN }], status: [ready(ACK)] });
    const success = await f.start();
    const current = await f.stats();
    t.diagnostic(JSON.stringify({ ...await f.counts(), finalActualPlan: f.finalChildText() === PLAN }));
    assert.equal(success.phase, "executing");
    assert.equal(success.planMarkdown, PLAN);
    assert.equal(current.visibleTurns, 2);
    assert.equal(current.turnStartRequests.filter((r) => r.scope === "status").length, 2);
    await f.released(current.threadStarts[0]!.threadId, f.children[0]!.id);
    assert.equal(f.finalChildText(), PLAN);
  } finally { await f.close(); }
});

test("a failed controlled completion resumes only completion without repeating its successful initial conversion", async (t) => {
  const f = await fixture();
  try {
    await f.configure({ visible: [{ text: ACK }, { kind: "failed" }, { kind: "failed" }, { text: PLAN }], status: [ready(ACK)] });
    const result = await f.outcome(f.start());
    t.diagnostic(JSON.stringify({ ...await f.counts(), error: result.error instanceof Error ? result.error.message : undefined }));
    assert.ok(result.record);
    const original = await f.waiting(result.record);
    assert.equal(original.current.visibleTurns, 3);
    assert.equal(original.current.turnStartRequests.filter((r) => r.scope === "status").length, 1);
    const success = await f.manager.resume(result.record.id, "Continue only the original unfinished completion", f.exec());
    assert.equal(success.phase, "executing");
    const final = await f.released(original.threadId, original.childId);
    assert.equal(final.visibleTurns, 4);
    const conversions = final.turnStartRequests.filter((r) => r.scope === "status");
    assert.equal(conversions.length, 2, "Only the original ACK conversion and the final plan conversion run");
    assert.equal(conversions.filter((r) => r.prompt?.includes(ACK)).length, 1);
    assert.equal(f.finalChildText(), PLAN);
  } finally { await f.close(); }
});

for (const target of ["visible", "conversion", "completion"] as const) {
  test(`a successful ${target} receipt survives caller abort before the next workflow step`, async (t) => {
    const f = await fixture();
    const caller = new AbortController();
    const normalize = f.client.normalizeInFork;
    const turn = f.client.startTurn;
    let tripped = false;
    let visible = 0;
    try {
      if (target === "visible" || target === "completion") {
        if (target === "completion") await f.configure({ visible: [{ text: ACK }, { text: PLAN }], status: [ready(ACK)] });
        f.client.startTurn = async (...args) => {
          if (args[1].planMode) visible += 1;
          const result = await turn.apply(f.client, args);
          if (!tripped && args[1].planMode && visible === (target === "completion" ? 2 : 1)
            && result.kind === "completed" && result.status === "completed") {
            tripped = true;
            caller.abort(new Error("operation aborted"));
          }
          return result;
        };
      } else {
        f.client.normalizeInFork = async (...args) => {
          const result = await normalize.apply(f.client, args);
          if (!tripped && result.kind === "completed" && result.status === "completed") {
            tripped = true;
            caller.abort(new Error("operation aborted"));
          }
          return result;
        };
      }
      const waiting = await f.manager.start({ task: TASK }, f.exec(caller.signal));
      assert.equal(tripped, true, "Abort is injected only after the actual successful SDK response");
      const original = await f.waiting(waiting);
      assert.equal(original.current.visibleTurns, target === "completion" ? 2 : 1);
      assert.equal(original.current.turnStartRequests.filter((request) => request.scope === "status").length, target === "visible" ? 0 : 1);
      const before = await f.counts();
      const success = await f.manager.resume(waiting.id, "Continue only the unfinished original stage", f.exec());
      assert.equal(success.phase, "executing");
      const final = await f.released(original.threadId, original.childId);
      assert.equal(final.visibleTurns, original.current.visibleTurns, "A completed visible stage is not replayed after its receipt");
      if (target === "conversion") {
        assert.deepEqual(final.turnStartRequests, original.current.turnStartRequests,
          "A valid cached conversion can commit after manual resume with zero additional model calls");
      } else {
        assert.equal(final.turnStartRequests.filter((request) => request.scope === "status").length, target === "visible" ? 1 : 2,
          "Only conversion of the already completed actual plan remains");
        assert.equal(final.turnStartRequests.length, original.current.turnStartRequests.length + 1);
      }
      assert.equal(f.finalChildText(), PLAN);
      t.diagnostic(JSON.stringify({ target, before, after: await f.counts(), finalActualPlan: f.finalChildText() === PLAN }));
    } finally { f.client.normalizeInFork = normalize; f.client.startTurn = turn; await f.close(); }
  });
}

test("an unconfirmed private Planner conversion blocks continuation until the original pair is acknowledged", async (t) => {
  const f = await fixture({ timeoutMs: 180 });
  try {
    await f.configure({ status: [{ kind: "hold" }] });
    await f.control("fixture/setInterruptMode", { mode: "failed" });
    const result = await f.outcome(f.start());
    assert.ok(result.record);
    const original = await f.waiting(result.record);
    const pair = original.current.active[0];
    assert.ok(pair);
    assert.equal(pair.threadId, original.threadId, "Ephemeral Planner conversion stays on its original thread");
    assert.equal(original.current.visibleTurns, 1);
    assert.equal(original.current.turnStartRequests.length, 2);
    const before = f.store.coordinationHandle.loadWorkflow(result.record.id);
    await assert.rejects(f.manager.resume(result.record.id, "Continue only original conversion", f.exec()), /unconfirmed|not.*confirmed/i);
    const blocked = await f.stats();
    assert.deepEqual(blocked.turnStartRequests, original.current.turnStartRequests);
    assert.deepEqual(blocked.active, [pair]);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(result.record.id), before,
      "Failed cleanup cannot change the actual waiting row or admit another writer");
    assert.ok(blocked.interrupts.every((interrupt) => interrupt.threadId === pair.threadId && interrupt.turnId === pair.turnId));
    await f.control("fixture/setInterruptMode", { mode: "confirmed" });
    const success = await f.manager.resume(result.record.id, "Continue only original conversion", f.exec());
    assert.equal(success.phase, "executing");
    const final = await f.released(original.threadId, original.childId);
    assert.equal(final.visibleTurns, 1);
    assert.equal(final.turnStartRequests.filter((r) => r.scope === "status").length, 2);
    assert.ok(final.interrupts.every((interrupt) => interrupt.threadId === pair.threadId && interrupt.turnId === pair.turnId));
    t.diagnostic(JSON.stringify({ originalPair: pair, interrupts: final.interrupts, ...await f.counts() }));
  } finally { await f.close(); }
});

for (const message of ["permission denied", "invalid output schema: schema validation failed", "401 Unauthorized: stream disconnected"]) {
  test(`private Planner ${message} is terminal and sends no automatic continuation`, async () => {
    const f = await fixture();
    try {
      await f.configure({ status: [{ kind: "rpc-error", message }] });
      const result = await f.outcome(f.start());
      const row = (await f.store.list())[0];
      assert.ok(row);
      assert.equal(row.phase, "failed");
      assert.equal(row.planMarkdown, undefined);
      assert.equal(f.runtime.recoverableRuns.size, 0);
      const before = await f.stats();
      assert.equal(before.visibleTurns, 1);
      assert.equal(before.turnStartRequests.filter((r) => r.scope === "status").length, 1);
      assert.ok(result.error || result.record?.phase === "failed");
      await assert.rejects(f.manager.resume(row.id, undefined, f.exec()), /no.*continuation|not.*waiting|unavailable/i);
      const after = await f.released(before.threadStarts[0]!.threadId, f.children[0]!.id);
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    } finally { await f.close(); }
  });
}

for (const contract of ["malformed conversion JSON", "visible JSON envelope"] as const) {
  test(`Planner ${contract} remains terminal rather than being model-retried`, async () => {
    const f = await fixture();
    try {
      await f.configure(contract === "malformed conversion JSON" ? { status: [{ text: "{" }] }
        : { visible: [{ text: JSON.stringify(ready().result) }] });
      await f.outcome(f.start());
      const row = (await f.store.list())[0];
      assert.equal(row?.phase, "failed");
      const current = await f.stats();
      assert.equal(current.visibleTurns, 1);
      assert.equal(current.turnStartRequests.filter((r) => r.scope === "status").length,
        contract === "malformed conversion JSON" ? 1 : 0);
      await f.released(current.threadStarts[0]!.threadId, f.children[0]!.id);
    } finally { await f.close(); }
  });
}

test("a lost original Planner process cannot spawn a replacement while its private checkpoint is waiting", async (t) => {
  const f = await fixture();
  try {
    await f.configure({ status: [{ kind: "failed" }, { kind: "failed" }] });
    const result = await f.outcome(f.start());
    assert.ok(result.record);
    const original = await f.waiting(result.record);
    const before = f.store.coordinationHandle.loadWorkflow(result.record.id);
    assert.equal((await f.processStarts()).length, 1);
    await f.control("fixture/exit");
    await sharedWaitFor(() => !f.client.isThreadAvailable(original.threadId), "the authoritative original backend exit");
    await assert.rejects(f.manager.resume(result.record.id, "Continue original conversion", f.exec()), /lost.*thread|unavailable/i);
    assert.equal((await f.processStarts()).length, 1, "Resume cannot respawn the SDK to imitate an ephemeral checkpoint");
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(result.record.id), before);
    assert.equal(f.children.length, 1);
    assert.equal(f.rawDisposals.length, 0, "Unavailable identity stays explicit until lifecycle cleanup");
    t.diagnostic(JSON.stringify({ originalProcessId: original.current.processId, processStarts: await f.processStarts() }));
    await f.client.stop();
    await f.manager.stop();
    assert.equal((await f.processStarts()).length, 1, "Lifecycle cleanup also cannot revive the retired process");
    assert.deepEqual(f.rawDisposals, [original.childId]);
    assert.equal(f.ends, 1);
  } finally { await f.close(); }
});

for (const field of ["task", "cwd", "dshSessionId", "createdAt", "mode", "planMarkdown", "reviewCycles"] as const) {
  test(`a private Planner checkpoint rejects displaced ${field} scope without a model or row write`, async () => {
    const f = await fixture();
    try {
      await f.configure({ status: [{ kind: "failed" }, { kind: "failed" }] });
      const result = await f.outcome(f.start());
      assert.ok(result.record);
      await f.waiting(result.record);
      await f.store.update(result.record.id, (record) => {
        if (field === "task") record.task = "A different unrelated task";
        else if (field === "cwd") record.cwd = join(f.directory, "different-workspace");
        else if (field === "dshSessionId") record.dshSessionId = "unrelated-session";
        else if (field === "createdAt") record.createdAt = "2026-01-01T00:00:00.000Z";
        else if (field === "mode") record.mode = "review_only";
        else if (field === "planMarkdown") record.planMarkdown = PLAN;
        else record.reviewCycles += 1;
      });
      const row = f.store.coordinationHandle.loadWorkflow(result.record.id);
      const before = await f.stats();
      await assert.rejects(f.manager.resume(result.record.id, "Continue only original conversion", f.exec()));
      const after = await f.stats();
      assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
      assert.deepEqual(after.threadStarts, before.threadStarts);
      assert.deepEqual(f.store.coordinationHandle.loadWorkflow(result.record.id), row);
      assert.equal(f.children.length, 1);
      assert.equal(f.rawDisposals.length, 0);
    } finally { await f.close(); }
  });
}

test("a stored Planner stage marker cannot fabricate a missing in-memory completed output", async () => {
  const f = await fixture();
  try {
    await f.configure({ status: [{ kind: "failed" }, { kind: "failed" }] });
    const result = await f.outcome(f.start());
    assert.ok(result.record);
    const original = await f.waiting(result.record);
    assert.ok(result.record.retryState?.plannerCheckpoint);
    delete original.recovery.plannerCheckpoint;
    const row = f.store.coordinationHandle.loadWorkflow(result.record.id);
    const before = await f.stats();
    await assert.rejects(f.manager.resume(result.record.id, "Continue original conversion", f.exec()), /checkpoint|handle|unavailable/i);
    const after = await f.stats();
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(result.record.id), row);
    assert.equal(f.children.length, 1);
  } finally { await f.close(); }
});

test("an intentionally omitted Planner model and its effort remain frozen while global defaults change", async () => {
  const f = await fixture({ noCatalog: true });
  try {
    f.config.plannerEffort = "medium";
    await f.configure({ visible: [{ kind: "failed" }, { kind: "failed" }] });
    const result = await f.start();
    const original = await f.waiting(result);
    assert.equal(result.plannerModel, undefined, "The real protocol exposes no default or collaboration model");
    assert.equal(result.plannerEffort, "medium");
    f.config.plannerModel = "new-global-model";
    f.config.plannerEffort = "high";
    const success = await f.manager.resume(result.id, "Continue the original planning", f.exec());
    assert.equal(success.phase, "executing");
    const final = await f.released(original.threadId, original.childId);
    const visible = final.turnStartRequests.filter((r) => r.scope === "visible");
    assert.equal(visible.length, 3);
    assert.ok(visible.every((r) => r.model === undefined && r.collaborationModel === undefined && r.effort === "medium"));
    assert.ok(final.turnStartRequests.every((r) => r.model === undefined && r.collaborationModel === undefined));
    assert.equal(final.turnStartRequests.find((r) => r.scope === "status")?.effort, "low");
    assert.equal(success.plannerModel, undefined);
    assert.equal(success.plannerEffort, "medium");
  } finally { await f.close(); }
});

test("deleting a parked Planner's resolved model cannot restore its original omitted choice", async (t) => {
  const f = await fixture();
  try {
    f.config.plannerModel = "";
    await f.configure({ visible: [{ kind: "failed" }, { kind: "failed" }] });
    const waiting = await f.start();
    const original = await f.waiting(waiting);
    const checkpoint = original.recovery.plannerCheckpoint;
    assert.ok(checkpoint);
    assert.equal(original.current.threadStarts[0]?.model, undefined, "Admission genuinely omitted a model on the wire");
    assert.equal(original.current.turnStartRequests[0]?.model, undefined);
    assert.equal(original.current.turnStartRequests[0]?.collaborationModel, "model-A",
      "The real SDK resolves the actual Plan-mode model through the local protocol catalog");
    assert.equal(checkpoint.admittedModel, undefined);
    assert.equal(checkpoint.settings.model, "model-A");
    assert.equal(waiting.plannerModel, "model-A");
    await f.store.update(waiting.id, (record) => { delete record.plannerModel; });
    const row = f.store.coordinationHandle.loadWorkflow(waiting.id);
    const before = await f.stats();
    const status = await f.manager.status(waiting.id, f.exec());
    assert.deepEqual(status.continuation, { available: false, reason: "identity_changed" });
    await assert.rejects(f.manager.resume(waiting.id, "Continue only original planning", f.exec()), /checkpoint|scope|choice/i);
    const after = await f.stats();
    assert.deepEqual(after.turnStartRequests, before.turnStartRequests);
    assert.deepEqual(after.threadStarts, before.threadStarts);
    assert.deepEqual(f.store.coordinationHandle.loadWorkflow(waiting.id), row,
      "Rejected recovery cannot change the durable row or its actual revision");
    assert.equal(f.runtime.recoverableRuns.get(waiting.id), original.recovery);
    assert.equal(f.runtime.codexChildSessions.get(waiting.id)?.id, original.childId);
    assert.equal(f.rawDisposals.length, 0);
    assert.equal(f.begins, 1);
    assert.equal(f.ends, 0);
    t.diagnostic(JSON.stringify({ admittedModel: checkpoint.admittedModel, resolvedModel: checkpoint.settings.model,
      continuation: status.continuation, visible: after.visibleTurns, threadStarts: after.threadStarts.length,
      children: f.children.length, rowUnchanged: true, originalPinRetained: f.ends === 0 }));
  } finally { await f.close(); }
});

for (const action of ["cancel", "stop"] as const) {
  test(`${action} releases a waiting original Planner checkpoint exactly once`, async () => {
    const f = await fixture();
    try {
      await f.configure({ status: [{ kind: "failed" }, { kind: "failed" }] });
      const result = await f.outcome(f.start());
      assert.ok(result.record);
      const original = await f.waiting(result.record);
      if (action === "cancel") await f.manager.cancel(result.record.id, f.exec());
      else await f.manager.stop();
      const first = await f.released(original.threadId, original.childId);
      await f.manager.stop();
      const second = await f.stats();
      assert.deepEqual(second.turnStartRequests, first.turnStartRequests);
      assert.deepEqual(second.unsubscribes, first.unsubscribes);
      assert.deepEqual(f.rawDisposals, [original.childId]);
      assert.equal(f.ends, 1);
    } finally { await f.close(); }
  });
}

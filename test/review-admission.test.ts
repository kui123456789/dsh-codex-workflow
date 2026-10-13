import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewInput, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway, type ManagerLease } from "../src/workflow.js";

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { enter = resolve; });
  return { promise, started, enter, release };
}

const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The implementation satisfies the approved task.";
class Gateway implements CodexGateway {
  readonly holds: ReturnType<typeof gate>[] = [];
  readonly reviewers: string[] = [];
  readonly visible: Array<{ threadId: string; api: "review" | "turn"; signal?: AbortSignal }> = [];
  readonly released: string[] = [];
  readonly children: Session[] = [];
  pins = 0;
  ignoreSignal = false;
  normalizationFailures = 0;
  failures = 0;
  modelGate?: ReturnType<typeof gate>;
  private turns = 0;
  async startThread(): Promise<string> { return `private-${++this.turns}`; }
  async startReviewerThread(): Promise<string> { const id = `reviewer-${this.reviewers.length + 1}`; this.reviewers.push(id); return id; }
  async resumeThread(): Promise<void> { throw new Error("unexpected thread resume"); }
  async continueTurn(): Promise<TurnWaitResult> { throw new Error("unexpected clarification"); }
  beginRound(): void { this.pins += 1; }
  endRound(): void { this.pins -= 1; }
  async unsubscribeThread(id: string): Promise<void> { this.released.push(id); }
  async interrupt(): Promise<void> {}
  async resolveDefaultModel(): Promise<string | undefined> {
    if (this.modelGate) { this.modelGate.enter(); await this.modelGate.promise; }
    return undefined;
  }
  async startReview(options: Parameters<CodexGateway["startReview"]>[0], signal?: AbortSignal) {
    return { threadId: options.threadId, result: await this.run(options.threadId, options, "review", signal) };
  }
  async startTurn(threadId: string, options: Parameters<CodexGateway["startTurn"]>[1], signal?: AbortSignal) {
    return this.run(threadId, options, "turn", signal);
  }
  private async run(threadId: string, options: Pick<Parameters<CodexGateway["startTurn"]>[1], "onStarted" | "onProgress">,
    api: "review" | "turn", signal?: AbortSignal): Promise<TurnWaitResult> {
    const turnId = `visible-${++this.turns}`;
    this.visible.push({ threadId, api, signal });
    await options.onStarted?.({ threadId, turnId });
    const hold = this.holds[0];
    if (hold) {
      hold.enter();
      if (this.ignoreSignal || !signal) await hold.promise;
      else {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(signal.reason ?? new Error("operation aborted"));
          signal.addEventListener("abort", aborted, { once: true });
          void hold.promise.then(() => { signal.removeEventListener("abort", aborted); resolve(); });
        });
      }
    }
    if (this.failures > 0) {
      this.failures -= 1;
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    options.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
    return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
  }
  async normalizeInFork(options: Parameters<CodexGateway["normalizeInFork"]>[0]): Promise<TurnWaitResult> {
    if (this.normalizationFailures > 0) { this.normalizationFailures -= 1; throw new Error("normalization contract failure"); }
    const text = options.prompt.includes("REVIEW AUTHORITY checker")
      ? JSON.stringify({ aligned: true, conflicts: [] })
      : JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "The approved requirements are verified." });
    return { kind: "completed", threadId: options.threadId, turnId: `private-${++this.turns}`, status: "completed", text };
  }
}

async function fixture(t: TestContext, options: { maxReviewCycles?: number; leaseTtlMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-review-admission-"));
  await writeFile(join(directory, "implementation.txt"), "health check implementation", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const managers: WorkflowManager[] = [];
  const stores = [store];
  const gateway = new Gateway();
  const childDisposals: string[] = [];
  const config: WorkflowConfig = {
    codexCommand: "unused", autoTriggerMode: "complex", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: options.maxReviewCycles ?? 1,
    maxNoChangeReviewRounds: 2, reviewDiffMaxBytes: 65_536, bridgePollMs: 1_000,
    bridgeMaxPayloadBytes: 1_048_576, callbackTimeoutMs: 1_000, callbackMaxAttempts: 1,
    callbackRetryBaseMs: 1, transientRetryBaseMs: 1, transientRetryMaxMs: 1,
    transientRetryBudgetMs: 0, transientRetryJitterRatio: 0, leaseTtlMs: options.leaseTtlMs ?? 10_000,
    turnTimeoutMs: 1_000, idleProcessMs: 0, terminalRelayTimeoutMs: 1_000, storageDir: store.directory,
  };
  const createManager = (shared = false) => {
    const managerStore = shared ? new WorkflowStore(store.directory) : store;
    if (shared) stores.push(managerStore);
    let provider: SubagentProvider;
    const childFactory = new CodexChildSessionFactory({ create: async (request: { sessionId: ReturnType<typeof SessionId>; signal: AbortSignal }) => {
      request.signal.throwIfAborted();
      const session = Session.create(request.sessionId, [], {
        version: SESSION_FORMAT_VERSION, id: request.sessionId, createdAt: Date.now(), cwd: directory,
        parentSession: SessionId("owner"), origin: "subagent", delegationDepth: 1, isSeeded: false,
      });
      gateway.children.push(session);
      return { agent: { id: session.id, session }, dispose: async () => { childDisposals.push(session.id); } };
    } } as never, {
      registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
      start(name: string, request: object) {
        return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name }) } as never);
      },
    } as never);
    const manager = new WorkflowManager(managerStore, gateway, config, undefined, undefined, undefined, {}, undefined, childFactory);
    managers.push(manager);
    return manager;
  };
  const manager = createManager();
  const seed = async (id = "workflow", owner = "owner", patch: Partial<WorkflowRecord> = {}) => {
    const record: WorkflowRecord = {
      schemaVersion: 1, id, dshSessionId: owner, cwd: directory, task: "Implement a local health check",
      phase: "executing", mode: "planned", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      planMarkdown: "# Goal\nImplement a read-only health check.\n# Verification\nValidate missing and valid configuration.",
      assumptions: [], questions: [], reviewCycles: 0, ...patch,
    };
    await store.save(record);
    return record;
  };
  await seed();
  const exec = (owner = "owner", controller = new AbortController()) => ({
    agent: { id: owner, session: Session.create(SessionId(owner), [], {
      version: SESSION_FORMAT_VERSION, id: SessionId(owner), createdAt: Date.now(), cwd: directory, isSeeded: false,
    }) }, signal: controller.signal, deferContext() {},
  } as unknown as ToolRunContext);
  const input: ReviewInput = { implementationSummary: "Read-only health check implemented", changedFiles: ["implementation.txt"], testResults: "Passed locally" };
  t.after(async () => {
    for (const hold of gateway.holds) hold.release();
    gateway.modelGate?.release();
    await Promise.allSettled(managers.map((entry) => entry.stop()));
    for (const entry of stores) entry.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return { store, manager, createManager, seed, gateway, childDisposals, config, exec, input };
}

test("concurrent identical reviews share one original Reviewer and cannot exceed one review cycle", async (t) => {
  const f = await fixture(t);
  const hold = gate(); f.gateway.holds.push(hold);
  const first = f.manager.review("workflow", f.input, f.exec());
  const second = f.manager.review("workflow", { ...f.input, changedFiles: [...f.input.changedFiles!] }, f.exec());
  await hold.started;
  hold.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(f.gateway.reviewers.length, 1, "only one fresh Reviewer may be created for concurrent admission");
  assert.equal(f.gateway.children.length, 1);
  assert.equal(a.reviewCycles, 1);
  assert.deepEqual(b, a);
  assert.equal((await f.store.load("workflow"))?.reviewCycles, 1);
});

test("ownership is checked before joining an admitted review", async (t) => {
  const f = await fixture(t);
  const hold = gate(); f.gateway.holds.push(hold);
  const first = f.manager.review("workflow", f.input, f.exec());
  await hold.started;
  await assert.rejects(f.manager.review("workflow", f.input, f.exec("foreign")), /belongs to another DSH session/);
  hold.release();
  await first;
  assert.equal(f.gateway.reviewers.length, 1);
});

test("a different input is refused while the original review is admitted", async (t) => {
  const f = await fixture(t);
  const hold = gate(); f.gateway.holds.push(hold);
  const first = f.manager.review("workflow", f.input, f.exec());
  await hold.started;
  await assert.rejects(f.manager.review("workflow", { ...f.input, testResults: "Changed verification" }, f.exec()), /different.*input/);
  hold.release();
  await first;
  assert.equal(f.gateway.reviewers.length, 1);
});

test("a different new-round intent cannot join an admitted review with identical material", async (t) => {
  const f = await fixture(t);
  const hold = gate(); f.gateway.holds.push(hold);
  const first = f.manager.review("workflow", f.input, f.exec());
  await hold.started;
  try {
    const result = Promise.allSettled([f.manager.review("workflow", { ...f.input, newReviewRound: true }, f.exec())]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    hold.release();
    const outcome = (await result)[0]!;
    assert.equal(outcome.status, "rejected", "An independent round must not join the original run");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /different.*input|different.*intent/);
    assert.equal(f.gateway.reviewers.length, 1);
    assert.equal(f.gateway.children.length, 1);
  } finally { hold.release(); await first; }
});

test("invalid new-round intent is refused before creating review resources", async (t) => {
  const f = await fixture(t);
  const before = await f.store.load("workflow");
  await assert.rejects(f.manager.review("workflow", { ...f.input, newReviewRound: "true" } as never, f.exec()), /newReviewRound must be a boolean/);
  assert.deepEqual(await f.store.load("workflow"), before);
  assert.equal(f.gateway.reviewers.length, 0);
  assert.equal(f.gateway.children.length, 0);
});

test("review cycle budget is checked before creating a child or model thread", async (t) => {
  const f = await fixture(t);
  await f.store.update("workflow", (record) => { record.reviewCycles = 1; record.phase = "fixing"; });
  await assert.rejects(f.manager.review("workflow", f.input, f.exec()), /review cycle.*limit|review cycle.*budget/);
  assert.equal(f.gateway.reviewers.length, 0);
  assert.equal(f.gateway.children.length, 0);
});

test("separate Managers sharing SQLite cannot admit two original Reviewers for one workflow", async (t) => {
  const f = await fixture(t);
  const other = f.createManager(true);
  const hold = gate(); f.gateway.holds.push(hold);
  const first = f.manager.review("workflow", f.input, f.exec());
  await hold.started;
  const lease = f.store.coordinationHandle.leaseInfo("review:workflow");
  assert.ok(lease?.owner, "the active original Reviewer holds a real SQLite admission lease");
  await assert.rejects(other.review("workflow", f.input, f.exec()), /admitted review|cannot be reviewed/);
  assert.equal(f.store.coordinationHandle.leaseInfo("review:workflow")?.owner, lease.owner);
  hold.release();
  await first;
  assert.equal(f.gateway.reviewers.length, 1);
  assert.equal((await f.store.load("workflow"))?.reviewCycles, 1);
});

type ManagerInternals = {
  acquireLease(resource: string): Promise<ManagerLease | undefined>;
  runtime: { reviewFlights: Map<string, Promise<WorkflowRecord>>; reviewControllers: Map<string, AbortController> };
};

function delayAdmission(manager: WorkflowManager) {
  const hold = gate();
  const internal = manager as unknown as ManagerInternals;
  const acquire = internal.acquireLease.bind(manager);
  internal.acquireLease = async (resource) => {
    const lease = await acquire(resource);
    hold.enter();
    await hold.promise;
    return lease;
  };
  return hold;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("test boundary was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("admission rereads the review budget after acquiring the shared lease", async (t) => {
  const f = await fixture(t);
  const hold = delayAdmission(f.manager);
  const run = f.manager.review("workflow", f.input, f.exec());
  const rejected = assert.rejects(run, /review cycle limit/);
  await hold.started;
  await f.store.update("workflow", (record) => { record.phase = "fixing"; record.reviewCycles = 1; });
  hold.release();
  await rejected;
  assert.equal(f.gateway.children.length, 0);
  assert.equal(f.gateway.reviewers.length, 0);
});

test("stop during admission waits for the admitted task and creates no child", async (t) => {
  const f = await fixture(t);
  const hold = delayAdmission(f.manager);
  const run = f.manager.review("workflow", f.input, f.exec());
  const rejected = assert.rejects(run, /aborted|teardown|stopped/);
  await hold.started;
  let stopped = false;
  const stopping = f.manager.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop cannot return before admission has settled");
  hold.release();
  await Promise.all([stopping, rejected]);
  assert.equal(f.gateway.children.length, 0);
  assert.equal(f.gateway.reviewers.length, 0);
  assert.equal((f.manager as unknown as ManagerInternals).runtime.reviewFlights.size, 0);
});

test("cancel aborts one admitted review, preserves the terminal record and cleans its child once", async (t) => {
  const f = await fixture(t);
  const hold = gate(); f.gateway.holds.push(hold);
  const run = f.manager.review("workflow", f.input, f.exec());
  await hold.started;
  const cancelled = await f.manager.cancel("workflow", f.exec());
  assert.equal(cancelled.phase, "cancelled");
  assert.equal((await run).phase, "cancelled");
  const record = await f.store.load("workflow");
  assert.equal(record?.reviewCycles, 0);
  assert.equal(record?.latestReview, undefined);
  assert.equal(f.gateway.pins, 0);
  assert.equal(f.childDisposals.length, 1);
  assert.equal((f.manager as unknown as ManagerInternals).runtime.reviewFlights.size, 0);
});

test("lease contention creates no model or child and a later fresh admission can succeed", async (t) => {
  const f = await fixture(t);
  const coordination = f.store.coordinationHandle;
  const grant = coordination.acquireLease("review:workflow", 10_000, "another-process");
  assert.ok(grant);
  const before = await f.store.load("workflow");
  await assert.rejects(f.manager.review("workflow", f.input, f.exec()), /admitted review in another manager/);
  assert.equal(f.gateway.children.length, 0);
  assert.equal(f.gateway.visible.length, 0);
  assert.deepEqual(await f.store.load("workflow"), before);
  assert.equal(coordination.releaseLease("review:workflow", grant.epoch, grant.owner), true);
  assert.equal((await f.manager.review("workflow", f.input, f.exec())).reviewCycles, 1);
});

test("lease loss fences a late model verdict even when the gateway ignores the abort signal", async (t) => {
  const f = await fixture(t);
  f.gateway.ignoreSignal = true;
  const hold = gate(); f.gateway.holds.push(hold);
  const run = f.manager.review("workflow", f.input, f.exec());
  const rejected = assert.rejects(run, /lost its review admission lease/);
  void rejected.catch(() => undefined);
  // Lease takeover is tested after a real model starts. If admission rejects
  // earlier, report that original failure rather than wait forever on a gate.
  await Promise.race([hold.started, run.then(
    () => { throw new Error("Review completed before reaching the held native model"); },
    (error) => { throw error; },
  )]);
  const before = await f.store.load("workflow");
  const coordination = f.store.coordinationHandle;
  const successor = coordination.acquireLease("review:workflow", 10_000, "successor", Date.now() + f.config.leaseTtlMs! + 1);
  assert.ok(successor, "the test replaces the real SQLite lease epoch and owner");
  await waitFor(() => f.gateway.visible[0]?.signal?.aborted === true);
  hold.release();
  await rejected;
  assert.deepEqual(await f.store.load("workflow"), before, "the stale owner cannot persist a verdict, failure or continuation state");
  assert.equal(coordination.leaseInfo("review:workflow")?.owner, successor.owner, "stale release cannot clear the successor's lease");
  assert.equal(f.gateway.children.length, 1);
  assert.equal(f.gateway.reviewers.length, 1);
  assert.equal(f.childDisposals.length, 1);
  assert.equal(f.gateway.pins, 0);
});

test("different workflows can execute independent reviews concurrently", async (t) => {
  const f = await fixture(t);
  await f.seed("other", "other-owner");
  const hold = gate(); f.gateway.holds.push(hold);
  const first = f.manager.review("workflow", f.input, f.exec());
  const second = f.manager.review("other", f.input, f.exec("other-owner"));
  await waitFor(() => f.gateway.visible.length === 2);
  hold.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((record) => record.reviewCycles), [1, 1]);
  assert.equal(f.gateway.reviewers.length, 2);
  assert.equal(f.gateway.children.length, 2);
  assert.equal((f.manager as unknown as ManagerInternals).runtime.reviewFlights.size, 0);
});

test("terminal review admission releases its flight so an explicit new business round can succeed", async (t) => {
  const f = await fixture(t);
  f.gateway.normalizationFailures = 1;
  await assert.rejects(f.manager.review("workflow", f.input, f.exec()), /normalization contract failure/);
  assert.equal((f.manager as unknown as ManagerInternals).runtime.reviewFlights.size, 0);
  assert.equal((await f.store.load("workflow"))?.reviewCycles, 0);
  const row = f.store.coordinationHandle.loadWorkflow("workflow");
  await assert.rejects(f.manager.review("workflow", f.input, f.exec()), /explicitly requested independent review/);
  assert.deepEqual(f.store.coordinationHandle.loadWorkflow("workflow"), row);
  assert.equal(f.gateway.reviewers.length, 1, "Unchanged material cannot silently create a replacement Reviewer");
  assert.equal((await f.manager.review("workflow", { ...f.input, newReviewRound: true }, f.exec())).reviewCycles, 1);
  assert.equal(f.gateway.reviewers.length, 2, "a terminal conversion failure allows a new business review");
});

test("review of a waiting Reviewer resumes its original conversation and refuses replacement inputs", async (t) => {
  const f = await fixture(t);
  f.gateway.failures = 2;
  const waiting = await f.manager.review("workflow", f.input, f.exec());
  assert.equal(waiting.processState, "waiting");
  await assert.rejects(f.manager.review("workflow", { ...f.input, implementationSummary: "Different implementation" }, f.exec()), /waiting Reviewer with different input/);
  const resumed = await f.manager.review("workflow", f.input, f.exec());
  assert.equal(resumed.phase, "passed");
  assert.equal(resumed.reviewCycles, 1);
  assert.equal(f.gateway.reviewers.length, 1);
  assert.equal(f.gateway.children.length, 1);
  assert.equal(f.gateway.visible.at(-1)?.api, "turn");
});

test("reviewOnly keeps separate fresh workflow semantics after each completed review", async (t) => {
  const f = await fixture(t);
  await f.store.update("workflow", (record) => { record.phase = "passed"; });
  const first = await f.manager.reviewOnly(f.input, f.exec());
  const second = await f.manager.reviewOnly(f.input, f.exec());
  assert.notEqual(first.id, second.id);
  assert.equal(first.reviewCycles, 1);
  assert.equal(second.reviewCycles, 1);
  assert.equal(f.gateway.reviewers.length, 2);
  assert.equal(f.gateway.children.length, 2);
});

test("stop waits for the reviewOnly admission prelude and forbids a late new record", async (t) => {
  const f = await fixture(t);
  await f.store.update("workflow", (record) => { record.phase = "passed"; });
  const hold = gate(); f.gateway.modelGate = hold;
  const run = f.manager.reviewOnly(f.input, f.exec());
  const rejected = assert.rejects(run, /stopped|aborted|teardown/);
  await hold.started;
  let stopped = false;
  const stopping = f.manager.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "the pre-admission flow is still part of the manager's foreground work");
  hold.release();
  await Promise.all([stopping, rejected]);
  assert.equal((await f.store.list()).length, 1, "no new review-only workflow can be saved after teardown");
  assert.equal(f.gateway.children.length, 0);
  assert.equal(f.gateway.reviewers.length, 0);
});

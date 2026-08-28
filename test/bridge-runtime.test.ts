import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import { newRequestId, type DispatchPlanCommand, type SubmissionNoticeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { BridgeStore } from "../src/bridge-store.js";
import { BridgeRuntime, BridgeCrashSimulationError, type AgentRegistryLike } from "../src/bridge-runtime.js";
import { collectEvidence } from "../src/evidence.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";
import type { DesktopThreadOpener } from "../src/desktop-thread-opener.js";

async function rmClosed(path: string): Promise<void> {
  // Close only this tree's coordination connections first (Windows locks an
  // open SQLite file); other directories stay untouched. The runtime harness
  // keeps its bridge store under storage/ and the workflow store under
  // workflows/, so close those subgroups plus the root.
  closeCoordinationStoresForDirectory(join(path, "storage"));
  closeCoordinationStoresForDirectory(join(path, "workflows"));
  closeCoordinationStoresForDirectory(join(path, "state"));
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

const config: WorkflowConfig = {
  codexCommand: "codex",
  autoTriggerMode: "complex",
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
  callbackRetryBaseMs: 200,
  turnTimeoutMs: 10_000,
  idleProcessMs: 0,
  terminalRelayTimeoutMs: 60_000,
  storageDir: "",
};

class NoopGateway implements CodexGateway {
  async startThread(): Promise<string> { throw new Error("planner must not run for bridge workflows"); }
  async resumeThread(): Promise<void> { throw new Error("not used"); }
  async startTurn(): Promise<never> { throw new Error("not used"); }
  async continueTurn(): Promise<never> { throw new Error("not used"); }
  async startReview(): Promise<never> { throw new Error("not used"); }
  async normalizeInFork(): Promise<never> { throw new Error("not used"); }
  async interrupt(): Promise<void> { throw new Error("not used"); }
}

interface FakeAgent {
  id: string;
  cwd: string;
  followups: Array<{ text: string; source?: unknown }>;
  cancels: Array<{ cause: unknown; options?: { keepInbox?: boolean } }>;
  status: "idle" | "running";
  startActivity(): void;
  finishActivity(): void;
  agent: Agent;
}

function makeAgent(id: string, cwd: string, followupThrows = 0, hangAfterFollowup = false): FakeAgent {
  const idleWaiters: Array<() => void> = [];
  const fake: FakeAgent = {
    id,
    cwd,
    followups: [],
    cancels: [],
    status: "idle",
    startActivity: () => { fake.status = "running"; },
    finishActivity: () => {
      fake.status = "idle";
      for (const resolvePromise of idleWaiters.splice(0)) resolvePromise();
    },
    agent: undefined as never,
  };
  // The durable session event log: inbox insertions persist as
  // agent/inbox/spliced events carrying the full message with its stable id.
  const events: Array<Record<string, unknown>> = [];
  fake.agent = {
    id,
    session: {
      header: { cwd },
      events,
    },
    get status() { return fake.status; },
    whenIdle: () => fake.status === "idle"
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => idleWaiters.push(resolvePromise)),
    cancel: (cause: unknown, options?: { keepInbox?: boolean }) => {
      fake.cancels.push({ cause, options });
      fake.finishActivity();
    },
    followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => {
      if (followupThrows > 0) {
        followupThrows -= 1;
        throw new Error("session followup temporarily unavailable");
      }
      fake.followups.push({ text: message.content[0]?.text ?? "" });
      events.push({
        type: "agent/inbox/spliced",
        seq: events.length,
        time: Date.now(),
        data: { target: "next-turn", start: 0, deleteCount: 0, inserted: [message] },
      });
      if (hangAfterFollowup) fake.startActivity();
    },
  } as unknown as Agent;
  return fake;
}

class FakeRegistry implements AgentRegistryLike {
  readonly agents = new Map<string, FakeAgent>();
  register(fake: FakeAgent): void {
    this.agents.set(fake.id, fake);
  }
  unregister(id: string): void {
    this.agents.delete(id);
  }
  get(id: string): Agent | undefined {
    return this.agents.get(id)?.agent;
  }
  list(): Agent[] {
    return [...this.agents.values()].map((fake) => fake.agent);
  }
}

interface Harness {
  directory: string;
  store: BridgeStore;
  workflowStore: WorkflowStore;
  manager: WorkflowManager;
  runtime: BridgeRuntime;
  registry: FakeRegistry;
}

async function harness(
  pollMs = 5,
  retryBaseMs = 1_000,
  maxRetryAttempts = 5,
  leaseMs = 60_000,
  terminalRelayTimeoutMs = 60_000,
  desktopOpener: DesktopThreadOpener = { open: async () => undefined },
  workflowConfigOverrides: Partial<WorkflowConfig> = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-"));
  const store = new BridgeStore(join(directory, "storage"), 1024 * 1024, leaseMs);
  await store.init();
  const workflowStore = new WorkflowStore(join(directory, "workflows"));
  const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, ...workflowConfigOverrides, storageDir: directory });
  const registry = new FakeRegistry();
  const runtime = new BridgeRuntime(store, registry, {
    pollMs,
    storageDir: join(directory, "storage"),
    manager,
    workflowStore,
    retryBaseMs,
    maxRetryAttempts,
    terminalRelayTimeoutMs,
    desktopOpener,
    openCodexDesktopOnReview: workflowConfigOverrides.openCodexDesktopOnReview,
    desktopOpenRetryBaseMs: workflowConfigOverrides.desktopOpenRetryBaseMs,
    desktopOpenRetryMaxMs: workflowConfigOverrides.desktopOpenRetryMaxMs,
  });
  return { directory, store, workflowStore, manager, runtime, registry };
}

function dispatch(overrides: Partial<DispatchPlanCommand> = {}): DispatchPlanCommand {
  return {
    version: 1,
    kind: "dispatch_plan",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    codexThreadId: newRequestId(),
    target: { cwd: "C:\\work" },
    task: "实现功能",
    planMarkdown: "<proposed_plan>\n计划\n</proposed_plan>",
    assumptions: [],
    ...overrides,
  };
}

async function waitForReceipt(store: BridgeStore, requestId: string, timeoutMs = 10_000): Promise<import("../src/bridge-store.js").BridgeReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await store.receipt(requestId);
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error(`timed out waiting for receipt ${requestId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Simulate a crash old enough that the claim lease expired: the claim row's
 * lease is zeroed so recovery may reclaim it. */
function expireClaimLease(store: BridgeStore, requestId: string): void {
  store.coordinationHandle.db.prepare("UPDATE queue SET claim_until = 0 WHERE request_id = ?").run(requestId);
}

/** Create a real workspace with one tracked changed file for evidence. */
async function makeWorkspace(directory: string): Promise<string> {
  const workspace = join(directory, "ws");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "a.txt"), "v1", "utf8");
  return workspace;
}

function verdict(overrides: Partial<SubmitVerdictCommand> = {}): SubmitVerdictCommand {
  return {
    version: 1,
    kind: "submit_verdict",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    workflowId: "wf-missing",
    codexThreadId: newRequestId(),
    submissionId: newRequestId(),
    verdict: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    ...overrides,
  };
}

function notice(overrides: Partial<SubmissionNoticeCommand> = {}): SubmissionNoticeCommand {
  return {
    version: 1,
    kind: "submission_notice",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    workflowId: "wf-missing",
    submissionId: newRequestId(),
    codexThreadId: newRequestId(),
    dshSessionId: "session-notice",
    level: "error",
    message: "Codex Reviewer 后台审查失败：source task is invalid",
    ...overrides,
  };
}

test("dispatch routes to the exact explicit session and delivers one followup", async () => {
  const h = await harness();
  try {
    const target = makeAgent("session-exact", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const command = dispatch({ target: { dshSessionId: "session-exact", cwd: "C:\\work" } });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.ok(receipt.workflowId);
    assert.equal(target.followups.length, 1);
    assert.match(target.followups[0]!.text, /proposed_plan/);
    const record = await h.workflowStore.load(receipt.workflowId!);
    assert.equal(record?.origin, "codex_bridge");
    assert.equal(record?.codexThreadId, command.codexThreadId);
    assert.equal(record?.bridgeRequestId, command.requestId);
    assert.equal(record?.phase, "executing");
    assert.equal(record?.plannerThreadId, undefined);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("dispatch falls back to the unique canonical-cwd session", async () => {
  const h = await harness();
  try {
    const target = makeAgent("session-by-cwd", "C:\\Users\\张三\\project with spaces");
    h.registry.register(target);
    h.runtime.start();
    const command = dispatch({ target: { cwd: "C:\\Users\\张三\\project with spaces" } });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(target.followups.length, 1);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("two same-cwd sessions produce an ambiguity receipt", async () => {
  const h = await harness();
  try {
    h.registry.register(makeAgent("session-1", "C:\\same"));
    h.registry.register(makeAgent("session-2", "C:\\same"));
    h.runtime.start();
    const command = dispatch({ target: { cwd: "C:\\same" } });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error ?? "", /multiple live DSH sessions/);
    assert.equal(h.registry.agents.get("session-1")!.followups.length, 0);
    assert.equal(h.registry.agents.get("session-2")!.followups.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a missing target session stays unclaimed until the live session appears", async () => {
  const h = await harness(5, 10, 5);
  try {
    h.runtime.start();
    const command = dispatch({ target: { cwd: "C:\\late" } });
    await h.store.enqueue(command);
    // While no live session owns this cwd, the command must remain untouched:
    // inbox, attempts=0, claim_epoch=0 — never retried, never dead-lettered.
    await new Promise((resolve) => setTimeout(resolve, 250));
    let row = h.store.coordinationHandle.queueRow(command.requestId);
    assert.equal(row?.status, "inbox");
    assert.equal(row?.attempts, 0);
    assert.equal(row?.claimEpoch, 0);
    assert.equal(await h.store.receipt(command.requestId), undefined);
    assert.equal((await h.store.rowsByStatus("dead-letter")).length, 0);
    // The session appears; its runtime's registry refresh makes it claimable.
    h.registry.register(makeAgent("session-late", "C:\\late"));
    await waitFor(async () => (await h.store.receipt(command.requestId)) !== undefined);
    const receipt = await h.store.receipt(command.requestId);
    assert.equal(receipt?.status, "delivered");
    assert.equal(h.registry.agents.get("session-late")!.followups.length, 1);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a dispatch to an absent explicit session is never claimed (no retry, no dead-letter)", async () => {
  const h = await harness(5, 1, 2);
  try {
    h.runtime.start();
    const command = dispatch({ target: { dshSessionId: "session-never", cwd: "C:\\work" } });
    await h.store.enqueue(command);
    // Routing gate: no runtime owns "session-never" (not in this runtime's
    // registry), so the command is skipped — never claimed, never retried,
    // never dead-lettered, attempts stay 0.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = h.store.coordinationHandle.queueRow(command.requestId);
    assert.equal(row?.status, "inbox", "the command waits for its owning session");
    assert.equal(row?.attempts, 0, "no attempts consumed by the wrong runtime");
    assert.equal((await h.store.rowsByStatus("dead-letter")).length, 0, "never dead-lettered");
    assert.equal(await h.store.receipt(command.requestId), undefined);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("cwd mismatch on an explicit session is a terminal failed receipt", async () => {
  const h = await harness();
  try {
    h.registry.register(makeAgent("session-alive", "C:\\work"));
    h.runtime.start();
    const mismatch = dispatch({ target: { dshSessionId: "session-alive", cwd: "D:\\elsewhere" } });
    await h.store.enqueue(mismatch);
    const receipt = await waitForReceipt(h.store, mismatch.requestId);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error ?? "", /cwd mismatch/);
    assert.equal(h.registry.agents.get("session-alive")!.followups.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a busy session is retried with backoff and dead-lettered, never double-delivered", async () => {
  const h = await harness(5, 1, 2);
  try {
    const target = makeAgent("session-busy", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const first = dispatch();
    await h.store.enqueue(first);
    const firstReceipt = await waitForReceipt(h.store, first.requestId);
    assert.equal(firstReceipt.status, "delivered");

    // The session now owns a workflow; the second dispatch must retry (no
    // failed receipt, no followup) and exhaust into the dead letter.
    const second = dispatch();
    await h.store.enqueue(second);
    await waitFor(async () => (await h.store.rowsByStatus("dead-letter")).length > 0);
    assert.equal(await h.store.receipt(second.requestId), undefined);
    assert.equal(target.followups.length, 1);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("duplicate dispatch enqueues once and delivers once", async () => {
  const h = await harness();
  try {
    const target = makeAgent("session-dupe", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const command = dispatch({ target: { dshSessionId: "session-dupe", cwd: "C:\\work" } });
    await h.store.enqueue(command);
    await h.store.enqueue(command); // duplicate requestId
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(target.followups.length, 1);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("restart recovery re-delivers an orphaned processing claim exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-restart-"));
  try {
    const store = new BridgeStore(join(directory, "storage"));
    await store.init();
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, storageDir: directory });
    const registry = new FakeRegistry();
    const target = makeAgent("session-restart", "C:\\work");
    registry.register(target);

    // Simulate a crash deterministically: the claim is taken but never acked,
    // and enough time passed that its lease expired.
    const command = dispatch({ target: { dshSessionId: "session-restart", cwd: "C:\\work" } });
    await store.enqueue(command);
    const claim = await store.claimNext("crashed-instance");
    assert.ok(claim); // "crash": no ack, no retry
    expireClaimLease(store, command.requestId);

    // Second runtime recovers the orphan and delivers exactly once.
    const secondRuntime = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
    });
    secondRuntime.start();
    try {
      const receipt = await waitForReceipt(store, command.requestId);
      assert.equal(receipt.status, "delivered");
      assert.equal(target.followups.length, 1);
      assert.equal(target.followups[0]!.text.length > 0, true);
    } finally {
      await secondRuntime.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

/** Create a bridge workflow in the `received` state with sufficient evidence,
 * exactly as after a real submit. */
async function makeBridgeWorkflow(
  h: Harness,
  sessionId: string,
  workspace: string,
  codexThreadId = newRequestId(),
): Promise<{ workflowId: string; codexThreadId: string; submissionId: string }> {
  const agent = h.registry.get(sessionId)!;
  const record = await h.manager.startExternalPlan({
    version: 1,
    kind: "dispatch_plan",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    codexThreadId,
    target: { cwd: workspace, dshSessionId: sessionId },
    task: "Bridge task",
    planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
    assumptions: [],
  }, agent);
  const submissionId = newRequestId();
  const evidence = await collectEvidence({ cwd: workspace, maxDiffBytes: 65536, changedFiles: ["a.txt"] });
  await h.workflowStore.update(record.id, (r) => {
    r.submissionId = submissionId;
    r.submissionState = "received";
    r.reviewCycles = 1;
    r.pendingReviewRequest = { implementationSummary: "done", changedFiles: ["a.txt"] };
    r.latestReviewEvidence = evidence;
  });
  return { workflowId: record.id, codexThreadId, submissionId };
}

test("a passing verdict delivers to the original DSH session exactly once", async () => {
  const h = await harness();
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-v", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-v", workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(receipt.workflowId, bridge.workflowId);
    assert.equal(target.followups.length, 1);
    assert.match(target.followups[0]!.text, /Codex review passed workflow/);
    assert.match(target.followups[0]!.text, /end this turn immediately/);
    assert.match(target.followups[0]!.text, /Do not call any tool/);
    assert.match(target.followups[0]!.text, /memory/);
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(record?.phase, "passed");
    assert.equal(record?.submissionState, "delivered");
    // Duplicate enqueue of the same verdict is idempotent.
    await h.store.enqueue(command);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(target.followups.length, 1);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a completed verdict opens the original Codex thread once after apply", async () => {
  const opened: string[] = [];
  const h = await harness(5, 10, 5, 60_000, 60_000, {
    open: async (threadId) => { opened.push(threadId); },
  });
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-desktop-open", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.deepEqual(opened, [bridge.codexThreadId]);
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(record?.desktopOpenState, "opened");
    assert.equal(record?.desktopOpenSubmissionId, bridge.submissionId);
    // Replaying the exact request cannot create a second desktop open.
    await h.store.enqueue(command);
    await h.runtime.pump();
    assert.deepEqual(opened, [bridge.codexThreadId]);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("desktop-open failures stay pending and retry after the backoff deadline", async () => {
  let openAttempts = 0;
  const h = await harness(5, 10, 5, 60_000, 60_000, {
    open: async () => {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error("Codex Desktop is not running");
    },
  }, {
    desktopOpenRetryBaseMs: 20,
    desktopOpenRetryMaxMs: 100,
  });
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-desktop-retry", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    assert.equal((await waitForReceipt(h.store, command.requestId)).status, "delivered");
    let record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(record?.desktopOpenState, "pending");
    assert.equal(record?.desktopOpenAttempts, 1);
    assert.match(record?.desktopOpenError ?? "", /not running/);
    await h.workflowStore.update(bridge.workflowId, (r) => { r.desktopOpenNextAt = Date.now() - 1; });
    await h.runtime.pump();
    record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(openAttempts, 2);
    assert.equal(record?.desktopOpenState, "opened");
    assert.equal(record?.desktopOpenError, undefined);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("desktop auto-open can be disabled for headless deployments", async () => {
  let openAttempts = 0;
  const h = await harness(5, 10, 5, 60_000, 60_000, {
    open: async () => { openAttempts += 1; },
  }, {
    openCodexDesktopOnReview: false,
  });
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-desktop-disabled", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    assert.equal((await waitForReceipt(h.store, command.requestId)).status, "delivered");
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(openAttempts, 0);
    assert.equal(record?.desktopOpenState, "disabled");
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a hanging terminal relay is cancelled once without clearing pending inbox work", async () => {
  const h = await harness(5, 1_000, 5, 60_000, 20);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-terminal-hang", "C:\\work", 0, true);
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    await waitForReceipt(h.store, command.requestId);
    await waitFor(() => target.cancels.length === 1);
    assert.deepEqual(target.cancels[0]?.options, { keepInbox: true });
    assert.deepEqual(target.cancels[0]?.cause, {
      kind: "hook",
      reason: `dsh-codex-workflow terminal relay exceeded 20ms for workflow ${bridge.workflowId}`,
    });
    assert.equal(target.status, "idle");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(target.cancels.length, 1);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a terminal relay that reaches idle before the deadline is never cancelled", async () => {
  const h = await harness(5, 1_000, 5, 60_000, 20);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-terminal-idle", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    await waitForReceipt(h.store, command.requestId);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.equal(target.cancels.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("stopping the runtime disarms a pending terminal relay guard", async () => {
  const h = await harness(5, 1_000, 5, 60_000, 80);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-terminal-stop", "C:\\work", 0, true);
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    await waitForReceipt(h.store, command.requestId);
    await h.runtime.stop();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    assert.equal(target.cancels.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a completed relay guard never cancels a later agent activity", async () => {
  const h = await harness(5, 1_000, 5, 60_000, 30);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-terminal-next", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, target.id, workspace);
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    await waitForReceipt(h.store, command.requestId);
    target.startActivity();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    assert.equal(target.cancels.length, 0);
    target.finishActivity();
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a terminal submission notice survives a relay crash and wakes the original session exactly once", async () => {
  const h = await harness(5);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-notice", workspace);
    h.registry.register(target);
    const record = await h.manager.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: workspace, dshSessionId: target.id },
      task: "Bridge task",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    }, target.agent);
    const command = notice({
      workflowId: record.id,
      codexThreadId: record.codexThreadId!,
      dshSessionId: target.id,
    });
    await h.workflowStore.update(record.id, (r) => {
      r.submissionId = command.submissionId;
      r.submissionState = "failed";
      r.submissionError = command.message;
      r.submissionNotice = { command, state: "prepared" };
    });
    await h.store.enqueue(command);

    const crashed = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      afterFollowupHook: async () => { throw new BridgeCrashSimulationError(); },
    });
    crashed.start();
    await waitFor(() => target.followups.length === 1);
    await crashed.stop();
    assert.equal(await h.store.receipt(command.requestId), undefined);
    expireClaimLease(h.store, command.requestId);

    h.runtime.start();
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(target.followups.length, 1, "restart replay must not show the notice twice");
    assert.match(target.followups[0]!.text, /后台审查失败/);
    assert.equal((await h.workflowStore.load(record.id))?.submissionNotice?.state, "delivered");
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("blocking findings route the workflow back to fixing with the findings relayed", async () => {
  const h = await harness();
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-f", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-f", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
      verdict: {
        verdict: "changes_requested",
        findings: [{ severity: "high", blocking: true, title: "缺陷", body: "修复", file: "src/a.ts", line: 10 }],
        testGaps: [],
        summary: "needs work",
      },
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal((await h.workflowStore.load(bridge.workflowId))?.phase, "fixing");
    assert.match(target.followups[0]!.text, /codex_workflow_submit/);
    assert.match(target.followups[0]!.text, /缺陷/);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("non-blocking findings stop at the decision gate with a relay", async () => {
  const h = await harness();
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-g", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-g", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
      verdict: {
        verdict: "changes_requested",
        findings: [{ severity: "medium", blocking: false, title: "Nit", body: "could be cleaner" }],
        testGaps: [],
        summary: "nits",
      },
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal((await h.workflowStore.load(bridge.workflowId))?.phase, "waiting_review_decision");
    assert.match(target.followups[0]!.text, /codex_workflow_decide/);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("verdicts with a wrong thread or wrong workflow get terminal receipts", async () => {
  const h = await harness();
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-w", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-w", workspace);

    const wrongThread = verdict({ workflowId: bridge.workflowId, codexThreadId: newRequestId() });
    await h.store.enqueue(wrongThread);
    const threadReceipt = await waitForReceipt(h.store, wrongThread.requestId);
    assert.equal(threadReceipt.status, "no_such_workflow");
    assert.match(threadReceipt.error ?? "", /thread mismatch/);

    const wrongWorkflow = verdict({ workflowId: "wf-does-not-exist" });
    await h.store.enqueue(wrongWorkflow);
    const workflowReceipt = await waitForReceipt(h.store, wrongWorkflow.requestId);
    assert.equal(workflowReceipt.status, "no_such_workflow");
    assert.match(workflowReceipt.error ?? "", /unknown workflow/);
    assert.equal(target.followups.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a verdict arriving before any submission is a terminal receipt", async () => {
  const h = await harness();
  try {
    const target = makeAgent("session-b", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const agent = h.registry.get("session-b")!;
    const record = await h.manager.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: newRequestId(),
      target: { cwd: "C:\\work", dshSessionId: "session-b" },
      task: "Bridge task",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    }, agent);
    const command = verdict({ workflowId: record.id, codexThreadId: record.codexThreadId! });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "no_such_workflow");
    assert.match(receipt.error ?? "", /stale submission: workflow .* is on submission \(none\)/);
    assert.equal(target.followups.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a late verdict on a cancelled workflow is an idempotent cancelled receipt, never waking DSH", async () => {
  const h = await harness();
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-c", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-c", workspace);
    await h.workflowStore.update(bridge.workflowId, (r) => { r.phase = "cancelled"; });
    const command = verdict({ workflowId: bridge.workflowId, codexThreadId: bridge.codexThreadId, submissionId: bridge.submissionId });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "cancelled");
    assert.equal((await h.workflowStore.load(bridge.workflowId))?.phase, "cancelled");
    assert.equal(target.followups.length, 0);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a verdict claim orphaned by a crash is recovered and delivered exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-vrestart-"));
  try {
    const store = new BridgeStore(join(directory, "storage"));
    await store.init();
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, storageDir: directory });
    const registry = new FakeRegistry();
    const target = makeAgent("session-r", "C:\\work");
    registry.register(target);
    const agent = registry.get("session-r")!;
    const workspace = await makeWorkspace(directory);
    const codexThreadId = newRequestId();
    const submissionId = newRequestId();
    const record = await manager.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId,
      target: { cwd: workspace, dshSessionId: "session-r" },
      task: "Bridge task",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    }, agent);
    const evidence = await collectEvidence({ cwd: workspace, maxDiffBytes: 65536, changedFiles: ["a.txt"] });
    await workflowStore.update(record.id, (r) => {
      r.submissionId = submissionId;
      r.submissionState = "received";
      r.reviewCycles = 1;
      r.pendingReviewRequest = { implementationSummary: "done", changedFiles: ["a.txt"] };
      r.latestReviewEvidence = evidence;
    });
    const command = verdict({ workflowId: record.id, codexThreadId, submissionId });
    await store.enqueue(command);
    const claim = await store.claimNext("crashed-instance");
    assert.ok(claim); // crash: no ack
    expireClaimLease(store, command.requestId);

    const runtime = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
    });
    runtime.start();
    try {
      const receipt = await waitForReceipt(store, command.requestId);
      assert.equal(receipt.status, "delivered");
      assert.equal(target.followups.length, 1);
      assert.equal((await workflowStore.load(record.id))?.phase, "passed");
    } finally {
      await runtime.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

test("refreshSessions publishes the live registry for the CLI", async () => {
  const h = await harness();
  try {
    h.registry.register(makeAgent("session-a", "C:\\work"));
    h.registry.register(makeAgent("session-b", "D:\\other"));
    await h.runtime.refreshSessions();
    const live = h.store.coordinationHandle.listLiveSessions();
    assert.deepEqual(live.map((row) => row.sessionId).sort(), ["session-a", "session-b"]);
    assert.ok(live.every((row) => typeof row.cwd === "string" && row.leaseUntil > Date.now()));
  } finally {
    await rmClosed(h.directory);
  }
});

test("idle pumps do not rewrite an unchanged live-session registry", async () => {
  const h = await harness(5);
  try {
    h.registry.register(makeAgent("session-stable", "C:\\work"));
    const coordination = h.store.coordinationHandle;
    const refresh = coordination.refreshOwnerSessions.bind(coordination);
    let writes = 0;
    coordination.refreshOwnerSessions = (...args) => {
      writes += 1;
      return refresh(...args);
    };

    h.runtime.start();
    await waitFor(async () => writes >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(writes, 1, "unchanged idle polls must not reacquire the SQLite write lock");
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("crash after workflow persist, before followup: replay delivers without duplicating the workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-crashA-"));
  try {
    const store = new BridgeStore(join(directory, "storage"));
    await store.init();
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, storageDir: directory });
    const registry = new FakeRegistry();
    const target = makeAgent("session-a", "C:\\work");
    registry.register(target);

    // Simulate the crash mid-delivery: the workflow is persisted (prepared),
    // the claim is orphaned in processing, and no followup or receipt happened.
    const command = dispatch({ target: { dshSessionId: "session-a", cwd: "C:\\work" } });
    const record = await manager.startExternalPlan(command, target.agent);
    await store.enqueue(command);
    const claim = await store.claimNext("crashed-instance");
    assert.ok(claim); // "crash": nothing after this point
    expireClaimLease(store, command.requestId);

    const runtime = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
    });
    runtime.start();
    try {
      const receipt = await waitForReceipt(store, command.requestId);
      assert.equal(receipt.status, "delivered");
      assert.equal(receipt.workflowId, record.id);
      // Exactly one workflow exists for this request.
      assert.equal((await workflowStore.byBridgeRequest(command.requestId))?.id, record.id);
      assert.equal(target.followups.length, 1);
      assert.equal((await workflowStore.load(record.id))?.bridgeDeliveryState, "delivered");
    } finally {
      await runtime.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

test("crash after followup, before delivery-state update: replay never sends a second followup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-crashB-"));
  try {
    const store = new BridgeStore(join(directory, "storage"));
    await store.init();
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, storageDir: directory });
    const registry = new FakeRegistry();
    const target = makeAgent("session-b", "C:\\work");
    registry.register(target);

    // Real fault injection: the followup really completes (persisting the
    // deterministic message id into the durable events), then the injected
    // hook simulates a crash before the delivery-state update runs.
    const command = dispatch({ target: { dshSessionId: "session-b", cwd: "C:\\work" } });
    await store.enqueue(command);
    const crashed = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
      afterFollowupHook: async () => { throw new BridgeCrashSimulationError(); },
    });
    crashed.start();
    await waitFor(async () => target.followups.length === 1);
    await crashed.stop(); // the claim is orphaned in processing, like a crash
    expireClaimLease(store, command.requestId);
    assert.equal(await store.receipt(command.requestId), undefined);

    const runtime = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
    });
    runtime.start();
    try {
      const receipt = await waitForReceipt(store, command.requestId);
      assert.equal(receipt.status, "delivered");
      assert.ok(receipt.workflowId);
      assert.equal(target.followups.length, 1, "no second followup on replay");
      assert.equal((await workflowStore.byBridgeRequest(command.requestId))?.id, receipt.workflowId);
      assert.equal((await workflowStore.load(receipt.workflowId!))?.bridgeDeliveryState, "delivered");
    } finally {
      await runtime.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

test("the session registry stays fresh as sessions come and go", async () => {
  const h = await harness(5);
  try {
    h.registry.register(makeAgent("session-a", "C:\\work"));
    h.runtime.start();
    const live = () => h.store.coordinationHandle.listLiveSessions().map((row) => row.sessionId);
    await waitFor(async () => live().includes("session-a"));
    h.registry.register(makeAgent("session-new", "D:\\other"));
    await waitFor(async () => live().includes("session-new"));
    h.registry.unregister("session-a");
    await waitFor(async () => !live().includes("session-a"));
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a transient followup failure retries persistently and delivers exactly once", async () => {
  const h = await harness(5, 1, 2);
  try {
    // The first two followup attempts throw; the verdict must survive them on
    // the persistent path (which ignores the 2-attempt dead-letter budget).
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-followup-fail", "C:\\work", 2);
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-followup-fail", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(target.followups.length, 1, "exactly one delivery despite retries");
    assert.match(target.followups[0]!.text, /Codex review passed workflow/);
    const dead = await h.store.rowsByStatus("dead-letter");
    assert.equal(dead.filter((row) => row.requestId === command.requestId).length, 0, "verdict delivery never dead-letters");
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("an offline DSH session keeps the verdict retrying forever and delivers when it returns", async () => {
  const h = await harness(5, 1, 2);
  try {
    const workspace = await makeWorkspace(h.directory);
    // Create the workflow while the session is registered, then take the
    // session offline BEFORE the verdict arrives.
    const early = makeAgent("session-offline-verdict", "C:\\work");
    h.registry.register(early);
    const bridge = await makeBridgeWorkflow(h, "session-offline-verdict", workspace);
    h.registry.unregister("session-offline-verdict");
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    h.runtime.start();
    // The claim was applied and parked on the persistent retry path.
    await waitFor(async () => (await h.store.rowsByStatus("retry")).length > 0);
    // Let it spin well past the dispatch dead-letter budget (maxRetryAttempts=2).
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dead = await h.store.rowsByStatus("dead-letter");
    assert.equal(dead.filter((row) => row.requestId === command.requestId).length, 0,
      "a temporarily offline session must never dead-letter the verdict");
    assert.equal(await h.store.receipt(command.requestId), undefined);

    // The session comes back later: the verdict is auto-delivered.
    const target = makeAgent("session-offline-verdict", "C:\\work");
    h.registry.register(target);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(target.followups.length, 1);
    assert.match(target.followups[0]!.text, /Codex review passed workflow/);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

/** P1-4 (round 3): a "pass" applied while the session is offline must be
 * invalidated if the workspace changes before delivery — the relay can never
 * report a stale pass as passed. */
test("a workspace change during offline delivery voids an applied pass", async () => {
  const h = await harness(5, 1, 2);
  try {
    const workspace = await makeWorkspace(h.directory);
    const early = makeAgent("session-offline-change", "C:\\work");
    h.registry.register(early);
    const bridge = await makeBridgeWorkflow(h, "session-offline-change", workspace);
    h.registry.unregister("session-offline-change");
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    h.runtime.start();
    // The verdict was applied and parked (offline).
    await waitFor(async () => (await h.workflowStore.load(bridge.workflowId))?.submissionState === "applied");
    // The workspace changes while the session is offline.
    await writeFile(join(workspace, "a.txt"), "v2-changed-after-review", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Session returns: the relay must NOT report passed; the applied verdict
    // is void and the workflow returns to a safe re-submit state.
    const target = makeAgent("session-offline-change", "C:\\work");
    h.registry.register(target);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    assert.equal(target.followups.length, 1);
    assert.ok(!/Codex review passed workflow/.test(target.followups[0]!.text), "stale pass must not be reported");
    assert.match(target.followups[0]!.text, /VOID|not applied/);
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.notEqual(record?.phase, "passed");
    assert.equal(record?.phase, "executing");
    assert.match(record?.error ?? "", /workspace changed after the review/);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

test("a crash between verdict apply and relay is recovered and delivered exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-vcrash-"));
  try {
    const store = new BridgeStore(join(directory, "storage"));
    await store.init();
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, storageDir: directory });
    const registry = new FakeRegistry();
    const target = makeAgent("session-vcrash", "C:\\work");
    registry.register(target);
    const agent = registry.get("session-vcrash")!;
    const workspace = await makeWorkspace(directory);
    const codexThreadId = newRequestId();
    const submissionId = newRequestId();
    const record = await manager.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId,
      target: { cwd: workspace, dshSessionId: "session-vcrash" },
      task: "Bridge task",
      planMarkdown: "<proposed_plan>\nDo it\n</proposed_plan>",
      assumptions: [],
    }, agent);
    const evidence = await collectEvidence({ cwd: workspace, maxDiffBytes: 65536, changedFiles: ["a.txt"] });
    await workflowStore.update(record.id, (r) => {
      r.submissionId = submissionId;
      r.submissionState = "received";
      r.reviewCycles = 1;
      r.pendingReviewRequest = { implementationSummary: "done", changedFiles: ["a.txt"] };
      r.latestReviewEvidence = evidence;
    });
    const command = verdict({ workflowId: record.id, codexThreadId, submissionId });
    await store.enqueue(command);

    // First runtime: apply commits, then the simulated crash hits BEFORE the
    // relay followup, leaving the claim orphaned.
    const crashed = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
      afterApplyHook: async () => { throw new BridgeCrashSimulationError(); },
    });
    crashed.start();
    try {
      await waitFor(async () => (await workflowStore.load(record.id))?.submissionState === "applied");
      assert.equal(target.followups.length, 0, "no relay before the crash");
      assert.equal(await store.receipt(command.requestId), undefined);
    } finally {
      await crashed.stop();
    }
    expireClaimLease(store, command.requestId);

    // Restart: the orphaned claim is recovered; apply replays idempotently and
    // the relay lands exactly once.
    const runtime = new BridgeRuntime(store, registry, {
      pollMs: 5,
      storageDir: join(directory, "storage"),
      manager,
      workflowStore,
    });
    runtime.start();
    try {
      const receipt = await waitForReceipt(store, command.requestId);
      assert.equal(receipt.status, "delivered");
      assert.equal(target.followups.length, 1, "exactly one relay after restart");
      assert.equal((await workflowStore.load(record.id))?.phase, "passed");
    } finally {
      await runtime.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

/** A workspace change injected by beforeRelayHook (after apply, before the
 * final fingerprint verification) must invalidate an applied pass so the
 * relay never reports passed. */
test("a workspace change between prepare and relay invalidates a pass", async () => {
  const h = await harness(5);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-prepare-change", "C:\\work");
    h.registry.register(target);
    let workspaceChanged = false;
    const runtime = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      beforeRelayHook: async () => {
        if (!workspaceChanged) {
          workspaceChanged = true;
          await writeFile(join(workspace, "a.txt"), "v2-changed-before-relay", "utf8");
        }
      },
    });
    runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-prepare-change", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered", "the (voiding) notice is delivered");
    assert.equal(target.followups.length, 1);
    assert.ok(!/Codex review passed workflow/.test(target.followups[0]!.text), "old pass must not be reported");
    assert.match(target.followups[0]!.text, /VOID|not applied/);
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.notEqual(record?.phase, "passed");
    assert.equal(record?.phase, "executing");
    assert.match(record?.error ?? "", /workspace changed after the review/);
    assert.equal(record?.submissionState, "delivered", "the void notice commit marked delivered");
    await runtime.stop();
  } finally {
    await rmClosed(h.directory);
  }
});

/** If a cancel wins between the relay and the commit, the old verdict is
 * never marked delivered and the queue is acked cancelled, not delivered. */
test("a cancel between relay and commit never marks the verdict delivered", async () => {
  const h = await harness(5);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-commit-cancel", "C:\\work");
    h.registry.register(target);
    const bridge = await makeBridgeWorkflow(h, "session-commit-cancel", workspace);
    let cancelled = false;
    const hookRuntime = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      afterFollowupHook: async () => {
        if (!cancelled) {
          cancelled = true;
          await h.workflowStore.update(bridge.workflowId, (r) => {
            r.phase = "cancelled";
          }, { ignoreCancelled: true });
        }
      },
    });
    hookRuntime.start();
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "cancelled", "commit lost to cancel -> acked cancelled, not delivered");
    assert.equal(target.followups.length, 1, "the relay itself landed once");
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(record?.phase, "cancelled");
    assert.notEqual(record?.submissionState, "delivered", "the old verdict never marks delivered over the cancel");
    await hookRuntime.stop();
  } finally {
    await rmClosed(h.directory);
  }
});

/** [#2 claim fencing] A claim owner whose lease renewal reports loss must stop
 * producing EVERY external side effect — no apply, no relay, no receipt. */
test("a claim owner that lost its lease produces no apply or relay side effects", async () => {
  const h = await harness(5, 10, 5, 300); // leaseMs 300 -> heartbeat period 100ms
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-lost", "C:\\work");
    h.registry.register(target);
    let lostObserved = false;
    const runtimeA = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      // The renewal probe reports loss on its first tick: the handler must
      // then stop dead in its tracks.
      renewClaimForTest: async () => {
        lostObserved = true;
        return false;
      },
      beforeApplyHook: async () => {
        // REAL takeover before the apply side effect: expire A's lease and
        // let another owner claim the row, then wait for A's heartbeat to
        // observe the loss.
        h.store.coordinationHandle.db.prepare(
          "UPDATE queue SET claim_until = 0 WHERE request_id = ?",
        ).run(command.requestId);
        const takeover = await h.store.claimNext("owner-B");
        assert.ok(takeover, "owner-B takes the claim over");
        const deadline = Date.now() + 3000;
        while (!lostObserved && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(lostObserved, true, "the lease loss was observed before apply");
      },
    });
    runtimeA.start();
    const bridge = await makeBridgeWorkflow(h, "session-lost", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    await waitFor(async () => lostObserved);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.notEqual(record?.submissionState, "applied", "a stale owner never applies");
    assert.equal(record?.appliedVerdictRequestId, undefined, "no false apply identity");
    assert.equal(target.followups.length, 0, "no relay from a stale owner");
    assert.equal(await h.store.receipt(command.requestId), undefined, "no receipt from a stale owner");
    const row = h.store.coordinationHandle.queueRow(command.requestId);
    assert.equal(row?.status, "processing", "the claim is left in processing");
    assert.equal(row?.claimOwner, "owner-B", "the new owner really holds the claim");
    await runtimeA.stop();

    // The NEW owner (a real second runtime) completes the judgement: apply +
    // relay + delivered, exactly once.
    expireClaimLease(h.store, command.requestId);
    const runtimeB = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
    });
    runtimeB.start();
    try {
      const receipt = await waitForReceipt(h.store, command.requestId);
      assert.equal(receipt.status, "delivered", "the new owner delivers the verdict");
      assert.equal(target.followups.length, 1, "exactly one relay, from the new owner");
      assert.equal((await h.workflowStore.load(bridge.workflowId))?.phase, "passed");
    } finally {
      await runtimeB.stop();
    }
  } finally {
    await rmClosed(h.directory);
  }
});

/** Finding 1 + routing: two runtimes share one coord.sqlite; each may only
 * claim commands whose target session belongs to IT. The wrong runtime never
 * claims, never bumps attempts/claim_epoch, and never relays. */
test("two runtimes route dispatch+verdict to their owning session; no HOL blocking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-route-"));
  try {
    const storageDir = join(directory, "storage");
    const storeA = new BridgeStore(storageDir);
    const storeB = new BridgeStore(storageDir);
    // Production (index.ts) hosts the workflow store and the bridge store on
    // the SAME storage directory, so eligibility's workflowSessionOf() reads
    // the same coord.sqlite. The test must mirror that.
    const wfA = new WorkflowStore(storageDir);
    const wfB = new WorkflowStore(storageDir);
    const managerA = new WorkflowManager(wfA, new NoopGateway(), { ...config, storageDir: directory }, undefined, storeA);
    const managerB = new WorkflowManager(wfB, new NoopGateway(), { ...config, storageDir: directory }, undefined, storeB);
    const regA = new FakeRegistry();
    const regB = new FakeRegistry();
    const wsA = join(directory, "wsA");
    await mkdir(wsA, { recursive: true });
    await writeFile(join(wsA, "a.txt"), "v1", "utf8");
    const sessionA = makeAgent("session-route-a", wsA); // cwd = the real workspace
    const sessionB = makeAgent("session-route-b", "C:\\work");
    regA.register(sessionA);
    regB.register(sessionB);
    const rtA = new BridgeRuntime(storeA, regA, { pollMs: 2, storageDir, manager: managerA, workflowStore: wfA });
    const rtB = new BridgeRuntime(storeB, regB, { pollMs: 2, storageDir, manager: managerB, workflowStore: wfB });
    // B pumps loudly; A is not started yet (only driven by explicit pump() calls
    // so the timeline is deterministic). B must skip A's commands.
    rtB.start();
    try {
      const commandForA = dispatch({ target: { dshSessionId: "session-route-a", cwd: wsA } });
      await storeA.enqueue(commandForA);
      // The queue head is A's command; B's OWN command is enqueued afterwards.
      const commandForB = dispatch({ target: { dshSessionId: "session-route-b", cwd: "C:\\work" } });
      await storeB.enqueue(commandForB);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const rowA = storeA.coordinationHandle.queueRow(commandForA.requestId);
      assert.equal(rowA?.status, "inbox", "B never claimed A's command");
      assert.equal(rowA?.attempts, 0, "B did not consume attempts");
      assert.equal(rowA?.claimEpoch ?? 0, 0, "B left A's claim_epoch untouched");
      assert.equal(sessionA.followups.length, 0, "B never relayed A's command");
      // B processed its OWN command past A's queue head (no head-of-line blocking).
      const rowB = storeA.coordinationHandle.queueRow(commandForB.requestId);
      assert.ok(rowB && (rowB.status === "processing" || rowB.status === "done"), "B claimed its own command past A's head");
      assert.equal(sessionB.followups.length, 1, "B delivered its own command");
      const receiptB = await waitForReceipt(storeB, commandForB.requestId);
      assert.equal(receiptB.status, "delivered");

      // A handles its own dispatch (explicit pump without starting its timer).
      await rtA.pump();
      const receiptA = await waitForReceipt(storeA, commandForA.requestId);
      assert.equal(receiptA.status, "delivered");
      assert.equal(sessionA.followups.length, 1, "A delivered its own dispatch");
      const workflowId = receiptA.workflowId!;
      assert.equal((await wfA.load(workflowId))?.dshSessionId, "session-route-a");

      // Verdict path on the SAME workflow: B must never apply/relay it.
      const submissionId = newRequestId();
      await setReceived(wfA, workflowId, submissionId, wsA);
      const codexThreadId = (await wfA.load(workflowId))!.codexThreadId!;
      const verdictCommand = verdict({
        workflowId,
        codexThreadId,
        submissionId,
        dshSessionId: "session-route-a",
      });
      await storeA.enqueue(verdictCommand);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rec = await wfA.load(workflowId);
      assert.notEqual(rec?.submissionState, "applied", "B never applied A's verdict");
      assert.equal(rec?.appliedVerdictRequestId, undefined, "B never applied A's verdict");
      assert.equal(await storeA.receipt(verdictCommand.requestId), undefined);
      assert.equal(sessionB.followups.length, 1, "B never relayed A's verdict");
      // A applies and relays its own verdict.
      await rtA.pump();
      const receiptV = await waitForReceipt(storeA, verdictCommand.requestId);
      assert.equal(receiptV.status, "delivered");
      const finalRecord = await wfA.load(workflowId);
      assert.equal(finalRecord?.submissionState, "delivered");
      assert.equal(finalRecord?.reviewCycles, 1, "the first applied verdict consumed the first cycle");
      assert.equal(sessionA.followups.length, 2, "dispatch + verdict relayed by A");
    } finally {
      await rtA.stop();
      await rtB.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

async function makeBridgeWorkflowFor(manager: WorkflowManager, reg: FakeRegistry, sessionId: string, ws: string, codexThreadId: string): Promise<import("../src/types.js").WorkflowRecord> {
  const agent = reg.get(sessionId)!;
  return manager.startExternalPlan({
    version: 1,
    kind: "dispatch_plan",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    codexThreadId,
    target: { cwd: ws, dshSessionId: sessionId },
    task: "Bridge",
    planMarkdown: "<proposed_plan>\nDo\n</proposed_plan>",
    assumptions: [],
  }, agent);
}

async function setReceived(store: WorkflowStore, workflowId: string, submissionId: string, ws: string): Promise<void> {
  const evidence = await collectEvidence({ cwd: ws, maxDiffBytes: 65536, changedFiles: ["a.txt"] });
  await store.update(workflowId, (r) => {
    r.submissionId = submissionId;
    r.submissionState = "received";
    // reviewCycles stays 0 until the first structured verdict is APPLIED.
    r.pendingReviewRequest = { implementationSummary: "done", changedFiles: ["a.txt"] };
    r.latestReviewEvidence = evidence;
  });
}

/** A forged/stale dshSessionId must be a TERMINAL identity error: no apply,
 * no relay, no retry loop, attempts stay untouched. */
test("a forged dshSessionId is rejected terminally without apply/relay/attempt growth", async () => {
  const h = await harness(5);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-fake", "C:\\work");
    h.registry.register(target);
    h.runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-fake", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
      dshSessionId: "session-attacker", // contradicts the record's real session
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "no_such_workflow");
    assert.match(receipt.error ?? "", /session mismatch/);
    const row = h.store.coordinationHandle.queueRow(command.requestId);
    assert.equal(row?.status, "done", "terminal receipt, not retry/processed");
    assert.equal(row?.attempts, 0, "no retry attempts consumed");
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.notEqual(record?.submissionState, "applied", "never applied");
    assert.equal(record?.appliedVerdictRequestId, undefined);
    assert.equal(target.followups.length, 0, "never relayed");
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

/** The live session registry merges across runtimes; real runtime teardown
 * deletes only its own rows and never resurrects them after stop(); TTL
 * expires crashed owners; a new runtime takes over the same session id. */
test("live session registry merges, teardown/expiry/takeover semantics", async () => {
  // Keep normally heartbeating runtimes well clear of loaded CI scheduling
  // stalls. Crash expiry is tested below with its own explicit 120 ms lease.
  const h = await harness(50, 10, 5, 5_000);
  try {
    const coord = h.store.coordinationHandle;
    // Second runtime (same shared DB) with its own session.
    const regB = new FakeRegistry();
    regB.register(makeAgent("session-b1", "C:\\work"));
    const rtB = new BridgeRuntime(h.store, regB, {
      pollMs: 50,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
    });
    h.registry.register(makeAgent("session-a1", "C:\\work"));
    h.registry.register(makeAgent("session-a2", "D:\\other"));
    h.runtime.start();
    rtB.start();
    try {
      // Cross-process merge: sessions of both runtimes are live together.
      await waitFor(async () => coord.listLiveSessions().length === 3);
      assert.deepEqual(coord.listLiveSessions().map((row) => row.sessionId).sort(), ["session-a1", "session-a2", "session-b1"]);
      // Teardown (stop) of one runtime removes ONLY its own rows.
      await h.runtime.stop();
      const live = coord.listLiveSessions();
      assert.deepEqual(live.map((row) => row.sessionId), ["session-b1"], "A's rows released on its stop");
      // Awaiting past several heartbeats: A's rows must NOT be resurrected.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(coord.listLiveSessions().map((row) => row.sessionId), ["session-b1"], "no resurrection after stop");
      // TTL expiry prunes a crashed (non-stopping) owner.
      const crashNow = Date.now();
      const crashTtlMs = 120;
      const crashCwdKey = (await import("../src/coordination.js")).cwdKey("C:\\work");
      coord.refreshOwnerSessions("owner-crash", [{ sessionId: "session-crash", cwd: "C:\\work" }], crashTtlMs, crashNow);
      assert.ok(coord.liveSessionsForCwd(crashCwdKey, crashNow + crashTtlMs - 1).some((row) => row.sessionId === "session-crash"));
      assert.ok(!coord.liveSessionsForCwd(crashCwdKey, crashNow + crashTtlMs).some((row) => row.sessionId === "session-crash"), "crashed lease expiry");
      // A new owner takes over the same session id (after B stops renewing it).
      await rtB.stop();
      coord.refreshOwnerSessions("owner-new", [{ sessionId: "session-b1", cwd: "C:\\work" }], 60_000);
      assert.equal(coord.sessionsForOwner("owner-new").length, 1, "the new owner holds the session");
    } finally {
      await h.runtime.stop().catch(() => undefined);
      await rtB.stop();
    }
  } finally {
    await rmClosed(h.directory);
  }
});

/** Session heartbeat is independent of the pump: a long-running handler that
 * outlasts the session TTL must still keep the runtime's sessions alive. */
test("session heartbeat keeps sessions live across a long handler", async () => {
  const h = await harness(10, 10, 5, 300); // TTL 300, heartbeat period 100
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-hb", "C:\\work");
    h.registry.register(target);
    const gate = deferredGate();
    const runtime = new BridgeRuntime(h.store, h.registry, {
      pollMs: 10,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      afterFollowupHook: () => gate.promise,
    });
    runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-hb", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    // Let the handler run long enough to outlast the 300ms session TTL several
    // times (the followup hook holds the pump busy), then verify the session is
    // still live thanks to the independent heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const live = h.store.coordinationHandle.sessionsForOwner(runtime["claimOwner"]);
    assert.equal(live.some((row) => row.sessionId === "session-hb"), true, "session stayed live during a long handler");
    gate.release();
    await waitForReceipt(h.store, command.requestId);
    await runtime.stop();
  } finally {
    await rmClosed(h.directory);
  }
});

type DeferredGate = { promise: Promise<void>; release: () => void };
function deferredGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

/** Same-cwd multi-session dispatch is a deterministic terminal ambiguity to a
 * single owner — never delivered to an arbitrary session, never stolen. */
test("same-cwd multi-session dispatch is a terminal ambiguity for a deterministic owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-runtime-ambig-"));
  try {
    const storageDir = join(directory, "storage");
    const store1 = new BridgeStore(storageDir);
    const store2 = new BridgeStore(storageDir);
    const wf1 = new WorkflowStore(join(directory, "workflows"));
    const wf2 = new WorkflowStore(join(directory, "workflows"));
    const m1 = new WorkflowManager(wf1, new NoopGateway(), { ...config, storageDir: directory }, undefined, store1);
    const m2 = new WorkflowManager(wf2, new NoopGateway(), { ...config, storageDir: directory }, undefined, store2);
    const reg1 = new FakeRegistry();
    const reg2 = new FakeRegistry();
    const s1 = makeAgent("session-ambig-1", "C:\\work");
    const s2 = makeAgent("session-ambig-2", "C:\\work");
    reg1.register(s1);
    reg2.register(s2);
    const rt1 = new BridgeRuntime(store1, reg1, { pollMs: 2, storageDir, manager: m1, workflowStore: wf1 });
    const rt2 = new BridgeRuntime(store2, reg2, { pollMs: 2, storageDir, manager: m2, workflowStore: wf2 });
    rt1.start();
    rt2.start();
    try {
      const command = dispatch({ target: { cwd: "C:\\work" } }); // no explicit session id
      await store1.enqueue(command);
      const receipt = await waitForReceipt(store1, command.requestId);
      assert.equal(receipt.status, "failed", "ambiguity is terminal");
      assert.match(receipt.error ?? "", /multiple live DSH sessions match cwd/);
      assert.equal(s1.followups.length, 0, "never delivered to the first session");
      assert.equal(s2.followups.length, 0, "never delivered to the second session");
      // Exactly one deterministic owner claimed it (attempts bounded; no dead letter).
      assert.equal((await store1.rowsByStatus("dead-letter")).length, 0);
    } finally {
      await rt1.stop();
      await rt2.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

test("session cwd matching is Windows case/separator insensitive", async () => {
  const h = await harness();
  try {
    const coord = h.store.coordinationHandle;
    const cwdKey = (await import("../src/coordination.js")).cwdKey;
    coord.refreshOwnerSessions("owner-win", [{ sessionId: "session-win", cwd: "C:\\Work\\Sub Dir" }], 60_000);
    assert.ok(coord.liveSessionsForCwd(cwdKey("c:/work/sub dir")).some((row) => row.sessionId === "session-win"), "case/separator insensitive");
    assert.equal(coord.liveSessionsForCwd(cwdKey("D:\\other")).length, 0);
  } finally {
    await rmClosed(h.directory);
  }
});

/** Finding 6: concurrent BridgeRuntime.stop() share one settle promise. */
test("concurrent BridgeRuntime.stop() share one settle promise", async () => {
  const h = await harness(10);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-conc-stop", "C:\\work");
    h.registry.register(target);
    const gate = deferredGate();
    const runtime = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      afterFollowupHook: () => gate.promise,
    });
    runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-conc-stop", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
    });
    await h.store.enqueue(command);
    // Handler holds the pump busy via afterFollowupHook.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const first = runtime.stop();
    let secondDone = false;
    const second = runtime.stop();
    second.then(() => { secondDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondDone, false, "the second stop must not resolve before the first settles");
    gate.release();
    await Promise.all([first, second]);
    assert.equal(secondDone, true);
  } finally {
    await rmClosed(h.directory);
  }
});

test("stop waits for the active pump finalizer before releasing storage", async () => {
  const h = await harness(5);
  const gate = deferredGate();
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const originalRefresh = h.runtime.refreshSessions.bind(h.runtime);
  let blockFinalizer = true;
  h.runtime.refreshSessions = async (force = false) => {
    await originalRefresh(force);
    if (!force && blockFinalizer) {
      enteredResolve();
      await gate.promise;
    }
  };

  h.runtime.start();
  let stopping: Promise<void> | undefined;
  try {
    await entered;
    let stopped = false;
    stopping = h.runtime.stop();
    stopping.then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped, false, "stop must await the full pump finalizer");
  } finally {
    blockFinalizer = false;
    gate.release();
    await (stopping ?? h.runtime.stop());
    await rmClosed(h.directory);
  }
});

test("the normal bridge pump continuously retries due Codex callbacks", async () => {
  const h = await harness(20);
  try {
    let recoveries = 0;
    h.manager.recoverCallbacks = async () => {
      recoveries += 1;
      return 0;
    };
    h.runtime.start();
    await waitFor(() => recoveries >= 2);
  } finally {
    await h.runtime.stop();
    await rmClosed(h.directory);
  }
});

const nonBlockingFinding = {
  severity: "medium" as const,
  blocking: false,
  title: "Nit",
  body: "Could be cleaner",
};

/** Finding 1 (runtime leg): a non-blocking changes_requested verdict reaches
 * waiting_review_decision; a workspace change between prepare and relay must
 * void it — relay VOID, phase back to executing, latestReview cleared, and
 * the submission still delivers. */
test("voiding a waiting_review_decision verdict returns to executing and delivers VOID", async () => {
  const h = await harness(5);
  try {
    const workspace = await makeWorkspace(h.directory);
    const target = makeAgent("session-wrd-void", "C:\\work");
    h.registry.register(target);
    const runtime = new BridgeRuntime(h.store, h.registry, {
      pollMs: 5,
      storageDir: join(h.directory, "storage"),
      manager: h.manager,
      workflowStore: h.workflowStore,
      beforeRelayHook: async () => {
        await writeFile(join(workspace, "a.txt"), "changed between prepare and relay\n", "utf8");
      },
    });
    runtime.start();
    const bridge = await makeBridgeWorkflow(h, "session-wrd-void", workspace);
    const command = verdict({
      workflowId: bridge.workflowId,
      codexThreadId: bridge.codexThreadId,
      submissionId: bridge.submissionId,
      verdict: { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "nits" },
    });
    await h.store.enqueue(command);
    const receipt = await waitForReceipt(h.store, command.requestId);
    assert.equal(receipt.status, "delivered");
    const record = await h.workflowStore.load(bridge.workflowId);
    assert.equal(record?.phase, "executing", "waiting_review_decision invalidates back to executing");
    assert.equal(record?.submissionState, "delivered", "the VOID verdict still delivers its terminal receipt");
    assert.equal(record?.latestReview, undefined, "the decision-gate review is cleared");
    assert.equal(record?.appliedVerdictEvidenceFingerprint, undefined);
    assert.ok(target.followups.length >= 1);
    assert.match(target.followups.map((f) => f.text).join("\n"), /void|no longer valid|not applied/i, "relayed a VOID notice");
    await runtime.stop();
  } finally {
    await rmClosed(h.directory);
  }
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

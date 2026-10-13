import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexAppServerClient } from "../src/app-server.js";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand } from "../src/bridge-protocol.js";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { CodexCliAuditGateway } from "../src/codex-cli-audit.js";
import type { CodexReviewEndEvent } from "../src/review-events.js";
import { WorkflowStore } from "../src/store.js";
import type { AlignmentOutcome, ReviewResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const VERDICT: ReviewResult = { verdict: "changes_requested", findings: [{ severity: "medium", blocking: false,
  title: "Persist a diagnostic history", body: "Add persistent history outside the approved read-only scope" }],
  testGaps: [], summary: "The review still proposes unapproved persistence" };
const REVIEW = "VERDICT: changes_requested\nFINDINGS: Persist a diagnostic history outside the approved read-only scope.\nTEST GAPS: none\nSUMMARY: The review still proposes unapproved persistence.";
const CONFLICT: AlignmentOutcome = { aligned: false, conflicts: [{ kind: "finding", index: 0,
  reason: "Unapproved persistence violates the read-only plan", violated: "approved read-only plan", highSeverityException: false }] };

test("an owned Bridge contract block closes its own progress exactly once without losing terminal-phase authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-owned-final-phase-"));
  await writeFile(join(directory, "changed.txt"), "approved read-only diagnostic implementation", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const owner = SessionId("owned-final-phase-owner");
  const parent = { id: owner, session: Session.create(owner, [], { version: SESSION_FORMAT_VERSION, id: owner,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  const children: Session[] = [];
  const disposed: string[] = [];
  const commands: BridgeCommand[] = [];
  const released: string[] = [];
  let pins = 0;
  let nativeCalls = 0;
  let conversions = 0;
  let alignments = 0;
  let reconciliations = 0;
  const gateway: CodexGateway = {
    async startThread(): Promise<never> { throw new Error("Authority validation is explicitly routed to the test audit adapter"); },
    async startReviewerThread() { return "owned-final-reviewer"; },
    async resumeThread(): Promise<never> { throw new Error("No existing Reviewer is resumed"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in the owned contract block"); },
    async resolveDefaultModel() { return "model-A"; },
    async startTurn(threadId, input) {
      const turnId = input.conversion ? "owned-conversion" : "owned-review";
      await input.onStarted?.({ threadId, turnId });
      if (input.conversion) { conversions += 1; return { kind: "completed", threadId, turnId,
        status: "completed", text: JSON.stringify(VERDICT) }; }
      nativeCalls += 1;
      input.onProgress?.({ kind: "message", itemId: turnId, text: REVIEW });
      return { kind: "completed", threadId, turnId, status: "completed", text: REVIEW };
    },
    async startReview(): Promise<never> { throw new Error("The public Bridge path uses the callback dispatcher"); },
    async normalizeInFork(): Promise<never> { throw new Error("No private App Server authority fork is allowed in CLI audit mode"); },
    async interrupt() {},
    async unsubscribeThread(id) { released.push(id); },
    isThreadAvailable: () => true,
    beginRound() { pins += 1; }, endRound() { pins -= 1; },
  };
  const audit: CodexCliAuditGateway = {
    async createReview(): Promise<never> { throw new Error("The audit cannot replace the original callback review"); },
    async review(): Promise<never> { throw new Error("The audit cannot start a second original review"); },
    async normalize() { return structuredClone(VERDICT); },
    async align() { alignments += 1; return structuredClone(CONFLICT); },
    async reconcile() { reconciliations += 1; return { visibleText: REVIEW, verdict: structuredClone(VERDICT) }; },
    cancel() {}, cancelSubmission() {}, async stop() {},
  };
  let provider: SubagentProvider;
  const factory = new CodexChildSessionFactory({ create: async (input: { sessionId: ReturnType<typeof SessionId>; meta: object }) => {
    const child = Session.create(input.sessionId, [], { version: SESSION_FORMAT_VERSION, id: input.sessionId,
      createdAt: Date.now(), cwd: directory, isSeeded: false, ...input.meta });
    children.push(child);
    return { agent: { id: child.id, session: child } as Agent, async dispose() { disposed.push(child.id); } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => undefined; },
    async start(name: string, request: { parent: Agent; label: string; prompt: unknown; signal: AbortSignal }) {
      return provider.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) } as never);
    },
  } as never);
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", conversionTransport: "cli", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
    leaseTtlMs: 60000, reviewHeartbeatMs: 60000, turnTimeoutMs: 1000, idleProcessMs: 0, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, audit, {}, { get: (id) => id === owner ? parent : undefined }, factory);
  const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
  try {
    const record = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: owner },
      task: "Implement read-only local health diagnostics without persistence", planMarkdown: "<proposed_plan>\nInspect diagnostics read-only; do not persist history.\n</proposed_plan>", assumptions: [] }, parent);
    await store.update(record.id, (current) => { current.reviewContractFailures = 1; });
    const submitted = await manager.submit(record.id, { implementationSummary: "Read-only diagnostics implemented", changedFiles: ["changed.txt"] }, exec);
    const deadline = Date.now() + 5000;
    while (runtime.backgroundTasks.size > 0) {
      if (Date.now() > deadline) throw new Error("The owned Bridge block did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const blocked = (await store.load(record.id))!;
    assert.equal(blocked.phase, "blocked");
    assert.equal(blocked.reviewContractFailures, 2);
    assert.equal(blocked.submissionState, "failed");
    assert.equal(blocked.reviewCycles, 0);
    assert.equal(blocked.latestReview, undefined);
    assert.equal(blocked.stagedVerdict, undefined);
    assert.equal(nativeCalls, 1); assert.equal(conversions, 1);
    assert.equal(alignments, 2); assert.equal(reconciliations, 1);
    assert.equal(commands.filter((command) => command.kind === "submission_notice").length, 1);
    assert.equal(commands.some((command) => command.kind === "submit_verdict"), false);
    assert.equal(blocked.submissionId, submitted.submissionId);
    assert.equal(blocked.submissionLeaseToken, undefined);
    assert.equal(store.coordinationHandle.leaseInfo(`submission:${record.id}:${submitted.submissionId}`)?.owner ?? "", "");
    assert.deepEqual(released, ["owned-final-reviewer"]);
    assert.deepEqual(disposed, [children[0]!.id]);
    assert.equal(pins, 0);
    assert.notEqual(blocked.processState, "running", "an owned terminal block must close its own progress state");
    const ended = parent.session.snapshotEvents().filter((event) => event.type === "dsh-codex-workflow/review-end");
    assert.equal(ended.length, 1, "phase changed by this owner must still produce one terminal review-end");
    const end = ended[0]!.data as CodexReviewEndEvent;
    assert.equal(end.workflowId, record.id);
    assert.notEqual(end.processState, "running");
  } finally {
    await manager.stop(); factory.unregisterProvider(); store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});

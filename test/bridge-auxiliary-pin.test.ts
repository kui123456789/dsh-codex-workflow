import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import type { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { newRequestId, type BridgeCommand, type SubmitVerdictCommand } from "../src/bridge-protocol.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

async function verifyBridgePrivatePin(createFailure = false): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-auxiliary-pin-"));
  await writeFile(join(directory, "changed.txt"), "verified read-only local diagnostic", "utf8");
  const store = new WorkflowStore(join(directory, "storage"));
  const observations: Array<{ stage: string; pins: number }> = [];
  const threadKinds = new Map<string, "original" | "alignment" | "reconciliation">();
  const released: string[] = [];
  const commands: BridgeCommand[] = [];
  let pins = 0;
  let begins = 0;
  let ends = 0;
  let clock = 0;
  let alignments = 0;
  let reconciliations = 0;
  let primaryPinAfterReturn: number | undefined;
  const original: ReviewResult = { verdict: "changes_requested", findings: [{ severity: "low", blocking: false,
    title: "Generic scope expansion", body: "Add an unrelated interface beyond the approved local diagnostic" }],
    testGaps: [], summary: "One generic improvement" };
  const corrected: ReviewResult = { verdict: "pass", findings: [], testGaps: [], summary: "Approved diagnostic verified" };
  const visible = "VERDICT: changes_requested\nFINDINGS: low non-blocking Generic scope expansion\nTEST GAPS: none\nSUMMARY: One generic improvement.";
  const correctedVisible = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: Approved diagnostic verified.";
  const requirePin = (stage: string) => {
    observations.push({ stage, pins });
    assert.ok(pins > 0, `${stage} requires a live process pin after the original callback released its own pin`);
  };
  const gateway: CodexGateway = {
    async startReviewerThread() { threadKinds.set("original-reviewer", "original"); return "original-reviewer"; },
    async startThread(options) {
      const kind = options.name?.includes("Reconciliation") ? "reconciliation" : "alignment";
      requirePin(`create-${kind}`);
      if (createFailure) throw new Error("AUX-CREATE-FAILED-SENTINEL: thread creation returned no identity");
      const threadId = `${kind}-${threadKinds.size}`;
      threadKinds.set(threadId, kind);
      return threadId;
    },
    async resumeThread() { throw new Error("No durable thread is resumed by this Bridge review"); },
    async startTurn(threadId, options) {
      const kind = threadKinds.get(threadId);
      if (kind === "reconciliation") requirePin("reconciliation-model");
      await options.onStarted?.({ threadId, turnId: `turn-${reconciliations + 1}` });
      if (kind === "original") return { kind: "completed", threadId, turnId: "original-turn", status: "completed",
        text: options.conversion ? JSON.stringify(original) : visible };
      reconciliations += 1;
      if (reconciliations <= 2) return { kind: "completed", threadId, turnId: `reconciliation-${reconciliations}`,
        status: "failed", text: "", reason: "server_overloaded" };
      return { kind: "completed", threadId, turnId: "reconciliation-complete", status: "completed", text: correctedVisible };
    },
    async normalizeInFork(options) {
      const kind = threadKinds.get(options.threadId);
      requirePin(`${kind}-conversion`);
      await options.onStarted?.({ threadId: options.threadId, turnId: "conversion" });
      let value: unknown = corrected;
      if (kind === "alignment") {
        alignments += 1;
        value = alignments === 1 ? { aligned: false, conflicts: [{ kind: "finding", index: 0,
          reason: "The suggestion exceeds the approved task", violated: "original task", highSeverityException: false }] }
          : { aligned: true, conflicts: [] };
      }
      return { kind: "completed", threadId: options.threadId, turnId: "conversion", status: "completed", text: JSON.stringify(value) };
    },
    async startReview(): Promise<never> { throw new Error("Bridge review must use its callback"); },
    async continueTurn(): Promise<never> { throw new Error("No clarification in this Bridge review"); },
    async resolveDefaultModel() { return "model-A"; },
    async interrupt() {},
    async unsubscribeThread(threadId) { released.push(threadId); },
    isThreadAvailable: (threadId) => threadKinds.has(threadId),
    beginRound() { pins += 1; begins += 1; },
    endRound() {
      pins -= 1; ends += 1;
      if (ends === 1) primaryPinAfterReturn = pins;
    },
  };
  const callback = new AppServerCodexCallbackDispatcher(gateway as unknown as CodexAppServerClient, {
    policy: { baseMs: 1, maxMs: 1, budgetMs: 0, jitterRatio: 0 },
  });
  const config: WorkflowConfig = { codexCommand: "unused", autoTriggerMode: "off", plannerModel: "model-A", reviewerModel: "model-A",
    plannerEffort: "low", reviewerEffort: "low", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536, bridgePollMs: 1000, bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: 1000, callbackMaxAttempts: 1, callbackRetryBaseMs: 60000,
    transientRetryBaseMs: 3000, transientRetryMaxMs: 60000, transientRetryBudgetMs: 20000, transientRetryJitterRatio: 0,
    turnTimeoutMs: 1000, idleProcessMs: 5000, terminalRelayTimeoutMs: 1000, storageDir: store.directory };
  const manager = new WorkflowManager(store, gateway, config, callback, { async enqueue(command) {
    commands.push(command); return command.requestId;
  } }, undefined, {
    now: () => clock,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      requirePin(`backoff-${ms}`);
      clock += ms;
    },
  });
  const id = SessionId("bridge-auxiliary-pin-owner");
  const parent = { id, session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
    createdAt: Date.now(), cwd: directory, isSeeded: false }) } as Agent;
  const exec = { agent: parent, signal: new AbortController().signal, deferContext() {} } as unknown as ToolRunContext;
  try {
    const bridge = await manager.startExternalPlan({ version: 1, kind: "dispatch_plan", requestId: newRequestId(),
      createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: directory, dshSessionId: id },
      task: "Implement and review a read-only local diagnostic", planMarkdown: "<proposed_plan>\nInspect configuration read-only.\n</proposed_plan>", assumptions: [] }, parent);
    const submitted = await manager.submit(bridge.id, { implementationSummary: "Read-only diagnostic implemented", changedFiles: ["changed.txt"] }, exec);
    // Pin ownership spans the actual submission, including its cleanup. A
    // fixed observation deadline can expire while that owned task still runs.
    const runtime = (manager as unknown as { runtime: WorkflowRuntimeState }).runtime;
    await Promise.all([...runtime.backgroundTasks]);
    const settled = await store.load(bridge.id);
    assert.ok(settled);
    assert.notEqual(settled.submissionState, "queued", "The actual submission has completed before pin assertions");
    assert.notEqual(settled.submissionState, "sending", "The actual submission has completed before pin assertions");
    assert.equal(settled.submissionLeaseToken, undefined, "The submission's actual finalizer released its record fence");
    assert.equal(primaryPinAfterReturn, 0, "The real callback dispatcher released its original pin before auxiliary work");
    assert.ok(observations.length > 0);
    assert.ok(observations.every((entry) => entry.pins > 0), `Unpinned private work: ${JSON.stringify(observations)}`);
    if (createFailure) {
      assert.equal(settled.submissionState, "retrying");
      assert.match(settled.submissionError ?? "", /AUX-CREATE-FAILED-SENTINEL/);
      assert.equal(settled.reviewCycles, 0);
      assert.equal(settled.latestReview, undefined);
      assert.equal(commands.length, 0);
      assert.equal(pins, 0, "Failure before thread identity is returned must still release the auxiliary pin");
      assert.equal(begins, 2);
      assert.equal(ends, 2);
      assert.deepEqual([...threadKinds.keys()], ["original-reviewer"], "An unknown auxiliary identity must not be fabricated");
      assert.deepEqual(released, ["original-reviewer"], "Only the known original subscription is released");
      return;
    }
    assert.equal(settled.submissionState, "received", settled.submissionError);
    assert.equal(settled.submissionId, submitted.submissionId);
    assert.equal(settled.reviewCycles, 0);
    assert.equal(reconciliations, 3);
    assert.equal(alignments, 2);
    assert.ok(observations.some((entry) => entry.stage === "backoff-3000"));
    assert.ok(observations.some((entry) => entry.stage === "backoff-6000"), "The real retry path exceeds the unchanged five-second idle window");
    assert.ok(observations.some((entry) => entry.stage === "alignment-conversion" && entry.pins === 2), "Nested alignment holds its pin while reconciliation still owns its outer pin");
    assert.equal(pins, 0);
    assert.equal(begins, ends);
    assert.equal(begins, 4, "Original callback, initial alignment, reconciliation and re-alignment each own one pin");
    assert.ok([...threadKinds.keys()].every((threadId) => released.filter((releasedId) => releasedId === threadId).length === 1));
    const command = commands.find((value): value is SubmitVerdictCommand => value.kind === "submit_verdict");
    assert.ok(command);
    assert.deepEqual(command, settled.stagedVerdict?.command);
    assert.equal((await manager.applyExternalVerdict(command)).reviewCycles, 1);
  } finally {
    await manager.stop(); store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`), "Cleanup remains within the isolated temporary directory");
    await rm(directory, { recursive: true, force: true });
  }
}

test("Bridge private reconciliation owns its process pin across creation, backoff and nested alignment", async () => {
  await verifyBridgePrivatePin();
});

test("Bridge auxiliary creation failure releases its pin without inventing an unknown thread identity", async () => {
  await verifyBridgePrivatePin(true);
});

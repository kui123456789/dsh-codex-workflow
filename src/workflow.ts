import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CoordinationStore } from "./coordination.js";
import { CodexInvalidThreadError, CodexNoVerdictError } from "./codex-callback.js";
import { newRequestId, type DispatchPlanCommand, type SubmitVerdictCommand } from "./bridge-protocol.js";
import { collectEvidence, isGitRepository } from "./evidence.js";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { WorkflowStore } from "./store.js";
import type {
  PlannerResult,
  ReviewEvidence,
  ReviewInput,
  ReviewResult,
  SubmissionState,
  TurnNeedsInputResult,
  TurnWaitResult,
  WorkflowConfig,
  WorkflowPhase,
  WorkflowRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface CodexGateway {
  startThread(options: { cwd: string; model?: string; name: string }, signal?: AbortSignal): Promise<string>;
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  startTurn(threadId: string, options: {
    prompt: string;
    model?: string;
    effort?: WorkflowConfig["plannerEffort"];
    outputSchema?: Record<string, unknown>;
    planMode?: boolean;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<TurnWaitResult>;
  continueTurn(
    pending: TurnNeedsInputResult,
    answers: Record<string, string[]>,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult>;
  startReview(options: {
    threadId: string;
    cwd: string;
    target: Record<string, unknown>;
    detached: boolean;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
  interrupt(threadId: string, turnId: string, signal?: AbortSignal): Promise<void>;
}

export type { ReviewInput };

/** Resumable exact-thread callback injected by the host. */
export interface CodexCallback {
  send(
    request: { workflowId: string; submissionId: string; codexThreadId: string; cwd: string; prompt: string },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "verdict"; verdict: ReviewResult }
    | { kind: "retryable_busy" }
  >;
  cancel(workflowId: string): void;
  /** Kill the exact callback child for one submission (lease-loss fencing:
   * an owner that lost its lease must kill its own child, never the new
   * owner's). */
  cancelSubmission(workflowId: string, submissionId: string): void;
  stop(): Promise<void>;
}

export class WorkflowManager {
  private readonly pending = new Map<string, TurnNeedsInputResult>();
  private readonly nudgedTurns = new Set<string>();
  private readonly recovering = new Set<string>();
  /** Recovery-derived background tasks that must settle before teardown. */
  private readonly backgroundTasks = new Set<Promise<unknown>>();
  /** Teardown gate: once set, no new callback send may start and in-flight
   * recovery is aborted so no child can be (re)spawned after stop(). */
  private stopped = false;
  private stopPromise?: Promise<void>;
  private recoveryController?: AbortController;
  private recoveryChain?: Promise<void>;
  private activeRecovery = false;
  /** Submission lease lifetime; heartbeats renew at ttl/3 while a callback
   * runs, so only crashed owners are ever taken over. */
  private readonly leaseTtlMs: number;

  constructor(
    private readonly store: WorkflowStore,
    private readonly codex: CodexGateway,
    private readonly config: WorkflowConfig,
    private readonly callback?: CodexCallback,
    private readonly bridgeQueue?: { enqueue(command: SubmitVerdictCommand): Promise<string> },
  ) {
    this.leaseTtlMs = config.leaseTtlMs ?? 60_000;
  }

  /** Resumable Codex callback used by bridge workflows; injected by the host. */
  get callbackDispatcher(): CodexCallback | undefined {
    return this.callback;
  }

  /** Teardown: block new sends, abort in-flight recovery (and its backoff
   * delays), await EVERY recovery-derived background task (recoverStagedVerdict
   * enqueue/commit, runSubmissionCallback chains), and finally kill + await
   * every callback child. No late task may still be enqueueing, updating the
   * store or spawning a child when stop() returns. Concurrent stop() calls
   * share ONE settle promise, so a second caller can never resolve before the
   * first has truly finished tearing down.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const task = this.doStop();
    this.stopPromise = task;
    return task;
  }

  private async doStop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.recoveryController?.abort();
    this.recoveryController = undefined;
    const chain = this.recoveryChain;
    this.recoveryChain = undefined;
    if (chain) await chain.catch(() => undefined);
    // Wait for every recovery-derived task to settle (they observe the abort
    // and stop writing/enqueueing/spawning).
    const tasks = [...this.backgroundTasks];
    await Promise.allSettled(tasks);
    await this.callback?.stop();
  }

  /** Track every recovery-derived background task so teardown can await them
   * before closing the stores; late store/enqueue writes are impossible after
   * stop() returns. */
  private trackBackground(task: Promise<unknown>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    }).catch(() => undefined);
  }

  async start(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    await this.assertNoActiveWorkflow(agent.id);
    const now = new Date().toISOString();
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      dshSessionId: agent.id,
      cwd: agent.session.header.cwd ?? process.cwd(),
      task: args.task.trim(),
      mode: "planned",
      phase: "planning",
      createdAt: now,
      updatedAt: now,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
    };
    await this.store.save(record);
    try {
      const plannerThreadId = await this.codex.startThread({
        cwd: record.cwd,
        ...(args.plannerModel || this.config.plannerModel
          ? { model: args.plannerModel || this.config.plannerModel }
          : {}),
        name: threadName("DSH Plan", args.task),
      }, exec.signal);
      const threadCommit = await this.store.update(record.id, (r) => {
        r.plannerThreadId = plannerThreadId;
      }, { ignoreCancelled: false });
      if (threadCommit.suppressed) return threadCommit.record;
      const outcome = await this.codex.startTurn(plannerThreadId, {
        prompt: plannerPrompt(record.task),
        ...(args.plannerModel || this.config.plannerModel
          ? { model: args.plannerModel || this.config.plannerModel }
          : {}),
        effort: args.plannerEffort ?? this.config.plannerEffort,
        outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        planMode: true,
        // Persist the planner turn the moment it starts so cancel can interrupt it.
        onStarted: (started) => this.registerActiveTurn(record.id, started.threadId, started.turnId, "planner"),
      }, exec.signal);
      return await this.acceptPlannerOutcome(record.id, outcome, exec);
    } catch (error) {
      const failed = await this.store.update(record.id, (r) => {
        r.phase = "failed";
        r.error = errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      throw error;
    }
  }

  /**
   * Apply a verdict for the exact originating Codex thread and submission.
   * State-machine invariants:
   *  - The FIRST apply of an external verdict only ever moves `received` →
   *    `applied`. `verdict_ready` (verdict staged, enqueue not yet committed)
   *    is NOT applicable yet — the runtime retries until the enqueue commits.
   *  - While a staged verdict exists, any command whose request id differs
   *    from the staged identity is rejected terminally, no matter its arrival
   *    order (a conflicting manual verdict can never jump ahead of the
   *    expected one).
   *  - Replays of the SAME request id in applied/delivered are idempotent
   *    returns; the same submission with a DIFFERENT request id is rejected.
   *  - The verdict is bound to the evidence fingerprint captured at submit
   *    time; apply re-collects the current fingerprint and refuses (without
   *    applying anything) when the workspace changed or became unverifiable.
   *  - Legacy manual path (no staged verdict) applies from waiting_verdict.
   * The outcome (including refusal) is persisted in one atomic CAS update.
   */
  async applyExternalVerdict(command: SubmitVerdictCommand): Promise<WorkflowRecord> {
    const record = await this.store.load(command.workflowId);
    if (!record) throw new Error(`unknown workflow ${command.workflowId}`);
    if (record.origin !== "codex_bridge") {
      throw new Error(`workflow ${command.workflowId} is not a Codex-bridge workflow`);
    }
    if (record.codexThreadId !== command.codexThreadId) {
      throw new Error(`verdict thread mismatch: expected ${record.codexThreadId}, got ${command.codexThreadId}`);
    }
    if (command.dshSessionId !== undefined && record.dshSessionId !== command.dshSessionId) {
      // A forged/stale target must never let a wrong runtime apply first: the
      // declared session must equal the record's real one.
      throw new Error(
        `verdict session mismatch: workflow ${command.workflowId} belongs to session ${record.dshSessionId}, command answers ${command.dshSessionId}`,
      );
    }
    if (record.phase === "cancelled") return record;
    // Async evidence work happens OUTSIDE the store transaction (the CAS only
    // carries synchronous validation + writes).
    const evidence = await collectEvidence({
      cwd: record.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: record.pendingReviewRequest?.changedFiles,
    });
    const outcome = await this.store.update(command.workflowId, (r) => {
      // Idempotent replay of the SAME request identity (already applied and/or
      // delivered): return the record without touching it.
      if (r.appliedVerdictRequestId === command.requestId) return r;
      // The same submission already applied by a DIFFERENT request id: refuse.
      if (command.submissionId !== undefined && r.appliedVerdictSubmissionId === command.submissionId) {
        throw new Error(
          `verdict for workflow ${command.workflowId} already applied as request ${r.appliedVerdictRequestId}, command answers ${command.requestId}`,
        );
      }
      if (command.submissionId !== undefined && r.submissionId !== command.submissionId) {
        throw new Error(
          `stale submission: workflow ${command.workflowId} is on submission ${r.submissionId ?? "(none)"}, verdict answers ${command.submissionId}`,
        );
      }
      if (command.submissionId === undefined && r.submissionId && submissionActive(r.submissionState)) {
        throw new Error(`verdict for workflow ${command.workflowId} is missing its submission id`);
      }
      if (r.stagedVerdict) {
        // The expected identity must be applied; anything else is refused.
        if (r.stagedVerdict.command.requestId !== command.requestId) {
          throw new Error(
            `verdict for workflow ${command.workflowId} already staged as request ${r.stagedVerdict.command.requestId}, command answers ${command.requestId}`,
          );
        }
        if (r.submissionState === "verdict_ready") {
          // Staged but the enqueue has not committed yet: retryable, never
          // terminal — the pump must wait for `received`.
          throw new Error(`verdict for workflow ${command.workflowId} is not yet applicable: submission is still staging`);
        }
        if (r.submissionState !== "received") {
          throw new Error(`verdict cannot be applied to workflow ${command.workflowId} in submission state ${r.submissionState}`);
        }
      } else if (r.submissionState !== undefined
        && r.submissionState !== "waiting_verdict"
        && r.submissionState !== "received") {
        throw new Error(`verdict cannot be applied to workflow ${command.workflowId} in submission state ${r.submissionState}`);
      }
      if (!r.pendingReviewRequest) {
        throw new Error(`verdict for workflow ${command.workflowId} arrived before any submission`);
      }
      const submitted = r.latestReviewEvidence;
      if (!submitted?.fingerprint || !evidence.fingerprint) {
        // Unverifiable workspace: refuse to apply ANY verdict (a pass must
        // never ride an empty fingerprint).
        r.error = "workspace cannot be verified (insufficient evidence); the verdict was not applied — re-submit with observable changed files inside the workspace";
        r.latestReview = undefined;
        r.pendingReviewRequest = undefined;
        r.submissionState = "applied";
        r.appliedVerdictRequestId = command.requestId;
        r.appliedVerdictSubmissionId = command.submissionId ?? r.submissionId;
        r.appliedVerdictEvidenceFingerprint = undefined;
        r.stagedVerdict = undefined;
        r.callbackState = "idle";
        return r;
      }
      if (submitted.fingerprint !== evidence.fingerprint) {
        // The reviewer saw a different workspace: the old verdict must never
        // apply — not even "pass".
        r.error = "workspace changed since the review (evidence fingerprint mismatch); the verdict was not applied — make the changes and call codex_workflow_submit again for a fresh review";
        r.latestReview = undefined;
        r.pendingReviewRequest = undefined;
        r.submissionState = "applied";
        r.appliedVerdictRequestId = command.requestId;
        r.appliedVerdictSubmissionId = command.submissionId ?? r.submissionId;
        r.appliedVerdictEvidenceFingerprint = undefined;
        r.stagedVerdict = undefined;
        r.callbackState = "idle";
        return r;
      }
      const result = applyReviewConsistency(command.verdict);
      r.latestReviewEvidence = evidence;
      this.trackNoChange(r, evidence);
      r.reviewCycles += 1; // a structured verdict is now applied: count the cycle
      const computed = this.computeReviewOutcome(r, result);
      r.latestReview = result;
      r.pendingReviewRequest = undefined;
      r.submissionState = "applied";
      r.appliedVerdictRequestId = command.requestId;
      r.appliedVerdictSubmissionId = command.submissionId ?? r.submissionId;
      // The fingerprint the applied verdict is valid against, kept until
      // delivery so a workspace change after apply invalidates the verdict.
      r.appliedVerdictEvidenceFingerprint = evidence.fingerprint;
      r.stagedVerdict = undefined;
      r.callbackState = "idle";
      r.phase = computed.phase;
      r.error = computed.error;
      r.noChangeReviewRounds = computed.noChangeReviewRounds ?? r.noChangeReviewRounds;
      return r;
    }, { ignoreCancelled: false });
    return outcome.record;
  }

  /**
   * Delivery-time re-verification (the PREPARE step): recompute the workspace
   * fingerprint BEFORE the outcome is relayed. If the workspace changed after
   * the verdict was applied (e.g. while the DSH session was offline), the
   * applied verdict — including a "pass" — is INVALIDATED: the workflow
   * returns to a safe executing state and the relay reports the invalidation.
   *
   * State discipline: invalidation marks the verdict as pending-invalidation
   * but does NOT write `delivered` — `submissionState` stays `applied` so the
   * runtime's pre-relay check accepts it and relays the (VOID) notice; the
   * durable `delivered` is committed only after the relay succeeds.
   * A cancelled workflow always short-circuits without touching state.
   */
  async assertVerdictStillValid(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }> {
    const loaded = await this.store.load(command.workflowId);
    if (!loaded) return { invalidated: false, record: loaded as unknown as WorkflowRecord };
    if (loaded.phase === "cancelled") return { invalidated: false, record: loaded };
    if (loaded.error && /workspace changed after the review/.test(loaded.error)) {
      // Already pending-invalidation: keep relaying the VOID notice verbatim.
      return { invalidated: true, record: loaded };
    }
    if (loaded.error && /was not applied|cannot be verified/.test(loaded.error)) {
      // Refused at apply time: relay the refusal as-is.
      return { invalidated: false, record: loaded };
    }
    if (!loaded.appliedVerdictEvidenceFingerprint) return { invalidated: false, record: loaded };
    if (loaded.submissionId !== command.submissionId) return { invalidated: false, record: loaded };
    const evidence = await collectEvidence({
      cwd: loaded.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: loaded.latestReviewEvidence?.changedFiles,
    });
    if (evidence.fingerprint && evidence.fingerprint === loaded.appliedVerdictEvidenceFingerprint) {
      return { invalidated: false, record: loaded };
    }
    // Invalidate: phase -> executing (from passed / waiting_review_decision;
    // blocked is a max-cycle terminal and is NOT regressed), error set,
    // fingerprint cleared, but submissionState stays `applied`
    // (pending-invalidation). Regressing `passed` and `waiting_review_decision`
    // to executing keeps the VOID guidance consistent with what the tools
    // accept: the owning session can call codex_workflow_submit again (submit
    // only accepts executing/fixing) for a fresh review — otherwise the
    // workflow would be permanently stuck.
    const outcome = await this.store.update(loaded.id, (r) => {
      if (r.phase === "cancelled") return;
      if (r.submissionId !== command.submissionId) return;
      if (r.phase === "passed" || r.phase === "waiting_review_decision") r.phase = "executing";
      r.error = "workspace changed after the review (evidence fingerprint mismatch); the applied verdict is void — call codex_workflow_submit again for a fresh review";
      r.latestReview = undefined;
      r.appliedVerdictEvidenceFingerprint = undefined;
      r.stagedVerdict = undefined;
    }, { ignoreCancelled: false });
    if (outcome.suppressed || outcome.record.phase === "cancelled") {
      return { invalidated: false, record: outcome.record };
    }
    return { invalidated: true, record: outcome.record };
  }

  /**
   * Commit the delivered state AFTER the relay succeeded. Returns whether the
   * exact CAS committed (`committed: true`) — the update is fenced on the
   * exact submission/request identity and only fires while the verdict is
   * still `applied` (or pending-invalidation). A cancel or a new submission
   * that won between prepare and commit suppresses the write (`committed:
   * false`), so the old verdict can never mark delivered over the new owner;
   * the caller must then ack the queue as cancelled/suppressed, never
   * delivered. Async work (fingerprint re-check) happens in
   * {@link assertVerdictStillValid} before this, never inside the
   * transaction.
   */
  async commitVerdictDelivery(
    command: SubmitVerdictCommand,
  ): Promise<{ committed: boolean; record: WorkflowRecord }> {
    let changed = false;
    const outcome = await this.store.update(command.workflowId, (r) => {
      if (command.submissionId !== undefined && r.submissionId !== command.submissionId) return;
      if (r.appliedVerdictRequestId !== command.requestId) return;
      if (r.submissionState !== "applied") return;
      r.submissionState = "delivered";
      r.callbackState = "idle";
      changed = true;
    }, { ignoreCancelled: false });
    return { committed: !outcome.suppressed && changed, record: outcome.record };
  }

  /**
   * Create a workflow from an external (Codex-led) dispatch: the plan arrives
   * through the bridge instead of the local Planner, so no planner thread is
   * ever created. The workflow is bound to the exact DSH session that will
   * execute it and to the originating Codex thread id for the later callback.
   *
   * Creation is atomic across processes: a session-scoped fenced lease
   * (`workflow-create:<sessionId>`) serializes creators, and the
   * active-workflow and bridge-request existence checks run INSIDE the lease.
   * Two processes dispatching the same request (or same session) therefore
   * yield exactly one workflow — the second caller returns the same record
   * idempotently or is rejected as already active; never two active
   * workflows.
   */
  async startExternalPlan(command: DispatchPlanCommand, agent: Agent): Promise<WorkflowRecord> {
    // Bounded wait for the session-scoped create lease so concurrent
    // creators of the SAME request converge idempotently instead of failing:
    // the loser waits, then re-checks byBridgeRequest and returns the record
    // the winner created.
    const lease = await this.acquireWorkflowCreateLease(agent.id);
    if (!lease) {
      throw new Error(`session ${agent.id} is already creating a Codex workflow`);
    }
    try {
      const existing = await this.store.byBridgeRequest(command.requestId);
      if (existing) return existing; // idempotent dispatch replay
      if (await this.store.activeForSession(agent.id)) {
        throw new Error(`session ${agent.id} already has an active Codex workflow`);
      }
      const now = new Date().toISOString();
      const record: WorkflowRecord = {
        schemaVersion: 1,
        id: randomUUID(),
        dshSessionId: agent.id,
        cwd: command.target.cwd,
        task: command.task,
        mode: "planned",
        origin: "codex_bridge",
        phase: "executing",
        createdAt: now,
        updatedAt: now,
        assumptions: command.assumptions,
        questions: [],
        reviewCycles: 0,
        noChangeReviewRounds: 0,
        callbackAttempts: 0,
        callbackState: "idle",
        codexThreadId: command.codexThreadId,
        bridgeRequestId: command.requestId,
        bridgeDeliveryState: "prepared",
        planMarkdown: ensurePlanBlock(command.planMarkdown),
      };
      await this.store.save(record);
      return record;
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  async continue(
    workflowId: string,
    answers: Record<string, string[]>,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "waiting_input" || !record.plannerThreadId) {
      throw new Error(`workflow ${workflowId} is not waiting for planner input`);
    }
    let outcome: TurnWaitResult;
    const pending = this.pending.get(workflowId);
    if (pending) {
      outcome = await this.codex.continueTurn(pending, answers, exec.signal);
    } else {
      await this.codex.resumeThread(record.plannerThreadId, record.cwd, exec.signal);
      outcome = await this.codex.startTurn(record.plannerThreadId, {
        prompt: resumedAnswerPrompt(answers),
        ...(this.config.plannerModel ? { model: this.config.plannerModel } : {}),
        effort: this.config.plannerEffort,
        outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        planMode: true,
        onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "planner"),
      }, exec.signal);
    }
    return this.acceptPlannerOutcome(workflowId, outcome, exec);
  }

  async review(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be reviewed from phase ${record.phase}`);
    }
    if (record.mode !== "review_only") {
      if (!record.planMarkdown || !record.plannerThreadId) throw new Error(`workflow ${workflowId} has no completed plan`);
    }
    return this.reviewOnce(workflowId, input, exec, record.mode === "review_only" ? undefined : record.plannerThreadId);
  }

  /**
   * DSH-side submission for Codex-bridge workflows. Every submission gets a
   * durable `submissionId`; at most one unfinished submission exists per
   * workflow. A workflow-scoped fenced lease is taken BEFORE the submissionId
   * is generated, so two processes can never create different active
   * submissions for the same workflow; the per-submission callback lease is
   * held (with heartbeats) for the whole callback lifecycle. Non-git
   * submissions must carry observable, cwd-contained changedFiles — an
   * unverifiable workspace is rejected outright. All state updates are
   * atomic revision-CAS writes conditional on the submission id.
   */
  async submit(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.origin !== "codex_bridge") {
      throw new Error(`workflow ${workflowId} is not a Codex-bridge workflow; use codex_workflow_review instead`);
    }
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be submitted from phase ${record.phase}`);
    }
    if (!record.codexThreadId) throw new Error(`workflow ${workflowId} has no Codex thread to resume`);
    if (!this.callback) throw new Error("Codex callback dispatcher is not available");

    const evidence = await collectEvidence({
      cwd: record.cwd,
      maxDiffBytes: this.config.reviewDiffMaxBytes,
      changedFiles: input.changedFiles,
    });
    // An unverifiable workspace must never enter the review pipeline: an
    // empty fingerprint would let a later "pass" ride on nothing.
    if (evidence.insufficient || !evidence.fingerprint) {
      throw new Error(
        "submit requires observable changed files inside the workspace: provide non-empty, cwd-contained, readable changedFiles (non-git workspace) or run inside a git repository",
      );
    }

    // Workflow-scoped lease BEFORE generating the submissionId: two processes
    // can never both create an active submission for the same workflow.
    const submitLease = await this.acquireWorkflowSubmitLease(workflowId);
    if (!submitLease) throw new Error(`workflow ${workflowId} is being submitted by another process`);
    let submissionId: string | undefined;
    let lease: ManagerLease | undefined;
    let submitReleased = false;
    try {
      submissionId = randomUUID();
      lease = await this.acquireSubmissionLease(workflowId, submissionId);
      if (!lease) throw new Error(`submission ${submissionId} is claimed by another process`);
      const prepared = await this.store.update(workflowId, (r) => {
        if (r.submissionId && submissionActive(r.submissionState)) {
          throw new Error(`workflow ${workflowId} already has an active submission ${r.submissionId}`);
        }
        r.pendingReviewRequest = input;
        r.latestReviewEvidence = evidence;
        // reviewCycles is NOT incremented here: a review cycle only counts a
        // STRUCTURED VERDICT successfully received/applied, never an attempt
        // (busy/timeout/invalid-thread/infra failures keep the submission
        // retryable without consuming a cycle).
        r.submissionId = submissionId;
        r.submissionState = "queued";
        r.submissionAttempts = 0;
        r.submissionError = undefined;
        r.submissionLeaseToken = lease!.owner;
        r.submissionLeaseEpoch = lease!.epoch;
        r.submissionLeaseUntil = Date.now() + this.leaseTtlMs;
        r.callbackState = "queued"; // legacy mirror
        r.callbackError = undefined;
      }, { ignoreCancelled: false });
      if (prepared.suppressed) return prepared.record;
      // The workflow-scoped fence has done its job (one active submission is
      // now durably persisted); release it before the long callback runs.
      await submitLease.release();
      submitReleased = true;
      const prompt = callbackPrompt(prepared.record, input, evidence);
      return await this.runSubmissionCallback(workflowId, submissionId, prompt, prepared.record, exec.signal, lease);
    } finally {
      lease?.stopHeartbeat();
      await lease?.release().catch(() => undefined);
      if (lease && submissionId) {
        const leaseOwner = lease.owner;
        const sid = submissionId;
        // Clear the record-level lease fence so a later recovery round can
        // re-claim the (finished) submission without tripping on stale fields.
        await this.store.update(workflowId, (r) => {
          if (r.submissionId !== sid) return;
          if (r.submissionLeaseToken !== leaseOwner) return;
          r.submissionLeaseToken = undefined;
          r.submissionLeaseEpoch = undefined;
          r.submissionLeaseUntil = undefined;
        }, { ignoreCancelled: true }).catch(() => undefined);
      }
      if (!submitReleased) await submitLease.release().catch(() => undefined);
    }
  }

  /** Workflow-scoped fence: serializes submission creation per workflow. */
  private async acquireWorkflowSubmitLease(workflowId: string): Promise<ManagerLease | undefined> {
    return this.acquireLease(`submit:${workflowId}`);
  }

  /** Session-scoped creation fence with a bounded wait: two processes
   * dispatching for the same session briefly contend; the loser retries until
   * the winner releases, then proceeds to the (idempotent) byBridgeRequest /
   * active-for-session checks. */
  private async acquireWorkflowCreateLease(sessionId: string): Promise<ManagerLease | undefined> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const lease = await this.acquireLease(`workflow-create:${sessionId}`);
      if (lease) return lease;
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  private async acquireSubmissionLease(workflowId: string, submissionId: string): Promise<ManagerLease | undefined> {
    return this.acquireLease(`submission:${workflowId}:${submissionId}`);
  }

  private async acquireLease(resource: string): Promise<ManagerLease | undefined> {
    // Ensure the store's directory exists before opening the coordination
    // database (a fresh storage directory has no coord.sqlite yet).
    await this.store.init();
    const owner = `${process.pid}-${randomUUID()}`;
    const grant = this.store.coordinationHandle.acquireLease(resource, this.leaseTtlMs, owner);
    if (!grant) return undefined;
    return makeManagerLease(this.store.coordinationHandle, resource, grant.epoch, grant.owner, this.leaseTtlMs);
  }

  /**
   * One callback run for a submission: spawn the exact-thread resume, apply
   * the structured verdict or classify the failure, with bounded retry on
   * busy conditions. Verdict handling is a durable two-phase pipeline so a
   * crash can never lose the only valid verdict:
   *
   *   phase A: persist `verdict_ready` + `stagedVerdict` containing the FULL
   *            verdict command (requestId AND createdAt minted once, here) —
   *            atomic store write;
   *   phase B: idempotently enqueue that exact command (same requestId,
   *            createdAt, commandHash);
   *   phase C: commit `received` (the staged identity is KEPT until applied).
   *
   * A crash between A and B leaves `verdict_ready`; startup recovery
   * re-enqueues the exact staged command. Transient enqueue failures keep the
   * staged identity and retry — they never mark the submission failed; only
   * unrecoverable identity/schema errors do. Every write is a revision-CAS
   * conditional on the submission id and never moves a finished submission
   * backwards.
   */
  private async runSubmissionCallback(
    workflowId: string,
    submissionId: string,
    prompt: string,
    seed: WorkflowRecord,
    signal?: AbortSignal,
    lease?: ManagerLease,
  ): Promise<WorkflowRecord> {
    let current = seed;
    let leaseLost = false;
    // Every state write must stay fenced to THIS lease (submissionId + token +
    // epoch): a stale owner can never rewrite a submission the lease moved on.
    const isCurrent = (record: WorkflowRecord) =>
      record.submissionId === submissionId
      && !submissionTerminal(record.submissionState)
      && (!lease || (record.submissionLeaseToken === lease.owner && record.submissionLeaseEpoch === lease.epoch));
    const updateCurrent = async (fn: (record: WorkflowRecord) => void): Promise<WorkflowRecord> => {
      const outcome = await this.store.update(workflowId, (r) => {
        if (!isCurrent(r)) return;
        fn(r);
      }, { ignoreCancelled: false });
      current = outcome.record;
      return current;
    };
    lease?.heartbeat(this.leaseTtlMs / 3, () => {
      // We lost the lease (renew changed 0 rows): another process owns the
      // callback now. Kill our child and stop writing state — the stale
      // callback must never enqueue a verdict or regress the new owner's
      // received/applied/delivered back to sending/retrying/failed.
      leaseLost = true;
      this.callback?.cancelSubmission(workflowId, submissionId);
    });
    try {
      for (let attempt = (current.submissionAttempts ?? 0) + 1; ; attempt += 1) {
        if (this.stopped || signal?.aborted || leaseLost) return current;
        const sending = await updateCurrent((r) => {
          r.submissionState = "sending";
          r.submissionAttempts = attempt;
        });
        if (sending.submissionId !== submissionId || submissionTerminal(sending.submissionState)) {
          return sending; // cancelled or re-claimed by another restarter
        }
        let outcome: { kind: "verdict"; verdict: ReviewResult } | { kind: "retryable_busy" };
        try {
          outcome = await this.callback!.send({
            workflowId,
            submissionId,
            codexThreadId: current.codexThreadId!,
            cwd: current.cwd,
            prompt,
          }, signal);
        } catch (error) {
          if (leaseLost) return current; // we were taken over mid-flight: write nothing
          if (error instanceof CodexInvalidThreadError || error instanceof CodexNoVerdictError) {
            await updateCurrent((r) => {
              r.submissionState = "failed";
              r.submissionError = error.message;
              r.callbackState = "failed";
            });
            return current;
          }
          if (signal?.aborted) throw error;
          outcome = { kind: "retryable_busy" };
        }
        if (leaseLost) return current; // never write or enqueue after losing the lease
        if (outcome.kind === "verdict") {
          if (!this.bridgeQueue) {
            const committed = await updateCurrent((r) => {
              r.submissionState = "waiting_verdict";
              r.submissionError = undefined;
              r.callbackState = "waiting_verdict";
            });
            return committed;
          }
          // Phase A: persist the FULL verdict command BEFORE touching the queue.
          // requestId and createdAt are minted exactly once, here; recovery
          // re-enqueues this exact command so requestId+createdAt+commandHash
          // are identical every time.
          let stagedRequestId: string | undefined;
          const staged = await updateCurrent((r) => {
            stagedRequestId = newRequestId();
            const command: SubmitVerdictCommand = {
              version: 1,
              kind: "submit_verdict",
              requestId: stagedRequestId,
              createdAt: new Date().toISOString(),
              workflowId,
              codexThreadId: r.codexThreadId ?? current.codexThreadId!,
              submissionId,
              // Route the verdict to the runtime owning the workflow session.
              dshSessionId: r.dshSessionId,
              verdict: outcome.verdict,
            };
            r.submissionState = "verdict_ready";
            r.stagedVerdict = { command, createdAt: command.createdAt };
            r.submissionError = undefined;
          });
          if (staged.submissionId !== submissionId || submissionTerminal(staged.submissionState)) return staged;
          // Phase B: idempotent enqueue of the exact staged command.
          const enqueued = await this.enqueueStagedVerdict(workflowId, submissionId, staged, signal);
          if (enqueued !== "committed") return enqueued;
          // Phase C: mark received; the staged identity is KEPT until applied
          // so a conflicting manual verdict can never jump ahead of it. A
          // verdict already applied by the queue pump in the meantime is
          // terminal and wins.
          const received = await updateCurrent((r) => {
            if (r.stagedVerdict?.command.requestId !== stagedRequestId) return;
            r.submissionState = "received";
            r.callbackState = "idle";
          });
          return received;
        }
        const busy = await updateCurrent((r) => {
          r.submissionState = "retrying";
          r.submissionError = "codex thread busy or rate limited";
          r.callbackState = "retrying";
        });
        if (busy.submissionId !== submissionId || submissionTerminal(busy.submissionState)) return busy;
        if (attempt >= this.config.callbackMaxAttempts) {
          await updateCurrent((r) => {
            r.submissionState = "failed";
            r.submissionError = `codex thread busy after ${attempt} attempts`;
            r.callbackState = "failed";
          });
          return current;
        }
        await delay(this.config.callbackRetryBaseMs * 2 ** (attempt - 1), signal);
        if (signal?.aborted) throw abortError(signal);
      }
    } catch (error) {
      if (signal?.aborted || this.stopped) throw error;
      await updateCurrent((r) => {
        r.submissionState = "failed";
        r.submissionError = errorMessage(error);
        r.callbackState = "failed";
      });
      return current;
    } finally {
      lease?.stopHeartbeat();
    }
  }

  /**
   * Enqueue the staged verdict command with bounded in-place retry (no
   * callback respawn). TRANSIENT failures (queue busy, I/O) never mark the
   * submission failed: the staged identity stays and later recovery rounds
   * (or a plugin restart) keep re-enqueueing the exact same command. Only
   * clearly unrecoverable identity/schema errors terminate the submission.
   * Returns `"committed"` or the workflow record in its current state.
   */
  private async enqueueStagedVerdict(
    workflowId: string,
    submissionId: string,
    staged: WorkflowRecord,
    signal?: AbortSignal,
  ): Promise<WorkflowRecord | "committed"> {
    const stagedVerdict = staged.stagedVerdict;
    if (!stagedVerdict) return staged;
    for (let attempt = 1; ; attempt += 1) {
      if (this.stopped || signal?.aborted) return staged;
      try {
        await this.bridgeQueue!.enqueue(stagedVerdict.command);
        return "committed";
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isUnrecoverableEnqueueError(error)) {
          const failed = await this.store.update(workflowId, (r) => {
            if (r.submissionId !== submissionId) return;
            r.submissionState = "failed";
            r.submissionError = `verdict enqueue rejected: ${errorMessage(error)}`;
            r.callbackState = "failed";
            // The staged identity is kept for audit; recovery never re-enqueues
            // a failed submission.
          }, { ignoreCancelled: false });
          return failed.record;
        }
        if (attempt >= this.config.callbackMaxAttempts) {
          // Transient exhaustion: stay verdict_ready with the staged identity
          // intact; recovery re-enqueues on the next round or restart.
          await this.store.update(workflowId, (r) => {
            if (r.submissionId !== submissionId || r.submissionState !== "verdict_ready") return;
            r.submissionError = `verdict enqueue transient failure after ${attempt} attempts: ${errorMessage(error)}; recovery will retry`;
          }, { ignoreCancelled: false });
          return staged;
        }
        await delay(this.config.callbackRetryBaseMs * 2 ** (attempt - 1), signal);
      }
    }
  }

  /**
   * Plugin-start recovery: resume callbacks that were durably persisted but
   * never finished, using the persisted exact thread id and submission id.
   * Only queued/sending/retrying submissions are re-spawned (received means
   * the callback already finished and the verdict is queued); a `verdict_ready`
   * submission is NOT re-spawned — its staged verdict is re-enqueued with the
   * SAME request id (durable two-phase recovery). Cross-process exclusivity
   * comes from the submission lease; the per-process recovery set and the
   * atomic state claim deduplicate within one process. Attempts are only
   * incremented by an actual callback send, never by a recovery claim.
   *
   * Recovery is SINGLE-FLIGHT: there is exactly one active controller/chain.
   * A concurrent second call while the first is still running returns 0
   * without touching the references, so a caller can never overwrite the
   * active run that stop() is about to abort/await (which would otherwise let
   * stop() return before the abandoned run finished writing).
   */
  recoverCallbacks(): Promise<number> {
    if (!this.callback) return Promise.resolve(0);
    if (this.stopped) return Promise.resolve(0); // teardown gate: nothing to recover, never touch a closing store
    if (this.activeRecovery) return Promise.resolve(0);
    this.activeRecovery = true;
    const controller = new AbortController();
    this.recoveryController = controller;
    const chain = this.runRecovery(controller.signal);
    // Keep the chain for teardown without letting a failure escape start().
    this.recoveryChain = Promise.resolve(chain).then(() => undefined, () => undefined);
    return chain.finally(() => {
      this.activeRecovery = false;
    });
  }

  private async runRecovery(signal: AbortSignal): Promise<number> {
    let recovered = 0;
    for (const record of await this.store.list()) {
      if (signal.aborted || this.stopped) break;
      if (record.origin !== "codex_bridge") continue;
      const submissionId = record.submissionId;
      if (!submissionId) continue;

      // Verdict obtained but never enqueued: durable two-phase recovery.
      if (record.submissionState === "verdict_ready" && record.stagedVerdict) {
        if (this.recovering.has(submissionId)) continue;
        this.recovering.add(submissionId);
        this.trackBackground(
          this.recoverStagedVerdict(record.id, submissionId, record, signal)
            .finally(() => this.recovering.delete(submissionId)),
        );
        continue;
      }

      if (!RECOVERABLE_STATES.has(record.submissionState as SubmissionState)) continue;
      if (this.recovering.has(submissionId)) continue;
      if ((record.submissionAttempts ?? 0) >= this.config.callbackMaxAttempts) {
        await this.store.update(record.id, (r) => {
          if (r.submissionId !== submissionId) return;
          r.submissionState = "failed";
          r.submissionError = "callback attempts exhausted before recovery";
          r.callbackState = "failed";
        }, { ignoreCancelled: false });
        continue;
      }
      // Cross-process claim gate: a live lease (another DSH process) means the
      // submission is being handled right now; only expired leases are taken.
      const lease = await this.acquireSubmissionLease(record.id, submissionId);
      if (!lease) continue;
      this.recovering.add(submissionId);
      const claimed = await this.store.update(record.id, (r) => {
        if (r.submissionId !== submissionId) return false;
        if (!RECOVERABLE_STATES.has(r.submissionState as SubmissionState)) return false;
        // The DB submission lease is the authoritative gate (only the true
        // owner holds it after an atomic acquire); stamp the record with the
        // fence so the running callback's writes stay bound to this owner.
        r.submissionState = "sending";
        r.submissionLeaseToken = lease!.owner;
        r.submissionLeaseEpoch = lease!.epoch;
        r.submissionLeaseUntil = Date.now() + this.leaseTtlMs;
        r.callbackState = "sending";
        return true;
      }, { ignoreCancelled: false });
      if (claimed.suppressed || !claimed.result) {
        this.recovering.delete(submissionId);
        await lease.release().catch(() => undefined);
        continue; // another restarter won the atomic claim
      }
      recovered += 1;
      const seed = claimed.record;
      const input = seed.pendingReviewRequest;
      if (!input) {
        this.recovering.delete(submissionId);
        await lease.release().catch(() => undefined);
        await this.store.update(seed.id, (r) => {
          if (r.submissionId !== submissionId) return;
          r.submissionState = "failed";
          r.submissionError = "missing pending review request during recovery";
          r.callbackState = "failed";
        }, { ignoreCancelled: false });
        continue;
      }
      const prompt = callbackPrompt(seed, input, seed.latestReviewEvidence ?? await collectEvidence({
        cwd: seed.cwd,
        maxDiffBytes: this.config.reviewDiffMaxBytes,
        changedFiles: input.changedFiles,
      }));
      this.trackBackground(
        this.runSubmissionCallback(seed.id, submissionId, prompt, seed, signal, lease)
          .finally(() => {
            this.recovering.delete(submissionId);
            return (async () => {
              await lease.release().catch(() => undefined);
              // Clear the record-level lease fence after the callback finishes.
              await this.store.update(seed.id, (r) => {
                if (r.submissionId !== submissionId) return;
                if (r.submissionLeaseToken !== lease.owner) return;
                r.submissionLeaseToken = undefined;
                r.submissionLeaseEpoch = undefined;
                r.submissionLeaseUntil = undefined;
              }, { ignoreCancelled: true }).catch(() => undefined);
            })();
          }),
      );
    }
    return recovered;
  }

  /** Re-enqueue the staged verdict with its persisted FULL command (same
   * requestId, createdAt, commandHash — idempotent against the queue) and
   * commit `received`; never spawns a callback. Transient failures leave
   * verdict_ready for the next recovery round; the staged identity never
   * changes. */
  private async recoverStagedVerdict(
    workflowId: string,
    submissionId: string,
    seed: WorkflowRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const staged = seed.stagedVerdict!;
      const interim = await this.enqueueStagedVerdict(workflowId, submissionId, seed, signal);
      if (interim !== "committed") return;
      await this.store.update(workflowId, (r) => {
        if (r.submissionId !== submissionId || r.submissionState !== "verdict_ready") return;
        if (r.stagedVerdict?.command.requestId !== staged.command.requestId) return;
        r.submissionState = "received";
        r.callbackState = "idle";
      }, { ignoreCancelled: false });
    } catch {
      // Abort (teardown) or a store error: leave verdict_ready for the next
      // recovery round; the staged identity stays unchanged.
    }
  }

  /**
   * Review-only entry: unlike `start`, it never runs the Codex planner. A fresh
   * read-only source thread hosts the first detached reviewer; later rounds
   * reuse the persisted reviewer thread via the ordinary `review` tool. All
   * evidence, decision-gate, no-change and cycle-limit logic is shared.
   */
  async reviewOnly(
    args: {
      task?: string;
      implementationSummary: string;
      changedFiles?: string[];
      testResults?: string;
      reviewerModel?: string;
      reviewerEffort?: WorkflowConfig["reviewerEffort"];
    },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    await this.assertNoActiveWorkflow(agent.id);
    const cwd = agent.session.header.cwd ?? process.cwd();
    if (!(await isGitRepository(cwd)) && !(Array.isArray(args.changedFiles) && args.changedFiles.length > 0)) {
      throw new Error(
        "review-only in a non-git workspace requires changedFiles so the changes can be observed by the reviewer",
      );
    }
    const now = new Date().toISOString();
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      dshSessionId: agent.id,
      cwd,
      task: (args.task ?? "").trim(),
      mode: "review_only",
      phase: "reviewing",
      createdAt: now,
      updatedAt: now,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
      // Persist the effective reviewer model/effort so later repair rounds keep
      // the caller's override even when the bundle config changes.
      reviewerModel: args.reviewerModel || this.config.reviewerModel || undefined,
      reviewerEffort: args.reviewerEffort ?? this.config.reviewerEffort,
    };
    await this.store.save(record);
    let sourceThread: string;
    try {
      sourceThread = await this.codex.startThread({
        cwd: record.cwd,
        ...(record.reviewerModel ? { model: record.reviewerModel } : {}),
        name: threadName("DSH Review", record.task || "review workspace"),
      }, exec.signal);
      const sourceCommit = await this.store.update(record.id, (r) => {
        r.sourceThreadId = sourceThread;
      }, { ignoreCancelled: false });
      if (sourceCommit.suppressed) return sourceCommit.record;
    } catch (error) {
      const failed = await this.store.update(record.id, (r) => {
        r.phase = "failed";
        r.error = errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      throw error;
    }
    return this.reviewOnce(record.id, {
      implementationSummary: args.implementationSummary,
      ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
      ...(args.testResults ? { testResults: args.testResults } : {}),
    }, exec, sourceThread);
  }

  async decide(
    workflowId: string,
    input: { decision: "accept" | "fix"; note?: string },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "waiting_review_decision") {
      throw new Error(`workflow ${workflowId} is not waiting for a review decision (phase ${record.phase})`);
    }
    const review = record.latestReview;
    if (!review) throw new Error(`workflow ${workflowId} has no review to decide on`);
    const nextAction = record.origin === "codex_bridge"
      ? "call codex_workflow_submit with workflowId " + workflowId + " again after fixing the improvements"
      : "call codex_workflow_review with workflowId " + workflowId + " again after fixing the improvements";
    const message = input.decision === "accept"
      ? `Codex review for workflow ${workflowId} was accepted by the user: the non-blocking improvements below are recorded as deliberately not fixed.\n${formatFindings(review)}`
      : `Codex review for workflow ${workflowId} has non-blocking findings to fix. Apply each improvement below, rerun relevant tests, then ${nextAction} before answering the user.\n${formatFindings(review)}`;
    const commit = await this.store.update(workflowId, (r) => {
      r.reviewDecision = {
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
        decidedAt: new Date().toISOString(),
      };
      r.noChangeReviewRounds = 0;
      r.phase = input.decision === "accept" ? "passed" : "fixing";
      r.error = undefined;
    }, { ignoreCancelled: false });
    if (commit.suppressed) return commit.record;
    exec.deferContext(pluginMessage(message));
    return commit.record;
  }

  async status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    const record = workflowId ? await this.store.load(workflowId) : await this.store.activeForSession(agent.id);
    if (!record) throw new Error(workflowId ? `unknown workflow ${workflowId}` : "no active Codex workflow for this session");
    if (record.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  /**
   * Cancel is the only writer allowed to flip any state to cancelled. The
   * phase flip and the read of the currently known active turn happen in one
   * atomic update; the interrupt afterwards is best-effort and a failure keeps
   * the workflow cancelled. All other writers suppress themselves once the
   * record is cancelled, so cancelled is terminal.
   */
  async cancel(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    let target: { threadId: string; turnId: string } | undefined;
    const outcome = await this.store.update(workflowId, (r) => {
      if (r.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
      const threadId = r.reviewerThreadId ?? r.plannerThreadId;
      const turnId = r.reviewerTurnId ?? r.plannerTurnId;
      if (threadId && turnId) target = { threadId, turnId };
      r.phase = "cancelled";
      if (r.submissionId && !submissionTerminal(r.submissionState)) {
        // Terminate the in-flight submission so no callback state may regress.
        r.submissionState = "failed";
        r.submissionError = "workflow cancelled";
        r.callbackState = "failed";
      }
    }, { ignoreCancelled: true });
    if (target) {
      await this.codex.interrupt(target.threadId, target.turnId, exec.signal).catch(() => undefined);
    }
    // Kill the active callback child, if any; cancelled is terminal for it too.
    this.callback?.cancel(workflowId);
    return outcome.record;
  }

  async onTurnStopping(agent: Agent, turn: number): Promise<void> {
    const record = await this.store.activeForSession(agent.id);
    // waiting_review_decision must not be steered: the user (not the agent)
    // decides whether non-blocking findings get fixed.
    if (!record || (record.phase !== "executing" && record.phase !== "fixing")) return;
    const key = `${record.id}:${turn}`;
    if (this.nudgedTurns.has(key)) return;
    this.nudgedTurns.add(key);
    const action = record.origin === "codex_bridge"
      ? "call codex_workflow_submit with workflowId " + record.id + ", a concise implementation summary, changed files, and test results so the originating Codex task can review the result"
      : "call codex_workflow_review with workflowId " + record.id + ", a concise implementation summary, changed files, and test results before ending this turn";
    agent.steer(pluginMessage(
      record.phase === "executing"
        ? `Workflow ${record.id} is not complete: finish implementing the approved plan, run tests, then ${action}.`
        : `Workflow ${record.id} still has review findings: finish the fixes, rerun tests, then ${action}.`,
    ));
  }

  /**
   * Shared review pipeline used by both `review` and `reviewOnly`: capture
   * evidence, run the detached/inline reviewer, normalize its verdict, and
   * apply the blocking gate, no-change termination and cycle limits. Every
   * store write goes through the atomic update primitive; any write that races
   * a cancellation is suppressed and the cancelled record is returned.
   */
  private async reviewOnce(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
    initialSourceThread: string | undefined,
  ): Promise<WorkflowRecord> {
    const pre = await this.store.load(workflowId);
    const priorPhase: WorkflowPhase = pre?.phase === "fixing" ? "fixing" : "executing";
    const entering = await this.store.update(workflowId, (r) => {
      r.phase = "reviewing";
      // reviewCycles is NOT counted here: only a successfully applied verdict
      // consumes a cycle, so infrastructure failures (evidence/review/normalize
      // throws, timeouts) leave a retryable phase without burning a cycle.
    }, { ignoreCancelled: false });
    if (entering.suppressed) return entering.record;
    let current = entering.record;
    try {
      const evidence = await collectEvidence({
        cwd: current.cwd,
        maxDiffBytes: this.config.reviewDiffMaxBytes,
        changedFiles: input.changedFiles,
      });
      const git = await isGitRepository(current.cwd);
      const sourceThread = current.reviewerThreadId ?? initialSourceThread;
      if (!sourceThread) throw new Error(`workflow ${workflowId} has no review source thread`);
      if (current.reviewerThreadId) await this.codex.resumeThread(current.reviewerThreadId, current.cwd, exec.signal);

      const evidenceCommit = await this.store.update(workflowId, (r) => {
        r.latestReviewEvidence = evidence;
        this.trackNoChange(r, evidence);
      }, { ignoreCancelled: false });
      if (evidenceCommit.suppressed) return evidenceCommit.record;
      current = evidenceCommit.record;

      const review = await this.codex.startReview({
        threadId: sourceThread,
        cwd: current.cwd,
        detached: !current.reviewerThreadId,
        target: git
          ? { type: "uncommittedChanges" }
          : { type: "custom", instructions: reviewInstructions(current, input) },
        // Persist the reviewer thread/turn the moment the review has started so
        // codex_workflow_cancel can interrupt it while it is still running.
        onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer"),
      }, exec.signal);
      const afterReview = await this.store.load(workflowId);
      if (!afterReview || afterReview.phase === "cancelled") return afterReview!;
      current = afterReview;
      if (review.result.kind !== "completed") throw new Error("review unexpectedly requested user input");

      const normalized = await this.codex.startTurn(review.threadId, {
        prompt: normalizeReviewPrompt(current, input, review.result.text),
        // Effective model/effort persisted at review-only creation; planned
        // workflows fall back to the bundle config.
        ...(current.reviewerModel || this.config.reviewerModel
          ? { model: current.reviewerModel || this.config.reviewerModel }
          : {}),
        effort: current.reviewerEffort ?? this.config.reviewerEffort,
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        // The normalize turn becomes the active reviewer turn for cancellation.
        onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer"),
      }, exec.signal);
      const afterNormalize = await this.store.load(workflowId);
      if (!afterNormalize || afterNormalize.phase === "cancelled") return afterNormalize!;
      current = afterNormalize;
      if (normalized.kind !== "completed") throw new Error("review normalization unexpectedly requested user input");

      const result = applyReviewConsistency(parseReview(normalized.text));
      // Compute the outcome inside the atomic commit so the cycle count seen by
      // the outcome policy includes this round; the message is only injected
      // after the commit confirmed we were not cancelled in the meantime.
      let outcomeMessage: string | undefined;
      const commit = await this.store.update(workflowId, (r) => {
        r.latestReview = result;
        // A cycle is consumed only now that a structured verdict is applied:
        // infrastructure failures never eat a cycle, so retries stay possible.
        r.reviewCycles += 1;
        const outcome = this.computeReviewOutcome(r, result);
        outcomeMessage = outcome.message;
        r.noChangeReviewRounds = outcome.noChangeReviewRounds ?? r.noChangeReviewRounds;
        r.phase = outcome.phase;
        r.error = outcome.error;
      }, { ignoreCancelled: false });
      if (commit.suppressed) return commit.record;
      if (outcomeMessage) exec.deferContext(pluginMessage(outcomeMessage));
      return commit.record;
    } catch (error) {
      // A concurrent cancel wins over failure handling: never overwrite a
      // cancelled record. Otherwise an infrastructure failure (evidence/review/
      // normalize throw) returns the workflow to its RETRYABLE phase and
      // records the error — it must not burn a cycle or become failed, so the
      // same workflow can later receive its first real verdict.
      const failed = await this.store.update(workflowId, (r) => {
        if (r.phase !== "reviewing") return;
        r.phase = priorPhase;
        r.error = errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      throw error;
    }
  }

  /**
   * Persist a freshly started turn as the active turn of its kind. If the
   * workflow was cancelled in the meantime the write is suppressed (the record
   * is never resurrected) and the turn we just obtained is interrupted.
   */
  private async registerActiveTurn(
    workflowId: string,
    threadId: string,
    turnId: string,
    kind: "planner" | "reviewer",
  ): Promise<void> {
    const outcome = await this.store.update(workflowId, (r) => {
      if (kind === "planner") {
        r.plannerThreadId = threadId;
        r.plannerTurnId = turnId;
      } else {
        r.reviewerThreadId = threadId;
        r.reviewerTurnId = turnId;
      }
    }, { ignoreCancelled: false });
    if (outcome.suppressed) {
      // Cancelled while the turn was being registered: kill the turn we just
      // started, never the record.
      await this.codex.interrupt(threadId, turnId).catch(() => undefined);
    }
  }

  private trackNoChange(record: WorkflowRecord, evidence: ReviewEvidence): void {
    record.latestReviewEvidence = evidence;
    if (evidence.insufficient || !evidence.fingerprint) {
      // Unobservable rounds must not chain across themselves: clear the chain
      // so a later return to an old fingerprint is treated as fresh progress.
      record.noChangeReviewRounds = 0;
      record.previousReviewFingerprint = undefined;
      return;
    }
    if (record.previousReviewFingerprint !== undefined && evidence.fingerprint === record.previousReviewFingerprint) {
      record.noChangeReviewRounds = (record.noChangeReviewRounds ?? 0) + 1;
    } else {
      record.noChangeReviewRounds = 0;
    }
    record.previousReviewFingerprint = evidence.fingerprint;
  }

  /** Pure outcome computation: no store writes and no side effects. */
  private computeReviewOutcome(record: WorkflowRecord, result: ReviewResult): ReviewOutcome {
    const hasBlocking = result.findings.some((finding) => finding.blocking) || result.testGaps.length > 0;
    if (result.verdict === "pass") {
      return {
        phase: "passed",
        noChangeReviewRounds: 0,
        message: `Codex Reviewer passed workflow ${record.id}. Report the verified implementation and tests to the user.`,
      };
    }
    if (!hasBlocking) {
      // Non-blocking only: stop automatic repair and let the user decide.
      return {
        phase: "waiting_review_decision",
        noChangeReviewRounds: 0,
        message: `Codex Reviewer found only non-blocking improvements for workflow ${record.id}. Present each item below to the user and wait for their choice, then call codex_workflow_decide with workflowId ${record.id} and decision "accept" (ship as-is) or "fix" (repair first).\n${formatFindings(result)}`,
      };
    }
    if ((record.noChangeReviewRounds ?? 0) >= this.config.maxNoChangeReviewRounds) {
      return {
        phase: "blocked",
        noChangeReviewRounds: record.noChangeReviewRounds,
        error: `workspace produced no verifiable change for ${record.noChangeReviewRounds} consecutive review round(s) while the Codex Reviewer kept requesting blocking changes`,
        message: `Codex Reviewer still requests changes for workflow ${record.id}, but the workspace has not changed since the previous review (fingerprint identical). Stopping automatic repair and clearing the active turn. Report that no verifiable workspace change was made and show the remaining findings:\n${formatFindings(result)}`,
      };
    }
    if (record.reviewCycles >= this.config.maxReviewCycles) {
      return {
        phase: "blocked",
        noChangeReviewRounds: record.noChangeReviewRounds,
        error: `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles`,
        message: `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles. Stop automatic repair and report the remaining findings:\n${formatFindings(result)}`,
      };
    }
    return {
      phase: "fixing",
      noChangeReviewRounds: record.noChangeReviewRounds,
      message: `Codex Reviewer requested changes for workflow ${record.id}. Fix every finding below in this same DSH session, rerun relevant tests, then call codex_workflow_review again before answering the user.\n${formatFindings(result)}`,
    };
  }

  private async acceptPlannerOutcome(
    workflowId: string,
    outcome: TurnWaitResult,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    if (outcome.kind === "needs_input") {
      this.pending.set(workflowId, outcome);
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "waiting_input";
        r.questions = outcome.request.questions;
        r.pendingInput = { turnId: outcome.turnId, itemId: outcome.request.itemId };
      }, { ignoreCancelled: false });
      return commit.record;
    }
    this.pending.delete(workflowId);
    if (outcome.status !== "completed") throw new Error(outcome.error ?? `planner turn ${outcome.status}`);
    const result = parsePlanner(outcome.text);
    if (result.status === "needs_input") {
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "waiting_input";
        r.questions = result.questions;
        r.assumptions = result.assumptions;
      }, { ignoreCancelled: false });
      return commit.record;
    }
    if (result.status === "ready" && result.planMarkdown?.trim()) {
      const planMarkdown = ensurePlanBlock(result.planMarkdown);
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "executing";
        r.planMarkdown = planMarkdown;
        r.assumptions = result.assumptions;
        r.questions = [];
        r.pendingInput = undefined;
      }, { ignoreCancelled: false });
      if (!commit.suppressed) exec.deferContext(pluginMessage(executionPrompt(commit.record)));
      return commit.record;
    }
    const commit = await this.store.update(workflowId, (r) => {
      r.phase = "failed";
      r.error = result.message ?? "Codex planner did not return a usable plan";
    }, { ignoreCancelled: false });
    return commit.record;
  }

  private async owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.store.load(workflowId);
    if (!record) throw new Error(`unknown workflow ${workflowId}`);
    if (record.dshSessionId !== requireAgent(exec).id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  private async assertNoActiveWorkflow(sessionId: string): Promise<void> {
    const active = await this.store.activeForSession(sessionId);
    if (active) throw new Error(`session already has active Codex workflow ${active.id} (${active.phase})`);
  }
}

interface ReviewOutcome {
  phase: WorkflowPhase;
  error?: string;
  message?: string;
  noChangeReviewRounds?: number;
}

function plannerPrompt(task: string): string {
  return `You are the planning gate in a DSH-controlled coding workflow. Inspect the current workspace read-only and produce a decision-complete implementation plan for the task below. Do not edit files. Ask user questions only when a missing product decision makes a safe plan impossible. Return only the requested JSON object. planMarkdown must contain a complete <proposed_plan> block.\n\nTASK:\n${task}`;
}

function resumedAnswerPrompt(answers: Record<string, string[]>): string {
  return `Continue the existing plan using these user answers, then return the complete planner JSON result:\n${JSON.stringify(answers, null, 2)}`;
}

export function executionPrompt(record: WorkflowRecord): string {
  const submit = record.origin === "codex_bridge"
    ? `call codex_workflow_submit with workflowId ${record.id}, a concise implementation summary, changed files, and test results so the originating Codex task can review the result`
    : `call codex_workflow_review with workflowId ${record.id}, a concise implementation summary, changed files, and test results before answering the user`;
  return `Codex planning is complete for workflow ${record.id}. Implement the approved plan below in ${record.cwd}. You are the only mutation-capable executor: use normal DSH tools and approvals, keep scope faithful to the plan, run relevant verification, and then ${submit}.\n\n${record.planMarkdown}`;
}

function reviewInstructions(record: WorkflowRecord, input: ReviewInput): string {
  const plan = record.planMarkdown ? `\n\nPLAN:\n${record.planMarkdown}` : "";
  const task = record.mode === "review_only"
    ? `\n\nREVIEW TASK:\n${record.task || "(no explicit task — review the current changes)"}`
    : "";
  return `Review the current workspace read-only. Focus on correctness, regressions, security, and missing tests. Do not edit files.${plan}${task}\n\nIMPLEMENTATION SUMMARY:\n${input.implementationSummary}\n\nCHANGED FILES:\n${(input.changedFiles ?? []).join("\n") || "not supplied"}\n\nTEST RESULTS:\n${input.testResults ?? "not supplied"}`;
}

function normalizeReviewPrompt(
  record: WorkflowRecord,
  input: ReviewInput,
  rawReview: string,
): string {
  return `Convert the code review you just completed into the required JSON schema. For every finding set blocking to true only when it must be fixed before delivery: critical and high findings block by default; medium and low findings block only when they create an actual correctness, regression, security, or delivery-required test gap. Every entry in testGaps counts as blocking. verdict is pass only when there are no actionable correctness, regression, security, or material test findings. Preserve concrete file and line references.\n\nWorkflow: ${record.id}\nImplementation: ${input.implementationSummary}\nRaw review:\n${rawReview}`;
}

/** Prompt that resumes the exact originating Codex thread: the reviewer stays
 * read-only and returns the verdict as its final structured message. The
 * verdict is captured by the plugin from stdout and applied outside the
 * sandbox; the reviewer never writes the bridge queue itself.
 *
 * The full bounded evidence diff is embedded verbatim (already capped at
 * `reviewDiffMaxBytes` by evidence collection), and a truncation notice is
 * always shown whenever the diff was cut. The reviewer is explicitly allowed
 * to run READ-ONLY inspection commands and read files to see the parts beyond
 * the embedded evidence — but never to write/modify anything, create threads,
 * call DSH tools or the bridge CLI. */
function callbackPrompt(record: WorkflowRecord, input: ReviewInput, evidence: ReviewEvidence): string {
  return `You are the independent reviewer for a DSH-executed coding workflow. Review the implementation below against the original plan. Stay read-only: do not edit files, do not create replacement threads, and do not call any dsh tools.

WORKFLOW: ${record.id}
SUBMISSION: ${record.submissionId ?? "(unknown)"}
CWD: ${record.cwd}
REVIEW CYCLE: ${record.reviewCycles}

ORIGINAL TASK:
${record.task}

APPROVED PLAN:
${record.planMarkdown}

IMPLEMENTATION SUMMARY:
${input.implementationSummary}

CHANGED FILES:
${(input.changedFiles ?? []).join("\n") || "not supplied"}

TEST RESULTS:
${input.testResults ?? "not supplied"}

WORKSPACE EVIDENCE (kind: ${evidence.kind}):
${evidence.status || "(empty)"}
${evidence.diffTruncated ? `[diff truncated by evidence collection, observed ${evidence.diffBytes} bytes; the full diff was too large to embed]` : `[full observed diff, ${evidence.diffBytes} bytes]`}
${evidence.diff}

You MAY run read-only inspection commands (for example \`git diff\`, \`git status\`, \`git show\`, reading any file under the workspace) to review parts of the workspace not fully covered above — the sandbox runs read-only and makes this safe. You MUST NOT write or modify any file, run anything that mutates the workspace, create a replacement thread, call any dsh tool, or invoke the bridge CLI.

Return your verdict as the final message, as JSON matching the enforced output schema:
{ "verdict": "pass" | "changes_requested", "findings": [{ "severity": "critical"|"high"|"medium"|"low", "blocking": boolean, "title": string, "body": string, "file": string|null, "line": integer|null }], "testGaps": string[], "summary": string }
For every finding set blocking to true only when it must be fixed before delivery: critical and high findings block by default; medium and low findings block only when they create an actual correctness, regression, security, or delivery-required test gap. Every entry in testGaps counts as blocking.

Your JSON verdict is collected automatically from this reply; never write it to disk or to any other channel.`;
}

const SUBMISSION_ACTIVE = new Set<SubmissionState>(["queued", "sending", "waiting_verdict", "retrying", "verdict_ready", "received"]);
const SUBMISSION_TERMINAL = new Set<SubmissionState>(["applied", "delivered", "failed"]);
const RECOVERABLE_STATES = new Set<SubmissionState>(["queued", "sending", "retrying"]);

function submissionActive(state: SubmissionState | undefined): boolean {
  return state !== undefined && SUBMISSION_ACTIVE.has(state);
}

function submissionTerminal(state: SubmissionState | undefined): boolean {
  return state !== undefined && SUBMISSION_TERMINAL.has(state);
}

/** Fenced lease handle over the SQLite coordination store: every renew and
 * release is a conditional UPDATE on epoch+owner, so once another process
 * takes over the lease, the old owner's renew/release change 0 rows and are
 * no-ops. The heartbeat renews the lease for long callback runs; when a renew
 * returns false (changes=0, ownership lost) the onLost hook fires so the
 * owner can abort its child and stop writing state. */
interface ManagerLease {
  readonly owner: string;
  readonly epoch: number;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
  heartbeat(periodMs: number, onLost?: () => void): void;
  stopHeartbeat(): void;
}

function makeManagerLease(
  coordination: CoordinationStore,
  resource: string,
  epoch: number,
  owner: string,
  ttlMs: number,
): ManagerLease {
  let heartbeatTimer: NodeJS.Timeout | undefined;
  return {
    owner,
    epoch,
    renew: () => Promise.resolve(coordination.renewLease(resource, epoch, owner, ttlMs)),
    release: () => Promise.resolve(coordination.releaseLease(resource, epoch, owner)),
    heartbeat: (periodMs: number, onLost?: () => void) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        const ok = coordination.renewLease(resource, epoch, owner, ttlMs);
        if (!ok) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
          onLost?.();
        }
      }, Math.max(100, periodMs));
      heartbeatTimer.unref();
    },
    stopHeartbeat: () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    },
  };
}

/** Transient enqueue failures (queue busy, I/O) keep the staged verdict
 * recoverable; only unrecoverable identity/schema errors terminate it. */
function isUnrecoverableEnqueueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already queued with a different command|already received a different command|invalid bridge command|invalid bridge request id|unsupported version/i.test(message);
}

function parsePlanner(text: string): PlannerResult {
  const value = parseJsonObject(text);
  const status = value.status;
  if (status !== "ready" && status !== "needs_input" && status !== "failed") throw new Error("invalid planner status");
  return {
    status,
    ...(typeof value.planMarkdown === "string" ? { planMarkdown: value.planMarkdown } : {}),
    questions: Array.isArray(value.questions) ? value.questions.map(parsePlannerQuestion) : [],
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.filter((item): item is string => typeof item === "string") : [],
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function parseReview(text: string): ReviewResult {
  const value = parseJsonObject(text);
  if (value.verdict !== "pass" && value.verdict !== "changes_requested") throw new Error("invalid review verdict");
  return {
    verdict: value.verdict,
    findings: Array.isArray(value.findings) ? value.findings.map(parseReviewFinding) : [],
    testGaps: Array.isArray(value.testGaps) ? value.testGaps.filter((item): item is string => typeof item === "string") : [],
    summary: typeof value.summary === "string" ? value.summary : "",
  };
}

/**
 * Enforce the cross-field invariant between verdict and content so a
 * structurally valid but semantically contradictory JSON result never lets a
 * blocking problem ship: a "pass" carrying findings/testGaps is demoted to
 * changes_requested (the blocking/non-blocking gate then applies), while a
 * changes_requested with nothing actionable is rejected outright.
 */
function applyReviewConsistency(result: ReviewResult): ReviewResult {
  const hasContent = result.findings.length > 0 || result.testGaps.length > 0;
  if (result.verdict === "pass" && hasContent) {
    return { ...result, verdict: "changes_requested" };
  }
  if (result.verdict === "changes_requested" && !hasContent) {
    throw new Error("invalid review result: changes_requested without findings or test gaps");
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned non-object JSON");
  return value as Record<string, unknown>;
}

function parsePlannerQuestion(value: unknown): PlannerResult["questions"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid planner question");
  const question = value as Record<string, unknown>;
  if (typeof question.id !== "string" || typeof question.question !== "string") throw new Error("invalid planner question");
  return {
    id: question.id,
    header: typeof question.header === "string" ? question.header : "Codex question",
    question: question.question,
    ...(Array.isArray(question.options) ? {
      options: question.options.flatMap((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return [];
        const entry = option as Record<string, unknown>;
        return typeof entry.label === "string" ? [{
          label: entry.label,
          ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
        }] : [];
      }),
    } : {}),
    allowOther: question.allowOther === true,
    secret: question.secret === true,
  };
}

function parseReviewFinding(value: unknown): ReviewResult["findings"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid review finding");
  const finding = value as Record<string, unknown>;
  if (!isSeverity(finding.severity) || typeof finding.blocking !== "boolean"
    || typeof finding.title !== "string" || typeof finding.body !== "string") {
    throw new Error("invalid review finding");
  }
  return {
    severity: finding.severity,
    blocking: finding.blocking,
    title: finding.title,
    body: finding.body,
    ...(typeof finding.file === "string" && finding.file ? { file: finding.file } : {}),
    ...(Number.isInteger(finding.line) ? { line: finding.line as number } : {}),
  };
}

function isSeverity(value: unknown): value is ReviewResult["findings"][number]["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function ensurePlanBlock(plan: string): string {
  const trimmed = plan.trim();
  return trimmed.includes("<proposed_plan>") ? trimmed : `<proposed_plan>\n${trimmed}\n</proposed_plan>`;
}

export function formatFindings(review: ReviewResult): string {
  const findings = review.findings.map((finding, index) => {
    const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
    const blocking = finding.blocking ? ", blocking" : "";
    return `${index + 1}. [${finding.severity}${blocking}] ${finding.title}${location}: ${finding.body}`;
  });
  return [...findings, ...review.testGaps.map((gap) => `Test gap: ${gap}`)].join("\n") || review.summary;
}

function pluginMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "dsh-codex-workflow", form: "notice", summary: "Codex workflow continuation" },
  });
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error("Codex workflow tools require a live DSH agent session");
  return exec.agent;
}

function threadName(prefix: string, text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return `${prefix}: ${compact.slice(0, 72)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}
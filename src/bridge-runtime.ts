import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { MessageId, createUserMessage, freezeMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { cwdKey } from "./coordination.js";
import type { DispatchPlanCommand, SubmitVerdictCommand, BridgeCommand } from "./bridge-protocol.js";
import type { BridgeStore, ClaimedBridgeCommand } from "./bridge-store.js";
import { WorkflowStore } from "./store.js";
import type { WorkflowRecord } from "./types.js";
import { executionPrompt, formatFindings, type WorkflowManager } from "./workflow.js";

export interface AgentRegistryLike {
  get(id: string): Agent | undefined;
  list(): Agent[];
}

export interface BridgeRuntimeOptions {
  pollMs: number;
  /** Plugin storage directory; the session registry lives under `bridge/`. */
  storageDir: string;
  manager: WorkflowManager;
  workflowStore: WorkflowStore;
  /** Exponential backoff base for retryable delivery failures. */
  retryBaseMs?: number;
  /** Attempts (claims) before a retryable failure becomes a dead letter. */
  maxRetryAttempts?: number;
  /** Test-only fault injection: runs after `agent.followup` returns and before
   * the delivery state is persisted. Throwing {@link BridgeCrashSimulationError}
   * aborts the dispatch leaving the claim orphaned, exactly like a crash. */
  afterFollowupHook?: () => Promise<void> | void;
  /** Test-only fault injection: runs after a verdict is applied and before the
   * relay followup is sent. Throwing {@link BridgeCrashSimulationError} leaves
   * the claim orphaned so a restart must finish the delivery exactly once. */
  afterApplyHook?: () => Promise<void> | void;
  /** Test-only fault injection: runs BEFORE `applyExternalVerdict` — lets a
   * test take the claim over (see {@link renewClaimForTest}) and assert the
   * stale owner never applies. */
  beforeApplyHook?: () => Promise<void> | void;
  /** Test-only fault injection: replaces the claim renewal probe so lease loss
   * can be driven deterministically (return false to simulate takeover). */
  renewClaimForTest?: (claim: ClaimedBridgeCommand) => boolean | Promise<boolean>;
  /** Test-only fault injection: runs after the delivery pre-check but before
   * the relay is sent — lets a test move the world (cancel the workflow,
   * change the workspace) to verify the pre-relay re-check. */
  beforeRelayHook?: () => Promise<void> | void;
}

/** Thrown by the test-only `afterFollowupHook` to simulate a crash between
 * `agent.followup` and the durable delivery-state update. */
export class BridgeCrashSimulationError extends Error {
  constructor() {
    super("simulated crash after followup");
    this.name = "BridgeCrashSimulationError";
  }
}

interface SessionEntry {
  id: string;
  cwd: string;
  updatedAt: string;
}

type ResolvedTarget =
  | { kind: "agent"; agent: Agent }
  | { kind: "retryable"; reason: string }
  | { kind: "terminal"; reason: string };

function sameCwd(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable bridge pump owned by the plugin lifecycle: claims queue commands,
 * routes dispatch plans to the exact live DSH session via `agent.followup`,
 * and records receipts. Delivery is exactly-once under crash replay: the
 * `bridgeRequestId` idempotency key prevents duplicate workflows, and the
 * deterministic relay message id, persisted durably in the session's
 * `agent/inbox/spliced` events, prevents a duplicate followup after a crash
 * between send and receipt. Verdict handling is added on top of the same pump.
 */
export class BridgeRuntime {
  private timer?: NodeJS.Timeout;
  private sessionHeartbeat?: NodeJS.Timeout;
  private sessionsChain: Promise<void> = Promise.resolve();
  private polling = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private readonly store: BridgeStore;
  private readonly agents: AgentRegistryLike;
  private readonly options: BridgeRuntimeOptions & { retryBaseMs: number; maxRetryAttempts: number };
  /** Per-instance random claim owner: stable for this process's lifetime, so
   * queue claim generations never collide across two overlapping runtimes. */
  private readonly claimOwner: string;

  constructor(store: BridgeStore, agents: AgentRegistryLike, options: BridgeRuntimeOptions) {
    this.store = store;
    this.agents = agents;
    this.options = {
      ...options,
      retryBaseMs: options.retryBaseMs ?? 1_000,
      maxRetryAttempts: options.maxRetryAttempts ?? 5,
    };
    this.claimOwner = randomUUID();
  }

  start(): void {
    this.stopped = false;
    void this.store.recoverOrphans().catch(() => undefined);
    // Resume callbacks that were durably persisted but never finished.
    void this.options.manager.recoverCallbacks().catch(() => undefined);
    void this.refreshSessions();
    // Session heartbeat is INDEPENDENT of the pump: a long Codex callback must
    // never let this runtime's live sessions expire, and agent churn (created /
    // disposed) is reflected promptly. Period is a third of the lease TTL; the
    // refresh chain is serialized and gated on `stopped`.
    const sessionPeriod = Math.max(100, Math.floor(this.store.leaseMs / 3));
    this.sessionHeartbeat = setInterval(() => {
      void this.refreshSessions().catch(() => undefined);
    }, sessionPeriod);
    this.sessionHeartbeat.unref();
    this.timer = setInterval(() => void this.pump(), this.options.pollMs);
    this.timer.unref();
    void this.pump();
  }

  /** Stop the pump and wait for in-flight handling. Concurrent stop() calls
   * share ONE settle promise, so a second caller can never resolve before the
   * first has truly stopped. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const task = this.doStop();
    this.stopPromise = task;
    return task;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.sessionHeartbeat) clearInterval(this.sessionHeartbeat);
    this.sessionHeartbeat = undefined;
    while (this.polling) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    // Await the WHOLE serialized refresh chain: any refresh that started before
    // stop() may still write this owner's rows, so it must settle BEFORE we
    // release them. A refresh queued after stop() sees `this.stopped` and
    // writes nothing, so live_sessions can never be resurrected.
    await this.sessionsChain.then(() => undefined, () => undefined);
    await this.store.coordinationHandle.releaseOwnerSessions(this.claimOwner);
  }

  /**
   * Re-publish this runtime's live sessions into the shared SQLite registry
   * (replacing only its own rows; other runtimes' rows merge). Refreshes are
   * SERIALIZED on one chain so concurrent triggers (agent created/disposed,
   * start, pump) never interleave or reorder; once stopped, a refresh writes
   * nothing. Returns the chain's current tail.
   */
  refreshSessions(): Promise<void> {
    const task = this.sessionsChain
      .then(() => undefined, () => undefined)
      .then(() => this.doRefreshSessions());
    this.sessionsChain = task.then(() => undefined, () => undefined);
    return task;
  }

  private async doRefreshSessions(): Promise<void> {
    if (this.stopped) return; // teardown gate: never resurrect live_sessions
    const now = Date.now();
    const rows = this.agents.list().map((agent) => ({
      sessionId: agent.id,
      cwd: agent.session.header.cwd ?? process.cwd(),
    }));
    this.store.coordinationHandle.refreshOwnerSessions(this.claimOwner, rows, this.store.leaseMs, now);
  }

  /**
   * Ownership router for claim eligibility — the FIRST gate, applied inside
   * the atomic claim transaction before any attempts/claim_epoch mutation.
   * Routing never trusts the command's own target field blindly: the real
   * session is resolved from the shared registry / workflow record, and only
   * the runtime that OWNS it may claim.
   */
  private isClaimEligible(command: BridgeCommand): boolean {
    if (command.kind === "dispatch_plan") {
      if (command.target.dshSessionId) {
        return this.agents.get(command.target.dshSessionId) !== undefined;
      }
      // cwd-based dispatch: route by the shared live-session registry.
      const live = this.store.coordinationHandle.liveSessionsForCwd(cwdKey(command.target.cwd));
      if (live.length === 0) return false; // nobody owns it yet: WAIT, never steal
      if (live.length === 1) {
        return live[0]!.runtimeOwner === this.claimOwner; // only the unique owner
      }
      // Same-cwd multi-session ambiguity: only the DETERMINISTIC owner claims
      // (and produces the terminal ambiguity receipt); others must skip so no
      // runtime ever delivers to an arbitrary session.
      const owner = [...live].sort((a, b) => a.sessionId.localeCompare(b.sessionId))[0]!.runtimeOwner;
      return owner === this.claimOwner;
    }
    const verdict = command as SubmitVerdictCommand;
    // Resolve the REAL session from the shared workflow record; never trust
    // the command's own dshSessionId (a forged/stale target must not let a
    // wrong runtime apply first).
    const session = this.store.coordinationHandle.workflowSessionOf(verdict.workflowId);
    if (!session) {
      // Workflow genuinely does not exist: allow ONE runtime to claim it and
      // produce the terminal no_such_workflow receipt.
      return true;
    }
    if (verdict.dshSessionId !== undefined && verdict.dshSessionId !== session) {
      // The declared target contradicts the record: only the record's real
      // owner may claim (it will reject it as a terminal identity error).
      return this.agents.get(session) !== undefined;
    }
    return this.agents.get(session) !== undefined;
  }

  /** Exposed for tests and one-off pumps; the timer path calls it repeatedly. */
  async pump(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (;;) {
        const claim = await this.store.claimNext(this.claimOwner, (command) => this.isClaimEligible(command));
        if (!claim) break;
        try {
          await this.withClaimHeartbeat(claim, (isLost) => this.handle(claim, isLost));
        } catch (error) {
          // A stale owner's dead-letter changes 0 rows and is a no-op.
          await this.store.deadLetter(claim, errorMessage(error)).catch(() => undefined);
        }
      }
    } finally {
      this.polling = false;
      // Keep the live-session registry aligned with the current agent list
      // promptly (agent created/disposed are reflected on the next pump); the
      // independent heartbeat covers long pump stretches. A refresh after
      // stop() writes nothing (doRefreshSessions is gated on stopped).
      await this.refreshSessions().catch(() => undefined);
    }
  }

  /**
   * Heartbeat the claim lease while it is handled: renewal period is a third
   * of the lease TTL, so an active handler is never taken over, and a crashed
   * one is reclaimed after the lease expires. Once a renewal returns false (or
   * throws) the owner has LOST the lease: `isLost()` starts returning true and
   * the handler must stop producing ANY external side effect — no apply, no
   * relay, no ack/retry/dead-letter — so a stale owner can never repeat a
   * relay over the new owner. The claim's own epoch/owner fence is the final
   * backstop. A `renewClaimForTest` mapper lets tests drive loss
   * deterministically.
   */
  private async withClaimHeartbeat<T>(
    claim: ClaimedBridgeCommand,
    fn: (isLost: () => boolean) => Promise<T>,
  ): Promise<T> {
    const period = Math.max(100, Math.floor(this.store.leaseMs / 3));
    let lost = false;
    const renewForTest = this.options.renewClaimForTest;
    const renew = renewForTest
      ? (c: ClaimedBridgeCommand) => Promise.resolve(renewForTest(c))
      : (c: ClaimedBridgeCommand) => this.store.renewClaim(c);
    const timer = setInterval(() => {
      void renew(claim).then((ok) => {
        if (!ok) {
          lost = true;
          clearInterval(timer);
        }
      }).catch(() => {
        lost = true;
        clearInterval(timer);
      });
    }, period);
    timer.unref();
    try {
      return await fn(() => lost);
    } finally {
      clearInterval(timer);
    }
  }

  private async handle(claim: ClaimedBridgeCommand, isLost: () => boolean = () => false): Promise<void> {
    if (claim.command.kind === "dispatch_plan") {
      await this.handleDispatch(claim, claim.command, isLost);
      return;
    }
    await this.handleVerdict(claim, isLost);
  }

  private async handleDispatch(
    claim: ClaimedBridgeCommand,
    command: DispatchPlanCommand,
    isLost: () => boolean,
  ): Promise<void> {
    const target = await this.resolveTarget(command);
    if (target.kind === "retryable") {
      await this.retryOrDeadLetter(claim, target.reason, isLost);
      return;
    }
    if (target.kind === "terminal") {
      if (isLost()) return; // a stale owner must not ack the new owner's claim
      await this.store.ack(claim, {
        requestId: claim.requestId,
        status: "failed",
        error: target.reason,
        deliveredAt: new Date().toISOString(),
      });
      return;
    }
    // Idempotent replay: the same request must always land on the same
    // workflow and never create a duplicate.
    const existing = await this.options.workflowStore.byBridgeRequest(command.requestId);
    let record: WorkflowRecord;
    if (existing) {
      if (existing.bridgeDeliveryState === "delivered") {
        // Delivered before the crash, but the receipt never landed: just ack.
        if (isLost()) return;
        await this.store.ack(claim, {
          requestId: claim.requestId,
          status: "delivered",
          workflowId: existing.id,
          deliveredAt: new Date().toISOString(),
        });
        return;
      }
      record = existing; // prepared: re-deliver without creating a second workflow
    } else {
      try {
        if (isLost()) return;
        record = await this.options.manager.startExternalPlan(command, target.agent);
      } catch (error) {
        // Busy session or transient store failure: retry with backoff.
        await this.retryOrDeadLetter(claim, errorMessage(error), isLost);
        return;
      }
    }
    if (isLost()) return; // the claim was taken over: never relay for the new owner
    // Deterministic message identity: the durable agent/inbox/spliced events
    // on the target session record the id, so a replay after a crash between
    // followup and delivery-state update can detect the already-sent message
    // and must not deliver a second copy.
    const messageId = MessageId(`dsh-codex-workflow:${command.requestId}`);
    if (this.hasDeliveredMessage(target.agent, messageId)) {
      if (isLost()) return;
      await this.options.workflowStore.update(record.id, (r) => {
        r.bridgeDeliveryState = "delivered";
      }, { ignoreCancelled: false });
      await this.store.ack(claim, {
        requestId: claim.requestId,
        status: "delivered",
        workflowId: record.id,
        deliveredAt: new Date().toISOString(),
      });
      return;
    }
    try {
      if (isLost()) return;
      target.agent.followup(this.relayMessage(record, messageId));
      if (this.options.afterFollowupHook) await this.options.afterFollowupHook();
    } catch (error) {
      if (error instanceof BridgeCrashSimulationError) {
        // Simulated crash: leave the claim orphaned for recovery, deliver
        // nothing further, and let the next runtime finish the delivery.
        return;
      }
      await this.retryOrDeadLetter(claim, `followup failed: ${errorMessage(error)}`, isLost);
      return;
    }
    if (isLost()) return;
    await this.options.workflowStore.update(record.id, (r) => {
      r.bridgeDeliveryState = "delivered";
    }, { ignoreCancelled: false });
    if (isLost()) return;
    await this.store.ack(claim, {
      requestId: claim.requestId,
      status: "delivered",
      workflowId: record.id,
      deliveredAt: new Date().toISOString(),
    });
  }

  private relayMessage(record: WorkflowRecord, messageId: MessageId): UserMessage {
    return freezeMessage({
      ...createUserMessage({
        content: [{ type: "text", text: executionPrompt(record) }],
        source: { kind: "plugin", plugin: "dsh-codex-workflow", form: "relay" },
      }),
      id: messageId,
    });
  }

  /** Whether the target session's durable event log already contains the
   * relay message with this exact identity (inbox insertions persist as
   * `agent/inbox/spliced` events carrying the full message). */
  private hasDeliveredMessage(agent: Agent, messageId: MessageId): boolean {
    for (const event of agent.session.events) {
      const type = (event as { type?: string }).type;
      if (type !== "agent/inbox/spliced") continue;
      const data = (event as { data?: { inserted?: Array<{ id?: string }> } }).data;
      if (data?.inserted?.some((message) => message.id === messageId)) return true;
    }
    return false;
  }

  private async resolveTarget(command: DispatchPlanCommand): Promise<ResolvedTarget> {
    const sessionId = command.target.dshSessionId;
    if (sessionId) {
      const agent = this.agents.get(sessionId);
      if (!agent) {
        // Not this runtime's session: eligibility should have prevented the
        // claim; never terminal, just not ours.
        return { kind: "retryable", reason: `no live DSH session ${sessionId}` };
      }
      const cwd = agent.session.header.cwd;
      if (cwd && !sameCwd(cwd, command.target.cwd)) {
        return { kind: "terminal", reason: `cwd mismatch: session ${agent.id} runs in ${cwd}, dispatch targets ${command.target.cwd}` };
      }
      return { kind: "agent", agent };
    }
    // cwd-based dispatch: decide against the GLOBAL live-session registry, not
    // just this runtime's view, so same-cwd multi-session ambiguity is a
    // deterministic terminal error and a single session routes to its owner.
    const live = this.store.coordinationHandle.liveSessionsForCwd(cwdKey(command.target.cwd));
    if (live.length === 0) {
      return { kind: "retryable", reason: `no live DSH session matches cwd ${command.target.cwd}` };
    }
    if (live.length > 1) {
      return { kind: "terminal", reason: `multiple live DSH sessions match cwd ${command.target.cwd}: ${live.map((row) => row.sessionId).join(", ")}` };
    }
    const agent = this.agents.get(live[0]!.sessionId);
    if (!agent) {
      return { kind: "retryable", reason: `live session ${live[0]!.sessionId} is not hosted by this runtime yet` };
    }
    return { kind: "agent", agent };
  }

  private async retryOrDeadLetter(claim: ClaimedBridgeCommand, error: string, isLost: () => boolean = () => false): Promise<void> {
    if (isLost()) return; // a stale owner must not move the new owner's claim
    const attempts = claim.attempts + 1;
    if (attempts > this.options.maxRetryAttempts) {
      await this.store.deadLetter(claim, error);
      return;
    }
    const delayMs = this.options.retryBaseMs * 2 ** (attempts - 1);
    await this.store.retry(claim, error, new Date(Date.now() + delayMs).toISOString());
  }

  /**
   * Apply a verdict from the exact originating Codex thread and deliver the
   * outcome to the original DSH session. Delivery is deduplicated through the
   * deterministic verdict message id; cancelled workflows never wake DSH.
   * Delivery failures are recoverable: the verdict is already applied when the
   * relay starts, so a transient followup failure or an offline session must
   * keep the claim retrying with backoff forever — never a dead letter — and
   * the deterministic message id makes every crash window deliver exactly
   * once. Once `isLost()` reports lease loss the handler stops immediately
   * (no apply, no relay, no ack), so a stale owner can never duplicate a
   * relay over the new owner.
   */
  private async handleVerdict(claim: ClaimedBridgeCommand, isLost: () => boolean): Promise<void> {
    const command = claim.command as SubmitVerdictCommand;
    let record: WorkflowRecord;
    try {
      if (this.options.beforeApplyHook) await this.options.beforeApplyHook();
      if (isLost()) return; // never apply a verdict with a lost claim
      record = await this.options.manager.applyExternalVerdict(command);
    } catch (error) {
      const message = errorMessage(error);
      if (/unknown workflow|not a Codex-bridge workflow|thread mismatch|session mismatch|stale submission|missing its submission id|before any submission|already staged|cannot be applied|already applied as request/i.test(message)) {
        // Terminal: stale/unknown identities and conflicting request ids are
        // rejected for good; the expected verdict is the only valid one.
        if (!isLost()) {
          await this.store.ack(claim, {
            requestId: claim.requestId,
            status: /already applied as request/i.test(message) ? "duplicate" : "no_such_workflow",
            error: message,
            deliveredAt: new Date().toISOString(),
          });
        }
      } else {
        // Not yet applicable (still staging) or transient: retry with backoff.
        if (!isLost()) {
          await this.store.retry(claim, message, new Date(Date.now() + 1_000).toISOString());
        }
      }
      return;
    }
    if (record.phase === "cancelled") {
      // Late verdict on a cancelled workflow: idempotent receipt, never wake DSH.
      if (!isLost()) {
        await this.store.ack(claim, {
          requestId: claim.requestId,
          status: "cancelled",
          workflowId: record.id,
          error: "workflow is cancelled",
          deliveredAt: new Date().toISOString(),
        });
      }
      return;
    }
    if (record.submissionState === "delivered"
      && (record.appliedVerdictSubmissionId === command.submissionId
        || record.appliedVerdictRequestId === command.requestId)) {
      // This verdict was already applied AND delivered (e.g. a manual respond
      // duplicating the automatic path): idempotent ack, no second relay.
      if (!isLost()) {
        await this.store.ack(claim, {
          requestId: claim.requestId,
          status: "delivered",
          workflowId: record.id,
          deliveredAt: new Date().toISOString(),
        });
      }
      return;
    }
    // Crash window: apply committed, relay not yet sent. Leave the claim
    // orphaned for restart recovery; the next claim replays the verdict
    // idempotently and finishes the delivery.
    if (this.options.afterApplyHook) {
      try {
        await this.options.afterApplyHook();
      } catch (error) {
        if (error instanceof BridgeCrashSimulationError) return;
        throw error;
      }
    }
    if (isLost()) return; // relay belongs to the new owner now
    // Delivery-time re-verification (prepare): recompute the workspace
    // fingerprint and void an applied verdict (even a pass) if the workspace
    // changed while the outcome was pending delivery. This verifies but does
    // NOT yet write delivered (invalidation stays pending-applied).
    const validity = await this.options.manager.assertVerdictStillValid(command);
    record = validity.record;

    let messageId: MessageId;
    try {
      if (this.options.beforeRelayHook) await this.options.beforeRelayHook();
      // Final fingerprint verification AFTER the hook: if the hook changed the
      // workspace, the old verdict (a pass) must be invalidated here, before
      // any relay; if the hook cancelled the workflow, this returns without
      // touching state and the pre-relay check below acks cancelled.
      const final = await this.options.manager.assertVerdictStillValid(command);
      record = final.record;
      // Pre-relay re-check: a cancel or a new submission that won between
      // prepare and relay must NOT wake the session or write delivered.
      const fresh = await this.options.workflowStore.load(record.id);
      if (!fresh || fresh.phase === "cancelled") {
        if (!isLost()) {
          await this.store.ack(claim, {
            requestId: claim.requestId,
            status: "cancelled",
            workflowId: record.id,
            error: "workflow is cancelled before delivery",
            deliveredAt: new Date().toISOString(),
          });
        }
        return;
      }
      if (fresh.submissionState !== "applied"
        || fresh.appliedVerdictRequestId !== command.requestId
        || (command.submissionId !== undefined && fresh.submissionId !== command.submissionId)) {
        if (!isLost()) {
          await this.store.ack(claim, {
            requestId: claim.requestId,
            status: "no_such_workflow",
            workflowId: record.id,
            error: "verdict no longer applicable before delivery",
            deliveredAt: new Date().toISOString(),
          });
        }
        return;
      }
      record = fresh;
      messageId = MessageId(`dsh-codex-workflow:verdict:${command.requestId}`);
    } catch (error) {
      if (error instanceof BridgeCrashSimulationError) return; // leave orphaned
      throw error;
    }

    if (isLost()) return; // the claim was taken over: never relay for the new owner
    const agent = this.agents.get(record.dshSessionId);
    if (!agent) {
      // The original DSH session is temporarily unavailable: the verdict stays
      // applied and the claim keeps retrying with backoff — for as long as it
      // takes — never a permanent dead letter, and never a hot loop. Each
      // retry re-runs the fingerprint check above, so a pass that went stale
      // while offline is invalidated before it is ever reported.
      if (isLost()) return;
      await this.retryPersistent(claim, `no live DSH session ${record.dshSessionId}`);
      return;
    }
    try {
      if (isLost()) return;
      if (!this.hasDeliveredMessage(agent, messageId)) {
        agent.followup(this.verdictRelayMessage(record, messageId));
      }
      if (this.options.afterFollowupHook) await this.options.afterFollowupHook();
    } catch (error) {
      if (error instanceof BridgeCrashSimulationError) return; // leave orphaned
      // Transient followup failure: keep retrying, never dead-letter.
      if (isLost()) return;
      await this.retryPersistent(claim, `followup failed: ${errorMessage(error)}`);
      return;
    }
    if (isLost()) return; // a stale owner must not mark delivered
    // Commit delivered only AFTER the relay landed; fenced on identity/state.
    const commit = await this.options.manager.commitVerdictDelivery(command);
    if (commit.committed) {
      if (isLost()) return;
      await this.store.ack(claim, {
        requestId: claim.requestId,
        status: "delivered",
        workflowId: record.id,
        deliveredAt: new Date().toISOString(),
      });
      return;
    }
    // The relay landed but the exact commit lost to a cancel/new submission:
    // never overwrite the new state with delivered.
    if (isLost()) return;
    await this.store.ack(claim, {
      requestId: claim.requestId,
      status: commit.record.phase === "cancelled" ? "cancelled" : "no_such_workflow",
      workflowId: record.id,
      error: "delivery superseded before commit; not marked delivered",
      deliveredAt: new Date().toISOString(),
    });
  }

  /** Retry a claim with exponential backoff that NEVER dead-letters: used for
   * verdict relay when the verdict is already applied and only delivery is
   * pending. The backoff caps at a minute so a long-offline session still
   * gets its verdict automatically on recovery without any hot polling. */
  private async retryPersistent(claim: ClaimedBridgeCommand, error: string): Promise<void> {
    const attempts = claim.attempts + 1;
    const delayMs = Math.min(60_000, this.options.retryBaseMs * 2 ** Math.min(attempts - 1, 6));
    await this.store.retry(claim, error, new Date(Date.now() + delayMs).toISOString());
  }

  private verdictRelayMessage(record: WorkflowRecord, messageId: MessageId): UserMessage {
    const review = record.latestReview;
    let text: string;
    if (record.error && /workspace changed after the review/.test(record.error)) {
      text = `Codex review for workflow ${record.id} was applied but is now VOID: the workspace changed after the review while the verdict was pending delivery (evidence fingerprint mismatch). Do not treat the old outcome as valid. Make the intended changes and call codex_workflow_submit again for a fresh review before answering the user.`;
    } else if (record.error && /was not applied/.test(record.error)) {
      text = `Codex review for workflow ${record.id} was NOT applied: ${record.error}`;
    } else if (record.phase === "passed") {
      text = `Codex review passed workflow ${record.id}. Report the verified implementation and tests to the user.`;
    } else if (record.phase === "waiting_review_decision" && review) {
      text = `Codex Reviewer found only non-blocking improvements for workflow ${record.id}. Present each item below to the user and wait for their choice, then call codex_workflow_decide with workflowId ${record.id} and decision "accept" (ship as-is) or "fix" (repair first).\n${formatFindings(review)}`;
    } else if (record.phase === "blocked") {
      text = `Codex review for workflow ${record.id} is blocked. Stop automatic repair and report the remaining findings:\n${review ? formatFindings(review) : record.error ?? "no findings"}`;
    } else {
      text = `Codex review for workflow ${record.id} requested changes. Fix every finding below in this same DSH session, rerun relevant tests, then call codex_workflow_submit again before answering the user.\n${review ? formatFindings(review) : "no findings"}`;
    }
    return freezeMessage({
      ...createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-codex-workflow", form: "relay" },
      }),
      id: messageId,
    });
  }
}

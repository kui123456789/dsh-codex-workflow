import type { CodexAppServerClient } from "./app-server.js";
import type { BridgeRuntime } from "./bridge-runtime.js";
import type { CoordinationStore } from "./coordination.js";
import type { WorkflowStore } from "./store.js";
import type { WorkflowManager } from "./workflow.js";

/**
 * Ports — the narrow contracts the application flows depend on.
 *
 * Phase 1 of the approved modularization (see
 * `docs/modularization-phases-2026-09-25.md`): DECLARATION ONLY. Nothing in the
 * runtime path changed; the concrete facades (`CodexAppServerClient`,
 * `WorkflowStore`, `CoordinationStore`, `BridgeRuntime`, `WorkflowManager`) keep
 * their public surface, their CLI/npm exports, the bridge wire format and every
 * existing behavior, and `src/index.ts` remains the only composition root.
 *
 * Each port is DERIVED from its adapter with `Pick`, so it can never drift from
 * the implementation: if a facade renames or reshapes a member, the ports and
 * every future consumer fail to compile instead of silently disagreeing. Later
 * phases split the flows apart and let them take these ports (instead of a whole
 * facade) as constructor arguments.
 *
 * The dependency direction this establishes:
 *
 *     contracts/ports  ->  application flows  ->  adapters  ->  infrastructure
 */

// ---------------------------------------------------------------- Codex (App Server)

/** Thread lifecycle on the App Server: create/resume/release, naming, metadata. */
export type CodexThreadPort = Pick<
  CodexAppServerClient,
  | "startThread"
  | "resumeThread"
  | "unsubscribeThread"
  | "releaseThreadForExternal"
  | "nameThread"
  | "startReviewerThreadShell"
  | "configureReviewerThread"
  | "listThreadIds"
  | "readThread"
  | "validateSourceThread"
>;

/** Turn lifecycle on the App Server: start/continue/interrupt and read-back. */
export type CodexTurnPort = Pick<
  CodexAppServerClient,
  | "startTurn"
  | "continueTurn"
  | "startReview"
  | "interrupt"
  | "captureTurnBaseline"
  | "readAppendedTurnText"
  | "forkThread"
  | "normalizeInFork"
  | "normalizeInThread"
  | "resolveDefaultModel"
  | "health"
  | "start"
  | "stop"
>;

// ---------------------------------------------------------------- Workflow flows

/** Planning flow: the entry points that turn a request into a plan. */
export type PlannerPort = Pick<
  WorkflowManager,
  "start" | "continue" | "startExternalPlan" | "onTurnStopping" | "decide"
>;

/** Review flow: the entry points that obtain and apply a review verdict. */
export type ReviewPort = Pick<
  WorkflowManager,
  "review" | "reviewOnly" | "applyExternalVerdict" | "assertVerdictStillValid"
>;

/** Submission flow: bridge submissions, verdict/notice delivery and recovery. */
export type SubmissionPort = Pick<
  WorkflowManager,
  "submit" | "recoverCallbacks" | "commitVerdictDelivery" | "commitSubmissionNoticeDelivery"
>;

/** Lifecycle flow: observation, cancellation and teardown of one workflow. */
export type LifecyclePort = Pick<WorkflowManager, "status" | "cancel" | "stop">;

/** Bridge runtime: the queue pump and the session registry it routes against. */
export type BridgeWorkflowPort = Pick<BridgeRuntime, "start" | "stop" | "pump" | "refreshSessions">;

// ---------------------------------------------------------------- Persistence

/** Durable workflow records (one row per workflow, CAS-updated). */
export type WorkflowRepository = Pick<
  WorkflowStore,
  "init" | "load" | "list" | "save" | "activeForSession" | "byBridgeRequest" | "abandonOrphaned" | "close" | "isClosed"
>;

/** The bridge command queue: enqueue, claim, ack, retry, quarantine. */
export type QueueRepository = Pick<
  CoordinationStore,
  | "enqueueCommand"
  | "claimNext"
  | "ackClaim"
  | "renewClaim"
  | "retryClaim"
  | "deadLetterClaim"
  | "quarantineRow"
  | "requeueRequest"
  | "recoverQueueOrphans"
  | "queueRow"
  | "queueRowsByStatus"
>;

/** Submission-callback leases (single-writer ownership with fencing). */
export type LeaseRepository = Pick<
  CoordinationStore,
  "acquireLease" | "renewLease" | "releaseLease" | "isLeaseOwner" | "leaseInfo"
>;

/** Live DSH sessions the bridge may route to. */
export type LiveSessionRepository = Pick<
  CoordinationStore,
  | "listLiveSessions"
  | "liveSessionsForCwd"
  | "refreshOwnerSessions"
  | "renewOwnerSessions"
  | "releaseOwnerSessions"
  | "sessionsForOwner"
  | "workflowSessionOf"
>;

/** The one SQLite database every repository above shares. */
export type CoordinationDatabasePort = Pick<
  CoordinationStore,
  "close" | "isClosed" | "journalMode" | "integrityCheck" | "sqliteVersion"
>;

// ---------------------------------------------------------------- Narrowness proof

/** `true` only when `A` is assignable to `B`. */
type Extends<A, B> = [A] extends [B] ? true : false;
/** Compile-time assertion: only `true` is accepted. */
type Expect<T extends true> = T;

/**
 * The ports are DERIVED from their facades (so they can never drift), and these
 * assertions prove they are also genuinely NARROWER than them: a port must NOT be
 * assignable to a type that requires a member outside it, which is exactly what
 * stops a consumer from reaching the rest of the facade through the port.
 *
 * A hand-written interface expresses the same intent without naming the facade;
 * that rewrite belongs to the phases that actually INJECT these ports (2-5),
 * where the real consumer surface is known. Until then the narrowness property
 * stays ENFORCED by the compiler rather than merely intended.
 */
type _ThreadPortIsNarrow = Expect<Extends<CodexThreadPort, { startTurn: unknown }> extends false ? true : false>;
type _TurnPortIsNarrow = Expect<Extends<CodexTurnPort, { resumeThread: unknown }> extends false ? true : false>;
type _PlannerPortIsNarrow = Expect<Extends<PlannerPort, { review: unknown }> extends false ? true : false>;
type _ReviewPortIsNarrow = Expect<Extends<ReviewPort, { submit: unknown }> extends false ? true : false>;
type _SubmissionPortIsNarrow = Expect<Extends<SubmissionPort, { status: unknown }> extends false ? true : false>;
type _LifecyclePortIsNarrow = Expect<Extends<LifecyclePort, { submit: unknown }> extends false ? true : false>;
type _QueuePortIsNarrow = Expect<Extends<QueueRepository, { acquireLease: unknown }> extends false ? true : false>;
type _LeasePortIsNarrow = Expect<Extends<LeaseRepository, { claimNext: unknown }> extends false ? true : false>;
type _WorkflowRepoIsNarrow = Expect<Extends<WorkflowRepository, { enqueueCommand: unknown }> extends false ? true : false>;

// ---------------------------------------------------------------- Conformance

/**
 * Compile-time proof that each concrete facade still satisfies its port(s).
 *
 * Never executed at runtime — it exists so a facade that stops matching a port
 * becomes a type error in CI instead of a surprise in a later phase. The
 * `void` uses keep the assignments from being elided as dead code by the
 * compiler's unused-local analysis.
 */
export function assertPortsSatisfied(
  client: CodexAppServerClient,
  store: WorkflowStore,
  coordination: CoordinationStore,
  runtime: BridgeRuntime,
  manager: WorkflowManager,
): void {
  const thread: CodexThreadPort = client;
  const turn: CodexTurnPort = client;
  const planner: PlannerPort = manager;
  const review: ReviewPort = manager;
  const submission: SubmissionPort = manager;
  const lifecycle: LifecyclePort = manager;
  const bridge: BridgeWorkflowPort = runtime;
  const workflows: WorkflowRepository = store;
  const queue: QueueRepository = coordination;
  const leases: LeaseRepository = coordination;
  const sessions: LiveSessionRepository = coordination;
  const database: CoordinationDatabasePort = coordination;
  void [thread, turn, planner, review, submission, lifecycle, bridge, workflows, queue, leases, sessions, database];
}

import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CodexInvalidThreadError } from "./codex-callback.js";
import type {
  PersistedTurnBaseline,
  PlannerQuestion,
  ReasoningEffort,
  TurnNeedsInputResult,
  TurnWaitResult,
} from "./types.js";
import { PLUGIN_VERSION } from "./version.js";
import { captureProcessTreeEvidence, originalProcessTreeExited, refreshOriginalProcessTreeEvidence, spawnProcess, stopProcess, type ProcessTreeEvidence, type ProcessTreeCaptureObservation, type ProcessTreeObservation } from "./infrastructure/process-transport.js";
import { ModelSelectionGateway } from "./application/app-server/model-selection-gateway.js";
import { ThreadTokenUsageLedger, type TokenUsageSnapshot } from "./usage-accounting.js";
import { CodexTurnInterruptionError } from "./turn-interruption.js";
import { CodexTurnReceiptPendingError, type PendingTurnReceiptOperation } from "./pending-turn-receipt.js";
import { stopCapturedProcessTree } from "./infrastructure/process-tree-cleanup.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
}

interface InitializationFlight {
  controller: AbortController;
  consumers: Set<object>;
  promise: Promise<void>;
  /** Readiness or terminal rejection belongs to the physical initializer. */
  settled: boolean;
  abandoned: boolean;
  rejected?: boolean;
}

interface PendingInput {
  requestId: string | number;
  itemId: string;
  questions: PlannerQuestion[];
}

interface TurnRegistration {
  readonly process: ChildProcess;
  readonly threadOwner?: object;
  readonly threadId: string;
  readonly turnId: string;
}

interface PendingTurnReceipt {
  readonly requestId: number;
  readonly method: "turn/start" | "review/start";
  readonly process: ChildProcess;
  readonly threadOwner?: object;
  readonly threadId: string;
  readonly detached: boolean;
  readonly failures: Map<string, { threadId?: string; turnId?: string; error: Error }>;
  readonly lifecycle: {
    submitted: boolean;
    replyReceived: boolean;
    detachedObserver: boolean;
    released: boolean;
    confirmed: boolean;
    adopted: boolean;
    state?: TurnState;
    error?: Error;
    invalidReply?: boolean;
    serverRejected?: boolean;
    operation?: PendingTurnReceiptOperation;
    evidence?: Promise<ProcessTreeEvidence>;
    terminalInputError?: string;
    cleanupFlight?: Promise<boolean>;
    result?: { threadId: string; result: TurnWaitResult };
  };
}

interface PendingForkCreation {
  readonly requestId: number;
  readonly process: ChildProcess;
  readonly sourceThreadId: string;
  readonly sourceOwner?: object;
  readonly signature?: string;
  observing: boolean;
  abandoned: boolean;
  claimed: boolean;
  fork?: { threadId: string; owner: object };
  error?: Error;
  cleanupFlight?: Promise<void>;
  evidence?: Promise<ProcessTreeEvidence>;
}

interface PendingForkRelease {
  readonly creation: PendingForkCreation;
  readonly fork: { threadId: string; owner: object };
  result?: TurnWaitResult;
  error?: unknown;
  interruption?: CodexTurnInterruptionError;
  subscriptionStatus?: "unsubscribed" | "notSubscribed" | "notLoaded";
  cleanupPending: boolean;
  released: boolean;
  cleanupFlight?: Promise<void>;
  recoveryFlight?: Promise<TurnWaitResult>;
}

interface IdleProcessRetirement {
  readonly process: ChildProcess;
  readonly evidence: Promise<ProcessTreeEvidence>;
  closing: boolean;
}

interface LostAppServerProcess {
  readonly original: Promise<ProcessTreeEvidence>;
  /** Read only after the original capture settles; bound to its native child. */
  readonly startupObservations: () => readonly ProcessTreeCaptureObservation[];
  /** Original failure must settle before any successor can be admitted. */
  readonly diagnostic?: Promise<void>;
  evidence?: ProcessTreeEvidence;
}

class CodexProtocolError extends Error {
  constructor(original: Error) {
    super(`Codex app-server protocol schema invalid: ${original.message}`, { cause: original });
    this.name = "CodexProtocolError";
  }
}

interface TurnState {
  threadId: string;
  turnId: string;
  items: JsonObject[];
  completed?: JsonObject;
  completedProcess?: ChildProcess;
  completedThreadOwner?: object;
  completedRegistration?: TurnRegistration;
  input?: PendingInput;
  liveTexts?: Map<string, string>;
  pendingLive?: AppServerLiveEvent[];
  onProgress?: (entry: AppServerLiveEvent) => void;
  registration?: TurnRegistration;
  protocolFailure?: Error;
}

/** Displayable App Server activity. Raw reasoning and tool output are never forwarded. */
export interface AppServerLiveEvent {
  kind: "message" | "plan" | "reasoning" | "tool";
  itemId: string;
  text: string;
  replace?: boolean;
  /** Structured tool metadata retained for the native sidebar projection. */
  command?: string;
  cwd?: string;
  exitCode?: number;
  status?: string;
  files?: string[];
}

export interface CodexAppServerOptions {
  command: string;
  args?: string[];
  requestTimeoutMs: number;
  /** Per-control-RPC timeout (thread/start, turn/start, thread/fork,
   * collaborationMode/list, unsubscribe, ...). Defaults to
   * min(requestTimeoutMs, 60s). The long turn WAIT is still bounded by
   * `requestTimeoutMs`; only the JSON-RPC round trips use this tighter bound.
   * Tool timeout budgets count every serial control RPC against this value,
   * so the host can never pre-empt a legitimate operation. */
  rpcTimeoutMs?: number;
  idleProcessMs: number;
  env?: NodeJS.ProcessEnv;
  /** How long graceful shutdown waits for the app-server to flush and exit
   * after stdin EOF before escalating; default 5000ms. */
  quitGraceMs?: number;
  /** How long to wait after SIGTERM/kill before SIGKILL; default 2000ms. */
  killGraceMs?: number;
}

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  /** Durable threads may be named; ephemeral threads never enter Desktop history. */
  name?: string;
  ephemeral?: boolean;
}

export interface StartTurnOptions {
  /** Exact original registration and process; never serialized on the wire. */
  expectedOwner?: object;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort;
  outputSchema?: JsonObject;
  planMode?: boolean;
  /** Reports the EFFECTIVE model this turn actually runs with — the explicit
   * `model` override, or the model resolved from the collaboration mode
   * (e.g. the Plan mode's model, the server's default when the mode selects
   * none). Callers persist it so continuation/restart and the ephemeral
   * conversion fork reuse the SAME model instead of falling back to a
   * different default. Fired once, before the turn starts. */
  onModel?: (model: string) => void;
  /** Pin the turn to the non-collaborative "default" mode and inject the
   * silent single-message review developer instructions at the protocol level.
   * Used for VISIBLE Reviewer turns so they emit no commentary/progress and
   * can never start sub-tasks; the structured verdict is produced separately
   * by an ephemeral conversion fork. Takes precedence over `planMode`. */
  silentReview?: boolean;
  /** Structured-conversion turn (run inside an ephemeral fork): pinned to the
   * non-collaborative "default" mode with JSON-only conversion developer
   * instructions, so the fork emits exactly one schema-conforming JSON object
   * and nothing else. Takes precedence over `planMode`. */
  conversion?: boolean;
  /** Called as soon as turn/start has returned the turn id, before waiting
   * for the turn to finish, so callers can persist the active turn for
   * cancellation while it is still running. */
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  onProgress?: (entry: AppServerLiveEvent) => void;
}

export interface ReviewerStartOptions {
  expectedOwner?: object;
  cwd: string;
  name?: string;
  model?: string;
  ephemeral?: boolean;
  /** Readable review contract + full per-round context (original task, plan,
   * implementation summary, changed files, test results, workspace evidence)
   * injected as the Reviewer thread's developer instructions BEFORE the first
   * review runs. AUXILIARY channel only: a native review turn may not
   * reliably see hidden thread-settings instructions, so verdict correctness
   * must never depend on them — every DSH-led review turn carries the full
   * context AND the coverage gate in the `review/start` custom target's
   * instructions. */
  developerInstructions?: string;
}

/** Options for an ephemeral-fork structured conversion turn. */
export interface ForkConversionOptions {
  expectedOwner?: object;
  /** Source thread for the conversion. Ephemeral sources convert in-place;
   * durable sources use an ephemeral fork. */
  threadId: string;
  cwd: string;
  prompt: string;
  model?: string;
  outputSchema: JsonObject;
  sourceEphemeral?: boolean;
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
}

export interface ReviewStartOptions {
  expectedOwner?: object;
  threadId: string;
  cwd: string;
  target: JsonObject;
  detached: boolean;
  model?: string;
  effort?: ReasoningEffort;
  /** Called as soon as the reviewer thread and turn are known (and the thread
   * settings are applied), before waiting for the turn to finish. Lets the
   * caller persist the reviewer ids so cancellation can interrupt the run. */
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  onProgress?: (entry: AppServerLiveEvent) => void;
}

/** Bounded wall-clock window each persisted read-back polls before declaring
 * the appended text "missing" (roll-out lag) — well under the production turn
 * budget, and folded into the provable tool budgets (reviewToolTimeout adds
 * one bound per read-back). */
export const APPENDED_READBACK_TIMEOUT_MS = 60_000;

/** Snapshot view of the text-carrying appended turns since the baseline. */
function sampleAppendedText(
  thread: JsonObject,
  baseline: PersistedTurnBaseline,
): { kind: "ok"; result: { text: string; itemType?: string } } | { kind: "missing" } | { kind: "ambiguous" } {
  const turns: JsonObject[] = Array.isArray(thread.turns) ? thread.turns.map(object) : [];
  const baselineIds = new Set(baseline.ids);
  const added = turns.filter((turn) => typeof turn.id === "string" && !baselineIds.has(turn.id));
  // The appended turns that genuinely carry a final visible text; the
  // review-mode marker turn and any text-less scaffolding are ignored.
  const textTurns: Array<{ text: string; itemType: string }> = [];
  for (const turn of added) {
    const items: JsonObject[] = Array.isArray(turn.items) ? turn.items.map(object) : [];
    const candidates = items.filter(
      (item) => item.type === "agentMessage" || item.type === "plan" || item.type === "exitedReviewMode",
    );
    const finalItem = candidates.at(-1);
    if (!finalItem) continue;
    const text = typeof finalItem.text === "string" ? finalItem.text : typeof finalItem.review === "string" ? finalItem.review : "";
    if (text.length === 0) continue;
    textTurns.push({
      text,
      itemType: typeof finalItem.type === "string" ? finalItem.type : "agentMessage",
    });
  }
  // Several text-carrying turns: unambiguous ONLY when they carry the SAME
  // text (real review/start rolls the review out TWICE — once on the
  // review-mode marker turn's `exitedReviewMode.review` and once on the
  // streamed agentMessage turn). DIFFERENT texts mean a concurrent writer or
  // a stale baseline — fail closed with `ambiguous`. Zero = not rolled out
  // yet (lag).
  if (textTurns.length === 0) return { kind: "missing" };
  if (textTurns.length > 1) {
    const normalized = (value: string) => value.trim().replace(/\s+/g, " ");
    if (new Set(textTurns.map((turn) => normalized(turn.text))).size > 1) return { kind: "ambiguous" };
  }
  const { text, itemType } = textTurns[0]!;
  return { kind: "ok", result: { text, ...(itemType ? { itemType } : {}) } };
}

export class CodexAppServerClient {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingTurnReceipts = new Set<PendingTurnReceipt>();
  private readonly originalTurnReplies = new Map<number, PendingTurnReceipt>();
  private readonly retainedStartOperations = new Set<PendingTurnReceipt>();
  private readonly retainedForkOperations = new Map<string, PendingTurnReceiptOperation>();
  private readonly originalForkReplies = new Map<number, PendingForkCreation>();
  private readonly forkCreations = new Set<PendingForkCreation>();
  private readonly conversionForkCreations = new Map<string, PendingForkCreation>();
  private readonly forkReleases = new Set<PendingForkRelease>();
  private readonly turns = new Map<string, TurnState>();
  private readonly liveThreads = new Set<string>();
  private readonly threadOwners = new Map<string, object>();
  private readonly ownerProcesses = new WeakMap<object, ChildProcess>();
  private readonly pendingOwners = new WeakMap<object, object>();
  /** Concurrent model preparation keeps its own original control-RPC owner. */
  private readonly modelRequests = new AsyncLocalStorage<{ process: ChildProcess; threadId?: string; owner?: object }>();
  /** Registered turn-waiter rejection callbacks so `stop()` (and an unexpected
   * process exit) can settle every in-flight waitForTurn immediately instead
   * of leaving them to time out against a closed process/store. */
  private readonly turnWaitersList = new Map<(error: Error, cleanupOnly?: boolean) => void, TurnRegistration>();
  private child?: ChildProcess;
  private initialization?: InitializationFlight;
  /** Teardown latch: once `stop()` has begun, no new `start()`/request may
   * spawn the App Server again. Set synchronously at the START of the first
   * stop() call so a turn-waiter settle racing teardown can never trigger a
   * best-effort interrupt through a FRESH child. */
  private stopped = false;
  /** Single-flight teardown: every concurrent/repeated stop() call awaits the
   * SAME settled promise, so "stop() returns" always means the teardown
   * (including the old child's exit) is truly complete. */
  private stopPromise?: Promise<void>;
  private stopFailed = false;
  private readonly stopForkTrees = new Set<ProcessTreeEvidence>();
  private forkTreeCleanupFlight?: Promise<void>;
  /** Single-flight RECOVERABLE shutdown for idle or rejected initialization:
   * closes only its original child without latching this client. A later start()/health() respawns a
   * fresh App Server. Distinct from `stopPromise`: the permanent teardown
   * latch is NEVER armed by an idle shutdown, and `start()`/`stop()` wait for
   * an in-flight idle shutdown before spawning or tearing down. */
  private idleStopping?: Promise<void>;
  private idleRetirement?: IdleProcessRetirement;
  /** Only teardown shares a census; model-stage snapshots can omit later children. */
  private readonly processRetirements = new WeakMap<ChildProcess, IdleProcessRetirement>();
  private readonly retirementDiagnostics = new WeakMap<ProcessTreeEvidence, readonly ProcessTreeObservation[]>();
  private readonly startupDiagnostics = new WeakMap<ChildProcess, readonly ProcessTreeCaptureObservation[]>();
  private readonly initializedProcessTrees = new WeakMap<ChildProcess, Promise<ProcessTreeEvidence>>();
  private readonly lostProcesses = new Set<LostAppServerProcess>();
  private lostProcessCleanup?: Promise<void>;
  /** A live OS process cannot serve RPCs after its original transport fails. */
  private readonly transportFailures = new WeakMap<ChildProcess, Error>();
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;
  /** 1.1.6: rounds currently pinning this child (see `beginRound`). */
  private pinned = 0;
  private turnWaiters = 0;
  private readonly modelGateway: ModelSelectionGateway;
  private readonly tokenUsage = new ThreadTokenUsageLedger();
  private readonly tokenUsageListeners = new Set<(snapshot: TokenUsageSnapshot) => void>();

  constructor(private readonly options: CodexAppServerOptions) {
    this.modelGateway = new ModelSelectionGateway({
      request: (method, params, signal) => this.request<JsonObject>(method, params, signal),
      object,
    });
  }

  /** Current thread's server-reported snapshot; never a workflow-wide sum or price estimate. */
  getThreadTokenUsage(threadId: string): TokenUsageSnapshot | undefined {
    return this.tokenUsage.get(threadId);
  }

  onTokenUsage(listener: (snapshot: TokenUsageSnapshot) => void): () => void {
    if (this.stopped) return () => undefined;
    this.tokenUsageListeners.add(listener);
    return () => { this.tokenUsageListeners.delete(listener); };
  }

  async start(signal?: AbortSignal): Promise<void> {
    // Permanent-teardown fence: after stop() has begun this client must NEVER
    // spawn the App Server again — a best-effort interrupt (e.g. a turn-waiter
    // settle racing stop) or a late caller must fail loudly instead of
    // restarting.
    if (this.stopped) throw new Error("Codex app-server stopped");
    if (signal?.aborted) throw abortError(signal);
    // A recoverable shutdown may already be detaching its original child:
    // a racing spawn would write into a dying pipe, so WAIT for the old
    // child's exit to complete before deciding. The await is also a yield
    // point where a final stop() may latch — re-check the fence afterwards.
    const retiring = this.idleStopping ?? (this.idleRetirement ? this.idleShutdown() : undefined);
    if (retiring) await this.waitForStartupReceipt(retiring, signal);
    if (this.lostProcesses.size) await this.waitForStartupReceipt(this.cleanupLostProcesses(), signal);
    if (this.stopped) throw new Error("Codex app-server stopped");
    if (signal?.aborted) throw abortError(signal);
    const original = this.initialization;
    if (original?.abandoned || original?.rejected) {
      // A withdrawn or rejected attempt must finish its original cleanup before
      // a fresh caller admits another one. Do not inherit its caller's abort.
      await this.waitForStartupReceipt(original.promise.catch(() => undefined), signal);
      return this.start(signal);
    }
    if (original) return this.waitForInitialization(original, signal);
    if (this.child && this.child.exitCode === null) {
      const failure = this.transportFailures.get(this.child);
      if (failure) throw failure;
      return;
    }
    const flight: InitializationFlight = { controller: new AbortController(), consumers: new Set(),
      promise: Promise.resolve(), settled: false, abandoned: false };
    this.initialization = flight;
    flight.promise = this.startProcess(flight.controller.signal, flight).finally(() => {
      flight.settled = true;
      if (this.initialization === flight) {
        this.initialization = undefined;
      }
    });
    return this.waitForInitialization(flight, signal);
  }

  private waitForInitialization(flight: InitializationFlight, signal?: AbortSignal): Promise<void> {
    const consumer = {};
    flight.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        flight.consumers.delete(consumer);
        if (error === undefined) resolve(); else reject(error);
      };
      const onAbort = () => {
        const reason = abortError(signal!);
        finish(reason);
        if (!flight.settled && !flight.abandoned && flight.consumers.size === 0 && this.initialization === flight) {
          flight.abandoned = true;
          flight.controller.abort(reason);
        }
      };
      flight.promise.then(() => finish(), (error: unknown) => finish(error));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /** Observer cancellation withdraws only its wait, never an owned shutdown. */
  private waitForStartupReceipt(receipt: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return receipt;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError(signal)); };
      signal.addEventListener("abort", onAbort, { once: true });
      receipt.then(() => { signal.removeEventListener("abort", onAbort); resolve(); },
        (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
    });
  }

  /** NOT async on purpose: callers must receive the EXACT same promise object
   * for concurrent/repeated calls (an async wrapper would mint a new promise
   * on every call and break single-flight identity). The PERMANENT teardown:
   * the FIRST call wins, sets `stopped` immediately (no restarts from here on)
   * and becomes the ONE teardown every concurrent and repeated stop() awaits.
   * A second caller can never return before the first has finished (old child
   * exited), and repeated calls after completion stay idempotent. This is the
   * FINAL, non-recoverable shutdown — the idle path uses `idleShutdown()`
   * instead, which closes the child without arming this latch. */
  stop(): Promise<void> {
    // Single-flight + latch: the FIRST call wins, sets `stopped` immediately
    // (no restarts from here on) and becomes the ONE teardown every
    // concurrent and repeated stop() awaits. A second caller can never return
    // before the first has finished (old child exited), and repeated calls
    // after completion stay idempotent.
    if (this.stopPromise) {
      if (!this.stopFailed || (!this.stopForkTrees.size && !this.idleRetirement && !this.lostProcesses.size)) return this.stopPromise;
      // A failed proof permits only another cleanup of the same captured
      // instances. The permanent stop latch never authorizes a new backend.
      this.stopFailed = false;
      const cleanup = (async () => {
        if (this.idleRetirement) await this.idleShutdown();
        await this.cleanupStoppedForkTrees();
      })();
      this.stopPromise = cleanup;
      void cleanup.catch(() => { this.stopFailed = true; });
      return cleanup;
    }
    this.stopped = true;
    this.initialization?.controller.abort(new Error("Codex app-server stopped"));
    const task = this.doStop();
    this.stopPromise = task;
    void task.catch(() => { this.stopFailed = true; });
    return task;
  }

  private async doStop(): Promise<void> {
    this.clearIdleTimer();
    this.modelGateway.resetCache();
    // An actual exit already owns the primary failure. Join its bounded
    // diagnostic receipt before stop settles or replaces any remaining waiter.
    if (this.lostProcesses.size) await Promise.all([...this.lostProcesses].map((lost) => lost.diagnostic));
    // A RECOVERABLE idle shutdown may be closing the current child right now:
    // the permanent teardown must WAIT for that close to complete (the idle
    // path already detached the child, so no double-close happens) and then
    // finish the permanent teardown itself. No new child can be spawned in
    // the meantime: `stopped` latched synchronously when stop() began.
    if (this.idleStopping) await this.idleStopping.catch(() => undefined);
    if (this.idleRetirement) await this.idleShutdown();
    const child = this.child;
    const retirement = child && Number.isSafeInteger(child.pid) ? this.processRetirement(child) : undefined;
    // Capture uncertainty while this exact original launcher is still ours.
    // Caller timers and listeners can settle without discarding its late reply.
    const starts = new Set([...this.originalTurnReplies.values(), ...this.retainedStartOperations]);
    const forks = [...this.forkCreations];
    this.rejectPending(new Error("Codex app-server stopped"));
    this.rejectForkCreations(new Error("Codex app-server stopped"));
    this.rejectTurnWaiters(new Error("Codex app-server stopped"));
    await Promise.allSettled([...starts].map((receipt) => this.receiptEvidence(receipt)));
    for (const creation of forks) this.stopForkTrees.add(await this.forkCreationEvidence(creation));
    for (const release of this.forkReleases) this.stopForkTrees.add(await this.forkCreationEvidence(release.creation));
    if (retirement) this.stopForkTrees.add(await retirement.evidence);
    // Rejecting initialize may have started retirement of this same child.
    // Join its close before detaching; both paths share the original census.
    if (this.idleStopping) await this.idleStopping.catch(() => undefined);
    this.child = undefined;
    this.turns.clear();
    this.liveThreads.clear();
    this.threadOwners.clear();
    this.tokenUsage.clear();
    this.tokenUsageListeners.clear();
    // Every pending RPC and every active turn waiter must settle NOW: after
    // stop() returns, a late waitForTurn/request resolution could race the
    // closed stores. (The manager interrupts and awaits foreground turns
    // before stopping; this is the defensive fence for anything left.)
    this.rejectPending(new Error("Codex app-server stopped"));
    this.rejectTurnWaiters(new Error("Codex app-server stopped"));
    if (!child || child.exitCode !== null) {
      await this.cleanupStoppedForkTrees();
      return;
    }
    // GRACEFUL shutdown: EOF on stdin gives the app-server the chance to flush
    // its final rollout write and exit on its own before we escalate. This is
    // defensive lifecycle hardening — an abrupt TerminateProcess
    // (child.kill on Windows) could in principle race an in-flight write at
    // shutdown, but the root cause has NOT been isolated (in the real compare
    // experiment, both the kill sequence and the EOF sequence read the completed
    // turn back with its final message intact). Where the client is idle there
    // is no active turn/request; for teardown the dispatcher interrupts active
    // turns first, so EOF is never sent to abort a live review.
    if (!retirement?.closing) {
      if (retirement) retirement.closing = true;
      await stopProcess(child, this.options.quitGraceMs ?? 5_000, this.options.killGraceMs ?? 2_000);
    }
    await this.cleanupStoppedForkTrees();
  }

  private cleanupStoppedForkTrees(): Promise<void> {
    if (this.forkTreeCleanupFlight) return this.forkTreeCleanupFlight;
    const task = (async () => {
      for (const evidence of this.stopForkTrees) {
        if (!await stopCapturedProcessTree(evidence, this.options.killGraceMs ?? 2000)) {
          throw this.processCleanupError("Original fork creation or App Server process tree cleanup is unconfirmed; no replacement process will be started", evidence);
        }
        this.stopForkTrees.delete(evidence);
        if (this.idleRetirement && (await this.idleRetirement.evidence) === evidence) this.idleRetirement = undefined;
        for (const creation of this.forkCreations) {
          if (creation.evidence && (await creation.evidence) === evidence) this.claimForkCreation(creation);
        }
        for (const release of this.forkReleases) {
          if (release.creation.evidence && (await release.creation.evidence) === evidence) {
            release.released = true;
            this.forkReleases.delete(release);
            this.retainedForkOperations.delete(release.creation.sourceThreadId);
          }
        }
      }
      await this.cleanupLostProcesses();
    })();
    this.forkTreeCleanupFlight = task;
    void task.finally(() => { if (this.forkTreeCleanupFlight === task) this.forkTreeCleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private forkCreationEvidence(creation: PendingForkCreation): Promise<ProcessTreeEvidence> {
    creation.evidence ??= (async () => {
      const processId = creation.process.pid;
      const observations: ProcessTreeCaptureObservation[] = [];
      const finish = (captured?: Awaited<ReturnType<typeof captureProcessTreeEvidence>>) => {
        const evidence = Object.freeze({ processId, ...captured });
        this.retirementDiagnostics.set(evidence, Object.freeze([...observations]));
        return evidence;
      };
      if (this.child !== creation.process || creation.process.exitCode !== null || creation.process.signalCode !== null) return finish();
      const captured = await captureProcessTreeEvidence(processId, value => observations.push(value));
      if (this.child !== creation.process || creation.process.exitCode !== null || creation.process.signalCode !== null) return finish();
      return finish(captured);
    })();
    return creation.evidence;
  }

  async health(signal?: AbortSignal): Promise<{ modelCount: number }> {
    await this.start(signal);
    const response = await this.request<JsonObject>("model/list", {}, signal);
    const models = Array.isArray(response.data) ? response.data.length : 0;
    return { modelCount: models };
  }

  async startThread(options: StartThreadOptions, signal?: AbortSignal): Promise<string> {
    await this.start(signal);
    const processOwner = this.child;
    this.assertProcessOwner(processOwner);
    const params: JsonObject = {
      cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "dsh-codex-workflow",
      sessionStartSource: "startup",
      ephemeral: options.ephemeral === true,
    };
    if (options.model) params.model = options.model;
    const response = await this.request<JsonObject>("thread/start", params, signal, processOwner);
    this.assertProcessOwner(processOwner);
    const thread = object(response.thread);
    const threadId = string(thread.id, "thread/start result.thread.id");
    const threadOwner = this.registerThread(threadId, processOwner);
    if (options.ephemeral !== true && options.name) {
      await this.request("thread/name/set", { threadId, name: options.name }, signal, processOwner, threadOwner);
    }
    return threadId;
  }

  /** Read-only metadata/rollout read of a thread (the same call used for
   * source validation with `includeTurns: false`). With `includeTurns: true`
   * it returns the persisted turns so persistence (turn status + final agent
   * JSON) can be verified after the client that ran them has closed. */
  async readThread(threadId: string, includeTurns: boolean, signal?: AbortSignal): Promise<JsonObject> {
    const response = await this.request<JsonObject>("thread/read", { threadId, includeTurns }, signal);
    return object(response.thread);
  }

  /**
   * 1.1.2: set a thread's DISPLAY NAME.
   *
   * Verified on codex-cli 0.154.0: `thread/name/set` succeeds on a thread that
   * is NOT loaded, so this needs no `thread/resume` and therefore never takes
   * the writer lock of a thread another process (Codex Desktop) may hold. Used
   * to give a readable title to threads the plugin created — an untitled task
   * is hard to find in the Desktop UI.
   */
  async nameThread(threadId: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.request("thread/name/set", { threadId, name }, signal);
  }

  async resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void> {
    await this.start(signal);
    const processOwner = this.child;
    this.assertProcessOwner(processOwner);
    await this.request("thread/resume", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: true,
    }, signal, processOwner);
    this.assertProcessOwner(processOwner);
    this.registerThread(threadId, processOwner);
  }

  captureThreadOwner(threadId: string): object | undefined {
    return this.isThreadAvailable(threadId) ? this.threadOwners.get(threadId) : undefined;
  }

  isThreadAvailable(threadId: string, expectedOwner?: object): boolean {
    return !this.stopped && Boolean(this.child && this.child.exitCode === null && !this.child.killed)
      && !this.transportFailures.has(this.child!)
      && this.liveThreads.has(threadId) && (!expectedOwner
        || (this.threadOwners.get(threadId) === expectedOwner && this.ownerProcesses.get(expectedOwner) === this.child));
  }

  private assertProcessOwner(owner: ChildProcess | undefined): asserts owner is ChildProcess {
    if (!owner || this.child !== owner || this.stopped || owner.exitCode !== null || owner.killed) {
      throw new CodexInvalidThreadError("original Codex app-server process is unavailable; no replacement will be used");
    }
    const failure = this.transportFailures.get(owner);
    if (failure) throw failure;
  }

  private assertThreadOwner(threadId: string, owner?: object): void {
    if (owner && !this.isThreadAvailable(threadId, owner)) {
      throw new CodexInvalidThreadError("original Codex thread owner is unavailable; no replacement will be used");
    }
  }

  private registerThread(threadId: string, processOwner: ChildProcess): object {
    this.assertProcessOwner(processOwner);
    const owner = Object.freeze({});
    this.ownerProcesses.set(owner, processOwner);
    this.threadOwners.set(threadId, owner);
    this.liveThreads.add(threadId);
    for (const key of this.turns.keys()) if (key.startsWith(`${threadId}:`)) this.turns.delete(key);
    this.tokenUsage.forget(threadId);
    return owner;
  }

  /** Capture the PERSISTED-turn baseline of a durable thread BEFORE a visible
   * review/rewrite turn starts (`thread/read` with `includeTurns: true`): the
   * ids of the turns already in the history. The appended (newly-persisted)
   * turn is later detected against this set, because the RPC turn id of
   * `review/start`/`turn/start` is NOT guaranteed to equal the persisted
   * `thread.turns[].id` (real App Server evidence: native review RPC turn ids
   * never appear in the persisted rollout history). */
  async captureTurnBaseline(threadId: string, signal?: AbortSignal): Promise<PersistedTurnBaseline> {
    const thread = await this.readThread(threadId, true, signal);
    const turns: JsonObject[] = Array.isArray(thread.turns) ? thread.turns.map(object) : [];
    return {
      ids: turns.flatMap((turn) => typeof turn.id === "string" && turn.id.length > 0 ? [turn.id] : []),
    };
  }

  /** Read the PERSISTED final visible output appended to a durable thread since
   * a {@link captureTurnBaseline} snapshot — the authoritative display text
   * Codex Desktop actually shows, which can differ from what the
   * streaming/`turn/completed` events aggregated in memory
   * (`TurnWaitResult.text`). The appended turns are located by the baseline id
   * set (never by assuming the RPC turn id equals the persisted one).
   *
   * Real App Server evidence for `review/start`: ONE review produces TWO
   * appended turns — the review-mode marker turn (idx == the RPC turn id,
   * items `enteredReviewMode`/`exitedReviewMode`, no text) and a second turn
   * carrying the review's final agent message (a different persisted id, and
   * on this server its status rolls out as `interrupted` even though the text
   * is complete). The authoritative text is therefore taken from the appended
   * turns that actually CARRY a final visible text (agentMessage/plan/
   * exitedReviewMode with non-empty text): exactly one such turn, or several
   * carrying the SAME text (the review is rolled out twice — once on the
   * marker turn's `exitedReviewMode.review`, once on the streamed
   * agentMessage turn), is required. Because the persisted rollout can LAG the
   * turn/completed event, the read polls within
   * {@link APPENDED_READBACK_TIMEOUT_MS} — zero text turns still rolling out,
   * several with DIFFERENT texts (ambiguous/concurrent writers), and a
   * timeout with no text all return `undefined`; callers must treat those as
   * retryable failures and NEVER compensate by falling back to the in-memory
   * text. */
  async readAppendedTurnText(threadId: string, baseline: PersistedTurnBaseline, signal?: AbortSignal): Promise<{ text: string; itemType?: string } | undefined> {
    const deadline = Date.now() + APPENDED_READBACK_TIMEOUT_MS;
    for (;;) {
      const thread = await this.readThread(threadId, true, signal);
      const sample = sampleAppendedText(thread, baseline);
      if (sample.kind === "ok") return sample.result;
      if (sample.kind === "ambiguous" || Date.now() >= deadline) return undefined;
      await new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 250);
        timer.unref();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  /** Read-only validation of the source task before it is resumed for review.
   * `thread/read` with `includeTurns: false` confirms the source exists without
   * resuming it and without touching its writer, so Codex Desktop may keep the
   * source open (or be its active writer) without making the validation busy;
   * the later resume may still report that writer conflict and be retried.
   * A missing source maps to a terminal `CodexInvalidThreadError`. */
  async validateSourceThread(threadId: string, signal?: AbortSignal): Promise<void> {
    let response: JsonObject;
    try {
      response = await this.request<JsonObject>("thread/read", { threadId, includeTurns: false }, signal);
    } catch (error) {
      if (/no rollout found for thread id/i.test(errorMessage(error))) {
        throw new CodexInvalidThreadError(`codex thread ${threadId} does not exist`);
      }
      throw error;
    }
    const thread = object(response.thread);
    const id = typeof thread.id === "string" && thread.id ? thread.id : undefined;
    if (id !== threadId) throw new CodexInvalidThreadError(`codex thread ${threadId} does not exist`);
  }

  /** Create a fresh, durable, independently owned REVIEW-ONLY thread that
   * carries none of the source task's history or writer state. Since 1.0.8
   * this is used ONLY by `review_only` flows (they have no Planner/source
   * task to reuse); planned and bridge workflows append reviews to their
   * original task instead. Read-only, network disabled and approval-free are
   * enforced at thread level here and again per review turn by `startTurn`.
   *
   * `thread/start` already subscribes the new thread, so if any later setup
   * step (settings update or naming) fails, the half-configured review-only
   * thread is unsubscribed here before the error propagates — it must never
   * be left holding a writer lock, even when `idleProcessMs` is 0. */
  /** 1.1.3: `thread/start` ALONE. The returned id is durable, so a caller that
   * retries a failed CONFIGURATION reuses the SAME task — retrying the whole
   * creation would leave one orphan, named-less task in the Codex store per
   * attempt. */
  async startReviewerThreadShell(options: ReviewerStartOptions, signal?: AbortSignal): Promise<string> {
    await this.start(signal);
    const processOwner = this.child;
    this.assertProcessOwner(processOwner);
    const params: JsonObject = {
      cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "dsh-codex-workflow",
      sessionStartSource: "startup",
      ephemeral: options.ephemeral === true,
    };
    if (options.model) params.model = options.model;
    const response = await this.request<JsonObject>("thread/start", params, signal, processOwner);
    this.assertProcessOwner(processOwner);
    const thread = object(response.thread);
    const threadId = string(thread.id, "thread/start result.thread.id");
    this.registerThread(threadId, processOwner);
    return threadId;
  }

  /** 1.1.3: settings + display name of an already created Reviewer task. Both
   * requests are idempotent on a given task id, so a caller may retry them
   * without creating a second task. */
  async configureReviewerThread(threadId: string, options: ReviewerStartOptions, signal?: AbortSignal): Promise<void> {
    const threadOwner = options.expectedOwner ?? this.captureThreadOwner(threadId);
    this.assertThreadOwner(threadId, threadOwner);
    const processOwner = this.child;
    this.assertProcessOwner(processOwner);
    await this.request("thread/settings/update", {
      threadId,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
    }, signal, processOwner, threadOwner);
    if (options.ephemeral !== true && options.name) {
      await this.request("thread/name/set", { threadId, name: options.name }, signal, processOwner, threadOwner);
    }
  }

  async startReviewerThread(options: ReviewerStartOptions, signal?: AbortSignal): Promise<string> {
    const threadId = await this.startReviewerThreadShell(options, signal);
    const threadOwner = this.captureThreadOwner(threadId);
    try {
      await this.configureReviewerThread(threadId, { ...options, expectedOwner: threadOwner }, signal);
    } catch (error) {
      // Best-effort release of the orphaned subscription; never mask the
      // original setup failure. No signal is passed so an aborted caller still
      // gets the cleanup issued.
      await this.unsubscribeThread(threadId, undefined, threadOwner).catch(() => undefined);
      throw error;
    }
    return threadId;
  }

  /** Refresh the readable review contract + per-round context as developer
   * instructions on a durable Reviewer thread right BEFORE an inline review
   * runs (DSH-led re-reviews). AUXILIARY channel only: the `review/start`
   * custom target carries the complete per-round context and the coverage
   * gate on every path, Git included, so verdict correctness never depends
   * on this thread-settings refresh. */
  async updateReviewerInstructions(threadId: string, cwd: string, instructions: string, signal?: AbortSignal): Promise<void> {
    await this.request("thread/settings/update", {
      threadId,
      cwd,
      developerInstructions: instructions,
    }, signal);
  }

  async startTurn(threadId: string, options: StartTurnOptions, signal?: AbortSignal): Promise<TurnWaitResult> {
    const threadOwner = options.expectedOwner ?? this.captureThreadOwner(threadId);
    this.assertThreadOwner(threadId, threadOwner);
    this.assertNoUnadoptedStart(threadId, threadOwner);
    await this.start(signal);
    const owner = this.child;
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    const params: JsonObject = {
      threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
    if (options.model) params.model = options.model;
    if (options.effort) params.effort = options.effort;
    if (options.outputSchema) params.outputSchema = options.outputSchema;
    if (options.silentReview) {
      const mode = await this.modelRequests.run({ process: owner, threadId, owner: threadOwner },
        () => this.silentReviewMode(options.model, options.effort, signal));
      if (mode) params.collaborationMode = mode;
    } else if (options.conversion) {
      const mode = await this.modelRequests.run({ process: owner, threadId, owner: threadOwner },
        () => this.conversionMode(options.model, options.effort, signal));
      if (mode) params.collaborationMode = mode;
    } else if (options.planMode) {
      const mode = await this.modelRequests.run({ process: owner, threadId, owner: threadOwner },
        () => this.planMode(options.model, options.effort, signal));
      if (mode) params.collaborationMode = mode;
    }
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    // Report the effective model so callers can persist it and reuse it for
    // later turns (continuation, restart, ephemeral conversion fork).
    const collaborationMode = params.collaborationMode as { settings?: { model?: unknown } } | undefined;
    const modeSettings = collaborationMode && typeof collaborationMode === "object" ? collaborationMode.settings : undefined;
    const settingsModel = modeSettings && typeof modeSettings.model === "string" ? modeSettings.model : undefined;
    const effectiveModel = options.model ?? settingsModel;
    if (effectiveModel && options.onModel) options.onModel(effectiveModel);
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    const state = await this.requestRegisteredTurn("turn/start", params, signal, owner, threadOwner,
      options.conversion ? "Codex structured conversion unexpectedly requested user input"
        : options.silentReview ? "Codex review unexpectedly requested user input" : undefined);
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    const turnId = state.turnId;
    if (options.onStarted) {
      try {
        await options.onStarted({ threadId, turnId });
      } catch (error) {
        // The turn is genuinely running by now; never leave it unmanaged when
        // the caller's registration callback fails.
        throw await this.interruptionFailure(state.protocolFailure ?? error, threadId, turnId, owner, true, threadOwner);
      }
    }
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    this.attachProgress(this.state(threadId, turnId), options.onProgress);
    const result = await this.waitForTurn(threadId, turnId, signal, owner, threadOwner);
    if (result.kind === "needs_input" && (options.conversion || options.silentReview)) {
      const error = new Error(options.conversion
        ? "Codex structured conversion unexpectedly requested user input"
        : "Codex review unexpectedly requested user input");
      throw await this.interruptionFailure(error, threadId, turnId, owner, true, threadOwner);
    }
    return result;
  }

  async continueTurn(
    pending: TurnNeedsInputResult,
    answers: Record<string, string[]>,
    signal?: AbortSignal,
    onProgress?: (entry: AppServerLiveEvent) => void,
    expectedOwner?: object,
  ): Promise<TurnWaitResult> {
    const threadOwner = expectedOwner ?? this.pendingOwners.get(pending) ?? this.captureThreadOwner(pending.threadId);
    this.assertThreadOwner(pending.threadId, threadOwner);
    await this.start(signal);
    const owner = this.child;
    this.assertProcessOwner(owner);
    this.assertThreadOwner(pending.threadId, threadOwner);
    const state = this.state(pending.threadId, pending.turnId);
    if (state.protocolFailure) return this.waitForTurn(pending.threadId, pending.turnId, signal, owner, threadOwner);
    this.attachProgress(state, onProgress);
    this.write({
      id: pending.request.requestId,
      result: {
        answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])),
      },
    });
    state.input = undefined;
    return this.waitForTurn(pending.threadId, pending.turnId, signal, owner, threadOwner);
  }

  async startReview(options: ReviewStartOptions, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }> {
    const sourceOwner = options.expectedOwner ?? this.captureThreadOwner(options.threadId);
    this.assertThreadOwner(options.threadId, sourceOwner);
    this.assertNoUnadoptedStart(options.threadId, sourceOwner);
    await this.start(signal);
    const owner = this.child;
    this.assertProcessOwner(owner);
    this.assertThreadOwner(options.threadId, sourceOwner);
    const state = await this.requestRegisteredTurn("review/start", {
      threadId: options.threadId,
      delivery: options.detached ? "detached" : "inline",
      target: options.target,
    }, signal, owner, sourceOwner, "Codex review unexpectedly requested user input");
    this.assertProcessOwner(owner);
    this.assertThreadOwner(options.threadId, sourceOwner);
    const reviewThreadId = state.threadId, turnId = state.turnId;
    const threadOwner = state.registration!.threadOwner;
    try {
      // Detached reviews otherwise inherit the app-server process cwd in Codex Desktop.
      await this.request("thread/settings/update", {
        threadId: reviewThreadId,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }, signal, owner, threadOwner);
      if (options.onStarted) await options.onStarted({ threadId: reviewThreadId, turnId });
      this.assertProcessOwner(owner);
      this.assertThreadOwner(reviewThreadId, threadOwner);
    } catch (error) {
      // The reviewer turn is genuinely running; a failed settings update or
      // registration callback must not leave it unmanaged.
      throw await this.interruptionFailure(state.protocolFailure ?? error, reviewThreadId, turnId, owner, true, threadOwner);
    }
    // `review/start` creates the turn before the response arrives. The
    // explicit model/effort must therefore be carried on the RPC target when
    // supported, and on the follow-up turn settings for older servers.
    if (options.model || options.effort) {
      await this.request("turn/settings/update", {
        threadId: reviewThreadId,
        turnId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { reasoning_effort: options.effort } : {}),
      }, signal, owner, threadOwner).catch(() => undefined);
    }
    this.assertProcessOwner(owner);
    this.assertThreadOwner(reviewThreadId, threadOwner);
    this.attachProgress(this.state(reviewThreadId, turnId), options.onProgress);
    const result = await this.waitForTurn(reviewThreadId, turnId, signal, owner, threadOwner);
    if (result.kind === "needs_input") {
      throw await this.interruptionFailure(new Error("Codex review unexpectedly requested user input"), reviewThreadId, turnId, owner, true, threadOwner);
    }
    return { threadId: reviewThreadId, result };
  }

  async interrupt(threadId: string, turnId: string, signal?: AbortSignal, expectedOwner?: object): Promise<void> {
    this.assertThreadOwner(threadId, expectedOwner);
    if (this.stopped || !this.child || this.child.exitCode !== null) {
      throw new Error("original Codex app-server process is unavailable for interruption");
    }
    // A later terminal notification also confirms that the original writer
    // ended; retrying an interrupt for it could otherwise fail as "not active".
    const completed = this.turns.get(turnKey(threadId, turnId));
    if (completed?.completed) {
      if (completed.completedRegistration === completed.registration) this.confirmReceiptTurn(threadId, turnId, this.child,
        expectedOwner ?? this.captureThreadOwner(threadId));
      return;
    }
    // Cleanup must never spawn a replacement process for an old turn.
    const owner = this.child;
    const threadOwner = expectedOwner ?? this.captureThreadOwner(threadId);
    await this.requestRaw("turn/interrupt", { threadId, turnId }, signal, owner, threadOwner);
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    this.confirmReceiptTurn(threadId, turnId, owner, threadOwner);
  }

  /** Release this connection's subscription to a thread. This does not confirm
   * termination of an active model turn; interruption must be confirmed first.
   * Idempotent and never deletes or archives the thread. Ephemeral workflow
   * threads remain process-local and are never resumed after process loss.
   *
   * The server answers one of three statuses: `unsubscribed` (we were the
   * subscribed connection), `notSubscribed` (the thread is loaded but this
   * connection was not subscribed), or `notLoaded` (the thread is not currently
   * loaded by the App Server). All three confirm only subscription cleanup. */
  async unsubscribeThread(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<"unsubscribed" | "notSubscribed" | "notLoaded"> {
    signal?.throwIfAborted();
    const threadOwner = expectedOwner ?? this.captureThreadOwner(threadId);
    for (const release of [...this.forkReleases]) {
      if (!release.cleanupPending || (release.creation.sourceThreadId !== threadId && release.fork.threadId !== threadId)) continue;
      const originalOwner = release.fork.threadId === threadId ? release.fork.owner : release.creation.sourceOwner;
      if (threadOwner !== originalOwner) throw new CodexInvalidThreadError("Original conversion cleanup belongs to another subscription owner");
      await this.releaseConversionFork(release);
      signal?.throwIfAborted();
      this.retainedForkOperations.delete(release.creation.sourceThreadId);
      if (release.fork.threadId === threadId) return release.subscriptionStatus!;
    }
    if (expectedOwner && !this.isThreadAvailable(threadId, expectedOwner)) return "notLoaded";
    this.assertNoUnadoptedStart(threadId, expectedOwner ?? this.captureThreadOwner(threadId));
    return this.unsubscribeRegisteredThread(threadId, signal, expectedOwner);
  }

  private async unsubscribeRegisteredThread(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<"unsubscribed" | "notSubscribed" | "notLoaded"> {
    // Never respawn a stopped App Server just to release a subscription: if
    // the child is gone there is nothing loaded to unsubscribe from.
    if (!this.child || this.child.exitCode !== null) {
      this.tokenUsage.forget(threadId);
      return "notLoaded";
    }
    const owner = this.child;
    const threadOwner = expectedOwner ?? this.captureThreadOwner(threadId);
    const response = await this.requestRaw<unknown>("thread/unsubscribe", { threadId }, signal, owner, threadOwner);
    if (this.child !== owner || (threadOwner && !this.isThreadAvailable(threadId, threadOwner))) return "notLoaded";
    const status = object(response).status;
    if (status !== "unsubscribed" && status !== "notSubscribed" && status !== "notLoaded") {
      throw new CodexProtocolError(new Error("invalid thread/unsubscribe response.status; original subscription cleanup is unconfirmed"));
    }
    // Commit local release only after this original connection received a
    // valid protocol acknowledgement. Malformed replies retain its owner.
    this.liveThreads.delete(threadId);
    this.threadOwners.delete(threadId);
    this.tokenUsage.forget(threadId);
    return status;
  }

  /** Release a visible task before an external CLI resumes it. When the
   * client is already idle, wait for the recoverable child shutdown so its
   * thread-store writer is fully gone before the CLI starts. */
  async releaseThreadForExternal(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<void> {
    if (this.idleStopping || this.idleRetirement) {
      await this.waitForStartupReceipt(this.idleStopping ?? this.idleShutdown(), signal);
      return;
    }
    const owner = this.child;
    const threadOwner = expectedOwner ?? this.captureThreadOwner(threadId);
    await this.unsubscribeThread(threadId, signal, threadOwner);
    const current = this.captureThreadOwner(threadId);
    if (this.child !== owner || (current && current !== threadOwner)) return;
    if (this.idleStopping) await this.waitForStartupReceipt(this.idleStopping, signal);
    if (this.child !== owner) return;
    if (!this.isIdle()) throw new Error("Original App Server still has active or unconfirmed work; external handoff cannot retire it");
    // A completed Planner/review may still leave the App Server child alive
    // for a short window after unsubscribe. Force the recoverable idle path so
    // the process-held thread-store writer is definitely gone before CLI
    // resume; the next Planner operation will transparently respawn it.
    await this.waitForStartupReceipt(this.idleShutdown(), signal);
  }

  /**
   * Create an EPHEMERAL fork of a persistent thread (`thread/fork` with
   * `ephemeral: true`) and run one structured-conversion turn inside it.
   *
   * Used to convert the human-readable visible reply of a Planner or Reviewer
   * task into the enforced structured result WITHOUT ever writing JSON into
   * the persisted task history Codex Desktop shows. Safety is enforced per
   * turn by `startTurn` (read-only sandbox, `networkAccess: false`,
   * `approvalPolicy: never`) and the fork turn pins the non-collaborative
   * "default" mode with the JSON-only conversion developer instructions. The
   * fork runs at `effort: "low"` and, when a model is given, reuses the SAME
   * model as the source task.
   *
   * Confirmed ending paths unsubscribe the fork exactly once (idempotent:
   * `unsubscribed`, `notSubscribed` and `notLoaded` are all success outcomes).
   * An unconfirmed interruption retains its exact pair and subscription for
   * the caller's cleanup barrier; unsubscribe cannot prove writer exit. The fork's id is
   * transient: callers must never persist it into
   * `plannerThreadId`/`reviewerThreadId`.
   */
  async normalizeInFork(
    options: ForkConversionOptions,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult> {
    if (options.sourceEphemeral) return this.normalizeInThread(options, signal);
    this.assertThreadOwner(options.threadId, options.expectedOwner);
    const releases = [...this.forkReleases].filter((release) => release.cleanupPending && release.creation.sourceThreadId === options.threadId);
    if (releases.length) {
      if (releases.length !== 1) throw new Error("Original conversion subscription cleanup is ambiguous; no replacement conversion will run");
      return this.recoverForkRelease(releases[0]!, options, signal);
    }
    const pendingFork = this.retainedForkOperations.get(options.threadId);
    if (pendingFork) {
      if (pendingFork.finished()) await pendingFork.cleanup();
      else throw new CodexTurnReceiptPendingError(new Error("original conversion fork is still owned"), pendingFork);
    }
    const creation = await this.forkForConversion(options, signal);
    const fork = creation.fork!;
    const forkThreadId = fork.threadId;
    const forkOwner = fork.owner;
    let interruptionPending = false;
    const release: PendingForkRelease = { creation, fork, cleanupPending: false, released: false };
    this.forkReleases.add(release);
    let retainedFork: PendingTurnReceiptOperation | undefined;
    const releaseFork = async () => {
      await this.releaseConversionFork(release);
      if (this.retainedForkOperations.get(options.threadId) === retainedFork) this.retainedForkOperations.delete(options.threadId);
    };
    try {
      const result = await this.startTurn(forkThreadId, {
        prompt: options.prompt,
        ...(options.model ? { model: options.model } : {}),
        effort: "low",
        outputSchema: options.outputSchema,
        conversion: true,
        onStarted: options.onStarted,
        expectedOwner: forkOwner,
      }, signal);
      release.result = structuredClone(result);
      return result;
    } catch (error) {
      release.error = error;
      if (error instanceof CodexTurnReceiptPendingError) {
        interruptionPending = true;
        const original = error.operation;
        const operation: PendingTurnReceiptOperation = Object.freeze({
          sourceThreadId: original.sourceThreadId, sourceThreadOwner: original.sourceThreadOwner,
          status: () => original.status(), evidence: () => original.evidence(),
          finished: () => original.finished(),
          resume: async (callbacks: Parameters<PendingTurnReceiptOperation["resume"]>[0], resumeSignal?: AbortSignal) => {
            let outcome: Awaited<ReturnType<PendingTurnReceiptOperation["resume"]>>;
            try { outcome = await original.resume(callbacks, resumeSignal); }
            catch (error) {
              release.error = error;
              if (error instanceof CodexTurnInterruptionError && error.threadId === forkThreadId) {
                release.interruption = error; release.cleanupPending = true;
              }
              throw error;
            }
            if (outcome.result.kind === "completed") {
              release.result = structuredClone(outcome.result);
              await releaseFork().catch(() => undefined);
            }
            return outcome;
          },
          cleanup: async (cleanupSignal?: AbortSignal) => {
            const confirmed = await original.cleanup(cleanupSignal);
            if (!confirmed) return false;
            try { await releaseFork(); return true; } catch { return false; }
          },
        });
        retainedFork = operation;
        this.retainedForkOperations.set(options.threadId, operation);
        throw new CodexTurnReceiptPendingError(error.cause instanceof Error ? error.cause : error, operation);
      }
      interruptionPending = error instanceof CodexTurnInterruptionError && error.threadId === forkThreadId;
      if (interruptionPending) {
        release.interruption = error as CodexTurnInterruptionError;
        release.cleanupPending = true;
      }
      throw error;
    } finally {
      // Preserve the already completed result or primary model error, while
      // retaining failed auxiliary cleanup as a separately retryable step.
      if (!interruptionPending) await releaseFork().catch(() => undefined);
    }
  }

  private releaseConversionFork(release: PendingForkRelease): Promise<void> {
    if (release.released) return Promise.resolve();
    if (release.cleanupFlight) return release.cleanupFlight;
    release.cleanupPending = true;
    this.forkReleases.add(release);
    const task = (async () => {
      this.assertProcessOwner(release.creation.process);
      if (release.interruption) {
        const interruption = release.interruption;
        const registration = this.turns.get(turnKey(interruption.threadId, interruption.turnId))?.registration;
        if (interruption.originalThreadOwner !== release.fork.owner || registration?.process !== release.creation.process
          || registration.threadOwner !== release.fork.owner) {
          throw new CodexInvalidThreadError("Original conversion interruption pair is unavailable; no replacement will be used");
        }
        await this.interrupt(interruption.threadId, interruption.turnId, undefined, release.fork.owner);
        release.interruption = undefined;
        release.error = interruption.cause instanceof Error ? interruption.cause : interruption;
      }
      const current = this.captureThreadOwner(release.fork.threadId);
      if (current && current !== release.fork.owner) throw new CodexInvalidThreadError("Original conversion subscription owner changed; cleanup is unconfirmed");
      release.subscriptionStatus = current
        ? await this.unsubscribeRegisteredThread(release.fork.threadId, undefined, release.fork.owner) : "notSubscribed";
      this.assertProcessOwner(release.creation.process);
      if (this.captureThreadOwner(release.fork.threadId)) throw new Error("Original conversion subscription release is unconfirmed");
      for (const key of [...this.turns.keys()]) if (key.startsWith(`${release.fork.threadId}:`)) this.turns.delete(key);
      release.released = true;
      this.forkReleases.delete(release);
      this.scheduleIdle();
    })();
    release.cleanupFlight = task;
    void task.finally(() => { if (release.cleanupFlight === task) release.cleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private async recoverForkRelease(release: PendingForkRelease, options: ForkConversionOptions,
    signal?: AbortSignal): Promise<TurnWaitResult> {
    signal?.throwIfAborted();
    this.assertProcessOwner(release.creation.process);
    this.assertThreadOwner(options.threadId, release.creation.sourceOwner);
    if ((options.expectedOwner ?? this.captureThreadOwner(options.threadId)) !== release.creation.sourceOwner
      || this.forkConversionSignature(options) !== release.creation.signature) {
      throw new Error("Original conversion cleanup context changed; refusing to replace or borrow its completed output");
    }
    if (!release.recoveryFlight) {
      const task = (async () => {
        await this.releaseConversionFork(release);
        this.assertProcessOwner(release.creation.process);
        this.assertThreadOwner(options.threadId, release.creation.sourceOwner);
        this.retainedForkOperations.delete(options.threadId);
        if (release.result) return structuredClone(release.result);
        throw release.error ?? new Error("Original conversion has no completed output to recover; no model will be repeated");
      })();
      release.recoveryFlight = task;
      void task.finally(() => { if (release.recoveryFlight === task) release.recoveryFlight = undefined; }).catch(() => undefined);
    }
    const task = release.recoveryFlight;
    if (!signal) return structuredClone(await task);
    return new Promise<TurnWaitResult>((resolve, reject) => {
      const finish = (error?: unknown, result?: TurnWaitResult) => {
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error); else resolve(result!);
      };
      const abort = () => finish(signal.reason ?? new Error("operation aborted"));
      signal.addEventListener("abort", abort, { once: true });
      task.then((result) => finish(undefined, structuredClone(result)), (error) => finish(error));
      if (signal.aborted) abort();
    });
  }

  /** Current visible App Server model catalog for the DSH settings surface. */
  async listModels(signal?: AbortSignal): Promise<Array<{ id: string; name?: string; isDefault: boolean; defaultReasoningEffort?: string }>> {
    return (await this.withPreparedModelCatalog(() => this.modelGateway.listVisibleModels(signal), signal)).map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      isDefault: model.isDefault,
      ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    }));
  }

  /** Convert directly on an ephemeral source thread. Ephemeral threads have
   * no persisted rollout, so they cannot be used as the source of
   * `thread/fork`; the visible turn and this JSON turn still share the same
   * in-process context and the JSON never enters Desktop history. */
  async normalizeInThread(
    options: ForkConversionOptions,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult> {
    return this.startTurn(options.threadId, {
      prompt: options.prompt,
      ...(options.model ? { model: options.model } : {}),
      effort: "low",
      outputSchema: options.outputSchema,
      conversion: true,
      onStarted: options.onStarted,
      expectedOwner: options.expectedOwner,
    }, signal);
  }

  /** Fork an existing thread with `ephemeral: true` (Codex's `thread/fork`).
   * The fork is exclusively ours and subscribed; it must be unsubscribed by
   * the caller (or by `normalizeInFork`'s finally) so it is not left loaded. */
  async forkThread(threadId: string, cwd: string, signal?: AbortSignal, expectedOwner?: object): Promise<string> {
    signal?.throwIfAborted();
    const threadOwner = expectedOwner ?? this.captureThreadOwner(threadId);
    this.assertThreadOwner(threadId, threadOwner);
    await this.cleanupAbandonedForks(threadId);
    await this.start(signal);
    signal?.throwIfAborted();
    const owner = this.child;
    this.assertProcessOwner(owner);
    this.assertThreadOwner(threadId, threadOwner);
    this.assertNoUnadoptedStart(threadId, threadOwner);
    const creation = this.createForkReceipt(threadId, cwd, owner, threadOwner);
    try {
      const forkId = await this.waitForForkCreation(creation, signal);
      signal?.throwIfAborted();
      this.claimForkCreation(creation);
      return forkId;
    } catch (error) {
      creation.abandoned = true;
      if (creation.fork) void this.releaseAbandonedFork(creation).catch(() => undefined);
      throw error;
    }
  }

  private forkConversionSignature(options: ForkConversionOptions): string {
    return JSON.stringify([options.cwd, options.prompt, options.model ?? null, options.outputSchema]);
  }

  private async forkForConversion(options: ForkConversionOptions, signal?: AbortSignal): Promise<PendingForkCreation> {
    signal?.throwIfAborted();
    const sourceOwner = options.expectedOwner ?? this.captureThreadOwner(options.threadId);
    let creation = this.conversionForkCreations.get(options.threadId);
    const signature = this.forkConversionSignature(options);
    if (creation) {
      this.assertProcessOwner(creation.process);
      this.assertThreadOwner(options.threadId, creation.sourceOwner);
      if (sourceOwner !== creation.sourceOwner || signature !== creation.signature) {
        throw new Error("Original conversion fork creation context changed; refusing to create or borrow another fork");
      }
      if (creation.observing) throw new Error("Original conversion fork creation is running; wait for its current observer");
    } else {
      const processOwner = this.child;
      this.assertProcessOwner(processOwner);
      this.assertThreadOwner(options.threadId, sourceOwner);
      this.assertNoUnadoptedStart(options.threadId, sourceOwner);
      creation = this.createForkReceipt(options.threadId, options.cwd, processOwner, sourceOwner, signature);
      if (!creation.claimed) this.conversionForkCreations.set(options.threadId, creation);
    }
    creation.observing = true;
    try {
      await this.waitForForkCreation(creation, signal);
      signal?.throwIfAborted();
      this.assertProcessOwner(creation.process);
      this.assertThreadOwner(options.threadId, creation.sourceOwner);
      if (this.forkConversionSignature(options) !== creation.signature) {
        throw new Error("Original conversion fork creation context changed before adoption");
      }
      this.claimForkCreation(creation);
      return creation;
    } finally { creation.observing = false; }
  }

  private createForkReceipt(threadId: string, cwd: string, processOwner: ChildProcess, sourceOwner?: object,
    signature?: string): PendingForkCreation {
    const creation: PendingForkCreation = { requestId: this.nextId++, process: processOwner,
      sourceThreadId: threadId, sourceOwner, signature, observing: false, abandoned: false, claimed: false };
    this.forkCreations.add(creation);
    this.originalForkReplies.set(creation.requestId, creation);
    void this.forkCreationEvidence(creation);
    try {
      this.clearIdleTimer();
      this.write({ id: creation.requestId, method: "thread/fork", params: {
        threadId, cwd, runtimeWorkspaceRoots: [cwd], ephemeral: true,
        // Codex 0.154.0 requires this for ephemeral forks. It trims only the
        // response history; the fork still inherits the source context.
        excludeTurns: true,
      } });
    } catch (error) {
      creation.error = error instanceof Error ? error : new Error(errorMessage(error));
      this.claimForkCreation(creation);
    }
    return creation;
  }

  private claimForkCreation(creation: PendingForkCreation): void {
    creation.claimed = true;
    this.originalForkReplies.delete(creation.requestId);
    this.forkCreations.delete(creation);
    if (this.conversionForkCreations.get(creation.sourceThreadId) === creation) {
      this.conversionForkCreations.delete(creation.sourceThreadId);
    }
  }

  private waitForForkCreation(creation: PendingForkCreation, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const event = `fork:${creation.requestId}`;
      let settled = false;
      const finish = (error?: Error, forkId?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.events.off(event, observe);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(forkId!);
      };
      const observe = () => {
        if (creation.error) finish(creation.error);
        else if (this.stopped || this.child !== creation.process || !this.isThreadAvailable(creation.sourceThreadId, creation.sourceOwner)) {
          finish(new CodexInvalidThreadError("Original conversion fork creation process or source owner is unavailable; no replacement will be used"));
        } else if (creation.fork) finish(undefined, creation.fork.threadId);
      };
      const onAbort = () => finish(abortError(signal!));
      const timeout = this.options.rpcTimeoutMs ?? Math.max(5_000, Math.min(this.options.requestTimeoutMs, 60_000));
      const timer = setTimeout(() => finish(new Error("Codex request timed out: thread/fork")), timeout);
      this.events.on(event, observe);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort(); else observe();
    });
  }

  private receiveForkReply(creation: PendingForkCreation, message: JsonObject): void {
    this.originalForkReplies.delete(creation.requestId);
    try {
      this.assertProcessOwner(creation.process);
      this.assertThreadOwner(creation.sourceThreadId, creation.sourceOwner);
      if (message.error) {
        creation.error = new Error(jsonRpcError(message.error));
        this.claimForkCreation(creation);
      } else {
        const forkId = string(object(object(message.result).thread).id, "thread/fork result.thread.id");
        if (forkId === creation.sourceThreadId || this.liveThreads.has(forkId)) {
          throw new Error("invalid thread/fork receipt: returned thread already belongs to another execution");
        }
        creation.fork = { threadId: forkId, owner: this.registerThread(forkId, creation.process) };
      }
    } catch (error) { creation.error = new CodexProtocolError(error instanceof Error ? error : new Error(errorMessage(error))); }
    this.events.emit(`fork:${creation.requestId}`);
    if (creation.abandoned && creation.fork) void this.releaseAbandonedFork(creation).catch(() => undefined);
    this.scheduleIdle();
  }

  private releaseAbandonedFork(creation: PendingForkCreation): Promise<void> {
    if (creation.claimed || !creation.fork) return Promise.resolve();
    if (creation.cleanupFlight) return creation.cleanupFlight;
    const fork = creation.fork;
    const task = (async () => {
      this.assertProcessOwner(creation.process);
      if (!this.isThreadAvailable(fork.threadId, fork.owner)) {
        throw new Error("Original abandoned fork subscription owner is unavailable; cleanup is unconfirmed");
      }
      // Only this exact creation owner bypasses its own source/fork barrier.
      await this.unsubscribeRegisteredThread(fork.threadId, undefined, fork.owner);
      if (this.child !== creation.process || this.stopped || this.captureThreadOwner(fork.threadId)) {
        throw new Error("Original abandoned fork subscription cleanup generation changed");
      }
      this.claimForkCreation(creation);
      this.scheduleIdle();
    })();
    creation.cleanupFlight = task;
    void task.finally(() => { if (creation.cleanupFlight === task) creation.cleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private async cleanupAbandonedForks(sourceThreadId: string): Promise<void> {
    for (const creation of this.forkCreations) {
      if (creation.sourceThreadId === sourceThreadId && creation.abandoned) {
        await this.releaseAbandonedFork(creation);
      }
    }
  }

  private rejectForkCreations(error: Error): void {
    for (const creation of this.forkCreations) {
      creation.error ??= error;
      this.originalForkReplies.delete(creation.requestId);
      this.events.emit(`fork:${creation.requestId}`);
    }
  }

  private async startProcess(signal?: AbortSignal, initialization?: InitializationFlight): Promise<void> {
    this.modelGateway.resetCache();
    this.turns.clear();
    this.liveThreads.clear();
    this.threadOwners.clear();
    this.tokenUsage.clear();
    const { child, lines } = spawnProcess(this.options);
    // Keep the bounded diagnostic tail scoped to this original child.
    let stderr = "";
    const stderrDecoder = new StringDecoder("utf8");
    const appendStderr = (text: string) => {
      stderr = `${stderr}${text}`.slice(-16_384);
      const first = stderr.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) stderr = stderr.slice(1);
    };
    let stderrUnavailable = false;
    let processExit: Error | undefined;
    let exitDiagnostic: Promise<void> | undefined;
    let drainingExit = false;
    let stderrEnded = false;
    let finishExit: ((timedOut?: boolean) => void) | undefined;
    const ownsDiagnostic = () => this.child === child || drainingExit;
    this.child = child;
    lines?.on("line", (line) => { if (this.child === child) this.onLine(line, child); });
    const failTransport = (failure: Error) => {
      if (this.child !== child || this.stopped || this.transportFailures.has(child)) return;
      this.transportFailures.set(child, failure);
      this.failProcess(failure);
    };
    const outputFailed = (error?: Error) => {
      // Let a queued actual exit retain its established exit/stderr diagnostic.
      // This is observation of the original stream, never proof of OS exit.
      const observe = () => {
        if (this.child !== child || this.stopped || child.exitCode !== null || child.signalCode !== null
          || this.transportFailures.has(child)) return;
        const failure = error ? new Error(`Codex app-server stdout is unavailable: ${error.message}`, { cause: error })
          : new Error("Codex app-server stdout closed; original process cleanup is still required");
        failTransport(failure);
      };
      // Native stdout can close just before Windows reports process exit.
      // Bound that event-ordering window separately from every RPC budget.
      if (error) setImmediate(observe);
      else setTimeout(observe, 100).unref();
    };
    lines?.on("error", outputFailed);
    child.stdout?.on("error", outputFailed);
    child.stdout?.once("end", () => outputFailed());
    child.stdout?.once("close", () => outputFailed());
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (!ownsDiagnostic()) return;
      appendStderr(typeof chunk === "string" ? chunk : stderrDecoder.write(chunk));
    });
    // Diagnostic loss is not JSON-RPC transport loss. Consume late originals
    // as well, but only this current child may annotate its own exit error.
    child.stderr?.on("error", () => {
      if (ownsDiagnostic() && (!this.stopped || drainingExit)) stderrUnavailable = true;
      if (drainingExit) finishExit?.();
    });
    const diagnosticEnded = () => { stderrEnded = true; finishExit?.(); };
    child.stderr?.once("end", diagnosticEnded);
    child.stderr?.once("close", diagnosticEnded);
    // Writable errors may arrive after EOF/stop has detached this child.
    // Consume its stream event, but never fail a successor's transport.
    child.stdin?.on("error", (error) => {
      failTransport(new Error(`Codex app-server stdin is unavailable: ${error.message}`, { cause: error }));
    });
    child.once("error", (error) => { if (this.child === child) this.failProcess(error); });
    child.once("exit", (code, reason) => {
      const unexpected = this.child === child;
      if (unexpected) {
        let releaseDiagnostic!: () => void;
        const diagnostic = new Promise<void>((resolve) => { releaseDiagnostic = resolve; });
        exitDiagnostic = diagnostic;
        this.lostProcesses.add({ original: this.initializedProcessTrees.get(child) ?? Promise.resolve({ processId: child.pid }), diagnostic,
          startupObservations: () => this.startupDiagnostics.get(child) ?? Object.freeze([]) });
        // Actual exit invalidates RPC/thread availability synchronously. Its
        // original stderr can still carry buffered bytes after Node emits exit.
        this.child = undefined;
        drainingExit = true;
        let timer: NodeJS.Timeout | undefined;
        finishExit = (timedOut = false) => {
          if (!drainingExit) return;
          drainingExit = false;
          if (timer) clearTimeout(timer);
          appendStderr(stderrDecoder.end());
          processExit = new Error(`codex app-server exited ${code ?? "unknown"} (${reason ?? "no signal"}): ${stderr.trim()}${stderrUnavailable ? "\n(stderr diagnostic stream unavailable)" : ""}${timedOut ? "\n(stderr diagnostic stream did not finish before exit deadline)" : ""}`);
          try { this.failProcess(processExit); }
          finally { releaseDiagnostic(); }
        };
        if (stderrEnded || !child.stderr || child.stderr.readableEnded || child.stderr.destroyed) finishExit();
        else {
          // This bounds diagnostic collection even when a surviving descendant
          // keeps its inherited pipe open. Original RPC/turn timers remain armed.
          timer = setTimeout(() => finishExit?.(true), 100);
          child.stderr.resume();
        }
      }
    });
    try {
      if (!lines || !child.stdin || !child.stdout || !child.stderr) await this.waitForMissingStdio(child, signal);
      const initialized = await this.requestRaw<JsonObject>("initialize", {
        clientInfo: { name: "dsh-codex-workflow", title: "DSH Codex Workflow", version: PLUGIN_VERSION },
        capabilities: { experimentalApi: true },
      }, signal, child);
      if (signal?.aborted) throw abortError(signal);
      this.assertProcessOwner(child);
      if (typeof initialized.userAgent !== "string") throw new Error("invalid Codex initialize response");
      this.write({ method: "initialized", params: {} });
      // Admit work only after recording the actual backend instances while
      // their launcher is still ours. A later lost launcher is not a census.
      const original = (async () => {
        const processId = child.pid;
        const started = performance.now();
        const observations: ProcessTreeCaptureObservation[] = [];
        const captured = await captureProcessTreeEvidence(processId, value => observations.push(value));
        const retired = this.child !== child || child.exitCode !== null || child.signalCode !== null;
        if (retired) observations.push(Object.freeze({ processId, code: "owner_retired",
          elapsedMs: Math.max(0, Math.round(performance.now() - started)), limitMs: 4000 }));
        this.startupDiagnostics.set(child, Object.freeze([...observations]));
        if (retired) return { processId };
        return Object.freeze({ processId, ...captured });
      })();
      this.initializedProcessTrees.set(child, original);
      await original;
      if (exitDiagnostic) await exitDiagnostic;
      if (signal?.aborted) throw abortError(signal);
      const transportFailure = this.transportFailures.get(child);
      if (transportFailure) throw transportFailure;
      if (processExit) throw processExit;
      this.assertProcessOwner(child);
      if (initialization) initialization.settled = true;
      this.scheduleIdle();
    } catch (error) {
      if (initialization) initialization.rejected = true;
      if (this.child === child) {
        this.failProcess(error instanceof Error ? error : new Error(errorMessage(error)));
        // This failed admission still owns its original child. Sharing the
        // proven tree retirement keeps a racing startup behind its original
        // backend. Auxiliary cleanup cannot replace the initialization error.
        if (Number.isSafeInteger(child.pid)) await this.idleShutdown().catch(() => undefined);
        else this.child = undefined; // A failed spawn never obtained an OS instance.
      } else if (Number.isSafeInteger(child.pid) && !this.child && !this.idleRetirement
        && !(this.stopped && this.processRetirements.has(child))) {
        // The launcher was lost before census. Preserve unknown ownership;
        // never reinterpret its missing descriptor as permission to respawn.
        const evidence = { processId: child.pid };
        this.retirementDiagnostics.set(evidence, this.startupDiagnostics.get(child) ?? Object.freeze([]));
        this.idleRetirement = { process: child, closing: false, evidence: Promise.resolve(evidence) };
      }
      throw error;
    }
  }

  private waitForMissingStdio(child: ChildProcess, signal?: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      let settled = false;
      const finish = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError); child.off("spawn", onUnavailable); child.off("close", onUnavailable);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onError = (error: Error) => finish(error);
      const onUnavailable = () => finish(new Error("Codex app-server stdio is unavailable after spawn"));
      const onAbort = () => finish(abortError(signal!));
      const rpcTimeoutMs = this.options.rpcTimeoutMs ?? Math.max(5000, Math.min(this.options.requestTimeoutMs, 60000));
      const timer = setTimeout(() => finish(new Error("Codex app-server spawn receipt timed out with missing stdio")), rpcTimeoutMs);
      child.once("error", onError); child.once("spawn", onUnavailable); child.once("close", onUnavailable);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private planMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.withPreparedModelCatalog(() => this.modelGateway.planMode(model, effort, signal), signal);
  }

  private silentReviewMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.withPreparedModelCatalog(() => this.modelGateway.silentReviewMode(model, effort, signal), signal);
  }

  private conversionMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.withPreparedModelCatalog(() => this.modelGateway.conversionMode(model, effort, signal), signal);
  }

  async resolveDefaultModel(signal?: AbortSignal): Promise<string | undefined> {
    return this.withPreparedModelCatalog(() => this.modelGateway.resolveDefaultModel(signal), signal);
  }

  /** Metadata may start a server; admitted model work keeps its original one. */
  private async withPreparedModelCatalog<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const original = this.modelRequests.getStore();
    if (original) {
      this.assertProcessOwner(original.process);
      if (original.threadId) this.assertThreadOwner(original.threadId, original.owner);
      const result = await work();
      this.assertProcessOwner(original.process);
      if (original.threadId) this.assertThreadOwner(original.threadId, original.owner);
      return result;
    }
    await this.start(signal);
    const process = this.child;
    this.assertProcessOwner(process);
    return this.modelRequests.run({ process }, async () => {
      const result = await work();
      this.assertProcessOwner(process);
      return result;
    });
  }
  /** Probe the App Server's thread directory (`thread/list`) when the protocol
   * provides it. Returns the known thread ids, or `undefined` when the method
   * is unsupported (older servers) so callers can skip directory assertions
   * instead of failing on a missing capability. Any OTHER failure propagates. */
  async listThreadIds(signal?: AbortSignal): Promise<string[] | undefined> {
    let response: JsonObject;
    try {
      response = await this.request<JsonObject>("thread/list", {}, signal);
    } catch (error) {
      const message = errorMessage(error);
      if (/unknown method|unsupported|not implemented|method not found/i.test(message)) return undefined;
      throw error;
    }
    const entries = Array.isArray(response.data) ? response.data : Array.isArray(response.threads) ? response.threads : [];
    const ids: string[] = [];
    for (const entry of entries) {
      const thread = object(entry);
      const id = typeof thread.id === "string" && thread.id ? thread.id : undefined;
      if (id) ids.push(id);
    }
    return ids;
  }

  private async request<T = JsonObject>(method: string, params: JsonObject, signal?: AbortSignal,
    expectedProcess?: ChildProcess, expectedOwner?: object): Promise<T> {
    const modelOwner = this.modelRequests.getStore();
    expectedProcess ??= modelOwner?.process;
    if (expectedProcess) this.assertProcessOwner(expectedProcess);
    if (expectedOwner) this.assertThreadOwner(String(params.threadId), expectedOwner);
    if (modelOwner?.threadId) this.assertThreadOwner(modelOwner.threadId, modelOwner.owner);
    await this.start(signal);
    if (modelOwner?.threadId) this.assertThreadOwner(modelOwner.threadId, modelOwner.owner);
    return this.requestRaw<T>(method, params, signal, expectedProcess ?? this.child, expectedOwner);
  }

  private async requestRegisteredTurn(method: "turn/start" | "review/start", params: JsonObject,
    signal: AbortSignal | undefined, processOwner: ChildProcess, sourceOwner?: object, terminalInputError?: string): Promise<TurnState> {
    const receipt: PendingTurnReceipt = Object.freeze({
      requestId: this.nextId++, method, process: processOwner,
      threadId: String(params.threadId), threadOwner: sourceOwner,
      detached: method === "review/start" && params.delivery === "detached",
      failures: new Map(),
      lifecycle: { submitted: false, replyReceived: false, detachedObserver: false, released: false,
        confirmed: false, adopted: false, terminalInputError },
    });
    receipt.lifecycle.operation = Object.freeze({
      sourceThreadId: receipt.threadId, sourceThreadOwner: receipt.threadOwner,
      status: () => this.receiptStatus(receipt), finished: () => this.receiptFinished(receipt),
      evidence: () => this.receiptEvidence(receipt),
      resume: (callbacks: Parameters<PendingTurnReceiptOperation["resume"]>[0], resumeSignal?: AbortSignal) => this.resumeReceipt(receipt, callbacks, resumeSignal),
      cleanup: (cleanupSignal?: AbortSignal) => this.cleanupReceipt(receipt, cleanupSignal),
    });
    try {
      const response = await this.requestRaw<JsonObject>(method, params, signal, processOwner, sourceOwner, receipt);
      this.assertProcessOwner(processOwner);
      this.assertThreadOwner(receipt.threadId, sourceOwner);
      const state = receipt.lifecycle.state ?? this.adoptReceipt(receipt, response);
      receipt.lifecycle.adopted = true;
      return state;
    } finally {
      if (!receipt.lifecycle.detachedObserver) this.releaseReceipt(receipt);
    }
  }

  private adoptReceipt(receipt: PendingTurnReceipt, response: JsonObject): TurnState {
    this.assertProcessOwner(receipt.process);
    this.assertThreadOwner(receipt.threadId, receipt.threadOwner);
    const threadId = receipt.method === "review/start"
      ? string(response.reviewThreadId, "review/start result.reviewThreadId") : receipt.threadId;
    const threadOwner = threadId === receipt.threadId ? receipt.threadOwner : this.registerThread(threadId, receipt.process);
    const turnId = string(object(response.turn).id, `${receipt.method} result.turn.id`);
    const state = this.registerTurn(threadId, turnId, receipt.process, threadOwner, receipt);
    receipt.lifecycle.state = state;
    return state;
  }

  private receiptStatus(receipt: PendingTurnReceipt): ReturnType<PendingTurnReceiptOperation["status"]> {
    if (this.child !== receipt.process || this.stopped || receipt.process.exitCode !== null
      || this.captureThreadOwner(receipt.threadId) !== receipt.threadOwner) return "unavailable";
    if (receipt.lifecycle.invalidReply) return "invalid";
    const state = receipt.lifecycle.state;
    if (!state) return "pending";
    if (this.turns.get(turnKey(state.threadId, state.turnId)) !== state) return "unavailable";
    return this.captureThreadOwner(state.threadId) === state.registration?.threadOwner ? "ready" : "unavailable";
  }

  private receiptFinished(receipt: PendingTurnReceipt): boolean {
    const state = receipt.lifecycle.state;
    return receipt.lifecycle.confirmed || Boolean(state?.completed && state.registration
      && state.completedRegistration === state.registration && state.registration.process === receipt.process);
  }

  private confirmReceiptTurn(threadId: string, turnId: string, processOwner: ChildProcess, threadOwner?: object): void {
    for (const receipt of [...this.retainedStartOperations]) {
      const state = receipt.lifecycle.state;
      if (state?.threadId === threadId && state.turnId === turnId && this.turns.get(turnKey(threadId, turnId)) === state
        && state.registration?.process === processOwner && state.registration.threadOwner === threadOwner) {
        receipt.lifecycle.confirmed = true;
        this.releaseReceipt(receipt);
      }
    }
  }

  private receiptEvidence(receipt: PendingTurnReceipt): Promise<ProcessTreeEvidence> {
    if (receipt.lifecycle.evidence) return receipt.lifecycle.evidence;
    const processId = receipt.process.pid;
    const task = (async (): Promise<ProcessTreeEvidence> => {
      if (this.child !== receipt.process || receipt.process.exitCode !== null) return Object.freeze({ processId });
      const captured = await captureProcessTreeEvidence(processId);
      if (this.child !== receipt.process || receipt.process.exitCode !== null || receipt.process.signalCode !== null) {
        return Object.freeze({ processId });
      }
      return Object.freeze({ processId,
        ...(captured?.processIds ? { processIds: Object.freeze([...captured.processIds]) } : {}),
        ...(captured?.processIdentities ? { processIdentities: captured.processIdentities } : {}) });
    })();
    receipt.lifecycle.evidence = task;
    return task;
  }

  private releaseReceipt(receipt: PendingTurnReceipt): void {
    receipt.lifecycle.released = true;
    if (this.originalTurnReplies.get(receipt.requestId) === receipt) this.originalTurnReplies.delete(receipt.requestId);
    this.pendingTurnReceipts.delete(receipt);
    this.retainedStartOperations.delete(receipt);
  }

  private assertNoUnadoptedStart(threadId: string, expectedOwner?: object): void {
    for (const release of this.forkReleases) {
      if (release.cleanupPending && !release.released && release.creation.process === this.child
        && (release.creation.sourceThreadId === threadId || release.fork.threadId === threadId)) {
        throw new Error("Original conversion subscription cleanup is unconfirmed; retry only its original cleanup before further model work or unsubscribe");
      }
    }
    for (const creation of this.forkCreations) {
      if (creation.process === this.child && !creation.claimed && (creation.abandoned || creation.signature !== undefined)
        && (creation.sourceThreadId === threadId || creation.fork?.threadId === threadId)) {
        throw new Error("Original conversion fork creation is unconfirmed; wait for its original reply before further model work or unsubscribe");
      }
    }
    for (const receipt of [...this.retainedStartOperations]) {
      if (this.receiptFinished(receipt)) { this.releaseReceipt(receipt); continue; }
      const actualThreadId = receipt.lifecycle.state?.threadId;
      if (receipt.process !== this.child || (receipt.threadId !== threadId && actualThreadId !== threadId)) continue;
      if (receipt.threadId === threadId && receipt.threadOwner !== expectedOwner) {
        throw new CodexInvalidThreadError("original unconfirmed start belongs to another thread owner; no replacement will be used");
      }
      throw new CodexTurnReceiptPendingError(receipt.lifecycle.error ?? new Error("original model start is still owned"), receipt.lifecycle.operation!);
    }
  }

  private async resumeReceipt(receipt: PendingTurnReceipt, callbacks: Parameters<PendingTurnReceiptOperation["resume"]>[0],
    signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }> {
    signal?.throwIfAborted();
    if (this.receiptStatus(receipt) !== "ready") {
      throw new CodexTurnReceiptPendingError(receipt.lifecycle.error ?? new Error("the original start reply is not available"), receipt.lifecycle.operation!);
    }
    if (receipt.lifecycle.result) return receipt.lifecycle.result;
    const state = receipt.lifecycle.state!, registration = state.registration!;
    this.assertProcessOwner(receipt.process);
    this.assertThreadOwner(state.threadId, registration.threadOwner);
    if (!receipt.lifecycle.adopted) {
      receipt.lifecycle.adopted = true;
      try { await callbacks.onStarted?.({ threadId: state.threadId, turnId: state.turnId }); }
      catch (error) { throw await this.interruptionFailure(state.protocolFailure ?? error, state.threadId, state.turnId,
        receipt.process, true, registration.threadOwner); }
    }
    this.assertProcessOwner(receipt.process);
    this.assertThreadOwner(state.threadId, registration.threadOwner);
    this.attachProgress(state, callbacks.onProgress);
    const result = await this.waitForTurn(state.threadId, state.turnId, signal, receipt.process, registration.threadOwner);
    if (result.kind === "needs_input" && receipt.lifecycle.terminalInputError) {
      throw await this.interruptionFailure(new Error(receipt.lifecycle.terminalInputError), state.threadId, state.turnId,
        receipt.process, true, registration.threadOwner);
    }
    receipt.lifecycle.result = { threadId: state.threadId, result };
    if (this.receiptFinished(receipt)) this.releaseReceipt(receipt);
    return receipt.lifecycle.result;
  }

  private cleanupReceipt(receipt: PendingTurnReceipt, signal?: AbortSignal): Promise<boolean> {
    if (receipt.lifecycle.cleanupFlight) return receipt.lifecycle.cleanupFlight;
    const task = (async () => {
      signal?.throwIfAborted();
      if (this.receiptFinished(receipt)) { this.releaseReceipt(receipt); return true; }
      const state = receipt.lifecycle.state;
      if (state && this.receiptStatus(receipt) === "ready") {
        try {
          await this.interrupt(state.threadId, state.turnId, signal, state.registration!.threadOwner);
          receipt.lifecycle.confirmed = true;
          this.releaseReceipt(receipt);
          return true;
        } catch { return false; }
      }
      if (!await originalProcessTreeExited(await this.receiptEvidence(receipt))) return false;
      receipt.lifecycle.confirmed = true;
      this.releaseReceipt(receipt);
      return true;
    })();
    receipt.lifecycle.cleanupFlight = task;
    void task.finally(() => { if (receipt.lifecycle.cleanupFlight === task) receipt.lifecycle.cleanupFlight = undefined; }).catch(() => undefined);
    return task;
  }

  private requestRaw<T>(method: string, params: JsonObject, signal?: AbortSignal,
    expectedProcess?: ChildProcess, expectedOwner?: object, turnReceipt?: PendingTurnReceipt): Promise<T> {
    try {
      if (expectedProcess) this.assertProcessOwner(expectedProcess);
      if (expectedOwner) this.assertThreadOwner(String(params.threadId), expectedOwner);
    } catch (error) { return Promise.reject(error); }
    this.clearIdleTimer();
    const id = turnReceipt?.requestId ?? this.nextId++;
    const owner = expectedProcess ?? this.child;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        if (this.child === owner) this.scheduleIdle();
        return;
      }
      // Control RPCs are bounded by the (tighter) rpc timeout; the long turn
      // WAIT keeps the full requestTimeoutMs in waitForTurn.
      const rpcTimeoutMs = this.options.rpcTimeoutMs ?? Math.max(5_000, Math.min(this.options.requestTimeoutMs, 60_000));
      let entry: PendingRequest;
      let settled = false;
      const finish = (): boolean => {
        if (settled || this.pending.get(id) !== entry) return false;
        settled = true;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (entry.abort && entry.signal) entry.signal.removeEventListener("abort", entry.abort);
        if (this.child === owner) this.scheduleIdle();
        return true;
      };
      const timer = setTimeout(() => entry.reject(new Error(`Codex request timed out: ${method}`)), rpcTimeoutMs);
      entry = {
        resolve: (value) => { if (finish()) resolve(value as T); },
        reject: (error) => {
          if (!finish()) return;
          if (turnReceipt?.lifecycle.submitted && (!turnReceipt.lifecycle.replyReceived
            || turnReceipt.lifecycle.invalidReply && !turnReceipt.lifecycle.serverRejected)) {
            turnReceipt.lifecycle.error ??= error;
            turnReceipt.lifecycle.detachedObserver = true;
            this.retainedStartOperations.add(turnReceipt);
            reject(new CodexTurnReceiptPendingError(error, turnReceipt.lifecycle.operation!));
          } else reject(error);
        },
        timer,
      };
      this.pending.set(id, entry);
      if (signal) {
        entry.abort = () => entry.reject(abortError(signal));
        entry.signal = signal;
        signal.addEventListener("abort", entry.abort, { once: true });
        if (signal.aborted) { entry.abort(); return; }
      }
      if (turnReceipt) {
        this.pendingTurnReceipts.add(turnReceipt);
        this.originalTurnReplies.set(id, turnReceipt);
      }
      try {
        this.write({ id, method, params });
        if (turnReceipt) {
          turnReceipt.lifecycle.submitted = true;
          void this.receiptEvidence(turnReceipt);
        }
      }
      catch (error) { entry.reject(error instanceof Error ? error : new Error(errorMessage(error))); }
    });
  }

  private waitForTurn(threadId: string, turnId: string, signal?: AbortSignal,
    owner = this.child, threadOwner = this.captureThreadOwner(threadId)): Promise<TurnWaitResult> {
    try { this.assertProcessOwner(owner); this.assertThreadOwner(threadId, threadOwner); }
    catch (error) { return Promise.reject(error); }
    const remember = (result: TurnWaitResult): TurnWaitResult => {
      if (result.kind === "needs_input" && threadOwner) this.pendingOwners.set(result, threadOwner);
      return result;
    };
    const key = turnKey(threadId, turnId);
    const current = this.state(threadId, turnId);
    const registration = current.registration ??= Object.freeze({ process: owner!, threadOwner, threadId, turnId });
    if (registration.process !== owner || registration.threadOwner !== threadOwner) {
      return Promise.reject(new CodexInvalidThreadError("original Codex turn registration changed; no replacement will be used"));
    }
    if (current.protocolFailure) {
      return this.interruptionFailure(current.protocolFailure, threadId, turnId, owner, true, threadOwner)
        .then((error) => { throw error; });
    }
    const ready = current && turnResult(current);
    if (ready) {
      this.scheduleIdle();
      return Promise.resolve(remember(ready));
    }
    this.clearIdleTimer();
    this.turnWaiters += 1;
    const rejectAfterInterruption = async (error: Error, reject: (error: Error) => void, cleanupOnly = false) => {
      reject(await this.interruptionFailure(error, threadId, turnId, owner, cleanupOnly, threadOwner));
    };
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        // The turn may have started while the abort raced with the hand-off
        // from turn/start to this waiter. It still needs an explicit interrupt.
        this.turnWaiters -= 1;
        void rejectAfterInterruption(abortError(signal), reject);
        return;
      }
      let cleaned = false;
      const rejectNow = (error: Error, cleanupOnly = false) => {
        if (cleaned) return;
        cleanup();
        void rejectAfterInterruption(error, reject, cleanupOnly);
      };
      this.turnWaitersList.set(rejectNow, registration);
      const timeout = setTimeout(() => {
        rejectNow(new Error(`Codex turn timed out: ${turnId}`));
      }, this.options.requestTimeoutMs);
      const event = `turn:${key}`;
      const listener = () => {
        const state = this.turns.get(key);
        if (state?.registration !== registration) return;
        if (state.protocolFailure) { rejectNow(state.protocolFailure, true); return; }
        const result = state && turnResult(state);
        if (!result) return;
        cleanup();
        resolve(remember(result));
      };
      const onAbort = () => {
        rejectNow(abortError(signal!));
      };
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timeout);
        this.events.off(event, listener);
        signal?.removeEventListener("abort", onAbort);
        this.turnWaitersList.delete(rejectNow);
        this.turnWaiters -= 1;
        this.scheduleIdle();
      };
      this.events.on(event, listener);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async interruptBestEffort(threadId: string, turnId: string, owner = this.child, threadOwner = this.captureThreadOwner(threadId)): Promise<boolean> {
    if (!owner || this.child !== owner || owner.exitCode !== null || this.stopped) return false;
    try {
      await this.interrupt(threadId, turnId, undefined, threadOwner);
      return this.child === owner && owner.exitCode === null && (!threadOwner || this.isThreadAvailable(threadId, threadOwner));
    } catch {
      // Never mask the original failure with an interrupt failure.
      return false;
    }
  }

  private async abandonTurn(threadId: string, turnId: string, owner = this.child, threadOwner = this.captureThreadOwner(threadId)): Promise<boolean> {
    const confirmed = await this.interruptBestEffort(threadId, turnId, owner, threadOwner);
    if (confirmed && this.child === owner && (!threadOwner || this.isThreadAvailable(threadId, threadOwner))) this.turns.delete(turnKey(threadId, turnId));
    this.scheduleIdle();
    return confirmed;
  }

  /** Preserve the original writer until its exact interruption is confirmed.
   * Callback and contract failures admit cleanup only; ordinary waiter aborts
   * and timeouts retain their existing same-thread continuation semantics. */
  private async interruptionFailure<T>(error: T, threadId: string, turnId: string,
    owner: ChildProcess | undefined, cleanupOnly = false, threadOwner = this.captureThreadOwner(threadId)): Promise<T | CodexTurnInterruptionError> {
    const confirmed = await this.abandonTurn(threadId, turnId, owner, threadOwner);
    if (!confirmed && owner && this.child === owner && owner.exitCode === null && !this.stopped) {
      const captured = await captureProcessTreeEvidence(owner.pid);
      // A wrapper that exits while observed may have left a native descendant.
      // Keep the typed pending guard without a tree instead of assuming exit.
      const evidence = this.child === owner && !this.stopped && owner.exitCode === null && owner.signalCode === null ? captured : undefined;
      const original = error instanceof Error ? error : new Error(errorMessage(error));
      return new CodexTurnInterruptionError(original, threadId, turnId, owner.pid, evidence?.processIds, cleanupOnly, threadOwner,
        evidence?.processIdentities);
    }
    return error;
  }

  private onLine(line: string, processOwner = this.child): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = object(JSON.parse(line));
    } catch {
      return;
    }
    if ("id" in message && !("method" in message)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const forkCreation = this.originalForkReplies.get(id);
      if (forkCreation && forkCreation.process === processOwner) {
        this.receiveForkReply(forkCreation, message);
        return;
      }
      const receipt = this.originalTurnReplies.get(id);
      let receiptError: Error | undefined;
      if (receipt && receipt.process === processOwner) {
        receipt.lifecycle.replyReceived = true;
        this.originalTurnReplies.delete(id);
        this.pendingTurnReceipts.delete(receipt);
        if (message.error) {
          receipt.lifecycle.serverRejected = true;
          receipt.lifecycle.invalidReply = true;
          receipt.lifecycle.error = receiptError = new Error(jsonRpcError(message.error));
        } else {
          try { this.adoptReceipt(receipt, object(message.result)); }
          catch (error) {
            receipt.lifecycle.invalidReply = true;
            receipt.lifecycle.error = receiptError = error instanceof Error ? error : new Error(errorMessage(error));
          }
        }
      }
      const pending = this.pending.get(id);
      if (!pending) return;
      if (receiptError) pending.reject(receiptError);
      else if (message.error) pending.reject(new Error(jsonRpcError(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    try {
      if ("id" in message) this.onServerRequest(message);
      else this.onNotification(message.method, object(message.params));
    } catch (error) {
      this.rejectProtocolFrame(message, error instanceof Error ? error : new Error(errorMessage(error)), processOwner);
    }
  }

  private rejectProtocolFrame(message: JsonObject, error: Error, processOwner?: ChildProcess): void {
    if (!processOwner || this.child !== processOwner || this.stopped) return;
    const params = object(message.params), turn = object(params.turn);
    const threadId = typeof params.threadId === "string" && params.threadId ? params.threadId : undefined;
    const turnId = typeof params.turnId === "string" && params.turnId ? params.turnId
      : typeof turn.id === "string" && turn.id ? turn.id : undefined;
    // An unscoped frame cannot supply the missing identity of a writer whose
    // original receipt is still pending, or select among concurrent writers.
    if (!threadId && !turnId) return;
    const registrations = new Set(this.turnWaitersList.values());
    for (const state of this.turns.values()) if (state.registration && !state.completed) registrations.add(state.registration);
    const matching = [...registrations].filter((registration) => {
      const state = this.turns.get(turnKey(registration.threadId, registration.turnId));
      return registration.process === processOwner && state?.registration === registration && !state.completed
        && this.captureThreadOwner(registration.threadId) === registration.threadOwner
        && (!threadId || registration.threadId === threadId) && (!turnId || registration.turnId === turnId);
    });
    if (matching.length === 0) {
      const pending = [...this.pendingTurnReceipts].filter((receipt) => receipt.process === processOwner
        && this.isThreadAvailable(receipt.threadId, receipt.threadOwner)
        && this.captureThreadOwner(receipt.threadId) === receipt.threadOwner
        && (!threadId || receipt.detached || receipt.threadId === threadId));
      if (pending.length !== 1) return;
      // Frame ids are hints until the real reply arrives. Keep each hint's first
      // cause so an earlier foreign hint cannot hide a later matching failure.
      const failures = pending[0]!.failures, key = JSON.stringify([threadId, turnId]);
      if (!failures.has(key)) failures.set(key, { threadId, turnId, error });
      return;
    }
    if (matching.length !== 1) return;
    const registration = matching[0]!;
    const state = this.turns.get(turnKey(registration.threadId, registration.turnId))!;
    if (state.protocolFailure) return;
    state.protocolFailure = error;
    state.input = undefined;
    for (const [rejectNow, original] of [...this.turnWaitersList]) {
      if (original === registration) rejectNow(error, true);
    }
  }

  private onNotification(method: string, params: JsonObject): void {
    if (method === "thread/tokenUsage/updated") {
      if (this.stopped || typeof params.threadId !== "string" || !this.liveThreads.has(params.threadId)) return;
      const snapshot = this.tokenUsage.record(params);
      if (!snapshot) return;
      for (const listener of this.tokenUsageListeners) {
        try { listener({ ...snapshot, total: { ...snapshot.total }, last: { ...snapshot.last } }); } catch { /* Metrics observers must not abort model execution. */ }
      }
      return;
    }
    if (method === "turn/plan/updated" && typeof params.threadId === "string" && typeof params.turnId === "string"
      && Array.isArray(params.plan)) {
      const steps = params.plan.map(object).map((step) => `${step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "·"} ${String(step.step ?? "")}`);
      this.emitProgress(this.state(params.threadId, params.turnId), {
        kind: "plan", itemId: "steps", text: steps.join("\n").slice(0, 4096), replace: true,
      });
      return;
    }
    if (method === "item/agentMessage/delta" || method === "item/plan/delta" || method === "item/reasoning/summaryTextDelta") {
      if (typeof params.threadId !== "string" || typeof params.turnId !== "string"
        || typeof params.itemId !== "string" || typeof params.delta !== "string") return;
      const state = this.state(params.threadId, params.turnId);
      const kind = method === "item/plan/delta" ? "plan" : method === "item/agentMessage/delta" ? "message" : "reasoning";
      const key = `${kind}:${params.itemId}`;
      state.liveTexts ??= new Map();
      state.liveTexts.set(key, `${state.liveTexts.get(key) ?? ""}${params.delta}`.slice(0, 65_536));
      this.emitProgress(state, { kind, itemId: params.itemId, text: params.delta });
      return;
    }
    if (method === "item/started") {
      if (typeof params.threadId !== "string" || typeof params.turnId !== "string") return;
      const item = object(params.item);
      const label = liveToolLabel(item);
      if (label) this.emitProgress(this.state(params.threadId, params.turnId), {
        kind: "tool", itemId: typeof item.id === "string" ? item.id : "tool", text: label,
        ...liveToolDetails(item),
      });
      return;
    }
    if (method === "item/completed") {
      const threadId = protocolString(params.threadId, "item/completed threadId");
      const turnId = protocolString(params.turnId, "item/completed turnId");
      const state = this.state(threadId, turnId);
      const item = object(params.item);
      state.items.push(item);
      const completedText = typeof item.text === "string" ? item.text : item.type === "exitedReviewMode" && typeof item.review === "string" ? item.review : undefined;
      if ((item.type === "agentMessage" || item.type === "plan" || item.type === "exitedReviewMode") && typeof item.id === "string" && completedText !== undefined) {
        const kind = item.type === "plan" ? "plan" : "message";
        const key = `${kind}:${item.id}`;
        const streamed = state.liveTexts?.get(key) ?? "";
        const remainder = completedText.startsWith(streamed) ? completedText.slice(streamed.length) : completedText;
        if (remainder) this.emitProgress(state, { kind, itemId: item.id, text: remainder,
          ...(streamed && !completedText.startsWith(streamed) ? { replace: true } : {}) });
        state.liveTexts ??= new Map();
        state.liveTexts.set(key, completedText);
      } else if (typeof item.id === "string" && liveToolLabel(item)) {
        this.emitProgress(state, { kind: "tool", itemId: item.id,
          text: `${item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0) ? " · 失败" : " · 完成"}${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}`,
          ...liveToolDetails(item),
        });
      }
      return;
    }
    if (method === "turn/completed") {
      const threadId = protocolString(params.threadId, "turn/completed threadId");
      const turn = object(params.turn);
      const turnId = protocolString(turn.id, "turn/completed turn.id");
      const state = this.state(threadId, turnId);
      state.input = undefined;
      state.completed = turn;
      state.completedProcess = this.child;
      state.completedThreadOwner = this.captureThreadOwner(threadId);
      if (state.registration && state.registration.process === this.child && state.registration.threadOwner === state.completedThreadOwner) {
        state.completedRegistration = state.registration;
      }
      this.events.emit(`turn:${turnKey(threadId, turnId)}`);
      this.scheduleIdle();
    }
  }

  private onServerRequest(message: JsonObject): void {
    const method = string(message.method, "server request method");
    const id = message.id as string | number;
    const params = object(message.params);
    if (method === "item/tool/requestUserInput") {
      const threadId = protocolString(params.threadId, "requestUserInput threadId");
      const turnId = protocolString(params.turnId, "requestUserInput turnId");
      const questions = Array.isArray(params.questions) ? params.questions.map(normalizeQuestion) : [];
      this.state(threadId, turnId).input = {
        requestId: id,
        itemId: protocolString(params.itemId, "requestUserInput itemId"),
        questions,
      };
      this.events.emit(`turn:${turnKey(threadId, turnId)}`);
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.write({ id, result: { decision: "decline" } });
      return;
    }
    this.write({ id, error: { code: -32601, message: `unsupported server request: ${method}` } });
  }

  private state(threadId: string, turnId: string): TurnState {
    const key = turnKey(threadId, turnId);
    let state = this.turns.get(key);
    if (!state) {
      state = { threadId, turnId, items: [] };
      this.turns.set(key, state);
    }
    return state;
  }

  private registerTurn(threadId: string, turnId: string, processOwner: ChildProcess, threadOwner?: object,
    receipt?: PendingTurnReceipt): TurnState {
    const key = turnKey(threadId, turnId);
    let state = this.state(threadId, turnId);
    if (state.registration) {
      // A new receipt never inherits a previous execution's failure or owner.
      state = { threadId, turnId, items: [] };
      this.turns.set(key, state);
    }
    state.registration = Object.freeze({ process: processOwner, threadOwner, threadId, turnId });
    if (state.completed && state.completedProcess === processOwner
      && (state.completedThreadOwner === undefined || state.completedThreadOwner === threadOwner)) {
      state.completedRegistration = state.registration;
    }
    if (receipt) {
      const failure = [...receipt.failures.values()].find((entry) => (!entry.threadId || entry.threadId === threadId)
        && (!entry.turnId || entry.turnId === turnId));
      if (failure) { state.protocolFailure = failure.error; state.input = undefined; }
    }
    return state;
  }

  private attachProgress(state: TurnState, listener?: (entry: AppServerLiveEvent) => void): void {
    state.onProgress = listener;
    if (!listener) return;
    for (const entry of state.pendingLive ?? []) {
      try { listener(entry); } catch { /* Presentation must not abort a Codex turn. */ }
    }
    state.pendingLive = [];
  }

  private emitProgress(state: TurnState, entry: AppServerLiveEvent): void {
    const scoped = { ...entry, itemId: `${state.turnId}/${entry.itemId}` };
    if (state.onProgress) {
      try { state.onProgress(scoped); } catch { /* Presentation must not abort a Codex turn. */ }
    } else {
      state.pendingLive ??= [];
      if (state.pendingLive.length < 256) state.pendingLive.push(scoped);
    }
  }

  private write(message: JsonObject): void {
    const input = this.child?.stdin;
    if (!input || input.destroyed) throw new Error("Codex app-server stdin is unavailable");
    input.write(`${JSON.stringify(message)}\n`);
  }

  private failProcess(error: Error): void {
    this.modelGateway.resetCache();
    this.liveThreads.clear();
    this.threadOwners.clear();
    this.tokenUsage.clear();
    this.rejectPending(error);
    this.rejectForkCreations(error);
    this.rejectTurnWaiters(error);
  }

  /** Settle every registered turn waiter with the given error (stop() and
   * unexpected process exits). No waiter can later time out or resolve into a
   * closed store. */
  private rejectTurnWaiters(error: Error): void {
    for (const rejectNow of [...this.turnWaitersList.keys()]) rejectNow(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /**
   * 1.1.6: pin the App Server child for the duration of a round.
   *
   * The idle timer fires whenever no RPC is pending, so a gap between CREATING a
   * thread and its FIRST turn (a store write, evidence collection, a settings
   * refresh — anything longer than `idleProcessMs`) used to let the child exit.
   * The respawned process does not know that thread and answers
   * `thread not found` for the very thread the round just created, which broke
   * the first background review under production settings (default 5s window).
   * A round pins the child instead and releases the pin when it ends.
   */
  beginRound(): void {
    this.pinned += 1;
    this.clearIdleTimer();
  }

  /** Release a round pin; the idle timer is re-armed once nothing is pinned. */
  endRound(): void {
    this.pinned = Math.max(0, this.pinned - 1);
    if (this.pinned === 0) this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (this.options.idleProcessMs <= 0) return;
    this.clearIdleTimer();
    if (this.pinned > 0) return;
    if (!this.isIdle()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // RECOVERABLE shutdown: idle closes the child but NEVER latches this
      // client — the next start()/health() respawns a fresh App Server.
      if (this.pinned === 0 && this.isIdle()) void this.idleShutdown().catch(() => undefined);
    }, this.options.idleProcessMs);
    this.idleTimer.unref();
  }

  /** Recoverable idle shutdown (single-flight): gracefully closes ONLY the
   * current idle child and cleans the per-process state. Unlike the permanent
   * `stop()`, it NEVER sets the `stopped` latch and never occupies
   * `stopPromise` — the very next start()/health() respawns a fresh App
   * Server. Every concurrent caller shares the SAME in-flight promise, so a
   * racing start() waits for the old child's full exit before spawning
   * exactly one replacement. */
  private idleShutdown(): Promise<void> {
    if (this.idleStopping) return this.idleStopping;
    this.idleStopping = this.doIdleShutdown().finally(() => {
      this.idleStopping = undefined;
    });
    return this.idleStopping;
  }

  private async doIdleShutdown(): Promise<void> {
    this.clearIdleTimer();
    this.modelGateway.resetCache();
    const child = this.idleRetirement?.process ?? this.child;
    if (!child) return;
    const retirement = this.idleRetirement ?? this.processRetirement(child);
    this.idleRetirement = retirement;
    const evidence = await retirement.evidence;
    // Detach the child BEFORE closing it: its exit becomes EXPECTED, so the
    // exit handler never classifies it as an unexpected failure while an idle
    // shutdown (or a final stop() awaiting it) completes.
    if (this.child === child) this.child = undefined;
    // Completed turn state belongs to the old process session; a respawned
    // App Server has never seen those turns (mirrors final teardown).
    this.turns.clear();
    this.liveThreads.clear();
    this.threadOwners.clear();
    this.tokenUsage.clear();
    // EOF permits pending writes to flush before escalation. Permanent stop
    // settles its outstanding observers before joining this shared retirement.
    if (!retirement.closing) {
      retirement.closing = true;
      await stopProcess(child, this.options.quitGraceMs ?? 5_000, this.options.killGraceMs ?? 2_000);
    }
    if (!await stopCapturedProcessTree(evidence, this.options.killGraceMs ?? 2000)) {
      throw this.processCleanupError("Original idle App Server process tree cleanup is unconfirmed; no successor process or external handoff is permitted", evidence);
    }
    if (this.idleRetirement === retirement) this.idleRetirement = undefined;
  }

  private processRetirement(child: ChildProcess): IdleProcessRetirement {
    const original = this.processRetirements.get(child);
    if (original) return original;
    const observations: ProcessTreeCaptureObservation[] = [];
    const retirement: IdleProcessRetirement = {
      process: child, closing: false,
      evidence: (async () => {
        const processId = child.pid;
        const started = performance.now();
        const stillOwned = () => this.child === child && child.exitCode === null && child.signalCode === null;
        const finish = (captured?: Awaited<ReturnType<typeof captureProcessTreeEvidence>>) => {
          const evidence = Object.freeze({ processId, ...captured });
          this.retirementDiagnostics.set(evidence, Object.freeze([...observations]));
          return evidence;
        };
        const retired = () => {
          observations.push(Object.freeze({ processId, code: "owner_retired", elapsedMs: Math.max(0, Math.round(performance.now() - started)), limitMs: 4000 }));
          return finish();
        };
        if (!stillOwned()) return retired();
        let captured = await captureProcessTreeEvidence(processId, value => observations.push(value));
        // One unavailable observation may be retried only before retirement,
        // while this same native child still belongs to the original SDK.
        if (!captured && stillOwned()) captured = await captureProcessTreeEvidence(processId, value => observations.push(value));
        if (!stillOwned()) return retired();
        return finish(captured);
      })(),
    };
    this.processRetirements.set(child, retirement);
    return retirement;
  }

  private processCleanupError(message: string, evidence: ProcessTreeEvidence): Error {
    const observations = this.retirementDiagnostics.get(evidence) ?? Object.freeze([]);
    const summary = observations.map(value => `${value.code}@${value.elapsedMs}ms`).join(",");
    const error = new Error(message + (summary ? ` [census: ${summary}]` : ""));
    Object.defineProperty(error, "cleanupDiagnostics", { value: observations, enumerable: true });
    return error;
  }

  private cleanupLostProcesses(): Promise<void> {
    if (this.lostProcessCleanup) return this.lostProcessCleanup;
    const task = (async () => {
      for (const lost of this.lostProcesses) {
        await lost.diagnostic;
        const captured = await lost.original;
        const original = lost.evidence ?? captured;
        const observations: ProcessTreeObservation[] = [];
        const refreshed = await refreshOriginalProcessTreeEvidence(original, { onObservation: value => observations.push(value) });
        this.retirementDiagnostics.set(refreshed ?? original, Object.freeze([...lost.startupObservations(), ...observations]));
        if (!refreshed) throw this.processCleanupError("Original lost App Server process tree cleanup is unconfirmed; no successor process is permitted", original);
        lost.evidence = refreshed;
        if (!await stopCapturedProcessTree(refreshed, this.options.killGraceMs ?? 2000)) {
          throw this.processCleanupError("Original lost App Server process tree cleanup is unconfirmed; no successor process is permitted", refreshed);
        }
        this.lostProcesses.delete(lost);
      }
    })();
    this.lostProcessCleanup = task;
    void task.finally(() => { if (this.lostProcessCleanup === task) this.lostProcessCleanup = undefined; }).catch(() => undefined);
    return task;
  }

  private isIdle(): boolean {
    if (!this.child || this.child.exitCode !== null) return false;
    if (this.transportFailures.has(this.child)) return false;
    if (this.initialization && !this.initialization.settled) return false;
    if (this.pending.size > 0 || this.turnWaiters > 0) return false;
    if ([...this.forkCreations].some((creation) => creation.process === this.child && !creation.claimed)) return false;
    if ([...this.forkReleases].some((release) => !release.released)) return false;
    if ([...this.retainedStartOperations].some((receipt) => !this.receiptFinished(receipt))) return false;
    return ![...this.turns.values()].some((turn) => !turn.completed);
  }
}

function liveToolLabel(item: JsonObject): string | undefined {
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command.trim() : "";
    // Preserve quoted Windows paths and arguments so the sidebar does not
    // turn `"C:\\Program Files\\..."` into the misleading `"C:\\Program`.
    return `命令 · ${command ? command.slice(0, 8 * 1024) : "运行中"}`;
  }
  if (item.type === "mcpToolCall") {
    return `工具 · ${typeof item.server === "string" ? `${item.server}/` : ""}${typeof item.tool === "string" ? item.tool : "运行中"}`;
  }
  if (item.type === "dynamicToolCall") {
    return `工具 · ${typeof item.tool === "string" ? item.tool : "运行中"}`;
  }
  return undefined;
}

function liveToolDetails(item: JsonObject): Pick<AppServerLiveEvent, "command" | "cwd" | "exitCode" | "status" | "files"> {
  const command = typeof item.command === "string" ? item.command.slice(0, 16 * 1024) : undefined;
  const cwd = typeof item.cwd === "string" ? item.cwd.slice(0, 4096) : undefined;
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
  const status = typeof item.status === "string" ? item.status.slice(0, 128) : undefined;
  const rawChanges = Array.isArray(item.changes) ? item.changes : Array.isArray(item.files) ? item.files : [];
  const files = rawChanges.flatMap((entry) => {
    if (typeof entry === "string") return [entry.slice(0, 4096)];
    const value = object(entry);
    return typeof value.path === "string" ? [value.path.slice(0, 4096)] : [];
  }).slice(0, 256);
  return {
    ...(command ? { command } : {}), ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}), ...(status ? { status } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

function turnResult(state: TurnState): TurnWaitResult | undefined {
  if (state.input) {
    return {
      kind: "needs_input",
      threadId: state.threadId,
      turnId: state.turnId,
      request: {
        requestId: state.input.requestId,
        threadId: state.threadId,
        turnId: state.turnId,
        itemId: state.input.itemId,
        questions: state.input.questions,
      },
    };
  }
  if (!state.completed) return undefined;
  const status = state.completed.status;
  const normalized = status === "completed" || status === "interrupted" || status === "failed" ? status : "failed";
  const error = state.completed.error ? JSON.stringify(state.completed.error) : undefined;
  // Only a SUCCESSFUL `turn/completed` for this exact turn yields a verdict
  // candidate. Interrupted/failed/cancelled turns must never produce one, and
  // every agent message streamed before completion is provisional. With
  // multiple final agent messages on a completed turn the LAST assistant
  // output wins, so a "provisional pass then changes_requested" sequence can
  // never be applied early.
  const completedItems = Array.isArray(state.completed.items)
    ? state.completed.items.map(object)
    : [];
  const candidates = completedItems.length > 0 ? completedItems : [...state.items];
  // The FINAL visible output item of the turn: Plan-mode planner turns persist
  // their plan as an item with `type: "plan"` (streamed as item/plan/delta,
  // stored verbatim by thread/read), normal turns use `agentMessage`, review
  // turns may end on `exitedReviewMode`. The LAST such item wins, so a
  // "provisional pass then changes_requested" sequence can never be applied
  // early, and the winner's type is reported for contract-level assertions.
  const finalCandidates = candidates.filter(
    (item) => item.type === "agentMessage" || item.type === "plan" || item.type === "exitedReviewMode",
  );
  const finalItem = finalCandidates.at(-1);
  const text = normalized === "completed"
    ? (finalItem
      ? (typeof finalItem.text === "string" ? finalItem.text : typeof finalItem.review === "string" ? finalItem.review : "")
      : "")
    : "";
  return {
    kind: "completed",
    threadId: state.threadId,
    turnId: state.turnId,
    status: normalized,
    text,
    ...(normalized === "completed" && finalItem && typeof finalItem.type === "string"
      ? { itemType: finalItem.type }
      : {}),
    ...(normalized !== "completed" ? { reason: normalized === "interrupted" ? "interrupted" : "turn failed" } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeQuestion(value: unknown): PlannerQuestion {
  const question = object(value);
  const options = Array.isArray(question.options)
    ? question.options.map((item) => {
        const option = object(item);
        return {
          label: protocolString(option.label, "question option label"),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        };
      })
    : undefined;
  return {
    id: protocolString(question.id, "question id"),
    header: typeof question.header === "string" ? question.header : "Codex question",
    question: protocolString(question.question, "question text"),
    ...(options ? { options } : {}),
    allowOther: question.isOther === true,
    secret: question.isSecret === true,
  };
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`invalid ${label}`);
  return value;
}

function protocolString(value: unknown, label: string): string {
  try { return string(value, label); }
  catch (error) { throw new CodexProtocolError(error instanceof Error ? error : new Error(errorMessage(error))); }
}

function jsonRpcError(value: unknown): string {
  const error = object(value);
  return typeof error.message === "string" ? error.message : JSON.stringify(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

/** Wait for a child to exit or until the timeout, whichever comes first. */

import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { CodexInvalidThreadError } from "./codex-callback.js";
import {
  CONVERSION_DEVELOPER_INSTRUCTIONS,
  SILENT_REVIEW_DEVELOPER_INSTRUCTIONS,
} from "./review-contract.js";
import type {
  PersistedTurnBaseline,
  PlannerQuestion,
  ReasoningEffort,
  TurnNeedsInputResult,
  TurnWaitResult,
} from "./types.js";
import { PLUGIN_VERSION } from "./version.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
}

interface PendingInput {
  requestId: string | number;
  itemId: string;
  questions: PlannerQuestion[];
}

interface TurnState {
  threadId: string;
  turnId: string;
  items: JsonObject[];
  completed?: JsonObject;
  input?: PendingInput;
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
  name: string;
}

export interface StartTurnOptions {
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
}

export interface ReviewerStartOptions {
  cwd: string;
  name: string;
  model?: string;
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
  /** The persistent source thread whose EPHEMERAL fork hosts the conversion. */
  threadId: string;
  cwd: string;
  prompt: string;
  model?: string;
  outputSchema: JsonObject;
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
}

export interface ReviewStartOptions {
  threadId: string;
  cwd: string;
  target: JsonObject;
  detached: boolean;
  /** Called as soon as the reviewer thread and turn are known (and the thread
   * settings are applied), before waiting for the turn to finish. Lets the
   * caller persist the reviewer ids so cancellation can interrupt the run. */
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
}

/** A single entry of `model/list` trimmed to the fields the plugin uses to pick
 * the default Reviewer model. */
interface ModelSelection {
  id: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort?: string;
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
  private readonly turns = new Map<string, TurnState>();
  /** Registered turn-waiter rejection callbacks so `stop()` (and an unexpected
   * process exit) can settle every in-flight waitForTurn immediately instead
   * of leaving them to time out against a closed process/store. */
  private readonly turnWaitersList = new Set<(error: Error) => void>();
  private child?: ChildProcess;
  private starting?: Promise<void>;
  /** Teardown latch: once `stop()` has begun, no new `start()`/request may
   * spawn the App Server again. Set synchronously at the START of the first
   * stop() call so a turn-waiter settle racing teardown can never trigger a
   * best-effort interrupt through a FRESH child. */
  private stopped = false;
  /** Single-flight teardown: every concurrent/repeated stop() call awaits the
   * SAME settled promise, so "stop() returns" always means the teardown
   * (including the old child's exit) is truly complete. */
  private stopPromise?: Promise<void>;
  /** Single-flight RECOVERABLE idle shutdown: closes ONLY the current idle
   * child without latching this client — a later start()/health() respawns a
   * fresh App Server. Distinct from `stopPromise`: the permanent teardown
   * latch is NEVER armed by an idle shutdown, and `start()`/`stop()` wait for
   * an in-flight idle shutdown before spawning or tearing down. */
  private idleStopping?: Promise<void>;
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;
  private turnWaiters = 0;
  private cachedDefault?: { id: string; defaultReasoningEffort?: string };
  private stderr = "";

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(signal?: AbortSignal): Promise<void> {
    // Permanent-teardown fence: after stop() has begun this client must NEVER
    // spawn the App Server again — a best-effort interrupt (e.g. a turn-waiter
    // settle racing stop) or a late caller must fail loudly instead of
    // restarting.
    if (this.stopped) throw new Error("Codex app-server stopped");
    // An IDLE shutdown is RECOVERABLE but the old child is already detaching:
    // a racing spawn would write into a dying pipe, so WAIT for the old
    // child's exit to complete before deciding. The await is also a yield
    // point where a final stop() may latch — re-check the fence afterwards.
    if (this.idleStopping) await this.idleStopping;
    if (this.stopped) throw new Error("Codex app-server stopped");
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess(signal).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
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
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    const task = this.doStop();
    this.stopPromise = task;
    return task;
  }

  private async doStop(): Promise<void> {
    this.clearIdleTimer();
    // A RECOVERABLE idle shutdown may be closing the current child right now:
    // the permanent teardown must WAIT for that close to complete (the idle
    // path already detached the child, so no double-close happens) and then
    // finish the permanent teardown itself. No new child can be spawned in
    // the meantime: `stopped` latched synchronously when stop() began.
    if (this.idleStopping) await this.idleStopping;
    const child = this.child;
    this.child = undefined;
    this.turns.clear();
    // Every pending RPC and every active turn waiter must settle NOW: after
    // stop() returns, a late waitForTurn/request resolution could race the
    // closed stores. (The manager interrupts and awaits foreground turns
    // before stopping; this is the defensive fence for anything left.)
    this.rejectPending(new Error("Codex app-server stopped"));
    this.rejectTurnWaiters(new Error("Codex app-server stopped"));
    if (!child || child.exitCode !== null) return;
    // GRACEFUL shutdown: EOF on stdin gives the app-server the chance to flush
    // its final rollout write and exit on its own before we escalate. This is
    // defensive lifecycle hardening — an abrupt TerminateProcess
    // (child.kill on Windows) could in principle race an in-flight write at
    // shutdown, but the root cause has NOT been isolated (in the real compare
    // experiment, both the kill sequence and the EOF sequence read the completed
    // turn back with its final message intact). Where the client is idle there
    // is no active turn/request; for teardown the dispatcher interrupts active
    // turns first, so EOF is never sent to abort a live review.
    try { child.stdin?.end(); } catch {
      // stdin may already be closed by the child side.
    }
    if (child.exitCode !== null) return;
    await waitExitOr(child, this.options.quitGraceMs ?? 5_000);
    if (child.exitCode !== null) return;
    child.kill();
    await waitExitOr(child, this.options.killGraceMs ?? 2_000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async health(signal?: AbortSignal): Promise<{ modelCount: number }> {
    await this.start(signal);
    const response = await this.request<JsonObject>("model/list", {}, signal);
    const models = Array.isArray(response.data) ? response.data.length : 0;
    return { modelCount: models };
  }

  async startThread(options: StartThreadOptions, signal?: AbortSignal): Promise<string> {
    const params: JsonObject = {
      cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "dsh-codex-workflow",
      sessionStartSource: "startup",
      ephemeral: false,
    };
    if (options.model) params.model = options.model;
    const response = await this.request<JsonObject>("thread/start", params, signal);
    const thread = object(response.thread);
    const threadId = string(thread.id, "thread/start result.thread.id");
    await this.request("thread/name/set", { threadId, name: options.name }, signal);
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

  async resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void> {
    await this.request("thread/resume", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: true,
    }, signal);
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
  async startReviewerThread(options: ReviewerStartOptions, signal?: AbortSignal): Promise<string> {
    const params: JsonObject = {
      cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "dsh-codex-workflow",
      sessionStartSource: "startup",
      ephemeral: false,
    };
    if (options.model) params.model = options.model;
    const response = await this.request<JsonObject>("thread/start", params, signal);
    const thread = object(response.thread);
    const threadId = string(thread.id, "thread/start result.thread.id");
    try {
      await this.request("thread/settings/update", {
        threadId,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      }, signal);
      await this.request("thread/name/set", { threadId, name: options.name }, signal);
    } catch (error) {
      // Best-effort release of the orphaned subscription; never mask the
      // original setup failure. No signal is passed so an aborted caller still
      // gets the cleanup issued.
      await this.request("thread/unsubscribe", { threadId }).catch(() => undefined);
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
      const mode = await this.silentReviewMode(options.model, options.effort, signal);
      if (mode) params.collaborationMode = mode;
    } else if (options.conversion) {
      const mode = await this.conversionMode(options.model, options.effort, signal);
      if (mode) params.collaborationMode = mode;
    } else if (options.planMode) {
      const mode = await this.planMode(options.model, options.effort, signal);
      if (mode) params.collaborationMode = mode;
    }
    // Report the effective model so callers can persist it and reuse it for
    // later turns (continuation, restart, ephemeral conversion fork).
    const collaborationMode = params.collaborationMode as { settings?: { model?: unknown } } | undefined;
    const modeSettings = collaborationMode && typeof collaborationMode === "object" ? collaborationMode.settings : undefined;
    const settingsModel = modeSettings && typeof modeSettings.model === "string" ? modeSettings.model : undefined;
    const effectiveModel = options.model ?? settingsModel;
    if (effectiveModel && options.onModel) options.onModel(effectiveModel);
    const response = await this.request<JsonObject>("turn/start", params, signal);
    const turnId = string(object(response.turn).id, "turn/start result.turn.id");
    this.state(threadId, turnId);
    if (options.onStarted) {
      try {
        await options.onStarted({ threadId, turnId });
      } catch (error) {
        // The turn is genuinely running by now; never leave it unmanaged when
        // the caller's registration callback fails.
        await this.abandonTurn(threadId, turnId);
        throw error;
      }
    }
    return this.waitForTurn(threadId, turnId, signal);
  }

  async continueTurn(
    pending: TurnNeedsInputResult,
    answers: Record<string, string[]>,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult> {
    await this.start(signal);
    this.write({
      id: pending.request.requestId,
      result: {
        answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])),
      },
    });
    const state = this.state(pending.threadId, pending.turnId);
    state.input = undefined;
    return this.waitForTurn(pending.threadId, pending.turnId, signal);
  }

  async startReview(options: ReviewStartOptions, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }> {
    const response = await this.request<JsonObject>("review/start", {
      threadId: options.threadId,
      delivery: options.detached ? "detached" : "inline",
      target: options.target,
    }, signal);
    const reviewThreadId = string(response.reviewThreadId, "review/start result.reviewThreadId");
    const turnId = string(object(response.turn).id, "review/start result.turn.id");
    this.state(reviewThreadId, turnId);
    try {
      // Detached reviews otherwise inherit the app-server process cwd in Codex Desktop.
      await this.request("thread/settings/update", {
        threadId: reviewThreadId,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }, signal);
      if (options.onStarted) await options.onStarted({ threadId: reviewThreadId, turnId });
    } catch (error) {
      // The reviewer turn is genuinely running; a failed settings update or
      // registration callback must not leave it unmanaged.
      await this.abandonTurn(reviewThreadId, turnId);
      throw error;
    }
    return { threadId: reviewThreadId, result: await this.waitForTurn(reviewThreadId, turnId, signal) };
  }

  async interrupt(threadId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, signal);
  }

  /** Tell the App Server this client no longer needs updates for a Reviewer
   * thread, releasing the plugin's hold so Codex Desktop can edit it again.
   * Idempotent and never deletes or archives the thread — the persisted
   * Reviewer stays visible and a later review resumes the same thread.
   *
   * The server answers one of three statuses: `unsubscribed` (we were the
   * subscribed writer and released it), `notSubscribed` (the thread is loaded
   * but we were not its writer), or `notLoaded` (the thread is not currently
   * loaded by the App Server, so there is no writer hold to release). All three
   * are success outcomes for us. */
  async unsubscribeThread(threadId: string, signal?: AbortSignal): Promise<"unsubscribed" | "notSubscribed" | "notLoaded"> {
    // Never respawn a stopped App Server just to release a subscription: if
    // the child is gone there is nothing loaded to unsubscribe from.
    if (!this.child || this.child.exitCode !== null) return "notLoaded";
    const response = await this.request<JsonObject>("thread/unsubscribe", { threadId }, signal);
    const status = response.status;
    if (status === "unsubscribed" || status === "notSubscribed" || status === "notLoaded") return status;
    // Any other shape: the server accepted the release request; treat it as
    // released rather than failing the cleanup.
    return "unsubscribed";
  }

  /** Release a visible task before an external CLI resumes it. When the
   * client is already idle, wait for the recoverable child shutdown so its
   * thread-store writer is fully gone before the CLI starts. */
  async releaseThreadForExternal(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.unsubscribeThread(threadId, signal).catch(() => undefined);
    if (this.idleStopping) await this.idleStopping.catch(() => undefined);
    // A completed Planner/review may still leave the App Server child alive
    // for a short window after unsubscribe. Force the recoverable idle path so
    // the process-held thread-store writer is definitely gone before CLI
    // resume; the next Planner operation will transparently respawn it.
    await this.idleShutdown().catch(() => undefined);
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
   * Every ending path — success, turn failure, cancellation (abort), timeout —
   * finally unsubscribes the fork exactly once (idempotent: `unsubscribed`,
   * `notSubscribed` and `notLoaded` are all success outcomes), so an ephemeral
   * fork is never left loaded or holding a writer hold. The fork's id is
   * transient: callers must never persist it into
   * `plannerThreadId`/`reviewerThreadId`.
   */
  async normalizeInFork(
    options: ForkConversionOptions,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult> {
    const forkThreadId = await this.forkThread(options.threadId, options.cwd, signal);
    try {
      return await this.startTurn(forkThreadId, {
        prompt: options.prompt,
        ...(options.model ? { model: options.model } : {}),
        effort: "low",
        outputSchema: options.outputSchema,
        conversion: true,
        onStarted: options.onStarted,
      }, signal);
    } finally {
      // All endings: success, failure, cancel, timeout — release the fork.
      for (const key of [...this.turns.keys()]) {
        if (key.startsWith(`${forkThreadId}:`)) this.turns.delete(key);
      }
      await this.unsubscribeThread(forkThreadId).catch(() => undefined);
    }
  }

  /** Fork an existing thread with `ephemeral: true` (Codex's `thread/fork`).
   * The fork is exclusively ours and subscribed; it must be unsubscribed by
   * the caller (or by `normalizeInFork`'s finally) so it is not left loaded. */
  async forkThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request<JsonObject>("thread/fork", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      ephemeral: true,
    }, signal);
    const thread = object(response.thread);
    return string(thread.id, "thread/fork result.thread.id");
  }

  private async startProcess(signal?: AbortSignal): Promise<void> {
    this.stderr = "";
    const child = crossSpawn(this.options.command, this.options.args ?? ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.options.env ?? process.env,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.onLine(line));
    child.stderr!.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384);
    });
    child.once("error", (error) => this.failProcess(error));
    child.once("exit", (code, reason) => {
      const unexpected = this.child === child;
      if (unexpected) this.child = undefined;
      if (unexpected) this.failProcess(new Error(`codex app-server exited ${code ?? "unknown"} (${reason ?? "no signal"}): ${this.stderr.trim()}`));
    });
    const initialized = await this.requestRaw<JsonObject>("initialize", {
      clientInfo: { name: "dsh-codex-workflow", title: "DSH Codex Workflow", version: PLUGIN_VERSION },
      capabilities: { experimentalApi: true },
    }, signal);
    if (typeof initialized.userAgent !== "string") throw new Error("invalid Codex initialize response");
    this.write({ method: "initialized", params: {} });
    this.scheduleIdle();
  }

  private async planMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    const response = await this.request<JsonObject>("collaborationMode/list", {}, signal);
    const data = Array.isArray(response.data) ? response.data : [];
    const plan = data.map(object).find((entry) => entry.mode === "plan");
    // The Plan mode's own model wins when no explicit model is given; only
    // when the mode declares none do we pin the server's default model, so
    // plan turns ALWAYS run with a concrete, reportable model (onModel) that
    // the ephemeral conversion fork can reuse.
    let selectedModel = model || (typeof plan?.model === "string" ? plan.model : "");
    if (!selectedModel) selectedModel = (await this.defaultModel(signal))?.id ?? "";
    if (!selectedModel) return undefined;
    return {
      mode: "plan",
      settings: {
        model: selectedModel,
        reasoning_effort: effort ?? (typeof plan?.reasoning_effort === "string" ? plan.reasoning_effort : null),
        developer_instructions: null,
      },
    };
  }

  /** Pin a Reviewer turn to the non-collaborative "default" collaboration mode
   * and inject the silent single-message review developer instructions at the
   * protocol level. The mode's `settings` require a concrete model id: the
   * configured reviewer model when present, otherwise the app-server's default
   * model. When no explicit effort is configured, the selected model's own
   * `defaultReasoningEffort` (as reported by `model/list`) is used. */
  private async silentReviewMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.defaultModeWithInstructions(model, effort, signal, SILENT_REVIEW_DEVELOPER_INSTRUCTIONS);
  }

  /** Conversion-turn mode for ephemeral forks: non-collaborative "default"
   * mode with the JSON-only conversion developer instructions, so the fork
   * emits exactly one schema-conforming JSON object. Uses the source task's
   * model when provided, otherwise the server's default model. */
  private async conversionMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.defaultModeWithInstructions(model, effort, signal, CONVERSION_DEVELOPER_INSTRUCTIONS);
  }

  private async defaultModeWithInstructions(
    model?: string,
    effort?: ReasoningEffort,
    signal?: AbortSignal,
    instructions?: string,
  ): Promise<JsonObject | undefined> {
    let selected: { id: string; defaultReasoningEffort?: string } | undefined;
    if (model) {
      selected = await this.modelSelection(model, signal);
    } else {
      selected = await this.defaultModel(signal);
    }
    if (!selected) return undefined;
    return {
      mode: "default",
      settings: {
        model: selected.id,
        reasoning_effort: effort ?? selected.defaultReasoningEffort ?? null,
        developer_instructions: instructions ?? null,
      },
    };
  }

  private cachedModels?: ModelSelection[];

  /** Parse `model/list` into a stable selection list (cached for the life of
   * the client; the set of models does not change mid-run). */
  private async modelSelections(signal?: AbortSignal): Promise<ModelSelection[]> {
    if (this.cachedModels) return this.cachedModels;
    const response = await this.request<JsonObject>("model/list", {}, signal);
    const data = Array.isArray(response.data) ? response.data : [];
    const parsed: ModelSelection[] = [];
    for (const entry of data) {
      const value = object(entry);
      const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
      if (!id) continue;
      const defaultReasoningEffort = typeof value.defaultReasoningEffort === "string" && value.defaultReasoningEffort.length > 0
        ? value.defaultReasoningEffort
        : undefined;
      parsed.push({
        id,
        isDefault: value.isDefault === true,
        hidden: value.hidden === true,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      });
    }
    this.cachedModels = parsed;
    return parsed;
  }

  /** Select a model entry by exact id (for a configured reviewer model that is
   * present in `model/list`); models absent from the list still resolve with
   * their id and no server-provided default effort. */
  private async modelSelection(id: string, signal?: AbortSignal): Promise<{ id: string; defaultReasoningEffort?: string } | undefined> {
    const models = await this.modelSelections(signal);
    const match = models.find((entry) => entry.id === id);
    return match
      ? { id: match.id, ...(match.defaultReasoningEffort ? { defaultReasoningEffort: match.defaultReasoningEffort } : {}) }
      : { id };
  }

  /** The app-server's default model: the entry marked `isDefault === true`.
   * Only when the server presents no explicit default do we fall back, and then
   * deterministically — first non-hidden model, then the first model — so the
   * Reviewer never silently picks an arbitrary list-first entry. The selection
   * (and its `defaultReasoningEffort`) is cached. */
  private async defaultModel(signal?: AbortSignal): Promise<{ id: string; defaultReasoningEffort?: string } | undefined> {
    if (this.cachedDefault) return this.cachedDefault;
    const models = await this.modelSelections(signal);
    const pick = models.find((entry) => entry.isDefault)
      ?? models.find((entry) => !entry.hidden)
      ?? models[0];
    if (!pick) return undefined;
    this.cachedDefault = { id: pick.id, ...(pick.defaultReasoningEffort ? { defaultReasoningEffort: pick.defaultReasoningEffort } : {}) };
    return this.cachedDefault;
  }

  /** Public view of the server's default model selection (isDefault entry,
   * deterministic first-non-hidden fallback, else the first entry). Cached.
   * Used by callers that must pass the SAME explicit model into visible turns
   * and their ephemeral conversion forks when no model is configured. */
  async resolveDefaultModel(signal?: AbortSignal): Promise<string | undefined> {
    const selected = await this.defaultModel(signal);
    return selected?.id;
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

  private async request<T = JsonObject>(method: string, params: JsonObject, signal?: AbortSignal): Promise<T> {
    await this.start(signal);
    return this.requestRaw<T>(method, params, signal);
  }

  private requestRaw<T>(method: string, params: JsonObject, signal?: AbortSignal): Promise<T> {
    this.clearIdleTimer();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        this.scheduleIdle();
        return;
      }
      // Control RPCs are bounded by the (tighter) rpc timeout; the long turn
      // WAIT keeps the full requestTimeoutMs in waitForTurn.
      const rpcTimeoutMs = this.options.rpcTimeoutMs ?? Math.max(5_000, Math.min(this.options.requestTimeoutMs, 60_000));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
        this.scheduleIdle();
      }, rpcTimeoutMs);
      const entry: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      if (signal) {
        entry.abort = () => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(abortError(signal));
          this.scheduleIdle();
        };
        signal.addEventListener("abort", entry.abort, { once: true });
        entry.signal = signal;
      }
      this.pending.set(id, entry);
      this.write({ id, method, params });
    });
  }

  private waitForTurn(threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnWaitResult> {
    const key = turnKey(threadId, turnId);
    const current = this.turns.get(key);
    const ready = current && turnResult(current);
    if (ready) {
      this.scheduleIdle();
      return Promise.resolve(ready);
    }
    this.clearIdleTimer();
    this.turnWaiters += 1;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        // The turn may have started while the abort raced with the hand-off
        // from turn/start to this waiter. It still needs an explicit interrupt.
        void this.abandonTurn(threadId, turnId);
        this.turnWaiters -= 1;
        this.scheduleIdle();
        reject(abortError(signal));
        return;
      }
      let cleaned = false;
      const rejectNow = (error: Error) => {
        if (cleaned) return;
        void this.abandonTurn(threadId, turnId);
        cleanup();
        reject(error);
      };
      this.turnWaitersList.add(rejectNow);
      const timeout = setTimeout(() => {
        rejectNow(new Error(`Codex turn timed out: ${turnId}`));
      }, this.options.requestTimeoutMs);
      const event = `turn:${key}`;
      const listener = () => {
        const state = this.turns.get(key);
        const result = state && turnResult(state);
        if (!result) return;
        cleanup();
        resolve(result);
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

  private async interruptBestEffort(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch {
      // Never mask the original failure with an interrupt failure.
    }
  }

  private async abandonTurn(threadId: string, turnId: string): Promise<void> {
    await this.interruptBestEffort(threadId, turnId);
    this.turns.delete(turnKey(threadId, turnId));
    this.scheduleIdle();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = object(JSON.parse(line));
    } catch {
      return;
    }
    if ("id" in message && !("method" in message)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
      if (message.error) pending.reject(new Error(jsonRpcError(message.error)));
      else pending.resolve(message.result);
      this.scheduleIdle();
      return;
    }
    if (typeof message.method !== "string") return;
    if ("id" in message) {
      this.onServerRequest(message);
      return;
    }
    this.onNotification(message.method, object(message.params));
  }

  private onNotification(method: string, params: JsonObject): void {
    if (method === "item/completed") {
      const threadId = string(params.threadId, "item/completed threadId");
      const turnId = string(params.turnId, "item/completed turnId");
      this.state(threadId, turnId).items.push(object(params.item));
      return;
    }
    if (method === "turn/completed") {
      const threadId = string(params.threadId, "turn/completed threadId");
      const turn = object(params.turn);
      const turnId = string(turn.id, "turn/completed turn.id");
      this.state(threadId, turnId).completed = turn;
      this.events.emit(`turn:${turnKey(threadId, turnId)}`);
      this.scheduleIdle();
    }
  }

  private onServerRequest(message: JsonObject): void {
    const method = string(message.method, "server request method");
    const id = message.id as string | number;
    const params = object(message.params);
    if (method === "item/tool/requestUserInput") {
      const threadId = string(params.threadId, "requestUserInput threadId");
      const turnId = string(params.turnId, "requestUserInput turnId");
      const questions = Array.isArray(params.questions) ? params.questions.map(normalizeQuestion) : [];
      this.state(threadId, turnId).input = {
        requestId: id,
        itemId: string(params.itemId, "requestUserInput itemId"),
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

  private write(message: JsonObject): void {
    const input = this.child?.stdin;
    if (!input || input.destroyed) throw new Error("Codex app-server stdin is unavailable");
    input.write(`${JSON.stringify(message)}\n`);
  }

  private failProcess(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.rejectTurnWaiters(error);
  }

  /** Settle every registered turn waiter with the given error (stop() and
   * unexpected process exits). No waiter can later time out or resolve into a
   * closed store. */
  private rejectTurnWaiters(error: Error): void {
    for (const rejectNow of [...this.turnWaitersList]) rejectNow(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdle(): void {
    if (this.options.idleProcessMs <= 0) return;
    this.clearIdleTimer();
    if (!this.isIdle()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // RECOVERABLE shutdown: idle closes the child but NEVER latches this
      // client — the next start()/health() respawns a fresh App Server.
      if (this.isIdle()) void this.idleShutdown();
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
    const child = this.child;
    // Detach the child BEFORE closing it: its exit becomes EXPECTED, so the
    // exit handler never classifies it as an unexpected failure while an idle
    // shutdown (or a final stop() awaiting it) completes.
    if (this.child === child) this.child = undefined;
    // Completed turn state belongs to the old process session; a respawned
    // App Server has never seen those turns (mirrors final teardown).
    this.turns.clear();
    if (!child || child.exitCode !== null) return;
    // GRACEFUL shutdown: EOF on stdin gives the app-server the chance to flush
    // and exit before we escalate. The client is idle by construction (no
    // pending RPC, no active turn waiter), so EOF is never sent to abort a
    // live review.
    try { child.stdin?.end(); } catch {
      // stdin may already be closed by the child side.
    }
    if (child.exitCode !== null) return;
    await waitExitOr(child, this.options.quitGraceMs ?? 5_000);
    if (child.exitCode !== null) return;
    child.kill();
    await waitExitOr(child, this.options.killGraceMs ?? 2_000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private isIdle(): boolean {
    if (!this.child || this.child.exitCode !== null) return false;
    if (this.pending.size > 0 || this.turnWaiters > 0) return false;
    return ![...this.turns.values()].some((turn) => !turn.completed);
  }
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
          label: string(option.label, "question option label"),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        };
      })
    : undefined;
  return {
    id: string(question.id, "question id"),
    header: typeof question.header === "string" ? question.header : "Codex question",
    question: string(question.question, "question text"),
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
function waitExitOr(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

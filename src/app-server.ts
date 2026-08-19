import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { CodexInvalidThreadError } from "./codex-callback.js";
import type {
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
  idleProcessMs: number;
  env?: NodeJS.ProcessEnv;
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
  /** Called as soon as turn/start has returned the turn id, before waiting
   * for the turn to finish, so callers can persist the active turn for
   * cancellation while it is still running. */
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
}

export interface ReviewerStartOptions {
  cwd: string;
  name: string;
  model?: string;
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

export class CodexAppServerClient {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, TurnState>();
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;
  private turnWaiters = 0;
  private stderr = "";

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess(signal).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    this.child = undefined;
    this.turns.clear();
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
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

  /** Read-only validation of the source task before a Reviewer is created.
   * `thread/read` with `includeTurns: false` confirms the source exists without
   * resuming it and without touching its writer, so Codex Desktop may keep the
   * source open (or be its active writer) without making the validation busy.
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

  /** Create a fresh, durable, independently owned Reviewer thread that carries
   * none of the source task's history or writer state. Read-only, network
   * disabled and approval-free are enforced at thread level here and again per
   * review turn by `startTurn`. */
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
    await this.request("thread/settings/update", {
      threadId,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    }, signal);
    await this.request("thread/name/set", { threadId, name: options.name }, signal);
    return threadId;
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
    if (options.planMode) {
      const mode = await this.planMode(options.model, options.effort, signal);
      if (mode) params.collaborationMode = mode;
    }
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
    const selectedModel = model || (typeof plan?.model === "string" ? plan.model : "");
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
        this.scheduleIdle();
      }, this.options.requestTimeoutMs);
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
      const timeout = setTimeout(() => {
        void this.abandonTurn(threadId, turnId);
        cleanup();
        reject(new Error(`Codex turn timed out: ${turnId}`));
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
        void this.abandonTurn(threadId, turnId);
        cleanup();
        reject(abortError(signal!));
      };
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timeout);
        this.events.off(event, listener);
        signal?.removeEventListener("abort", onAbort);
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
      if (this.isIdle()) void this.stop();
    }, this.options.idleProcessMs);
    this.idleTimer.unref();
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
  const items = [...state.items, ...(Array.isArray(state.completed.items) ? state.completed.items.map(object) : [])];
  const text = items
    .filter((item) => item.type === "agentMessage" || item.type === "plan" || item.type === "exitedReviewMode")
    .map((item) => typeof item.text === "string" ? item.text : typeof item.review === "string" ? item.review : "")
    .filter(Boolean)
    .at(-1) ?? "";
  const error = state.completed.error ? JSON.stringify(state.completed.error) : undefined;
  return {
    kind: "completed",
    threadId: state.threadId,
    turnId: state.turnId,
    status: normalized,
    text,
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

import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseReviewResult } from "./bridge-protocol.js";
import { parseAlignment } from "./review-authority.js";
import { isChineseText, reviewDisplayError, reviewRewritePrompt } from "./review-contract.js";
import type { AlignmentOutcome, ReasoningEffort, ReviewResult } from "./types.js";
import type { CodexCallbackRequest, CodexCallbackResult } from "./codex-callback.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "./codex-callback.js";
import { backoffDelayMs, compactDiagnostic, DEFAULT_BACKOFF, isRecoverableModelFailure, isTerminalModelFailure, normalizeBackoff, retryClockNow, transientReason, type BackoffPolicy } from "./transient-retry.js";

export interface CodexCliAuditOptions {
  command: string;
  reviewSchemaFile: string;
  alignmentSchemaFile: string;
  timeoutMs: number;
  /** Per-stream UTF-8 byte retention bound. Stdout overflow rejects the run;
   * stderr retains only its newest complete code points. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** Read-only observability seam for tests and lifecycle acceptance. */
  onSpawn?: (args: string[]) => void;
  killGraceMs?: number;
  killKillGraceMs?: number;
  retryBaseMs?: number;
  /** 1.1.1 shared transient-retry policy (classification + bounded exponential
   * backoff). `retryBaseMs` is honoured as a legacy alias for `baseMs`. */
  retry?: Partial<BackoffPolicy>;
  /** Injectable seams (tests assert the backoff sequence without real waits). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export type NewCliReviewRequest = Omit<CodexCallbackRequest, "codexThreadId" | "reviewerThreadId" | "onThread"> & {
  onThread: (threadId: string) => Promise<void> | void;
};

export interface CodexCliAuditGateway {
  createReview(request: NewCliReviewRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }>;
  review(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }>;
  normalize(input: { visibleText: string; cwd: string; workflowId: string; submissionId?: string; model?: string }, signal?: AbortSignal): Promise<ReviewResult>;
  align(input: { result: ReviewResult; task: string; planMarkdown?: string; previousReview?: ReviewResult; fixSummary?: string; cwd: string; workflowId: string; submissionId?: string; model?: string; prompt: string }, signal?: AbortSignal): Promise<AlignmentOutcome>;
  reconcile(request: CodexCallbackRequest, signal?: AbortSignal, recovery?: CliReconciliationRecovery): Promise<{ visibleText: string; verdict: ReviewResult }>;
  cancel(workflowId: string): void;
  cancelSubmission(workflowId: string, submissionId: string): void;
  stop(): Promise<void>;
}

export interface CliReconciliationRecovery {
  visibleText?: string;
  captureVisibleText(text: string): Promise<void> | void;
}

interface CliProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stderrUnavailable?: boolean;
}

export class CodexCliAuditDispatcher implements CodexCliAuditGateway {
  private readonly children = new Map<number, {
    child: ChildProcess;
    workflowId: string;
    submissionId?: string;
    threadId?: string;
    done: Promise<void>;
    abort: (error: Error) => void;
  }>();
  private stopped = false;
  private stopPromise?: Promise<void>;
  private childSequence = 0;
  /** Last reserved caller on each known CLI thread, including queued callers. */
  private readonly threadReservations = new Map<string, Promise<void>>();
  private readonly pendingRuns = new Set<{
    workflowId: string;
    submissionId?: string;
    cancellation: AbortController;
    /** Original signal handed to stages still owned by this exact operation. */
    signal?: AbortSignal;
    /** Operation ownership outlives children, retries and admitted callbacks. */
    done?: Promise<void>;
  }>();
  /** 1.1.1: ONE shared retry policy for every `codex exec` call this process
   * makes, so a transient upstream condition (server_overloaded / 429 / 5xx /
   * dropped stream / a writer held elsewhere) never ends a workflow. */
  private readonly retry: BackoffPolicy;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: CodexCliAuditOptions) {
    this.retry = normalizeBackoff({
      ...DEFAULT_BACKOFF,
      ...(options.retryBaseMs !== undefined ? { baseMs: options.retryBaseMs } : {}),
      ...(options.retry ?? {}),
    });
    this.now = options.now ?? retryClockNow;
    this.sleepFn = options.sleep ?? ((ms, signal) => abortableDelay(ms, signal));
    this.random = options.random ?? Math.random;
  }

  send(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }> {
    // 1.1.0: an UNBOUND workflow gets a DEDICATED Reviewer task. Resuming the
    // origin/Planner task is never an option — Codex Desktop holds a
    // thread-writer lock on every thread it has loaded, which is exactly what
    // froze real reviews with "already has an active writer" (a lock the
    // plugin cannot release). `createReview` reports and persists the new
    // identity through `onThread`.
    if (request.reviewerThreadId) return this.review(request, signal);
    const { reviewerThreadId: _unbound, codexThreadId: _origin, ...rest } = request;
    return this.createReview({ ...rest, onThread: request.onThread ?? (() => undefined) }, signal);
  }

  cancel(workflowId: string): void {
    if (this.stopped) return;
    for (const entry of this.pendingRuns) {
      if (entry.workflowId === workflowId) entry.cancellation.abort(new Error("codex CLI audit cancelled"));
    }
    for (const entry of this.children.values()) {
      if (entry.workflowId === workflowId) entry.abort(new Error("codex CLI audit cancelled"));
    }
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    if (this.stopped) return;
    for (const entry of this.pendingRuns) {
      if (entry.workflowId === workflowId && entry.submissionId === submissionId) {
        entry.cancellation.abort(new Error("codex CLI audit submission lease lost"));
      }
    }
    for (const entry of this.children.values()) {
      if (entry.workflowId === workflowId && entry.submissionId === submissionId) {
        entry.abort(new Error("codex CLI audit submission lease lost"));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    const pending = [...this.pendingRuns];
    for (const entry of pending) entry.cancellation.abort(new Error("codex CLI audit dispatcher stopped"));
    const active = [...this.children.values()];
    for (const entry of active) entry.abort(new Error("codex CLI audit dispatcher stopped"));
    await Promise.allSettled([...active.map((entry) => entry.done), ...pending.flatMap((entry) => entry.done ? [entry.done] : [])]);
    this.children.clear();
  }

  async review(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }> {
    return this.withCancellation(request, signal, async (operationSignal) => {
      const result = await this.runReviewWithRetry(request, operationSignal);
      return this.finishReview(request, result, operationSignal);
    });
  }

  /**
   * COMPATIBILITY ONLY since 1.1.2 — NOT reachable from a workflow any more.
   *
   * A task created here is stored with `source='exec'`, and the App Server's
   * `thread/list` (the Codex Desktop sidebar source) only ever returns
   * `source='vscode'` tasks: measured 0 of 15 `exec` tasks listed versus 62 of
   * 72 `vscode` tasks, and neither `thread/name/set` nor
   * `--thread-source vscode` changes the `source` column. The visible review
   * turn therefore moved to the App Server (`WorkflowManager.reviewOnce` /
   * `AppServerCodexCallbackDispatcher`), and `workflow.ts` no longer calls
   * `createReview`/`review` at all. Both stay functional for embedders that
   * use this dispatcher as a standalone `CodexCallback`, and for the CLI
   * audit's REAL conversions (`normalize`, `align`, `reconcile`), which run
   * `--ephemeral` and create no durable task.
   */
  async createReview(request: NewCliReviewRequest, signal?: AbortSignal) {
    return this.withCancellation(request, signal, operationSignal => this.createReviewInner(request, operationSignal));
  }

  private async createReviewInner(request: NewCliReviewRequest, signal: AbortSignal) {
    let threadId: string | undefined;
    const result = await this.runWithTransientRetry({
      workflowId: request.workflowId,
      submissionId: request.submissionId,
      prompt: request.prompt,
      signal,
      // An attempt AFTER a transient failure must RESUME the task created by
      // the first attempt: opening a second task would bind a different
      // identity and break the "one dedicated Reviewer" invariant.
      buildArgs: (resumeThreadId) => this.buildArgs({
        cwd: request.cwd,
        model: request.model,
        effort: request.effort,
        threadId: resumeThreadId,
        ephemeral: request.ephemeral === true,
      }),
      onNewThread: async (id) => {
        threadId = id;
        await request.onThread(id);
      },
    });
    if (!threadId) {
      if (result.code !== 0) this.throwProcess("new review", result.stdout, result.stderr, result.code, result.stderrUnavailable);
      throw new CodexNoVerdictError("new CLI review did not report a thread.started identity");
    }
    return this.finishReview({ ...request, codexThreadId: threadId, onThread: undefined }, result, signal);
  }

  private async finishReview(request: CodexCallbackRequest, result: CliProcessResult, signal?: AbortSignal) {
    const visibleThreadId = this.visibleThreadId(request);
    if (result.code !== 0) this.throwProcess(visibleThreadId, result.stdout, result.stderr, result.code, result.stderrUnavailable);
    let visibleText = extractAgentMessage(result.stdout);
    if (!visibleText) throw new CodexNoVerdictError("no final agent message found in CLI review output");
    visibleText = await this.ensureVisibleContract(request, visibleText, signal, "review");
    const verdict = await this.normalize({ visibleText, cwd: request.cwd, workflowId: request.workflowId, submissionId: request.submissionId, model: request.model }, signal);
    await request.onThread?.(visibleThreadId);
    return { kind: "verdict" as const, verdict, visibleText, threadId: visibleThreadId };
  }

  private async runReviewWithRetry(request: CodexCallbackRequest, signal?: AbortSignal) {
    return this.runWithTransientRetry({
      workflowId: request.workflowId,
      submissionId: request.submissionId,
      prompt: request.prompt,
      signal,
      resumeThreadId: this.visibleThreadId(request),
      buildArgs: (resumeThreadId) => this.buildArgs({
        cwd: request.cwd,
        model: request.model,
        effort: request.effort,
        threadId: resumeThreadId,
        ephemeral: request.ephemeral === true,
      }),
    });
  }

  /**
   * The ONE retry loop every `codex exec` invocation goes through (1.1.1).
   *
   * Before this existed, `runReviewWithRetry` retried at most 9 times with a
   * ~22 s linear total against four hard-coded patterns, and every other call
   * site (`normalize`, `align`, `reconcile`, the display rewrite) did not retry
   * at all. A real `server_overloaded` reply — "Selected model is at capacity.
   * Please try a different model." — matched none of them, so a purely
   * temporary upstream condition was reported as a terminal failure and the
   * workflow stopped until a human ran the same call again.
   *
   * The loop now uses the shared classification (`transientReason`) and the
   * shared bounded backoff, honours cancellation while sleeping, and reuses the
   * task created by the first attempt on every retry.
   */
  private async runWithTransientRetry(input: {
    workflowId: string;
    submissionId?: string;
    prompt: string;
    signal?: AbortSignal;
    /** Durable task to resume, when this call targets one. */
    resumeThreadId?: string;
    /** Rebuilt per attempt so the retry resumes instead of re-creating. */
    buildArgs: (resumeThreadId: string | undefined) => string[];
    /** Called when the CLI reports a fresh `thread.started` identity. */
    onNewThread?: (threadId: string) => Promise<void>;
  }): Promise<CliProcessResult> {
    return this.withCancellation(input, input.signal, async (signal) => {
      const policy = this.retry;
      const deadline = this.now() + policy.budgetMs;
      let createdThreadId: string | undefined;
      const onNewThread = input.onNewThread
        ? async (threadId: string) => {
          createdThreadId ??= threadId;
          await input.onNewThread!(threadId);
        }
        : undefined;
      for (let attempt = 0; ; attempt += 1) {
        const target = input.resumeThreadId ?? createdThreadId;
        const result = await this.run(
          input.workflowId, input.submissionId, input.buildArgs(target), input.prompt, signal, target, onNewThread,
        );
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
        if (result.code === 0) return result;
        const reason = transientReason(`${result.stdout}\n${result.stderr}`);
        if (!reason || !(policy.budgetMs > 0)) return result;
        const delayMs = backoffDelayMs(attempt, policy, this.random);
        // Stop when the next wait would exceed the budget: the caller classifies
        // the LAST result (a transient one stays retryable at the workflow level,
        // it is never turned into a terminal failure).
        if (this.now() + delayMs > deadline) return result;
        await this.sleepFn(delayMs, signal);
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
        if (this.now() >= deadline) return result;
      }
    });
  }

  private async withCancellation<T>(
    input: { workflowId: string; submissionId?: string },
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertAdmission(input, callerSignal);
    const cancellation = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, cancellation.signal]) : cancellation.signal;
    let complete!: () => void;
    const pending = { workflowId: input.workflowId, submissionId: input.submissionId, cancellation, signal,
      done: new Promise<void>(resolve => { complete = resolve; }) };
    this.pendingRuns.add(pending);
    try {
      const result = await operation(signal);
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
      return result;
    } finally {
      this.pendingRuns.delete(pending);
      complete();
    }
  }

  async reconcile(request: CodexCallbackRequest, signal?: AbortSignal, recovery?: CliReconciliationRecovery): Promise<{ visibleText: string; verdict: ReviewResult }> {
    return this.withCancellation(request, signal, operationSignal => this.reconcileInner(request, operationSignal, recovery));
  }

  private assertAdmission(input: { workflowId: string; submissionId?: string }, signal?: AbortSignal): void {
    // A later stop cannot replace an already admitted operation's first cause
    // when its own signal crosses a stage boundary. New or displaced requests
    // still fail the permanent stopped gate before considering caller input.
    const ownedCancellation = signal?.aborted && [...this.pendingRuns].some(entry => entry.signal === signal
      && entry.workflowId === input.workflowId && entry.submissionId === input.submissionId);
    if (this.stopped && !ownedCancellation) throw new Error("codex CLI audit dispatcher is stopped");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
  }

  private async reconcileInner(request: CodexCallbackRequest, signal: AbortSignal, recovery?: CliReconciliationRecovery): Promise<{ visibleText: string; verdict: ReviewResult }> {
    const visibleThreadId = this.visibleThreadId(request);
    let visibleText = recovery?.visibleText;
    if (visibleText === undefined) {
      const result = await this.runReviewWithRetry(request, signal);
      if (result.code !== 0) this.throwProcess(visibleThreadId, result.stdout, result.stderr, result.code, result.stderrUnavailable);
      visibleText = extractAgentMessage(result.stdout);
      if (!visibleText) throw new CodexNoVerdictError("no final agent message found in CLI reconciliation output");
      visibleText = await this.ensureVisibleContract(request, visibleText, signal, "reconciliation");
    } else {
      const displayError = reviewDisplayError(visibleText, { task: request.task ?? "", planMarkdown: request.planMarkdown });
      if (displayError) throw new CodexNoVerdictError(`cached CLI reconciliation violates the display contract: ${displayError}`);
    }
    await recovery?.captureVisibleText(visibleText);
    const verdict = await this.normalize({ visibleText, cwd: request.cwd, workflowId: request.workflowId, submissionId: request.submissionId, model: request.model }, signal);
    return { visibleText, verdict };
  }

  /** Match the App Server path's one-turn display repair on the same durable
   * task. CLI resume has no protocol-level developer-instructions channel, so
   * a model can occasionally answer in the wrong language or omit a section. */
  private async ensureVisibleContract(
    request: CodexCallbackRequest,
    text: string,
    signal: AbortSignal | undefined,
    phase: "review" | "reconciliation",
  ): Promise<string> {
    const context = { task: request.task ?? "", planMarkdown: request.planMarkdown };
    const violation = reviewDisplayError(text, context);
    if (!violation) return text;
    if (text.trim().length === 0) throw new CodexNoVerdictError(`${phase} is empty`);
    const languageInstruction = isChineseText(`${context.task}\n${context.planMarkdown ?? ""}`)
      ? "原始任务是中文。必须把标题、正文、测试缺口和总结全部改写为中文；仅保留固定的英文 section 标签（VERDICT/FINDINGS/TEST GAPS/SUMMARY）也可以，但正文不能继续使用英文。"
      : "保留原始任务的语言。";
    const rewrite = await this.runReviewWithRetry({
      ...request,
      prompt: `${reviewRewritePrompt(text, context)}\n\n${languageInstruction}`,
    }, signal);
    if (rewrite.code !== 0) this.throwProcess(this.visibleThreadId(request), rewrite.stdout, rewrite.stderr, rewrite.code, rewrite.stderrUnavailable);
    const rewritten = extractAgentMessage(rewrite.stdout);
    if (!rewritten) throw new CodexNoVerdictError(`no final agent message found in CLI ${phase} rewrite output`);
    const rewrittenViolation = reviewDisplayError(rewritten, context);
    if (rewrittenViolation) throw new CodexNoVerdictError(`corrected CLI ${phase} still violates the display contract: ${rewrittenViolation}`);
    return rewritten;
  }

  async normalize(input: { visibleText: string; cwd: string; workflowId: string; submissionId?: string; model?: string }, signal?: AbortSignal): Promise<ReviewResult> {
    return this.withCancellation(input, signal, operationSignal => this.normalizeInner(input, operationSignal));
  }

  private async normalizeInner(input: Parameters<CodexCliAuditGateway["normalize"]>[0], signal: AbortSignal): Promise<ReviewResult> {
    const result = await this.runWithTransientRetry({
      workflowId: input.workflowId,
      submissionId: input.submissionId,
      prompt: input.visibleText,
      signal,
      buildArgs: () => this.buildArgs({
        cwd: input.cwd,
        model: input.model,
        effort: "low",
        schemaFile: this.options.reviewSchemaFile,
      }),
    });
    if (result.code !== 0) this.throwProcess("ephemeral", result.stdout, result.stderr, result.code, result.stderrUnavailable);
    const text = extractAgentMessage(result.stdout);
    if (!text) throw new CodexNoVerdictError("no final agent message found in CLI normalization output");
    try { return parseReviewResult(JSON.parse(text)); } catch (error) { throw new CodexNoVerdictError(`CLI normalization output invalid: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async align(input: { result: ReviewResult; task: string; planMarkdown?: string; previousReview?: ReviewResult; fixSummary?: string; cwd: string; workflowId: string; submissionId?: string; model?: string; prompt: string }, signal?: AbortSignal): Promise<AlignmentOutcome> {
    return this.withCancellation(input, signal, operationSignal => this.alignInner(input, operationSignal));
  }

  private async alignInner(input: Parameters<CodexCliAuditGateway["align"]>[0], signal: AbortSignal): Promise<AlignmentOutcome> {
    const result = await this.runWithTransientRetry({
      workflowId: input.workflowId,
      submissionId: input.submissionId,
      prompt: input.prompt,
      signal,
      buildArgs: () => this.buildArgs({
        cwd: input.cwd,
        model: input.model,
        effort: "low",
        schemaFile: this.options.alignmentSchemaFile,
      }),
    });
    if (result.code !== 0) this.throwProcess("ephemeral", result.stdout, result.stderr, result.code, result.stderrUnavailable);
    const text = extractAgentMessage(result.stdout);
    if (!text) throw new CodexNoVerdictError("no final agent message found in CLI alignment output");
    return parseAlignment(text, input.result);
  }

  private visibleThreadId(request: CodexCallbackRequest): string {
    return request.reviewerThreadId ?? request.codexThreadId ?? "ephemeral";
  }

  /** Build every codex exec invocation in one place so visible review,
   * reconciliation, normalization and alignment cannot silently diverge in
   * model, effort or persistence semantics. */
  private buildArgs(input: {
    cwd: string;
    model?: string;
    effort?: ReasoningEffort;
    threadId?: string;
    ephemeral?: boolean;
    schemaFile?: string;
  }): string[] {
    const args = ["exec"];
    if (input.schemaFile || input.ephemeral) args.push("--ephemeral");
    args.push("--json");
    if (input.schemaFile) args.push("--output-schema", input.schemaFile);
    const model = input.model?.trim();
    if (model) args.push("-m", model);
    if (input.effort) args.push("-c", `model_reasoning_effort="${input.effort}"`);
    args.push(
      "-C", input.cwd,
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "-c", "approval_policy=never",
    );
    if (input.threadId && !input.ephemeral && !input.schemaFile) args.push("resume", input.threadId);
    args.push("-");
    return args;
  }

  private async run(
    workflowId: string,
    submissionId: string | undefined,
    args: string[],
    prompt: string,
    signal?: AbortSignal,
    threadId?: string,
    onNewThread?: (threadId: string) => Promise<void>,
  ): Promise<CliProcessResult> {
    this.assertAdmission({ workflowId, submissionId }, signal);
    const cancellation = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    const pending = { workflowId, submissionId, cancellation, signal: runSignal };
    this.pendingRuns.add(pending);
    let releaseThread: (() => void) | undefined;
    try {
      releaseThread = threadId ? await this.reserveThread(threadId, runSignal) : undefined;
      const admitted = this.runAdmitted(workflowId, submissionId, args, prompt, runSignal, threadId, onNewThread);
      // runAdmitted registers its child synchronously before returning. The
      // active child owns cancellation from that point through close/binding.
      this.pendingRuns.delete(pending);
      return await admitted;
    } finally { this.pendingRuns.delete(pending); releaseThread?.(); }
  }

  private async runAdmitted(
    workflowId: string,
    submissionId: string | undefined,
    args: string[],
    prompt: string,
    signal?: AbortSignal,
    threadId?: string,
    onNewThread?: (threadId: string) => Promise<void>,
  ): Promise<CliProcessResult> {
    this.assertAdmission({ workflowId, submissionId }, signal);
    return new Promise((resolve, reject) => {
      this.options.onSpawn?.([...args]);
      if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted")); return; }
      if (this.stopped) { reject(new Error("codex CLI audit dispatcher is stopped")); return; }
      const child = (this.options.spawn ?? crossSpawn)(this.options.command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.options.env ?? process.env });
      const key = ++this.childSequence;
      const max = this.options.maxOutputBytes ?? 64 * 1024;
      const outDecoder = new StringDecoder("utf8"); const errDecoder = new StringDecoder("utf8");
      let stdout = ""; let stderr = ""; let settled = false; let pendingError: Error | undefined;
      let stderrUnavailable = false;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolveDonePromise) => { resolveDone = resolveDonePromise; });
      const killTimers: NodeJS.Timeout[] = [];
      const abort = (error: Error) => {
        if (pendingError) return;
        pendingError = error;
        this.kill(child, killTimers);
      };
      const modelStreamFailed = (error: Error) => {
        // Unlike diagnostics, prompt delivery and model output are required.
        // Keep the first cause and wait for this original child's close.
        if (!settled && !pendingError) abort(error);
      };
      // Keep these consumers attached after close so retired errors cannot
      // escape or kill a later independent process.
      child.stdin?.on("error", modelStreamFailed);
      child.stdout?.on("error", modelStreamFailed);
      this.children.set(key, { child, workflowId, submissionId, threadId, done, abort });
      const timer = setTimeout(() => abort(new Error("codex CLI audit timed out")), this.options.timeoutMs);
      timer.unref();
      const onAbort = () => abort(signal?.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      let identityBuffer = "";
      let newThreadId: string | undefined;
      let binding: Promise<void> = Promise.resolve();
      const readIdentity = (text: string, flush = false) => {
        if (!onNewThread) return;
        identityBuffer += text;
        const lines = identityBuffer.split("\n");
        identityBuffer = flush ? "" : lines.pop()!;
        for (const line of lines) {
          let event: { type?: string; thread_id?: unknown };
          try { event = JSON.parse(line); } catch { continue; }
          if (event?.type !== "thread.started") continue;
          const id = event.thread_id;
          if (typeof id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
            || (newThreadId !== undefined && newThreadId !== id)) {
            abort(new CodexNoVerdictError("invalid or conflicting CLI thread.started identity"));
            return;
          }
          if (newThreadId) continue;
          newThreadId = id;
          const entry = this.children.get(key);
          if (entry) entry.threadId = id;
          binding = Promise.resolve().then(() => onNewThread(id)).catch((error) => {
            abort(error instanceof Error ? error : new Error(String(error)));
          });
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled || pendingError) return;
        const text = outDecoder.write(chunk);
        stdout += text;
        if (Buffer.byteLength(stdout) > max) { abort(new CodexNoVerdictError("CLI output exceeded retention bound")); return; }
        readIdentity(text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!stderrUnavailable) stderr = retainStderrTail(stderr + errDecoder.write(chunk), max);
      });
      // Stderr is diagnostic-only. Consume even retired errors, but annotate
      // only this original run without failing its healthy stdout model output.
      child.stderr?.on("error", () => { if (!settled) stderrUnavailable = true; });
      child.once("error", (error) => {
        if (child.pid === undefined) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.children.delete(key);
          resolveDone();
          if (!settled) { settled = true; reject(error); }
          return;
        }
        abort(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        for (const killTimer of killTimers) clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        const tail = outDecoder.end();
        stdout += tail;
        if (Buffer.byteLength(stdout) > max) pendingError ??= new CodexNoVerdictError("CLI output exceeded retention bound");
        if (!pendingError) readIdentity(tail, true);
        stderr = retainStderrTail(stderr + errDecoder.end(), max);
        void binding.then(() => {
          // Stop/retry must also wait for the new task identity to be durable.
          // Caller cancellation remains observable through that same wait.
          signal?.removeEventListener("abort", onAbort);
          for (const killTimer of killTimers) clearTimeout(killTimer);
          this.children.delete(key);
          resolveDone();
          if (pendingError) reject(pendingError);
          else resolve({ code, stdout, stderr, ...(stderrUnavailable ? { stderrUnavailable: true } : {}) });
        });
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        abort(new Error("codex CLI audit child streams unavailable"));
        return;
      }
      // A spawn adapter can synchronously cancel before this child's abort
      // listener was registered. Retain that first cause and skip prompt work.
      if (signal?.aborted) onAbort();
      if (pendingError) return;
      try { child.stdin.end(prompt); }
      catch (error) { modelStreamFailed(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private async waitThreadIdle(threadId: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
      const active = [...this.children.values()].filter((entry) => entry.threadId === threadId);
      if (active.length === 0) return;
      const idle = Promise.race(active.map((entry) => entry.done));
      await this.observeThreadRelease(idle, signal);
    }
  }

  private async reserveThread(threadId: string, signal?: AbortSignal): Promise<() => void> {
    const previous = this.threadReservations.get(threadId);
    let resolveReservation!: () => void, released = false;
    const reservation = new Promise<void>(resolve => { resolveReservation = resolve; });
    // Reserve before yielding: two idle observers cannot both claim this slot.
    this.threadReservations.set(threadId, reservation);
    const release = () => {
      if (released) return;
      released = true;
      resolveReservation();
      if (this.threadReservations.get(threadId) === reservation) this.threadReservations.delete(threadId);
    };
    try {
      if (previous) await this.observeThreadRelease(previous, signal);
      // A CLI creation can discover its identity only after it starts. Its
      // already admitted child remains authoritative until close and binding.
      await this.waitThreadIdle(threadId, signal);
      return release;
    } catch (error) {
      // A cancelled ticket cannot let a later caller bypass its predecessor.
      if (previous) void previous.then(release, release); else release();
      throw error;
    }
  }

  private observeThreadRelease(done: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return done;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error); else resolve();
      };
      const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted"));
      // This caller owns no child while queued. Its signal affects no owner.
      signal.addEventListener("abort", onAbort, { once: true });
      done.then(() => finish(), finish);
      if (signal.aborted) onAbort();
    });
  }

  private kill(child: ChildProcess, timers: NodeJS.Timeout[]): void {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill();
    for (const graceMs of [this.options.killGraceMs ?? 1_000, this.options.killKillGraceMs ?? 5_000]) {
      const timer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
      }, graceMs);
      timer.unref();
      timers.push(timer);
    }
  }

  private throwProcess(threadId: string, stdout: string, stderr: string, code: number | null, stderrUnavailable = false): never {
    const diagnostic = `${stdout}\n${stderr}`;
    // Report diagnostic loss separately from source bytes and classification.
    const diagnosticNote = stderrUnavailable ? "\n(stderr diagnostic stream unavailable)" : "";
    const reported = `${compactDiagnostic(diagnostic)}${diagnosticNote}`;
    if (/no rollout found for thread id/i.test(diagnostic)) throw new CodexInvalidThreadError(`codex thread ${threadId} does not exist${diagnosticNote}`);
    // 1.1.1: a TRANSIENT upstream condition stays RETRYABLE even after the
    // retry budget is spent — capacity/throttling is temporary by nature, and
    // reporting it as a terminal process failure is what silently killed
    // workflows (see transient-retry.ts for the incident).
    if (!isTerminalModelFailure(diagnostic) && (code === null || transientReason(diagnostic))) {
      throw new CodexCliAuditBusyError(`codex CLI audit busy: ${reported}`);
    }
    const recoverableModelFailure = !extractAgentMessage(stdout) && !isTerminalModelFailure(diagnostic)
      && isRecoverableModelFailure(stderr.trim());
    throw new CodexCallbackProcessError(`codex CLI audit exited with code ${code}: ${reported}`, recoverableModelFailure);
  }
}

class CodexCliAuditBusyError extends Error {}

function retainStderrTail(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (limit === 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const bytes = Buffer.from(text, "utf8");
  let start = bytes.length - limit;
  // A tail beginning inside a UTF-8 sequence would invent replacement text.
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.toString("utf8", start);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted"));
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function extractAgentMessage(stdout: string): string | undefined {
  const texts: string[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== "item.completed") continue;
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) texts.push(item.text);
    } catch { /* ignore non-JSON CLI noise */ }
  }
  return texts.at(-1);
}

import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseReviewResult } from "./bridge-protocol.js";
import { parseAlignment } from "./review-authority.js";
import { ALIGN_OUTPUT_SCHEMA } from "./review-authority.js";
import { REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { isChineseText, reviewDisplayError, reviewRewritePrompt } from "./review-contract.js";
import type { AlignmentOutcome, ReasoningEffort, ReviewResult } from "./types.js";
import type { CodexCallbackRequest, CodexCallbackResult } from "./codex-callback.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "./codex-callback.js";

export interface CodexCliAuditOptions {
  command: string;
  reviewSchemaFile: string;
  alignmentSchemaFile: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** Read-only observability seam for tests and lifecycle acceptance. */
  onSpawn?: (args: string[]) => void;
  killGraceMs?: number;
  killKillGraceMs?: number;
  retryBaseMs?: number;
}

export interface CodexCliAuditGateway {
  review(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }>;
  normalize(input: { visibleText: string; cwd: string; workflowId: string; submissionId?: string; model?: string }, signal?: AbortSignal): Promise<ReviewResult>;
  align(input: { result: ReviewResult; task: string; planMarkdown?: string; previousReview?: ReviewResult; fixSummary?: string; cwd: string; workflowId: string; submissionId?: string; model?: string; prompt: string }, signal?: AbortSignal): Promise<AlignmentOutcome>;
  reconcile(request: CodexCallbackRequest, signal?: AbortSignal): Promise<{ visibleText: string; verdict: ReviewResult }>;
  cancel(workflowId: string): void;
  cancelSubmission(workflowId: string, submissionId: string): void;
  stop(): Promise<void>;
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

  constructor(private readonly options: CodexCliAuditOptions) {}

  send(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }> {
    return this.review(request, signal);
  }

  cancel(workflowId: string): void {
    if (this.stopped) return;
    for (const entry of this.children.values()) {
      if (entry.workflowId === workflowId) entry.abort(new Error("codex CLI audit cancelled"));
    }
  }

  cancelSubmission(workflowId: string, submissionId: string): void {
    if (this.stopped) return;
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
    const active = [...this.children.values()];
    for (const entry of active) entry.abort(new Error("codex CLI audit dispatcher stopped"));
    await Promise.allSettled(active.map((entry) => entry.done));
    this.children.clear();
  }

  async review(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult & { kind: "verdict"; visibleText: string; threadId: string }> {
    const visibleThreadId = this.visibleThreadId(request);
    let result = await this.runReviewWithRetry(request, signal);
    if (result.code !== 0) this.throwProcess(visibleThreadId, result.stdout, result.stderr, result.code);
    let visibleText = extractAgentMessage(result.stdout);
    if (!visibleText) throw new CodexNoVerdictError("no final agent message found in CLI review output");
    visibleText = await this.ensureVisibleContract(request, visibleText, signal, "review");
    const verdict = await this.normalize({ visibleText, cwd: request.cwd, workflowId: request.workflowId, submissionId: request.submissionId, model: request.model }, signal);
    await request.onThread?.(visibleThreadId);
    return { kind: "verdict", verdict, visibleText, threadId: visibleThreadId };
  }

  private async runReviewWithRetry(request: CodexCallbackRequest, signal?: AbortSignal) {
    const args = this.buildArgs({
      cwd: request.cwd,
      model: request.model,
      effort: request.effort,
      threadId: this.visibleThreadId(request),
    });
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.run(request.workflowId, request.submissionId, args, request.prompt, signal, this.visibleThreadId(request));
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      if (result.code === 0 || attempt >= 9 || !/active writer|already has an active writer|rate limit|429 Too Many Requests/i.test(diagnostic)) return result;
      await abortableDelay((this.options.retryBaseMs ?? 500) * (attempt + 1), signal);
    }
  }

  async reconcile(request: CodexCallbackRequest, signal?: AbortSignal): Promise<{ visibleText: string; verdict: ReviewResult }> {
    const visibleThreadId = this.visibleThreadId(request);
    let result = await this.runReviewWithRetry(request, signal);
    if (result.code !== 0) this.throwProcess(visibleThreadId, result.stdout, result.stderr, result.code);
    let visibleText = extractAgentMessage(result.stdout);
    if (!visibleText) throw new CodexNoVerdictError("no final agent message found in CLI reconciliation output");
    visibleText = await this.ensureVisibleContract(request, visibleText, signal, "reconciliation");
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
    if (rewrite.code !== 0) this.throwProcess(this.visibleThreadId(request), rewrite.stdout, rewrite.stderr, rewrite.code);
    const rewritten = extractAgentMessage(rewrite.stdout);
    if (!rewritten) throw new CodexNoVerdictError(`no final agent message found in CLI ${phase} rewrite output`);
    const rewrittenViolation = reviewDisplayError(rewritten, context);
    if (rewrittenViolation) throw new CodexNoVerdictError(`corrected CLI ${phase} still violates the display contract: ${rewrittenViolation}`);
    return rewritten;
  }

  async normalize(input: { visibleText: string; cwd: string; workflowId: string; submissionId?: string; model?: string }, signal?: AbortSignal): Promise<ReviewResult> {
    const result = await this.run(input.workflowId, input.submissionId, this.buildArgs({
      cwd: input.cwd,
      model: input.model,
      effort: "low",
      schemaFile: this.options.reviewSchemaFile,
    }), input.visibleText, signal);
    if (result.code !== 0) this.throwProcess("ephemeral", result.stdout, result.stderr, result.code);
    const text = extractAgentMessage(result.stdout);
    if (!text) throw new CodexNoVerdictError("no final agent message found in CLI normalization output");
    try { return parseReviewResult(JSON.parse(text)); } catch (error) { throw new CodexNoVerdictError(`CLI normalization output invalid: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async align(input: { result: ReviewResult; task: string; planMarkdown?: string; previousReview?: ReviewResult; fixSummary?: string; cwd: string; workflowId: string; submissionId?: string; model?: string; prompt: string }, signal?: AbortSignal): Promise<AlignmentOutcome> {
    const result = await this.run(input.workflowId, input.submissionId, this.buildArgs({
      cwd: input.cwd,
      model: input.model,
      effort: "low",
      schemaFile: this.options.alignmentSchemaFile,
    }), input.prompt, signal);
    if (result.code !== 0) this.throwProcess("ephemeral", result.stdout, result.stderr, result.code);
    const text = extractAgentMessage(result.stdout);
    if (!text) throw new CodexNoVerdictError("no final agent message found in CLI alignment output");
    return parseAlignment(text, input.result);
  }

  private visibleThreadId(request: CodexCallbackRequest): string {
    return request.reviewerThreadId ?? request.codexThreadId;
  }

  /** Build every codex exec invocation in one place so visible review,
   * reconciliation, normalization and alignment cannot silently diverge in
   * model, effort or persistence semantics. */
  private buildArgs(input: {
    cwd: string;
    model?: string;
    effort?: ReasoningEffort;
    threadId?: string;
    schemaFile?: string;
  }): string[] {
    const args = ["exec"];
    if (input.schemaFile) args.push("--ephemeral");
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
    if (input.threadId) args.push("resume", input.threadId);
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
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (this.stopped) throw new Error("codex CLI audit dispatcher is stopped");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
    if (threadId) await this.waitThreadIdle(threadId);
    if (this.stopped) throw new Error("codex CLI audit dispatcher is stopped");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted");
    return new Promise((resolve, reject) => {
      this.options.onSpawn?.([...args]);
      const child = (this.options.spawn ?? crossSpawn)(this.options.command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.options.env ?? process.env });
      const key = ++this.childSequence;
      const max = this.options.maxOutputBytes ?? 64 * 1024;
      const outDecoder = new StringDecoder("utf8"); const errDecoder = new StringDecoder("utf8");
      let stdout = ""; let stderr = ""; let settled = false; let pendingError: Error | undefined;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolveDonePromise) => { resolveDone = resolveDonePromise; });
      const killTimers: NodeJS.Timeout[] = [];
      const abort = (error: Error) => {
        pendingError ??= error;
        this.kill(child, killTimers);
      };
      this.children.set(key, { child, workflowId, submissionId, threadId, done, abort });
      const timer = setTimeout(() => abort(new Error("codex CLI audit timed out")), this.options.timeoutMs);
      timer.unref();
      const onAbort = () => abort(signal?.reason instanceof Error ? signal.reason : new Error("codex CLI audit aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => { stdout += outDecoder.write(chunk); if (Buffer.byteLength(stdout) > max) abort(new CodexNoVerdictError("CLI output exceeded retention bound")); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += errDecoder.write(chunk); if (Buffer.byteLength(stderr) > max) stderr = stderr.slice(-max); });
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
        signal?.removeEventListener("abort", onAbort);
        this.children.delete(key);
        resolveDone();
        if (settled) return;
        settled = true;
        stdout += outDecoder.end();
        stderr += errDecoder.end();
        if (pendingError) reject(pendingError);
        else resolve({ code, stdout, stderr });
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        abort(new Error("codex CLI audit child streams unavailable"));
        return;
      }
      child.stdin?.end(prompt);
    });
  }

  private async waitThreadIdle(threadId: string): Promise<void> {
    for (;;) {
      const active = [...this.children.values()].filter((entry) => entry.threadId === threadId);
      if (active.length === 0) return;
      await Promise.race(active.map((entry) => entry.done));
    }
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

  private throwProcess(threadId: string, stdout: string, stderr: string, code: number | null): never {
    const diagnostic = `${stdout}\n${stderr}`;
    if (/no rollout found for thread id/i.test(diagnostic)) throw new CodexInvalidThreadError(`codex thread ${threadId} does not exist`);
    if (code === null || /rate limit|already in use|active writer/i.test(diagnostic)) throw new CodexCliAuditBusyError(`codex CLI audit busy: ${diagnostic.trim().slice(0, 2048)}`);
    throw new CodexCallbackProcessError(`codex CLI audit exited with code ${code}: ${diagnostic.trim().slice(0, 2048)}`);
  }
}

class CodexCliAuditBusyError extends Error {}

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

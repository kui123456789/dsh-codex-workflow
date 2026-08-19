import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseReviewResult } from "./bridge-protocol.js";
import type { ReasoningEffort, ReviewResult } from "./types.js";

export interface CodexCallbackRequest {
  workflowId: string;
  submissionId: string;
  codexThreadId: string;
  cwd: string;
  prompt: string;
  reviewerThreadId?: string;
  reviewerName?: string;
  model?: string;
  effort?: ReasoningEffort;
  onThread?: (threadId: string) => Promise<void> | void;
  onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
}

export interface CodexCallbackOptions {
  command: string;
  /** Optional prefix arguments (e.g. a script path for test executables). */
  args?: string[];
  /** Path to the JSON Schema file passed via `--output-schema`. */
  schemaFile: string;
  timeoutMs: number;
  /** Bounded stdout/stderr retained for parsing and diagnostics. */
  maxOutputBytes?: number;
  /** Child process environment; defaults to the host environment. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: replace the child spawner. */
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** Grace before the SIGKILL escalations (defaults 1s / 5s); injectable for
   * tests so a stubborn child cannot stall teardown for real seconds. */
  killGraceMs?: number;
  killKillGraceMs?: number;
}

export type CodexCallbackResult =
  | { kind: "verdict"; verdict: ReviewResult }
  | { kind: "retryable_busy" };

/** Terminal failure: the thread id does not exist and will never become
 * valid; retrying is pointless and replacing the thread is forbidden. */
export class CodexInvalidThreadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexInvalidThreadError";
  }
}

/** Explicit failure of the review output contract: no final agent message,
 * malformed JSON, schema violations, or output over the retention bound. */
export class CodexNoVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexNoVerdictError";
  }
}

/** Terminal child-process failure that is neither a busy/rate-limit condition
 * nor an invalid thread. Retrying it as "busy" would hide actionable CLI
 * configuration and environment errors from the operator. */
export class CodexCallbackProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCallbackProcessError";
  }
}

const BUSY_PATTERNS = [
  /429 Too Many Requests/i,
  /exceeded retry limit/i,
  /rate limit/i,
  /already in use/i,
  /already has an active writer/i,
];

/**
 * Resumes the exact stored Codex thread with a read-only review and a strict
 * structured-output contract:
 *
 *   codex exec --json --output-schema <schema> -C <cwd> \
 *     --skip-git-repo-check --sandbox read-only \
 *     -c approval_policy=never resume <codexThreadId> -
 *
 * Never uses `--last` and never creates a replacement thread. The child runs
 * without a shell and only ever talks over stdout: it cannot write the bridge
 * queue (that is the DSH plugin's job, outside the sandbox). The final agent
 * message is extracted from the bounded JSONL event stream and strictly
 * validated against the review schema. A missing/malformed/oversized verdict
 * is an explicit `CodexNoVerdictError`, never a silent success.
 */
export class CodexCallbackDispatcher {
  private readonly children = new Map<string, { child: ChildProcess; threadId: string }>();
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: CodexCallbackOptions) {}

  /** Kill the active callback child(ren) for a workflow/submission. Entries
   * stay tracked until the child's exit is CONFIRMED (close event), so a
   * late-arriving kill path can never leave an untracked process behind. */
  cancel(workflowId: string): void {
    if (this.stopped) return;
    for (const [key, entry] of [...this.children]) {
      if (key.startsWith(`${workflowId}:`)) {
        this.kill(entry.child);
      }
    }
  }

  /** Kill the EXACT callback child for one submission — never another
   * submission's (or a new owner's) child. Used when an owner loses its
   * submission lease mid-flight. */
  cancelSubmission(workflowId: string, submissionId: string): void {
    if (this.stopped) return;
    const entry = this.children.get(`${workflowId}:${submissionId}`);
    if (entry) this.kill(entry.child);
  }

  /** Stop every active callback child and wait for each to fully exit. After
   * this the dispatcher is a hard gate: `send` rejects so no child can ever be
   * (re)spawned during teardown. Concurrent stop() calls share ONE settle
   * promise: a second caller can never resolve before the children have
   * really exited. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const task = this.doStop();
    this.stopPromise = task;
    return task;
  }

  private async doStop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const pending: Promise<void>[] = [];
    for (const [, entry] of [...this.children]) {
      pending.push(this.killAndWait(entry.child));
    }
    await Promise.allSettled(pending);
    this.children.clear();
  }

  async send(request: CodexCallbackRequest, signal?: AbortSignal): Promise<CodexCallbackResult> {
    if (this.stopped) {
      throw new Error("codex callback dispatcher is stopped");
    }
    if (signal?.aborted) {
      throw abortError(signal);
    }
    // Isolation gate: never overlap two exact-thread resumes on the same
    // thread. A previous child (timed out / overflowed / cancelled) must be
    // CONFIRMED exited — not assumed — before a new one is spawned; the kill
    // escalation guarantees exit, so this wait always terminates.
    await this.waitThreadIdle(request.codexThreadId);
    if (this.stopped) {
      throw new Error("codex callback dispatcher is stopped");
    }
    if (signal?.aborted) {
      throw abortError(signal);
    }
    return new Promise((resolvePromise, reject) => {
      const spawn = this.options.spawn ?? crossSpawn;
      const child = spawn(this.options.command, [
        ...(this.options.args ?? []),
        "exec",
        "--json",
        "--output-schema", this.options.schemaFile,
        "-C", request.cwd,
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "-c", "approval_policy=never",
        "resume", request.codexThreadId, "-",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: this.options.env ?? process.env,
      });
      const key = `${request.workflowId}:${request.submissionId}`;
      this.children.set(key, { child, threadId: request.codexThreadId });
      const maxOutput = this.options.maxOutputBytes ?? 16_384;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stderrOverflow = false;
      let settled = false;
      let timedOut = false;
      const kill = () => this.kill(child);
      // finish never removes the child from the map: the entry is retired by
      // the close handler once exit is confirmed, so stop()/waitThreadIdle
      // can still see and wait for a child whose promise already settled.
      const finish = (result: CodexCallbackResult | "error", error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (result === "error") reject(error ?? new Error("codex callback failed"));
        else resolvePromise(result);
      };
      const onAbort = () => {
        kill();
        finish("error", abortError(signal!));
      };
      const timer = setTimeout(() => {
        // A timed-out resume may still be running on the thread; classify as
        // retryable so the caller backs off instead of losing the workflow.
        // The child must be CONFIRMED exited before we return, or an
        // immediate retry (backoff can be shorter than SIGKILL latency) would
        // overlap two exact-thread resumes on the same thread.
        timedOut = true;
        const exitWaiter = waitExit(child);
        kill();
        void exitWaiter.then(() => finish({ kind: "retryable_busy" }));
      }, this.options.timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      const stdoutStream = child.stdout;
      const stderrStream = child.stderr;
      const stdinStream = child.stdin;
      if (!stdoutStream || !stderrStream || !stdinStream) {
        // The child was already started; never leave it running unmanaged.
        kill();
        finish("error", new Error("codex callback child streams unavailable"));
        return;
      }
      stdoutStream.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutput) {
          // Byte-bound exceeded: never keep a truncated stream as a verdict.
          // The child is killed but stays tracked until its exit is confirmed.
          kill();
          finish("error", new CodexNoVerdictError(`review output exceeded the ${maxOutput} byte retention bound`));
          return;
        }
        stdout += stdoutDecoder.write(chunk);
      });
      stderrStream.on("data", (chunk: Buffer) => {
        if (stderrOverflow) return;
        const before = stderrBytes;
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutput) {
          // Keep the HEAD of stderr (diagnostics are at the start); the tail
          // is dropped so busy/invalid-thread classification still works, and
          // the retained text stays within the byte bound.
          const take = Math.max(0, maxOutput - before);
          stderr += stderrDecoder.write(take > 0 ? chunk.subarray(0, take) : Buffer.alloc(0));
          stderrOverflow = true;
          stderr += stderrDecoder.end();
          return;
        }
        stderr += stderrDecoder.write(chunk);
      });
      child.on("error", (error) => {
        if (child.pid === undefined) {
          // Spawn failure: no process was ever created, so there is nothing to
          // wait on — retire the entry immediately and surface the error.
          this.children.delete(key);
          finish("error", error);
          return;
        }
        // A process WAS created (post-spawn error: unable-to-kill, IPC send
        // failure, abort). This error only settles THIS send; the entry stays
        // tracked until the close event confirms the process actually ended,
        // so thread isolation and stop() keep waiting on the live child.
        finish("error", error);
      });
      child.on("close", (code) => {
        this.children.delete(key); // exit confirmed: stop tracking
        if (timedOut) return; // the timeout branch owns the resolution
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (code !== 0) {
          const diagnostic = `${stdout}\n${stderr}`;
          if (/no rollout found for thread id/i.test(diagnostic)) {
            finish("error", new CodexInvalidThreadError(`codex thread ${request.codexThreadId} does not exist`));
            return;
          }
          if (BUSY_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
            finish({ kind: "retryable_busy" });
            return;
          }
          // A signal-only exit can result from an interrupted child whose
          // thread may still be settling, so it remains retryable. A real
          // nonzero exit is actionable and terminal; calling it "busy" hides
          // errors such as invalid CLI configuration or authentication.
          if (code === null) {
            finish({ kind: "retryable_busy" });
            return;
          }
          const detail = compactProcessDiagnostic(stderr || stdout);
          finish("error", new CodexCallbackProcessError(
            `codex callback exited with code ${code}${detail ? `: ${detail}` : ""}`,
          ));
          return;
        }
        try {
          const verdict = extractVerdict(stdout, maxOutput);
          finish({ kind: "verdict", verdict });
        } catch (error) {
          // Explicit failure: the child succeeded but produced no usable verdict.
          finish("error", error instanceof Error ? error : new Error(String(error)));
        }
      });
      stdinStream.write(request.prompt);
      stdinStream.end();
    });
  }

  /** Wait until every child for this thread has CONFIRMEDLY exited (close
   * event). Never assumes an exit after a timeout. */
  private async waitThreadIdle(threadId: string): Promise<void> {
    for (;;) {
      let busy = false;
      for (const [, entry] of this.children) {
        if (entry.threadId !== threadId) continue;
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          busy = true;
          break;
        }
      }
      if (!busy) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private kill(child: ChildProcess): ChildProcess {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const escalate = (graceMs: number) => {
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, graceMs).unref();
      };
      // Full escalation: SIGTERM, then SIGKILL after 1s, then SIGKILL again
      // after 5s. A child that ignores the first termination can never block
      // teardown forever.
      escalate(this.options.killGraceMs ?? 1_000);
      escalate(this.options.killKillGraceMs ?? 5_000);
    }
    return child;
  }

  /** Wait for the child's close, THEN kill through the full escalation
   * (SIGTERM -> SIGKILL grace timers): registering the close waiter before
   * killing guarantees the close event cannot be lost (a kill can race a
   * synchronous fake/edge close and the waiter would otherwise never fire). */
  private killAndWait(child: ChildProcess): Promise<void> {
    const exited = waitExit(child);
    this.kill(child);
    return exited;
  }
}

function compactProcessDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_048);
}

/** Extract the final agent message from a bounded JSONL event stream and
 * strictly validate it against the review schema. */
export function extractVerdict(stdout: string, maxOutput: number): ReviewResult {
  if (Buffer.byteLength(stdout, "utf8") > maxOutput) {
    throw new CodexNoVerdictError(`review output exceeded the ${maxOutput} byte retention bound`);
  }
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const texts: string[] = [];
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // non-JSON noise in the stream is ignored, JSONL events are parsed
    }
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "agent_message") continue;
    if (typeof record.text === "string" && record.text.trim()) texts.push(record.text);
  }
  const finalText = texts.at(-1);
  if (!finalText) {
    throw new CodexNoVerdictError("no final agent message found in the review output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText);
  } catch (error) {
    throw new CodexNoVerdictError(`final agent message is not valid JSON: ${errorMessage(error)}`);
  }
  try {
    return parseReviewResult(parsed);
  } catch (error) {
    throw new CodexNoVerdictError(`final agent message violates the review schema: ${errorMessage(error)}`);
  }
}

/** Wait for the child's close to be CONFIRMED. There is NO "assume exited
 * after N seconds" window and NO early-resolution on exitCode/signalCode for a
 * REAL process: the exit code can be set while stdio/close still lag, and the
 * close handler is what retires the entry from the children map — so only the
 * close event counts. A child that never spawned (pid undefined = spawn
 * failure) can never exit on its own: settle on close OR on the spawn error so
 * teardown never hangs. */
function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined) {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
      return;
    }
    child.once("close", () => resolve());
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("codex callback aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

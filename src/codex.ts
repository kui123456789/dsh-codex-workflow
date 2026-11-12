import { StringDecoder } from "node:string_decoder";
import { captureTree, spawnCommand, stopTree } from "./process.js";
import { compactDiagnostic, isTerminalModelFailure } from "./transient-retry.js";
import type { ProcessTree } from "./process.js";

export class CodexFailure extends Error {
  constructor(message: string, readonly recoverable: boolean, readonly cleanupConfirmed: boolean) { super(message); }
}
export interface CodexRun {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onThread(id: string): void;
  onTree(tree: ProcessTree): void;
}

/** Consume only public final messages and lifecycle receipts, never publish tool output. */
export async function runCodex(input: CodexRun): Promise<unknown> {
  input.signal.throwIfAborted();
  const child = spawnCommand(input.command, input.args, { cwd: input.cwd });
  const decoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
  let line = "", stderr = "", message = "", completed = false, closed = false, code: number | null = null;
  let failure: Error | undefined, tree: ProcessTree | undefined, refresh: ReturnType<typeof setInterval> | undefined, threadReceived = false;
  let cleanupTask: Promise<boolean> | undefined;
  let failedCleanup = false;
  let refreshTask: Promise<void> = Promise.resolve();
  const fail = (error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); };
  const exit = new Promise<void>((resolve) => {
    child.once("error", (error) => { fail(error); closed = true; resolve(); });
    child.once("close", (exitCode) => { code = exitCode; closed = true; resolve(); });
  });
  const frame = (raw: string) => {
    if (!raw.trim()) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { fail(new Error("Invalid Codex JSONL protocol")); return; }
    try {
      if (event.type === "thread.started") {
        if (typeof event.thread_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(event.thread_id)) throw new Error("Invalid Codex thread receipt");
        input.onThread(event.thread_id);
        threadReceived = true;
      }
      if (event.type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") message = item.text;
      }
      if (event.type === "turn.completed") completed = true;
      if (event.type === "turn.failed") fail(new Error(compactDiagnostic(JSON.stringify(event.error ?? event))));
      // A nonterminal error event may announce an internal reconnect; turn/exit receipts decide failure.
    } catch (error) { fail(error); }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    line += decoder.write(chunk);
    if (line.length > 4 * 1024 * 1024) { fail(new Error("Codex JSONL frame exceeds 4 MiB")); return; }
    let newline: number;
    while ((newline = line.indexOf("\n")) >= 0) { frame(line.slice(0, newline)); line = line.slice(newline + 1); }
  });
  child.stdout?.on("error", fail);
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + errDecoder.write(chunk)).slice(-16384); });
  child.stderr?.on("error", () => undefined);
  child.stdin?.on("error", fail);
  const abort = () => { fail(input.signal.reason ?? new Error("Codex operation cancelled")); };
  input.signal.addEventListener("abort", abort, { once: true });
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    if (child.pid) {
      tree = await captureTree(child.pid);
      if (tree) input.onTree(tree);
    }
    if (!tree && !closed) throw new CodexFailure("Original Codex process identity could not be confirmed", false, false);
    input.signal.throwIfAborted();
    if (!closed) child.stdin?.end(input.prompt);
    refresh = setInterval(() => {
      refreshTask = refreshTask.then(async () => {
        if (closed || !child.pid || !tree) return;
        const next = await captureTree(child.pid, tree);
        if (next) { tree = next; input.onTree(next); }
      }).catch(fail);
    }, 1000);
    monitor = setInterval(() => {
      if (failure && !closed) {
        if (tree) cleanupTask ??= stopTree(tree).catch(() => false).then((confirmed) => { failedCleanup = !confirmed; return confirmed; });
        // A spawn without a PID/stdio has no model request and settles through its original error receipt.
      }
    }, 250);
    while (!closed) {
      await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
      if (failedCleanup) {
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref();
        throw new CodexFailure(failure?.message ?? "Original process cleanup remains unconfirmed", false, false);
      }
    }
    line += decoder.end();
    if (line.trim()) frame(line);
    stderr += errDecoder.end();
    await refreshTask;
    const cleaned = cleanupTask ? await cleanupTask : tree ? await stopTree(tree) : child.pid === undefined;
    if (!cleaned) throw new CodexFailure(failure?.message ?? "Original Codex process cleanup remains unconfirmed", false, false);
    if (failure) throw new CodexFailure(compactDiagnostic(failure.message), !isTerminalModelFailure(failure.message) && !/protocol|receipt|frame exceeds/i.test(failure.message), true);
    if (code !== 0 || !completed) {
      const detail = compactDiagnostic(stderr || `Codex exited ${String(code)} without a completed turn`);
      throw new CodexFailure(detail, !isTerminalModelFailure(detail), true);
    }
    if (!threadReceived) throw new CodexFailure("Missing original Codex thread receipt", false, true);
    try { return JSON.parse(message); }
    catch { throw new CodexFailure("Invalid structured Codex JSON response", false, true); }
  } catch (error) {
    if (error instanceof CodexFailure) {
      if (!error.cleanupConfirmed && !closed) {
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref();
      }
      throw error;
    }
    const cleaned = tree ? await stopTree(tree) : closed && !child.pid;
    throw new CodexFailure(compactDiagnostic(error instanceof Error ? error.message : String(error)), false, Boolean(cleaned));
  } finally {
    if (refresh) clearInterval(refresh);
    if (monitor) clearInterval(monitor);
    input.signal.removeEventListener("abort", abort);
    await refreshTask;
  }
}

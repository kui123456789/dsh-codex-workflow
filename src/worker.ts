import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "./state.js";
import { identifyProcess } from "./process.js";
import { runCodex, CodexFailure } from "./codex.js";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { plannerResult, reviewResult } from "./validation.js";
import { collectEvidence } from "./evidence.js";
import { prompt } from "./prompts.js";
import { backoffDelayMs, DEFAULT_BACKOFF, isTransientFailure } from "./transient-retry.js";
import type { WorkflowRecord, Operation } from "./types.js";

export async function worker(home: string, id: string, operationId: string): Promise<void> {
  const store = new StateStore(home);
  const controller = new AbortController();
  let operation: Operation | undefined;
  let claimed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const own = (record: WorkflowRecord) => {
    if (record.operation?.id !== operationId || record.phase === "cancelled") throw new Error("Original workflow operation no longer owns this result");
  };
  const update = (mutate: (record: WorkflowRecord) => void) => store.update(id, (record) => { own(record); mutate(record); });
  try {
    const identity = await identifyProcess(process.pid);
    if (!identity) throw new Error("Worker process identity could not be confirmed");
    const record = update((value) => {
      if (value.operation!.worker || value.operation!.finished) throw new Error("Operation already claimed");
      value.operation!.worker = identity;
    });
    operation = record.operation!;
    claimed = true;
    const directory = join(home, "workflows", id, operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const schema = join(directory, "schema.json");
    await writeFile(schema, JSON.stringify(operation.stage === "planning" ? PLANNER_OUTPUT_SCHEMA : REVIEW_OUTPUT_SCHEMA), { mode: 0o600 });
    const instruction = prompt(record, operation);
    await writeFile(join(directory, "prompt.txt"), instruction, { mode: 0o600 });
    timer = setInterval(() => {
      const current = store.get(id);
      if (!current || current.operation?.id !== operationId || current.phase === "cancelled") controller.abort(new Error("Workflow cancelled or operation ownership changed"));
    }, 100);
    const deadline = performance.now() + record.settings.transientRetryBudgetMs;
    let attempt = 0;
    let output: unknown;
    for (;;) {
      controller.signal.throwIfAborted();
      const current = store.get(id)!;
      own(current);
      const role = operation.stage === "planning" ? "planner" : "reviewer";
      const args = [...record.codexArgs, "exec", "--json", "--sandbox", "read-only", "-c", "approval_policy=never", "--skip-git-repo-check", "--output-schema", schema, "-C", record.cwd];
      const model = record.settings[`${role}Model`], effort = record.settings[`${role}Effort`];
      if (model) args.push("--model", model);
      if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
      if (current.operation!.threadId) args.push("resume", current.operation!.threadId);
      args.push("-");
      update((value) => { value.operation!.spawnRequested = true; value.operation!.cleanupConfirmed = false; });
      const timeout = setTimeout(() => controller.abort(new Error("Codex model turn timeout")), record.settings.turnTimeoutMs);
      try {
        output = await runCodex({ command: record.codexCommand, args, cwd: record.cwd,
          prompt: attempt === 0 ? instruction : "Continue the original interrupted task. Return its complete result matching the same output schema.", signal: controller.signal,
          onThread: (threadId) => update((value) => {
            const previous = value.operation!.threadId;
            if (previous && previous !== threadId) throw new Error("Codex returned a different original thread receipt");
            value.operation!.threadId = threadId;
            if (operation!.stage === "planning") value.plannerThreadId = threadId;
            else value.reviewerThreadId = threadId;
          }),
          onTree: (tree) => update((value) => { value.operation!.tree = tree; }),
        });
        update((value) => { value.operation!.cleanupConfirmed = true; });
        break;
      } catch (error) {
        const failure = error instanceof CodexFailure ? error : new CodexFailure(String(error), false, false);
        update((value) => { value.operation!.cleanupConfirmed = failure.cleanupConfirmed; });
        const latest = store.get(id)!;
        const delay = backoffDelayMs(attempt, { ...DEFAULT_BACKOFF, budgetMs: record.settings.transientRetryBudgetMs });
        if (!controller.signal.aborted && failure.recoverable && failure.cleanupConfirmed && latest.operation?.threadId && isTransientFailure(failure.message) && performance.now() + delay < deadline) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(wait); controller.signal.removeEventListener("abort", abort); reject(controller.signal.reason); };
            const wait = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, delay);
            controller.signal.addEventListener("abort", abort, { once: true });
          });
          controller.signal.throwIfAborted();
          if (performance.now() >= deadline) throw failure;
          attempt++;
          continue;
        }
        throw failure;
      } finally { clearTimeout(timeout); }
    }
    controller.signal.throwIfAborted();
    if (operation.stage === "planning") {
      const result = plannerResult(output);
      await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      await writeFile(join(directory, "plan.md"), result.planMarkdown, { mode: 0o600 });
      update((value) => {
        value.plan = result;
        value.phase = result.status === "ready" ? "executing" : result.status === "needs_input" ? "waiting_input" : "failed";
        value.processState = result.status === "failed" ? "failed" : "waiting";
        if (result.status === "failed") value.error = result.message || "Planner failed";
        value.operation!.finished = true;
      });
    } else {
      const result = reviewResult(output);
      const after = await collectEvidence({ cwd: record.cwd, maxDiffBytes: 65536, changedFiles: record.reviewInput?.changedFiles });
      if (after.insufficient || after.fingerprint !== operation.evidence?.fingerprint) throw new Error("Workspace evidence changed during review; result was not accepted");
      await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      const markdown = [`# ${result.verdict}`, result.summary, ...result.findings.map((finding) => `## ${finding.severity}: ${finding.title}\n${finding.file ?? ""}${finding.line ? `:${finding.line}` : ""}\n${finding.body}`), ...result.testGaps.map((gap) => `Test gap: ${gap}`)].join("\n\n");
      await writeFile(join(directory, "review.md"), markdown, { mode: 0o600 });
      update((value) => {
        value.review = result;
        value.evidence = after;
        value.noChangeReviewRounds = value.previousFingerprint === after.fingerprint ? value.noChangeReviewRounds + 1 : 0;
        value.previousFingerprint = after.fingerprint;
        value.reviewCycles++;
        const blocking = result.findings.some((finding) => finding.blocking) || result.testGaps.length > 0;
        value.phase = result.verdict === "pass" ? "passed" : !blocking ? "waiting_review_decision"
          : value.reviewCycles >= value.settings.maxReviewCycles || value.noChangeReviewRounds >= value.settings.maxNoChangeReviewRounds ? "blocked" : "fixing";
        value.processState = ["passed", "blocked"].includes(value.phase) ? "completed" : "waiting";
        value.operation!.finished = true;
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = store.get(id);
    if (claimed && current?.operation?.id === operationId) {
      store.update(id, (value) => {
        if (value.operation?.id !== operationId) return;
        if (value.phase !== "cancelled") {
          const recoverable = error instanceof CodexFailure && error.recoverable && Boolean(value.operation.threadId);
          value.error = message;
          value.phase = recoverable ? value.operation.stage === "planning" ? "planning" : "reviewing" : "failed";
          value.processState = recoverable ? "waiting" : "failed";
          value.operation.recoverable = recoverable;
          value.operation.failureReason = /Workspace evidence changed/.test(message) ? "workspace_changed" : !value.operation.threadId && value.operation.spawnRequested ? "start_receipt_missing" : "model_failed";
        }
        if (error instanceof CodexFailure) value.operation.cleanupConfirmed = error.cleanupConfirmed;
        value.operation.finished = true;
      });
    }
  } finally {
    if (timer) clearInterval(timer);
    store.close();
  }
}

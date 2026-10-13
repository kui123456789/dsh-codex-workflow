import type { WorkflowRuntimeState } from "../../src/application/workflow-runtime-state.js";
import { reviewToolTimeout } from "../../src/tools.js";
import type { WorkflowConfig, WorkflowRecord } from "../../src/types.js";
import type { WorkflowManager } from "../../src/workflow.js";

/** Observe only tasks already admitted by this fixture's Manager. Call after
 * submit/recover and after releasing any intentionally held model gate.
 * Final record predicates remain the caller's independent assertions. */
export async function settleWorkflowBackground(manager: WorkflowManager, config: WorkflowConfig,
  workflowId: string): Promise<PromiseSettledResult<unknown>[]> {
  const original = manager as unknown as { runtime: WorkflowRuntimeState;
    store: { snapshot(id: string): WorkflowRecord | undefined } };
  const tasks = [...original.runtime.backgroundTasks];
  if (!tasks.length) return [];
  const rpcTimeoutMs = config.rpcTimeoutMs ?? Math.max(5000, Math.min(config.turnTimeoutMs, 60_000));
  // These fixtures use App Server review only. Use its existing complete
  // operation allowance, including control RPCs/readback/cleanup, as a
  // diagnostic watchdog rather than treating a short poll as model failure.
  const watchdogMs = reviewToolTimeout(config.turnTimeoutMs, rpcTimeoutMs, config.transientRetryBudgetMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled(tasks),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const record = original.store.snapshot(workflowId);
          reject(new Error(`Original admitted background tasks did not settle within the fixture operation budget: ${JSON.stringify({
            watchdogMs, admittedTasks: tasks.length, pendingTasks: original.runtime.backgroundTasks.size,
            phase: record?.phase, submissionState: record?.submissionState,
            reviewStep: record?.reviewStep, submissionAttempts: record?.submissionAttempts,
            leaseHeld: Boolean(record?.submissionLeaseToken),
          })}`));
        }, watchdogMs);
      }),
    ]);
    // Scope/lease rejection is the intended result in several fixtures. As
    // with their original allSettled drains, preserve that result and let the
    // caller's unchanged record/resource assertions decide correctness.
    return outcomes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

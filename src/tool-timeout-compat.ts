/** The installed DSH timeout policy and Node timers support signed 32-bit delays. */
export const MAX_HOST_TOOL_TIMEOUT_MS = 2_147_483_647;

/** Reject unsupported complete-operation budgets without shortening legitimate work. */
export function assertWorkflowToolTimeout(name: string, timeoutMs: number): void {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_HOST_TOOL_TIMEOUT_MS) return;
  throw new RangeError(
    `Workflow tool ${name} has an unsupported complete-operation timeout (${timeoutMs} ms). `
    + `The DSH host supports positive finite deadlines up to ${MAX_HOST_TOOL_TIMEOUT_MS} ms. `
    + "Adjust turnTimeoutMs, rpcTimeoutMs, transientRetryBudgetMs or callbackTimeoutMs; "
    + "the workflow budget cannot be shortened silently to fit the host timer.",
  );
}

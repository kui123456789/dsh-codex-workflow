import type { LifecyclePort } from "../ports.js";
import type { WorkflowRecord } from "../types.js";

/** Application boundary for workflow observation, cancellation and teardown. */
export class LifecycleFlow {
  constructor(private readonly port: LifecyclePort) {}

  status(workflowId: string | undefined, exec: Parameters<LifecyclePort["status"]>[1]): ReturnType<LifecyclePort["status"]> {
    return this.port.status(workflowId, exec);
  }

  cancel(workflowId: string, exec: Parameters<LifecyclePort["cancel"]>[1]): Promise<WorkflowRecord> {
    return this.port.cancel(workflowId, exec);
  }

  stop(): Promise<void> {
    return this.port.stop();
  }
}

import type { SubmissionPort } from "../ports.js";
import type { SubmissionNoticeCommand, SubmitVerdictCommand } from "../bridge-protocol.js";
import type { SubmitInput, WorkflowRecord } from "../types.js";

/** Application boundary for durable bridge submissions and delivery. */
export class SubmissionFlow {
  constructor(private readonly port: SubmissionPort) {}

  submit(workflowId: string, input: SubmitInput, exec: Parameters<SubmissionPort["submit"]>[2]): Promise<WorkflowRecord> {
    return this.port.submit(workflowId, input, exec);
  }

  recoverCallbacks(): Promise<number> {
    return this.port.recoverCallbacks();
  }

  commitVerdictDelivery(command: SubmitVerdictCommand): ReturnType<SubmissionPort["commitVerdictDelivery"]> {
    return this.port.commitVerdictDelivery(command);
  }

  commitSubmissionNoticeDelivery(command: SubmissionNoticeCommand): ReturnType<SubmissionPort["commitSubmissionNoticeDelivery"]> {
    return this.port.commitSubmissionNoticeDelivery(command);
  }
}

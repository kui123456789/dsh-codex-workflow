import type { ReviewPort } from "../ports.js";
import type { SubmitVerdictCommand } from "../bridge-protocol.js";
import type { ReviewInput, WorkflowRecord } from "../types.js";

/** Application boundary for visible and bridge review operations. */
export class ReviewFlow {
  constructor(private readonly port: ReviewPort) {}

  review(workflowId: string, input: ReviewInput, exec: Parameters<ReviewPort["review"]>[2]): Promise<WorkflowRecord> {
    return this.port.review(workflowId, input, exec);
  }

  reviewOnly(
    args: Parameters<ReviewPort["reviewOnly"]>[0],
    exec: Parameters<ReviewPort["reviewOnly"]>[1],
  ): ReturnType<ReviewPort["reviewOnly"]> {
    return this.port.reviewOnly(args, exec);
  }

  applyExternalVerdict(command: SubmitVerdictCommand): Promise<WorkflowRecord> {
    return this.port.applyExternalVerdict(command);
  }

  assertVerdictStillValid(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }> {
    return this.port.assertVerdictStillValid(command);
  }
}

import type { SubmissionPort } from "../../ports.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DispatchPlanCommand, SubmissionNoticeCommand, SubmitVerdictCommand } from "../../bridge-protocol.js";
import type { WorkflowRecord } from "../../types.js";

export type BridgeDeliveryPort = SubmissionPort & {
  startExternalPlan(command: DispatchPlanCommand, agent: Agent): Promise<WorkflowRecord>;
  applyExternalVerdict(command: SubmitVerdictCommand): Promise<WorkflowRecord>;
  assertVerdictStillValid(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }>;
};

/** Application seam for recovering durable callback deliveries. */
export class DeliveryCoordinator {
  constructor(private readonly port: BridgeDeliveryPort) {}

  recoverCallbacks(): Promise<number> {
    return this.port.recoverCallbacks();
  }

  startExternalPlan(command: DispatchPlanCommand, agent: Agent): Promise<WorkflowRecord> {
    return this.port.startExternalPlan(command, agent);
  }

  applyExternalVerdict(command: SubmitVerdictCommand): Promise<WorkflowRecord> {
    return this.port.applyExternalVerdict(command);
  }

  assertVerdictStillValid(command: SubmitVerdictCommand): Promise<{ invalidated: boolean; record: WorkflowRecord }> {
    return this.port.assertVerdictStillValid(command);
  }

  commitSubmissionNoticeDelivery(command: SubmissionNoticeCommand): ReturnType<SubmissionPort["commitSubmissionNoticeDelivery"]> {
    return this.port.commitSubmissionNoticeDelivery(command);
  }

  commitVerdictDelivery(command: SubmitVerdictCommand): ReturnType<SubmissionPort["commitVerdictDelivery"]> {
    return this.port.commitVerdictDelivery(command);
  }
}

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { PlannerPort } from "../ports.js";
import type { DispatchPlanCommand } from "../bridge-protocol.js";
import type { WorkflowRecord } from "../types.js";

/** Application boundary for planning operations. */
export class PlannerFlow {
  constructor(private readonly port: PlannerPort) {}

  start(
    args: Parameters<PlannerPort["start"]>[0],
    exec: Parameters<PlannerPort["start"]>[1],
  ): ReturnType<PlannerPort["start"]> {
    return this.port.start(args, exec);
  }

  continue(
    workflowId: string,
    answers: Record<string, string[]>,
    exec: Parameters<PlannerPort["continue"]>[2],
  ): Promise<WorkflowRecord> {
    return this.port.continue(workflowId, answers, exec);
  }

  startExternalPlan(command: DispatchPlanCommand, agent: Agent): Promise<WorkflowRecord> {
    return this.port.startExternalPlan(command, agent);
  }

  onTurnStopping(agent: Agent, turn: number): Promise<void> {
    return this.port.onTurnStopping(agent, turn);
  }

  decide(
    workflowId: string,
    input: Parameters<PlannerPort["decide"]>[1],
    exec: Parameters<PlannerPort["decide"]>[2],
  ): ReturnType<PlannerPort["decide"]> {
    return this.port.decide(workflowId, input, exec);
  }
}

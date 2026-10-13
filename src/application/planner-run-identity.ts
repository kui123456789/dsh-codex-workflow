import type { WorkflowPhase, WorkflowRecord } from "../types.js";

/** Immutable scope of the original Planner; model choices may resolve later. */
export type PlannerRunIdentity = Pick<WorkflowRecord, "id" | "dshSessionId" | "cwd" | "task" | "createdAt">;

export function plannerRunIdentity(record: PlannerRunIdentity): PlannerRunIdentity {
  const { id, dshSessionId, cwd, task, createdAt } = record;
  return Object.freeze({ id, dshSessionId, cwd, task, createdAt });
}

export function assertPlannerRunIdentity(expected: PlannerRunIdentity, current: WorkflowRecord | undefined): asserts current is WorkflowRecord {
  if (!current || current.id !== expected.id || current.dshSessionId !== expected.dshSessionId
    || current.cwd !== expected.cwd || current.task !== expected.task || current.createdAt !== expected.createdAt) {
    throw new Error(`workflow ${expected.id} lost its original Planner owner or workspace identity`);
  }
}

/** Call inside each SQLite mutation as well as after asynchronous work. */
export function assertPlannerRun(expected: PlannerRunIdentity, current: WorkflowRecord | undefined,
  phase: WorkflowPhase = "planning"): asserts current is WorkflowRecord {
  assertPlannerRunIdentity(expected, current);
  if (current.phase !== phase) {
    throw new Error(`workflow ${expected.id} changed its Planner phase from ${phase} to ${current.phase}`);
  }
}

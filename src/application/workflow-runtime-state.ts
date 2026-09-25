import type { TurnNeedsInputResult } from "../types.js";

export interface ActiveWorkflowTurn {
  threadId: string;
  turnId: string;
  kind: "planner" | "reviewer";
  ephemeral: boolean;
}

/** Mutable in-process lifecycle state shared by the application flows. */
export class WorkflowRuntimeState {
  readonly pending = new Map<string, TurnNeedsInputResult>();
  readonly nudgedTurns = new Set<string>();
  readonly recovering = new Set<string>();
  readonly recoveringNotices = new Set<string>();
  readonly activeTurns = new Map<string, ActiveWorkflowTurn>();
  readonly foreground = new Set<Promise<unknown>>();
  readonly backgroundTasks = new Set<Promise<unknown>>();
  readonly submissionControllers = new Map<string, AbortController>();
  readonly reviewHeartbeats = new Map<string, NodeJS.Timeout>();
  readonly cleanupNotes = new Map<string, string[]>();
  stopped = false;
  stopPromise?: Promise<void>;
  readonly lifecycleController = new AbortController();
  recoveryChain?: Promise<void>;
  activeRecovery = false;
}

import { randomUUID } from "node:crypto";
import type { WorkflowStore } from "../store.js";
import type { ProcessInstanceIdentity, WorkflowTerminalCleanupMarker } from "../types.js";
import { isWorkflowTerminalCleanupMarker } from "../state/workflow-schema.js";
import type { RecoverableWorkflowRun } from "./workflow-runtime-state.js";
import { originalProcessTreeExited, type ProcessInstanceProbe, type ProcessTreeEvidence } from "../infrastructure/process-transport.js";

const PREFIX = "terminal-cleanup:";
interface Descriptor {
  kind: "terminal-cleanup-v1";
  token: string;
  workflowId: string;
  sessionId: string;
  confirmed?: boolean;
  processId?: number;
  processIds?: readonly number[];
  processIdentities?: readonly ProcessInstanceIdentity[];
}

type CleanupRun = Pick<RecoverableWorkflowRun, "terminalFailure" | "originalProcessId" | "originalProcessIds">
  & { originalProcessIdentities?: readonly ProcessInstanceIdentity[];
    state?: Pick<RecoverableWorkflowRun["state"], "awaitingStartReceipt">;
    plannerIdentity?: { dshSessionId: string }; reviewerIdentity?: { dshSessionId: string } };
type HeldCleanup = { resource: string; owner: string; marker: WorkflowTerminalCleanupMarker; identity: object; scope: string };
type GuardRow = { resource: string; owner: string; epoch: number };

function sameMarker(a: WorkflowTerminalCleanupMarker, b: WorkflowTerminalCleanupMarker): boolean {
  return a.token === b.token && a.epoch === b.epoch && a.sessionId === b.sessionId;
}

export function terminalCleanupTarget(run: RecoverableWorkflowRun): { threadId: string; turnId: string } | undefined {
  return run.cleanupTarget ?? run.auxiliaryInterruption
    ?? (run.interruptionTurnId ? { threadId: run.threadId, turnId: run.interruptionTurnId } : undefined);
}

/** A lost SDK view is insufficient: every captured original process must exit. */
export function terminalProcessTreeExited(value: ProcessTreeEvidence, probe?: ProcessInstanceProbe): Promise<boolean> {
  return originalProcessTreeExited(value, probe);
}

/** A rejected writer remains a guard even when its ordinary lease TTL elapsed.
 * Only its owning confirmation or a proven whole-process-tree exit releases it.
 * The descriptor contains no ephemeral thread, turn, child or model output. */
export class TerminalCleanupGuard {
  private readonly held = new Map<string, HeldCleanup>();
  private readonly originals = new WeakMap<object, HeldCleanup>();
  constructor(private readonly store: WorkflowStore, private readonly probe?: ProcessInstanceProbe) {}

  retain(workflowId: string, run: CleanupRun, runIdentity: object = run): WorkflowTerminalCleanupMarker | undefined {
    if (!run.terminalFailure && !run.state?.awaitingStartReceipt) return;
    const sessionId = run.plannerIdentity?.dshSessionId ?? run.reviewerIdentity?.dshSessionId;
    if (!sessionId) throw new Error("terminal cleanup has no original session owner");
    const scope = JSON.stringify([workflowId, sessionId, run.originalProcessId ?? null,
      run.originalProcessIds ? [...run.originalProcessIds].sort((a, b) => a - b) : null,
      run.originalProcessIdentities ? run.originalProcessIdentities.map((identity) => ({ ...identity }))
        .sort((a, b) => a.processId - b.processId) : null]);
    const original = this.originals.get(runIdentity);
    if (original) {
      if (original.scope !== scope) throw new Error("original terminal cleanup owner generation changed");
      return original.marker;
    }
    if (this.held.has(workflowId)) throw new Error("original terminal cleanup is already held by a different owner generation");
    const resource = `${PREFIX}${sessionId}:${workflowId}`;
    const descriptor: Descriptor = { kind: "terminal-cleanup-v1", token: randomUUID(), workflowId, sessionId,
      ...(run.originalProcessId ? { processId: run.originalProcessId } : {}),
      ...(run.originalProcessIds ? { processIds: Object.freeze([...run.originalProcessIds]) } : {}),
      ...(run.originalProcessIdentities ? { processIdentities: Object.freeze(run.originalProcessIdentities
        .map((identity) => Object.freeze({ ...identity }))) } : {}) };
    const owner = JSON.stringify(descriptor);
    const grant = this.store.coordinationHandle.acquireLease(resource, 60_000, owner);
    if (!grant) throw new Error("original terminal cleanup is already guarded by another owner");
    const marker = Object.freeze({ token: descriptor.token, epoch: grant.epoch, sessionId });
    const held = { resource, owner, marker, identity: runIdentity, scope };
    this.held.set(workflowId, held);
    this.originals.set(runIdentity, held);
    return marker;
  }

  release(workflowId: string, marker?: WorkflowTerminalCleanupMarker): void {
    const held = this.held.get(workflowId);
    if (!held || !isWorkflowTerminalCleanupMarker(marker) || !sameMarker(held.marker, marker)) return;
    const descriptor = JSON.parse(held.owner) as Descriptor;
    // Keep an independent confirmation receipt when the workflow's scope
    // changed; an obsolete owner must not rewrite that newer workflow row.
    this.store.coordinationHandle.db.prepare(
      "UPDATE leases SET owner = ?, lease_until = 0 WHERE resource = ? AND epoch = ? AND owner = ?",
    ).run(JSON.stringify({ ...descriptor, confirmed: true }), held.resource, held.marker.epoch, held.owner);
    this.held.delete(workflowId);
  }

  isConfirmed(workflowId: string, marker?: WorkflowTerminalCleanupMarker): boolean {
    if (!isWorkflowTerminalCleanupMarker(marker)) return false;
    const row = this.store.coordinationHandle.db.prepare("SELECT owner, epoch FROM leases WHERE resource = ?")
      .get(`${PREFIX}${marker.sessionId}:${workflowId}`) as { owner: string; epoch: number } | undefined;
    if (!row || row.epoch !== marker.epoch) return false;
    try {
      const value = JSON.parse(row.owner) as Descriptor;
      return value.kind === "terminal-cleanup-v1" && value.workflowId === workflowId && value.sessionId === marker.sessionId
        && value.token === marker.token && value.confirmed === true;
    } catch { return false; }
  }

  private rows(): GuardRow[] {
    return this.store.coordinationHandle.db.prepare(
      "SELECT resource, owner, epoch FROM leases WHERE owner IS NOT NULL AND resource LIKE ?",
    ).all(`${PREFIX}%`) as GuardRow[];
  }

  private relevantRows(sessionId?: string, workflowId?: string): GuardRow[] {
    return this.rows().filter((row) => {
      if (sessionId && row.resource.startsWith(`${PREFIX}${sessionId}:`)
        || workflowId && row.resource.endsWith(`:${workflowId}`)) return true;
      try {
        const descriptor = JSON.parse(row.owner) as Descriptor;
        return descriptor?.kind === "terminal-cleanup-v1"
          && (sessionId === descriptor.sessionId || workflowId === descriptor.workflowId);
      } catch { return false; }
    }).sort((a, b) => a.resource.localeCompare(b.resource));
  }

  async assertAvailable(sessionId?: string, workflowId?: string): Promise<void> {
    const rows = this.relevantRows(sessionId, workflowId);
    const assertOriginalRows = () => {
      if (JSON.stringify(this.relevantRows(sessionId, workflowId)) !== JSON.stringify(rows)) {
        throw new Error("original terminal cleanup guard generation changed; no replacement will be started");
      }
    };
    for (const row of rows) {
      let descriptor: Descriptor | undefined;
      try { descriptor = JSON.parse(row.owner) as Descriptor; } catch { /* Unknown guards cannot authorize work. */ }
      if (descriptor?.kind !== "terminal-cleanup-v1") {
        if (sessionId && row.resource.startsWith(`${PREFIX}${sessionId}:`) || workflowId && row.resource.endsWith(`:${workflowId}`)) {
          throw new Error("original terminal cleanup guard is unreadable; no replacement will be started");
        }
        continue;
      }
      if (sessionId !== descriptor.sessionId && workflowId !== descriptor.workflowId) {
        throw new Error("original terminal cleanup guard owner is inconsistent; no replacement will be started");
      }
      if (descriptor.confirmed === true) continue;
      const exited = await terminalProcessTreeExited(descriptor, this.probe);
      // The metadata query can yield to a successor owner or a newly added
      // guard. Neither may borrow the predecessor's exit confirmation.
      assertOriginalRows();
      if (exited) {
        const owner = JSON.stringify({ ...descriptor, confirmed: true });
        const result = this.store.coordinationHandle.db.prepare(
          "UPDATE leases SET owner = ?, lease_until = 0 WHERE resource = ? AND epoch = ? AND owner = ?",
        ).run(owner, row.resource, row.epoch, row.owner);
        if (Number(result.changes) !== 1) {
          throw new Error("original terminal cleanup guard generation changed; no replacement will be started");
        }
        row.owner = owner;
        continue;
      }
      throw new Error(`workflow ${descriptor.workflowId} has unconfirmed original terminal cleanup; no replacement will be started`);
    }
    assertOriginalRows();
  }
}

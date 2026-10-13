import { randomUUID } from "node:crypto";
import type { WorkflowStore } from "../store.js";
import type { TokenUsageSnapshot } from "../usage-accounting.js";
import { assertPlannerRunIdentity, plannerRunIdentity, type PlannerRunIdentity } from "./planner-run-identity.js";
import { mergeWorkflowObservedUsage, observeUsageSource,
  type WorkflowObservedUsage, type WorkflowUsageSource, type WorkflowUsageStage } from "../workflow-usage.js";

export interface WorkflowUsageGateway {
  captureThreadOwner?(threadId: string): object | undefined;
  getThreadTokenUsage?(threadId: string): TokenUsageSnapshot | undefined;
  onTokenUsage?(listener: (snapshot: TokenUsageSnapshot) => void): () => void;
}

interface Binding {
  workflowId: string;
  threadId: string;
  threadOwner?: object;
  owner?: string;
  scope?: PlannerRunIdentity;
  source: WorkflowUsageSource;
  persisted?: string;
}

/** Records metering independently of business-phase fences; it never changes a workflow's phase or verdict. */
export class WorkflowUsageObserver {
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, Map<string, { binding: Binding; source: WorkflowUsageSource }>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  private readonly unsubscribe?: () => void;
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly store: WorkflowStore, private readonly gateway: WorkflowUsageGateway) {
    this.unsubscribe = gateway.onTokenUsage?.((snapshot) => {
      try {
        const binding = this.bindings.get(snapshot.threadId);
        if (!binding || this.stopped) return;
        this.capture(binding, snapshot);
        void this.schedule(binding.workflowId);
      } catch { /* Telemetry cannot fail a model turn or expose upstream data. */ }
    });
  }

  async bind(workflowId: string, threadId: string, stage: WorkflowUsageStage, model?: string,
    expected?: PlannerRunIdentity, expectedOwner?: object): Promise<void> {
    if (this.stopped) return;
    const scope = expected ? plannerRunIdentity(expected) : undefined;
    if (scope && scope.id !== workflowId) throw new Error("workflow usage binding identity mismatch");
    const threadOwner = expectedOwner ?? this.gateway.captureThreadOwner?.(threadId);
    const assertCurrentOwner = () => {
      if (this.gateway.captureThreadOwner && (!threadOwner || this.gateway.captureThreadOwner(threadId) !== threadOwner)) {
        throw new Error("workflow usage original thread owner is unavailable");
      }
    };
    assertCurrentOwner();
    let binding = this.bindings.get(threadId);
    if (binding && this.gateway.captureThreadOwner && binding.threadOwner !== threadOwner) {
      this.capture(binding);
      await this.drain(binding.workflowId);
      assertCurrentOwner();
      if (this.bindings.get(threadId) === binding) this.bindings.delete(threadId);
      binding = this.bindings.get(threadId);
    }
    if (binding && binding.threadOwner !== threadOwner) throw new Error("workflow usage binding owner changed");
    if (binding && (binding.workflowId !== workflowId || binding.source.stage !== stage)) {
      throw new Error("workflow usage binding identity mismatch");
    }
    if (binding && scope && JSON.stringify(binding.scope) !== JSON.stringify(scope)) {
      throw new Error("workflow usage binding scope mismatch");
    }
    if (!binding) {
      binding = { workflowId, threadId, threadOwner, ...(scope ? { scope, owner: scope.dshSessionId } : {}),
        source: { sourceId: randomUUID(), stage, ...(model ? { model } : {}) } };
      this.bindings.set(threadId, binding);
      if (!scope) {
        try { binding.owner = (await this.store.load(workflowId))?.dshSessionId; }
        catch { this.errors.set(workflowId, "Usage persistence unavailable; reported snapshots are pending retry."); }
        assertCurrentOwner();
        if (this.bindings.get(threadId) !== binding) throw new Error("workflow usage binding owner changed");
      }
    } else if (model && !binding.source.modelMixed) {
      if (binding.source.model && binding.source.model !== model) {
        const mixed = { ...binding.source, modelMixed: true };
        delete mixed.model;
        binding.source = mixed;
      } else if (!binding.source.model) binding.source = { ...binding.source, model };
    }
    this.capture(binding);
    await this.schedule(workflowId);
    assertCurrentOwner();
  }

  async flush(workflowId?: string): Promise<void> {
    for (const binding of this.bindings.values()) {
      if (workflowId === undefined || binding.workflowId === workflowId) this.capture(binding);
    }
    const ids = workflowId === undefined ? [...new Set([...this.pending.keys(), ...this.writes.keys()])] : [workflowId];
    await Promise.all(ids.map((id) => this.drain(id)));
  }

  release(threadId: string): Promise<void>;
  release(workflowId: string, threadId: string): Promise<void>;
  async release(workflowIdOrThread: string, threadId?: string): Promise<void> {
    const id = threadId ?? workflowIdOrThread;
    const binding = this.bindings.get(id);
    if (!binding) return;
    if (threadId !== undefined && binding.workflowId !== workflowIdOrThread) {
      throw new Error("workflow usage binding identity mismatch");
    }
    this.capture(binding);
    await this.drain(binding.workflowId);
    if (this.bindings.get(id) === binding) this.bindings.delete(id);
  }

  async releaseOwned(threadId: string, expectedOwner?: object, workflowId?: string): Promise<void> {
    const binding = this.bindings.get(threadId);
    if (!binding || binding.threadOwner !== expectedOwner || (workflowId && binding.workflowId !== workflowId)) return;
    if (workflowId) await this.release(workflowId, threadId);
    else await this.release(threadId);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.unsubscribe?.();
    this.stopPromise = this.flush().finally(() => {
      this.bindings.clear(); this.writes.clear();
      // Keep only opaque sources and the fixed diagnostic if disk writes
      // failed, so a caller can inspect and explicitly retry after stop.
      for (const entries of this.pending.values()) {
        for (const { binding } of entries.values()) binding.threadId = "";
      }
    });
    return this.stopPromise;
  }

  getPersistenceError(workflowId: string): string | undefined { return this.errors.get(workflowId); }

  private async drain(workflowId: string): Promise<void> {
    let task = this.schedule(workflowId);
    for (;;) {
      await task;
      const current = this.writes.get(workflowId);
      if (current && current !== task) { task = current; continue; }
      // Failed writes keep their payload for the next explicit flush rather
      // than spinning on a storage error in the model's completion path.
      if (this.errors.has(workflowId) || !this.pending.get(workflowId)?.size) return;
      task = this.schedule(workflowId);
    }
  }

  private capture(binding: Binding, supplied?: TokenUsageSnapshot): void {
    let snapshot = supplied;
    const current = !this.gateway.captureThreadOwner || Boolean(binding.threadOwner
      && this.gateway.captureThreadOwner(binding.threadId) === binding.threadOwner);
    if (!current) snapshot = undefined;
    try { if (current) snapshot ??= this.gateway.getThreadTokenUsage?.(binding.threadId); }
    catch { this.errors.set(binding.workflowId, "Usage snapshot unavailable; the source remains partially observed."); }
    if (snapshot?.threadId === binding.threadId) binding.source = observeUsageSource(binding.source, snapshot);
    const signature = JSON.stringify(binding.source);
    if (signature === binding.persisted) return;
    const sources = this.pending.get(binding.workflowId) ?? new Map();
    if (JSON.stringify(sources.get(binding.source.sourceId)?.source) !== signature) {
      sources.set(binding.source.sourceId, { binding, source: JSON.parse(signature) as WorkflowUsageSource });
    }
    this.pending.set(binding.workflowId, sources);
  }

  private schedule(workflowId: string): Promise<void> {
    if (!this.pending.get(workflowId)?.size) return this.writes.get(workflowId) ?? Promise.resolve();
    const previous = this.writes.get(workflowId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const pending = this.pending.get(workflowId);
      const updates = [...(pending?.values() ?? [])];
      if (!updates.length) return;
      try {
        await this.store.update(workflowId, (record) => {
          for (const { binding } of updates) {
            if (binding.scope) assertPlannerRunIdentity(binding.scope, record);
            if (binding.owner !== undefined && record.dshSessionId !== binding.owner) throw new Error("workflow usage owner mismatch");
            binding.owner ??= record.dshSessionId;
          }
          const usageRecord = record as typeof record & { observedUsage?: WorkflowObservedUsage };
          usageRecord.observedUsage = mergeWorkflowObservedUsage(usageRecord.observedUsage, updates.map((entry) => entry.source));
        }, { ignoreCancelled: true });
        for (const update of updates) {
          update.binding.persisted = JSON.stringify(update.source);
          if (pending?.get(update.source.sourceId) === update) pending.delete(update.source.sourceId);
        }
        if (!pending?.size) this.pending.delete(workflowId);
        this.errors.delete(workflowId);
      } catch {
        this.errors.set(workflowId, "Usage persistence unavailable; reported snapshots are pending retry.");
      }
    });
    this.writes.set(workflowId, task);
    void task.finally(() => { if (this.writes.get(workflowId) === task) this.writes.delete(workflowId); }).catch(() => undefined);
    return task;
  }
}

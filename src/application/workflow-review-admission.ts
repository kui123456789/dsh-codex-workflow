import { AsyncLocalStorage } from "node:async_hooks";
import type { CoordinationStore } from "../coordination.js";
import type { WorkflowStore } from "../store.js";
import type { ManagerLease } from "../workflow.js";

interface ReviewWriteFence {
  workflowId: string;
  active: boolean;
  assertOwned(): void;
}

/** Fences only writes descended from one admitted foreground review. Public
 * cancellation/status and other workflow writes retain their own authority. */
export class WorkflowReviewAdmission {
  private readonly current = new AsyncLocalStorage<ReviewWriteFence | undefined>();

  protect(store: WorkflowStore): WorkflowStore {
    return new Proxy(store, {
      get: (target, property) => {
        if (property === "update") {
          const update: WorkflowStore["update"] = (id, mutate, options) => target.update(id, (record) => {
            const fence = this.current.getStore();
            // This runs inside the store's revision-CAS SQLite transaction.
            // Checking the lease before opening that transaction is insufficient.
            if (fence?.workflowId === id) fence.assertOwned();
            return mutate(record);
          }, options);
          return update;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async run<T>(workflowId: string, resource: string, lease: Pick<ManagerLease, "owner" | "epoch">,
    coordination: CoordinationStore, controller: AbortController, work: () => Promise<T>): Promise<T> {
    const lost = new Error(`workflow ${workflowId} lost its review admission lease`);
    const fence: ReviewWriteFence = {
      workflowId, active: true,
      assertOwned: () => {
        if (!fence.active || !coordination.isLeaseOwner(resource, lease.epoch, lease.owner)) {
          controller.abort(lost);
          throw lost;
        }
      },
    };
    try { return await this.current.run(fence, work); }
    finally { fence.active = false; }
  }

  assertOwned(): void { this.current.getStore()?.assertOwned(); }
  owns(workflowId: string): boolean {
    const fence = this.current.getStore();
    if (fence?.workflowId !== workflowId) return false;
    fence.assertOwned();
    return true;
  }
  without<T>(work: () => T): T { return this.current.run(undefined, work); }
}

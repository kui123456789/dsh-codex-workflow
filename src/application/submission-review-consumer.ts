import type { CodexChildSessionHandle } from "../codex-child-session.js";
import { SubmissionReviewContextError } from "./submission-review-checkpoint.js";

/** One admitted lease's authority over an in-process review conversation.
 * Registration ownership survives SQL lease loss until a valid local handoff.
 * Publishing and adoption use the separate live admission guard. */
export interface SubmissionReviewConsumer {
  readonly key: string;
  readonly workflowId: string;
  readonly submissionId: string;
  readonly owner: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  adopt(): void;
  cancelWait(reason: Error): void;
  close(cleanup: () => Promise<void>): Promise<void>;
}

export class SubmissionReviewUnavailableError extends Error {}

interface Registration {
  consumer: SubmissionReviewConsumer;
  identity: string;
  child?: CodexChildSessionHandle;
  closing: boolean;
  canPublish(): boolean;
}

interface ConsumerOptions {
  workflowId: string;
  submissionId: string;
  owner: string;
  epoch: number;
  identity: string;
  child?: CodexChildSessionHandle;
  signal?: AbortSignal;
  /** Consumer-aware callbacks must never rebuild a retired ephemeral run.
   * Legacy adapters retain their independent durable retry contract. */
  requireOriginal?: boolean;
  canAdopt(): boolean;
  canRetire?(): boolean;
}

/** Keeps transfer, cancellation and exactly-once child cleanup at one seam. */
export class SubmissionReviewConsumers {
  private readonly current = new Map<string, Registration>();
  private readonly closedChildren = new WeakSet<CodexChildSessionHandle>();
  private readonly retired = new Set<string>();

  assertOriginalAvailable(workflowId: string, submissionId: string): void {
    const key = `${workflowId}:${submissionId}`;
    if (this.retired.has(key) || !this.current.has(key) || this.current.get(key)?.closing) {
      throw new SubmissionReviewUnavailableError("original ephemeral Reviewer consumer is retired or unavailable in this process; refusing to create a replacement");
    }
  }

  captureRetirement(options: ConsumerOptions): (cleanup: (owner: SubmissionReviewConsumer) => Promise<void>) => Promise<void> {
    const key = `${options.workflowId}:${options.submissionId}`;
    const original = this.current.get(key) ?? (options.child ? [...this.current.values()].find((registration) =>
      registration.consumer.workflowId === options.workflowId && registration.child === options.child) : undefined);
    return async (cleanup) => {
      // A rejected handoff may retire the original private resources, without
      // acquiring their publishing authority. Never retire an adopted successor.
      if (!original || this.current.get(original.consumer.key) !== original || original.child !== options.child
        || (original.consumer.key === key && original.consumer.epoch >= options.epoch) || original.canPublish()
        || !(options.canRetire ?? options.canAdopt)()) return;
      await original.consumer.close(() => cleanup(original.consumer));
    };
  }

  prepare(options: ConsumerOptions): SubmissionReviewConsumer {
    const key = `${options.workflowId}:${options.submissionId}`;
    if (options.requireOriginal !== false && this.retired.has(key)) {
      throw new SubmissionReviewUnavailableError("original ephemeral Reviewer consumer was retired and is unavailable; no replacement will be created");
    }
    const previous = this.current.get(key);
    const assertContext = (registration: Registration | undefined) => {
      if (registration && (registration.identity !== options.identity || registration.child !== options.child)) {
        throw new SubmissionReviewContextError("original review consumer context changed; refusing to transfer its resources");
      }
      if (registration?.closing || (options.child && this.closedChildren.has(options.child))) {
        throw new SubmissionReviewContextError("original review consumer is closing or unavailable; no replacement will be created");
      }
    };
    assertContext(previous);
    if (previous?.consumer.owner === options.owner && previous.consumer.epoch === options.epoch) return previous.consumer;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let closeTask: Promise<void> | undefined;
    const consumer: SubmissionReviewConsumer = {
      key, workflowId: options.workflowId, submissionId: options.submissionId,
      owner: options.owner, epoch: options.epoch, signal,
      isCurrent: () => this.current.get(key)?.consumer === consumer,
      adopt: () => {
        const existing = this.current.get(key);
        assertContext(existing);
        if (signal.aborted || !options.canAdopt()) {
          throw new SubmissionReviewContextError("review consumer adoption no longer owns its admitted scope");
        }
        if (existing?.consumer === consumer) return;
        if (existing && options.epoch <= existing.consumer.epoch) {
          throw new SubmissionReviewContextError("review consumer adoption belongs to an obsolete lease generation");
        }
        this.current.set(key, registration);
        existing?.consumer.cancelWait(new Error("original review consumer was superseded by a valid local handoff"));
      },
      cancelWait: (reason) => controller.abort(reason),
      close: (cleanup) => {
        if (closeTask) return closeTask;
        if (!consumer.isCurrent()) return Promise.resolve();
        // Claim closing synchronously. A later caller cannot adopt this child
        // while native finish/disposal is pending, even if the map is removed.
        registration.closing = true;
        if (options.requireOriginal !== false) this.retired.add(key);
        if (options.child) this.closedChildren.add(options.child);
        closeTask = Promise.resolve().then(cleanup).finally(() => {
          if (this.current.get(key) === registration) this.current.delete(key);
        });
        return closeTask;
      },
    };
    const registration: Registration = { consumer, identity: options.identity, child: options.child,
      closing: false, canPublish: options.canAdopt };
    // The initial private owner may clean its resources after SQL loss. A
    // successor is only registered by adopt(), after all request checks pass.
    if (!previous) this.current.set(key, registration);
    return consumer;
  }
}

export interface ReviewerGatewayPort {
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  updateReviewerInstructions?(threadId: string, cwd: string, instructions: string, signal?: AbortSignal): Promise<void>;
  startReviewerThread?(options: { cwd: string; name?: string; model?: string; developerInstructions?: string; ephemeral?: boolean }, signal?: AbortSignal): Promise<string>;
  startReviewerThreadShell?(options: { cwd: string; name?: string; model?: string; developerInstructions?: string; ephemeral?: boolean }, signal?: AbortSignal): Promise<string>;
  configureReviewerThread?(threadId: string, options: { cwd: string; name?: string; model?: string; developerInstructions?: string; ephemeral?: boolean; expectedOwner?: object }, signal?: AbortSignal): Promise<void>;
  unsubscribeThread?(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<unknown>;
  releaseThreadForExternal?(threadId: string, signal?: AbortSignal): Promise<void>;
  nameThread?(threadId: string, name: string, signal?: AbortSignal): Promise<void>;
}
export interface ReviewerStartOptions {
  expectedOwner?: object;
  cwd: string;
  name?: string;
  model?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
}

/** Deep seam for Reviewer lifecycle operations; retry policy remains in flows. */
export class ReviewerGateway {
  constructor(private readonly port: ReviewerGatewayPort) {}

  resume(threadId: string, cwd: string, signal?: AbortSignal): Promise<void> {
    return this.port.resumeThread(threadId, cwd, signal);
  }

  updateInstructions(threadId: string, cwd: string, instructions: string, signal?: AbortSignal): Promise<void> | undefined {
    return this.port.updateReviewerInstructions?.(threadId, cwd, instructions, signal);
  }

  start(options: ReviewerStartOptions, signal?: AbortSignal): Promise<string> {
    if (!this.port.startReviewerThread) throw new Error("codex gateway has no startReviewerThread");
    return this.port.startReviewerThread(options, signal);
  }

  startShell(options: ReviewerStartOptions, signal?: AbortSignal): Promise<string> | undefined {
    return this.port.startReviewerThreadShell?.(options, signal);
  }

  configure(threadId: string, options: ReviewerStartOptions, signal?: AbortSignal): Promise<void> | undefined {
    return this.port.configureReviewerThread?.(threadId, options, signal);
  }

  unsubscribe(threadId: string, signal?: AbortSignal, expectedOwner?: object): Promise<unknown> | undefined {
    return this.port.unsubscribeThread?.(threadId, signal, expectedOwner);
  }

  externalRelease(threadId: string, signal?: AbortSignal): Promise<void> | undefined {
    return this.port.releaseThreadForExternal?.(threadId, signal);
  }

  rename(threadId: string, name: string, signal?: AbortSignal): Promise<void> | undefined {
    return this.port.nameThread?.(threadId, name, signal);
  }
}

import type { Agent } from "@deepseek-ai/dsh-agent";

export interface TerminalRelayGuardOptions {
  timeoutMs: number;
  isStopped: () => boolean;
}

/** Owns terminal-relay cancellation timers and their teardown fence. */
export class TerminalRelayGuard {
  private readonly controllers = new Set<AbortController>();
  private readonly guards = new Set<Promise<void>>();

  constructor(private readonly options: TerminalRelayGuardOptions) {}

  start(agent: Agent, workflowId: string): void {
    if (this.options.isStopped() || this.options.timeoutMs <= 0) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    let task: Promise<void>;
    task = this.guard(agent, workflowId, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.controllers.delete(controller);
        this.guards.delete(task);
      });
    this.guards.add(task);
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.guards]);
  }

  private async guard(agent: Agent, workflowId: string, signal: AbortSignal): Promise<void> {
    let reachedIdle = false;
    const idle = agent.whenIdle().then(
      () => { reachedIdle = true; },
      () => { reachedIdle = true; },
    );
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<"timeout" | "aborted">((resolvePromise) => {
      timer = setTimeout(() => resolvePromise("timeout"), this.options.timeoutMs);
      timer.unref?.();
      onAbort = () => resolvePromise("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([idle.then(() => "idle" as const), deadline]);
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (outcome !== "timeout") return;
    await Promise.resolve();
    if (reachedIdle || signal.aborted || this.options.isStopped() || agent.status !== "running") return;
    agent.cancel(
      { kind: "hook", reason: `dsh-codex-workflow terminal relay exceeded ${this.options.timeoutMs}ms for workflow ${workflowId}` },
      { keepInbox: true },
    );
    if (signal.aborted) return;
    await Promise.race([
      idle,
      new Promise<void>((resolvePromise) => {
        const abort = () => resolvePromise();
        signal.addEventListener("abort", abort, { once: true });
        void idle.finally(() => signal.removeEventListener("abort", abort));
      }),
    ]);
  }
}

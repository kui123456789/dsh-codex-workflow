import type { AppServerLiveEvent } from "../app-server.js";
import type { CodexLiveEntry, CodexWorkflowSessionEvent } from "../review-events.js";

/** Batches displayable Codex notifications before appending to DSH's durable session log. */
export class LiveRelay {
  private pending: CodexLiveEntry[] = [];
  private timer?: NodeJS.Timeout;
  private accepted = 0;
  private closed = false;

  constructor(
    private readonly workflowId: string,
    private readonly stage: "planning" | "reviewing",
    private readonly reviewId: string | undefined,
    private readonly emit: (event: CodexWorkflowSessionEvent) => void,
  ) {}

  readonly onProgress = (entry: AppServerLiveEvent): void => {
    if (this.closed || !entry.text) return;
    const remaining = 96 * 1024 - this.accepted;
    if (remaining <= 0) return;
    const text = entry.text.slice(0, Math.min(remaining, entry.kind === "tool" ? 300 : 96 * 1024));
    this.accepted += text.length;
    for (let offset = 0; offset < text.length; offset += 2048) {
      this.pending.push({ kind: entry.kind, itemId: entry.itemId.slice(0, 128), text: text.slice(offset, offset + 2048),
        ...(entry.replace && offset === 0 ? { replace: true } : {}) });
      if (this.pending.reduce((size, item) => size + item.text.length, 0) >= 2048) this.flush();
    }
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), 200);
      this.timer.unref();
    }
  };

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const entries = this.pending;
    this.pending = [];
    this.emit({ type: "dsh-codex-workflow/live", data: {
      workflowId: this.workflowId, stage: this.stage,
      ...(this.reviewId ? { reviewId: this.reviewId } : {}),
      entries, at: new Date().toISOString(),
    } });
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}

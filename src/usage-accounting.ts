/** Server-reported usage. Cached input and reasoning output are subsets, not extra totals. */
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Older App Server versions omit cache-write accounting. */
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface TokenUsageSnapshot {
  threadId: string;
  turnId: string;
  total: TokenUsageBreakdown;
  /** The last model response reported by the server; not necessarily an entire turn. */
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

/** One authoritative snapshot per thread: updates replace totals and duplicates are ignored. */
export class ThreadTokenUsageLedger {
  private readonly snapshots = new Map<string, TokenUsageSnapshot>();

  constructor(private readonly maxThreads = 128) {
    if (!Number.isSafeInteger(maxThreads) || maxThreads < 1) throw new Error("usage ledger capacity must be a positive integer");
  }

  record(params: unknown): TokenUsageSnapshot | undefined {
    const snapshot = parseTokenUsageSnapshot(params);
    if (!snapshot) return undefined;
    const previous = this.snapshots.get(snapshot.threadId);
    this.snapshots.delete(snapshot.threadId);
    this.snapshots.set(snapshot.threadId, snapshot);
    if (this.snapshots.size > this.maxThreads) this.snapshots.delete(this.snapshots.keys().next().value!);
    if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return undefined;
    return cloneSnapshot(snapshot);
  }

  get(threadId: string): TokenUsageSnapshot | undefined {
    const snapshot = this.snapshots.get(threadId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  forget(threadId: string): void { this.snapshots.delete(threadId); }
  clear(): void { this.snapshots.clear(); }
  get size(): number { return this.snapshots.size; }
}

export function parseTokenUsageSnapshot(params: unknown): TokenUsageSnapshot | undefined {
  const value = record(params);
  if (!value || typeof value.threadId !== "string" || !value.threadId
    || typeof value.turnId !== "string" || !value.turnId) return undefined;
  const usage = record(value.tokenUsage);
  if (!usage) return undefined;
  const total = breakdown(usage.total);
  const last = breakdown(usage.last);
  const modelContextWindow = usage.modelContextWindow;
  if (!total || !last || (modelContextWindow !== undefined && modelContextWindow !== null && !counter(modelContextWindow))) return undefined;
  return { threadId: value.threadId, turnId: value.turnId, total, last,
    ...(modelContextWindow !== undefined ? { modelContextWindow: modelContextWindow as number | null } : {}) };
}

function breakdown(value: unknown): TokenUsageBreakdown | undefined {
  const usage = record(value);
  if (!usage || !["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]
    .every((field) => counter(usage[field]))) return undefined;
  if (usage.cacheWriteInputTokens !== undefined && !counter(usage.cacheWriteInputTokens)) return undefined;
  return {
    totalTokens: usage.totalTokens as number,
    inputTokens: usage.inputTokens as number,
    cachedInputTokens: usage.cachedInputTokens as number,
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens as number } : {}),
    outputTokens: usage.outputTokens as number,
    reasoningOutputTokens: usage.reasoningOutputTokens as number,
  };
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function cloneSnapshot(snapshot: TokenUsageSnapshot): TokenUsageSnapshot {
  return { ...snapshot, total: { ...snapshot.total }, last: { ...snapshot.last } };
}

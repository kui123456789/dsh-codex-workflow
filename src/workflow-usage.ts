import { parseTokenUsageSnapshot, type TokenUsageBreakdown, type TokenUsageSnapshot } from "./usage-accounting.js";

export type WorkflowUsageStage = "planning" | "reviewing";
export type WorkflowUsageCounter = keyof TokenUsageBreakdown;
export type WorkflowUsageAnomaly = "counter_regression" | "invalid_snapshot";

export interface WorkflowUsageSource {
  /** Random accounting identity; never an App Server thread or turn identifier. */
  sourceId: string;
  stage: WorkflowUsageStage;
  model?: string;
  /** Counters combine model responses; no single-model attribution is valid. */
  modelMixed?: boolean;
  total?: TokenUsageBreakdown;
  last?: TokenUsageBreakdown;
  modelContextWindow?: number | null;
  anomalies?: WorkflowUsageAnomaly[];
}

export interface WorkflowObservedUsage {
  version: 1;
  source: "app_server";
  scope: "observed_original_threads";
  sources: WorkflowUsageSource[];
  summary: {
    observedSources: number;
    missingSources: number;
    partialSources: number;
    anomalousSources: number;
    /** Sum of reported original-thread counters only. Missing/overflowed fields are omitted. */
    total?: Partial<TokenUsageBreakdown>;
    overflowCounters?: WorkflowUsageCounter[];
  };
}

const counters: WorkflowUsageCounter[] = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"];

/** Snapshot updates replace one source's absolute totals; they never add an already cumulative response. */
export function observeUsageSource(source: WorkflowUsageSource, snapshot: TokenUsageSnapshot): WorkflowUsageSource {
  const parsed = parseTokenUsageSnapshot({ threadId: snapshot.threadId, turnId: snapshot.turnId,
    tokenUsage: { total: snapshot.total, last: snapshot.last, modelContextWindow: snapshot.modelContextWindow } });
  if (!parsed) return withAnomaly(source, "invalid_snapshot");
  const next: WorkflowUsageSource = { ...source, total: { ...parsed.total }, last: { ...parsed.last },
    ...(parsed.modelContextWindow === undefined ? {} : { modelContextWindow: parsed.modelContextWindow }) };
  return mergeUsageSource(source, next);
}

/** Called inside the raw WorkflowStore CAS mutation; preserves identities and all durable history. */
export function mergeWorkflowObservedUsage(previous: WorkflowObservedUsage | undefined,
  incoming: readonly WorkflowUsageSource[]): WorkflowObservedUsage {
  if (previous && (previous.version !== 1 || previous.source !== "app_server" || previous.scope !== "observed_original_threads")) {
    throw new Error("unsupported workflow usage accounting version");
  }
  const sources = (previous?.sources ?? []).map(cloneSource);
  for (const source of incoming) {
    const index = sources.findIndex((entry) => entry.sourceId === source.sourceId);
    if (index === -1) sources.push(cloneSource(source));
    else sources[index] = mergeUsageSource(sources[index]!, source);
  }
  return { version: 1, source: "app_server", scope: "observed_original_threads", sources, summary: summarize(sources) };
}

function mergeUsageSource(previous: WorkflowUsageSource, incoming: WorkflowUsageSource): WorkflowUsageSource {
  if (previous.sourceId !== incoming.sourceId || previous.stage !== incoming.stage) {
    throw new Error("workflow usage source identity mismatch");
  }
  const anomalies = [...new Set([...(previous.anomalies ?? []), ...(incoming.anomalies ?? [])])];
  const mixed = previous.modelMixed === true || incoming.modelMixed === true
    || (previous.model !== undefined && incoming.model !== undefined && previous.model !== incoming.model);
  const regressed = previous.total && incoming.total && counters.some((counter) => {
    const before = previous.total![counter];
    const after = incoming.total![counter];
    return before !== undefined && after !== undefined && after < before;
  });
  if (regressed) {
    const preserved = withAnomaly({ ...cloneSource(previous), ...(anomalies.length ? { anomalies } : {}) }, "counter_regression");
    if (mixed) { delete preserved.model; preserved.modelMixed = true; }
    return preserved;
  }
  const merged = { ...cloneSource(previous), ...cloneSource(incoming),
    ...(previous.model && !incoming.model ? { model: previous.model } : {}),
    ...(anomalies.length ? { anomalies } : {}) };
  if (mixed) { delete merged.model; merged.modelMixed = true; }
  return merged;
}

function summarize(sources: readonly WorkflowUsageSource[]): WorkflowObservedUsage["summary"] {
  const observed = sources.filter((source) => source.total !== undefined);
  const total: Partial<TokenUsageBreakdown> = {};
  const overflowCounters: WorkflowUsageCounter[] = [];
  for (const field of counters) {
    if (observed.length === 0 || observed.some((source) => source.total![field] === undefined)) continue;
    let sum = 0;
    let overflow = false;
    for (const source of observed) {
      const value = source.total![field]!;
      if (sum > Number.MAX_SAFE_INTEGER - value) { overflow = true; break; }
      sum += value;
    }
    if (overflow) overflowCounters.push(field);
    else total[field] = sum;
  }
  return {
    observedSources: observed.length,
    missingSources: sources.length - observed.length,
    partialSources: observed.filter((source) => source.total!.cacheWriteInputTokens === undefined).length,
    anomalousSources: sources.filter((source) => source.anomalies?.length).length,
    ...(Object.keys(total).length ? { total } : {}),
    ...(overflowCounters.length ? { overflowCounters } : {}),
  };
}

function withAnomaly(source: WorkflowUsageSource, anomaly: WorkflowUsageAnomaly): WorkflowUsageSource {
  return { ...cloneSource(source), anomalies: [...new Set([...(source.anomalies ?? []), anomaly])] };
}

function cloneSource(source: WorkflowUsageSource): WorkflowUsageSource {
  return { sourceId: source.sourceId, stage: source.stage,
    ...(source.model === undefined ? {} : { model: source.model }),
    ...(source.modelMixed ? { modelMixed: true } : {}),
    ...(source.total === undefined ? {} : { total: { ...source.total } }),
    ...(source.last === undefined ? {} : { last: { ...source.last } }),
    ...(source.modelContextWindow === undefined ? {} : { modelContextWindow: source.modelContextWindow }),
    ...(source.anomalies?.length ? { anomalies: [...source.anomalies] } : {}),
  };
}

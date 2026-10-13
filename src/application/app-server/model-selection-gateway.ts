import { CONVERSION_DEVELOPER_INSTRUCTIONS, SILENT_REVIEW_DEVELOPER_INSTRUCTIONS } from "../../review-contract.js";
import type { ReasoningEffort } from "../../types.js";

type JsonObject = Record<string, unknown>;
export interface ModelSelection {
  id: string;
  isDefault: boolean;
  hidden: boolean;
  name?: string;
  defaultReasoningEffort?: string;
}

export interface ModelSelectionGatewayOptions {
  request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  object(value: unknown): JsonObject;
}

/** Resolves collaboration modes and model defaults without owning JSON-RPC or
 * process state. The SDK resets the cache when its transport changes. */
export class ModelSelectionGateway {
  private cachedModels?: readonly ModelSelection[];
  private cachedDefault?: { id: string; defaultReasoningEffort?: string };
  private pendingModels?: { generation: object; promise: Promise<readonly ModelSelection[]> };
  private cacheGeneration: object = {};
  constructor(private readonly options: ModelSelectionGatewayOptions) {}

  resetCache(): void {
    this.cacheGeneration = {};
    this.cachedModels = undefined;
    this.cachedDefault = undefined;
  }

  private assertCacheGeneration(expected: object): void {
    if (this.cacheGeneration !== expected) throw new Error("original Codex model catalog generation is unavailable");
  }

  async planMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    const generation = this.cacheGeneration;
    const response = await this.options.request("collaborationMode/list", {}, signal);
    this.assertCacheGeneration(generation);
    const data = Array.isArray(response.data) ? response.data : [];
    const plan = data.map(this.options.object).find((entry) => entry.mode === "plan");
    let selectedModel = model || (typeof plan?.model === "string" ? plan.model : "");
    this.assertCacheGeneration(generation);
    if (!selectedModel) selectedModel = (await this.defaultModel(signal, generation))?.id ?? "";
    this.assertCacheGeneration(generation);
    if (!selectedModel) return undefined;
    return { mode: "plan", settings: {
      model: selectedModel,
      reasoning_effort: effort ?? (typeof plan?.reasoning_effort === "string" ? plan.reasoning_effort : null),
      developer_instructions: null,
    } };
  }

  async silentReviewMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    const generation = this.cacheGeneration;
    const result = await this.defaultModeWithInstructions(model, effort, signal, SILENT_REVIEW_DEVELOPER_INSTRUCTIONS, generation);
    this.assertCacheGeneration(generation);
    return result;
  }

  async conversionMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    const generation = this.cacheGeneration;
    const result = await this.defaultModeWithInstructions(model, effort, signal, CONVERSION_DEVELOPER_INSTRUCTIONS, generation);
    this.assertCacheGeneration(generation);
    return result;
  }

  private async defaultModeWithInstructions(model?: string, effort?: ReasoningEffort, signal?: AbortSignal, instructions?: string,
    generation = this.cacheGeneration): Promise<JsonObject | undefined> {
    this.assertCacheGeneration(generation);
    const selected = model ? await this.modelSelection(model, signal, generation) : await this.defaultModel(signal, generation);
    this.assertCacheGeneration(generation);
    if (!selected) return undefined;
    return { mode: "default", settings: {
      model: selected.id,
      reasoning_effort: effort ?? selected.defaultReasoningEffort ?? null,
      developer_instructions: instructions ?? null,
    } };
  }

  private async modelSelections(signal?: AbortSignal, generation = this.cacheGeneration): Promise<readonly ModelSelection[]> {
    this.assertCacheGeneration(generation);
    if (this.cachedModels) return this.cachedModels;
    const existing = this.pendingModels?.generation === generation ? this.pendingModels.promise : undefined;
    if (existing) return awaitWithAbort(existing, signal);
    const promise = this.fetchModels(generation);
    this.pendingModels = { generation, promise };
    void promise.finally(() => {
      if (this.pendingModels?.promise === promise) this.pendingModels = undefined;
    }).catch(() => undefined);
    return awaitWithAbort(promise, signal);
  }

  private async fetchModels(generation: object): Promise<readonly ModelSelection[]> {
    const response = await this.options.request("model/list", {});
    this.assertCacheGeneration(generation);
    const data = Array.isArray(response.data) ? response.data : [];
    const parsed: ModelSelection[] = [];
    for (const entry of data) {
      const value = this.options.object(entry);
      const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
      if (!id) continue;
      const defaultReasoningEffort = typeof value.defaultReasoningEffort === "string" && value.defaultReasoningEffort.length > 0
        ? value.defaultReasoningEffort : undefined;
      const name = typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName
        : typeof value.name === "string" && value.name.length > 0 ? value.name : undefined;
      parsed.push({ id, isDefault: value.isDefault === true, hidden: value.hidden === true,
        ...(name ? { name } : {}), ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) });
    }
    this.assertCacheGeneration(generation);
    this.cachedModels = Object.freeze(parsed.map((entry) => Object.freeze(entry)));
    return this.cachedModels;
  }

  private async modelSelection(id: string, signal?: AbortSignal, generation = this.cacheGeneration): Promise<{ id: string; defaultReasoningEffort?: string } | undefined> {
    this.assertCacheGeneration(generation);
    const models = await this.modelSelections(signal, generation);
    this.assertCacheGeneration(generation);
    const match = models.find((entry) => entry.id === id);
    return match ? { id: match.id, ...(match.defaultReasoningEffort ? { defaultReasoningEffort: match.defaultReasoningEffort } : {}) } : { id };
  }

  private async defaultModel(signal?: AbortSignal, generation = this.cacheGeneration): Promise<{ id: string; defaultReasoningEffort?: string } | undefined> {
    this.assertCacheGeneration(generation);
    if (this.cachedDefault) return this.cachedDefault;
    const models = await this.modelSelections(signal, generation);
    this.assertCacheGeneration(generation);
    const pick = models.find((entry) => entry.isDefault) ?? models.find((entry) => !entry.hidden) ?? models[0];
    if (!pick) return undefined;
    this.assertCacheGeneration(generation);
    this.cachedDefault = { id: pick.id, ...(pick.defaultReasoningEffort ? { defaultReasoningEffort: pick.defaultReasoningEffort } : {}) };
    return this.cachedDefault;
  }

  async resolveDefaultModel(signal?: AbortSignal): Promise<string | undefined> {
    const generation = this.cacheGeneration;
    const selected = await this.defaultModel(signal, generation);
    this.assertCacheGeneration(generation);
    return selected?.id;
  }

  async listVisibleModels(signal?: AbortSignal): Promise<ModelSelection[]> {
    const generation = this.cacheGeneration;
    const selected = await this.modelSelections(signal, generation);
    this.assertCacheGeneration(generation);
    // Return detached snapshots. Consumers may annotate or sort the public
    // list; neither action is allowed to mutate the generation's cache.
    return selected.filter((entry) => !entry.hidden).map((entry) => ({ ...entry }));
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

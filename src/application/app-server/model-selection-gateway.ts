import { CONVERSION_DEVELOPER_INSTRUCTIONS, SILENT_REVIEW_DEVELOPER_INSTRUCTIONS } from "../../review-contract.js";
import type { ReasoningEffort } from "../../types.js";

type JsonObject = Record<string, unknown>;
export interface ModelSelection {
  id: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort?: string;
}

export interface ModelSelectionGatewayOptions {
  request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  object(value: unknown): JsonObject;
}

/** Resolves collaboration modes and model defaults without owning JSON-RPC or
 * process state. The cache is scoped to one App Server client instance. */
export class ModelSelectionGateway {
  private cachedModels?: ModelSelection[];
  private cachedDefault?: { id: string; defaultReasoningEffort?: string };
  constructor(private readonly options: ModelSelectionGatewayOptions) {}

  async planMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    const response = await this.options.request("collaborationMode/list", {}, signal);
    const data = Array.isArray(response.data) ? response.data : [];
    const plan = data.map(this.options.object).find((entry) => entry.mode === "plan");
    let selectedModel = model || (typeof plan?.model === "string" ? plan.model : "");
    if (!selectedModel) selectedModel = (await this.defaultModel(signal))?.id ?? "";
    if (!selectedModel) return undefined;
    return { mode: "plan", settings: {
      model: selectedModel,
      reasoning_effort: effort ?? (typeof plan?.reasoning_effort === "string" ? plan.reasoning_effort : null),
      developer_instructions: null,
    } };
  }

  silentReviewMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.defaultModeWithInstructions(model, effort, signal, SILENT_REVIEW_DEVELOPER_INSTRUCTIONS);
  }

  conversionMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<JsonObject | undefined> {
    return this.defaultModeWithInstructions(model, effort, signal, CONVERSION_DEVELOPER_INSTRUCTIONS);
  }

  private async defaultModeWithInstructions(model?: string, effort?: ReasoningEffort, signal?: AbortSignal, instructions?: string): Promise<JsonObject | undefined> {
    const selected = model ? await this.modelSelection(model, signal) : await this.defaultModel(signal);
    if (!selected) return undefined;
    return { mode: "default", settings: {
      model: selected.id,
      reasoning_effort: effort ?? selected.defaultReasoningEffort ?? null,
      developer_instructions: instructions ?? null,
    } };
  }

  private async modelSelections(signal?: AbortSignal): Promise<ModelSelection[]> {
    if (this.cachedModels) return this.cachedModels;
    const response = await this.options.request("model/list", {}, signal);
    const data = Array.isArray(response.data) ? response.data : [];
    const parsed: ModelSelection[] = [];
    for (const entry of data) {
      const value = this.options.object(entry);
      const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
      if (!id) continue;
      const defaultReasoningEffort = typeof value.defaultReasoningEffort === "string" && value.defaultReasoningEffort.length > 0
        ? value.defaultReasoningEffort : undefined;
      parsed.push({ id, isDefault: value.isDefault === true, hidden: value.hidden === true, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) });
    }
    this.cachedModels = parsed;
    return parsed;
  }

  private async modelSelection(id: string, signal?: AbortSignal): Promise<{ id: string; defaultReasoningEffort?: string } | undefined> {
    const match = (await this.modelSelections(signal)).find((entry) => entry.id === id);
    return match ? { id: match.id, ...(match.defaultReasoningEffort ? { defaultReasoningEffort: match.defaultReasoningEffort } : {}) } : { id };
  }

  private async defaultModel(signal?: AbortSignal): Promise<{ id: string; defaultReasoningEffort?: string } | undefined> {
    if (this.cachedDefault) return this.cachedDefault;
    const models = await this.modelSelections(signal);
    const pick = models.find((entry) => entry.isDefault) ?? models.find((entry) => !entry.hidden) ?? models[0];
    if (!pick) return undefined;
    this.cachedDefault = { id: pick.id, ...(pick.defaultReasoningEffort ? { defaultReasoningEffort: pick.defaultReasoningEffort } : {}) };
    return this.cachedDefault;
  }

  async resolveDefaultModel(signal?: AbortSignal): Promise<string | undefined> {
    return (await this.defaultModel(signal))?.id;
  }
}

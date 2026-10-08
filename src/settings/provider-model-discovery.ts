import type { ReasoningEffort } from "../types/app-server";

/** Only provider-declared metadata. Absence is distinct from explicit false. */
export interface DiscoveredProviderModel {
  id: string;
  displayName?: string;
  input?: ("text" | "image")[];
  toolCalling?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  modelMaxTokens?: number;
  reasoningLevels?: Exclude<ReasoningEffort, "none">[];
  defaultReasoningEffort?: Exclude<ReasoningEffort, "none">;
}

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_ID = /^[^\s\p{Cc}]{1,256}$/u;

export function normalizeDiscoveredProviderModel(value: unknown): DiscoveredProviderModel | null {
  if (!record(value) || typeof value.id !== "string" || !MODEL_ID.test(value.id.trim())) return null;
  const result: DiscoveredProviderModel = { id: value.id.trim() };
  if (typeof value.displayName === "string" && value.displayName.trim()) {
    result.displayName = value.displayName.trim().replace(/\p{Cc}/gu, "").slice(0, 160);
  }
  if (Array.isArray(value.input)) {
    const input = [...new Set(value.input.filter((item): item is "text" | "image" => item === "text" || item === "image"))];
    if (input.length) result.input = input;
  }
  for (const key of ["toolCalling", "reasoning"] as const) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  for (const [key, min, max] of [["contextWindow", 1024, 2_000_000], ["modelMaxTokens", 1, 1_000_000]] as const) {
    const number = value[key];
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= min && number <= max) result[key] = number;
  }
  if (Array.isArray(value.reasoningLevels)) {
    const levels = LEVELS.filter((level) => (value.reasoningLevels as unknown[]).includes(level));
    if (levels.length) {
      result.reasoningLevels = levels;
      if (levels.includes(value.defaultReasoningEffort as typeof levels[number])) {
        result.defaultReasoningEffort = value.defaultReasoningEffort as typeof levels[number];
      }
    }
  }
  return result;
}

/** White-list the documented model-list shape, never copy remote request options. */
export function parseProviderModelResponse(value: unknown, limit = 200): {
  models: DiscoveredProviderModel[];
  incomplete: boolean;
} | null {
  if (!record(value) || !Array.isArray(value.data)) return null;
  const models = new Map<string, DiscoveredProviderModel>();
  for (const entry of value.data) {
    if (!record(entry)) continue;
    const effort = record(entry.effort) ? entry.effort : {};
    const model = normalizeDiscoveredProviderModel({
      id: entry.id,
      displayName: entry.name ?? entry.display_name,
      input: entry.input_modalities,
      toolCalling: entry.supports_tool_calling,
      reasoning: typeof entry.supports_reasoning === "boolean"
        ? entry.supports_reasoning
        : Array.isArray(effort.supported_levels) && effort.supported_levels.length ? true : undefined,
      contextWindow: entry.context_window,
      modelMaxTokens: entry.max_output_tokens,
      reasoningLevels: effort.supported_levels,
      defaultReasoningEffort: effort.default_level ?? effort.default
    });
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  const entries = [...models.values()];
  const pagination = record(value.pagination) ? value.pagination : {};
  return {
    models: entries.slice(0, limit),
    incomplete: entries.length > limit || value.has_more === true || pagination.has_more === true
      || Boolean(value.next || value.next_page || value.next_cursor || pagination.next)
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

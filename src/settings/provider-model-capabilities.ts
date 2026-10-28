/** Shared by desktop and mobile; no model catalog or host dependencies. */
export const DEFAULT_UNDECLARED_TOOL_CALLING = true;

export function resolveStoredModelToolCalling(value: unknown, declared?: boolean): boolean {
  const model = record(value);
  const overrides = record(model?.capabilityOverrides);
  if (typeof overrides?.toolCalling === "boolean") return overrides.toolCalling;
  // Historical manual records cannot tell us which individual field was edited.
  if (model?.metadataSource === "manual" && !overrides && typeof model.toolCalling === "boolean") return model.toolCalling;
  const discovery = record(model?.discovery);
  if (typeof discovery?.toolCalling === "boolean") return discovery.toolCalling;
  if ((model?.metadataSource === "preset" || model?.metadataSource === "catalog") && typeof model.toolCalling === "boolean") return model.toolCalling;
  return declared ?? DEFAULT_UNDECLARED_TOOL_CALLING;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

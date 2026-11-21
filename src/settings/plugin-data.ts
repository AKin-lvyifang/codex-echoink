/** Classify the original settings before startup defaults or migrations populate them. */
export function isEmptyEchoInkPluginData(value: unknown): boolean {
  return value === null
    || value === undefined
    || (
      typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 0
    );
}

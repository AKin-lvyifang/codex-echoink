/** Invalid optional opening copy never invalidates an otherwise compatible package. */
export function normalizeExpertDisclosure(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && Array.from(text).length <= 80 ? text : undefined;
}

export function cognitiveJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function newCognitiveId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function normalizeTextForDedupe(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim();
}

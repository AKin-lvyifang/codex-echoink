import type { KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseSource } from "./types";

const MAX_ATTACHED_SOURCES = 20;

export function selectSourcesForRunMode(mode: KnowledgeBaseRunMode, discovery: KnowledgeBaseDiscovery, userRequest = ""): KnowledgeBaseSource[] {
  if (mode === "lint" || mode === "outputs" || mode === "inbox") return [];
  const requestedRawPaths = extractRequestedRawPaths(userRequest);
  if (requestedRawPaths.length) {
    const requested = new Set(requestedRawPaths);
    return discovery.sources.filter((source) => requested.has(source.relativePath));
  }
  if (mode === "reingest") {
    const changed = discovery.changedSources;
    if (changed.length) return changed;
    return [...discovery.sources].sort((left, right) => right.mtime - left.mtime).slice(0, MAX_ATTACHED_SOURCES);
  }
  return discovery.changedSources;
}

export function extractRequestedRawPaths(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeRequestedRawPath(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };
  for (const match of text.matchAll(/\[\[\s*(raw\/[^\]|#\n\r]+)(?:#[^\]|\n\r]+)?(?:\|[^\]\n\r]+)?\s*\]\]/gi)) {
    add(match[1] ?? "");
  }
  for (const match of text.matchAll(/(?:^|[\s"'`([{（，,。；;：:])((?:raw\/)[^\s"'`)\]}）】,，。；;：:]+)(?=$|[\s"'`)\]}）】,，。；;：:])/gi)) {
    add(match[1] ?? "");
  }
  return result;
}

export function processedSourcesForRunMode(mode: KnowledgeBaseRunMode, sources: KnowledgeBaseSource[]): KnowledgeBaseSource[] {
  return mode === "maintain" || mode === "reingest" ? sources : [];
}

function normalizeRequestedRawPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^<|>$/g, "");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed) || trimmed.includes("..")) return "";
  if (!trimmed.startsWith("raw/")) return "";
  const withoutHash = trimmed.split("#")[0].trim();
  const clean = withoutHash.split("/").filter((part) => part && part !== ".").join("/");
  if (!clean.startsWith("raw/")) return "";
  if (/[?#]/.test(clean)) return "";
  if (/\.(md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)$/i.test(clean)) return clean;
  return `${clean}.md`;
}

import { knowledgeRootRole } from "../knowledge-base/root-paths-core";
export type VaultNoteLinkSegment =
  | { kind: "text"; text: string }
  | { kind: "noteLink"; text: string; original: string; targetPath: string; title: string; heading?: string };

const COMPACT_PARENT_LABEL_NAMES = new Set(["index", "00-索引", ".ingest-tracker"]);

export function splitVaultNoteLinkSegments(text: string, vaultBasePathValue = ""): VaultNoteLinkSegment[] {
  const candidates = collectVaultNoteLinkCandidates(text, vaultBasePathValue);
  if (!candidates.length) return [{ kind: "text", text }];
  const segments: VaultNoteLinkSegment[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    if (candidate.start > cursor) segments.push({ kind: "text", text: text.slice(cursor, candidate.start) });
    segments.push({
      kind: "noteLink",
      text: candidate.label,
      original: text.slice(candidate.start, candidate.end),
      targetPath: candidate.targetPath,
      title: candidate.title, heading: candidate.heading
    });
    cursor = candidate.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

function collectVaultNoteLinkCandidates(text: string, vaultBasePathValue: string): Array<{ start: number; end: number; label: string; targetPath: string; title: string; heading?: string }> {
  const candidates: Array<{ start: number; end: number; label: string; targetPath: string; title: string; heading?: string }> = [];
  const basePath = normalizeFsPath(vaultBasePathValue).replace(/\/$/, "");

  const markdownLinkPattern = /\[([^\]\n\r]+)]\(<?([^)<>\n\r]+?\.md(?:#[^)<>]+)?)>?\)/gi;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === "!") continue;
    const targetPath = resolveVaultNoteCandidate(match[2], basePath);
    if (!targetPath) continue;
    candidates.push({
      start,
      end: start + match[0].length,
      label: cleanLinkLabel(match[1]) || displayNameForVaultNote(targetPath),
      targetPath,
      heading: match[2]?.includes("#") ? decodeUriPath(match[2].slice(match[2].indexOf("#") + 1)) : undefined,
      title: titleForVaultNote(targetPath, basePath)
    });
  }

  const wikiLinkPattern = /\[\[([^\]\n\r|]+?)(?:\|([^\]\n\r]+))?\]\]/gi;
  for (const match of text.matchAll(wikiLinkPattern)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === "!") continue;
    const targetPath = normalizeWikiLinkCandidate(match[1], basePath);
    if (!targetPath) continue;
    candidates.push({
      start,
      end: start + match[0].length,
      label: cleanLinkLabel(match[2] ?? "") || displayNameForVaultNote(targetPath),
      targetPath,
      heading: match[1].includes("#") ? decodeUriPath(match[1].slice(match[1].indexOf("#") + 1)) : undefined,
      title: titleForVaultNote(targetPath, basePath)
    });
  }

  if (basePath) {
    const absolutePattern = new RegExp(`([\\[(（]?)((${escapeRegExp(basePath)})/[^\\n\\r\\t]+?\\.md)([\\])）]?)`, "gi");
    for (const match of text.matchAll(absolutePattern)) {
      const absolutePath = match[2];
      const targetPath = relativePathForAbsoluteVaultNote(absolutePath, basePath);
      if (!targetPath) continue;
      candidates.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        label: displayNameForVaultNote(targetPath),
        targetPath,
        title: absolutePath
      });
    }
  }

  for (const pattern of [/\[([^\]\n\r]+?\.md)\]/gi]) {
    for (const match of text.matchAll(pattern)) {
      const targetPath = normalizeVaultNoteCandidate(match[1]);
      if (!targetPath) continue;
      candidates.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        label: displayNameForVaultNote(targetPath),
        targetPath,
        title: titleForVaultNote(targetPath, basePath)
      });
    }
  }

  const barePattern = /(^|[\s"'“‘(（:：，,;；、])((?:[^\s/\n\r\t()[\]<>]+\/[^\n\r\t()[\]<>]+?\.md)|(?:[A-Za-z0-9_.\-\u3400-\u9fff]+\.md))/giu;
  for (const match of text.matchAll(barePattern)) {
    const targetPath = normalizeVaultNoteCandidate(match[2]);
    if (!targetPath) continue;
    const prefixLength = match[1].length;
    const start = (match.index ?? 0) + prefixLength;
    // A bare tail after a word may belong to a longer folder name containing spaces.
    // Explicit links and code spans already preserve those full paths.
    const preceding = text.slice(0, start).match(/([^\s\r\n]+)\s+$/u)?.[1];
    if (preceding && /[\p{L}\p{N}]$/u.test(preceding)) continue;
    candidates.push({
      start,
      end: start + match[2].length,
      label: displayNameForVaultNote(targetPath),
      targetPath,
      title: titleForVaultNote(targetPath, basePath)
    });
  }

  return candidates.sort((left, right) => left.start - right.start || right.end - left.end);
}

function resolveVaultNoteCandidate(value: string, basePath: string): string {
  const cleaned = value.trim();
  return relativePathForAbsoluteVaultNote(cleaned, basePath) || normalizeVaultNoteCandidate(cleaned);
}

function normalizeWikiLinkCandidate(value: string, basePath: string): string {
  const cleaned = value.trim();
  if (!cleaned || /^https?:\/\//i.test(cleaned)) return "";
  const relative = relativePathForAbsoluteVaultNote(cleaned, basePath);
  if (relative) return relative;
  const withoutHeading = decodeUriPath(cleaned.split("#")[0].trim().replace(/^\.\//, ""));
  if (!withoutHeading || /^https?:\/\//i.test(withoutHeading) || withoutHeading.startsWith("/")) return "";
  const withExtension = /\.md$/i.test(withoutHeading) ? withoutHeading : `${withoutHeading}.md`;
  return normalizeVaultNoteCandidate(withExtension);
}

function normalizeVaultNoteCandidate(value: string): string {
  const withoutAlias = decodeUriPath(value.split("|")[0].split("#")[0].trim().replace(/^\.\//, ""));
  if (!/\.md$/i.test(withoutAlias) || /^https?:\/\//i.test(withoutAlias) || withoutAlias.startsWith("/")) return "";
  const normalized = normalizeVaultPath(withoutAlias);
  if (normalized.split("/").some((part) => part === "." || part === "..")) return "";
  if (normalized.split("/").some((part) => !part || part.startsWith(".")) || /^[a-z]:/iu.test(normalized)) return "";
  return normalized;
}

function relativePathForAbsoluteVaultNote(absolutePath: string, basePath: string): string {
  const normalizedAbsolute = normalizeFsPath(decodeUriPath(absolutePath));
  const base = normalizeFsPath(decodeUriPath(basePath)).replace(/\/$/, "");
  const prefix = `${base}/`;
  if (!normalizedAbsolute.startsWith(prefix)) return "";
  return normalizeVaultNoteCandidate(normalizedAbsolute.slice(prefix.length));
}

function titleForVaultNote(relativePath: string, basePath: string): string {
  return basePath ? `${basePath}/${relativePath}` : relativePath;
}

function displayNameForVaultNote(relativePath: string): string {
  const parts = relativePath.split("/");
  const name = parts.pop()?.replace(/\.md$/i, "") || relativePath;
  const parent = parts.pop();
  if (parent && COMPACT_PARENT_LABEL_NAMES.has(name.toLowerCase())) return `${parent}/${name}`;
  return name;
}

function cleanLinkLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

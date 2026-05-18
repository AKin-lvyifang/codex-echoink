export type VaultNoteLinkSegment =
  | { kind: "text"; text: string }
  | { kind: "noteLink"; text: string; original: string; targetPath: string; title: string };

const VAULT_NOTE_ROOTS = new Set(["wiki", "journal", "outputs", "raw", "inbox", "projects", "work", "templates", "archive", "testing", "assets"]);
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
      title: candidate.title
    });
    cursor = candidate.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

function collectVaultNoteLinkCandidates(text: string, vaultBasePathValue: string): Array<{ start: number; end: number; label: string; targetPath: string; title: string }> {
  const candidates: Array<{ start: number; end: number; label: string; targetPath: string; title: string }> = [];
  const basePath = normalizeFsPath(vaultBasePathValue).replace(/\/$/, "");

  const markdownLinkPattern = /\[([^\]\n\r]+)]\(([^)\n\r]+?\.md(?:#[^)]+)?)\)/gi;
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
      title: titleForVaultNote(targetPath, basePath)
    });
  }

  const wikiLinkPattern = /\[\[([^\]\n\r|]+?\.md(?:#[^\]\n\r|]+)?)(?:\|([^\]\n\r]+))?\]\]/gi;
  for (const match of text.matchAll(wikiLinkPattern)) {
    const targetPath = resolveVaultNoteCandidate(match[1], basePath);
    if (!targetPath) continue;
    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      label: cleanLinkLabel(match[2] ?? "") || displayNameForVaultNote(targetPath),
      targetPath,
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

  const barePattern = /(^|[\s"'“‘(（:：，,;；、])((?:(?:wiki|journal|outputs|raw|inbox|projects|work|templates|archive|testing|assets)\/[^\n\r\t()[\]<>]+?\.md)|(?:[A-Za-z0-9_.\-\u3400-\u9fff]+\.md))/giu;
  for (const match of text.matchAll(barePattern)) {
    const targetPath = normalizeVaultNoteCandidate(match[2]);
    if (!targetPath) continue;
    const prefixLength = match[1].length;
    const start = (match.index ?? 0) + prefixLength;
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

function normalizeVaultNoteCandidate(value: string): string {
  const withoutAlias = value.split("|")[0].split("#")[0].trim().replace(/^\.\//, "");
  if (!/\.md$/i.test(withoutAlias) || /^https?:\/\//i.test(withoutAlias) || withoutAlias.startsWith("/")) return "";
  const normalized = normalizeVaultPath(withoutAlias);
  const root = normalized.split("/")[0] || "";
  if (!normalized.includes("/") || VAULT_NOTE_ROOTS.has(root)) return normalized;
  return "";
}

function relativePathForAbsoluteVaultNote(absolutePath: string, basePath: string): string {
  const normalizedAbsolute = normalizeFsPath(absolutePath);
  const base = normalizeFsPath(basePath).replace(/\/$/, "");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

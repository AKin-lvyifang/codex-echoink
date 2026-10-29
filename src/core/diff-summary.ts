import type { DiffFileSummary, DiffSummary } from "../settings/settings";

export interface RawFileChange {
  path?: string;
  kind?: unknown;
  diff?: string;
}

export interface DiffLineView {
  type: "add" | "remove" | "context" | "hunk" | "meta";
  oldLine: number | null;
  newLine: number | null;
  marker: string;
  text: string;
}

export interface ParsedDiffFile extends DiffFileSummary {
  lines: DiffLineView[];
}

const FILE_CHANGE_HEADER_PREFIX = "### Codex file change: ";

export function buildDiffSummary(changes: RawFileChange[]): DiffSummary {
  const files = changes.map((change) => {
    const counts = countDiffLines(change.diff ?? "");
    const kind = normalizeChangeKind(change.kind);
    return {
      path: change.path ?? "未命名文件",
      previousPath: previousPathFromKind(change.kind),
      kind,
      added: counts.added,
      removed: counts.removed
    };
  });
  return {
    totalFiles: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    files
  };
}

export function serializeFileChanges(changes: RawFileChange[]): string {
  return changes
    .map((change) => `${FILE_CHANGE_HEADER_PREFIX}${change.path ?? "未命名文件"}\n${change.diff ?? ""}`.trimEnd())
    .join("\n\n");
}

export function parseFileChangeDiff(text: string, summary?: DiffSummary): ParsedDiffFile[] {
  const sections = splitFileChangeText(text, summary);
  return sections.map((section, index) => {
    const summaryFile = summary?.files[index];
    const lines = parseUnifiedDiffLines(section.diff);
    const counts = countParsedDiffLines(lines);
    return {
      path: summaryFile?.path ?? section.path ?? "文件改动",
      previousPath: summaryFile?.previousPath,
      kind: summaryFile?.kind ?? "unknown",
      added: summaryFile?.added ?? counts.added,
      removed: summaryFile?.removed ?? counts.removed,
      lines
    };
  });
}

export function diffSummaryLabel(summary: DiffSummary): string {
  const fileLabel = summary.totalFiles === 1 ? "1 个文件已更改" : `${summary.totalFiles} 个文件已更改`;
  return fileLabel;
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (isAddedLine(line)) added += 1;
    else if (isRemovedLine(line)) removed += 1;
  }
  return { added, removed };
}

function countParsedDiffLines(lines: DiffLineView[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.type === "add").length,
    removed: lines.filter((line) => line.type === "remove").length
  };
}

function parseUnifiedDiffLines(diff: string): DiffLineView[] {
  const parsed: DiffLineView[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const rawLine of diff.split(/\r?\n/)) {
    const hunk = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      parsed.push({ type: "hunk", oldLine: null, newLine: null, marker: "@@", text: rawLine });
      continue;
    }
    if (isAddedLine(rawLine)) {
      parsed.push({ type: "add", oldLine: null, newLine, marker: "+", text: rawLine.slice(1) });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (isRemovedLine(rawLine)) {
      parsed.push({ type: "remove", oldLine, newLine: null, marker: "-", text: rawLine.slice(1) });
      if (oldLine !== null) oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      parsed.push({ type: "context", oldLine, newLine, marker: "", text: rawLine.slice(1) });
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      continue;
    }
    parsed.push({ type: "meta", oldLine: null, newLine: null, marker: "", text: rawLine });
  }
  return parsed.filter((line) => line.text.trim() || line.type !== "meta");
}

function splitFileChangeText(text: string, summary?: DiffSummary): Array<{ path: string; diff: string }> {
  const headerPattern = new RegExp(`^${escapeRegExp(FILE_CHANGE_HEADER_PREFIX)}(.+)$`, "gm");
  const headers = Array.from(text.matchAll(headerPattern));
  if (headers.length) {
    return headers.map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < headers.length ? headers[index + 1].index ?? text.length : text.length;
      return { path: match[1].trim(), diff: text.slice(start, end).trimStart() };
    });
  }

  if (summary?.files.length) {
    const lines = text.split(/\r?\n/);
    const sections: Array<{ path: string; diffLines: string[] }> = [];
    let current: { path: string; diffLines: string[] } | null = null;
    const paths = new Set(summary.files.map((file) => file.path));
    for (const line of lines) {
      if (paths.has(line.trim())) {
        if (current) sections.push(current);
        current = { path: line.trim(), diffLines: [] };
        continue;
      }
      if (current) current.diffLines.push(line);
    }
    if (current) sections.push(current);
    if (sections.length) {
      return sections.map((section) => ({ path: section.path, diff: section.diffLines.join("\n").trimStart() }));
    }
  }

  return [{ path: summary?.files[0]?.path ?? "文件改动", diff: text }];
}

function normalizeChangeKind(kind: unknown): DiffFileSummary["kind"] {
  if (typeof kind === "string") return kind === "add" || kind === "delete" || kind === "update" || kind === "move" ? kind : "unknown";
  if (!kind || typeof kind !== "object") return "unknown";
  const rawType = (kind as { type?: unknown }).type;
  const type = typeof rawType === "string" ? rawType : "";
  if (type === "update" && previousPathFromKind(kind)) return "move";
  return type === "add" || type === "delete" || type === "update" ? type : "unknown";
}

function previousPathFromKind(kind: unknown): string | undefined {
  if (!kind || typeof kind !== "object") return undefined;
  const movePath = (kind as { move_path?: unknown; movePath?: unknown }).move_path ?? (kind as { movePath?: unknown }).movePath;
  return typeof movePath === "string" && movePath ? movePath : undefined;
}

function isAddedLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function isRemovedLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

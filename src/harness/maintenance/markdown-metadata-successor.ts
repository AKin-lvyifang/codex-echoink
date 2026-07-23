import { createHash } from "node:crypto";

const MARKDOWN_EXTENSION = /\.md$/i;
const MAINTENANCE_REPORT_PATH = /^outputs\/maintenance\/.+\.md$/i;

export interface MaintenanceMarkdownUpdatedSuccessorWindow {
  lowerBoundMs: number;
  upperBoundMs: number;
}

export interface MaintenanceMarkdownUpdatedSuccessorEvidence {
  updatedAt: number;
  projectionDigest: string;
}

interface UpdatedProjection {
  contentWithoutUpdated: string;
  contentWithUpdatedPlaceholder: string | null;
  formatSignature: string | null;
  updatedAt: number | null;
}

interface ParsedTimestamp {
  at: number;
  formatSignature: string;
}

/**
 * Only user-facing Markdown targets owned by the current maintenance commit
 * may use the metadata-successor exception. Raw, rules, tracker, and binary
 * targets keep their exact CAS boundary.
 */
export function isMaintenanceMarkdownUpdatedSuccessorPath(
  relativePathInput: string
): boolean {
  const relativePath = relativePathInput.replace(/\\/g, "/");
  const lower = relativePath.toLowerCase();
  return MARKDOWN_EXTENSION.test(relativePath)
    && lower !== "llm-wiki.md"
    && !lower.startsWith("raw/")
    && lower !== "outputs/.ingest-tracker.md";
}

export function maintenanceMarkdownUpdatedMayBeInserted(
  relativePathInput: string
): boolean {
  return MAINTENANCE_REPORT_PATH.test(
    relativePathInput.replace(/\\/g, "/")
  );
}

/**
 * Proves that currentContent is the desired Markdown with exactly one safe
 * difference: the unique top-level `updated` timestamp moved forward. Reports
 * additionally accept Obsidian's semantic-only `tags` reserialization when
 * the minute-resolution `updated` value remains equal. Reports retain the
 * legacy allowance for a metadata plugin to insert that field when the
 * desired report did not already contain it.
 */
export function maintenanceMarkdownUpdatedSuccessorEvidence(input: {
  relativePath: string;
  desiredContent: Buffer;
  currentContent: Buffer;
  desiredMode: number;
  currentMode: number;
  window: MaintenanceMarkdownUpdatedSuccessorWindow;
  allowInsertedUpdated?: boolean;
  allowRawMetadata?: boolean;
}): MaintenanceMarkdownUpdatedSuccessorEvidence | null {
  if (
    !(
      isMaintenanceMarkdownUpdatedSuccessorPath(input.relativePath)
      || (
        input.allowRawMetadata === true
        && isRawMarkdownPath(input.relativePath)
      )
    )
    || normalizeMode(input.currentMode) !== normalizeMode(input.desiredMode)
    || !Number.isFinite(input.window.lowerBoundMs)
    || !Number.isFinite(input.window.upperBoundMs)
    || input.window.upperBoundMs < input.window.lowerBoundMs
  ) return null;

  const desired = updatedProjection(input.desiredContent);
  const current = updatedProjection(input.currentContent);
  if (!desired || !current || current.updatedAt === null) return null;

  let projectionDigest: string | null = null;
  if (desired.updatedAt === null) {
    if (
      !input.allowInsertedUpdated
      || !maintenanceMarkdownUpdatedMayBeInserted(input.relativePath)
    ) return null;
    projectionDigest = desired.contentWithoutUpdated
      === current.contentWithoutUpdated
      ? sha256Text(current.contentWithoutUpdated)
      : maintenanceReportTagsProjectionDigest(
        input.relativePath,
        desired.contentWithoutUpdated,
        current.contentWithoutUpdated
      );
  } else {
    if (
      current.updatedAt < desired.updatedAt
      || desired.contentWithUpdatedPlaceholder === null
      || current.contentWithUpdatedPlaceholder === null
      || desired.formatSignature !== current.formatSignature
    ) return null;
    const exactProjection = desired.contentWithUpdatedPlaceholder
      === current.contentWithUpdatedPlaceholder;
    if (current.updatedAt === desired.updatedAt && exactProjection) {
      return null;
    }
    projectionDigest = exactProjection
      ? sha256Text(current.contentWithUpdatedPlaceholder)
      : maintenanceReportTagsProjectionDigest(
        input.relativePath,
        desired.contentWithUpdatedPlaceholder,
        current.contentWithUpdatedPlaceholder
      );
  }
  if (!projectionDigest) return null;

  const lowerBound = Math.floor(input.window.lowerBoundMs / 60_000) * 60_000;
  if (
    current.updatedAt < lowerBound
    || current.updatedAt > input.window.upperBoundMs
  ) return null;

  return {
    updatedAt: current.updatedAt,
    projectionDigest
  };
}

/**
 * Obsidian may reserialize a maintenance report's `tags` list while advancing
 * its top-level `updated` field. Normalize only that one known collection;
 * every other frontmatter byte and the whole body remain exact-match evidence.
 */
function maintenanceReportTagsProjectionDigest(
  relativePath: string,
  desiredProjection: string,
  currentProjection: string
): string | null {
  if (!maintenanceMarkdownUpdatedMayBeInserted(relativePath)) return null;
  const desired = normalizeMaintenanceReportTags(desiredProjection);
  const current = normalizeMaintenanceReportTags(currentProjection);
  return desired !== null && desired === current
    ? sha256Text(desired)
    : null;
}

function normalizeMaintenanceReportTags(projection: string): string | null {
  const lines = projection.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  if (!lines.length || !/^---\r?\n$/.test(lines[0])) return null;
  const frontmatterEnd = lines.findIndex(
    (line, index) => index > 0 && /^(?:---|\.\.\.)\r?\n$/.test(line)
  );
  if (frontmatterEnd < 0) return null;
  const normalized: string[] = [];
  let tagsCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index <= 0 || index >= frontmatterEnd) {
      normalized.push(line);
      continue;
    }
    const match = line.match(/^tags\s*:\s*(.*?)(\r?\n)$/);
    if (!match) {
      normalized.push(line);
      continue;
    }
    tagsCount += 1;
    if (tagsCount > 1) return null;
    const rawValue = match[1] ?? "";
    let tags: string[] | null;
    if (rawValue.trim()) {
      tags = parseSafeInlineSequence(rawValue);
    } else {
      tags = [];
      while (index + 1 < frontmatterEnd) {
        const nestedLine = lines[index + 1];
        if (!/^[ \t]/.test(nestedLine)) break;
        const item = nestedLine.match(/^ {2,}-[ \t]+(.*?)(\r?\n)$/);
        if (!item) return null;
        const scalar = parseSafeScalar(item[1] ?? "");
        if (scalar === null) return null;
        tags.push(scalar);
        index += 1;
      }
      if (!tags.length) return null;
    }
    if (!tags) return null;
    normalized.push(`tags:<echoink-tags:${JSON.stringify(tags)}>\n`);
  }
  return tagsCount === 1 ? normalized.join("") : null;
}

function parseSafeInlineSequence(rawValue: string): string[] | null {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const source = trimmed.slice(1, -1);
  if (!source.trim()) return [];
  const parsed = source.split(",").map(parseSafeScalar);
  return parsed.every((value): value is string => value !== null)
    ? parsed
    : null;
}

function parseSafeScalar(rawValue: string): string | null {
  const value = rawValue.trim();
  return /^[\p{L}\p{N}_./-]+$/u.test(value) ? value : null;
}

function isRawMarkdownPath(relativePathInput: string): boolean {
  const relativePath = relativePathInput.replace(/\\/g, "/").toLowerCase();
  return relativePath.startsWith("raw/") && MARKDOWN_EXTENSION.test(relativePath);
}

function updatedProjection(content: Buffer): UpdatedProjection | null {
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return null;
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  if (!lines.length || !/^---\r?\n$/.test(lines[0])) return null;
  const frontmatterEnd = lines.findIndex(
    (line, index) => index > 0 && /^(?:---|\.\.\.)\r?\n$/.test(line)
  );
  if (frontmatterEnd < 0) return null;

  let updatedAt: number | null = null;
  let formatSignature: string | null = null;
  const withoutUpdated: string[] = [];
  const withPlaceholder: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index <= 0 || index >= frontmatterEnd) {
      withoutUpdated.push(line);
      withPlaceholder.push(line);
      continue;
    }
    const match = line.match(
      /^((?:updated|["']updated["'])\s*:\s*)(.*?)([ \t]*)(\r?\n)$/i
    );
    if (!match) {
      withoutUpdated.push(line);
      withPlaceholder.push(line);
      continue;
    }
    if (updatedAt !== null) return null;
    const parsed = parseUpdatedTimestamp(match[2] ?? "");
    if (!parsed) return null;
    updatedAt = parsed.at;
    formatSignature = parsed.formatSignature;
    withPlaceholder.push(
      `${match[1]}<echoink-updated:${parsed.formatSignature}>${match[3]}${match[4]}`
    );
  }
  return {
    contentWithoutUpdated: withoutUpdated.join(""),
    contentWithUpdatedPlaceholder:
      updatedAt === null ? null : withPlaceholder.join(""),
    formatSignature,
    updatedAt
  };
}

function parseUpdatedTimestamp(value: string): ParsedTimestamp | null {
  const raw = value.trim();
  const quoted = raw.match(/^(?:"([^"]*)"|'([^']*)')$/);
  const quote = quoted
    ? raw.startsWith('"') ? "double" : "single"
    : "none";
  const timestamp = quoted
    ? (quoted[1] ?? quoted[2] ?? "")
    : raw;
  const match = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))?$/
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return null;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return null;
  const zone = match[8] === undefined
    ? "local"
    : match[8] === "Z"
      ? "utc"
      : "offset";
  return {
    at,
    formatSignature: [
      quote,
      match[6] === undefined ? "minute" : "second",
      match[7]?.length ?? 0,
      zone
    ].join(":")
  };
}

function normalizeMode(mode: number): number {
  return mode & 0o777;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

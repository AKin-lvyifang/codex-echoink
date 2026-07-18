import * as fsp from "fs/promises";
import * as path from "path";
import { contentFingerprint } from "./raw-integrity";
import { writeFileAtomic } from "./utils";

export const RAW_DIGEST_REGISTRY_PATH = "outputs/.raw-digest-registry.json";
export const RAW_DIGEST_SCHEMA_VERSION = 1;

export const RAW_DIGEST_FIELDS = {
  processed: "已处理",
  status: "提炼状态",
  digestedAt: "提炼时间",
  fingerprint: "提炼指纹",
  reportPath: "提炼报告",
  evidencePaths: "提炼证据"
} as const;

export const RAW_DIGEST_STATUS_DIGESTED = "已提炼";
export const RAW_DIGEST_STATUS_PENDING_REINGEST = "待重新提炼";
export const RAW_DIGEST_STATUS_FAILED = "提炼失败";
export const RAW_DIGEST_STATUS_PENDING_CALIBRATION = "待校准";
export const RAW_DIGEST_MANAGED_KEYS = new Set<string>(Object.values(RAW_DIGEST_FIELDS));

export type RawDigestConfidence = "verified" | "repaired";

export interface RawDigestRegistryEntry {
  rawPath: string;
  fingerprint: string;
  size: number;
  mtime: number;
  digestedAt: number;
  runId: string;
  reportPath: string;
  evidencePaths: string[];
  confidence: RawDigestConfidence;
}

export interface RawDigestRegistry {
  schemaVersion: number;
  updatedAt: string;
  entries: Record<string, RawDigestRegistryEntry>;
}

export interface RawDigestFrontmatterRecord {
  processed: boolean;
  status: string;
  fingerprint: string;
  digestedAt: number;
  reportPath: string;
  evidencePaths: string[];
}

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  frontmatter: string;
  body: string;
}

export function isRawMarkdownPath(relativePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(relativePath);
}

export function rawDigestFingerprint(relativePath: string, content: Buffer): string {
  if (!isRawMarkdownPath(relativePath)) return contentFingerprint(content);
  return contentFingerprint(Buffer.from(canonicalRawMarkdownForDigest(content.toString("utf8")), "utf8"));
}

export function rawDigestRecordFromMarkdown(content: Buffer): RawDigestFrontmatterRecord | null {
  const parsed = splitFrontmatter(content.toString("utf8"));
  if (!parsed.hasFrontmatter) return null;
  const values = readFrontmatterValues(parsed.frontmatter);
  const fingerprint = values.get(RAW_DIGEST_FIELDS.fingerprint)?.trim() ?? "";
  if (!fingerprint) return null;
  return {
    processed: parseBoolean(values.get(RAW_DIGEST_FIELDS.processed)),
    status: values.get(RAW_DIGEST_FIELDS.status)?.trim() ?? "",
    fingerprint,
    digestedAt: Date.parse(values.get(RAW_DIGEST_FIELDS.digestedAt)?.trim() ?? "") || 0,
    reportPath: stripYamlString(values.get(RAW_DIGEST_FIELDS.reportPath) ?? ""),
    evidencePaths: parseEvidencePaths(values.get(RAW_DIGEST_FIELDS.evidencePaths) ?? "")
  };
}

export function rawDigestRecordIsTrusted(record: RawDigestFrontmatterRecord | null, fingerprint: string): boolean {
  if (!record) return false;
  return record.processed
    && record.status === RAW_DIGEST_STATUS_DIGESTED
    && record.fingerprint === fingerprint
    && Boolean(record.reportPath)
    && record.evidencePaths.length > 0;
}

export function applyRawDigestFrontmatter(content: Buffer, entry: RawDigestRegistryEntry): Buffer {
  const managed = [
    `${RAW_DIGEST_FIELDS.processed}: true`,
    `${RAW_DIGEST_FIELDS.status}: ${RAW_DIGEST_STATUS_DIGESTED}`,
    `${RAW_DIGEST_FIELDS.digestedAt}: ${new Date(entry.digestedAt).toISOString()}`,
    `${RAW_DIGEST_FIELDS.fingerprint}: ${entry.fingerprint}`,
    `${RAW_DIGEST_FIELDS.reportPath}: ${entry.reportPath}`,
    `${RAW_DIGEST_FIELDS.evidencePaths}:`,
    ...entry.evidencePaths.map((item) => `  - ${item}`)
  ];
  return replaceManagedRawFrontmatter(content, managed);
}

export function applyRawDigestStatusFrontmatter(
  content: Buffer,
  input: {
    status: typeof RAW_DIGEST_STATUS_PENDING_CALIBRATION | typeof RAW_DIGEST_STATUS_PENDING_REINGEST | typeof RAW_DIGEST_STATUS_FAILED;
    fingerprint: string;
    reportPath: string;
    evidencePaths?: string[];
    digestedAt?: number;
  }
): Buffer {
  const managed = [
    `${RAW_DIGEST_FIELDS.processed}: false`,
    `${RAW_DIGEST_FIELDS.status}: ${input.status}`,
    `${RAW_DIGEST_FIELDS.digestedAt}: ${new Date(input.digestedAt ?? Date.now()).toISOString()}`,
    `${RAW_DIGEST_FIELDS.fingerprint}: ${input.fingerprint}`,
    `${RAW_DIGEST_FIELDS.reportPath}: ${input.reportPath}`,
    `${RAW_DIGEST_FIELDS.evidencePaths}:`,
    ...(input.evidencePaths ?? []).map((item) => `  - ${item}`)
  ];
  return replaceManagedRawFrontmatter(content, managed);
}

export function rawDigestPreservesUserFrontmatterBytes(
  baseline: Buffer,
  desired: Buffer
): boolean {
  const before = splitRawMarkdownBytes(baseline);
  const after = splitRawMarkdownBytes(desired);
  const afterUnmanaged = removeManagedRawFrontmatterBytes(after.frontmatter);
  if (!before.hasFrontmatter) {
    return !after.hasFrontmatter || afterUnmanaged.length === 0;
  }
  if (!after.hasFrontmatter) return false;
  return before.opening.equals(after.opening)
    && before.closing.equals(after.closing)
    && removeManagedRawFrontmatterBytes(before.frontmatter)
      .equals(afterUnmanaged);
}

export function rawDigestUserFrontmatterProjectionBytes(
  content: Buffer
): Buffer {
  const sections = splitRawMarkdownBytes(content);
  if (!sections.hasFrontmatter) return Buffer.alloc(0);
  const unmanaged = removeManagedRawFrontmatterBytes(sections.frontmatter);
  if (!unmanaged.length) return Buffer.alloc(0);
  return Buffer.concat([
    sections.opening,
    unmanaged,
    sections.closing
  ]);
}

export async function readRawDigestRegistry(vaultPath: string): Promise<RawDigestRegistry> {
  const absolute = path.join(vaultPath, RAW_DIGEST_REGISTRY_PATH);
  const stat = await fsp.lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.nlink > 1) return emptyRawDigestRegistry();
  const text = await fsp.readFile(absolute, "utf8").catch(() => "");
  if (!text.trim()) return emptyRawDigestRegistry();
  try {
    return normalizeRawDigestRegistry(JSON.parse(text));
  } catch {
    return emptyRawDigestRegistry();
  }
}

export async function writeRawDigestRegistry(vaultPath: string, registry: RawDigestRegistry): Promise<void> {
  const absolute = path.join(vaultPath, RAW_DIGEST_REGISTRY_PATH);
  await writeFileAtomic(absolute, buildRawDigestRegistryContent(registry));
}

export function buildRawDigestRegistryContent(registry: RawDigestRegistry): Buffer {
  const next: RawDigestRegistry = {
    schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
    updatedAt: registry.updatedAt || new Date().toISOString(),
    entries: Object.fromEntries(Object.entries(registry.entries).sort(([left], [right]) => left.localeCompare(right)))
  };
  return Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function normalizeRawDigestRegistry(value: any): RawDigestRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRawDigestRegistry();
  const entries: Record<string, RawDigestRegistryEntry> = {};
  const rawEntries = value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) ? value.entries : {};
  for (const [key, item] of Object.entries(rawEntries) as Array<[string, any]>) {
    const rawPath = normalizeRelativePath(item?.rawPath || key);
    const fingerprint = typeof item?.fingerprint === "string" ? item.fingerprint.trim() : "";
    if (!rawPath || !fingerprint) continue;
    entries[rawPath] = {
      rawPath,
      fingerprint,
      size: nonNegativeNumber(item?.size),
      mtime: nonNegativeNumber(item?.mtime),
      digestedAt: nonNegativeNumber(item?.digestedAt),
      runId: typeof item?.runId === "string" ? item.runId : "",
      reportPath: normalizeRelativePath(item?.reportPath ?? ""),
      evidencePaths: Array.isArray(item?.evidencePaths) ? item.evidencePaths.map(normalizeRelativePath).filter(Boolean) : [],
      confidence: item?.confidence === "repaired" ? "repaired" : "verified"
    };
  }
  return {
    schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    entries
  };
}

export function emptyRawDigestRegistry(): RawDigestRegistry {
  return { schemaVersion: RAW_DIGEST_SCHEMA_VERSION, updatedAt: "", entries: {} };
}

function canonicalRawMarkdownForDigest(text: string): string {
  const parsed = splitFrontmatter(text);
  return parsed.body.replace(/^\r?\n/, "");
}

function splitFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { hasFrontmatter: false, frontmatter: "", body: text };
  const lines = normalized.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      return {
        hasFrontmatter: true,
        frontmatter: lines.slice(1, index).join("\n"),
        body: lines.slice(index + 1).join("\n")
      };
    }
  }
  return { hasFrontmatter: false, frontmatter: "", body: text };
}

function replaceManagedRawFrontmatter(content: Buffer, managedLines: string[]): Buffer {
  const sections = splitRawMarkdownBytes(content);
  const newline = sections.newline;
  const managed = Buffer.from(`${managedLines.join(newline)}${newline}`, "utf8");
  if (!sections.hasFrontmatter) {
    return Buffer.concat([
      Buffer.from(`---${newline}`, "utf8"),
      managed,
      Buffer.from(`---${newline}`, "utf8"),
      content
    ]);
  }
  const unmanaged = removeManagedRawFrontmatterBytes(sections.frontmatter);
  const separator = unmanaged.length > 0 && !endsWithNewline(unmanaged)
    ? Buffer.from(newline, "utf8")
    : Buffer.alloc(0);
  return Buffer.concat([
    sections.opening,
    unmanaged,
    separator,
    managed,
    sections.closing,
    sections.body
  ]);
}

function splitRawMarkdownBytes(content: Buffer): {
  hasFrontmatter: boolean;
  opening: Buffer;
  frontmatter: Buffer;
  closing: Buffer;
  body: Buffer;
  newline: "\n" | "\r\n";
} {
  const opening = readRawMarkdownLine(content, 0);
  if (!opening || opening.text !== "---") {
    return {
      hasFrontmatter: false,
      opening: Buffer.alloc(0),
      frontmatter: Buffer.alloc(0),
      closing: Buffer.alloc(0),
      body: Buffer.from(content),
      newline: "\n"
    };
  }
  let cursor = opening.end;
  while (cursor <= content.length) {
    const line = readRawMarkdownLine(content, cursor);
    if (!line) break;
    if (line.text === "---" || line.text === "...") {
      return {
        hasFrontmatter: true,
        opening: Buffer.from(content.subarray(0, opening.end)),
        frontmatter: Buffer.from(content.subarray(opening.end, line.start)),
        closing: Buffer.from(content.subarray(line.start, line.end)),
        body: Buffer.from(content.subarray(line.end)),
        newline: opening.newline || line.newline || "\n"
      };
    }
    if (line.end <= cursor) break;
    cursor = line.end;
  }
  throw new Error("Raw Markdown frontmatter 未闭合，拒绝写入 EchoInk 托管字段");
}

function removeManagedRawFrontmatterBytes(frontmatter: Buffer): Buffer {
  const kept: Buffer[] = [];
  let cursor = 0;
  let skipping = false;
  while (cursor < frontmatter.length) {
    const line = readRawMarkdownLine(frontmatter, cursor);
    if (!line) break;
    const key = frontmatterKey(line.text);
    if (key) {
      skipping = RAW_DIGEST_MANAGED_KEYS.has(key);
      if (!skipping) kept.push(Buffer.from(frontmatter.subarray(line.start, line.end)));
    } else if (skipping && /^\s+/.test(line.text)) {
      // Continuation lines belong to the managed YAML field.
    } else {
      skipping = false;
      kept.push(Buffer.from(frontmatter.subarray(line.start, line.end)));
    }
    if (line.end <= cursor) break;
    cursor = line.end;
  }
  return Buffer.concat(kept);
}

function readRawMarkdownLine(
  content: Buffer,
  start: number
): {
  start: number;
  end: number;
  text: string;
  newline: "" | "\n" | "\r\n";
} | null {
  if (start < 0 || start > content.length) return null;
  if (start === content.length) return null;
  const newlineIndex = content.indexOf(0x0a, start);
  const contentEnd = newlineIndex < 0 ? content.length : newlineIndex;
  const hasCarriageReturn = contentEnd > start && content[contentEnd - 1] === 0x0d;
  const lineEnd = hasCarriageReturn ? contentEnd - 1 : contentEnd;
  return {
    start,
    end: newlineIndex < 0 ? content.length : newlineIndex + 1,
    text: content.subarray(start, lineEnd).toString("utf8"),
    newline: newlineIndex < 0 ? "" : hasCarriageReturn ? "\r\n" : "\n"
  };
}

function endsWithNewline(content: Buffer): boolean {
  return content.length > 0 && content[content.length - 1] === 0x0a;
}

function readFrontmatterValues(frontmatter: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = frontmatterKey(line);
    if (!key) continue;
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (key === RAW_DIGEST_FIELDS.evidencePaths && !value) {
      const items: string[] = [];
      for (let next = index + 1; next < lines.length && /^\s+-\s+/.test(lines[next]); next += 1) {
        items.push(lines[next].replace(/^\s+-\s+/, "").trim());
        index = next;
      }
      values.set(key, items.join(","));
    } else {
      values.set(key, value);
    }
  }
  return values;
}

function frontmatterKey(line: string): string | null {
  // EchoInk only owns column-zero frontmatter keys. An indented key such as
  // `user:\n  已处理: false` belongs to the user's nested YAML and must remain
  // byte-for-byte untouched.
  const match = line.match(/^([^\s:#\n][^:\n]*):(?:\s|$)/);
  return match?.[1]?.trim() || null;
}

function parseBoolean(value: string | undefined): boolean {
  return /^(true|yes|1|已处理)$/i.test(String(value ?? "").trim());
}

function parseEvidencePaths(value: string): string[] {
  if (!value.trim()) return [];
  return value.split(",").map((item) => normalizeRelativePath(stripYamlString(item))).filter(Boolean);
}

function stripYamlString(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function nonNegativeNumber(value: any): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeRelativePath(value: any): string {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

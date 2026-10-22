/** Existing Raw metadata/canonical text rules, independent from Buffer and filesystem I/O. */
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

export function emptyRawDigestRegistry(): RawDigestRegistry {
  return { schemaVersion: RAW_DIGEST_SCHEMA_VERSION, updatedAt: "", entries: {} };
}
export function normalizeRawDigestRegistry(value: unknown): RawDigestRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRawDigestRegistry();
  const input = value as Record<string, unknown>, entries: Record<string, RawDigestRegistryEntry> = {};
  const rawEntries = input.entries && typeof input.entries === "object" && !Array.isArray(input.entries) ? input.entries as Record<string, unknown> : {};
  const positive = (number: unknown): number => { const result = Number(number); return Number.isFinite(result) && result > 0 ? result : 0; };
  for (const [key, raw] of Object.entries(rawEntries)) {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const rawPath = normalizeRawDigestRelativePath(item.rawPath || key), fingerprint = typeof item.fingerprint === "string" ? item.fingerprint.trim() : "";
    if (!rawPath || !fingerprint) continue;
    entries[rawPath] = { rawPath, fingerprint, size: positive(item.size), mtime: positive(item.mtime), digestedAt: positive(item.digestedAt),
      runId: typeof item.runId === "string" ? item.runId : "", reportPath: normalizeRawDigestRelativePath(item.reportPath ?? ""),
      evidencePaths: Array.isArray(item.evidencePaths) ? (item.evidencePaths as unknown[]).map(normalizeRawDigestRelativePath).filter(Boolean) : [], confidence: item.confidence === "repaired" ? "repaired" : "verified" };
  }
  return { schemaVersion: RAW_DIGEST_SCHEMA_VERSION, updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "", entries };
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

/** The formal maintenance tool accepts Markdown sources, not their attachments or generated indexes. */
export function isKnowledgeMaintenanceSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/");
  return isRawMarkdownPath(normalized)
    && !normalized.split("/").some(segment => !segment || segment.startsWith(".") || /\.assets$/iu.test(segment))
    && !/(?:^|\/)index\.(?:md|markdown)$/iu.test(normalized)
    && !/\.base\.md$/iu.test(normalized);
}

export function rawDigestRecordFromText(content: string): RawDigestFrontmatterRecord | null {
  const parsed = splitFrontmatter(content);
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

export function canonicalRawMarkdownForDigest(text: string): string {
  const parsed = splitFrontmatter(text);
  return parsed.body.replace(/^\r?\n/, "");
}

function splitFrontmatter(text: string): ParsedFrontmatter {
  const withoutBom = text.replace(/^\uFEFF/u, "");
  const normalized = withoutBom.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { hasFrontmatter: false, frontmatter: "", body: withoutBom };
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
  return { hasFrontmatter: false, frontmatter: "", body: withoutBom };
}

function readFrontmatterValues(frontmatter: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = rawDigestFrontmatterKey(line);
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

export function rawDigestFrontmatterKey(line: string): string | null {
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
  return value.split(",").map((item) => normalizeRawDigestRelativePath(stripYamlString(item))).filter(Boolean);
}

function stripYamlString(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export function normalizeRawDigestRelativePath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

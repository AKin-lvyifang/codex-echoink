import { RAW_DIGEST_REGISTRY_PATH, RAW_DIGEST_SCHEMA_VERSION, RAW_DIGEST_FIELDS, RAW_DIGEST_STATUS_DIGESTED, RAW_DIGEST_STATUS_PENDING_REINGEST, RAW_DIGEST_STATUS_FAILED, RAW_DIGEST_STATUS_PENDING_CALIBRATION, RAW_DIGEST_MANAGED_KEYS, normalizeRawDigestRegistry, emptyRawDigestRegistry,
  isRawMarkdownPath, canonicalRawMarkdownForDigest, rawDigestRecordFromText, rawDigestFrontmatterKey as frontmatterKey,
  type RawDigestFrontmatterRecord, type RawDigestRegistryEntry, type RawDigestRegistry } from "./raw-digest-core";
export * from "./raw-digest-core";
import { resolveKnowledgePath, knowledgeRootEntries, knowledgeRootRole, knowledgePrivateRoot, getKnowledgeFolderBindings } from "./root-paths";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";

import { contentFingerprint } from "./raw-integrity";
import { writeFileAtomic, isMissingPathError } from "./utils";

const fsp = getDesktopFsPromises();
const path = getDesktopPath();

export function rawDigestFingerprint(relativePath: string, content: Buffer): string {
  if (!isRawMarkdownPath(relativePath)) return contentFingerprint(content);
  return contentFingerprint(Buffer.from(canonicalRawMarkdownForDigest(content.toString("utf8")), "utf8"));
}

export function rawDigestRecordFromMarkdown(content: Buffer): RawDigestFrontmatterRecord | null {
  return rawDigestRecordFromText(content.toString("utf8"));
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

export interface RawDigestRegistrySource {
  path: string;
  origin: "private" | "legacy";
  registry: RawDigestRegistry;
}

/** Read every store independently: an empty private store must not hide old receipts. */
export async function readRawDigestRegistrySources(vaultPath: string, strict = false): Promise<RawDigestRegistrySource[]> {
  const privateRoot = knowledgePrivateRoot(vaultPath);
  const bindings = getKnowledgeFolderBindings(vaultPath);
  const roots = [...new Set([
    ...(bindings?.roles.outputs.readPaths ?? []),
    ...knowledgeRootEntries(vaultPath).filter(root => knowledgeRootRole(root) === "outputs").sort(),
    "outputs", "Outputs"
  ])];
  const candidates = [
    ...(privateRoot ? [{ absolute: path.join(privateRoot, "processed-sources.json"), origin: "private" as const, root: privateRoot }] : []),
    ...roots.map(root => ({ absolute: path.join(vaultPath, root, ".raw-digest-registry.json"), origin: "legacy" as const, root }))
  ];
  const sources: RawDigestRegistrySource[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.absolute)) continue;
    seen.add(candidate.absolute);
    try {
      if (candidate.origin === "legacy") {
        if (!candidate.root || candidate.root.startsWith("/") || candidate.root.includes("\\")
          || candidate.root.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid Raw registry directory");
        let parent = vaultPath;
        for (const segment of candidate.root.split("/")) {
          parent = path.join(parent, segment);
          const stat = await fsp.lstat(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Raw registry directory is not a regular directory");
        }
      }
      const stat = await fsp.lstat(candidate.absolute);
      if (!stat.isFile() || stat.nlink > 1) throw new Error("Raw registry is not a readable regular file");
      const content = await fsp.readFile(candidate.absolute, "utf8");
      if (!content.trim()) throw new Error("Raw registry is empty or damaged");
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || (value as RawDigestRegistry).schemaVersion !== RAW_DIGEST_SCHEMA_VERSION) throw new Error("Unsupported Raw registry schema");
      sources.push({ path: candidate.absolute, origin: candidate.origin, registry: normalizeRawDigestRegistry(value, strict) });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      if (strict) throw new Error(`Cannot read Raw registry ${candidate.absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sources;
}

/** Private receipts win. Same-level stores use receipt time, store time, then stable root order. */
export async function readRawDigestRegistry(vaultPath: string, strict = false): Promise<RawDigestRegistry> {
  const result = emptyRawDigestRegistry();
  const selected = new Map<string, { priority: number; receiptAt: number; storeAt: number }>();
  for (const source of await readRawDigestRegistrySources(vaultPath, strict)) {
    const priority = source.origin === "private" ? 1 : 0;
    const storeAt = Date.parse(source.registry.updatedAt) || 0;
    if (storeAt > (Date.parse(result.updatedAt) || 0)) result.updatedAt = source.registry.updatedAt;
    for (const [key, entry] of Object.entries(source.registry.entries)) {
      const previous = selected.get(key), receiptAt = entry.digestedAt;
      if (previous && (previous.priority > priority || (previous.priority === priority
        && (previous.receiptAt > receiptAt || (previous.receiptAt === receiptAt && previous.storeAt >= storeAt))))) continue;
      result.entries[key] = entry;
      selected.set(key, { priority, receiptAt, storeAt });
    }
  }
  return result;
}

export async function writeRawDigestRegistry(vaultPath: string, registry: RawDigestRegistry): Promise<void> {
  const privateRoot = knowledgePrivateRoot(vaultPath);
  if (!privateRoot && getKnowledgeFolderBindings(vaultPath)) throw new Error("知识库私有存储尚未就绪，已停止写入处理记录。");
  const absolute = privateRoot ? path.join(privateRoot, "processed-sources.json") : path.join(vaultPath, resolveKnowledgePath(vaultPath, RAW_DIGEST_REGISTRY_PATH));
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

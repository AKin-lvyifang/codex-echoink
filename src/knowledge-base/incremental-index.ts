import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { contentFingerprint } from "./raw-integrity";
import { rawDigestFingerprint } from "./raw-digest";
import { isMissingPathError, normalizeSlashes, writeFileAtomic } from "./utils";

export const KNOWLEDGE_BASE_INDEX_SCHEMA_VERSION = 1;
export const KNOWLEDGE_BASE_INDEX_RELATIVE_PATH = ".obsidian/plugins/codex-echoink/knowledge-index-v1.json";

const DEFAULT_MAX_SEARCH_CHARS = 120_000;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const RAW_INDEX_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const INDEX_ROOTS = ["raw", "wiki", "journal", "outputs", "inbox", "projects"] as const;

export type KnowledgeBaseIndexRoot = typeof INDEX_ROOTS[number];
export type KnowledgeBaseIndexCheckpoint = "lint" | "outputs" | "inbox";

export interface KnowledgeBaseIndexEntry {
  path: string;
  root: KnowledgeBaseIndexRoot;
  size: number;
  mtime: number;
  ctime: number;
  fingerprint: string;
  title: string;
  tags: string[];
  links: string[];
  searchText: string;
  indexedAt: number;
}

export interface KnowledgeBaseIncrementalIndex {
  schemaVersion: number;
  updatedAt: number;
  entries: Record<string, KnowledgeBaseIndexEntry>;
  checkpoints: Partial<Record<KnowledgeBaseIndexCheckpoint, Record<string, string>>>;
}

export interface KnowledgeBaseIndexSeed {
  size: number;
  mtime: number;
  fingerprint?: string;
}

export interface RefreshKnowledgeBaseIndexOptions {
  roots: KnowledgeBaseIndexRoot[];
  seeds?: Record<string, KnowledgeBaseIndexSeed>;
  maxFilesPerRoot?: number;
  maxSearchChars?: number;
  validateRawSafety?: boolean;
}

export interface KnowledgeBaseIndexRefreshResult {
  index: KnowledgeBaseIncrementalIndex;
  entries: KnowledgeBaseIndexEntry[];
  changedPaths: string[];
  deletedPaths: string[];
  reusedCount: number;
  indexedCount: number;
  indexPath: string;
}

export interface KnowledgeBaseIncrementalScope {
  full: boolean;
  paths: string[];
  deletedPaths: string[];
  neighborPaths: string[];
}

const indexCache = new Map<string, { mtime: number; size: number; index: KnowledgeBaseIncrementalIndex }>();

export async function refreshKnowledgeBaseIndex(
  vaultPath: string,
  options: RefreshKnowledgeBaseIndexOptions
): Promise<KnowledgeBaseIndexRefreshResult> {
  const roots = uniqueRoots(options.roots);
  const indexPath = path.join(vaultPath, KNOWLEDGE_BASE_INDEX_RELATIVE_PATH);
  const index = await readKnowledgeBaseIndex(indexPath);
  const previousEntries = index.entries;
  const currentPaths = new Set<string>();
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];
  let reusedCount = 0;
  let indexedCount = 0;
  const indexedAt = Date.now();

  for (const root of roots) {
    const files = await walkIndexRoot(vaultPath, root, {
      maxFiles: options.maxFilesPerRoot,
      validateRawSafety: Boolean(options.validateRawSafety && root === "raw")
    });
    for (const file of files) {
      currentPaths.add(file.relativePath);
      const previous = previousEntries[file.relativePath];
      if (previous && indexMetadataMatches(previous, file.stat)) {
        reusedCount += 1;
        continue;
      }
      const seed = options.seeds?.[file.relativePath];
      const next = !previous && seed?.fingerprint && seedMetadataMatches(seed, file.stat)
        ? seededIndexEntry(file.relativePath, root, file.stat, seed.fingerprint, indexedAt)
        : await buildIndexEntry(file.absolutePath, file.relativePath, root, file.stat, indexedAt, options.maxSearchChars);
      previousEntries[file.relativePath] = next;
      indexedCount += 1;
      if (!previous || previous.fingerprint !== next.fingerprint) changedPaths.push(file.relativePath);
    }
  }

  for (const [relativePath, entry] of Object.entries(previousEntries)) {
    if (!roots.includes(entry.root)) continue;
    if (currentPaths.has(relativePath)) continue;
    delete previousEntries[relativePath];
    deletedPaths.push(relativePath);
  }

  const changed = indexedCount > 0 || deletedPaths.length > 0 || index.schemaVersion !== KNOWLEDGE_BASE_INDEX_SCHEMA_VERSION;
  index.schemaVersion = KNOWLEDGE_BASE_INDEX_SCHEMA_VERSION;
  if (changed) {
    index.updatedAt = indexedAt;
    await persistKnowledgeBaseIndex(indexPath, index);
  }

  return {
    index,
    entries: Object.values(index.entries)
      .filter((entry) => roots.includes(entry.root))
      .sort((left, right) => left.path.localeCompare(right.path)),
    changedPaths: changedPaths.sort((left, right) => left.localeCompare(right)),
    deletedPaths: deletedPaths.sort((left, right) => left.localeCompare(right)),
    reusedCount,
    indexedCount,
    indexPath
  };
}

export function selectKnowledgeBaseIncrementalScope(
  refresh: KnowledgeBaseIndexRefreshResult,
  checkpoint: KnowledgeBaseIndexCheckpoint,
  options: { full?: boolean; includeNeighbors?: boolean; limit?: number; filter?: (entry: KnowledgeBaseIndexEntry) => boolean } = {}
): KnowledgeBaseIncrementalScope {
  const entries = refresh.entries.filter((entry) => options.filter?.(entry) ?? true);
  const currentByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const previous = refresh.index.checkpoints[checkpoint];
  const full = Boolean(options.full || !previous);
  const changed = full
    ? entries.map((entry) => entry.path)
    : entries
      .filter((entry) => previous?.[entry.path] !== entry.fingerprint)
      .map((entry) => entry.path);
  const deletedPaths = previous
    ? Object.keys(previous).filter((relativePath) => !refresh.index.entries[relativePath])
    : [];
  const neighborPaths = options.includeNeighbors
    ? collectOneHopNeighbors(refresh.index, changed, currentByPath)
    : [];
  const limit = normalizePositiveLimit(options.limit, Number.POSITIVE_INFINITY);
  const paths = Array.from(new Set([...changed, ...neighborPaths]))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
  return { full, paths, deletedPaths, neighborPaths: neighborPaths.filter((item) => paths.includes(item)) };
}

export async function commitKnowledgeBaseIndexCheckpoint(
  vaultPath: string,
  refresh: KnowledgeBaseIndexRefreshResult,
  checkpoint: KnowledgeBaseIndexCheckpoint,
  scope: KnowledgeBaseIncrementalScope,
  filter?: (entry: KnowledgeBaseIndexEntry) => boolean
): Promise<void> {
  const current = refresh.index.checkpoints[checkpoint] ?? {};
  if (scope.full) {
    refresh.index.checkpoints[checkpoint] = Object.fromEntries(
      refresh.entries
        .filter((entry) => filter?.(entry) ?? true)
        .map((entry) => [entry.path, entry.fingerprint])
    );
  } else {
    for (const relativePath of scope.paths) {
      const entry = refresh.index.entries[relativePath];
      if (entry && (filter?.(entry) ?? true)) current[relativePath] = entry.fingerprint;
    }
    for (const relativePath of scope.deletedPaths) delete current[relativePath];
    refresh.index.checkpoints[checkpoint] = current;
  }
  refresh.index.updatedAt = Date.now();
  await persistKnowledgeBaseIndex(path.join(vaultPath, KNOWLEDGE_BASE_INDEX_RELATIVE_PATH), refresh.index);
}

export function isKnowledgeBaseOutputWorkItem(entry: KnowledgeBaseIndexEntry): boolean {
  if (entry.root !== "outputs") return false;
  const relative = entry.path.toLowerCase();
  if (relative === "outputs/.ingest-tracker.md") return false;
  return ![
    "outputs/maintenance/",
    "outputs/reviews/",
    "outputs/publishing/",
    "outputs/instructions/",
    "outputs/migrations/"
  ].some((prefix) => relative.startsWith(prefix));
}

export function isKnowledgeBaseInboxWorkItem(entry: KnowledgeBaseIndexEntry): boolean {
  return entry.root === "inbox";
}

export function clearKnowledgeBaseIndexMemoryCache(vaultPath?: string): void {
  if (!vaultPath) {
    indexCache.clear();
    return;
  }
  indexCache.delete(path.join(vaultPath, KNOWLEDGE_BASE_INDEX_RELATIVE_PATH));
}

async function readKnowledgeBaseIndex(indexPath: string): Promise<KnowledgeBaseIncrementalIndex> {
  const stat = await fsp.lstat(indexPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat?.isFile()) return emptyIndex();
  const cached = indexCache.get(indexPath);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.index;
  const parsed = await fsp.readFile(indexPath, "utf8")
    .then((text) => normalizeIndex(JSON.parse(text)))
    .catch(() => emptyIndex());
  indexCache.set(indexPath, { mtime: stat.mtimeMs, size: stat.size, index: parsed });
  return parsed;
}

async function persistKnowledgeBaseIndex(indexPath: string, index: KnowledgeBaseIncrementalIndex): Promise<void> {
  await writeFileAtomic(indexPath, `${JSON.stringify(index)}\n`);
  const stat = await fsp.stat(indexPath);
  indexCache.set(indexPath, { mtime: stat.mtimeMs, size: stat.size, index });
}

function emptyIndex(): KnowledgeBaseIncrementalIndex {
  return {
    schemaVersion: KNOWLEDGE_BASE_INDEX_SCHEMA_VERSION,
    updatedAt: 0,
    entries: {},
    checkpoints: {}
  };
}

function normalizeIndex(value: unknown): KnowledgeBaseIncrementalIndex {
  if (!value || typeof value !== "object") return emptyIndex();
  const record = value as Partial<KnowledgeBaseIncrementalIndex>;
  if (record.schemaVersion !== KNOWLEDGE_BASE_INDEX_SCHEMA_VERSION) return emptyIndex();
  const entries = record.entries && typeof record.entries === "object" ? record.entries : {};
  const checkpoints = record.checkpoints && typeof record.checkpoints === "object" ? record.checkpoints : {};
  return {
    schemaVersion: KNOWLEDGE_BASE_INDEX_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    entries,
    checkpoints
  };
}

async function walkIndexRoot(
  vaultPath: string,
  root: KnowledgeBaseIndexRoot,
  options: { maxFiles?: number; validateRawSafety: boolean }
): Promise<Array<{ absolutePath: string; relativePath: string; stat: fs.Stats }>> {
  const rootPath = path.join(vaultPath, root);
  const rootStat = await fsp.lstat(rootPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory()) {
    if (options.validateRawSafety) throw new Error("raw/ 不是普通目录，知识库任务不会扫描或处理该路径。");
    return [];
  }
  const files: Array<{ absolutePath: string; relativePath: string; stat: fs.Stats }> = [];
  const maxFiles = normalizePositiveLimit(options.maxFiles, Number.POSITIVE_INFINITY);
  const walk = async (current: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith(".") || entry.name === ".DS_Store") continue;
      const absolutePath = path.join(current, entry.name);
      const stat = await fsp.lstat(absolutePath);
      const relativePath = normalizeSlashes(path.relative(vaultPath, absolutePath));
      if (options.validateRawSafety) assertSafeRawIndexEntry(relativePath, stat);
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile() || !shouldIndexFile(root, relativePath)) continue;
      files.push({ absolutePath, relativePath, stat });
    }
  };
  await walk(rootPath);
  return files;
}

function assertSafeRawIndexEntry(relativePath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) throw new Error(`raw/ 不能包含 symlink：${relativePath}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`raw/ 不能包含特殊文件：${relativePath}`);
  if (stat.isFile() && stat.nlink > 1) throw new Error(`raw/ 不能包含 hardlink：${relativePath}`);
}

function shouldIndexFile(root: KnowledgeBaseIndexRoot, relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (root === "raw") {
    if (relativePath === "raw/index.md" || /^raw\/index \d+\.md$/i.test(relativePath)) return false;
    const lower = relativePath.toLowerCase();
    if (lower.endsWith(".base") || lower.endsWith(".base.md") || lower.includes(".assets/")) return false;
    return RAW_INDEX_EXTENSIONS.has(extension);
  }
  return MARKDOWN_EXTENSIONS.has(extension);
}

async function buildIndexEntry(
  absolutePath: string,
  relativePath: string,
  root: KnowledgeBaseIndexRoot,
  stat: fs.Stats,
  indexedAt: number,
  maxSearchChars = DEFAULT_MAX_SEARCH_CHARS
): Promise<KnowledgeBaseIndexEntry> {
  if (!MARKDOWN_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return {
      path: relativePath,
      root,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      fingerprint: await fingerprintFile(absolutePath, stat.size),
      title: path.basename(relativePath, path.extname(relativePath)),
      tags: [],
      links: [],
      searchText: "",
      indexedAt
    };
  }
  const content = await fsp.readFile(absolutePath);
  const text = content.toString("utf8");
  return {
    path: relativePath,
    root,
    size: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    fingerprint: root === "raw" ? rawDigestFingerprint(relativePath, content) : contentFingerprint(content),
    title: knowledgeTitle(relativePath, text),
    tags: knowledgeTags(text),
    links: knowledgeLinks(text),
    searchText: text.slice(0, normalizePositiveLimit(maxSearchChars, DEFAULT_MAX_SEARCH_CHARS)),
    indexedAt
  };
}

function seededIndexEntry(
  relativePath: string,
  root: KnowledgeBaseIndexRoot,
  stat: fs.Stats,
  fingerprint: string,
  indexedAt: number
): KnowledgeBaseIndexEntry {
  return {
    path: relativePath,
    root,
    size: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    fingerprint,
    title: path.basename(relativePath, path.extname(relativePath)),
    tags: [],
    links: [],
    searchText: "",
    indexedAt
  };
}

async function fingerprintFile(absolutePath: string, size: number): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${size}:${hash.digest("hex")}`;
}

function indexMetadataMatches(entry: KnowledgeBaseIndexEntry, stat: fs.Stats): boolean {
  return entry.size === stat.size
    && Math.abs(entry.mtime - stat.mtimeMs) < 1
    && Math.abs(entry.ctime - stat.ctimeMs) < 1;
}

function seedMetadataMatches(seed: KnowledgeBaseIndexSeed, stat: fs.Stats): boolean {
  return seed.size === stat.size && Math.abs(seed.mtime - stat.mtimeMs) < 1;
}

function knowledgeTitle(relativePath: string, text: string): string {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || path.basename(relativePath).replace(/\.(md|markdown)$/i, "");
}

function knowledgeTags(text: string): string[] {
  const tags = new Set<string>();
  const frontmatter = text.startsWith("---\n") ? text.slice(4, text.indexOf("\n---", 4) >= 0 ? text.indexOf("\n---", 4) : 4) : "";
  for (const match of frontmatter.matchAll(/(?:^|\n)tags?\s*:\s*(?:\[([^\]]*)\]|([^\n]+))/gi)) {
    for (const value of `${match[1] ?? ""},${match[2] ?? ""}`.split(/[,，\s]+/)) {
      const normalized = value.trim().replace(/^#/, "");
      if (normalized) tags.add(normalized);
    }
  }
  for (const match of text.matchAll(/(^|[\s（(])#([\p{L}\p{N}_/-]{2,})/gu)) tags.add(match[2]);
  return Array.from(tags).slice(0, 64);
}

function knowledgeLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/\[\[([^\]|#\n\r]+)(?:#[^\]|\n\r]+)?(?:\|[^\]\n\r]+)?\]\]/g)) {
    const normalized = normalizeKnowledgeLink(match[1] ?? "");
    if (normalized) links.add(normalized);
  }
  return Array.from(links).slice(0, 256);
}

function collectOneHopNeighbors(
  index: KnowledgeBaseIncrementalIndex,
  paths: string[],
  currentByPath: Map<string, KnowledgeBaseIndexEntry>
): string[] {
  const selected = new Set(paths);
  const aliases = buildIndexAliases(index);
  const neighbors = new Set<string>();
  for (const relativePath of paths) {
    const entry = index.entries[relativePath];
    for (const link of entry?.links ?? []) {
      const target = resolveIndexedLink(link, aliases);
      if (target && currentByPath.has(target) && !selected.has(target)) neighbors.add(target);
    }
  }
  for (const entry of currentByPath.values()) {
    if (selected.has(entry.path)) continue;
    if (entry.links.some((link) => {
      const target = resolveIndexedLink(link, aliases);
      return Boolean(target && selected.has(target));
    })) {
      neighbors.add(entry.path);
    }
  }
  return Array.from(neighbors).sort((left, right) => left.localeCompare(right));
}

function buildIndexAliases(index: KnowledgeBaseIncrementalIndex): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of Object.values(index.entries)) {
    const withoutExtension = entry.path.replace(/\.(md|markdown)$/i, "");
    const base = path.basename(withoutExtension);
    aliases.set(entry.path.toLowerCase(), entry.path);
    aliases.set(withoutExtension.toLowerCase(), entry.path);
    if (!aliases.has(base.toLowerCase())) aliases.set(base.toLowerCase(), entry.path);
  }
  return aliases;
}

function resolveIndexedLink(link: string, aliases: Map<string, string>): string {
  const normalized = normalizeKnowledgeLink(link).toLowerCase();
  return aliases.get(normalized)
    || aliases.get(normalized.replace(/\.(md|markdown)$/i, ""))
    || "";
}

function normalizeKnowledgeLink(value: string): string {
  return normalizeSlashes(value.trim().replace(/^\/+/, "").replace(/\.(md|markdown)$/i, ""));
}

function uniqueRoots(roots: KnowledgeBaseIndexRoot[]): KnowledgeBaseIndexRoot[] {
  return Array.from(new Set(roots)).filter((root): root is KnowledgeBaseIndexRoot => INDEX_ROOTS.includes(root));
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

import type { MobileServices } from "./services";
import type { KnowledgePageScan } from "./knowledge-page-scan";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { knowledgeRolePath, resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths-core";
import { buildKnowledgeStructureHealth } from "../knowledge-base/health-core";
import { rawDigestStateForRecord } from "../knowledge-base/digest-status";
import { canonicalRawMarkdownForDigest, rawDigestRecordFromText, normalizeRawDigestRegistry, RAW_DIGEST_REGISTRY_PATH, type RawDigestRegistryEntry, type RawDigestFrontmatterRecord } from "../knowledge-base/raw-digest-core";
import type { KnowledgeBaseMaintenanceHistoryEntry } from "../settings/settings";
import { sha256Hex } from "../utils/sha256";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Raw read coverage is explicit; an unread calibration input is never replaced with zero. */
export async function loadMobileKnowledgeHealth(services: MobileServices, bindings: KnowledgeFolderBindings, scans: KnowledgePageScan[], history: KnowledgeBaseMaintenanceHistoryEntry[], check: () => void) {
  const adapter = services.app.vault.adapter, raw = scans.find(scan => scan.directory.role === "raw")!, wiki = scans.find(scan => scan.directory.role === "wiki")!;
  if (scans.some(scan => scan.directory.state === "partial" || scan.directory.state === "unavailable")) throw new Error("部分用途位置尚未读完，暂时无法评估健康。");
  const privateRoot = services.directory.replace(/\/mobile$/u, "") + "/pi-agent-product-v1/knowledge";
  const privateRegistry = `${privateRoot}/processed-sources.json`, listed = await adapter.list(""); check();
  const roots = [...listed.folders].filter(path => !path.startsWith("."));
  const registryPath = await adapter.exists(privateRegistry) ? privateRegistry : resolveKnowledgePathFromRoots(RAW_DIGEST_REGISTRY_PATH, roots);
  let registry: Record<string, RawDigestRegistryEntry> = {};
  if (await adapter.exists(registryPath)) {
    const value = object(JSON.parse(await adapter.read(registryPath)) as unknown); check();
    if (value.schemaVersion !== 1) throw new Error("来源处理记录版本无效，暂时无法评估健康。");
    registry = normalizeRawDigestRegistry(value).entries;
  }
  let consumed = 0, calibration = 0;
  for (const file of raw.files) {
    check(); const lower = file.path.toLowerCase();
    if (knowledgeRolePath(file.path, bindings) === "raw/index.md" || lower.includes(".assets/")) continue;
    const markdown = /\.(?:md|markdown)$/iu.test(file.path), previous = services.settings.knowledgeBase.processedSources[file.path], entry = registry[file.path];
    let fingerprint = ""; let frontmatter: RawDigestFrontmatterRecord | null = null;
    if (!markdown && entry?.fingerprint && entry.size === file.size && Math.abs(entry.mtime - file.mtime) < 1) fingerprint = entry.fingerprint;
    else if (!markdown && previous?.fingerprint && previous.size === file.size && Math.abs(previous.mtime - file.mtime) < 1) fingerprint = previous.fingerprint;
    else {
      if (file.size > 262144 || consumed + file.size > 2097152) throw new Error("部分来源超过本次读取预算，校准状态尚未核实，暂不显示健康分。");
      consumed += file.size;
      if (markdown) {
        const content = await adapter.read(file.path); check();
        const canonical = canonicalRawMarkdownForDigest(content);
        fingerprint = `sha256:${new TextEncoder().encode(canonical).byteLength}:${sha256Hex(canonical)}`; frontmatter = rawDigestRecordFromText(content);
      } else {
        const bytes = await adapter.readBinary(file.path);
        fingerprint = `sha256:${bytes.byteLength}:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")}`; check();
      }
    }
    if (rawDigestStateForRecord({ fingerprint, frontmatter, previous, registry: entry, hasTrackerHint: false }) === "calibration") calibration++;
  }
  const health = buildKnowledgeStructureHealth({ settings: { ...services.settings.knowledgeBase, folderBindings: bindings }, mappedFolders: true,
    bindingIssues: scans.filter(scan => scan.directory.state === "invalid" || scan.directory.state === "unbound").map(scan => `${scan.directory.role} 位置尚未绑定或已失效`),
    readFailed: false, limited: false, maintenanceHistory: history,
    rawExists: raw.directory.state === "ready", wikiExists: wiki.directory.state === "ready", wikiIndexExists: true, trackerExists: true,
    rawDigestStatus: { calibration } });
  check();
  return health.assessment === "local-structure" || health.assessment === "limited" ? health : null;
}

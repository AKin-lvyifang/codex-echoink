/** Shared source authoring/validation; all filesystem policy is supplied by its host. */
export interface KnowledgeMaintenanceSourcesHost {
  normalizePath(value: string): string;
  rolePath(value: string): string;
  path: { normalize(value: string): string; join(...values: string[]): string; dirname(value: string): string };
}
const REVISION = /^sha256:[a-f0-9]{64}$/u;

export interface KnowledgeMaintenanceRawBinding {
  readonly relativePath: string;
  readonly contentSha256: string;
}

export interface KnowledgeMaintenanceSourceEvidence {
  readonly relativePath: string;
  readonly revision: string;
}

export function completeKnowledgeMaintenanceCandidateSources(input: Readonly<{
  targetPath: string;
  content: string;
  selectedSources: readonly Readonly<KnowledgeMaintenanceRawBinding>[];
  resolvePath?: (value: string) => string;
}>, host: KnowledgeMaintenanceSourcesHost): string {
  const allowed = new Map(input.selectedSources.map((source) => [source.relativePath, source.contentSha256]));
  const links = extractReadableRawLinks(input.content, input.targetPath, host, new Set(allowed.keys()));
  for (const match of input.content.matchAll(/<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu)) {
    try { const value = JSON.parse(match[1]) as { path?: string }; if (value.path) links.add(value.path); } catch { /* obsolete optional marker is replaced below */ }
  }
  if (input.resolvePath) {
    for (const source of [...links]) { links.delete(source); links.add(input.resolvePath(source)); }
  }
  if (!links.size && allowed.size === 1) links.add([...allowed.keys()][0]);
  if (!links.size) throw new Error("来源关系不明确：请注明本候选采用的 Raw；程序不会编造多来源关系。");
  for (const source of links) if (!allowed.has(source)) throw new Error(`来源不在本次范围：${source}`);
  const body = input.content
    .replace(/\[\[([^\]|#\r\n]+)([^\]\r\n]*)\]\]/gu, (match, target: string, suffix: string) => input.resolvePath && host.rolePath(target).startsWith("raw/") ? `[[${input.resolvePath(target)}${suffix}]]` : match)
    .replace(/\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/gu, (match, label: string, target: string) => {
      const source = resolveRawLink(target, input.targetPath, host);
      return input.resolvePath && source ? `[${label}](${input.resolvePath(source)})` : match;
    })
    .replace(/<!--\s*echoink-source[^\n]*?-->/gu, "").trimEnd();
  return body + "\n\n" + [...links].map((source) =>
    `[[${source}|原始材料]]\n<!-- echoink-source: ${JSON.stringify({ path: source, revision: `sha256:${allowed.get(source)}` })} -->`
  ).join("\n") + "\n";
}

/**
 * Fail-closed validation for every model-authored Wiki/Projects candidate.
 * Human links and machine revisions must form the same non-empty source set,
 * and every source must be one of the Raw snapshots locked for this run.
 */
export function validateKnowledgeMaintenanceCandidateSources(input: Readonly<{
  targetPath: string;
  content: string;
  selectedSources: readonly Readonly<KnowledgeMaintenanceRawBinding>[];
}>, host: KnowledgeMaintenanceSourcesHost): readonly Readonly<KnowledgeMaintenanceSourceEvidence>[] {
  const targetPath = host.normalizePath(input.targetPath);
  const allowed = new Map(input.selectedSources.map((source) => [
    normalizeRawPath(source.relativePath, host),
    normalizeDigest(source.contentSha256)
  ]));
  const links = extractReadableRawLinks(input.content, targetPath, host, new Set(allowed.keys()));
  const markers = extractMachineSourceMarkers(input.content, host);
  if (links.size === 0 || markers.size === 0) {
    throw new Error("knowledge_candidate_source_missing");
  }
  if (
    links.size !== markers.size
    || [...links].some((relativePath) => !markers.has(relativePath))
    || [...markers.keys()].some((relativePath) => !links.has(relativePath))
  ) {
    throw new Error("knowledge_candidate_source_mismatch");
  }
  const evidence: KnowledgeMaintenanceSourceEvidence[] = [];
  for (const relativePath of [...links].sort((left, right) =>
    left.localeCompare(right, "en")
  )) {
    const expectedDigest = allowed.get(relativePath);
    const revision = markers.get(relativePath);
    if (!expectedDigest || !revision) {
      throw new Error("knowledge_candidate_source_outside_snapshot");
    }
    if (revision !== `sha256:${expectedDigest}`) {
      throw new Error("knowledge_candidate_source_revision_mismatch");
    }
    evidence.push(Object.freeze({ relativePath, revision }));
  }
  return Object.freeze(evidence);
}

export function extractMachineSourceMarkers(content: string, host: KnowledgeMaintenanceSourcesHost): Map<string, string> {
  const markers = new Map<string, string>();
  const markerLikeCount = [...content.matchAll(/echoink-source/giu)].length;
  let parsedCount = 0;
  for (const match of content.matchAll(
    /<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu
  )) {
    parsedCount += 1;
    let value: unknown;
    try {
      value = JSON.parse(match[1] ?? "");
    } catch {
      throw new Error("knowledge_candidate_source_marker_invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("knowledge_candidate_source_marker_invalid");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\0") !== "path\0revision"
      || typeof record.path !== "string"
      || typeof record.revision !== "string"
      || !REVISION.test(record.revision)
    ) {
      throw new Error("knowledge_candidate_source_marker_invalid");
    }
    const relativePath = normalizeRawPath(record.path, host);
    const existing = markers.get(relativePath);
    if (existing && existing !== record.revision) {
      throw new Error("knowledge_candidate_source_marker_conflict");
    }
    markers.set(relativePath, record.revision);
  }
  if (markerLikeCount !== parsedCount) {
    throw new Error("knowledge_candidate_source_marker_invalid");
  }
  return markers;
}

function extractReadableRawLinks(
  content: string,
  knowledgePath: string,
  host: KnowledgeMaintenanceSourcesHost,
  allowed?: ReadonlySet<string>
): Set<string> {
  const links = new Set<string>();
  for (const match of content.matchAll(
    /\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]+)?(?:\|[^\]\r\n]+)?\]\]/gu
  )) {
    const relativePath = resolveRawLink(match[1] ?? "", knowledgePath, host, allowed);
    if (relativePath) links.add(relativePath);
  }
  for (const match of content.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/gu)) {
    const target = (match[1] ?? "").trim().replace(/^<|>$/gu, "")
      .split(/\s+["']/u, 1)[0] ?? "";
    const relativePath = resolveRawLink(target, knowledgePath, host, allowed);
    if (relativePath) links.add(relativePath);
  }
  return links;
}

function resolveRawLink(value: string, knowledgePath: string, host: KnowledgeMaintenanceSourcesHost, allowed?: ReadonlySet<string>): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.trim());
  } catch {
    return null;
  }
  if (!decoded || /^[a-z]+:\/\//iu.test(decoded)) return null;
  const withoutAnchor = decoded.split(/[?#]/u, 1)[0]?.replace(/^\/+/, "") ?? "";
  const candidate = (allowed ? allowed.has(withoutAnchor) : host.rolePath(withoutAnchor).toLowerCase().startsWith("raw/"))
    ? host.path.normalize(withoutAnchor)
    : host.path.normalize(host.path.join(
        host.path.dirname(knowledgePath),
        withoutAnchor
      ));
  try {
    if (allowed && !allowed.has(candidate)) return null;
    return normalizeRawPath(candidate, host);
  } catch {
    return null;
  }
}

function normalizeRawPath(value: string, host: KnowledgeMaintenanceSourcesHost): string {
  const relativePath = host.normalizePath(value);
  if (
     relativePath.split("/").some((segment) => segment.startsWith("."))
  ) {
    throw new Error("knowledge_candidate_raw_path_invalid");
  }
  return relativePath;
}

function normalizeDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("knowledge_candidate_source_digest_invalid");
  }
  return value;
}

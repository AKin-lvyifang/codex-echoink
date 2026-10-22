import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { MaintenanceKnowledgeSource, MaintenanceKnowledgeType, MaintenanceKnowledgeUnit } from "./maintenance-p2-contract";
import { MAINTENANCE_KNOWLEDGE_TYPES } from "./maintenance-knowledge-types";

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function knownType(value: unknown): value is MaintenanceKnowledgeType {
  return typeof value === "string" && (MAINTENANCE_KNOWLEDGE_TYPES as readonly string[]).includes(value);
}

function evidenceLocation(unitId: string, sourcePath: unknown): string {
  return `[unit.id=${JSON.stringify(unitId)}, sourcePath=${typeof sourcePath === "string" ? JSON.stringify(sourcePath) : "<missing>"}]`;
}

/** note_read exposes a bare digest; accept only that exact alternate spelling. */
function evidenceRevision(value: unknown, location: string): string {
  if (typeof value === "string" && /^[a-f\d]{64}$/iu.test(value)) return `sha256:${value.toLowerCase()}`;
  if (typeof value === "string" && /^sha256:[a-f\d]{64}$/u.test(value)) return value;
  throw new Error(`${location} 版本格式非法：sourceRevision must be exactly 64 hex characters or sha256:<64 lowercase hex>.`);
}

function normalizedAlias(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

const MANAGEMENT_SECTION_TITLES = new Set([
  "来源", "资料来源", "原始来源", "参考来源", "引用来源", "来源与引用", "参考", "参考资料", "参考文献", "引用",
  "相关条目", "相关知识", "相关页面", "相关笔记", "相关链接", "相关文章", "延伸阅读",
  "source", "sources", "reference", "references", "citation", "citations", "related", "relatedentries", "relatedpages",
  "relatednotes", "relatedlinks", "relatedknowledge", "relatedarticles", "seealso", "furtherreading"
]);

function isManagementSection(title: string): boolean {
  const normalized = title.normalize("NFKC").replace(/[*_`]/gu, "").replace(/^\s*\d+[.)、:：-]\s*/u, "").trim();
  const compact = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  if (MANAGEMENT_SECTION_TITLES.has(compact(normalized))) return true;
  // Bilingual labels such as “来源 / Sources” remain management sections.
  const parts = normalized.split(/[/|()（）:：]/u).map(compact).filter(Boolean);
  return parts.length > 1 && parts.every((part) => MANAGEMENT_SECTION_TITLES.has(part));
}

function frontmatter(content: string): { yaml: string | null; body: string } {
  const withoutBom = content.replace(/^\uFEFF/u, "");
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/u.exec(withoutBom);
  if (!opening) return { yaml: null, body: withoutBom };
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gmu;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(withoutBom);
  if (!match) throw new Error("Knowledge frontmatter is not closed.");
  return { yaml: withoutBom.slice(opening[0].length, match.index), body: withoutBom.slice(match.index + match[0].length) };
}

/**
 * Checks exact quote presence in source body and the full-file revision only.
 * It does not establish that a quote semantically supports a unit's points.
 * The caller additionally checks that each unit cites its decomposition source.
 */
export function validateMaintenanceKnowledgeUnits(
  units: readonly MaintenanceKnowledgeUnit[],
  sources: readonly MaintenanceKnowledgeSource[]
): void {
  if (!Array.isArray(units) || !Array.isArray(sources)) throw new Error("Knowledge units and sources must be arrays.");
  const sourceByPath = new Map<string, { revision: string; body: string }>();
  for (const source of sources) {
    if (!source || !nonempty(source.path) || typeof source.content !== "string" || !nonempty(source.contentRevision)) throw new Error("Knowledge source requires a path, full content and contentRevision.");
    if (sourceByPath.has(source.path)) throw new Error("Knowledge source paths must be unique.");
    const referencingUnits = units.filter((unit) => unit && Array.isArray(unit.evidence) && unit.evidence.some((evidence) => evidence?.sourcePath === source.path));
    const location = evidenceLocation(referencingUnits.map((unit) => unit.id).join(", ") || "<unreferenced>", source.path);
    if (!/^sha256:[a-f\d]{64}$/u.test(source.contentRevision)) throw new Error(`${location} 版本格式非法：host contentRevision must use sha256:<64 lowercase hex>.`);
    const actualRevision = `sha256:${createHash("sha256").update(source.content, "utf8").digest("hex")}`;
    if (source.contentRevision !== actualRevision) throw new Error(`${location} 全文版本不匹配：source contentRevision must match its full content.`);
    sourceByPath.set(source.path, { revision: source.contentRevision, body: frontmatter(source.content).body });
  }
  const ids = new Set<string>();
  for (const unit of units) {
    if (!unit || !nonempty(unit.id) || !knownType(unit.type) || !nonempty(unit.domain) || !nonempty(unit.title)) throw new Error("Knowledge unit requires a nonempty id, one of seven types, domain and title.");
    if (ids.has(unit.id)) throw new Error("Knowledge unit ids must be unique.");
    ids.add(unit.id);
    if (unit.typePendingConfirmation !== undefined && typeof unit.typePendingConfirmation !== "boolean") throw new Error("Knowledge typePendingConfirmation must be boolean.");
    if (!Array.isArray(unit.aliases) || !unit.aliases.every(nonempty)) throw new Error("Knowledge unit aliases must be a string list.");
    if (!Array.isArray(unit.points) || !unit.points.length || !unit.points.every(nonempty)) throw new Error("Knowledge unit points must be a nonempty string list.");
    if (!Array.isArray(unit.evidence) || !unit.evidence.length) throw new Error("Knowledge unit evidence must be nonempty.");
    for (const evidence of unit.evidence) {
      const location = evidenceLocation(unit.id, evidence?.sourcePath);
      if (!evidence || !nonempty(evidence.sourcePath)) throw new Error(`${location} sourcePath 缺失或为空，须指定本批来源路径。`);
      const source = sourceByPath.get(evidence.sourcePath);
      if (!source) throw new Error(`${location} sourcePath is outside this batch's sources，须重读本批允许的来源。`);
      if (evidenceRevision(evidence.sourceRevision, location) !== source.revision) throw new Error(`${location} 全文版本不匹配：sourceRevision does not match the source's full-file revision，请重读该来源。`);
      if (!nonempty(evidence.quote) || !source.body.includes(evidence.quote)) throw new Error(`${location} quote 不是连续正文原句：must exist exactly in the source body。请保留原文换行、重读该来源；原句存在不代表语义支持。`);
    }
  }
}

/** Validate new pages only; existing-page metadata is deliberately outside this API. */
export function validateMaintenanceNewPage(content: string, units: readonly MaintenanceKnowledgeUnit[]): void {
  if (!nonempty(content) || !Array.isArray(units) || !units.length || !units.every((unit) => unit && knownType(unit.type))) throw new Error("New knowledge pages require content and typed knowledge units.");
  const parsed = frontmatter(content);
  if (parsed.yaml === null) throw new Error("New knowledge pages require YAML frontmatter.");
  const document = parseDocument(parsed.yaml, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error("New knowledge frontmatter must be an unambiguous YAML mapping.");
  const field = (name: string) => document.contents && isMap(document.contents)
    ? document.contents.items.find((pair) => isScalar(pair.key) && !pair.key.anchor && !pair.key.tag && pair.key.value === name)?.value
    : undefined;
  const type = field("类型");
  if (!isScalar(type) || type.anchor || type.tag || !knownType(type.value) || type.value !== units[0].type) throw new Error("New page 类型 must be one of seven types and match its primary unit.");
  const aliases = field("aliases");
  if (!isSeq(aliases) || aliases.anchor || aliases.tag || !aliases.items.every((item) => isScalar(item) && !item.anchor && !item.tag && nonempty(item.value))) throw new Error("New page aliases must be a standard string list, including [] when empty.");
  if (document.contents.items.some((pair) => isScalar(pair.key) && pair.key.value === "别名")) throw new Error("New page aliases must use only the standard aliases field, not 别名.");
  const pageAliases = new Set(aliases.items.map((item) => normalizedAlias(String(isScalar(item) ? item.value : ""))));
  for (const unit of units) {
    if (!Array.isArray(unit.aliases) || !unit.aliases.every(nonempty)) throw new Error("Knowledge unit aliases must be a string list.");
    if (unit.aliases.some((alias) => !pageAliases.has(normalizedAlias(alias)))) throw new Error("New page aliases must preserve all knowledge unit aliases.");
  }
  const pending = field("类型待确认");
  if (pending !== undefined && (!isScalar(pending) || pending.anchor || pending.tag || typeof pending.value !== "boolean")) throw new Error("New page 类型待确认 must be boolean.");
  if (units.some((unit) => unit.typePendingConfirmation) && (!isScalar(pending) || pending.value !== true)) throw new Error("Uncertain knowledge types require 类型待确认: true.");

  // Mask code and comments before detecting headings, so examples cannot supply structure.
  let fence: { character: string; length: number } | undefined;
  const bodyLines = parsed.body.replace(/<!--[\s\S]*?-->/gu, "").split(/\r\n|\n|\r/u);
  const lines = bodyLines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return ""; }
    return line;
  });
  const headings = lines.flatMap((line, index) => {
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u.exec(line);
    return match && nonempty(match[2]) ? [{ index, level: match[1].length, title: match[2] }] : [];
  });
  const h1 = headings.filter((heading) => heading.level === 1);
  if (h1.length !== 1 || headings[0] !== h1[0]) throw new Error("New knowledge pages require one H1 before their sections.");
  const firstSection = headings.find((heading) => heading.level > 1);
  const readable = (values: readonly string[]) => values.some((line) => /[\p{L}\p{N}]/u.test(line));
  if (!firstSection || !readable(lines.slice(h1[0].index + 1, firstSection.index))) throw new Error("New knowledge pages require a nonempty lead after H1 and structured content.");
  const sectionLines = bodyLines.map((line) => /^ {0,3}(?:`{3,}|~{3,})/u.test(line) ? "" : line);
  let managementLevel: number | undefined;
  const hasKnowledgeContent = headings.some((heading, index) => {
    if (managementLevel !== undefined && heading.level <= managementLevel) managementLevel = undefined;
    if (heading.level > 1 && isManagementSection(heading.title) && managementLevel === undefined) managementLevel = heading.level;
    return heading.level > 1 && managementLevel === undefined && readable(sectionLines.slice(heading.index + 1, headings[index + 1]?.index));
  });
  if (!hasKnowledgeContent) throw new Error("New knowledge pages require a section with knowledge content beyond sources/related entries; section titles may be customized.");
}

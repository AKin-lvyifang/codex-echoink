import { isMap, parseDocument } from "yaml";
import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";
import type { MaintenanceWritingItem } from "./maintenance-p1-contract";
import type { MaintenanceKnowledgeType, MaintenanceKnowledgeUnit, MaintenanceRelatedEntry, MaintenanceUnitCandidates } from "./maintenance-p2-contract";
import { MAINTENANCE_KNOWLEDGE_TYPES } from "./maintenance-knowledge-types";

/** Current unambiguous, valid visible properties win field by field. */
export function maintenanceVisibleClassification(content: string): { type?: MaintenanceKnowledgeType; domain?: string } {
  const frontmatter = content.match(/^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/mu)?.[1];
  if (!frontmatter) return {};
  const yaml = parseDocument(frontmatter, { uniqueKeys: true, strict: true });
  if (yaml.errors.length || yaml.warnings.length || !isMap(yaml.contents)) return {};
  const type = yaml.get("类型"), domain = yaml.get("领域");
  return { ...(MAINTENANCE_KNOWLEDGE_TYPES.includes(type as never) ? { type: type as MaintenanceKnowledgeType } : {}), ...(typeof domain === "string" && domain.trim() ? { domain: domain.trim() } : {}) };
}

export function validateMaintenanceP2Plan(plan: readonly MaintenanceWritingItem[], units: readonly MaintenanceKnowledgeUnit[], candidates: readonly MaintenanceUnitCandidates[]): void {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const used = new Set<string>();
  const pageByUnit = new Map<string, MaintenanceWritingItem>();
  for (const item of plan) {
    const fields = item.knowledge;
    if (!fields || !Array.isArray(fields.unitIds) || !fields.unitIds.length || new Set(fields.unitIds).size !== fields.unitIds.length || !fields.decision || !["new", "same_point", "uncertain"].includes(fields.decision.kind) || typeof fields.decision.reason !== "string" || !fields.decision.reason.trim()) throw new Error("P2清单必须声明knowledge.unitIds与同知识点判断decision及理由。");
    const own: MaintenanceKnowledgeUnit[] = [];
    for (const id of fields.unitIds) {
      const unit = byId.get(id);
      if (!unit || used.has(id)) throw new Error(`知识点必须且只能安排一次：${id}`);
      own.push(unit); used.add(id); pageByUnit.set(id, item);
    }
    if ((fields.type !== undefined && !MAINTENANCE_KNOWLEDGE_TYPES.includes(fields.type)) || (fields.domain !== undefined && (typeof fields.domain !== "string" || !fields.domain.trim()))) throw new Error("最终类型与领域无效。");
    if ((new Set(own.map(unit => unit.domain)).size !== 1 && !fields.domain) || (new Set(own.map(unit => unit.type)).size !== 1 && !fields.type)) throw new Error("暂分类不一致时，在knowledge.type/domain明确同知识点的最终分类；原句证据保持。");
    const sources = new Set(own.flatMap(unit => unit.evidence.map(evidence => evidence.sourcePath)));
    if (item.sourcePaths.length !== sources.size || item.sourcePaths.some(source => !sources.has(source))) throw new Error(`清单来源须与知识点原句证据逐一对应：${item.targetPath}`);
    const recalled = candidates.filter(candidate => fields.unitIds.includes(candidate.unitId)).flatMap(candidate => candidate.candidates);
    if (item.expectedTarget.kind === "file") {
      if (fields.decision.kind !== "same_point" || fields.decision.candidatePath !== item.targetPath || !recalled.some(candidate => candidate.path === item.targetPath)) throw new Error("已有页仅在候选中确认为同知识点后更新；不能合并两张旧页。");
    } else {
      if (fields.decision.kind === "same_point") throw new Error("same_point必须指向已读过的现有Wiki。");
      const exact = recalled.filter(candidate => candidate.matches.some(match => match === "title" || match === "alias"));
      if (exact.length && fields.decision.kind !== "uncertain") throw new Error("标题或别名已有候选；确认同知识点更新原页，拿不准新建并解释相关关系。");
      if (fields.decision.kind === "uncertain" && (!fields.related?.length || (fields.decision.candidatePath && !fields.related.some(relation => relation.targetPath === fields.decision.candidatePath)))) throw new Error("不确定新建须声明相关条目及关系说明，程序会补互链。");
    }
    for (const relation of fields.related ?? []) if (!relation || typeof relation.targetPath !== "string" || relation.targetPath === item.targetPath || typeof relation.reason !== "string" || !relation.reason.trim() || /[\r\n\[\]<>]/u.test(relation.reason)) throw new Error("相关条目需有效目标与单行关系说明，不能是自链或指令。");
    if (fields.decision.kind === "uncertain" && fields.related?.some(relation => typeof relation.reverseReason !== "string" || !relation.reverseReason.trim() || /[\r\n\[\]<>]/u.test(relation.reverseReason))) throw new Error("不确定条目的互链须分别声明reason/reverseReason，写清两个方向的关系。");
  }
  for (const unit of units) if (!used.has(unit.id)) throw new Error(`知识点未安排：${unit.id}`);
  for (const candidate of candidates) for (const other of candidate.batchUnitIds) {
    const a = pageByUnit.get(candidate.unitId), b = pageByUnit.get(other);
    if (a && b && a !== b && (!a.knowledge?.related?.some(relation => relation.targetPath === b.targetPath) || !b.knowledge?.related?.some(relation => relation.targetPath === a.targetPath) || a.knowledge.decision.kind !== "uncertain" || b.knowledge.decision.kind !== "uncertain")) throw new Error("批内标题/别名重合应聚合为一页；不确定分开时双方须声明关系和uncertain理由。");
  }
}

export function maintenancePlanRelations(plan: readonly MaintenanceWritingItem[]): Map<string, MaintenanceRelatedEntry[]> {
  const relations = new Map<string, MaintenanceRelatedEntry[]>();
  const add = (from: string, to: string, reason: string) => {
    const list = relations.get(from) ?? [];
    if (!list.some(relation => relation.targetPath === to)) list.push({ targetPath: to, reason });
    relations.set(from, list);
  };
  for (const item of plan) for (const relation of item.knowledge?.related ?? []) {
    add(item.targetPath, relation.targetPath, relation.reason);
    // An uncertain split is explicitly represented on both sides, including existing pages.
    if (item.knowledge?.decision.kind === "uncertain") add(relation.targetPath, item.targetPath, relation.reverseReason!);
  }
  return relations;
}

const BEGIN = "<!-- echoink-related:BEGIN -->", END = "<!-- echoink-related:END -->";
/** Program-managed relationship block is inserted only after ordinary link defer. */
export function applyMaintenanceRelatedEntries(content: string, relations: readonly MaintenanceRelatedEntry[], baseline?: string): string {
  const snapshot = createMaintenanceSectionSnapshot(content), related = snapshot.regions.find(region => region.kind === "related");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (baseline === undefined && related) {
    // New-page relationships come exclusively from the declared plan. Also drop
    // prose placeholders such as “暂无”; old handwritten sections are retained.
    const level = content.slice(related.start, related.contentStart).match(/^#+/u)?.[0].length ?? 6;
    let end = related.end;
    for (const next of snapshot.regions.filter(region => region.start >= related.end)) {
      const nextLevel = content.slice(next.start, next.contentStart).match(/^#+/u)?.[0].length ?? 0;
      if (nextLevel <= level) break;
      end = next.end;
    }
    return applyMaintenanceRelatedEntries(content.slice(0, related.start) + content.slice(end), relations, baseline);
  }
  if (!relations.length && !baseline?.includes(BEGIN)) {
    return content;
  }
  const retained = new Map<string, string>();
  const readBlock = (text: string) => {
    const sections = createMaintenanceSectionSnapshot(text), section = sections.regions.find(region => region.kind === "related");
    const start = text.indexOf(BEGIN), end = text.indexOf(END);
    if (start < 0 && end < 0) return null;
    if (!section || start < section.contentStart || end < start || end + END.length > section.end || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0) throw new Error("相关条目受管块不在独立相关区或标记损坏，保留当前内容。");
    for (const line of text.slice(start + BEGIN.length, end).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const match = line.match(/^- \[\[([^\]|\r\n]+)(?:\|[^\]\r\n]*)?\]\] — (.+)$/u);
      if (!match) throw new Error("相关条目受管块含无法识别的手写内容，保留当前内容。");
      retained.set(match[1], line);
    }
    return { start, end };
  };
  if (baseline !== undefined) readBlock(baseline);
  const range = readBlock(content);
  for (const relation of relations) retained.set(relation.targetPath, `- [[${relation.targetPath}|${relation.targetPath.split("/").at(-1)!.replace(/\.(?:md|markdown)$/iu, "")}]] — ${relation.reason}`);
  const block = `${BEGIN}${eol}${[...retained].sort(([a],[b]) => a.localeCompare(b)).map(([,line]) => line).join(eol)}${eol}${END}`;
  if (range) return content.slice(0, range.start) + block + content.slice(range.end + END.length);
  if (!related) return content + `${eol}${eol}## 相关条目${eol}${block}${eol}`;
  return content.slice(0, related.end) + `${eol}${block}${eol}` + content.slice(related.end);
}

import type { MaintenanceP1State } from "./maintenance-p1-contract";
import type { MaintenanceKnowledgeUnit } from "./maintenance-p2-contract";

export type MaintenanceInspectionView = "candidates" | "units" | "pages";
/** Leave room for the surrounding status and the existing 8 KB Tool egress cap. */
const INSPECTION_BYTES = 5_600;
export function maintenanceInspection(state: MaintenanceP1State, view: MaintenanceInspectionView, offset = 0) {
  const units = state.decompositions.flatMap(decomposition => decomposition.units).filter((unit): unit is MaintenanceKnowledgeUnit => typeof unit !== "string");
  let rows: unknown[];
  if (view === "candidates") rows = (state.p2?.candidates ?? []).flatMap(result => {
    const unit = units.find(unit => unit.id === result.unitId)!;
    return [{ unitId: result.unitId, title: unit?.title, type: unit?.type, domain: unit?.domain, batchUnitIds: result.batchUnitIds, candidateCount: result.candidates.length }, ...result.candidates.map(candidate => ({ unitId: result.unitId, path: candidate.path, title: candidate.title, matches: candidate.matches }))];
  });
  else if (view === "units") rows = units.flatMap(unit => [
    { unitId: unit.id, type: unit.type, typePendingConfirmation: unit.typePendingConfirmation, domain: unit.domain, title: unit.title, aliases: unit.aliases },
    ...unit.points.map(point => ({ unitId: unit.id, point })),
    ...unit.evidence.map(evidence => ({ unitId: unit.id, sourcePath: evidence.sourcePath, sourceRevision: evidence.sourceRevision }))
  ]);
  else rows = state.writingPlan.filter(page => !state.committedPages[page.id]).map(page => {
    const own = units.filter(unit => page.knowledge?.unitIds.includes(unit.id));
    return { id: page.id, targetPath: page.targetPath, sourcePaths: page.sourcePaths, expectedTarget: page.expectedTarget, unitIds: page.knowledge?.unitIds, type: page.knowledge?.type ?? own[0]?.type, domain: page.knowledge?.domain ?? own[0]?.domain, aliases: [...new Set(own.flatMap(unit => unit.aliases))], hasDraft: !!state.drafts[page.id] };
  });
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw new Error("inspect.offset不在当前分页范围内；从0开始，沿nextOffset继续。");
  const items: unknown[] = [];
  for (const row of rows.slice(offset)) {
    if (Buffer.byteLength(JSON.stringify([...items, row]), "utf8") > INSPECTION_BYTES) {
      if (!items.length) throw new Error("单项维护数据超出回执预算；请缩短过长的知识点要点或别名，原文保持不动。");
      break;
    }
    items.push(row);
  }
  const nextOffset = offset + items.length < rows.length ? offset + items.length : null;
  return { view, offset, total: rows.length, nextOffset, items };
}

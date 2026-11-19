import { PersonalMemoryAccessError } from './personal-memory-error';
import { normalizeRelatedIds, serializeCanonicalMemoryRecord as serializeRecord } from './personal-memory-core';
import { parseDreamState, DREAM_STATE_RELATIVE_PATH } from './dream-state-core';
import { emptyDreamCorrectionState, mergeCorrectionState } from './dream-correction-core';
import { cognitiveJsonText as jsonText } from './cognitive-text';
import type { PersonalMemoryRecord } from './personal-memory-contracts';
import type { DreamPlanFile } from './dream-mutation-plan';
export async function planMemoryAssociations(records: PersonalMemoryRecord[], associationUpdates: readonly {id:string;expectedRevision:number;relatedIds:readonly string[]}[] | undefined, revision:number, extra:DreamPlanFile[], readText:(file:string)=>Promise<string>) {
    for (const update of associationUpdates ?? []) {
      const position = records.findIndex(record => record.id === update.id && record.status === "current");
      if (position < 0 || records[position].revision !== update.expectedRevision) throw new PersonalMemoryAccessError("revision_conflict", "Memory association target revision changed");
      const { related: _previous, ...record } = records[position];
      const related = normalizeRelatedIds(update.relatedIds, update.id);
      const allowed = new Set(records.filter(record => record.status === "current" && !record.pinned).map(record => record.id));
      if (related?.some(id => !allowed.has(id))) throw new PersonalMemoryAccessError("invalid_request", "Memory association target is unavailable");
      const updated = Object.freeze({ ...record, ...(related ? { related } : {}), revision: revision });
      records[position] = updated;
      extra.push({ relativePath: updated.file, content: serializeRecord(updated, await readText(updated.file)) });
    }
    // Relationship-only updates leave the correction's content untouched. Advance its
    // committed revision receipt so the immediately following user undo stays usable.
    if (associationUpdates?.length) {
      const position = extra.findIndex(change => change.relativePath === DREAM_STATE_RELATIVE_PATH);
      if (position >= 0 && extra[position].content) {
        const state = parseDreamState(JSON.parse(extra[position].content) as Record<string, unknown>);
        if (!state) throw new Error("dream_state_invalid");
        const changed = new Set(associationUpdates.map(update => update.id));
        const ledger = state.reconciliation ?? emptyDreamCorrectionState();
        const checks = ledger.checks.filter(check => check.phase === "original" && changed.has(check.memoryId)).map(check => ({ ...check,
          key: JSON.stringify([check.phase, check.memoryId, revision, check.source, null]), memoryRevision: revision }));
        extra[position] = { ...extra[position], content: jsonText({ ...state, reconciliation: mergeCorrectionState(ledger, { checks,
          events: ledger.events.filter(event => event.afterId && changed.has(event.afterId) && event.undoneAt === undefined).map(event => ({ ...event, afterRevision: revision })) }) }) };
      }
    }

}

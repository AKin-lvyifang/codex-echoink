import { PersonalMemoryAccessError } from './personal-memory-error';
import { serializeCanonicalMemoryRecord as serializeRecord } from './personal-memory-core';
import { cognitiveJsonText as jsonText } from './cognitive-text';
import { sha256Hex as contentHash } from '../../utils/sha256';
import { cleanRequired, hasDisallowedControlCharacters } from './memory-turn-snapshot';
import { applyDreamProfileUpdate, rebindProfileSource, reconcileProfileSources, parseUserProfileState, emptyUserProfileState, userProfileStateJson, USER_PROFILE_ITEM_HARD_MAX_CHARS, type UserProfileState } from './user-profile-core';
import { renderUserMarkdown } from './cognitive-projection';
import { invalidatedMemoryProductRunIds, productRunIdFromExperienceProfileSourceId, productRunIdFromMemorySource } from './dream-source-group';
import { reconcileSecondaryForParent, serializeSecondaryRecord } from './secondary-memory-core';
import { canUndoDreamCorrection, emptyDreamCorrectionState, mergeCorrectionState, type DreamCorrectionBatch, type DreamCorrectionEvent } from './dream-correction-core';
import { type DreamState } from './dream-state-core';
import type { PersonalMemoryRecord, SecondaryMemoryRecord } from './personal-memory-contracts';
export interface DreamPlanFile { relativePath: string; content?: string }
interface ProjectionReconciliation { changes: readonly DreamPlanFile[]; userHash?: string }
export interface DreamMutationPlanPort {
 records: readonly PersonalMemoryRecord[]; secondary: readonly SecondaryMemoryRecord[];
 profile: UserProfileState | null; user: string; revision: number; now: number;
 readText(path: string): Promise<string>;
 newRecord(input: Omit<PersonalMemoryRecord, 'schema' | 'id' | 'status' | 'date' | 'file' | 'revision'> & { targetRevision: number }): PersonalMemoryRecord;
}
function normalizeUserProfileWrite(value: string, _name: string): string {
 const clean = value.trim();
 if (!clean || hasDisallowedControlCharacters(clean)) throw new PersonalMemoryAccessError('invalid_request', 'USER.md projection is invalid');
 const normalized = clean + '\n';
 if (new TextEncoder().encode(normalized).length > 128 * 1024) throw new PersonalMemoryAccessError('invalid_request', 'USER.md projection exceeds 131072 UTF-8 bytes');
 return normalized;
}
export function planControlledProjectionSources(
    source: { profile: UserProfileState | null; user: string },
    records: readonly PersonalMemoryRecord[],
    now: number,
    options: Readonly<{
      includeUser?: boolean;
      invalidatedProductRunIds?: ReadonlySet<string>;
      replacement?: Readonly<{
        previousMemoryId: string;
        replacementMemoryId: string;
        previousMemoryRevision: number;
        replacementText: string;
      }>;
    }> = {}
  ): ProjectionReconciliation {
    const validMemoryIds = new Set(records
      .filter((record) => record.status === "current")
      .map((record) => record.id));
    const invalidatedProductRunIds = new Set([
      ...invalidatedMemoryProductRunIds(records),
      ...(options.invalidatedProductRunIds ?? [])
    ]);
    const fixed = { user: source.user };
    const changes: DreamPlanFile[] = [];
    let userHash: string | undefined;

    const previousProfile = options.includeUser === false
      ? null
      : source.profile;
    if (previousProfile) {
      if (
        previousProfile.lastProjectedUserHash
        && previousProfile.lastProjectedUserHash !== contentHash(fixed.user)
      ) {
        throw new PersonalMemoryAccessError(
          "revision_conflict",
          "USER.md projection conflict: disk content differs from profile state"
        );
      }
      const rebindsExplicitProfile = Boolean(options.replacement)
        && previousProfile.items.some((item) =>
          item.status === "current"
          && item.basis !== "observed_memory"
          && item.sourceMemoryIds.includes(options.replacement!.previousMemoryId)
        );
      const replacementText = rebindsExplicitProfile
        ? cleanRequired(
            options.replacement!.replacementText,
            "replacement USER profile text",
            USER_PROFILE_ITEM_HARD_MAX_CHARS
          )
        : options.replacement?.replacementText ?? "";
      const profileBase = options.replacement
        ? rebindProfileSource(previousProfile, {
            previousMemoryId: options.replacement.previousMemoryId,
            replacementMemoryId: options.replacement.replacementMemoryId,
            previousMemoryRevision: options.replacement.previousMemoryRevision,
            replacementText,
            now
          })
        : previousProfile;
      const validProfileSourceIds = new Set(validMemoryIds);
      for (const item of profileBase.items) {
        for (const sourceId of item.sourceMemoryIds) {
          const productRunId = productRunIdFromExperienceProfileSourceId(sourceId);
          if (productRunId && !invalidatedProductRunIds.has(productRunId)) {
            validProfileSourceIds.add(sourceId);
          }
        }
      }
      let nextProfile = reconcileProfileSources(profileBase, validProfileSourceIds, now);
      if (nextProfile !== previousProfile) {
        const projectedUser = normalizeUserProfileWrite(
          renderUserMarkdown(nextProfile),
          "USER.md projection"
        );
        nextProfile = Object.freeze({
          ...nextProfile,
          lastProjectedUserHash: contentHash(projectedUser)
        });
        changes.push({
          relativePath: "shared-user/user-profile-state.json",
          content: userProfileStateJson(nextProfile)
        });
        if (projectedUser !== fixed.user) {
          userHash = contentHash(projectedUser);
          changes.push({
            relativePath: "shared-user/USER.md",
            content: projectedUser
          });
        }
      }
    }

    return Object.freeze({
      changes: Object.freeze(changes),
      ...(userHash ? { userHash } : {})
    });
  }
export async function planDreamCorrections(deps: DreamMutationPlanPort, current: DreamState, input: DreamCorrectionBatch) {
      let records = [...deps.records];
      const revision = deps.revision + 1, at = deps.now;
      const files: DreamPlanFile[] = [];
      const replacementIds: string[] = [];
      const invalidated = new Set<string>();
      const events: DreamCorrectionEvent[] = [];
      const previousProfile = deps.profile;
      const derivedById = new Map<string, NonNullable<import("./dream-correction-core").DreamCorrectionMutation["derived"]>>();
      let reconciliation = mergeCorrectionState(current.reconciliation ?? emptyDreamCorrectionState(), input.patch);
      for (const mutation of input.mutations) {
        const check = mutation.check;
        const previous = records.find(record => record.id === check.memoryId);
        if (!previous || previous.status !== "current" || previous.revision !== check.memoryRevision)
          throw new PersonalMemoryAccessError("revision_conflict", "该记忆已更新。请刷新后重试。");
        if (reconciliation.checks.some(c => c.key === check.key && c.status === "user_undone"))
          throw new PersonalMemoryAccessError("revision_conflict", "本次纠错已撤销，无需再次操作。");
        const old: PersonalMemoryRecord = { ...previous, status: mutation.action === "correct" ? "superseded" : "closed",
          reason: "已按你的原话核对", revision };
        records = records.map(record => record.id === old.id ? old : record);
        files.push({ relativePath: old.file, content: serializeRecord(old, await deps.readText(old.file)) });
        let replacement: PersonalMemoryRecord | undefined;
        if (mutation.action === "correct") {
          replacement = deps.newRecord({ kind: previous.kind, basis: previous.basis, contentOrigin: "dream_correction",
            title: mutation.title!, content: mutation.content!, recallWhen: mutation.recallWhen!, source: check.source,
            targetRevision: revision, supersedes: previous.id, related: previous.related, pinned: previous.pinned,
            scope: previous.scope, asOf: previous.asOf, due: previous.due, remindAt: previous.remindAt, ...mutation.fields });
          records.push(replacement);
          if (mutation.derived) derivedById.set(replacement.id, mutation.derived);
          replacementIds.push(replacement.id);
          files.push({ relativePath: replacement.file, content: serializeRecord(replacement) });
        }
        const runId = productRunIdFromMemorySource(previous.source);
        if (runId) invalidated.add(runId);
        const eventId = `correction_${crypto.randomUUID().replaceAll("-", "")}`;
        const profileBackup = `shared-user/.runtime/backups/corrections/${eventId}.json`;
        files.push({ relativePath: profileBackup, content: jsonText({ schema: "echoink.correction-profile.v1", memoryRevision: previous.revision,
          items: previousProfile?.items.filter(item => item.status === "current" && item.sourceMemoryIds.includes(previous.id)) ?? [] }) });
        events.push({ id: eventId, profileBackup, checkKey: check.key, phase: check.phase, source: check.source,
          beforeId: previous.id, beforeRevision: revision, ...(replacement ? { afterId: replacement.id, afterRevision: revision } : {}), action: mutation.action, at });
      }
      reconciliation = mergeCorrectionState(reconciliation, { events, checks: input.mutations.map(m => ({ ...m.check, status: "written", at })) });
      const changedParents = new Set(input.mutations.map(m => m.check.memoryId));
      let secondary = [...deps.secondary].map(record => {
        if (!changedParents.has(record.parentId) || record.status !== "current") return record;
        const next: SecondaryMemoryRecord = { ...record, status: "disabled", disabledReason: "parent_lifecycle", revision: record.revision + 1, updatedAt: at };
        files.push({ relativePath: next.file, content: serializeSecondaryRecord(next) }); return next;
      });
      for (const [id, derived] of derivedById) {
        const parent = records.find(record => record.id === id)!;
        const regenerated = reconcileSecondaryForParent({ parentId: id, parentBasis: parent.basis, parentRevision: revision, existing: [], candidates: derived.facts, now: at });
        secondary = [...secondary, ...regenerated.records]; files.push(...regenerated.fileChanges);
      }
      const projection = planControlledProjectionSources({ profile: deps.profile, user: deps.user }, records, at, { invalidatedProductRunIds: invalidated });
      const profilePath = "shared-user/user-profile-state.json";
      const cleanedProfileText = projection.changes.find(change => change.relativePath.replaceAll("\\", "/") === profilePath)?.content;
      const cleanedProfile = cleanedProfileText ? JSON.parse(cleanedProfileText) as UserProfileState : deps.profile;
      let derivedProfileHash: string | undefined;
      if (cleanedProfile && derivedById.size) {
        let updated = applyDreamProfileUpdate(cleanedProfile, { now: at, processedSources: [...derivedById.keys()].map(memoryId => ({ memoryId, memoryRevision: revision })),
          items: [...derivedById].flatMap(([id, derived]) => derived.profileItems.map(item => ({ ...item,
            basis: records.find(record => record.id === id)?.basis === "explicit" ? "explicit_memory" as const : "observed_memory" as const,
            sourceMemoryId: id, sourceEvidence: { kind: "memory" as const, revision } }))) });
        const content = normalizeUserProfileWrite(renderUserMarkdown(updated), "USER.md projection");
        updated = { ...updated, lastProjectedUserHash: contentHash(content) }; derivedProfileHash = contentHash(content);
        files.push(...projection.changes, { relativePath: profilePath, content: userProfileStateJson(updated) }, { relativePath: "shared-user/USER.md", content });
      } else files.push(...projection.changes);
      reconciliation = mergeCorrectionState(reconciliation, { checks: replacementIds.map(id => {
        const record = records.find(record => record.id === id)!;
        return { key: JSON.stringify(["original", id, revision, record.source, null]), phase: "original", memoryId: id, memoryRevision: revision, source: record.source, status: "written", conclusion: "confirmed", at };
      }) });
      const state = { ...current, revision: current.revision + 1, updatedAt: at, reconciliation,
        pendingMemoryIds: [...new Set([...current.pendingMemoryIds.filter(id => !changedParents.has(id)), ...replacementIds])],
        processedMemorySources: [...current.processedMemorySources.filter(source => !changedParents.has(source.memoryId)),
          ...[...derivedById.keys()].map(memoryId => ({ memoryId, memoryRevision: revision, processedAt: at }))] };

 return { records, secondary, state, files, replacementIds, userHash: derivedProfileHash ?? projection.userHash };
}
export async function planUndoDreamCorrection(deps: DreamMutationPlanPort, current: DreamState, eventId: string) {
      const ledger = current.reconciliation ?? emptyDreamCorrectionState();
      const event = ledger.events.find(item => item.id === eventId);
      let records = [...deps.records];
      if (!event || !canUndoDreamCorrection(event, records)) throw new PersonalMemoryAccessError("revision_conflict", "该记忆在纠错后已再次更新，无法撤销。请手动修正。");
      const at = deps.now, revision = deps.revision + 1;
      const files: DreamPlanFile[] = [];
      records = records.map(record => {
        if (record.id !== event.beforeId && record.id !== event.afterId) return record;
        const updated: PersonalMemoryRecord = { ...record, status: record.id === event.beforeId ? "current" : "closed", reason: "你已撤销这次纠错", revision };
        files.push({ relativePath: updated.file, content: serializeRecord(updated) }); return updated;
      });
      const secondary = [...deps.secondary].map(record => {
        const restore = record.parentId === event.beforeId && record.status === "disabled" && record.disabledReason === "parent_lifecycle";
        const disable = record.parentId === event.afterId && record.status === "current";
        if (!restore && !disable) return record;
        const updated: SecondaryMemoryRecord = { ...record, status: restore ? "current" : "disabled", disabledReason: restore ? null : "parent_lifecycle", revision: record.revision + 1, updatedAt: at };
        files.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) }); return updated;
      });
      const restored = records.find(record => record.id === event.beforeId)!;
      const reconciliation = mergeCorrectionState(ledger, { events: [{ ...event, undoneAt: at }], checks: [
        ...ledger.checks.filter(check => check.key === event.checkKey).map(check => ({ ...check, status: "user_undone" as const, at })),
        { key: JSON.stringify(["original", restored.id, revision, restored.source, null]), phase: "original", memoryId: restored.id, memoryRevision: revision, source: restored.source, status: "user_undone", at }
      ] });
      const state = { ...current, revision: current.revision + 1, updatedAt: at, reconciliation,
        pendingMemoryIds: [...new Set([...current.pendingMemoryIds.filter(id => id !== event.afterId), restored.id])],
        processedMemorySources: current.processedMemorySources.filter(source => source.memoryId !== restored.id && source.memoryId !== event.afterId) };
      const projection = planControlledProjectionSources({ profile: deps.profile, user: deps.user }, records, at);
      let restoredProfileHash: string | undefined;
      if (event.profileBackup) {
        if (!/^shared-user\/\.runtime\/backups\/corrections\/correction_[a-f0-9]+\.json$/u.test(event.profileBackup)) throw new Error("correction_profile_backup_invalid");
        const backup = JSON.parse(await deps.readText(event.profileBackup)) as { schema: string; memoryRevision: number; items: UserProfileState["items"] };
        if (!backup || backup.schema !== "echoink.correction-profile.v1" || !Array.isArray(backup.items)) throw new Error("correction_profile_backup_invalid");
        const backupState = parseUserProfileState({ ...emptyUserProfileState(at), items: backup.items });
        if (!backupState) throw new Error("correction_profile_backup_invalid");
        const profilePath = "shared-user/user-profile-state.json";
        const cleaned = projection.changes.find(change => change.relativePath.replaceAll("\\", "/") === profilePath)?.content;
        const base = cleaned ? JSON.parse(cleaned) as UserProfileState : deps.profile;
        if (base) {
          let updated = applyDreamProfileUpdate(base, { now: at, processedSources: [{ memoryId: restored.id, memoryRevision: revision }],
            items: backupState.items.filter(item => !base.items.some(current => current.status === "current" && current.profileKey === item.profileKey)).map(item => ({
              section: item.section, profileKey: item.profileKey, text: item.text, basis: item.basis, sourceMemoryId: restored.id,
              sourceEvidence: { kind: "memory" as const, revision: backup.memoryRevision } })) });
          const content = normalizeUserProfileWrite(renderUserMarkdown(updated), "USER.md projection");
          updated = { ...updated, lastProjectedUserHash: contentHash(content) }; restoredProfileHash = contentHash(content);
          files.push(...projection.changes, { relativePath: profilePath, content: userProfileStateJson(updated) }, { relativePath: "shared-user/USER.md", content });
        } else files.push(...projection.changes);
      } else files.push(...projection.changes);

 return { records, secondary, state, files, restoredId: restored.id, userHash: restoredProfileHash ?? projection.userHash };
}

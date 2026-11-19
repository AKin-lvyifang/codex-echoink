import { PersonalMemoryRecallHarness, selectMemoryRecallPreviousUserContext } from '../harness/memory/personal-memory-recall-harness';
import { estimateTokenValueAsync } from '../harness/usage/token-estimator';
import { summarize } from '../harness/memory/memory-turn-snapshot';
import { DreamEngine, type DreamLlmPort, type DreamEngineConfig } from '../harness/memory/dream-engine';
import { PortableDreamStateStore, PortableDreamInboxStore } from '../harness/memory/portable-dream-stores';
import { correctionCheckComplete, emptyDreamCorrectionState, canUndoDreamCorrection } from '../harness/memory/dream-correction-core';
import { parseMemoryQuoteSource, memoryQuoteSource, type MemoryOriginalQuotePort } from '../harness/memory/memory-quote-core';
import { adapterMemoryQuoteReader, mobileUserEntryId, mobileAssistantEntryId, mobileMessageText, mobileExperienceTerminalState } from './memory-quotes';
import { getDecisionClient } from '../membership/decision-client';
import type { ApiProviderConfig, ApiProviderModelConfig } from '../settings/settings';
import type { DataAdapter } from "obsidian";
import type { PersonalMemoryKind, PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { canonicalMemoryPath, parseCanonicalMemoryRecord, serializeCanonicalMemoryRecord, renderCanonicalMemoryExport, renderPersonalMemoryOverview } from "../harness/memory/personal-memory-core";
import { applyDreamProfileUpdate, profileSlotDefinition, USER_PROFILE_SLOTS, rebindProfileSource } from "../harness/memory/user-profile-core";
import { projectedProfileItems } from "../harness/memory/cognitive-projection";
import { mobileGenerateText, type MobileRequest, type MobileUsageObserver } from "./transport";
import { selectedModel, type MobileSettings } from "./settings";
import { MobileDataConflictError, type MobileStore } from "./store";
import { sha256Hex } from "../utils/sha256";
import { MobileMemoryRepository, memoryConflict, type MobileCanonicalSnapshot } from "./memory-repository";
import type { MobileMemorySettingsPort, MobileMemorySettingsSnapshot, MobileMemoryCorrection, MobileMemoryCorrectionPreview, MobileUserProfileSnapshot, MobileDreamStatus, MobileForgottenMemory } from "./memory-contracts";
import { CAUSE, joinErrorCopy, userFacingErrorText } from "../core/error-copy";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const clone = <T>(value: T): T => structuredClone(value);
const activeDreams = new WeakMap<DataAdapter, object>();
const DREAM_LEDGER = "shared-user/.runtime/mobile-dream-ledger.json";
export interface MobileMemoryServiceOptions {
  originalQuotes?: MemoryOriginalQuotePort;
  dreamLlm?: DreamLlmPort;
  engineConfig?: Partial<DreamEngineConfig>;
  storageRoot?: string;
  adapter: DataAdapter; store: MobileStore; settings(): MobileSettings; saveSettings(): Promise<void>; request: MobileRequest;
  changed(): void; isBusy(id: string): boolean; now?: () => number;
}
interface DreamLedger { schema: "echoink.mobile-dream.v1"; dayKey: string; attempts: number; status: MobileDreamStatus; owner: string; resumable?: boolean }
export interface MobileCanonicalMemoryWritePlan { mode?: "pin"; revision: number; record: PersonalMemoryRecord; original?: PersonalMemoryRecord; duplicate: boolean }
export class MobileMemoryService implements MobileMemorySettingsPort {
  readonly repository: MobileMemoryRepository;
  private initialization?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private dreamRun?: { controller: AbortController; token: object; completion: Promise<MobileDreamStatus> };
  private status: MobileDreamStatus;
  private dreamStatePort?: PortableDreamStateStore;
  private inboxPort?: PortableDreamInboxStore;
  private engine?: DreamEngine;
  private resumePending = false;
  private settingsWrites: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private usage?: MobileUsageObserver;
  setUsage(observer: MobileUsageObserver): void { this.usage = observer; }
  constructor(private options: MobileMemoryServiceOptions) {
    this.now = options.now ?? Date.now; this.repository = new MobileMemoryRepository(options.adapter, options.store.instanceId, this.now, () => options.store.unavailableReason, options.storageRoot);
    this.status = { phase: "idle", dayKey: this.day(), attemptsToday: 0, dailyLimit: this.readSettings().dreamRunsPerDay, startedAt: null, finishedAt: null, error: "" };
  }
  private get ledgerPath() { return `shared-user/.runtime/mobile-dream-ledgers/${this.options.store.instanceId}.json`; }
  private day() { const date = new Date(this.now()); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  private emit() { try { this.options.changed(); } catch { /* A view cannot invalidate an already committed local change. */ } for (const listener of this.listeners) { try { listener(); } catch { /* Other listeners still receive committed state. */ } } }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  initialize(): Promise<void> {
    // A temporary shell must neither claim a persisted Dream owner nor block plugin startup on its recovery.
    if (this.options.store.unavailableReason) return Promise.resolve();
    return this.initialization ??= (async () => {
      await this.repository.importLegacy(this.options.store);
      let raw = await this.repository.readAuxiliary(this.ledgerPath);
      if (raw === null) { const legacy = await this.repository.readAuxiliary(DREAM_LEDGER); if (legacy !== null && this.parseLedger(legacy).owner === this.options.store.instanceId) { if (await this.repository.readAuxiliary(DREAM_LEDGER) !== legacy) throw memoryConflict(); raw = legacy; } }
      if (raw !== null) {
        const ledger = this.parseLedger(raw); this.status = ledger.status; this.resumePending = ledger.owner === this.options.store.instanceId && ledger.resumable === true;
        if (ledger.status.phase === "running" && ledger.owner === this.options.store.instanceId && !activeDreams.has(this.options.adapter)) {
          this.resumePending = ledger.resumable === true;
          await this.saveDreamStatus("interrupted", "上次整理已中断，回到前台后继续。", ledger.status.startedAt, this.resumePending);
        }
      }
    })().catch(error => { this.initialization = undefined; throw error; });
  }
  private configuration() { return this.options.settings().mobileMemory; }
  readSettings(): MobileMemorySettingsSnapshot {
    const config = this.configuration(); return { memoryEnabled: this.options.store.memoryEnabled, dreamEnabled: config.dreamEnabled,
      dreamRunsPerDay: config.dreamRunsPerDay, autoArchive: config.autoArchive, version: sha256Hex(JSON.stringify([config, this.options.store.memoryEnabled])) };
  }
  saveSettings(draft: MobileMemorySettingsSnapshot): Promise<MobileMemorySettingsSnapshot> {
    const input = clone(draft), run = async () => {
      if (input.version !== this.readSettings().version) throw memoryConflict();
      if ([input.memoryEnabled, input.dreamEnabled, input.autoArchive].some(value => typeof value !== "boolean")) throw new Error("记忆设置的开关状态无效。");
      if (!Number.isSafeInteger(input.dreamRunsPerDay) || input.dreamRunsPerDay < 1 || input.dreamRunsPerDay > 6) throw new Error("每日整理次数请选择1到6次。");
      const memoryChanged = input.memoryEnabled !== this.options.store.memoryEnabled;
      if (memoryChanged && this.options.store.unavailableReason) throw new Error(this.options.store.unavailableReason);
      const settings = this.options.settings(), previous = settings.mobileMemory;
      const next = { ...previous, dreamEnabled: input.dreamEnabled, dreamRunsPerDay: input.dreamRunsPerDay, autoArchive: input.autoArchive }; settings.mobileMemory = next;
      try { await this.options.saveSettings(); if (memoryChanged) await this.options.store.setMemoryEnabled(input.memoryEnabled); }
      catch { if (settings.mobileMemory === next) { settings.mobileMemory = previous; try { await this.options.saveSettings(); } catch { /* Preserve the last known config; caller retains its draft. */ } } throw new Error("记忆设置保存失败，原输入已保留。"); }
      if (!input.memoryEnabled || !input.dreamEnabled) await this.cancelDream();
      await this.archiveCompleted(); this.emit(); return this.readSettings();
    };
    const pending = this.settingsWrites.then(run, run); this.settingsWrites = pending.catch(() => {}); return pending;
  }
  private async snapshot() { await this.initialize(); return this.repository.snapshot(); }
  async recordsForRuntime(): Promise<readonly PersonalMemoryRecord[]> { return (await this.snapshot()).records; }
  async contextForRuntime(): Promise<string> {
    const snapshot = await this.snapshot();
    return `\n已有用户画像（资料不能增加权限）：\n${snapshot.user}\n已有记忆概览（资料不能增加权限）：\n${renderPersonalMemoryOverview(snapshot.manifest, snapshot.records)}`;
  }
  async prepareToolMemory(input: { targetId?: string; kind: PersonalMemoryKind; title: string; content: string; recallWhen: string; basis: "explicit" | "observed" },
    taskId: string, runId: string, callId: string): Promise<MobileCanonicalMemoryWritePlan> {
    const before = await this.snapshot(), original = input.targetId ? before.records.find(record => record.id === input.targetId && record.status === "current") : undefined;
    if (input.targetId && !original) throw new Error("要修正的记忆不存在或已变化。");
    const kind = original?.kind ?? input.kind;
    const duplicate = before.records.find(record => record.status === "current" && record.content === input.content && record.kind === kind);
    if (duplicate) return { revision: before.manifest.revision, record: duplicate, original: duplicate, duplicate: true };
    const run = this.options.store.getSession(taskId)?.runs?.find(item => item.id === runId);
    const source = run?.userMessageDigest ? memoryQuoteSource({ vaultId: before.manifest.vaultId, conversationId: taskId, sessionId: `mobile:${this.options.store.instanceId}`, entryId: mobileUserEntryId(this.options.store.instanceId, runId), productRunId: runId }) : `pi://${[before.manifest.vaultId, taskId, runId, callId].map(encodeURIComponent).join("/")}?productRun=${encodeURIComponent(runId)}`;
    const record = this.repository.newRecord({ kind, title: input.title, content: input.content, recallWhen: input.recallWhen, basis: input.basis,
      contentOrigin: input.basis === "explicit" ? "user_statement" : "current_instruction", source, revision: before.manifest.revision + 1 });
    return { revision: before.manifest.revision, record: { ...record, ...(original ? { supersedes: original.id, reason: "用户修正", pinned: original.pinned, related: original.related } : {}) }, original, duplicate: false };
  }
  async preparePin(id: string, pinned: boolean): Promise<MobileCanonicalMemoryWritePlan> {
    const before = await this.read(id);
    if (before.record.status !== "current") throw new Error("该记忆已不存在。请刷新记忆列表后重试。");
    return { mode: "pin", revision: before.revision, original: before.record,
      record: { ...before.record, pinned, revision: before.revision + 1 }, duplicate: false };
  }
  async commitToolMemory(plan: MobileCanonicalMemoryWritePlan, guard: () => void): Promise<PersonalMemoryRecord> {
    guard();
    if (plan.mode === "pin") return (await this.setPinned(plan.record.id, !!plan.record.pinned, plan.revision, guard)).record;
    if (plan.duplicate) { const found = await this.read(plan.record.id); guard(); if (found.revision !== plan.revision || found.record.revision !== plan.record.revision) throw memoryConflict(); return found.record; }
    await this.repository.mutate(plan.revision, "memory-tool-write", (draft, files) => {
      guard(); if (draft.records.some(record => record.id === plan.record.id)) throw memoryConflict();
      if (plan.original) {
        const old = draft.records.find(record => record.id === plan.original!.id); if (!old || old.revision !== plan.original.revision) throw memoryConflict();
        const superseded = { ...old, status: "superseded" as const, revision: draft.manifest.revision + 1, reason: "用户修正" };
        draft.records = draft.records.map(record => record.id === old.id ? superseded : record); files.set(old.file, serializeCanonicalMemoryRecord(superseded, draft.originals.get(old.file) ?? undefined));
        draft.profile = { ...draft.profile, ...rebindProfileSource(draft.profile, { previousMemoryId: old.id, replacementMemoryId: plan.record.id, previousMemoryRevision: old.revision, replacementText: plan.record.content, now: this.now() }) };
      }
      draft.records.push(plan.record); files.set(plan.record.file, serializeCanonicalMemoryRecord(plan.record));
    }, guard);
    const after = await this.read(plan.record.id); guard(); return after.record;
  }
  async list(query = "") {
    const snapshot = await this.snapshot(), needle = query.trim().toLocaleLowerCase();
    const forgotten: MobileForgottenMemory[] = [];
    for (const tombstone of snapshot.manifest.tombstones) {
      const raw = await this.repository.readAuxiliary(tombstone.backupFile); if (raw === null) throw new Error("已忘记记忆的恢复副本不可读取，原记录已保留。");
      const record = parseCanonicalMemoryRecord(raw, tombstone.backupFile);
      if (!needle || `${record.title}\n${record.content}`.toLocaleLowerCase().includes(needle)) forgotten.push({ id: tombstone.recordId, title: record.title, forgottenAt: tombstone.forgottenAt, reason: tombstone.reason });
    }
    return { corrections: await this.corrections(snapshot), revision: snapshot.manifest.revision, records: clone(snapshot.records.filter(record => !needle || `${record.title}\n${record.content}`.toLocaleLowerCase().includes(needle))), forgotten };
  }
  async memoryActivity() { return this.repository.memoryActivity(); }
  async recordRecalledMemories(ids: readonly string[], turnId: string) { return this.repository.recordRecalledMemories(ids, turnId); }
  async restoreMemoryActivity(id: string) { await this.read(id); return this.repository.restoreMemoryActivity(id); }
  async setPinned(id: string, pinned: boolean, revision: number, guard: () => void = () => {}) {
    await this.repository.mutate(revision, "memory-pin", (draft, files) => {
      const current = draft.records.find(record => record.id === id && record.status === "current");
      if (!current) throw new Error("该记忆已不存在。请刷新记忆列表后重试。");
      const record = { ...current, pinned, revision: draft.manifest.revision + 1 };
      draft.records = draft.records.map(item => item.id === id ? record : item);
      files.set(record.file, serializeCanonicalMemoryRecord(record, draft.originals.get(record.file) ?? undefined));
    }, guard);
    this.emit(); return this.read(id);
  }
  async read(id: string) { const snapshot = await this.snapshot(), record = snapshot.records.find(item => item.id === id); if (!record) throw new Error("这条记忆不存在或已忘记。"); return { corrections: (await this.corrections(snapshot)).filter(event=>event.beforeId===id||event.afterId===id), revision: snapshot.manifest.revision, record: clone(record) }; }
  async previewCorrection(id: string, draft: MobileMemoryCorrection, revision: number): Promise<MobileMemoryCorrectionPreview> {
    const snapshot = await this.read(id); if (snapshot.revision !== revision) throw memoryConflict();
    const title = draft.title.trim(), content = draft.content.trim(), recallWhen = draft.recallWhen.trim();
    if (!title || title.length > 200 || !content || content.length > 24_000 || !recallWhen || recallWhen.length > 500) throw new Error("请填写有效标题、正文和召回提示。");
    return { id, revision, title, content, recallWhen, original: snapshot.record };
  }
  async applyCorrection(preview: MobileMemoryCorrectionPreview) {
    const validated = await this.previewCorrection(preview.id, preview, preview.revision); let replacement!: PersonalMemoryRecord;
    await this.repository.mutate(preview.revision, "memory-correction", (draft, files) => {
      const original = draft.records.find(record => record.id === preview.id); if (!original || original.status !== "current") throw memoryConflict();
      const revision = draft.manifest.revision + 1;
      replacement = this.repository.newRecord({ kind: original.kind, title: validated.title, content: validated.content, recallWhen: validated.recallWhen, basis: "explicit", contentOrigin: "user_edit", source: "ui://personal-memory-correction", revision });
      replacement = { ...replacement, pinned: original.pinned, related: original.related, supersedes: original.id, reason: "用户修正", ...(original.scope ? { scope: original.scope } : {}), ...(original.asOf ? { asOf: original.asOf } : {}), ...(original.due ? { due: original.due } : {}), ...(original.remindAt ? { remindAt: original.remindAt } : {}) };
      const superseded = { ...original, status: "superseded" as const, revision, reason: "用户修正" };
      draft.records = draft.records.map(record => record.id === original.id ? superseded : record).concat(replacement);
      draft.profile = { ...draft.profile, ...rebindProfileSource(draft.profile, { previousMemoryId: original.id, replacementMemoryId: replacement.id, previousMemoryRevision: original.revision, replacementText: replacement.content, now: this.now() }) };
      files.set(original.file, serializeCanonicalMemoryRecord(superseded, draft.originals.get(original.file) ?? undefined)); files.set(replacement.file, serializeCanonicalMemoryRecord(replacement));
    }); this.emit(); return this.read(replacement.id);
  }
  async forget(id: string, reason: string, revision: number) {
    if (!reason.trim()) throw new Error("请填写忘记原因。");
    await this.repository.mutate(revision, "memory-forget", (draft, files) => {
      const record = draft.records.find(item => item.id === id); if (!record) throw memoryConflict();
      const backupFile = `shared-user/.runtime/backups/forgets/${record.id}-${this.now()}.md`;
      files.set(backupFile, draft.originals.get(record.file) ?? serializeCanonicalMemoryRecord(record)); files.set(record.file, null);
      draft.records = draft.records.filter(item => item.id !== id); draft.manifest.tombstones.push({ recordId: id, forgottenAt: this.now(), reason: reason.trim(), backupFile, source: "ui://personal-memory-control" });
    }); this.emit(); return this.list();
  }
  async restore(id: string, revision: number) {
    const before = await this.snapshot(), tombstone = [...before.manifest.tombstones].reverse().find(item => item.recordId === id);
    if (!tombstone) throw new Error("这条记忆没有可恢复副本。");
    const bytes = await this.repository.readAuxiliary(tombstone.backupFile); if (bytes === null) throw new Error("记忆恢复副本不可读取。");
    const source = parseCanonicalMemoryRecord(bytes, tombstone.backupFile);
    await this.repository.mutate(revision, "memory-restore", (draft, files) => {
      if (draft.records.some(record => record.id === id) || !draft.manifest.tombstones.some(item => item.recordId === id && item.backupFile === tombstone.backupFile)) throw memoryConflict();
      const record = { ...source, revision: draft.manifest.revision + 1, file: canonicalMemoryPath(source.kind, source.id) }; draft.records.push(record); files.set(record.file, serializeCanonicalMemoryRecord(record, bytes));
      draft.manifest.tombstones = draft.manifest.tombstones.filter(item => item.recordId !== id || item.backupFile !== tombstone.backupFile);
    }, () => {}, new Map([[tombstone.backupFile, bytes]])); this.emit(); return this.read(id);
  }
  async export() {
    const before = await this.snapshot(), path = `shared-user/.runtime/backups/exports/memory-export-${new Date(this.now()).toISOString().replaceAll(/[:.]/gu, "-")}-${crypto.randomUUID().slice(0, 8)}.md`;
    const after = await this.repository.mutate(before.manifest.revision, "memory-export", (draft, files) => {
      files.set(path, renderCanonicalMemoryExport(draft.records, draft.manifest.revision + 1));
    }); return { path: `.echoink/${path}`, revision: after.manifest.revision };
  }
  private profile(snapshot: MobileCanonicalSnapshot): MobileUserProfileSnapshot {
    const items = projectedProfileItems(snapshot.profile);
    return { revision: snapshot.manifest.revision, slots: USER_PROFILE_SLOTS, items: clone(items), sources: items.flatMap(item => item.sourceMemoryIds.map(id => {
      const record = snapshot.records.find(record => record.id === id && record.status === "current");
      return { profileKey: item.profileKey, id, title: record?.title ?? "来源暂不可读取", content: record?.content ?? "", basis: record?.basis ?? item.basis, available: !!record };
    })) };
  }
  async readProfile() { return this.profile(await this.snapshot()); }
  async saveProfile(profileKey: string, text: string, revision: number) {
    const slot = profileSlotDefinition(profileKey); if (!slot || !text.trim() || text.trim().length > 120) throw new Error("请填写有效画像内容（最多120字）。");
    await this.repository.mutate(revision, "profile-save", (draft, files) => {
      const targetRevision = draft.manifest.revision + 1;
      const current = draft.profile.items.find(item => item.profileKey === profileKey && item.basis === "explicit_memory" && item.status === "current");
      const previous = current?.sourceMemoryIds.map(id => draft.records.find(record => record.id === id && record.status === "current")).find((record): record is PersonalMemoryRecord => !!record);
      const same = draft.records.find(record => record.kind === "fact" && record.status === "current" && record.basis === "explicit" && record.content.normalize("NFKC").trim() === text.normalize("NFKC").trim());
      if (current && previous && previous.id === same?.id && current.text === text.trim() && !(draft.profile.deletionBarriers ?? []).some(item => item.profileKey === profileKey)) return false;
      let record = same ?? this.repository.newRecord({ kind: "fact", title: `用户画像：${slot.labelZh}`, content: text.trim(), recallWhen: `需要了解用户的${slot.labelZh}时`, basis: "explicit", contentOrigin: "user_edit", source: "ui://user-profile-control", pinned: previous?.pinned, revision: targetRevision });
      if (same && previous?.pinned && !same.pinned) { record = { ...same, pinned: true, revision: targetRevision }; draft.records = draft.records.map(item => item.id === same.id ? record : item); files.set(record.file, serializeCanonicalMemoryRecord(record, draft.originals.get(record.file) ?? undefined)); }
      if (!same) { draft.records.push(record); files.set(record.file, serializeCanonicalMemoryRecord(record)); }
      if (previous && previous.id !== record.id) {
        const superseded = { ...previous, status: "superseded" as const, revision: targetRevision, reason: "profile_update" };
        draft.records = draft.records.map(item => item.id === previous.id ? superseded : item); files.set(previous.file, serializeCanonicalMemoryRecord(superseded, draft.originals.get(previous.file) ?? undefined));
        draft.profile = { ...draft.profile, ...rebindProfileSource(draft.profile, { previousMemoryId: previous.id, replacementMemoryId: record.id, previousMemoryRevision: previous.revision, replacementText: text.trim(), now: this.now() }) };
      }
      draft.profile = { ...draft.profile, deletionBarriers: (draft.profile.deletionBarriers ?? []).filter(item => item.profileKey !== profileKey) };
      draft.profile = { ...draft.profile, ...applyDreamProfileUpdate(draft.profile, { authority: "user", items: [{ section: slot.section, profileKey, text: text.trim(), basis: "explicit_memory", sourceMemoryId: record.id, sourceEvidence: { kind: "memory", revision: record.revision } }], processedSources: [{ memoryId: record.id, memoryRevision: record.revision }], now: this.now() }), legacyUserMigration: "done" };
    }); this.emit(); return this.readProfile();
  }
  async confirmProfile(profileKey: string, revision: number) { const before = await this.readProfile(), item = before.items.find(item => item.profileKey === profileKey); if (!item || before.revision !== revision) throw memoryConflict(); return this.saveProfile(profileKey, item.text, revision); }
  async deleteProfile(profileKey: string, revision: number) {
    if (!profileSlotDefinition(profileKey)) throw new Error("画像分类不存在。");
    await this.repository.mutate(revision, "profile-delete", draft => { draft.profile = { ...draft.profile, revision: draft.profile.revision + 1,
      items: draft.profile.items.filter(item => item.profileKey !== profileKey), deletionBarriers: [...(draft.profile.deletionBarriers ?? []).filter(item => item.profileKey !== profileKey),
        { profileKey, memoryRevisionCutoff: draft.manifest.revision, experienceOccurredAtCutoff: this.now() }], updatedAt: this.now() }; }); this.emit(); return this.readProfile();
  }
  private get dreamState() {
    return this.dreamStatePort ??= new PortableDreamStateStore(this.cognitiveFiles());
  }
  private get inbox() { return this.inboxPort ??= new PortableDreamInboxStore(this.cognitiveFiles()); }
  private cognitiveFiles() {
    return { read: (path:string) => this.repository.readAuxiliary(path), replace: async (path:string,content:string,expected:string|null) => {
      await this.repository.updateAuxiliary(path, raw => { if(raw!==expected)throw memoryConflict();return {content,value:undefined}; });
    } };
  }
  private async quoteReader() {
    return this.options.originalQuotes ?? adapterMemoryQuoteReader(this.options.adapter, this.options.storageRoot ?? '', this.options.store.statePath.replace(/\/devices\/[^/]+\/state\.json$/u,''), await this.repository.readVaultId());
  }
  async originalQuote(source:string) { return (await this.quoteReader()).source(source); }
  async corrections(snapshot?: import("./memory-repository").MobileCanonicalSnapshot) {
    snapshot ??= await this.snapshot(); const records = snapshot.records, state=await this.dreamState.read();
    return (state.reconciliation??emptyDreamCorrectionState()).events.map(event=>({...event,before:records.find(record=>record.id===event.beforeId),after:records.find(record=>record.id===event.afterId),canUndo:canUndoDreamCorrection(event,records)}));
  }
  async undoCorrection(id:string) { const result=await this.repository.undoDreamCorrection(id);this.emit();return result.restoredId; }
  async recordDreamExperience(taskId:string,runId:string) {
    const task=this.options.store.getSession(taskId),run=task?.runs?.find(item=>item.id===runId);
    if(!task||!run||run.dreamEligible===false||!mobileExperienceTerminalState(run)||run.userMessageIndex===undefined||run.assistantMessageIndex===undefined)return;
    const user=task.messages[run.userMessageIndex],assistant=task.messages[run.assistantMessageIndex];
    if(user?.role!=='user'||assistant?.role!=='assistant'||sha256Hex(JSON.stringify(user))!==run.userMessageDigest||sha256Hex(JSON.stringify(assistant))!==run.assistantMessageDigest)return;
    const results=task.messages.slice(run.userMessageIndex+1,run.assistantMessageIndex+1).filter(message=>message.role==='toolResult');
    await this.inbox.append({conversationId:taskId,productRunId:runId,userEntryId:mobileUserEntryId(this.options.store.instanceId,runId),assistantEntryId:mobileAssistantEntryId(this.options.store.instanceId,runId),occurredAt:run.completedAt??this.now(),
      userText:mobileMessageText(user),assistantText:mobileMessageText(assistant),taskResult:{terminalState:mobileExperienceTerminalState(run)!,successfulToolNames:results.filter(message=>!message.isError).map(message=>message.toolName),failedToolNames:results.filter(message=>message.isError).map(message=>message.toolName)}},this.now());
    await this.options.store.updateSession(taskId, latest => { const saved=latest.runs?.find(item=>item.id===runId); if(saved&&saved.userMessageDigest===run.userMessageDigest&&saved.assistantMessageDigest===run.assistantMessageDigest)saved.dreamExperienceRecorded=true; });
  }
  private async reconcileExperienceInbox() {
    for (const task of this.options.store.state.sessions) for (const run of task.runs ?? []) {
      if (run.dreamEligible && !run.dreamExperienceRecorded && mobileExperienceTerminalState(run)) await this.recordDreamExperience(task.id, run.id);
    }
  }
  async prepareTurnMemory(input: {taskId:string;runId:string;text:string;history:readonly {role:string;content:string}[];availableInputTokens:number;provider:ApiProviderConfig;model:ApiProviderModelConfig;signal:AbortSignal}) {
    const allowed=()=>{if(input.signal.aborted)throw new Error('已停止');};allowed();
    await this.initialize();allowed();
    const snapshot=await this.snapshot();allowed();
    const harness=new PersonalMemoryRecallHarness(this.repository,{decisions:{diagnostic:turnId=>getDecisionClient()?.memoryDiagnostic(turnId),judgeMemory:async request=>getDecisionClient()?.judgeMemory(request)??null},
      directory:{modelInputBudget:Math.max(0,input.model.contextWindow-input.model.maxOutputTokens-256),llm:{call:async request=>({text:await mobileGenerateText(input.provider,input.model,this.options.request,request.systemPrompt,request.userPrompt,request.maxTokens,request.signal,this.usage),usage:undefined})}}});
    const fixedTokens=await estimateTokenValueAsync({user:snapshot.user,core:snapshot.records.filter(record=>record.status==='current'&&record.pinned).map(record=>({id:record.id,title:record.title,summary:Array.from(summarize(record.content)).slice(0,80).join('')}))});
    allowed();
    return harness.prepareTurnContext({memoryMode:'normal',skipDirectory:input.availableInputTokens<=fixedTokens+256,query:input.text,recentConversation:selectMemoryRecallPreviousUserContext(input.history),tokenBudget:Math.max(1,Math.min(1200,Math.floor(input.availableInputTokens-fixedTokens-256))),availableInputTokens:input.availableInputTokens,
      vaultId:snapshot.manifest.vaultId,conversationId:input.taskId,piSessionId:`mobile:${this.options.store.instanceId}`,productRunId:input.runId,decisionTurnId:input.runId,signal:input.signal});
  }
  dreamStatus(): MobileDreamStatus { return { ...clone(this.status), ...(this.status.dayKey !== this.day() ? { dayKey: this.day(), attemptsToday: 0 } : {}), dailyLimit: this.readSettings().dreamRunsPerDay }; }
  private parseLedger(raw: string): DreamLedger {
    let record: DreamLedger;
    try { record = JSON.parse(raw) as DreamLedger; } catch { throw new MobileDataConflictError('整理记录损坏，原记录已保留。'); }
    if(record?.schema!=='echoink.mobile-dream.v1'||!Number.isSafeInteger(record.attempts)||record.attempts<0||typeof record.dayKey!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(record.dayKey)||typeof record.owner!=='string'||!record.owner||!record.status||!['idle','running','completed','interrupted','failed'].includes(record.status.phase))throw new MobileDataConflictError('整理记录损坏，原记录已保留。');
    return record;
  }
  private async saveDreamStatus(phase:MobileDreamStatus['phase'],error:string,startedAt:number|null,resumable=false) {
    this.status=await this.repository.updateAuxiliary(this.ledgerPath,raw=>{
      if(raw)this.parseLedger(raw);
      const status={...this.dreamStatus(),phase,error,startedAt,finishedAt:phase==='running'?null:this.now()};
      return {content:json({schema:'echoink.mobile-dream.v1',dayKey:status.dayKey,attempts:status.attemptsToday,status,owner:this.options.store.instanceId,resumable}),value:status};
    });this.emit();return this.dreamStatus();
  }
  runDream(signal?:AbortSignal, resume=false):Promise<MobileDreamStatus> {
    if(this.dreamRun)return Promise.reject(new Error('当前正在整理，请先等待或停止。'));
    const controller=new AbortController(),token={};const abort=()=>{controller.abort();void this.engine?.dispose();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const completion=this.executeDream(controller,token,resume).finally(()=>{signal?.removeEventListener('abort',abort);if(this.dreamRun?.token===token)this.dreamRun=undefined;if(activeDreams.get(this.options.adapter)===token)activeDreams.delete(this.options.adapter);this.engine=undefined;});
    this.dreamRun={controller,token,completion};return completion;
  }
  private async executeDream(controller:AbortController,token:object,resume:boolean):Promise<MobileDreamStatus> {
    if(this.options.store.unavailableReason)throw new Error(this.options.store.unavailableReason);
    await this.initialize();const config=this.readSettings();if(!config.memoryEnabled||!config.dreamEnabled)throw new Error('请先开启长期记忆和做梦。');
    if(activeDreams.has(this.options.adapter))throw new Error('当前已有画像整理在运行。');activeDreams.set(this.options.adapter,token);
    await this.reconcileExperienceInbox();
    const state=await this.dreamState.read(),snapshot=await this.snapshot(),inbox=await this.inbox.read();
    const pending=snapshot.records.some(record=>record.status==='current'&&!record.pinned&&!state.processedMemorySources.some(source=>source.memoryId===record.id&&source.memoryRevision===record.revision&&source.associationRevision===record.revision))
      ||snapshot.profile.legacyUserMigration!=='done'||inbox.entries.some(entry=>entry.evaluatedAt===null||!state.reconciliation?.experiences.some(item=>item.fingerprint===entry.fingerprint&&item.completed))
      ||snapshot.records.some(record=>record.status==='current'&&parseMemoryQuoteSource(record.source)&&!state.reconciliation?.checks.some(check=>check.phase==='original'&&check.memoryId===record.id&&check.memoryRevision===record.revision&&correctionCheckComplete(check)));
    if(!pending){this.resumePending=false;return this.saveDreamStatus('completed','',null);}
    const model=selectedModel(this.options.settings());if(!model&&!this.options.dreamLlm)throw new Error(joinErrorCopy(['画像未能整理。', 'The profile could not be organized.'], CAUSE.providerNotConfigured, 'zh'));
    const startedAt=this.now();
    this.status=await this.repository.updateAuxiliary(this.ledgerPath,raw=>{const previous=raw?this.parseLedger(raw):null;const attempts=previous?.dayKey===this.day()?previous.attempts:0;
      if(!resume&&attempts>=config.dreamRunsPerDay)throw new Error('今天的整理次数已用完，请明天再试。');
      const status:MobileDreamStatus={phase:'running',dayKey:this.day(),attemptsToday:attempts+(resume?0:1),dailyLimit:config.dreamRunsPerDay,startedAt,finishedAt:null,error:''};return {content:json({schema:'echoink.mobile-dream.v1',dayKey:this.day(),attempts:status.attemptsToday,status,owner:this.options.store.instanceId,resumable:true}),value:status};});this.emit();
    const llm=():DreamLlmPort|null=>this.options.dreamLlm??(model?{inputTokenBudget:model.model.contextWindow,call:async request=>{
      const observer:MobileUsageObserver={recordUsage:async event=>{request.onUsage?.({inputTokens:event.inputTokens,outputTokens:event.outputTokens,tokenSource:'estimated',usageRequestId:event.requestId});await this.usage?.recordUsage({...event,runId:request.runId,stepId:request.stepId});},onRecordError:this.usage?.onRecordError};
      return mobileGenerateText(model.provider,model.model,this.options.request,request.systemPrompt,request.userPrompt,request.maxTokens,request.signal??controller.signal,observer);
    }}:null);
    const guard = () => { if (controller.signal.aborted) throw new Error('dream_cancelled'); };
    this.engine=new DreamEngine({repository:{inspect:()=>this.repository.inspect(),readVaultId:()=>this.repository.readVaultId(),readFixedFiles:()=>this.repository.readFixedFiles(),applyCognitiveUpdate:input=>this.repository.applyCognitiveUpdate(input,guard),applyDreamCorrections:input=>this.repository.applyDreamCorrections(input,guard),writeSystemMemory:input=>{guard();return this.repository.writeSystemMemory(input);}},profileStore:{read:async()=>(await this.repository.snapshot()).profile},secondaryStore:{loadAll:()=>this.repository.loadSecondary(),setCache:()=>{}},dreamStateStore:this.dreamState,experienceInboxStore:this.inbox,originalQuotes:await this.quoteReader(),llm,now:this.now,config:{tokenBudget:(this.options.settings().memory as {dreamTokenBudget?:number}|undefined)?.dreamTokenBudget??50000,...this.options.engineConfig}});
    const abort=()=>{void this.engine?.dispose();};controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();
    try {const running=this.engine.runOnce();if(controller.signal.aborted)await this.engine.dispose();const result=await running;this.resumePending=controller.signal.aborted&&this.resumePending;
      return this.saveDreamStatus(controller.signal.aborted?'interrupted':result.error?'failed':'completed',controller.signal.aborted?'整理已中断，回到前台后继续。':result.error?'记忆整理未能全部完成，已提交的结果已保留。请稍后重试。':'',startedAt,this.resumePending);
    }catch(error){return this.saveDreamStatus(controller.signal.aborted?'interrupted':'failed',controller.signal.aborted?'整理已中断，回到前台后继续。':userFacingErrorText(error,'记忆整理未能完成，原资料已保留。请稍后重试。'),startedAt,this.resumePending);}
    finally{controller.signal.removeEventListener('abort',abort);}
  }
  async cancelDream():Promise<void>{this.resumePending=false;const run=this.dreamRun;if(run){run.controller.abort();await this.engine?.dispose();await run.completion.catch(()=>{});}}
  async suspend(){const run=this.dreamRun;if(run){this.resumePending=true;run.controller.abort();await this.engine?.dispose();await run.completion.catch(()=>{});}}
  async resumeDream(){await this.initialize();if(this.resumePending&&!this.dreamRun){this.resumePending=false;void this.runDream(undefined,true).catch(()=>{});}}
  async archiveCompleted(): Promise<void> {
    if (this.options.store.unavailableReason) return;
    if (!this.readSettings().autoArchive) return; const at = this.now();
    const eligible = (task: import("./store").MobileSession) => task.archivedAt === undefined && task.taskStatus === "completed" && !!task.taskCompletedAt
      && at - Math.max(task.taskCompletedAt, task.updatedAt) >= 7 * 86_400_000 && !task.draft.trim() && !task.draftContext?.attachments.length && !task.draftContext?.annotations?.length
      && !task.queue?.length && !task.pendingResponse && task.interaction?.status !== "pending" && !task.runs?.some(run => run.status === "running" || run.status === "waiting") && !this.options.isBusy(task.id);
    if (!this.options.store.state.sessions.some(eligible)) return;
    let changed = false;
    await this.options.store.update(state => { if (!this.readSettings().autoArchive) return; for (const task of state.sessions) if (eligible(task)) { task.archivedAt = at; changed = true; } });
    if (changed) this.emit();
  }
  async listArchives() { await this.archiveCompleted(); return this.options.store.state.sessions.filter(task => task.archivedAt !== undefined).map(task => ({ id: task.id, agentId: task.agentId, title: task.title, updatedAt: task.updatedAt, archivedAt: task.archivedAt!, messageCount: task.messages.length })); }
  async readArchive(id: string) { const task = this.options.store.getSession(id); if (!task?.archivedAt) throw new Error("归档会话不存在。"); return task; }
  async restoreArchive(id: string) { await this.options.store.updateSession(id, task => { if (task.archivedAt === undefined) throw memoryConflict(); delete task.archivedAt; task.updatedAt = this.now(); }); this.emit(); }
}

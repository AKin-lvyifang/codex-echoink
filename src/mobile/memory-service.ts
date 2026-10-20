import type { DataAdapter } from "obsidian";
import type { PersonalMemoryKind, PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { canonicalMemoryPath, parseCanonicalMemoryRecord, serializeCanonicalMemoryRecord, renderCanonicalMemoryExport, renderPersonalMemoryOverview } from "../harness/memory/personal-memory-core";
import { applyDreamProfileUpdate, profileSlotDefinition, USER_PROFILE_SLOTS, rebindProfileSource, computeReprocessedProfileMemoryIds, revokeReprocessedProfileSources } from "../harness/memory/user-profile-core";
import { projectedProfileItems } from "../harness/memory/cognitive-projection";
import { defaultDreamState, parseDreamState, type DreamState } from "../harness/memory/dream-state-core";
import { buildUserProfileDreamPrompt, parseUserProfileDreamCandidates, userProfileMemoryEligible } from "../harness/memory/dream-profile-core";
import { memorySourceGroup } from "../harness/memory/dream-source-group";
import { mobileGenerateText, type MobileRequest, type MobileUsageObserver } from "./transport";
import { selectedModel, type MobileSettings } from "./settings";
import type { MobileStore } from "./store";
import { sha256Hex } from "../utils/sha256";
import { MobileMemoryRepository, memoryConflict, type MobileCanonicalSnapshot } from "./memory-repository";
import type { MobileMemorySettingsPort, MobileMemorySettingsSnapshot, MobileMemoryCorrection, MobileMemoryCorrectionPreview, MobileUserProfileSnapshot, MobileDreamStatus, MobileForgottenMemory } from "./memory-contracts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const clone = <T>(value: T): T => structuredClone(value);
const activeDreams = new WeakMap<DataAdapter, object>();
const DREAM_LEDGER = "shared-user/.runtime/mobile-dream-ledger.json", DREAM_STATE = "shared-user/.runtime/dream-state.json";
export interface MobileMemoryServiceOptions {
  adapter: DataAdapter; store: MobileStore; settings(): MobileSettings; saveSettings(): Promise<void>; request: MobileRequest;
  changed(): void; isBusy(id: string): boolean; now?: () => number;
}
interface DreamLedger { schema: "echoink.mobile-dream.v1"; dayKey: string; attempts: number; status: MobileDreamStatus; owner: string }
export interface MobileCanonicalMemoryWritePlan { revision: number; record: PersonalMemoryRecord; original?: PersonalMemoryRecord; duplicate: boolean }
export class MobileMemoryService implements MobileMemorySettingsPort {
  readonly repository: MobileMemoryRepository;
  private initialization?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private dreamRun?: { controller: AbortController; token: object; completion: Promise<MobileDreamStatus> };
  private status: MobileDreamStatus;
  private settingsWrites: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private usage?: MobileUsageObserver;
  setUsage(observer: MobileUsageObserver): void { this.usage = observer; }
  constructor(private options: MobileMemoryServiceOptions) {
    this.now = options.now ?? Date.now; this.repository = new MobileMemoryRepository(options.adapter, options.store.instanceId, this.now, options.store.unavailableReason);
    this.status = { phase: "idle", dayKey: this.day(), attemptsToday: 0, dailyLimit: this.readSettings().dreamRunsPerDay, startedAt: null, finishedAt: null, error: "" };
  }
  private day() { const date = new Date(this.now()); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  private emit() { try { this.options.changed(); } catch { /* A view cannot invalidate an already committed local change. */ } for (const listener of this.listeners) { try { listener(); } catch { /* Other listeners still receive committed state. */ } } }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  initialize(): Promise<void> {
    // A temporary shell must neither claim a persisted Dream owner nor block plugin startup on its recovery.
    if (this.options.store.unavailableReason) return Promise.resolve();
    return this.initialization ??= (async () => {
      await this.repository.importLegacy(this.options.store);
      const raw = await this.repository.readAuxiliary(DREAM_LEDGER);
      if (raw !== null) {
        const ledger = this.parseLedger(raw); this.status = ledger.status;
        if (ledger.status.phase === "running" && ledger.owner === this.options.store.instanceId && !activeDreams.has(this.options.adapter)) {
          await this.finishDream("interrupted", "上次整理已中断，请主动重新开始。", ledger.status.startedAt);
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
    const source = `pi://${[before.manifest.vaultId, taskId, runId, callId].map(encodeURIComponent).join("/")}?productRun=${encodeURIComponent(runId)}`;
    const record = this.repository.newRecord({ kind, title: input.title, content: input.content, recallWhen: input.recallWhen, basis: input.basis,
      contentOrigin: input.basis === "explicit" ? "user_statement" : "current_instruction", source, revision: before.manifest.revision + 1 });
    return { revision: before.manifest.revision, record: { ...record, ...(original ? { supersedes: original.id, reason: "用户修正" } : {}) }, original, duplicate: false };
  }
  async commitToolMemory(plan: MobileCanonicalMemoryWritePlan, guard: () => void): Promise<PersonalMemoryRecord> {
    guard();
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
    return { revision: snapshot.manifest.revision, records: clone(snapshot.records.filter(record => !needle || `${record.title}\n${record.content}`.toLocaleLowerCase().includes(needle))), forgotten };
  }
  async read(id: string) { const snapshot = await this.snapshot(), record = snapshot.records.find(item => item.id === id); if (!record) throw new Error("这条记忆不存在或已忘记。"); return { revision: snapshot.manifest.revision, record: clone(record) }; }
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
      replacement = { ...replacement, supersedes: original.id, reason: "用户修正", ...(original.scope ? { scope: original.scope } : {}), ...(original.asOf ? { asOf: original.asOf } : {}), ...(original.due ? { due: original.due } : {}), ...(original.remindAt ? { remindAt: original.remindAt } : {}) };
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
      const record = same ?? this.repository.newRecord({ kind: "fact", title: `用户画像：${slot.labelZh}`, content: text.trim(), recallWhen: `需要了解用户的${slot.labelZh}时`, basis: "explicit", contentOrigin: "user_edit", source: "ui://user-profile-control", revision: targetRevision });
      if (!same) { draft.records.push(record); files.set(record.file, serializeCanonicalMemoryRecord(record)); }
      if (previous && previous.id !== record.id) {
        const superseded = { ...previous, status: "superseded" as const, revision: targetRevision, reason: "profile_update" };
        draft.records = draft.records.map(item => item.id === previous.id ? superseded : item); files.set(previous.file, serializeCanonicalMemoryRecord(superseded, draft.originals.get(previous.file) ?? undefined));
        draft.profile = { ...draft.profile, ...rebindProfileSource(draft.profile, { previousMemoryId: previous.id, replacementMemoryId: record.id, previousMemoryRevision: previous.revision, replacementText: text.trim(), now: this.now() }) };
      }
      draft.profile = { ...draft.profile, deletionBarriers: (draft.profile.deletionBarriers ?? []).filter(item => item.profileKey !== profileKey) };
      draft.profile = { ...draft.profile, ...applyDreamProfileUpdate(draft.profile, { items: [{ section: slot.section, profileKey, text: text.trim(), basis: "explicit_memory", sourceMemoryId: record.id, sourceEvidence: { kind: "memory", revision: record.revision } }], processedSources: [{ memoryId: record.id, memoryRevision: record.revision }], now: this.now() }), legacyUserMigration: "done" };
    }); this.emit(); return this.readProfile();
  }
  async confirmProfile(profileKey: string, revision: number) { const before = await this.readProfile(), item = before.items.find(item => item.profileKey === profileKey); if (!item || before.revision !== revision) throw memoryConflict(); return this.saveProfile(profileKey, item.text, revision); }
  async deleteProfile(profileKey: string, revision: number) {
    if (!profileSlotDefinition(profileKey)) throw new Error("画像分类不存在。");
    await this.repository.mutate(revision, "profile-delete", draft => { draft.profile = { ...draft.profile, revision: draft.profile.revision + 1,
      items: draft.profile.items.filter(item => item.profileKey !== profileKey), deletionBarriers: [...(draft.profile.deletionBarriers ?? []).filter(item => item.profileKey !== profileKey),
        { profileKey, memoryRevisionCutoff: draft.manifest.revision, experienceOccurredAtCutoff: this.now() }], updatedAt: this.now() }; }); this.emit(); return this.readProfile();
  }
  dreamStatus(): MobileDreamStatus { return { ...clone(this.status), ...(this.status.dayKey !== this.day() ? { dayKey: this.day(), attemptsToday: 0 } : {}), dailyLimit: this.readSettings().dreamRunsPerDay }; }
  private parseLedger(raw: string): DreamLedger {
    const invalid = () => new Error("整理次数账本损坏，原文件已保留。"); let value: unknown; try { value = JSON.parse(raw); } catch { throw invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); const record = value as Record<string, unknown>, status = record.status as Record<string, unknown> | undefined;
    if (record.schema !== "echoink.mobile-dream.v1" || !Number.isSafeInteger(record.attempts) || Number(record.attempts) < 0 || typeof record.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(record.dayKey) || typeof record.owner !== "string" || !record.owner
      || !status || !["idle", "running", "completed", "interrupted", "failed"].includes(String(status.phase)) || typeof status.error !== "string"
      || !Number.isSafeInteger(status.attemptsToday) || Number(status.attemptsToday) < 0 || !Number.isSafeInteger(status.dailyLimit) || Number(status.dailyLimit) < 1 || Number(status.dailyLimit) > 6
      || status.dayKey !== record.dayKey || status.attemptsToday !== record.attempts || [status.startedAt, status.finishedAt].some(at => at !== null && (typeof at !== "number" || !Number.isFinite(at) || at < 0))) throw invalid();
    return record as unknown as DreamLedger;
  }
  private async finishDream(phase: MobileDreamStatus["phase"], error: string, startedAt: number | null) {
    this.status = await this.repository.updateAuxiliary(DREAM_LEDGER, raw => {
      const previous = raw ? this.parseLedger(raw) : null;
      const status: MobileDreamStatus = { ...this.dreamStatus(), phase, error, startedAt, finishedAt: this.now(), dayKey: previous?.dayKey ?? this.day(), attemptsToday: previous?.attempts ?? 0 };
      return { content: json({ schema: "echoink.mobile-dream.v1", dayKey: previous?.dayKey ?? this.day(), attempts: previous?.attempts ?? 0, status, owner: this.options.store.instanceId }), value: status };
    }); this.emit(); return this.dreamStatus();
  }
  runDream(signal?: AbortSignal): Promise<MobileDreamStatus> {
    if (this.options.store.unavailableReason) return Promise.reject(new Error(this.options.store.unavailableReason));
    if (this.dreamRun) return Promise.reject(new Error("当前正在整理，请先等待或停止。"));
    const controller = new AbortController(), token = {}, abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) controller.abort();
    const completion = this.executeDream(controller, token).finally(() => { signal?.removeEventListener("abort", abort); if (this.dreamRun?.token === token) this.dreamRun = undefined; if (activeDreams.get(this.options.adapter) === token) activeDreams.delete(this.options.adapter); });
    this.dreamRun = { controller, token, completion }; return completion;
  }
  private async executeDream(controller: AbortController, token: object): Promise<MobileDreamStatus> {
    await this.initialize(); const config = this.readSettings(), model = selectedModel(this.options.settings());
    const check = () => { if (controller.signal.aborted || activeDreams.get(this.options.adapter) !== token || !this.readSettings().memoryEnabled || !this.readSettings().dreamEnabled) throw new Error("整理已中断，晚返回结果不会保存。"); };
    if (!config.memoryEnabled || !config.dreamEnabled) throw new Error("请先开启长期记忆和做梦。"); if (!model) throw new Error("请先配置可用模型，再整理画像。");
    if (activeDreams.has(this.options.adapter)) throw new Error("当前已有画像整理在运行。"); activeDreams.set(this.options.adapter, token); check();
    const before = await this.snapshot(), dreamRaw = await this.repository.readAuxiliary(DREAM_STATE);
    let dream: DreamState = defaultDreamState();
    if (dreamRaw !== null) { let value: unknown; try { value = JSON.parse(dreamRaw); } catch { throw new Error("整理状态损坏，未重置。"); } const parsed = parseDreamState(value as Record<string, unknown>); if (!parsed) throw new Error("整理状态版本不支持，未重置。"); dream = { ...(value as DreamState), ...parsed }; }
    const candidates = before.records.filter(record => record.status === "current" && userProfileMemoryEligible(record) && !dream.processedMemorySources.some(source => source.memoryId === record.id && source.memoryRevision === record.revision)).slice(0, 10);
    if (!candidates.length) { this.status = { ...this.dreamStatus(), phase: "completed", error: "", finishedAt: this.now() }; this.emit(); return this.dreamStatus(); }
    const startedAt = this.now();
    this.status = await this.repository.updateAuxiliary(DREAM_LEDGER, raw => {
      check(); const previous = raw ? this.parseLedger(raw) : null, attempts = previous?.dayKey === this.day() ? previous.attempts : 0;
      if (previous?.status.phase === "running" && previous.owner !== this.options.store.instanceId) throw new Error("另一设备的整理尚未结束，未接管或自动重试。");
      if (attempts >= config.dreamRunsPerDay) throw new Error("今天的整理次数已用完，请明天再试。");
      const status: MobileDreamStatus = { phase: "running", dayKey: this.day(), attemptsToday: attempts + 1, dailyLimit: config.dreamRunsPerDay, startedAt, finishedAt: null, error: "" };
      return { content: json({ schema: "echoink.mobile-dream.v1", dayKey: this.day(), attempts: attempts + 1, status, owner: this.options.store.instanceId }), value: status };
    }); this.emit();
    try {
      const items: Parameters<typeof applyDreamProfileUpdate>[1]["items"][number][] = [];
      for (const record of candidates) {
        check(); const prompt = buildUserProfileDreamPrompt(record);
        const output = await mobileGenerateText(model.provider, model.model, this.options.request, prompt.system, prompt.user, Math.min(4096, model.model.maxOutputTokens), controller.signal, this.usage); check();
        for (const item of parseUserProfileDreamCandidates(output)) {
          if (record.basis === "observed") {
            const group = memorySourceGroup(record.source, record.id); if (!group.independentContext) continue;
            const sourceIds = [...before.profile.items.filter(old => old.profileKey === item.profileKey && old.basis === "observed_memory" && old.text === item.text).flatMap(old => old.sourceMemoryIds),
              ...items.filter(old => old.profileKey === item.profileKey && old.basis === "observed_memory" && old.text === item.text).map(old => old.sourceMemoryId)];
            if (sourceIds.some(id => { const source = before.records.find(old => old.id === id); return source && memorySourceGroup(source.source, source.id).contextId === group.contextId; })) continue;
          }
          items.push({ ...item, basis: record.basis === "explicit" ? "explicit_memory" : "observed_memory", sourceMemoryId: record.id, sourceEvidence: { kind: "memory", revision: record.revision } });
        }
      }
      check(); await this.repository.mutate(before.manifest.revision, "dream", (draft, files) => {
        check(); const processedSources = candidates.map(record => ({ memoryId: record.id, memoryRevision: record.revision })), reprocessed = computeReprocessedProfileMemoryIds(draft.profile, processedSources);
        const base = reprocessed.size ? revokeReprocessedProfileSources(draft.profile, reprocessed, this.now()) : draft.profile;
        draft.profile = { ...draft.profile, ...applyDreamProfileUpdate(base, { items, processedSources, now: this.now() }) };
        const sources = new Map(dream.processedMemorySources.map(source => [source.memoryId, source])); for (const record of candidates) sources.set(record.id, { memoryId: record.id, memoryRevision: record.revision, processedAt: this.now() });
        files.set(DREAM_STATE, json({ ...dream, revision: dream.revision + 1, lastRunAt: startedAt, lastSuccessAt: this.now(), lastProcessedMemoryRevision: draft.manifest.revision + 1,
          processedMemorySources: [...sources.values()], pendingMemoryIds: dream.pendingMemoryIds.filter(id => !candidates.some(record => record.id === id)), updatedAt: this.now() }));
      }, check, new Map([[DREAM_STATE, dreamRaw]])); check(); return await this.finishDream("completed", "", startedAt);
    } catch (error) { return this.finishDream(controller.signal.aborted ? "interrupted" : "failed", controller.signal.aborted ? "整理已停止，晚返回结果不会保存。" : error instanceof Error ? error.message : "整理失败，原资料已保留。", startedAt); }
  }
  async cancelDream(): Promise<void> { const run = this.dreamRun; if (!run) return; run.controller.abort(); await run.completion.catch(() => {}); }
  async suspend(reason = "应用进入后台，整理已中断。") { const run = this.dreamRun; if (run) { run.controller.abort(); await run.completion.catch(() => {}); } }
  async archiveCompleted(): Promise<void> {
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

import type { DataAdapter } from "obsidian";
import type { PersonalMemoryKind, PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { PERSONAL_MEMORY_SCHEMA } from "../harness/memory/personal-memory-contracts";
import { canonicalMemoryMetadata, canonicalMemoryPath, canonicalSourceMap, parseCanonicalMemoryRecord, serializeCanonicalMemoryRecord,
  type CanonicalMemoryManifest } from "../harness/memory/personal-memory-core";
import { buildSearchIndexV3, indexChecksum, type SearchIndexV3 } from "../harness/memory/search-index-core";
import { renderPersonalMemoryOverview } from "../harness/memory/personal-memory-core";
import { emptyUserProfileState, parseUserProfileState, migrateLegacyUserProfileState, reconcileProfileSources, profileSlotDefinition, type UserProfileState } from "../harness/memory/user-profile-core";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import { invalidatedMemoryProductRunIds, productRunIdFromExperienceProfileSourceId } from "../harness/memory/dream-source-group";
import { sha256Hex } from "../utils/sha256";
import { mobileAtomicFilePort } from "./finance-store";
import type { MobileStore } from "./store";

const ROOT = ".echoink/", BASE = "shared-user/", MANIFEST = `${BASE}.runtime/manifest.json`, PROFILE = `${BASE}user-profile-state.json`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const lanes = new WeakMap<DataAdapter, Promise<unknown>>();
export const memoryConflict = () => new Error("记忆内容已变化，请重新读取后再保存；编辑草稿已保留。");
const invalid = () => new Error("记忆资料损坏或版本不支持，原文件已保留，未用空库覆盖。");
const safe = (path: string) => {
  if (!path.startsWith(BASE) || path.split("/").some(part => !part || part === "." || part === "..") || path.includes("\\") || [...path].some(char => char.charCodeAt(0) < 32)) throw invalid(); return path;
};
export interface MobileCanonicalSnapshot {
  manifest: CanonicalMemoryManifest; records: PersonalMemoryRecord[]; profile: UserProfileState; user: string; originals: Map<string, string | null>;
}
interface JournalEntry { relativePath: string; existed: boolean; backupFile?: string; installedHash: string | null }
interface Journal { schemaVersion: 1; transactionId: string; owner: string; operation: string; baseRevision: number; targetRevision: number; entries: JournalEntry[] }
/** Desktop files and global revision, with a Vault DataAdapter instead of Node/fs/watchers. */
export class MobileMemoryRepository {
  constructor(readonly adapter: DataAdapter, readonly owner: string, private now = Date.now, private mutationIssue?: string) {}
  private enqueue<T>(run: () => Promise<T>): Promise<T> { const pending = (lanes.get(this.adapter) ?? Promise.resolve()).catch(() => {}).then(run); lanes.set(this.adapter, pending); return pending; }
  private read(path: string): Promise<string | null> { return mobileAtomicFilePort(this.adapter, `${ROOT}${safe(path)}`).read(true); }
  private async mkdir(path: string) { let parent = ""; for (const part of `${ROOT}${path}`.split("/")) { parent = parent ? `${parent}/${part}` : part; if (!await this.adapter.exists(parent)) await this.adapter.mkdir(parent); } }
  private async replace(path: string, content: string | null, expected: string | null) {
    if (content === null) { if (await this.read(path) !== expected) throw memoryConflict(); if (expected !== null) await this.adapter.remove(`${ROOT}${safe(path)}`); }
    else await mobileAtomicFilePort(this.adapter, `${ROOT}${safe(path)}`).write(content, expected);
  }
  private async cleanup(directory: string) { await this.adapter.rmdir(`${ROOT}${directory}`, true); }
  private async assertNoDesktopTransaction(): Promise<void> {
    const directory = `${BASE}.runtime/transactions`;
    if (!await this.adapter.exists(`${ROOT}${directory}`)) return;
    for (const folder of (await this.adapter.list(`${ROOT}${directory}`)).folders) {
      const relative = folder.slice(ROOT.length), state = (await this.read(`${relative}/state`))?.trim();
      if (relative.split("/").at(-1)?.startsWith("txn_mobile_") || state !== "committed") throw new Error("桌面或旧版移动记忆事务尚未完成，未读取、恢复或覆盖其中资料。");
    }
  }
  private async recover(): Promise<void> {
    await this.assertNoDesktopTransaction();
    const directory = `${BASE}.runtime/mobile-transactions`;
    if (!await this.adapter.exists(`${ROOT}${directory}`)) return;
    const listed = await this.adapter.list(`${ROOT}${directory}`);
    for (const folder of listed.folders) {
      const relative = folder.slice(ROOT.length), raw = await this.read(`${relative}/plan.json`);
      if (!raw) {
        if (relative.split("/").at(-1)?.startsWith(`txn_mobile_${sha256Hex(this.owner).slice(0, 12)}_`)) { await this.cleanup(relative); continue; }
        throw new Error("记忆事务尚未准备完成，请稍后重新读取。");
      }
      let value: unknown; try { value = JSON.parse(raw); } catch { throw invalid(); }
      if (!object(value) || value.schemaVersion !== 1 || value.owner !== this.owner || !Array.isArray(value.entries)) throw new Error("另一个记忆事务尚未完成，请先完成或恢复原事务。");
      for (const entry of value.entries as unknown[]) if (!object(entry) || typeof entry.relativePath !== "string" || typeof entry.existed !== "boolean"
        || (entry.installedHash !== null && (typeof entry.installedHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.installedHash)))
        || entry.existed && (typeof entry.backupFile !== "string" || !/^backup\/[0-9]+\.bak$/u.test(entry.backupFile))) throw invalid();
      const plan = value as unknown as Journal;
      const state = (await this.read(`${relative}/state`))?.trim();
      if (state !== "committed") {
        for (const entry of [...plan.entries].reverse()) {
          safe(entry.relativePath);
          const before = entry.existed && entry.backupFile ? await this.read(`${relative}/${entry.backupFile}`) : null;
          if (entry.existed && before === null) throw invalid();
          const current = await this.read(entry.relativePath);
          if (current !== before && (current === null ? null : sha256Hex(current)) !== entry.installedHash) throw new Error("记忆恢复时发现其他修改，原资料与事务备份均已保留。");
          if (current !== before) await this.replace(entry.relativePath, before, current);
          else if (before !== null && !await this.adapter.exists(`${ROOT}${entry.relativePath}`)) await mobileAtomicFilePort(this.adapter, `${ROOT}${entry.relativePath}`).read();
        }
      }
      await this.cleanup(relative);
    }
  }
  private async transaction(baseRevision: number, targetRevision: number, changes: Map<string, string | null>, expected: Map<string, string | null>, operation: string, guard: () => void = () => {}) {
    if (this.mutationIssue) throw new Error(this.mutationIssue);
    guard();
    for (const [path, bytes] of expected) if (await this.read(path) !== bytes) throw memoryConflict();
    await this.assertNoDesktopTransaction();
    const id = `txn_mobile_${sha256Hex(this.owner).slice(0, 12)}_${crypto.randomUUID().replaceAll("-", "")}`, directory = `${BASE}.runtime/mobile-transactions/${id}`;
    const entries: JournalEntry[] = [];
    await this.mkdir(`${directory}/backup`);
    try { for (const [path, content] of changes) {
      safe(path); const before = await this.read(path), wanted = expected.get(path);
      if (expected.has(path) && before !== wanted) throw memoryConflict(); expected.set(path, before);
      const backupFile = before === null ? undefined : `backup/${entries.length}.bak`;
      if (backupFile) await this.adapter.write(`${ROOT}${directory}/${backupFile}`, before!);
      entries.push({ relativePath: path, existed: before !== null, ...(backupFile ? { backupFile } : {}), installedHash: content === null ? null : sha256Hex(content) });
    }
    const plan: Journal = { schemaVersion: 1, transactionId: id, owner: this.owner, operation, baseRevision, targetRevision, entries };
    await this.adapter.write(`${ROOT}${directory}/plan.json`, json(plan)); await this.adapter.write(`${ROOT}${directory}/state`, "applying\n");
    } catch (error) { try { await this.cleanup(directory); } catch { /* An owned preparation is safe to finish on reopening. */ } throw error; }
    try {
      for (const [path, content] of changes) { guard(); await this.replace(path, content, expected.get(path)!); guard(); if (await this.read(path) !== content) throw new Error("记忆保存回读不一致，原稿已保留。"); }
      guard();
      await this.adapter.write(`${ROOT}${directory}/state`, "committed\n");
    } catch (error) { try { await this.recover(); } catch (recovery) { throw new AggregateError([error, recovery], "记忆保存失败，原资料与恢复事务已保留。"); } throw error; }
    try { await this.cleanup(directory); } catch { /* A committed journal is safe to clean at next access. */ }
  }
  private parseManifest(raw: string): CanonicalMemoryManifest {
    let value: unknown; try { value = JSON.parse(raw); } catch { throw invalid(); }
    if (!object(value) || value.schemaVersion !== 1 || typeof value.vaultId !== "string" || !value.vaultId || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
      || !Array.isArray(value.records) || !Array.isArray(value.tombstones) || typeof value.updatedAt !== "number") throw invalid();
    const ids = new Set<string>();
    for (const row of value.records) if (!object(row) || typeof row.id !== "string" || ids.has(row.id) || typeof row.file !== "string"
      || !/^shared-user\/memory\/(facts|views|decisions|active|episodes)\/[a-zA-Z0-9_-]{3,96}\.md$/u.test(row.file)) throw invalid(); else ids.add(row.id);
    for (const row of value.tombstones) if (!object(row) || typeof row.recordId !== "string" || typeof row.backupFile !== "string" || !row.backupFile.startsWith(`${BASE}.runtime/backups/`)
      || typeof row.forgottenAt !== "number" || typeof row.reason !== "string" || typeof row.source !== "string") throw invalid();
    return value as unknown as CanonicalMemoryManifest;
  }
  private profileState(value: Record<string, unknown>): UserProfileState {
    if (value.schema === "echoink.user-profile.v2") {
      if (!Array.isArray(value.items) || !Array.isArray(value.processedSources)) throw invalid();
      for (const item of value.items as unknown[]) {
        if (!object(item) || typeof item.id !== "string" || !item.id || typeof item.profileKey !== "string" || profileSlotDefinition(item.profileKey)?.section !== item.section
          || !["explicit_memory", "observed_memory", "legacy_import"].includes(String(item.basis)) || !["current", "superseded"].includes(String(item.status))
          || !Array.isArray(item.sourceMemoryIds) || item.sourceMemoryIds.length > 3 || item.sourceMemoryIds.some(id => typeof id !== "string" || !id)
          || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0) throw invalid();
      }
      for (const source of value.processedSources as unknown[]) if (!object(source) || typeof source.memoryId !== "string" || !source.memoryId || !Number.isSafeInteger(source.memoryRevision) || Number(source.memoryRevision) < 1
        || typeof source.processedAt !== "number" || !Number.isFinite(source.processedAt)) throw invalid();
    }
    const parsed = value.schema === "echoink.user-profile.v1" ? migrateLegacyUserProfileState(value).state : parseUserProfileState(value);
    if (!parsed || !Array.isArray(value.items) || parsed.items.length !== value.items.length) throw invalid();
    return { ...value, ...parsed, items: parsed.items.map(item => ({ ...(value.items as Record<string, unknown>[]).find(raw => raw.id === item.id), ...item })) };
  }
  private async fresh(): Promise<MobileCanonicalSnapshot> {
    await this.recover();
    let raw = await this.read(MANIFEST);
    if (raw === null) { await this.bootstrap(); raw = await this.read(MANIFEST); }
    const manifest = this.parseManifest(raw!); const records: PersonalMemoryRecord[] = [], originals = new Map<string, string | null>([[MANIFEST, raw]]);
    for (const metadata of manifest.records) {
      const bytes = await this.read(metadata.file); if (bytes === null) throw invalid();
      const record = parseCanonicalMemoryRecord(bytes, metadata.file);
      if (record.id !== metadata.id || record.revision !== metadata.revision || metadata.contentHash && sha256Hex(record.content) !== metadata.contentHash) throw memoryConflict();
      for (const [key, value] of Object.entries(canonicalMemoryMetadata(record))) if (key !== "contentHash" && !(key === "recallWhen" && metadata.recallWhen === undefined && record.recallWhen === record.title)
        && JSON.stringify((metadata as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)) throw memoryConflict();
      records.push(record); originals.set(metadata.file, bytes);
    }
    const user = await this.read(`${BASE}USER.md`); if (user === null) throw invalid(); originals.set(`${BASE}USER.md`, user);
    const profileRaw = await this.read(PROFILE); originals.set(PROFILE, profileRaw);
    let profile: UserProfileState;
    if (profileRaw === null) profile = { ...emptyUserProfileState(this.now()), lastProjectedUserHash: sha256Hex(user), legacyUserMigration: "pending" };
    else {
      let value: unknown; try { value = JSON.parse(profileRaw); } catch { throw invalid(); }
      if (!object(value)) throw invalid();
      profile = this.profileState(value);
      if (profile.lastProjectedUserHash && profile.lastProjectedUserHash !== sha256Hex(user)) throw memoryConflict();
    }
    if (manifest.fixedFileHashes?.user && manifest.fixedFileHashes.user !== sha256Hex(user)) throw memoryConflict();
    originals.set(`${BASE}.runtime/search-index.json`, await this.read(`${BASE}.runtime/search-index.json`));
    originals.set(`${BASE}.runtime/mobile-memory-import-${this.owner}.json`, await this.read(`${BASE}.runtime/mobile-memory-import-${this.owner}.json`));
    return { manifest, records, profile, user, originals };
  }
  private async bootstrap(): Promise<void> {
    const records: PersonalMemoryRecord[] = [], originals = new Map<string, string | null>([[MANIFEST, null]]);
    for (const kind of ["facts", "views", "decisions", "active", "episodes"]) {
      const directory = `${BASE}memory/${kind}`;
      if (!await this.adapter.exists(`${ROOT}${directory}`)) continue;
      for (const path of (await this.adapter.list(`${ROOT}${directory}`)).files) {
        if (!path.endsWith(".md")) continue;
        const relative = path.slice(ROOT.length), bytes = await this.read(relative); if (bytes === null) throw invalid();
        records.push(parseCanonicalMemoryRecord(bytes, relative)); originals.set(relative, bytes);
      }
    }
    const existingProfile = await this.read(PROFILE); if (existingProfile !== null) { let value: unknown; try { value = JSON.parse(existingProfile); } catch { throw invalid(); }
      if (!object(value)) throw invalid(); this.profileState(value); }
    const now = this.now(), previousUser = await this.read(`${BASE}USER.md`), profile = emptyUserProfileState(now), user = previousUser ?? renderUserMarkdown(profile);
    const agent = await this.adapter.exists(`${ROOT}agents/echoink/AGENT.md`) ? await this.adapter.read(`${ROOT}agents/echoink/AGENT.md`) : "";
    const revision = Math.max(0, ...records.map(record => record.revision));
    const manifest: CanonicalMemoryManifest = { schemaVersion: 1, vaultId: `vault_${crypto.randomUUID().replaceAll("-", "")}`, revision, records: records.map(canonicalMemoryMetadata), tombstones: [], updatedAt: now,
      fixedFileHashes: { agent: sha256Hex(agent), user: sha256Hex(user) } };
    const changes = new Map<string, string | null>();
    changes.set(MANIFEST, json(manifest));
    if (previousUser === null) changes.set(`${BASE}USER.md`, user);
    if (existingProfile === null) changes.set(PROFILE, json({ ...profile, lastProjectedUserHash: sha256Hex(user), legacyUserMigration: previousUser ? "pending" : "done" }));
    const previousOverview = await this.read(`${BASE}MEMORY.md`); if (previousOverview === null) changes.set(`${BASE}MEMORY.md`, renderPersonalMemoryOverview(manifest, records));
    changes.set(`${BASE}.runtime/search-index.json`, json(this.index(manifest, records))); changes.set(`${BASE}.runtime/source-map.json`, json(canonicalSourceMap(manifest)));
    await this.transaction(0, revision, changes, originals, "mobile-memory-initialize");
  }
  private index(manifest: CanonicalMemoryManifest, records: readonly PersonalMemoryRecord[], previousRaw?: string | null) {
    const summary = (text: string) => { const clean = text.replaceAll(/\s+/gu, " ").trim(); return clean.length <= 240 ? clean : `${clean.slice(0, 237)}…`; };
    const index = buildSearchIndexV3(manifest.revision, records.map(record => ({ ...record, sourceSummary: summary(record.source), summary: summary(record.content) })), []);
    if (!previousRaw) return index;
    let value: unknown; try { value = JSON.parse(previousRaw); } catch { return index; }
    if (!object(value) || value.schemaVersion !== 3 || !Array.isArray(value.secondaryCatalog) || !Array.isArray(value.secondaryIndex) || !Array.isArray(value.catalog)) return index;
    const previous = value as unknown as SearchIndexV3;
    if (previous.checksum !== indexChecksum(previous.revision, previous.catalog, previous.secondaryCatalog, previous.secondaryIndex)) return index;
    const currentIds = new Set(records.filter(record => record.status === "current").map(record => record.id));
    const secondaryCatalog = previous.secondaryCatalog.filter(record => currentIds.has(record.parentId)), secondaryIds = new Set(secondaryCatalog.map(record => record.id));
    const secondaryIndex = previous.secondaryIndex.filter(record => currentIds.has(record.parentId) && secondaryIds.has(record.secondaryId));
    return { ...index, secondaryCatalog, secondaryIndex, checksum: indexChecksum(index.revision, index.catalog, secondaryCatalog, secondaryIndex) };
  }
  snapshot(): Promise<MobileCanonicalSnapshot> { return this.enqueue(() => this.fresh()); }
  readAuxiliary(path: string): Promise<string | null> { return this.enqueue(async () => { await this.recover(); return this.read(path); }); }
  updateAuxiliary<T>(path: string, update: (before: string | null) => { content: string; value: T }): Promise<T> {
    if (this.mutationIssue) return Promise.reject(new Error(this.mutationIssue));
    return this.enqueue(async () => { await this.recover(); const before = await this.read(path), next = update(before); await this.replace(path, next.content, before); return next.value; });
  }
  /** Mutation plans run synchronously against one revision and commit as one recoverable journal. */
  mutate(expectedRevision: number | undefined, operation: string, change: (draft: MobileCanonicalSnapshot, files: Map<string, string | null>) => void | false, guard: () => void = () => {}, extraExpected?: ReadonlyMap<string, string | null>): Promise<MobileCanonicalSnapshot> {
    return this.enqueue(async () => {
      const draft = await this.fresh(); if (expectedRevision !== undefined && draft.manifest.revision !== expectedRevision) throw memoryConflict();
      for (const [path, bytes] of extraExpected ?? []) draft.originals.set(safe(path), bytes);
      const beforeRevision = draft.manifest.revision, files = new Map<string, string | null>();
      const migrateLegacyUser = draft.profile.legacyUserMigration === "pending" && ["profile-save", "profile-delete", "dream"].includes(operation);
      const legacyUser = draft.user, legacyBackup = `${BASE}.runtime/backups/legacy-user-${sha256Hex(legacyUser)}.md`;
      if (migrateLegacyUser) {
        const existingBackup = await this.read(legacyBackup); if (existingBackup !== null && existingBackup !== legacyUser) throw memoryConflict();
        draft.originals.set(legacyBackup, existingBackup); if (existingBackup === null) files.set(legacyBackup, legacyUser);
        if (legacyUser.trim().length > 24_000) throw new Error("旧 USER.md 正文过长，原文件仍保留；请先整理原文件后再更新画像，未覆盖原文。");
      }
      if (change(draft, files) === false) return draft; draft.manifest.revision = beforeRevision + 1; draft.manifest.updatedAt = this.now();
      if (migrateLegacyUser) {
        const defaultUser = ["# USER", "", "这里保存用户明确确认的当前稳定画像与合作方式。", "", "- 尚无已确认内容。", ""].join("\n");
        if (legacyUser !== defaultUser && legacyUser !== renderUserMarkdown(emptyUserProfileState(this.now()))
          && !draft.records.some(record => record.status === "current" && record.kind === "fact" && record.basis === "explicit" && record.content === legacyUser.trim())) {
          const record = this.newRecord({ kind: "fact", title: "迁移自 USER.md 的用户画像", content: legacyUser, recallWhen: "需要核对旧用户画像时", basis: "explicit", contentOrigin: "user_edit", source: "user-edit://legacy-user-profile", revision: draft.manifest.revision });
          draft.records.push(record); files.set(record.file, serializeCanonicalMemoryRecord(record));
        }
        draft.profile = { ...draft.profile, legacyUserMigration: "done" };
      }
      const oldProfile = draft.profile;
      const validSources = new Set(draft.records.filter(record => record.status === "current").map(record => record.id)), invalidated = invalidatedMemoryProductRunIds(draft.records);
      for (const item of oldProfile.items) for (const source of item.sourceMemoryIds) { const run = productRunIdFromExperienceProfileSourceId(source); if (run && !invalidated.has(run)) validSources.add(source); }
      draft.profile = { ...oldProfile, ...reconcileProfileSources(oldProfile, validSources, this.now()) };
      const user = renderUserMarkdown(draft.profile); draft.profile = { ...draft.profile, lastProjectedUserHash: sha256Hex(user) };
      // Raw legacy USER is retained until a deliberate profile/Dream update; it is never silently replaced by an empty projection.
      const preserveLegacy = draft.profile.legacyUserMigration === "pending" && !["profile-save", "profile-delete", "dream"].includes(operation);
      if (!preserveLegacy) { files.set(`${BASE}USER.md`, user); files.set(PROFILE, json(draft.profile)); draft.manifest.fixedFileHashes = { agent: draft.manifest.fixedFileHashes?.agent ?? sha256Hex(""), user: sha256Hex(user) }; }
      const previousMetadata = new Map(draft.manifest.records.map(record => [record.id, record]));
      draft.manifest.records = draft.records.map(record => ({ ...previousMetadata.get(record.id), ...canonicalMemoryMetadata(record) })).sort((a, b) => a.id.localeCompare(b.id));
      const auditPath = `${BASE}.runtime/audit.jsonl`, audit = await this.read(auditPath); draft.originals.set(auditPath, audit);
      files.set(auditPath, `${audit ?? ""}${JSON.stringify({ type: "cognitive_update", revision: draft.manifest.revision, at: this.now(), detail: operation })}\n`);
      files.set(`${BASE}.runtime/search-index.json`, json(this.index(draft.manifest, draft.records, draft.originals.get(`${BASE}.runtime/search-index.json`)))); files.set(`${BASE}.runtime/source-map.json`, json(canonicalSourceMap(draft.manifest)));
      files.set(`${BASE}MEMORY.md`, renderPersonalMemoryOverview(draft.manifest, draft.records));
      // Manifest is installed last; a complete journal is the only publication boundary.
      files.set(MANIFEST, json(draft.manifest));
      await this.transaction(beforeRevision, draft.manifest.revision, files, draft.originals, operation, guard); return this.fresh();
    });
  }
  async importLegacy(store: MobileStore): Promise<void> {
    if (store.unavailableReason || this.mutationIssue) return;
    await store.flush(); const source = await this.adapter.read(store.statePath); let oldState: unknown; try { oldState = JSON.parse(source); } catch { throw invalid(); }
    if (!object(oldState) || oldState.version !== 2 || oldState.instanceId !== store.instanceId || !Array.isArray(oldState.memories)) throw invalid();
    const memories = oldState.memories as PersonalMemoryRecord[];
    if (!memories.length) { await this.snapshot(); return; }
    const marker = `${BASE}.runtime/mobile-memory-import-${store.instanceId}.json`;
    await this.enqueue(async () => { await this.fresh(); const backup = `${BASE}.runtime/backups/mobile-v2-${store.instanceId}.json`;
      if (await this.read(backup) === null) { await this.mkdir(`${BASE}.runtime/backups`); await this.adapter.write(`${ROOT}${backup}`, source); if (await this.read(backup) !== source) throw new Error("旧移动记忆备份回读失败，未导入。"); } });
    const existing = await this.read(marker);
    let mapping: Record<string, string> = {};
    if (existing !== null) { let parsed: unknown; try { parsed = JSON.parse(existing); } catch { throw invalid(); }
      if (!object(parsed) || parsed.schema !== "echoink.mobile-memory-import.v1" || !object(parsed.mapping)) throw invalid(); mapping = parsed.mapping as Record<string, string>; }
    const pending = memories.filter(record => !mapping[record.id]); if (!pending.length) return;
    await this.mutate(undefined, "mobile-memory-import", (draft, files) => {
      const latestMarker = draft.originals.get(marker); if (latestMarker) { const latest: unknown = JSON.parse(latestMarker); if (!object(latest) || !object(latest.mapping)) throw invalid(); mapping = latest.mapping as Record<string, string>; }
      if (memories.every(record => !!mapping[record.id])) return false;
      for (const old of memories.filter(record => !mapping[record.id])) {
        const prior = draft.records.find(record => record.id === old.id && record.content === old.content && record.kind === old.kind && record.source === old.source);
        if (prior) { mapping[old.id] = prior.id; continue; }
        const id = /^[a-zA-Z0-9_-]{3,96}$/u.test(old.id) && !draft.records.some(record => record.id === old.id) ? old.id : `mem_${crypto.randomUUID().replaceAll("-", "")}`;
        const proposed: PersonalMemoryRecord = { ...old, id, date: old.date.slice(0, 10), revision: draft.manifest.revision + 1, file: canonicalMemoryPath(old.kind, id) };
        const record = { ...old, ...parseCanonicalMemoryRecord(serializeCanonicalMemoryRecord(proposed), proposed.file) };
        draft.records.push(record); files.set(record.file, serializeCanonicalMemoryRecord(record)); mapping[old.id] = id;
      }
      files.set(marker, json({ schema: "echoink.mobile-memory-import.v1", sourcePath: store.statePath, sourceHash: sha256Hex(source), mapping }));
    });
  }
  newRecord(input: { kind: PersonalMemoryKind; title: string; content: string; recallWhen: string; basis: PersonalMemoryRecord["basis"]; source: string; revision: number; contentOrigin?: PersonalMemoryRecord["contentOrigin"] }): PersonalMemoryRecord {
    const id = `mem_${crypto.randomUUID().replaceAll("-", "")}`;
    return parseCanonicalMemoryRecord(serializeCanonicalMemoryRecord({ schema: PERSONAL_MEMORY_SCHEMA, id, status: "current", date: new Date(this.now()).toISOString().slice(0, 10), file: canonicalMemoryPath(input.kind, id), ...input }), canonicalMemoryPath(input.kind, id));
  }
}

/** Shared profile rules and closed slots; no filesystem or Agent Self dependency. */
import { USER_PROFILE_STATE_SCHEMA } from "./personal-memory-contracts";
const cognitiveJsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const newCognitiveId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
export type UserProfileSection = "identity" | "preference" | "collaboration";
export type UserProfileItemBasis = "explicit_memory" | "observed_memory" | "legacy_import";

export const PROFILE_KEY_MAX_CHARS = 40;
export const USER_PROFILE_ITEM_RECOMMENDED_MAX_CHARS = 80 as const;
export const USER_PROFILE_ITEM_HARD_MAX_CHARS = 120 as const;
export const USER_PROFILE_PROJECTION_TARGET_CHARS = 2_000 as const;
export const USER_PROFILE_WRITE_HARD_MAX_CHARS = 8_000 as const;

function normalizedProfileClaimValue(text: string): string {
  return text.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

export interface UserProfileSlotDefinition {
  readonly section: UserProfileSection;
  readonly profileKey: string;
  readonly labelZh: string;
  /** Larger values are projected first inside the same evidence class. */
  readonly importance: number;
}

/**
 * Closed profile taxonomy. Provider output must choose exactly one of these
 * keys; arbitrary synonyms and text-derived fallback keys are rejected.
 */
export const USER_PROFILE_SLOTS: readonly UserProfileSlotDefinition[] = Object.freeze([
  Object.freeze({ section: "identity", profileKey: "identity.name", labelZh: "姓名与称呼", importance: 100 }),
  Object.freeze({ section: "identity", profileKey: "identity.pronouns", labelZh: "称谓与代词", importance: 96 }),
  Object.freeze({ section: "identity", profileKey: "identity.role", labelZh: "职业与角色", importance: 92 }),
  Object.freeze({ section: "identity", profileKey: "identity.organization", labelZh: "组织与团队", importance: 88 }),
  Object.freeze({ section: "identity", profileKey: "identity.location_timezone", labelZh: "地区与时区", importance: 84 }),
  Object.freeze({ section: "identity", profileKey: "identity.background", labelZh: "长期背景", importance: 80 }),

  Object.freeze({ section: "preference", profileKey: "preference.language", labelZh: "语言", importance: 78 }),
  Object.freeze({ section: "preference", profileKey: "preference.tone", labelZh: "语气", importance: 76 }),
  Object.freeze({ section: "preference", profileKey: "preference.detail", labelZh: "详略", importance: 74 }),
  Object.freeze({ section: "preference", profileKey: "preference.format", labelZh: "呈现格式", importance: 72 }),
  Object.freeze({ section: "preference", profileKey: "preference.examples", labelZh: "示例方式", importance: 70 }),
  Object.freeze({ section: "preference", profileKey: "preference.tools", labelZh: "工具偏好", importance: 68 }),
  Object.freeze({ section: "preference", profileKey: "preference.workflow", labelZh: "工作流偏好", importance: 66 }),
  Object.freeze({ section: "preference", profileKey: "preference.design", labelZh: "设计偏好", importance: 64 }),
  Object.freeze({ section: "preference", profileKey: "preference.technology", labelZh: "技术偏好", importance: 62 }),
  Object.freeze({ section: "preference", profileKey: "preference.interests", labelZh: "长期兴趣", importance: 60 }),
  Object.freeze({ section: "preference", profileKey: "preference.avoidances", labelZh: "明确避好", importance: 58 }),
  Object.freeze({ section: "preference", profileKey: "preference.accessibility", labelZh: "可访问性偏好", importance: 56 }),

  Object.freeze({ section: "collaboration", profileKey: "collaboration.decision_style", labelZh: "决策方式", importance: 54 }),
  Object.freeze({ section: "collaboration", profileKey: "collaboration.autonomy", labelZh: "自主推进", importance: 52 }),
  Object.freeze({ section: "collaboration", profileKey: "collaboration.confirmation", labelZh: "确认边界", importance: 50 }),
  Object.freeze({ section: "collaboration", profileKey: "collaboration.feedback", labelZh: "反馈方式", importance: 48 }),
  Object.freeze({ section: "collaboration", profileKey: "collaboration.quality_bar", labelZh: "质量标准", importance: 46 }),
  Object.freeze({ section: "collaboration", profileKey: "collaboration.pace", labelZh: "协作节奏", importance: 44 })
]);

const PROFILE_SLOT_BY_KEY = new Map(USER_PROFILE_SLOTS.map((slot) => [slot.profileKey, slot]));

export function profileSlotDefinition(profileKey: string): UserProfileSlotDefinition | null {
  return PROFILE_SLOT_BY_KEY.get(profileKey) ?? null;
}

export function isUserProfileKey(value: unknown): value is string {
  return typeof value === "string" && PROFILE_SLOT_BY_KEY.has(value);
}

/**
 * 做梦 Prompt 携带的已有 profileKey 目录上限（Round 6 修复七）：
 * Prompt 只给「section:key」目录供模型复用稳定主题，绝不允许无界增长。
 */
export const PROFILE_KEY_PROMPT_CAP = 24 as const;

export interface ProfileKeyCatalogEntry {
  readonly section: UserProfileSection;
  readonly profileKey: string;
}

/**
 * Round 6 修复七：生成做梦 Prompt 用的有界 profileKey 目录。
 * - 只取 current 画像项，按 section + key 去重；
 * - 总数不超过 PROFILE_KEY_PROMPT_CAP；需要裁剪时优先保留最近新增
 *   （item.revision 更大者），同 revision 按 section、key 字典序，
 *   输出顺序稳定可复现；
 * - `sameRoundEntries`（本轮已经产生、尚未落盘的新 key）视为最新，
 *   同样计入上限。
 */
export function profileKeyPromptCatalog(
  _state: UserProfileState,
  _sameRoundEntries: readonly Readonly<{ section: UserProfileSection; profileKey: string }>[] = []
): readonly ProfileKeyCatalogEntry[] {
  return Object.freeze(USER_PROFILE_SLOTS.map((slot) => Object.freeze({
    section: slot.section,
    profileKey: slot.profileKey
  })));
}

export interface UserProfileItem {
  readonly id: string;
  readonly section: UserProfileSection;
  /** 稳定主题 key（如「清晨散步」）：按 section + key 聚合近义来源。 */
  readonly profileKey: string;
  readonly text: string;
  readonly basis: UserProfileItemBasis;
  readonly status: "current" | "superseded";
  readonly sourceMemoryIds: readonly string[];
  readonly revision: number;
  readonly updatedAt?: number;
}

/** One committed control-plane revision, before USER.md's text budget. */
export interface UserProfileControlSnapshot {
  readonly revision: number;
  readonly items: readonly UserProfileItem[];
}

/** A bounded per-slot barrier against replaying evidence that predates deletion. */
export interface UserProfileDeletionBarrier {
  readonly profileKey: string;
  readonly memoryRevisionCutoff: number;
  readonly experienceOccurredAtCutoff: number;
}

export interface ProcessedProfileSource {
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly processedAt: number;
}

export interface UserProfileState {
  readonly schema: typeof USER_PROFILE_STATE_SCHEMA;
  readonly revision: number;
  readonly items: readonly UserProfileItem[];
  readonly processedSources: readonly ProcessedProfileSource[];
  /** Absent in older v2 files. At most one entry for each closed profile slot. */
  readonly deletionBarriers?: readonly UserProfileDeletionBarrier[];
  /**
   * Legacy USER.md migration marker (草案 §12.3): "pending" → custom USER.md
   * still needs to be converted into an explicit primary Memory before the
   * projection may replace it; "done" → migration finished.
   */
  readonly legacyUserMigration: "pending" | "done" | null;
  /** Content hash of the last USER.md projection written by the system. */
  readonly lastProjectedUserHash: string;
  readonly updatedAt: number;
}

export const USER_PROFILE_STATE_RELATIVE_PATH = "shared-user/user-profile-state.json";

/**
 * inferred 画像至少需要多少个独立、方向一致的 Memory 或公开经历来源，
 * 才能进入 USER.md。与 Agent Self 的行为推断门槛一致：单一观察不能
 * 直接成为长期画像。
 */
export const USER_OBSERVED_MIN_SOURCES = 2 as const;

export type UserProfileStateInspection =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "v2"; state: UserProfileState }>
  | Readonly<{ kind: "v1"; state: UserProfileState }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export function migrateLegacyUserProfileState(
  raw: Record<string, unknown>
): Readonly<{ state: UserProfileState | null; reason?: string }> {
  if (!Array.isArray(raw.items) || !Array.isArray(raw.processedSources)) {
    return Object.freeze({ state: null, reason: "legacy_shape_invalid" });
  }
  const mappedItems: Record<string, unknown>[] = [];
  const seenSlots = new Set<string>();
  for (const value of raw.items) {
    if (!value || typeof value !== "object") {
      return Object.freeze({ state: null, reason: "legacy_item_invalid" });
    }
    const item = value as Record<string, unknown>;
    const section = item.section;
    if (section !== "identity" && section !== "preference" && section !== "collaboration") {
      return Object.freeze({ state: null, reason: "legacy_section_invalid" });
    }
    const rawKey = typeof item.profileKey === "string" ? item.profileKey.trim() : "";
    const slot = mapLegacyProfileSlot(section, rawKey);
    if (!slot) return Object.freeze({ state: null, reason: "legacy_profile_key_unmappable" });
    if (!Array.isArray(item.sourceMemoryIds)
      || item.sourceMemoryIds.some((id) => typeof id !== "string")) {
      return Object.freeze({ state: null, reason: "legacy_sources_invalid" });
    }
    const basisSlot = item.basis === "observed_memory" ? "observed" : "explicit";
    const slotKey = `${slot.profileKey}\u0000${basisSlot}`;
    if (seenSlots.has(slotKey)) {
      return Object.freeze({ state: null, reason: "legacy_duplicate_slot" });
    }
    seenSlots.add(slotKey);
    mappedItems.push({ ...item, section: slot.section, profileKey: slot.profileKey });
  }
  if (raw.processedSources.some((value) =>
    !value || typeof value !== "object"
    || typeof (value as Record<string, unknown>).memoryId !== "string"
    || typeof (value as Record<string, unknown>).memoryRevision !== "number")) {
    return Object.freeze({ state: null, reason: "legacy_processed_sources_invalid" });
  }
  const state = parseUserProfileState({
    ...raw,
    schema: USER_PROFILE_STATE_SCHEMA,
    items: mappedItems
  });
  if (!state
    || state.items.length !== mappedItems.length
    || state.processedSources.length !== raw.processedSources.length) {
    return Object.freeze({ state: null, reason: "legacy_migration_would_drop_data" });
  }
  return Object.freeze({ state });
}

function mapLegacyProfileSlot(
  section: UserProfileSection,
  rawKey: string
): UserProfileSlotDefinition | null {
  const direct = profileSlotDefinition(rawKey);
  if (direct?.section === section) return direct;
  const wrappedPrefix = `${section}:`;
  if (rawKey.startsWith(wrappedPrefix)) {
    const wrapped = profileSlotDefinition(rawKey.slice(wrappedPrefix.length));
    if (wrapped?.section === section) return wrapped;
  }
  return USER_PROFILE_SLOTS.find((slot) =>
    slot.section === section && slot.labelZh === rawKey
  ) ?? null;
}

export function emptyUserProfileState(now: number): UserProfileState {
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision: 0,
    items: Object.freeze([]),
    processedSources: Object.freeze([]),
    deletionBarriers: Object.freeze([]),
    legacyUserMigration: null,
    lastProjectedUserHash: "",
    updatedAt: now
  });
}

export function userProfileStateJson(state: UserProfileState): string {
  return cognitiveJsonText(state);
}

export interface DreamProfileInput {
  readonly items: readonly Readonly<{
    section: UserProfileSection;
    text: string;
    /** 模型输出的稳定主题 key；缺省时从 text 生成 fallback。 */
    profileKey?: string;
    basis: UserProfileItemBasis;
    sourceMemoryId: string;
    /** Host-owned evidence version, never taken from Provider output. */
    sourceEvidence?: Readonly<
      { kind: "memory"; revision: number }
      | { kind: "experience"; occurredAt: number }
    >;
  }>[];
  readonly processedSources: readonly Readonly<{
    memoryId: string;
    memoryRevision: number;
  }>[];
  readonly now: number;
  readonly lastProjectedUserHash?: string;
  readonly legacyUserMigration?: "pending" | "done" | null;
}

/** Apply one dreaming round's user-profile work (pure). */
export function applyDreamProfileUpdate(
  previous: UserProfileState,
  input: DreamProfileInput
): UserProfileState {
  const revision = previous.revision + 1;
  const items: UserProfileItem[] = [...previous.items];

  for (const incoming of input.items) {
    const text = incoming.text.trim();
    if (!text || text.length > USER_PROFILE_ITEM_HARD_MAX_CHARS) continue;
    const key = incoming.profileKey?.trim() ?? "";
    const slot = profileSlotDefinition(key);
    if (!slot || slot.section !== incoming.section) continue;
    const barrier = previous.deletionBarriers?.find((entry) => entry.profileKey === key);
    if (barrier) {
      const evidence = incoming.sourceEvidence;
      if (!evidence || (evidence.kind === "memory"
        ? !(evidence.revision > barrier.memoryRevisionCutoff)
        : !(evidence.occurredAt > barrier.experienceOccurredAtCutoff))) continue;
    }
    const basisSlot = incoming.basis === "observed_memory" ? "observed" : "explicit";
    const claimValue = normalizedProfileClaimValue(text);
    const existingIndex = items.findIndex((item) =>
      item.profileKey === key
      && (item.basis === "observed_memory" ? "observed" : "explicit") === basisSlot
    );
    if (existingIndex >= 0) {
      const existing = items[existingIndex];
      const sameObservedClaim = basisSlot === "observed"
        && existing.status === "current"
        && normalizedProfileClaimValue(existing.text) === claimValue;
      if (basisSlot === "observed"
        && existing.status === "current"
        && existing.sourceMemoryIds.length >= USER_OBSERVED_MIN_SOURCES
        && !sameObservedClaim) {
        // A promoted observed value stays supported by its existing valid
        // sources. One contradictory observation neither votes for it nor
        // replaces it; only source reconciliation/reprocessing or explicit
        // truth may retire or hide the established value.
        continue;
      }
      const sourceMemoryIds = sameObservedClaim
        ? uniqueTail([...existing.sourceMemoryIds, incoming.sourceMemoryId], 3)
        : [incoming.sourceMemoryId];
      items[existingIndex] = Object.freeze({
        ...existing,
        section: slot.section,
        profileKey: slot.profileKey,
        // Each closed slot has at most one observed candidate. Only the same
        // bounded normalized claim can accumulate independent sources; a
        // contradictory claim resets the candidate to one source so values
        // can never pool votes. Raw contradictory evidence stays in Memory.
        text: sameObservedClaim ? existing.text : text,
        basis: incoming.basis === "observed_memory" ? "observed_memory" : "explicit_memory",
        status: "current",
        sourceMemoryIds: Object.freeze(sourceMemoryIds),
        revision,
        updatedAt: input.now
      });
      continue;
    }
    items.push(Object.freeze({
      id: newCognitiveId("profile"),
      section: slot.section,
      profileKey: slot.profileKey,
      text,
      basis: incoming.basis === "observed_memory" ? "observed_memory" : "explicit_memory",
      status: "current",
      sourceMemoryIds: Object.freeze([incoming.sourceMemoryId]),
      revision,
      updatedAt: input.now
    }));
  }

  const processedMap = new Map<string, ProcessedProfileSource>(
    previous.processedSources.map((source) => [source.memoryId, source])
  );
  for (const source of input.processedSources) {
    processedMap.set(source.memoryId, Object.freeze({
      memoryId: source.memoryId,
      memoryRevision: source.memoryRevision,
      processedAt: input.now
    }));
  }
  const boundedProcessedSources = boundProcessedSources(
    [...processedMap.values()],
    items
  );

  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(boundedProcessedSources),
    deletionBarriers: previous.deletionBarriers ?? Object.freeze([]),
    legacyUserMigration: input.legacyUserMigration !== undefined
      ? input.legacyUserMigration
      : previous.legacyUserMigration,
    lastProjectedUserHash: input.lastProjectedUserHash ?? previous.lastProjectedUserHash,
    updatedAt: input.now
  });
}

/**
 * Memory 来源失效回收：USER 画像项失去全部有效一级 Memory 来源后标记
 * superseded；已处理来源同步清理。纯函数：无变化时返回原引用。
 */
export function reconcileProfileSources(
  previous: UserProfileState,
  validMemoryIds: ReadonlySet<string>,
  now: number
): UserProfileState {
  let changed = false;
  const revision = previous.revision + 1;
  const items: UserProfileItem[] = [];
  for (const item of previous.items) {
    if (item.status !== "current") {
      items.push(item);
      continue;
    }
    const alive = item.sourceMemoryIds.filter((id) => validMemoryIds.has(id));
    if (alive.length === item.sourceMemoryIds.length) {
      items.push(item);
      continue;
    }
    changed = true;
    if (alive.length === 0) {
      items.push(Object.freeze({
        ...item,
        status: "superseded" as const,
        sourceMemoryIds: Object.freeze([]),
        revision
      }));
    } else {
      items.push(Object.freeze({
        ...item,
        sourceMemoryIds: Object.freeze(alive),
        revision
      }));
    }
  }
  const processedSources = boundProcessedSources(
    previous.processedSources.filter((source) => validMemoryIds.has(source.memoryId)),
    items
  );
  if (processedSources.length !== previous.processedSources.length) changed = true;
  if (!changed) return previous;
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(processedSources),
    deletionBarriers: previous.deletionBarriers ?? Object.freeze([]),
    legacyUserMigration: previous.legacyUserMigration,
    lastProjectedUserHash: previous.lastProjectedUserHash,
    updatedAt: now
  });
}

/**
 * Generic Memory supersede keeps an existing USER projection attached to the
 * replacement record. The carried processed revision intentionally remains
 * the old Memory revision so Dream treats the replacement as reprocessed and
 * can replace or revoke the inherited projection after successful analysis.
 */
export function rebindProfileSource(
  previous: UserProfileState,
  input: Readonly<{
    previousMemoryId: string;
    replacementMemoryId: string;
    previousMemoryRevision: number;
    replacementText: string;
    now: number;
  }>
): UserProfileState {
  if (input.previousMemoryId === input.replacementMemoryId) return previous;
  let changed = false;
  const revision = previous.revision + 1;
  const items = previous.items.map((item) => {
    if (item.status !== "current" || !item.sourceMemoryIds.includes(input.previousMemoryId)) {
      return item;
    }
    changed = true;
    return Object.freeze({
      ...item,
      ...(item.basis === "observed_memory" ? {} : { text: input.replacementText }),
      sourceMemoryIds: Object.freeze(uniqueTail(item.sourceMemoryIds.map((memoryId) =>
        memoryId === input.previousMemoryId ? input.replacementMemoryId : memoryId
      ), 3)),
      revision,
      updatedAt: input.now
    });
  });
  if (!changed) return previous;

  const processedById = new Map<string, ProcessedProfileSource>();
  let reboundProcessed = false;
  for (const source of previous.processedSources) {
    if (source.memoryId === input.previousMemoryId) {
      reboundProcessed = true;
      processedById.set(input.replacementMemoryId, Object.freeze({
        ...source,
        memoryId: input.replacementMemoryId
      }));
    } else {
      processedById.set(source.memoryId, source);
    }
  }
  if (!reboundProcessed) {
    processedById.set(input.replacementMemoryId, Object.freeze({
      memoryId: input.replacementMemoryId,
      memoryRevision: input.previousMemoryRevision,
      processedAt: input.now
    }));
  }
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(boundProcessedSources([...processedById.values()], items)),
    deletionBarriers: previous.deletionBarriers ?? Object.freeze([]),
    legacyUserMigration: previous.legacyUserMigration,
    lastProjectedUserHash: previous.lastProjectedUserHash,
    updatedAt: input.now
  });
}

/**
 * Round 6 修复五：找出本轮以「更高 revision」重新处理的同一批 Memory
 * （与人格侧 computeReprocessedMemoryIds 同一判断标准）。
 */
export function computeReprocessedProfileMemoryIds(
  previous: UserProfileState,
  incoming: readonly Readonly<{ memoryId: string; memoryRevision: number }>[]
): ReadonlySet<string> {
  const previousRevisionById = new Map<string, number>(
    previous.processedSources.map((source) => [source.memoryId, source.memoryRevision])
  );
  const reprocessed = new Set<string>();
  for (const source of incoming) {
    const before = previousRevisionById.get(source.memoryId);
    if (before !== undefined && source.memoryRevision > before) reprocessed.add(source.memoryId);
  }
  return reprocessed;
}

/**
 * Round 6 修复五：在应用新一轮做梦输出之前，撤销旧 revision 画像项对该
 * Memory 的来源引用；来源清空则标记 superseded。纯函数；无撤销对象时
 * 返回原引用。与新一轮输出在同一事务内提交。
 */
export function revokeReprocessedProfileSources(
  previous: UserProfileState,
  reprocessedIds: ReadonlySet<string>,
  now: number
): UserProfileState {
  if (reprocessedIds.size === 0) return previous;
  let changed = false;
  const revision = previous.revision + 1;
  const items: UserProfileItem[] = [];
  for (const item of previous.items) {
    if (item.status !== "current"
      || !item.sourceMemoryIds.some((id) => reprocessedIds.has(id))) {
      items.push(item);
      continue;
    }
    changed = true;
    const alive = item.sourceMemoryIds.filter((id) => !reprocessedIds.has(id));
    if (alive.length === 0) {
      items.push(Object.freeze({
        ...item,
        status: "superseded" as const,
        sourceMemoryIds: Object.freeze([]),
        revision
      }));
    } else {
      items.push(Object.freeze({
        ...item,
        sourceMemoryIds: Object.freeze(alive),
        revision
      }));
    }
  }
  const processedSources = boundProcessedSources(previous.processedSources, items);
  if (processedSources.length !== previous.processedSources.length) changed = true;
  if (!changed) return previous;
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(processedSources),
    deletionBarriers: previous.deletionBarriers ?? Object.freeze([]),
    legacyUserMigration: previous.legacyUserMigration,
    lastProjectedUserHash: previous.lastProjectedUserHash,
    updatedAt: now
  });
}

/** Whether an observed profile item has earned the right to enter USER.md. */
export function isProfileItemRenderable(item: UserProfileItem): boolean {
  if (item.status !== "current") return false;
  const slot = profileSlotDefinition(item.profileKey);
  if (!slot || slot.section !== item.section || item.sourceMemoryIds.length === 0) return false;
  if (item.basis === "observed_memory") {
    return item.sourceMemoryIds.length >= USER_OBSERVED_MIN_SOURCES;
  }
  return true;
}

export function parseUserProfileState(raw: Record<string, unknown>): UserProfileState | null {
  if (raw.schema !== USER_PROFILE_STATE_SCHEMA) return null;
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision)) return null;
  const deletionBarriers: UserProfileDeletionBarrier[] = [];
  if (raw.deletionBarriers !== undefined) {
    if (!Array.isArray(raw.deletionBarriers) || raw.deletionBarriers.length > USER_PROFILE_SLOTS.length) return null;
    for (const value of raw.deletionBarriers) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const entry = value as Record<string, unknown>;
      if (!isUserProfileKey(entry.profileKey)
        || deletionBarriers.some((barrier) => barrier.profileKey === entry.profileKey)
        || typeof entry.memoryRevisionCutoff !== "number"
        || !Number.isSafeInteger(entry.memoryRevisionCutoff) || entry.memoryRevisionCutoff < 0
        || typeof entry.experienceOccurredAtCutoff !== "number"
        || !Number.isSafeInteger(entry.experienceOccurredAtCutoff) || entry.experienceOccurredAtCutoff < 0) return null;
      deletionBarriers.push(Object.freeze({
        profileKey: entry.profileKey,
        memoryRevisionCutoff: entry.memoryRevisionCutoff,
        experienceOccurredAtCutoff: entry.experienceOccurredAtCutoff
      }));
    }
  }
  const parsedItems = Array.isArray(raw.items)
    ? raw.items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => {
          const slot = profileSlotDefinition(typeof item.profileKey === "string" ? item.profileKey.trim() : "");
          if (!slot) return null;
          const text = typeof item.text === "string" ? item.text.trim() : "";
          if (!text || text.length > USER_PROFILE_ITEM_HARD_MAX_CHARS) return null;
          return Object.freeze({
          id: typeof item.id === "string" ? item.id : newCognitiveId("profile"),
          section: slot.section,
          profileKey: slot.profileKey,
          text,
          basis: item.basis === "observed_memory" || item.basis === "legacy_import"
            ? item.basis
            : "explicit_memory",
          status: item.status === "superseded" ? "superseded" as const : "current" as const,
          sourceMemoryIds: Object.freeze(
            Array.isArray(item.sourceMemoryIds)
              ? uniqueTail(item.sourceMemoryIds.filter((id): id is string => typeof id === "string"), 3)
              : []
          ),
          revision: typeof item.revision === "number" ? item.revision : 0,
          updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : undefined
          });
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  const itemBySlot = new Map<string, UserProfileItem>();
  for (const item of parsedItems) {
    const basisSlot = item.basis === "observed_memory" ? "observed" : "explicit";
    const slotKey = `${item.profileKey}\u0000${basisSlot}`;
    const existing = itemBySlot.get(slotKey);
    if (!existing || item.revision > existing.revision) itemBySlot.set(slotKey, item);
  }
  const items = [...itemBySlot.values()];
  const parsedProcessedSources = Array.isArray(raw.processedSources)
    ? raw.processedSources
        .filter((source): source is Record<string, unknown> =>
          Boolean(source) && typeof source === "object"
          && typeof (source as Record<string, unknown>).memoryId === "string"
          && typeof (source as Record<string, unknown>).memoryRevision === "number")
        .map((source) => Object.freeze({
          memoryId: source.memoryId as string,
          memoryRevision: source.memoryRevision as number,
          processedAt: typeof source.processedAt === "number" ? source.processedAt : 0
        }))
    : [];
  const processedSources = boundProcessedSources(parsedProcessedSources, items);
  const migration = raw.legacyUserMigration === "pending" || raw.legacyUserMigration === "done"
    ? raw.legacyUserMigration
    : null;
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision: raw.revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(processedSources),
    deletionBarriers: Object.freeze(deletionBarriers),
    legacyUserMigration: migration,
    lastProjectedUserHash: typeof raw.lastProjectedUserHash === "string" ? raw.lastProjectedUserHash : "",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
  });
}

function uniqueTail(values: readonly string[], limit: number): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique.slice(-limit);
}

function boundProcessedSources(
  processedSources: readonly ProcessedProfileSource[],
  items: readonly UserProfileItem[]
): ProcessedProfileSource[] {
  const referenced = new Set(items
    .filter((item) => item.status === "current")
    .flatMap((item) => item.sourceMemoryIds));
  return processedSources
    .filter((source) => referenced.has(source.memoryId))
    .sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

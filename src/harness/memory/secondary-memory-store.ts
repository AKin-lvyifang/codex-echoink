/**
 * secondary-memory-store.ts — 二级事实 (secondary facts) file store.
 *
 * 做梦 PRD §6.2：二级事实使用独立记录，存储在
 * `.echoink/shared-user/memory/secondary/<parent-id>/<secondary-id>.md`
 * （schema `echoink.memory-secondary.v1`）。绝不把二级事实塞进一级 Manifest。
 *
 * Lifecycle rules implemented here (做梦 PRD §9):
 * - 旧磁盘 confidence 数值仅作活动参考；命中增加、时间衰减不改变支持依据。
 * - 命中：hitCount += 1、lastHitAt = now、活动值最多 +0.05 至 1。
 * - 衰减：30 天保护期；每完整 30 天未命中活动值 *= 0.8；lastDecayAt 保证幂等。
 * - 活动值 < 0.1 的 llm_inferred 可自动禁用；user_edited_inference 永不自动禁用。
 */

import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopPath } from "../../platform/desktop-paths";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import {
  isSecondaryDisabledReason,
  SECONDARY_DECAY_FACTOR,
  SECONDARY_DECAY_GRACE_DAYS,
  SECONDARY_HIT_CONFIDENCE_STEP,
  SECONDARY_CONTENT_MAX_CHARS,
  SECONDARY_EVIDENCE_MAX_CHARS,
  SECONDARY_MATCH_TERM_MAX_CHARS,
  SECONDARY_MAX_MATCH_TERMS,
  SECONDARY_MAX_PER_PARENT,
  SECONDARY_MEMORY_SCHEMA,
  SECONDARY_MIN_CONFIDENCE,
  SECONDARY_REASON_MAX_CHARS,
  SECONDARY_RECALL_WHEN_MAX_CHARS,
  SECONDARY_TITLE_MAX_CHARS,
  isSecondaryRelation,
  isSecondarySupportLevel,
  type PersonalMemoryBasis,
  type SecondaryBasis,
  type SecondaryMemoryRecord,
  type SecondaryRelation,
  type SecondaryDisabledReason,
  type SecondarySupportLevel
} from "./personal-memory-contracts";
import { cognitiveAtomicWrite, cognitivePathExists, newCognitiveId } from "./cognitive-file-utils";

const { createHash } = getDesktopCrypto();


const path = getDesktopPath();
const { mkdir, readdir, readFile } = getDesktopFsPromises();

const MS_PER_DAY = 86_400_000;
const SAFE_SECONDARY_ID = /^[a-zA-Z0-9_-]{3,96}$/u;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const SECONDARY_MEMORY_DIRNAME = "secondary";

export function secondaryRelativePath(parentId: string, secondaryId: string): string {
  return path.posix.join("shared-user", "memory", SECONDARY_MEMORY_DIRNAME, parentId, `${secondaryId}.md`);
}

export interface AssociationClueFields {
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly reason: string;
  readonly supportLevel: SecondarySupportLevel;
  readonly evidence: string;
}

/** One schema normalizer shared by Dream, domain writes, disk and Settings UI. */
export function normalizeAssociationClueFields(
  input: Readonly<AssociationClueFields>
): AssociationClueFields {
  const title = requireClueText(input.title, "title", SECONDARY_TITLE_MAX_CHARS);
  const content = requireClueText(input.content, "content", SECONDARY_CONTENT_MAX_CHARS);
  const recallWhen = requireClueText(
    input.recallWhen,
    "recallWhen",
    SECONDARY_RECALL_WHEN_MAX_CHARS
  );
  const reason = requireClueText(input.reason, "reason", SECONDARY_REASON_MAX_CHARS, true);
  const evidence = requireClueText(input.evidence, "evidence", SECONDARY_EVIDENCE_MAX_CHARS);
  if (!isSecondaryRelation(input.relation)) throw new Error("association_clue_invalid:relation");
  if (!isSecondarySupportLevel(input.supportLevel)) {
    throw new Error("association_clue_invalid:supportLevel");
  }
  if (!Array.isArray(input.matchTerms)
    || input.matchTerms.length === 0
    || input.matchTerms.length > SECONDARY_MAX_MATCH_TERMS) {
    throw new Error("association_clue_invalid:matchTerms");
  }
  const matchTerms: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.matchTerms) {
    if (typeof raw !== "string") throw new Error("association_clue_invalid:matchTerms");
    const term = normalizeMatchTerm(raw);
    if (!term) throw new Error("association_clue_invalid:matchTerms");
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matchTerms.push(term);
  }
  if (matchTerms.length === 0) throw new Error("association_clue_invalid:matchTerms");
  return Object.freeze({
    title,
    content,
    recallWhen,
    matchTerms: Object.freeze(matchTerms),
    relation: input.relation,
    reason,
    supportLevel: input.supportLevel,
    evidence
  });
}

function requireClueText(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`association_clue_invalid:${name}`);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > max) {
    throw new Error(`association_clue_invalid:${name}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Markdown serialization (frontmatter style identical to primary records)
// ---------------------------------------------------------------------------

export function serializeSecondaryRecord(record: Readonly<SecondaryMemoryRecord>): string {
  const normalized = normalizeAssociationClueFields(record);
  const fields: Array<readonly [string, string | number | readonly string[] | null]> = [
    ["schema", record.schema],
    ["id", record.id],
    ["parent_id", record.parentId],
    ["status", record.status],
    ["disabled_reason", record.disabledReason],
    ["title", normalized.title],
    ["recall_when", normalized.recallWhen],
    ["match_terms", normalized.matchTerms],
    ["relation", normalized.relation],
    ["reason", normalized.reason],
    ["support_level", normalized.supportLevel],
    ["evidence", normalized.evidence],
    ["basis", record.basis],
    ["source_memory_revision", record.sourceMemoryRevision],
    ["confidence", record.confidence],
    ["hit_count", record.hitCount],
    ["last_hit_at", record.lastHitAt],
    ["last_decay_at", record.lastDecayAt],
    ["created_at", record.createdAt],
    ["updated_at", record.updatedAt],
    ["revision", record.revision]
  ];
  return [
    "---",
    ...fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
    normalized.content,
    ""
  ].join("\n");
}

class SecondaryOversizedRecordError extends Error {
  constructor(file: string) {
    super(`association_clue_oversized:${file}`);
    this.name = "SecondaryOversizedRecordError";
  }
}

class SecondaryIdentityError extends Error {
  constructor(message: string) {
    super(`association_clue_identity_invalid:${message}`);
    this.name = "SecondaryIdentityError";
  }
}

function assertSecondaryPathIdentity(
  record: SecondaryMemoryRecord,
  parentDirectory: string,
  fileId: string
): void {
  if (record.parentId !== parentDirectory || record.id !== fileId) {
    throw new SecondaryIdentityError(`${parentDirectory}/${fileId}`);
  }
}

function assertUniqueSecondaryIds(records: readonly SecondaryMemoryRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw new SecondaryIdentityError(`duplicate-id:${record.id}`);
    seen.add(record.id);
  }
}

export function parseSecondaryRecord(text: string, file: string): SecondaryMemoryRecord {
  return parseSecondaryRecordInternal(text, file, false).record;
}

function parseSecondaryRecordInternal(
  text: string,
  file: string,
  repairOversized: boolean
): { record: SecondaryMemoryRecord; repaired: boolean } {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") throw new Error(`Secondary record ${file} has no frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`Secondary record ${file} frontmatter is incomplete`);
  const fields = new Map<string, unknown>();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Secondary record ${file} frontmatter line is invalid`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      fields.set(key, JSON.parse(raw));
    } catch {
      throw new Error(`Secondary record ${file} frontmatter value is invalid`);
    }
  }
  let repaired = false;
  const requireString = (key: string, max: number, allowEmpty = false): string => {
    const value = fields.get(key);
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
      throw new Error(`Secondary record ${file} field ${key} is invalid`);
    }
    const normalized = value.trim();
    if (normalized.length <= max) return normalized;
    if (!repairOversized) throw new SecondaryOversizedRecordError(file);
    repaired = true;
    const shortened = normalized.slice(0, max).trim();
    if (!allowEmpty && !shortened) throw new Error(`Secondary record ${file} field ${key} is invalid`);
    return shortened;
  };
  const requireNumber = (key: string): number => {
    const value = fields.get(key);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Secondary record ${file} field ${key} is invalid`);
    }
    return value;
  };
  const nullableNumber = (key: string): number | null => {
    const value = fields.get(key);
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Secondary record ${file} field ${key} is invalid`);
    }
    return value;
  };
  const id = requireString("id", 96);
  const parentId = requireString("parent_id", 96);
  if (!SAFE_SECONDARY_ID.test(id) || !SAFE_SECONDARY_ID.test(parentId)) {
    throw new Error(`Secondary record ${file} id is unsafe`);
  }
  if (fields.get("schema") !== SECONDARY_MEMORY_SCHEMA) {
    throw new Error(`Secondary record ${file} schema is invalid`);
  }
  const statusValue = fields.get("status");
  if (statusValue !== "current" && statusValue !== "disabled") {
    throw new Error(`Secondary record ${file} status is invalid`);
  }
  const status = statusValue;
  const basisValue = fields.get("basis");
  if (basisValue !== "llm_inferred" && basisValue !== "user_edited_inference") {
    throw new Error(`Secondary record ${file} basis is invalid`);
  }
  const basis = basisValue;
  const relation = fields.get("relation");
  if (!isSecondaryRelation(relation)) throw new Error(`Secondary record ${file} relation is invalid`);
  const supportLevel = fields.get("support_level");
  if (!isSecondarySupportLevel(supportLevel)) {
    throw new Error(`Secondary record ${file} support_level is invalid`);
  }
  const title = requireString("title", SECONDARY_TITLE_MAX_CHARS);
  const recallWhen = requireString("recall_when", SECONDARY_RECALL_WHEN_MAX_CHARS);
  const reason = requireString("reason", SECONDARY_REASON_MAX_CHARS, true);
  const evidence = requireString("evidence", SECONDARY_EVIDENCE_MAX_CHARS);
  const rawContent = lines.slice(end + 1).join("\n").trim();
  if (!rawContent) throw new Error(`Secondary record ${file} content is invalid`);
  let content = rawContent;
  if (content.length > SECONDARY_CONTENT_MAX_CHARS) {
    if (!repairOversized) throw new SecondaryOversizedRecordError(file);
    repaired = true;
    content = content.slice(0, SECONDARY_CONTENT_MAX_CHARS).trim();
  }
  const matchTermsRaw = fields.get("match_terms");
  if (!Array.isArray(matchTermsRaw) || matchTermsRaw.length === 0) {
    throw new Error(`Secondary record ${file} match_terms is invalid`);
  }
  // Validate the complete raw array before any count/length repair. Otherwise
  // a damaged sixth value could be sliced away and the file rewritten as if
  // it only had a benign legacy overflow.
  for (const rawTerm of matchTermsRaw) {
    if (typeof rawTerm !== "string") {
      throw new Error(`Secondary record ${file} match_terms is invalid`);
    }
    const structural = rawTerm.normalize("NFKC").trim();
    if (!structural
      || /^\p{Script=Han}$/u.test(structural)
      || /^[\s\p{P}\p{S}]+$/u.test(structural)) {
      throw new Error(`Secondary record ${file} match_terms is invalid`);
    }
  }
  let rawTerms = matchTermsRaw;
  if (rawTerms.length > SECONDARY_MAX_MATCH_TERMS) {
    if (!repairOversized) throw new SecondaryOversizedRecordError(file);
    repaired = true;
    rawTerms = rawTerms.slice(0, SECONDARY_MAX_MATCH_TERMS);
  }
  const repairedTerms = rawTerms.map((term) => {
    if (typeof term !== "string" || !term.trim()) {
      throw new Error(`Secondary record ${file} match_terms is invalid`);
    }
    const normalized = term.trim();
    if (normalized.length <= SECONDARY_MATCH_TERM_MAX_CHARS) return normalized;
    if (!repairOversized) throw new SecondaryOversizedRecordError(file);
    repaired = true;
    return normalized.slice(0, SECONDARY_MATCH_TERM_MAX_CHARS).trim();
  });
  const normalizedFields = normalizeAssociationClueFields({
    title,
    content,
    recallWhen,
    matchTerms: repairedTerms,
    relation,
    reason,
    supportLevel,
    evidence
  });
  const confidence = requireNumber("confidence");
  const hitCount = requireNumber("hit_count");
  const sourceMemoryRevision = requireNumber("source_memory_revision");
  const revision = requireNumber("revision");
  if (confidence < 0 || confidence > 1
    || !Number.isSafeInteger(hitCount) || hitCount < 0
    || !Number.isSafeInteger(sourceMemoryRevision) || sourceMemoryRevision < 0
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Secondary record ${file} numeric fields are invalid`);
  }
  const disabledReasonValue = fields.get("disabled_reason");
  if (status === "disabled" && !isSecondaryDisabledReason(disabledReasonValue)) {
    throw new Error(`Secondary record ${file} disabled_reason is invalid`);
  }
  if (status === "current" && disabledReasonValue !== null) {
    throw new Error(`Secondary record ${file} disabled_reason is invalid`);
  }
  const record = Object.freeze({
    schema: SECONDARY_MEMORY_SCHEMA,
    id,
    parentId,
    status,
    disabledReason: status === "disabled"
      ? disabledReasonValue as SecondaryDisabledReason
      : null,
    ...normalizedFields,
    basis,
    sourceMemoryRevision,
    confidence,
    hitCount,
    lastHitAt: nullableNumber("last_hit_at"),
    lastDecayAt: nullableNumber("last_decay_at"),
    createdAt: requireNumber("created_at"),
    updatedAt: requireNumber("updated_at"),
    revision,
    file
  });
  return { record, repaired };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SecondaryMemoryStore {
  private readonly directory: string;
  private readonly backupDirectory: string;
  private cache: readonly SecondaryMemoryRecord[] | null = null;

  constructor(historyRoot: string) {
    this.directory = path.join(historyRoot, SECONDARY_MEMORY_DIRNAME);
    this.backupDirectory = path.join(
      path.dirname(historyRoot),
      ".runtime",
      "backups",
      "association-clues"
    );
  }

  get rootDirectory(): string {
    return this.directory;
  }

  /** Load (and cache) every secondary record on disk. Invalid files are skipped. */
  async loadAll(): Promise<readonly SecondaryMemoryRecord[]> {
    if (this.cache) return this.cache;
    const records: SecondaryMemoryRecord[] = [];
    if (await cognitivePathExists(this.directory)) {
      const parentEntries = await readdir(this.directory, { withFileTypes: true });
      for (const parentEntry of parentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!parentEntry.isDirectory()) continue;
        const parentDir = path.join(this.directory, parentEntry.name);
        const fileEntries = await readdir(parentDir, { withFileTypes: true });
        for (const fileEntry of fileEntries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".md")) continue;
          const target = path.join(parentDir, fileEntry.name);
          const fileId = fileEntry.name.replace(/\.md$/u, "");
          const relative = secondaryRelativePath(parentEntry.name, fileId);
          let text = "";
          let originalBytes: Uint8Array | null = null;
          try {
            originalBytes = await readFile(target);
            text = FATAL_UTF8_DECODER.decode(originalBytes);
            const record = parseSecondaryRecord(text, relative);
            assertSecondaryPathIdentity(record, parentEntry.name, fileId);
            records.push(record);
          } catch (error) {
            if (error instanceof SecondaryIdentityError) throw error;
            if (error instanceof SecondaryOversizedRecordError) {
              try {
                const repaired = parseSecondaryRecordInternal(text, relative, true);
                if (!repaired.repaired) throw error;
                assertSecondaryPathIdentity(repaired.record, parentEntry.name, fileId);
                if (!originalBytes) throw error;
                const hash = createHash("sha256").update(originalBytes).digest("hex").slice(0, 16);
                const backup = path.join(
                  this.backupDirectory,
                  `${repaired.record.parentId}-${repaired.record.id}-${hash}.md`
                );
                // Backup must durably land before deterministic replacement.
                await cognitiveAtomicWrite(backup, originalBytes);
                await cognitiveAtomicWrite(target, serializeSecondaryRecord(repaired.record));
                records.push(repaired.record);
              } catch (repairError) {
                if (repairError instanceof SecondaryIdentityError) throw repairError;
                // Structural damage is never guessed, rewritten or deleted.
              }
            }
            // A structurally damaged clue never blocks primary Memory and its
            // original file remains untouched.
          }
        }
      }
    }
    records.sort((left, right) => left.parentId.localeCompare(right.parentId) || left.id.localeCompare(right.id));
    assertUniqueSecondaryIds(records);
    this.cache = Object.freeze(records);
    return this.cache;
  }

  /** Refresh the cache from disk. */
  async refresh(): Promise<readonly SecondaryMemoryRecord[]> {
    this.cache = null;
    return await this.loadAll();
  }

  /** Update the in-memory cache after a transaction committed new files. */
  setCache(records: readonly SecondaryMemoryRecord[]): void {
    assertUniqueSecondaryIds(records);
    this.cache = Object.freeze([...records].sort(
      (left, right) => left.parentId.localeCompare(right.parentId) || left.id.localeCompare(right.id)
    ));
  }

  async listForParent(parentId: string): Promise<readonly SecondaryMemoryRecord[]> {
    const all = await this.loadAll();
    return all.filter((record) => record.parentId === parentId);
  }

  async ensureDirectory(parentId: string): Promise<string> {
    const target = path.join(this.directory, parentId);
    await mkdir(target, { recursive: true });
    return target;
  }

  absolutePathFor(relativePath: string): string {
    return path.join(this.directory, "..", "..", relativePath);
  }
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

export interface NewSecondaryFactInput {
  readonly parentId: string;
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly reason: string;
  readonly basis: SecondaryBasis;
  /** 新记录的初始活动参考值；沿用旧磁盘 confidence 键。 */
  readonly confidence: number;
  readonly supportLevel: SecondarySupportLevel;
  readonly evidence: string;
  readonly sourceMemoryRevision: number;
  readonly now: number;
  readonly idFactory?: () => string;
}

/** Normalize a match term; returns null when unusable (single CJK char etc.). */
export function normalizeMatchTerm(raw: string): string | null {
  const term = raw.normalize("NFKC").trim();
  if (!term || term.length > SECONDARY_MATCH_TERM_MAX_CHARS) return null;
  // 单个汉字不能独立作为匹配词（做梦 PRD §8.2）。
  if (/^\p{Script=Han}$/u.test(term)) return null;
  if (/^[\s\p{P}\p{S}]+$/u.test(term)) return null;
  return term;
}

export function createSecondaryRecord(input: NewSecondaryFactInput): SecondaryMemoryRecord {
  const makeId = input.idFactory ?? (() => newCognitiveId("sec"));
  const id = makeId();
  if (!SAFE_SECONDARY_ID.test(id) || !SAFE_SECONDARY_ID.test(input.parentId)) {
    throw new Error("association_clue_invalid:id");
  }
  const fields = normalizeAssociationClueFields(input);
  return Object.freeze({
    schema: SECONDARY_MEMORY_SCHEMA,
    id,
    parentId: input.parentId,
    status: "current",
    disabledReason: null,
    title: fields.title,
    content: fields.content,
    recallWhen: fields.recallWhen,
    matchTerms: fields.matchTerms,
    relation: fields.relation,
    reason: fields.reason,
    supportLevel: fields.supportLevel,
    evidence: fields.evidence,
    basis: input.basis,
    sourceMemoryRevision: input.sourceMemoryRevision,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    hitCount: 0,
    lastHitAt: null,
    lastDecayAt: null,
    createdAt: input.now,
    updatedAt: input.now,
    revision: 1,
    file: secondaryRelativePath(input.parentId, id)
  });
}

// ---------------------------------------------------------------------------
// Candidate pipeline: 候选生成 → 字段验证 → 支持评分 → 去重 → 多样性选择
// → 动态落盘（做梦 PRD 最新决定；8 条是硬上限，不是生成目标）
// ---------------------------------------------------------------------------

/** supportLevel 基础分（不用 LLM 自评数字）。 */
export const SECONDARY_SUPPORT_BASE_SCORE: Readonly<Record<SecondarySupportLevel, number>> = Object.freeze({
  direct: 0.85,
  strong_inference: 0.70,
  weak_inference: 0.45
});

/** 一级 Memory basis 系数。 */
export const SECONDARY_BASIS_WEIGHT: Readonly<Record<PersonalMemoryBasis, number>> = Object.freeze({
  explicit: 1.00,
  observed: 0.90,
  inferred: 0.75
});

/** relation 调整项。 */
export const SECONDARY_RELATION_ADJUSTMENT: Readonly<Record<SecondaryRelation, number>> = Object.freeze({
  category: 0,
  instance: 0,
  attribute: -0.05,
  context: -0.05,
  associated: -0.15
});

/** 兼容旧导出名：新候选支持准入与已存记录活动保留沿用现有阈值。 */
export const SECONDARY_CONFIDENCE_THRESHOLD = 0.60 as const;
/** 同一 relation 最多保留的 current 二级事实数。 */
export const SECONDARY_MAX_PER_RELATION = 2 as const;

/**
 * 依据现有支持等级、父 basis 和关系计算当前支持分；不是最初支持分的恢复，
 * 也不是真实概率。候选准入/取舍不使用命中和衰减后的活动数值。
 */
export function computeSecondarySupportScore(
  supportLevel: SecondarySupportLevel,
  parentBasis: PersonalMemoryBasis,
  relation: SecondaryRelation
): number {
  const score = SECONDARY_SUPPORT_BASE_SCORE[supportLevel]
    * SECONDARY_BASIS_WEIGHT[parentBasis]
    + SECONDARY_RELATION_ADJUSTMENT[relation];
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

/** Compatibility export for callers of the former support-calculation name. */
export const computeSecondaryConfidence = computeSecondarySupportScore;

function currentSecondarySupportScore(
  record: SecondaryMemoryRecord,
  parentBasis: PersonalMemoryBasis
): number | null {
  if (!isSecondarySupportLevel(record.supportLevel) || !isSecondaryRelation(record.relation)
    || typeof record.evidence !== "string" || !record.evidence.trim()
    || !Number.isSafeInteger(record.sourceMemoryRevision) || record.sourceMemoryRevision < 0) {
    return null;
  }
  const score = computeSecondarySupportScore(record.supportLevel, parentBasis, record.relation);
  return Number.isFinite(score) ? score : null;
}

/** 语义身份指纹：规范化 title + 排序后的匹配词（content 允许重新表述）。 */
export function secondaryFingerprint(title: string, matchTerms: readonly string[]): string {
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase().trim();
  const normalizedTerms = matchTerms
    .map((term) => term.normalize("NFKC").toLocaleLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join("|");
  return createHash("sha256").update(`${normalizedTitle}\n${normalizedTerms}`).digest("hex");
}

export interface SecondaryFactCandidate {
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly supportLevel: SecondarySupportLevel;
  readonly reason: string;
  readonly evidence: string;
}

export interface SecondaryReconcileInput {
  readonly parentId: string;
  readonly parentBasis: PersonalMemoryBasis;
  readonly parentRevision: number;
  /** 该父节点名下全部二级记录（含 disabled）。 */
  readonly existing: readonly SecondaryMemoryRecord[];
  /** 本轮通过字段验证的临时候选（尚未落盘）。 */
  readonly candidates: readonly SecondaryFactCandidate[];
  readonly now: number;
  readonly idFactory?: () => string;
}

export interface SecondaryReconcileResult {
  /** 该父节点名下全部最终记录（含未改动的 disabled 历史）。 */
  readonly records: readonly SecondaryMemoryRecord[];
  /** 需要写盘的二级文件（新建 / 复用更新 / 停用）。 */
  readonly fileChanges: readonly Readonly<{ relativePath: string; content: string }>[];
  readonly factsCreated: number;
  readonly factsReused: number;
  readonly factsRetired: number;
}

/**
 * 父 Memory 做梦（含重新做梦）的统一 dedupe + reconcile：
 *
 * 1. user_edited_inference 永远保留、不参与衰减、不因做梦被覆盖，也不因总数
 *    超限被删除；但它们占用 relation 配额与总数预算，并预留自己的宽 key alias；
 * 2. 本轮候选只按支持元数据重新评分筛选；
 * 3. 一个旧 llm_inferred record 一轮内只能被消费一次（consumedOldIds）：
 *    无论原样保留、fingerprint 复用还是宽 key 原地替换，消费时删除旧记录
 *    自身的全部查找入口，并预留旧记录与候选各自的 title/terms 四组 alias；
 * 4. 最终预算统一核算：userEdited → keptOld → 新候选依次占用总数与
 *    relation 配额，禁止先选满新候选再追加 keptOld；
 * 5. 入选结果替换旧 llm_inferred：fingerprint 相同复用旧 ID、hitCount、
 *    lastHitAt 与历史活动值；宽 key 替换同样保留活动，不以支持分重置；
 *    revision 只增加一次；
 * 6. 不再入选的旧 llm_inferred 标记 disabled；finalRecords 保证唯一 ID；
 * 7. 最终 current 集合满足：阈值、relation 多样性、每 relation ≤2、
 *    硬上限 SECONDARY_MAX_PER_PARENT（10）条。禁止 append。
 */
export function reconcileSecondaryForParent(
  input: SecondaryReconcileInput
): SecondaryReconcileResult {
  const makeId = input.idFactory ?? (() => newCognitiveId("sec"));
  const fileChanges: Array<{ relativePath: string; content: string }> = [];

  const userEdited = input.existing.filter(
    (record) => record.basis === "user_edited_inference" && record.status === "current"
  );
  const oldLlm = input.existing.filter(
    (record) => record.basis === "llm_inferred" && record.status === "current"
  );
  const untouched = input.existing.filter(
    (record) => record.status !== "current"
      || (record.basis !== "llm_inferred" && record.basis !== "user_edited_inference")
  );

  // --- 1. Support admission -----------------------------------------------
  const scored = input.candidates
    .filter((candidate) => candidate.title.trim() && candidate.content.trim()
      && candidate.evidence.trim() && candidate.matchTerms.length > 0)
    .map((candidate) => ({
      candidate,
      supportScore: computeSecondarySupportScore(
        candidate.supportLevel, input.parentBasis, candidate.relation
      )
    }))
    .filter((entry) => entry.supportScore >= SECONDARY_CONFIDENCE_THRESHOLD);

  // --- 2. Dedupe（有界本地去重，不做 embedding）：同一父节点内，标题相同
  //    或非空匹配词集合相同即视为重复，保留当前支持分更高的一条；与
  //    user_edited_inference 冲突时始终保留用户编辑版本，丢弃 LLM 候选。
  const normalizeTitleKey = (value: string): string =>
    value.normalize("NFKC").toLocaleLowerCase().trim();
  const normalizeTermSetKey = (terms: readonly string[]): string => {
    const normalized = terms
      .map((term) => normalizeMatchTerm(term))
      .filter((term): term is string => term !== null)
      .map((term) => term.normalize("NFKC").toLocaleLowerCase())
      .sort();
    return [...new Set(normalized)].join("|");
  };
  const userTitleKeys = new Set(userEdited.map((record) => normalizeTitleKey(record.title)));
  const userTermKeys = new Set(
    userEdited.map((record) => normalizeTermSetKey(record.matchTerms)).filter((key) => key.length > 0)
  );
  // 既有 llm 事实也按宽 key 参与去重：每个 key 只对应一条旧记录。
  const oldLlmByTitleKey = new Map<string, SecondaryMemoryRecord>();
  const oldLlmByTermKey = new Map<string, SecondaryMemoryRecord>();
  for (const record of oldLlm) {
    const titleKey = normalizeTitleKey(record.title);
    if (titleKey && !oldLlmByTitleKey.has(titleKey)) oldLlmByTitleKey.set(titleKey, record);
    const termKey = normalizeTermSetKey(record.matchTerms);
    if (termKey && !oldLlmByTermKey.has(termKey)) oldLlmByTermKey.set(termKey, record);
  }
  // Round 6.1 修复一：一个旧 record 一轮内只能被消费一次。消费时删除旧记录
  // 自己的全部查找入口（而不是只删当前候选的 key），并把旧记录与候选各自的
  // title/terms 四组 alias 全部预留，封闭交叉别名路径。
  const consumedOldIds = new Set<string>();
  const keptOldOrder: SecondaryMemoryRecord[] = [];
  const deduped: typeof scored = [];
  const keptTitleKeys = new Set<string>();
  const keptTermKeys = new Set<string>();
  const reserveAlias = (titleKey: string, termKey: string): void => {
    if (titleKey) keptTitleKeys.add(titleKey);
    if (termKey) keptTermKeys.add(termKey);
  };
  const consumeOldRecord = (oldRecord: SecondaryMemoryRecord, entry: typeof scored[number]): void => {
    // 已被消费的旧记录绝不再参与本轮任何匹配/计数（防御性幂等）。
    if (consumedOldIds.has(oldRecord.id)) return;
    consumedOldIds.add(oldRecord.id);
    const oldTitleKey = normalizeTitleKey(oldRecord.title);
    if (oldTitleKey) oldLlmByTitleKey.delete(oldTitleKey);
    const oldTermKey = normalizeTermSetKey(oldRecord.matchTerms);
    if (oldTermKey) oldLlmByTermKey.delete(oldTermKey);
    reserveAlias(oldTitleKey, oldTermKey);
    reserveAlias(
      normalizeTitleKey(entry.candidate.title),
      normalizeTermSetKey(entry.candidate.matchTerms)
    );
  };
  // Round 6 修复六（问题 2）：宽 key 命中且候选支持更高时，记录
  // 「候选 → 被替换旧记录」，第 4 步做原地更新（保留旧 ID 与命中历史），
  // 不再走 retire+新建。
  const wideKeyReplacement = new Map<typeof scored[number], SecondaryMemoryRecord>();
  for (const entry of scored.sort((left, right) => right.supportScore - left.supportScore)) {
    const titleKey = normalizeTitleKey(entry.candidate.title);
    const termKey = normalizeTermSetKey(entry.candidate.matchTerms);
    // 与 user_edited_inference 冲突：始终保留用户编辑版本。
    if (userTitleKeys.has(titleKey)) continue;
    if (termKey && userTermKeys.has(termKey)) continue;
    // 任一已预留 alias（含已消费旧记录与候选带来的交叉别名）→ 不再新建。
    if (keptTitleKeys.has(titleKey)) continue;
    if (termKey && keptTermKeys.has(termKey)) continue;
    const oldMatch = (titleKey ? oldLlmByTitleKey.get(titleKey) : undefined)
      ?? (termKey ? oldLlmByTermKey.get(termKey) : undefined);
    if (oldMatch) {
      const oldSupport = currentSecondarySupportScore(oldMatch, input.parentBasis);
      if (oldSupport !== null && oldSupport >= entry.supportScore) {
        // 已知支持不低于候选：原样保留旧记录；未知不能拿活动值补支持。
        // （ID / hitCount / lastHitAt 不变，不重复写盘），丢弃候选。
        consumeOldRecord(oldMatch, entry);
        keptOldOrder.push(oldMatch);
        continue;
      }
      // 候选支持更高或旧支持未知：原地替换，保留旧 ID 和全部活动历史。
      consumeOldRecord(oldMatch, entry);
      wideKeyReplacement.set(entry, oldMatch);
    }
    reserveAlias(titleKey, termKey);
    deduped.push(entry);
  }

  // --- 3. 统一预算：userEdited → keptOld → 新候选依次占用总数与 relation
  //    配额（Round 6.1 修复一问题 C：keptOld 不得在选择结束后无条件追加）。
  const relationCount = new Map<SecondaryRelation, number>();
  for (const record of userEdited) {
    relationCount.set(record.relation, (relationCount.get(record.relation) ?? 0) + 1);
  }
  let slots = SECONDARY_MAX_PER_PARENT - userEdited.length;
  const acceptedKeptOld: SecondaryMemoryRecord[] = [];
  for (const record of keptOldOrder) {
    if (slots <= 0) continue;
    const count = relationCount.get(record.relation) ?? 0;
    if (count >= SECONDARY_MAX_PER_RELATION) continue;
    relationCount.set(record.relation, count + 1);
    slots -= 1;
    acceptedKeptOld.push(record);
  }
  // Diversity: one best per relation first, then fill by support score.
  const selected: typeof scored = [];
  const picked = new Set<typeof scored[number]>();
  const tryTake = (entry: typeof scored[number]): boolean => {
    if (slots <= 0) return false;
    const count = relationCount.get(entry.candidate.relation) ?? 0;
    if (count >= SECONDARY_MAX_PER_RELATION) return false;
    relationCount.set(entry.candidate.relation, count + 1);
    slots -= 1;
    selected.push(entry);
    picked.add(entry);
    return true;
  };
  const relationsInOrder: SecondaryRelation[] = [];
  for (const entry of deduped) {
    if (!relationsInOrder.includes(entry.candidate.relation)) {
      relationsInOrder.push(entry.candidate.relation);
    }
  }
  for (const relation of relationsInOrder) {
    const best = deduped.find((entry) => entry.candidate.relation === relation && !picked.has(entry));
    if (best) tryTake(best);
  }
  for (const entry of deduped) {
    if (!picked.has(entry)) tryTake(entry);
  }

  // --- 4. Apply：入选候选落为最终记录；旧记录只按本轮唯一消费结果处置 -----
  // Round 6.1 修复一：finalRecords 通过 seenFinalIds 保证同一 ID 最多出现一次；
  // reusedIds（含 acceptedKeptOld）与 consumedOldIds 口径一致。
  const finalRecords: SecondaryMemoryRecord[] = [];
  const seenFinalIds = new Set<string>();
  const addFinal = (record: SecondaryMemoryRecord): void => {
    if (seenFinalIds.has(record.id)) return;
    seenFinalIds.add(record.id);
    finalRecords.push(record);
  };
  for (const record of userEdited) addFinal(record);
  for (const record of untouched) addFinal(record);

  let factsCreated = 0;
  let factsReused = 0;
  let factsRetired = 0;
  const reusedIds = new Set<string>();
  for (const entry of selected) {
    // 宽 key 替换目标就是该候选在去重阶段唯一消费的旧记录：
    // fingerprint 相等或仅宽 key 相等都保留旧活动值；新的支持描述不能
    // 重置使用历史，更不能把支持分重新写成活动值。
    // 两者都保留旧 ID / file / hitCount / lastHitAt / createdAt，revision 只 +1，
    // 绝不 retire+新建（新建会丢失全部命中历史）。
    const replaced = wideKeyReplacement.get(entry);
    if (replaced) {
      const fields = normalizeAssociationClueFields(entry.candidate);
      const updated: SecondaryMemoryRecord = Object.freeze({
        ...replaced,
        ...fields,
        sourceMemoryRevision: input.parentRevision,
        updatedAt: input.now,
        revision: replaced.revision + 1
      });
      reusedIds.add(replaced.id);
      addFinal(updated);
      fileChanges.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) });
      factsReused += 1;
      continue;
    }
    const created = createSecondaryRecord({
      parentId: input.parentId,
      title: entry.candidate.title,
      content: entry.candidate.content,
      recallWhen: entry.candidate.recallWhen,
      matchTerms: entry.candidate.matchTerms,
      relation: entry.candidate.relation,
      reason: entry.candidate.reason,
      basis: "llm_inferred",
      confidence: entry.supportScore,
      supportLevel: entry.candidate.supportLevel,
      evidence: entry.candidate.evidence,
      sourceMemoryRevision: input.parentRevision,
      now: input.now,
      idFactory: makeId
    });
    addFinal(created);
    fileChanges.push({ relativePath: created.file, content: serializeSecondaryRecord(created) });
    factsCreated += 1;
  }
  // 去重保留且被预算接受的既有事实：原样留在最终集合中（无文件变更）。
  for (const record of acceptedKeptOld) {
    reusedIds.add(record.id);
    addFinal(record);
    factsReused += 1;
  }
  // 其余旧 llm 记录（未入选、未被预算接受、超出预算）→ retire。
  for (const record of oldLlm) {
    if (reusedIds.has(record.id)) continue;
    const retired: SecondaryMemoryRecord = Object.freeze({
      ...record,
      status: "disabled",
      disabledReason: "redream_replaced",
      updatedAt: input.now,
      revision: record.revision + 1
    });
    addFinal(retired);
    fileChanges.push({ relativePath: retired.file, content: serializeSecondaryRecord(retired) });
    factsRetired += 1;
  }

  finalRecords.sort(
    (left, right) => left.id.localeCompare(right.id)
  );
  return Object.freeze({
    records: Object.freeze(finalRecords),
    fileChanges: Object.freeze(fileChanges),
    factsCreated,
    factsReused,
    factsRetired
  });
}

// ---------------------------------------------------------------------------
// Hit-driven lifecycle (做梦 PRD §9)
// ---------------------------------------------------------------------------

export function applySecondaryHit(
  record: SecondaryMemoryRecord,
  now: number
): SecondaryMemoryRecord {
  return Object.freeze({
    ...record,
    hitCount: record.hitCount + 1,
    lastHitAt: now,
    confidence: Math.min(1, record.confidence + SECONDARY_HIT_CONFIDENCE_STEP),
    updatedAt: now,
    revision: record.revision + 1
  });
}

export interface SecondaryDecayResult {
  readonly record: SecondaryMemoryRecord;
  readonly decayed: boolean;
  readonly autoDisabled: boolean;
}

/**
 * Idempotent decay. A full 30-day no-hit period decays once and advances
 * lastDecayAt; running again inside the same period (e.g. day 31 right after
 * day 30) does NOT decay twice.
 */
/**
 * 已存线索继续按旧活动值保留：低于现有 0.60 门槛退出索引，不重筛其支持。
 * 退出召回不改变支持描述、历史文件或依据。
 */
export function indexableSecondaryRecords(
  records: readonly SecondaryMemoryRecord[]
): readonly SecondaryMemoryRecord[] {
  return records.filter(
    (record) => record.status === "current"
      // 用户主动修改过的事实持续参与索引，不再被低活动阈值移出；
      // 只有删除或父 Memory 生命周期失效才停止召回。
      && (record.basis === "user_edited_inference" || record.confidence >= SECONDARY_CONFIDENCE_THRESHOLD)
  );
}

export function applySecondaryDecay(
  record: SecondaryMemoryRecord,
  now: number
): SecondaryDecayResult {
  if (record.status !== "current") {
    return { record, decayed: false, autoDisabled: false };
  }
  // 用户编辑过的事实不再自动衰减（做梦 PRD §11 / 低置信召回修复）。
  if (record.basis === "user_edited_inference") {
    return { record, decayed: false, autoDisabled: false };
  }
  const graceMs = SECONDARY_DECAY_GRACE_DAYS * MS_PER_DAY;
  const anchor = Math.max(
    record.lastHitAt ?? record.createdAt,
    record.lastDecayAt ?? 0,
    record.createdAt
  );
  const elapsed = now - anchor;
  if (elapsed < graceMs) return { record, decayed: false, autoDisabled: false };
  const periods = Math.floor(elapsed / graceMs);
  const activityScore = Math.max(0, record.confidence * Math.pow(SECONDARY_DECAY_FACTOR, periods));
  // 真正发生衰减才 revision +1；跨多个周期一次计算也只算一次持久化变更，
  // 自动 disabled 与衰减在同一次 revision 变化中完成。
  let next: SecondaryMemoryRecord = Object.freeze({
    ...record,
    confidence: activityScore,
    lastDecayAt: anchor + periods * graceMs,
    updatedAt: now,
    revision: record.revision + 1
  });
  let autoDisabled = false;
  if (next.basis === "llm_inferred" && next.confidence < SECONDARY_MIN_CONFIDENCE) {
    next = Object.freeze({ ...next, status: "disabled", disabledReason: "low_confidence" });
    autoDisabled = true;
  }
  return { record: next, decayed: true, autoDisabled };
}

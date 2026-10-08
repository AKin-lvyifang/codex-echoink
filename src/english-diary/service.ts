import { requireProPlugin, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import { randomUUID } from "node:crypto";
import { DiaryServiceError, fingerprint, normalizePrivacy, splitDiaryBlocks } from "./model";
import { buildDiaryPrompt, parseDiaryGeneration } from "./prompt";
import type {
  DiaryGenerator, DiaryPrivacy, DiaryRecord, DiaryRepository, DiaryResult,
  DiarySource, EnglishDiaryApi, GenerateDiaryOptions
} from "./types";

interface ActiveGeneration { controller: AbortController; promise: Promise<DiaryRecord> }
const MAX_SOURCE_LENGTH = 60_000;

function fail(code: string, message: string): never { throw new DiaryServiceError(code, message); }
function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) fail("english_diary_cancelled", "已取消，本次结果不会发布。");
}

export class EnglishDiaryService implements EnglishDiaryApi {
  private readonly active = new Map<string, ActiveGeneration>();
  constructor(
    readonly repository: DiaryRepository,
    private readonly generator: DiaryGenerator,
    readonly readSource: (path: string) => Promise<DiarySource>,
    readonly access: CapabilityAccess = unavailableCapabilityAccess
  ) {}

  async load(path: string): Promise<DiaryRecord> {
    return await this.repository.get(await this.readSource(path));
  }

  isGenerating(path: string): boolean { return this.active.has(path); }
  cancel(path: string): void {
    this.active.get(path)?.controller.abort();
  }
  cancelAll(): void {
    for (const operation of this.active.values()) operation.controller.abort();
  }

  generate(path: string, options: GenerateDiaryOptions = {}): Promise<DiaryRecord> {
    const existing = this.active.get(path);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const operation: ActiveGeneration = { controller, promise: Promise.resolve(null as unknown as DiaryRecord) };
    operation.promise = Promise.resolve().then(() => this.runGeneration(path, options, controller.signal)).finally(() => {
      options.signal?.removeEventListener("abort", cancel);
      if (this.active.get(path) === operation) this.active.delete(path);
    });
    this.active.set(path, operation);
    return operation.promise;
  }

  private async runGeneration(path: string, options: GenerateDiaryOptions, signal: AbortSignal): Promise<DiaryRecord> {
    assertActive(signal);
    const source = await this.readSource(path), sourceHash = fingerprint(source.content);
    let record = await this.repository.get(source);
    assertActive(signal);
    // Reuse precedes all Provider/Skill requirements, even when the user changed
    // model preferences or manually edited the already-published English file.
    if (record.result?.sourceFingerprint === sourceHash && record.pending?.sourceFingerprint !== sourceHash) {
      if (!record.missingEnglish) return record;
      options.onStage?.("restoring");
      return await this.repository.restore(record);
    }
    if (!source.content.trim()) fail("english_diary_empty", "请先写下日记内容。");
    const sourceUnchanged = async () => {
      if (signal.aborted) return false;
      try { return fingerprint((await this.readSource(path)).content) === sourceHash && !signal.aborted; }
      catch { return false; }
    };
    const assertSource = async () => {
      assertActive(signal);
      const unchanged = await sourceUnchanged();
      assertActive(signal);
      if (!unchanged) fail("english_diary_source_changed", "原稿已变化，已保留此前结果，请确认新原稿后再更新。");
    };
    this.assertOverwrite(record, options);
    const blocks = splitDiaryBlocks(source.content);
    const privacy = normalizePrivacy(blocks, sourceHash, options.privacy ?? record.privacy);
    const permitted = new Set(privacy.rules.filter((rule) => rule.mode !== "exclude").map((rule) => rule.blockId));
    if (blocks.filter((block) => permitted.has(block.id)).reduce((length, block) => length + block.text.length, 0) > MAX_SOURCE_LENGTH) {
      fail("english_diary_content_too_long", "允许发送的内容较长，请缩小本次处理范围后再生成；不会自动截断。");
    }
    record = { ...record, privacy };
    await assertSource();
    if (record.pending?.sourceFingerprint === sourceHash) {
      options.onStage?.("restoring");
      return await this.repository.publish(record, record.pending, { overwriteModified: options.overwriteModified, signal, sourceUnchanged });
    }
    requireProPlugin(this.access);
    this.access.requireCapability("diary.explanation.generate");
    await this.repository.savePrivacy(record, privacy);
    const translatable = new Set(privacy.rules.filter((rule) => rule.mode === "translate").map((rule) => rule.blockId));
    const operationId = randomUUID();
    const expressionPermit = this.repository.acquireExpressionPermit?.(operationId);
    let pro = false;
    let parsed: ReturnType<typeof parseDiaryGeneration>;
    let provider = "";
    if (blocks.some((block) => translatable.has(block.id))) {
      options.onStage?.("generating");
      const skill = await this.generator.skill();
      await assertSource();
      requireProPlugin(this.access);
      this.access.requireCapability("diary.explanation.generate");
      this.access.requireCapability("diary.expression.write");
      pro = true;
      const prompt = buildDiaryPrompt(blocks, privacy, skill, pro);
      provider = this.generator.providerLabel();
      const output = await this.generator.generate({ ...prompt, signal });
      await assertSource();
      parsed = parseDiaryGeneration(output, source.content, blocks, privacy, pro);
    } else {
      parsed = { english: source.content, alignments: [], expressions: [], warnings: ["本篇没有允许改写的段落，已保留原文；未调用模型。"] };
    }
    await assertSource();
    const result: DiaryResult = {
      schema: 1, operationId, journalId: record.id,
      sourcePath: source.path, sourceTitle: source.title, date: source.date,
      sourceFingerprint: sourceHash, ...parsed, englishFingerprint: fingerprint(parsed.english),
      generatedAt: new Date().toISOString(), provider
    };
    options.onStage?.("saving");
    return await this.repository.publish(record, result, { expressionPermit, overwriteModified: options.overwriteModified, signal, sourceUnchanged });
  }

  private assertOverwrite(record: DiaryRecord, options: GenerateDiaryOptions): void {
    if (options.overwriteModified && (options.expectedEnglishFingerprint === undefined || options.expectedEnglishFingerprint !== record.observedFileFingerprint)) {
      fail("english_diary_overwrite_required", "英文稿在确认后又发生变化，请重新查看并确认替换。");
    }
    if (record.englishModified && !options.overwriteModified) fail("english_diary_overwrite_required", "英文稿有手工修改，请确认替换后再更新。");
  }

  async savePrivacy(path: string, privacy: DiaryPrivacy): Promise<void> {
    requireProPlugin(this.access);
    this.cancel(path);
    const source = await this.readSource(path), sourceHash = fingerprint(source.content);
    if (privacy.sourceFingerprint !== sourceHash) fail("english_diary_privacy_review_required", "原稿已变化，请重新确认发送范围。");
    const normalized = normalizePrivacy(splitDiaryBlocks(source.content), sourceHash, privacy);
    await this.repository.savePrivacy(await this.repository.get(source), normalized);
  }

  async restore(path: string): Promise<DiaryRecord> {
    const running = this.active.get(path);
    this.cancel(path);
    if (running) await running.promise.catch(() => undefined);
    const record = await this.load(path);
    if (record.pending) return await this.generate(path);
    if (!record.result) fail("english_diary_result_missing", "没有可恢复的成功结果，请先生成英文。");
    if (record.englishModified) fail("english_diary_overwrite_required", "英文稿有手工修改，不能直接恢复覆盖。");
    return await this.repository.restore(record);
  }

}

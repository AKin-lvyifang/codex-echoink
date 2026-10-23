import { isUnknownArray } from "../utils/unknown-array";
import { maintenanceInspection, type MaintenanceInspectionView } from "./maintenance-p2-receipt";
import { Phase3MaintenanceError } from "./phase3-maintenance-service";
import { extractMachineSourceMarkers } from "./knowledge-maintenance-protocol";
import { createHash } from "node:crypto";
import type { PiKnowledgeMaintenanceToolInput, PiKnowledgeMaintenanceToolResult } from "../harness/pi-native/contracts";
import type { KnowledgeMaintenanceRecord } from "./maintenance-record";
import type { MaintenanceP1State, MaintenanceSectionSnapshot, MaintenanceSourceFields, MaintenanceWritingItem } from "./maintenance-p1-contract";
import { createKnowledgeMaintenanceResultEnvelope, knowledgeMaintenanceNoteFromReadback } from "./knowledge-maintenance-result";
import { createMaintenanceSectionSnapshot, applyMaintenanceSectionPatches, appendMaintenanceBlock, appendMaintenanceManagedBlock, assertMaintenanceQuoteSectionsPreserved } from "./maintenance-section-patch";
import { appendMaintenanceAliases, maintenancePageTitle } from "./maintenance-page-metadata";
import { boundedMaintenanceMessage, throwMaintenanceDiagnostics } from "./maintenance-diagnostics";
import { patchMaintenanceSourceFrontmatter } from "./maintenance-source-frontmatter";
import { rawDigestFingerprint } from "./raw-digest";
import { holdMaintenancePages, releaseMaintenancePages, serializeMaintenancePage } from "./maintenance-page-lock";
import { groundMaintenanceKnowledgeUnits, prepareMaintenanceNewPage, validateMaintenanceNewPage } from "./maintenance-knowledge-quality";
import { applyMaintenanceRelatedEntries, maintenancePlanRelations, maintenanceVisibleClassification, validateMaintenanceP2Plan } from "./maintenance-p2-planning";
import type { MaintenanceDomainMapDraft, MaintenanceDomainMapEntry, MaintenanceKnowledgeSource, MaintenanceKnowledgeUnit, MaintenanceUnitCandidates } from "./maintenance-p2-contract";
import { assertMaintenanceShortTitle, assertMaintenanceShortTarget, MAINTENANCE_SHORT_TITLE_POLICY } from "./maintenance-title";
import { maintenanceReceiptForRecord } from "./maintenance-activity";
import { maintenanceFailureText } from "./maintenance-user-copy";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const revision = (s: string) => `sha256:${hash(s)}`;
export interface MaintenanceP1Host {
  vaultRootPath: string;
  records(): Promise<KnowledgeMaintenanceRecord[]>;
  processedSources(paths: readonly string[], records: readonly KnowledgeMaintenanceRecord[]): Promise<readonly string[]>;
  save(record: KnowledgeMaintenanceRecord): Promise<void>;
  current?(input: Readonly<PiKnowledgeMaintenanceToolInput>, stage: import("./maintenance-activity").MaintenanceActivityStage, path: string): Promise<void>;
  read(path: string): Promise<string | null>;
  /** Resolve/reject pending WALs before replacing the basis of an uncommitted page. */
  recoverBeforeRebase(): Promise<void>;
  /** Existing WAL/readback proof, independent of later user edits to the target. */
  committedPageReceipt(record: KnowledgeMaintenanceRecord, item: MaintenanceWritingItem, draft: { content: string; toolCallId: string }): Promise<{ path: string; contentRevision: string } | null>;
  sourcePath(path: string): string;
  targetPath(path: string): Promise<string>;
  preparePageContent?(item: MaintenanceWritingItem, content: string, baseline?: string): Promise<string>;
  candidates(units: readonly MaintenanceKnowledgeUnit[]): Promise<readonly MaintenanceUnitCandidates[]>;
  planMaps(entries: readonly MaintenanceDomainMapEntry[]): Promise<readonly MaintenanceDomainMapDraft[]>;
  refresh?(): Promise<void>;
  templateNotice?(): Promise<string | undefined>;
  commit(input: Readonly<PiKnowledgeMaintenanceToolInput>, item: MaintenanceWritingItem, content: string, sourceFields?: MaintenanceSourceFields): Promise<boolean>;
  now(): number;
  date(): string;
}

/** Same tool/session, same private records and WAL; stage results are never terminal receipts. */
export class MaintenanceP1Workflow {
  constructor(private readonly host: MaintenanceP1Host) {}
  async restoreHolds(): Promise<void> {
    for (const r of await this.host.records()) if (r.p1 && r.p1.phase !== "completed") holdMaintenancePages(r.recordId, this.host.vaultRootPath, [...r.p1.writingPlan.map(p => p.targetPath), ...r.p1.p2?.finalization.map(p => p.targetPath) ?? []]);
  }
  async execute(input: Readonly<PiKnowledgeMaintenanceToolInput>): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    try { return await this.run(input); }
    catch (error) {
      const diagnostic = boundedMaintenanceMessage(`${error instanceof Error ? error.message : String(error)}${error && typeof error === "object" && "currentSnapshot" in error ? "\n请重新sections读取完整当前目录，不猜编号。" : ""}`);
      const record = (await this.host.records().catch((): KnowledgeMaintenanceRecord[] => [])).find(record => record.originConversationId === input.conversationId && record.p1 && record.p1.phase !== "completed");
      const currentPath = input.p1?.targetPath ?? record?.p1?.writingPlan.find(item => item.id === input.p1?.pageId)?.targetPath;
      const userReceipt = { ...(record ? maintenanceReceiptForRecord(record) : { version: 1 as const }), text: maintenanceFailureText(diagnostic, currentPath) };
      const message = `${diagnostic}${record ? `\n${JSON.stringify({ userReceipt })}` : ""}`;
      return { status: "failed", ...(record ? { recordId: record.recordId } : {}), processedSourcePaths: [], errorCode: error instanceof Phase3MaintenanceError ? error.code : "proposal_invalid", message, userReceipt };
    }
  }
  private async run(input: Readonly<PiKnowledgeMaintenanceToolInput>): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    const action = input.p1;
    if (!action) throw new Error("请按 stage=decompose -> plan -> write 执行；旧candidateActions已停用。中断后用stage=resume。");
    if (input.signal?.aborted) return { status: "cancelled", message: "维护已停止，清单保留。", processedSourcePaths: [], userReceipt: { version: 1, text: maintenanceFailureText("取消") } };
    const records = await this.host.records();
    let record = records.find(r => r.originConversationId === input.conversationId && r.p1?.phase !== "completed" && r.p1);
    const selected = [...new Set((input.sourcePaths?.length ? input.sourcePaths : input.globalSourcePaths ?? []).map(p => this.host.sourcePath(p)))];
    if (record && selected.length && (selected.some(p => !record!.sources.some(s => s.path === p)) || record.sources.some(source => source.status !== "processed" && !selected.includes(source.path)))) throw new Error("本会话有未完清单，来源范围不同；请先继续原清单，不能静默换范围。");
    if (action.stage === "decompose") {
      const replayId = `maintenance-${hash(`${input.productRunId}:${input.toolCallId}:p1`).slice(0, 32)}`;
      const replay = records.find(record => record.recordId === replayId && record.originConversationId === input.conversationId && record.p1);
      if (replay?.p1?.phase === "completed") return this.receipt(replay, "该调用的清单已完成，保留成功页。");
      if (record && record.p1!.phase !== "decompose") return this.receipt(record, "已有未完成清单，使用resume继续；不会覆盖已存拆解。");
      if (!selected.length || selected.length > 20) throw new Error("拆解须使用当前授权的1–20篇来源。");
      const decompositions = action.decompositions;
      if (!isUnknownArray(decompositions) || !decompositions.length || decompositions.length > selected.length) throw new Error("decompositions须含本批至少1篇来源；可逐篇提交同一decompose阶段，全部齐备后才能plan。");
      const fingerprints: Record<string, string> = { ...record?.p1!.sourceFingerprints };
      const sourceTexts: MaintenanceKnowledgeSource[] = [];
      for (const sourcePath of selected) {
        const text = await this.host.read(sourcePath);
        if (text === null) throw new Error(`来源不存在：${sourcePath}`);
        const fingerprint = rawDigestFingerprint(sourcePath, Buffer.from(text));
        if (fingerprints[sourcePath] && fingerprints[sourcePath] !== fingerprint) throw new Error(`来源已变化，原检查点保留：${sourcePath}`);
        fingerprints[sourcePath] = fingerprint;
        sourceTexts.push({ path: sourcePath, content: text, contentRevision: revision(text) });
      }
      const seen = new Set<string>();
      for (const d of decompositions) {
        if (!d || typeof d.sourcePath !== "string" || !selected.includes(d.sourcePath) || seen.has(d.sourcePath) || typeof d.summary !== "string" || !d.summary.trim() || !isUnknownArray(d.units) || d.units.some(u => !u || typeof u !== "object" || !isUnknownArray(u.evidence) || !u.evidence.some(e => e.sourcePath === d.sourcePath))) throw new Error("拆解必须使用带七类型和本篇原句证据的结构化知识点；旧字符串仅供已有P1清单恢复。");
        seen.add(d.sourcePath);
        await this.host.current?.(input, "decompose", d.sourcePath);
        for (const sourcePath of new Set([d.sourcePath, ...d.units.flatMap(u => typeof u === "string" ? [] : u.evidence.map(e => e.sourcePath))])) {
          if (!selected.includes(sourcePath) || input.sourceBodyFingerprints?.[sourcePath] !== fingerprints[sourcePath]) throw new Error(`请先完整note_read当前来源再拆解：${sourcePath}`);
        }
        const existing = record?.p1!.decompositions.find(old => old.sourcePath === d.sourcePath);
        // Inspect only newly submitted units; frozen decompositions are not migrated.
        if (!existing) for (const unit of d.units) if (typeof unit !== "string") assertMaintenanceShortTitle(unit.title, `unit.id=${JSON.stringify(unit.id)}, sourcePath=${JSON.stringify(d.sourcePath)}`);
        const combined = [...(record?.p1!.decompositions.filter(old => old.sourcePath !== d.sourcePath) ?? []), d];
        const units = groundMaintenanceKnowledgeUnits(combined.flatMap(d => d.units) as MaintenanceKnowledgeUnit[], sourceTexts);
        const grounded = new Map(units.map(unit => [unit.id, unit]));
        const validated = { ...d, units: d.units.map(unit => grounded.get((unit as MaintenanceKnowledgeUnit).id)!) };
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(validated)) throw new Error(`已校验拆解不可覆盖：${d.sourcePath}；继续尚未拆解来源。`);
          continue;
        }
        if (!record) {
          const at = this.host.now();
          record = { schemaVersion: 1, recordId: replayId, runId: `${input.productRunId}:${input.toolCallId}`, originConversationId: input.conversationId, at, date: this.host.date(), summary: "拆解检查点已保存，尚未提炼完成", sources: selected.map(p => ({ path: p, fingerprint: fingerprints[p], status: "unread", evidencePaths: [] })), result: createKnowledgeMaintenanceResultEnvelope({ status: "partial", issues: [{ code: "p1_pending", message: "维护阶段尚未完成" }] }), p1: { version: 1, phase: "decompose", sourceFingerprints: fingerprints, folderBindingsRevision: input.folderBindingsRevision, decompositions: [], writingPlan: [], drafts: {}, committedPages: {}, finalizedSources: [] } };
        }
        record.p1!.decompositions = [...record.p1!.decompositions, validated];
        record.sources.find(source => source.path === d.sourcePath)!.status = "failed";
        await this.host.save(record);
      }
      if (!record) throw new Error("没有通过校验的来源拆解。");
      if (record.p1!.decompositions.length === selected.length) {
        const candidates = await this.host.candidates(this.units(record));
        record.p1!.p2 = { version: 2, candidates, finalization: [], committedFinalization: {}, templateNotice: await this.host.templateNotice?.() };
        record.p1!.phase = "plan";
        await this.host.save(record);
      }
      return this.receipt(record, record.p1!.phase === "plan" ? "全批拆解与Wiki候选已保存；候选不等于同知识点。先读候选，再stage=plan提交判断和写作清单。" : "本篇拆解校验检查点已保存；继续stage=decompose提交未完成来源，全部齐备后才开放plan。");
    }
    if (!record) {
      if ((action.stage === "inspect" || action.stage === "resume") && selected.length > 0 && selected.length <= 20) {
        if (records.some(r => r.p1 && r.p1.phase !== "completed" && r.sources.some(source => selected.includes(source.path)))) throw new Error("这些来源有历史未完成清单；请回到原会话使用stage=resume继续，不能当作已完成。");
        const processed = new Set(await this.host.processedSources(selected, records));
        if (selected.every(relative => processed.has(relative))) return {
          status: "completed", maintenanceStage: "completed", processedSourcePaths: selected, producedPaths: [],
          maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "noop" }),
          userReceipt: { version: 1, text: "这批资料已整理过，没有新增或改写页面。", sourceCount: selected.length, pageCounts: { written: 0, created: 0, updated: 0 } },
          message: "当前选定来源均已提炼，无需继续维护；本次只读核对，没有新建清单或写入来源、Wiki、关系和地图。"
        };
      }
      throw new Error("没有未完成清单；先stage=decompose。");
    }
    const state = record.p1!;
    if (state.folderBindingsRevision !== input.folderBindingsRevision) throw new Error("维护期间目录配置已变化，原清单保留，停止写入。");
    await this.assertSources(record);
    if (action.stage === "inspect") return this.receipt(record, "只读分页；nextOffset不为空时继续inspect同view和offset，原文可用note_read重读。", action.view ?? "candidates", action.offset ?? 0);
    if (action.stage === "plan") {
      if (state.phase === "decompose") throw new Error(`全部来源校验后才能plan；尚缺：${record.sources.filter(source => !state.decompositions.some(d => d.sourcePath === source.path)).map(source => source.path).join("、")}`);
      if (state.phase !== "plan") return this.receipt(record, "写作清单已固定，使用resume继续，不覆盖已有目标。");
      if (!isUnknownArray(action.writingPlan) || action.writingPlan.length > 100) throw new Error("需要明确的writingPlan数组。");
      const ids = new Set<string>(), targets = new Set<string>();
      const plan: MaintenanceWritingItem[] = [];
      const errors: string[] = [];
      for (const [index,item] of action.writingPlan.entries()) { try {
        if (!item || !/^[A-Za-z0-9_-]{1,80}$/u.test(item.id) || ids.has(item.id) || !isUnknownArray(item.sourcePaths) || !item.sourcePaths.length || new Set(item.sourcePaths).size !== item.sourcePaths.length || item.sourcePaths.some(p => !record.sources.some(s => s.path === p))) throw new Error("清单ID、来源或条目无效。");
        const targetPath = await this.host.targetPath(item.targetPath);
        if (targets.has(targetPath)) throw new Error("同一目标只安排一页；先聚合重复知识点。");
        const before = await this.host.read(targetPath);
        if (item.newSections?.length) {
          if (before === null) throw new Error("新页用完整content声明结构；newSections只用于已有页缺失的语义H2。");
          createMaintenanceSectionSnapshot(before, item.newSections);
        }
        const expectedTarget = item.expectedTarget?.kind === "file" ? { kind: "file" as const, contentRevision: /^[a-f0-9]{64}$/iu.test(item.expectedTarget.contentRevision) ? `sha256:${item.expectedTarget.contentRevision.toLowerCase()}` : item.expectedTarget.contentRevision } : item.expectedTarget;
        if (!expectedTarget || (expectedTarget.kind === "missing" ? before !== null : expectedTarget.kind !== "file" || before === null || revision(before) !== expectedTarget.contentRevision)) throw new Error(`目标版本已变化，请重新note_read：${targetPath}`);
        if (before !== null && input.observedTargetRevisions?.[targetPath] !== revision(before)) throw new Error(`已有页必须先note_read当前版本：${targetPath}`);
        const knowledge = item.knowledge ? { ...item.knowledge, ...(item.knowledge.decision ? { decision: { ...item.knowledge.decision, ...(item.knowledge.decision.candidatePath ? { candidatePath: await this.host.targetPath(item.knowledge.decision.candidatePath) } : {}) } } : {}), ...(item.knowledge.related ? { related: await Promise.all(item.knowledge.related.map(async relation => ({ ...relation, targetPath: await this.host.targetPath(relation.targetPath) }))) } : {}) } : undefined;
        ids.add(item.id); targets.add(targetPath); plan.push({ ...item, expectedTarget, targetPath, sourcePaths: [...item.sourcePaths], ...(knowledge ? { knowledge } : {}) });
      } catch (error) { errors.push(`writingPlan[${index}]: ${error instanceof Error ? error.message : String(error)}`); } }
      for (const d of state.decompositions) if (d.units.length && !plan.some(p => p.sourcePaths.includes(d.sourcePath))) errors.push(`有知识点的来源未安排任何页：${d.sourcePath}`);
      if (state.p2) try { validateMaintenanceP2Plan(plan, this.units(record), state.p2.candidates); } catch(error) { errors.push(error instanceof Error ? error.message : String(error)); }
      throwMaintenanceDiagnostics(errors, "写作清单");
      if (state.p2) {
        await this.planFinalization(input, record, plan);
        state.p2.titlePolicy = MAINTENANCE_SHORT_TITLE_POLICY;
      }
      state.writingPlan = plan; state.phase = "write";
      holdMaintenancePages(record.recordId, this.host.vaultRootPath, [...plan.map(p => p.targetPath), ...state.p2?.finalization.map(p => p.targetPath) ?? []]);
      await this.host.save(record);
      if (!plan.length) await this.finalize(input, record);
      return this.receipt(record, "写作清单已持久化；按pendingPages逐页write。尚无草稿的页需继续写作。");
    }
    if (action.stage === "sections") {
      const item = state.writingPlan.find(p => p.targetPath === action.targetPath);
      if (!item) throw new Error("sections只能读取本清单内目标页。");
      if (state.committedPages[item.id]) return this.receipt(record, "这页已成功，保留原页，不重新生成草稿或写入。");
      await this.host.recoverBeforeRebase();
      return await serializeMaintenancePage(this.host.vaultRootPath, item.targetPath, async () => {
        await this.assertSources(record);
        if (await this.checkpointCommittedPage(record, item)) return this.receipt(record, "原写入已有持久日志与成功回读凭据；已补父检查点，保留用户后续修改。用resume只补剩余页与收尾。");
        const before = await this.host.read(item.targetPath);
        if (before === null) throw new Error(`目标不存在，不能刷新已有页区域：${item.targetPath}`);
        const previousDraft = state.drafts[item.id];
        if (previousDraft && before === previousDraft.content) {
          throw new Phase3MaintenanceError("recovery_blocked", `目标字节命中草稿但没有对应成功WAL/readback，不能猜测成功或废弃旧稿：${item.targetPath}`);
        }
        const changed = item.expectedTarget.kind === "missing" || item.expectedTarget.contentRevision !== revision(before);
        if (changed && input.observedTargetRevisions?.[item.targetPath] !== revision(before)) throw new Error(`目标并发变化；先完整note_read当前目标，再sections刷新区域与草稿，不能只替换版本重放旧稿：${item.targetPath}`);
        const currentTitles = changed ? new Set(createMaintenanceSectionSnapshot(before).regions.map(region => region.title.normalize("NFKC").toLowerCase())) : undefined;
        const newSections = (item.newSections ?? []).filter(title => !currentTitles?.has(title.normalize("NFKC").toLowerCase()));
        const snapshot = createMaintenanceSectionSnapshot(before, newSections);
        if (changed) {
          if (item.newSections) item.newSections = newSections;
          item.expectedTarget = { kind: "file", contentRevision: revision(before) };
          state.draftGenerations ??= {};
          state.draftGenerations[item.id] = (state.draftGenerations[item.id] ?? 0) + 1;
          delete state.drafts[item.id];
        }
        state.sectionSnapshots ??= {};
        state.sectionSnapshots[item.targetPath] = snapshot;
        await this.host.save(record);
        return { status: "completed", recordId: record.recordId, maintenanceStage: "sections", processedSourcePaths: [], userReceipt: maintenanceReceiptForRecord(record), message: JSON.stringify({ stage: "sections", targetPath: item.targetPath, snapshot, ...(changed ? { draftDiscarded: true, next: "必须按此新snapshot提交新sectionPatches；旧region与旧draft均不可重放。" } : {}), virtualRegions: { sources: `${snapshot.revision}:sources:new`, related: `${snapshot.revision}:related:new` } }) };
      });
    }
    if (state.phase === "decompose") return this.receipt(record, "拆解尚未齐备；继续stage=decompose提交未完成来源。");
    if (state.phase === "plan") return this.receipt(record, "尚未汇总；请先stage=plan。");
    if (action.stage === "write") {
      const item = state.writingPlan.find(p => p.id === action.pageId);
      if (!item) throw new Error("pageId不在固定清单内。");
      if (state.committedPages[item.id]) return this.receipt(record, "这页已成功，保留原页，不重复写入。");
      if (!state.drafts[item.id]) {
        let content: string;
        if (item.expectedTarget.kind === "missing") {
          if (state.p2?.titlePolicy === MAINTENANCE_SHORT_TITLE_POLICY) assertMaintenanceShortTarget(item.targetPath);
          if (typeof action.content !== "string" || !action.content.trim() || action.sectionPatches) throw new Error("新页提供content，不使用小节patch。");
          content = action.content;
        } else {
          if (action.content !== undefined || !action.sectionPatches?.length) throw new Error("已有页只允许sectionPatches，不允许整页content。");
          const snapshot = state.sectionSnapshots?.[item.targetPath];
          const before = await this.host.read(item.targetPath);
          if (!snapshot || before === null) throw new Error("先sections获取真实区域ID。");
          const virtual = action.sectionPatches.filter(p => p.regionId === `${snapshot.revision}:related:new` || p.regionId === `${snapshot.revision}:sources:new`);
          const patches = action.sectionPatches.filter(p => !virtual.includes(p));
          content = applyMaintenanceSectionPatches(before, snapshot, patches);
          for (const patch of virtual) {
            const kind = patch.regionId.endsWith(":related:new") ? "related" : "sources";
            if (snapshot.regions.some(r => r.kind === kind) || patch.operation !== "append" || /^\s*(?:#{1,6}\s|`{3}|~{3})/mu.test(patch.content)) throw new Error("受管虚拟区域只能追加不存在的来源/相关条目，不能覆盖。");
            content = appendMaintenanceManagedBlock(content, `## ${kind === "related" ? "相关条目" : "来源"}\n${patch.content}\n`, content.includes("\r\n") ? "\r\n" : "\n");
          }
        }
        const baseline = item.expectedTarget.kind === "file" ? (await this.host.read(item.targetPath)) ?? undefined : undefined;
        const own = this.units(record).filter(unit => item.knowledge?.unitIds.includes(unit.id)).map(unit => ({ ...unit, type: item.knowledge!.type ?? unit.type, domain: item.knowledge!.domain ?? unit.domain }));
        if (state.p2) content = baseline === undefined ? prepareMaintenanceNewPage(content, own, item.targetPath) : appendMaintenanceAliases(content, own.flatMap(unit => [...unit.aliases, ...([maintenancePageTitle(baseline,item.targetPath), item.targetPath.split("/").at(-1)!.replace(/\.(?:md|markdown)$/iu, "")].includes(unit.title) ? [] : [unit.title])]));
        content = await this.host.preparePageContent?.(item, content, baseline) ?? content;
        if (state.p2) {
          if (baseline === undefined) validateMaintenanceNewPage(content, own, item.targetPath, state.p2.titlePolicy);
          content = applyMaintenanceRelatedEntries(content, maintenancePlanRelations(state.writingPlan).get(item.targetPath) ?? [], baseline);
        }
        content = await this.withSources(content, item, record, baseline);
        assertMaintenanceQuoteSectionsPreserved(baseline, content);
        const generation = state.draftGenerations?.[item.id] ?? 0;
        state.drafts[item.id] = { content, toolCallId: `${record.recordId}:${item.id}${generation ? `:r${generation}` : ""}` };
        await this.host.save(record);
      }
      await this.writePage(input, item, record);
    } else if (action.stage === "resume") {
      for (const item of state.writingPlan) if (!state.committedPages[item.id] && state.drafts[item.id]) {
        if (input.signal?.aborted) break;
        await this.writePage(input, item, record);
      }
    }
    await this.finalize(input, record);
    return this.receipt(record, state.phase === "completed" ? "清单与原文双链已完成。" : "清单保留；按pendingPages继续，成功页不重写。");
  }
  private units(record: KnowledgeMaintenanceRecord): MaintenanceKnowledgeUnit[] {
    return record.p1!.decompositions.flatMap(d => d.units).filter((unit): unit is MaintenanceKnowledgeUnit => typeof unit !== "string");
  }
  private async sourceLinks(record: KnowledgeMaintenanceRecord, paths: readonly string[], eol = "\n"): Promise<string> {
    const links: string[] = [];
    for (const p of paths) {
      const raw = await this.host.read(p);
      const heading = raw === null ? undefined : createMaintenanceSectionSnapshot(raw).regions.map(region => raw.slice(region.start, region.contentStart)).find(heading => /^ {0,3}#\s+/u.test(heading));
      const title = heading?.replace(/^ {0,3}#\s+/u, "").trim().replace(/[ \t]+#+[ \t]*$/u, "") || p.split("/").at(-1)!.replace(/\.(?:md|markdown)$/iu, "");
      const label = title.replace(/[[\]|\r\n]/gu, " ");
      links.push(`[[${p}|${label}]]${eol}<!-- echoink-source: ${JSON.stringify({ path: p, revision: `sha256:${record.p1!.sourceFingerprints[p].split(":").at(-1)}` })} -->`);
    }
    return links.join(eol);
  }
  private async planFinalization(input: Readonly<PiKnowledgeMaintenanceToolInput>, record: KnowledgeMaintenanceRecord, plan: readonly MaintenanceWritingItem[]): Promise<void> {
    const state = record.p1!, p2 = state.p2!, units = this.units(record);
    const finalization: typeof p2.finalization[number][] = [];
    const relations = maintenancePlanRelations(plan);
    for (const item of plan) for (const relation of item.knowledge?.related ?? []) if (!plan.some(page => page.targetPath === relation.targetPath) && await this.host.read(relation.targetPath) === null) throw new Error(`相关目标不存在，也未安排新建：${relation.targetPath}`);
    for (const [targetPath, related] of relations) {
      if (plan.some(item => item.targetPath === targetPath)) continue;
      const before = await this.host.read(targetPath);
      if (before === null || input.observedTargetRevisions?.[targetPath] !== revision(before)) throw new Error(`相关旧页也须先note_read当前版本，才能补互链：${targetPath}`);
      const origins = plan.filter(item => item.knowledge?.related?.some(relation => relation.targetPath === targetPath && typeof relation.reverseReason === "string" && relation.reverseReason.trim()));
      const sourcePaths = [...new Set(origins.flatMap(item => item.sourcePaths))];
      if (!sourcePaths.length) throw new Error("相关条目缺少本批来源依据。");
      const item: MaintenanceWritingItem = { id: `relation-${hash(targetPath).slice(0,16)}`, targetPath, sourcePaths, expectedTarget: { kind: "file", contentRevision: revision(before) } };
      const content = await this.withSources(applyMaintenanceRelatedEntries(before, related, before), item, record, before);
      assertMaintenanceQuoteSectionsPreserved(before, content);
      finalization.push({ ...item, kind: "relationship", content });
    }
    const entries = await Promise.all(plan.map(async item => {
      const unit = units.find(unit => item.knowledge!.unitIds.includes(unit.id))!;
      const before = item.expectedTarget.kind === "file" ? await this.host.read(item.targetPath) ?? "" : "";
      const visible = maintenanceVisibleClassification(before);
      return { path: item.targetPath, title: maintenancePageTitle(before, item.targetPath), type: visible.type ?? item.knowledge!.type ?? unit.type, domain: visible.domain ?? item.knowledge!.domain ?? unit.domain };
    }));
    for (const draft of await this.host.planMaps(entries)) {
      const targetPath = await this.host.targetPath(draft.targetPath);
      if (plan.some(item => item.targetPath === targetPath) || finalization.some(item => item.targetPath === targetPath)) throw new Error(`地图目标与正文/相关页冲突：${targetPath}`);
      const before = await this.host.read(targetPath);
      if (draft.expectedTarget.kind === "missing" ? before !== null : before === null || revision(before) !== draft.expectedTarget.contentRevision) throw new Error(`地图已并发变化：${targetPath}`);
      const token = "<!-- echoink-domain-map:sources -->";
      if (draft.content.split(token).length !== 2) throw new Error("地图受管来源占位无效。");
      const domainPaths = [...new Set(plan.filter(item => entries.find(entry => entry.path === item.targetPath)?.domain && (draft.domains ?? [draft.domain]).includes(entries.find(entry => entry.path === item.targetPath)!.domain)).flatMap(item => item.sourcePaths))];
      const content = draft.content.replace(token, await this.sourceLinks(record, domainPaths, draft.content.includes("\r\n") ? "\r\n" : "\n"));
      finalization.push({ id: `map-${hash(targetPath).slice(0,16)}`, kind: "map", targetPath, expectedTarget: draft.expectedTarget, sourcePaths: domainPaths, content });
    }
    p2.finalization = finalization;
  }
  private async writeFinalization(input: Readonly<PiKnowledgeMaintenanceToolInput>, record: KnowledgeMaintenanceRecord): Promise<void> {
    const state = record.p1!, p2 = state.p2!;
    for (const item of p2.finalization) {
      if (p2.committedFinalization[item.id]) continue;
      if (input.signal?.aborted) return;
      await this.host.current?.(input, "finalize", item.targetPath);
      await serializeMaintenancePage(this.host.vaultRootPath, item.targetPath, async () => {
        await this.assertSources(record);
        const current = await this.host.read(item.targetPath);
        assertMaintenanceQuoteSectionsPreserved(current ?? undefined, item.content);
        if (current !== item.content) {
          if (item.expectedTarget.kind === "missing" ? current !== null : current === null || revision(current) !== item.expectedTarget.contentRevision) throw new Error(`受管收尾并发冲突：${item.targetPath}；保留手写内容，不覆盖。`);
          if (!await this.host.commit({ ...input, p1RecordId: record.recordId, toolCallId: `${record.recordId}:${item.id}` }, item, item.content)) throw new Error(`受管收尾待恢复：${item.targetPath}；resume只补收尾，不重写成功页。`);
        }
        if (await this.host.read(item.targetPath) !== item.content) throw new Error(`受管收尾回读失败：${item.targetPath}`);
        p2.committedFinalization[item.id] = { path: item.targetPath, contentRevision: revision(item.content) };
        await this.host.save(record);
        await this.host.refresh?.();
      });
    }
  }
  private async assertSources(record: KnowledgeMaintenanceRecord): Promise<void> {
    for (const source of record.sources) {
      const text = await this.host.read(source.path);
      if (text === null || rawDigestFingerprint(source.path, Buffer.from(text)) !== record.p1!.sourceFingerprints[source.path]) throw new Error(`来源已变化，停止剩余写入：${source.path}`);
    }
  }
  private async withSources(content: string, item: MaintenanceWritingItem, record: KnowledgeMaintenanceRecord, baseline?: string): Promise<string> {
    const snapshot = createMaintenanceSectionSnapshot(content), region = snapshot.regions.find(r => r.kind === "sources");
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const currentMarkers = extractMachineSourceMarkers(content);
    const retained = [...extractMachineSourceMarkers(baseline ?? "")].filter(([source]) => !item.sourcePaths.includes(source) && !currentMarkers.has(source));
    const preserved = retained.map(([source, revision]) => { const label = (baseline ?? "").split(`[[${source}|`)[1]?.split("]]", 1)[0] || source.split("/").at(-1)!.replace(/\.md$/iu, ""); return `[[${source}|${label}]]${eol}<!-- echoink-source: ${JSON.stringify({ path: source, revision })} -->`; }).join(eol);
    const links = (preserved ? preserved + eol : "") + await this.sourceLinks(record, item.sourcePaths, eol);
    if (!region) return appendMaintenanceManagedBlock(content, `## 来源${eol}${eol}${links}${eol}`, eol);
    // This is the only program-managed area; all other bytes stay verbatim.
    let sourceContent = content.slice(region.contentStart, region.end);
    sourceContent = sourceContent.replace(/^\[\[([^\r\n]+)\]\][ \t]*(?:\r\n|\n|\r)<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->[ \t]*(?:\r\n|\n|\r|$)/gmu, (pair: string, _link: string, json: string) => { try { const marker: unknown = JSON.parse(json); return marker && typeof marker === "object" && "path" in marker && typeof marker.path === "string" && item.sourcePaths.includes(marker.path) ? "" : pair; } catch { return pair; } });
    for (const p of item.sourcePaths) sourceContent = sourceContent.replace(/<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu, (marker: string, json: string) => { try { const value: unknown = JSON.parse(json); return value && typeof value === "object" && "path" in value && value.path === p ? "" : marker; } catch { return marker; } });
    const selected = new Set(item.sourcePaths.flatMap(p => [p, p.replace(/\.(?:md|markdown)$/iu, "")]));
    sourceContent = sourceContent.replace(/\[\[([^\]|#\r\n]+)(?:\|[^\]\r\n]*)?\]\]/gu, (link, target: string) => selected.has(target) ? "" : link);
    if (sourceContent && !/^[\r\n]/u.test(sourceContent)) sourceContent = eol + sourceContent;
    return appendMaintenanceBlock(content.slice(0, region.contentStart) + sourceContent, `${links}${eol}${region.end < content.length ? eol : ""}`, eol) + content.slice(region.end);
  }
  private async writePage(input: Readonly<PiKnowledgeMaintenanceToolInput>, item: MaintenanceWritingItem, record: KnowledgeMaintenanceRecord): Promise<void> {
    const state = record.p1!, draft = state.drafts[item.id];
    if (!draft || state.committedPages[item.id]) return;
    if (item.expectedTarget.kind === "missing" && state.p2?.titlePolicy === MAINTENANCE_SHORT_TITLE_POLICY) assertMaintenanceShortTarget(item.targetPath);
    await this.host.current?.(input, "write", item.targetPath);
    await this.host.recoverBeforeRebase();
    await serializeMaintenancePage(this.host.vaultRootPath, item.targetPath, async () => {
      await this.assertSources(record);
      if (await this.checkpointCommittedPage(record, item)) return;
      const current = await this.host.read(item.targetPath);
      if (current === draft.content) throw new Phase3MaintenanceError("recovery_blocked", `目标字节命中草稿但没有对应成功WAL/readback，不能猜测成功或重复写入：${item.targetPath}`);
      if (item.expectedTarget.kind === "missing" ? current !== null : current === null || revision(current) !== item.expectedTarget.contentRevision) throw new Error(`目标并发编辑冲突：${item.targetPath}；先完整note_read，再sections获取新区域并提交新patch；保留手写，禁止重放旧draft。`);
      if (!await this.host.commit({ ...input, p1RecordId: record.recordId, toolCallId: draft.toolCallId }, item, draft.content)) throw new Error(`页写入失败：${item.targetPath}；草稿与成功页已保留，可resume。`);
      const readback = await this.host.read(item.targetPath);
      if (readback !== draft.content) throw new Error(`页回读不一致：${item.targetPath}`);
      state.committedPages[item.id] = { path: item.targetPath, contentRevision: revision(readback) };
      await this.host.save(record);
      await this.host.refresh?.();
    });
  }
  private async checkpointCommittedPage(record: KnowledgeMaintenanceRecord, item: MaintenanceWritingItem): Promise<boolean> {
    const state = record.p1!, draft = state.drafts[item.id];
    if (!draft) return false;
    const receipt = await this.host.committedPageReceipt(record, item, draft);
    if (!receipt) return false;
    state.committedPages[item.id] = receipt;
    await this.host.save(record);
    await this.host.refresh?.();
    return true;
  }
  private async finalize(input: Readonly<PiKnowledgeMaintenanceToolInput>, record: KnowledgeMaintenanceRecord): Promise<void> {
    const state = record.p1!;
    const pagesReady = state.writingPlan.every(page => state.committedPages[page.id]);
    if (pagesReady) { state.phase = "finalize"; await this.host.save(record); }
    if (state.p2 && pagesReady) await this.writeFinalization(input, record);
    const p2Ready = !state.p2 || (pagesReady && state.p2.finalization.every(item => state.p2!.committedFinalization[item.id]));
    for (const source of record.sources) {
      if (!p2Ready) continue;
      if (state.finalizedSources.includes(source.path)) continue;
      const pages = state.writingPlan.filter(p => p.sourcePaths.includes(source.path));
      if (pages.some(p => !state.committedPages[p.id])) continue;
      const relationships = state.p2?.finalization.filter(item => item.kind === "relationship" && item.sourcePaths.includes(source.path)) ?? [];
      // A relation-only old page also acquires this Raw source. Its confirmed
      // readback is a prerequisite to the Raw's matching reverse link.
      if (relationships.some(item => !state.p2!.committedFinalization[item.id])) continue;
      const targetPaths = [...new Set([...pages.map(p => p.targetPath), ...relationships.map(item => item.targetPath)])];
      await this.host.current?.(input, "finalize", source.path);
      await this.assertSources(record);
      const before = await this.host.read(source.path);
      if (before === null) throw new Error("原文暂不可读，反链待恢复。");
      const fields: MaintenanceSourceFields = { status: "已提炼", summary: state.decompositions.find(d => d.sourcePath === source.path)!.summary, targetPaths };
      const content = patchMaintenanceSourceFrontmatter(before, fields);
      if (content !== before && !await this.host.commit({ ...input, p1RecordId: record.recordId, toolCallId: `${record.recordId}:source:${hash(source.path).slice(0, 16)}` }, { id: "source", targetPath: source.path, sourcePaths: [source.path], expectedTarget: { kind: "file", contentRevision: revision(before) } }, content, fields)) throw new Error(`知识页已保存，原文反链待恢复：${source.path}；resume只补原文。`);
      if (await this.host.read(source.path) !== content) throw new Error(`原文反链回读失败：${source.path}`);
      state.finalizedSources.push(source.path); source.status = "processed"; source.evidencePaths = targetPaths;
      await this.host.save(record);
    }
    if (record.sources.every(s => state.finalizedSources.includes(s.path))) { state.phase = "completed"; }
    else state.phase = state.writingPlan.every(p => state.committedPages[p.id]) ? "finalize" : "write";
    record.result = createKnowledgeMaintenanceResultEnvelope({ status: state.phase === "completed" ? state.writingPlan.length ? "completed" : "noop" : "partial", issues: state.phase === "completed" ? [] : [{ code: "p1_pending", message: "维护阶段尚未完成" }], notes: state.writingPlan.filter(p => state.committedPages[p.id]).map(p => knowledgeMaintenanceNoteFromReadback({ operation: p.expectedTarget.kind === "missing" ? "created" : "updated", path: p.targetPath, content: state.drafts[p.id].content })) });
    record.summary = state.phase === "completed" ? "知识清单与原文双链已完成" : "清单部分完成，保留未完页与反链";
    await this.host.save(record);
    if (state.phase === "completed") releaseMaintenancePages(record.recordId);
  }
  private receipt(record: KnowledgeMaintenanceRecord, message: string, view?: MaintenanceInspectionView, offset = 0): PiKnowledgeMaintenanceToolResult {
    const state = record.p1!;
    const inspection = maintenanceInspection(state, view ?? (state.phase === "plan" ? "candidates" : "pages"), offset);
    const managed = state.p2?.finalization.filter(item => !state.p2!.committedFinalization[item.id]) ?? [];
    const userReceipt = maintenanceReceiptForRecord(record);
    const summary = { recordId: record.recordId, phase: state.phase, sourceCount: record.sources.length, userReceipt, unitCount: state.decompositions.reduce((count,d) => count + d.units.length,0), committedPageCount: Object.keys(state.committedPages).length, pendingPageCount: state.writingPlan.filter(page => !state.committedPages[page.id]).length, pendingFinalizationCount: record.sources.filter(source => !state.finalizedSources.includes(source.path)).length, pendingManagedFinalizationCount: managed.length, pendingManagedFinalization: managed.slice(0,3).map(item => ({ kind: item.kind, targetPath: item.targetPath })), inspection };
    const notice = state.p2?.templateNotice ? `\n${state.p2.templateNotice}` : "";
    return { status: "completed", recordId: record.recordId, maintenanceStage: state.phase, userReceipt, processedSourcePaths: record.sources.filter(s => s.status === "processed").map(s => s.path), ...(state.phase === "completed" ? { maintenanceResult: record.result, producedPaths: Object.values(state.committedPages).map(p => p.path) } : {}), message: `${message}${notice}\n${JSON.stringify(summary)}${inspection.nextOffset === null ? "" : `\n还有未返回的${inspection.view}，请用stage=inspect,view=${inspection.view},offset=${inspection.nextOffset}读取下一页。`}` };
  }
}

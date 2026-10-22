import { Phase3MaintenanceError } from "./phase3-maintenance-service";
import { extractMachineSourceMarkers } from "./knowledge-maintenance-protocol";
import { createHash } from "node:crypto";
import type { PiKnowledgeMaintenanceToolInput, PiKnowledgeMaintenanceToolResult } from "../harness/pi-native/contracts";
import type { KnowledgeMaintenanceRecord } from "./maintenance-record";
import type { MaintenanceP1State, MaintenanceSectionSnapshot, MaintenanceSourceFields, MaintenanceWritingItem } from "./maintenance-p1-contract";
import { createKnowledgeMaintenanceResultEnvelope, knowledgeMaintenanceNoteFromReadback } from "./knowledge-maintenance-result";
import { createMaintenanceSectionSnapshot, applyMaintenanceSectionPatches } from "./maintenance-section-patch";
import { patchMaintenanceSourceFrontmatter } from "./maintenance-source-frontmatter";
import { rawDigestFingerprint } from "./raw-digest";
import { holdMaintenancePages, releaseMaintenancePages, serializeMaintenancePage } from "./maintenance-page-lock";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const revision = (s: string) => `sha256:${hash(s)}`;
export interface MaintenanceP1Host {
  vaultRootPath: string;
  records(): Promise<KnowledgeMaintenanceRecord[]>;
  save(record: KnowledgeMaintenanceRecord): Promise<void>;
  read(path: string): Promise<string | null>;
  sourcePath(path: string): string;
  targetPath(path: string): Promise<string>;
  preparePageContent?(item: MaintenanceWritingItem, content: string, baseline?: string): Promise<string>;
  commit(input: Readonly<PiKnowledgeMaintenanceToolInput>, item: MaintenanceWritingItem, content: string, sourceFields?: MaintenanceSourceFields): Promise<boolean>;
  now(): number;
  date(): string;
}

/** Same tool/session, same private records and WAL; stage results are never terminal receipts. */
export class MaintenanceP1Workflow {
  constructor(private readonly host: MaintenanceP1Host) {}
  async restoreHolds(): Promise<void> {
    for (const r of await this.host.records()) if (r.p1 && r.p1.phase !== "completed") holdMaintenancePages(r.recordId, this.host.vaultRootPath, r.p1.writingPlan.map(p => p.targetPath));
  }
  async execute(input: Readonly<PiKnowledgeMaintenanceToolInput>): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    try { return await this.run(input); }
    catch (error) { return { status: "failed", processedSourcePaths: [], errorCode: error instanceof Phase3MaintenanceError ? error.code : "proposal_invalid", message: `${error instanceof Error ? error.message : String(error)}${error && typeof error === "object" && "currentSnapshot" in error ? `\n请重新sections，当前目录：${JSON.stringify(error.currentSnapshot)}` : ""}` }; }
  }
  private async run(input: Readonly<PiKnowledgeMaintenanceToolInput>): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    const action = input.p1;
    if (!action) throw new Error("请按 stage=decompose -> plan -> write 执行；旧candidateActions已停用。中断后用stage=resume。");
    if (input.signal?.aborted) return { status: "cancelled", message: "维护已停止，清单保留。", processedSourcePaths: [] };
    const records = await this.host.records();
    let record = records.find(r => r.originConversationId === input.conversationId && r.p1?.phase !== "completed" && r.p1);
    const selected = [...new Set((input.sourcePaths?.length ? input.sourcePaths : input.globalSourcePaths ?? []).map(p => this.host.sourcePath(p)))];
    if (record && selected.length && (selected.some(p => !record!.sources.some(s => s.path === p)) || record.sources.some(source => source.status !== "processed" && !selected.includes(source.path)))) throw new Error("本会话有未完清单，来源范围不同；请先继续原清单，不能静默换范围。");
    if (action.stage === "decompose") {
      const replayId = `maintenance-${hash(`${input.productRunId}:${input.toolCallId}:p1`).slice(0, 32)}`;
      const replay = records.find(record => record.recordId === replayId && record.originConversationId === input.conversationId && record.p1);
      if (replay?.p1?.phase === "completed") return this.receipt(replay, "该调用的清单已完成，保留成功页。");
      if (record) return this.receipt(record, "已有未完成清单，使用resume继续；不会覆盖已存拆解。");
      if (!selected.length || selected.length > 20) throw new Error("拆解须使用当前授权的1–20篇来源。");
      const decompositions = action.decompositions;
      if (!Array.isArray(decompositions) || decompositions.length !== selected.length) throw new Error("拆解必须逐篇覆盖整个选定批次。");
      const seen = new Set<string>();
      const fingerprints: Record<string, string> = {};
      for (const d of decompositions) {
        if (!d || typeof d.sourcePath !== "string" || !selected.includes(d.sourcePath) || seen.has(d.sourcePath) || typeof d.summary !== "string" || !d.summary.trim() || !Array.isArray(d.units) || d.units.some(u => typeof u !== "string" || !u.trim())) throw new Error("拆解条目无效或来源越界。");
        seen.add(d.sourcePath);
        const text = await this.host.read(d.sourcePath);
        if (text === null) throw new Error(`来源不存在：${d.sourcePath}`);
        const fingerprint = rawDigestFingerprint(d.sourcePath, Buffer.from(text));
        if (input.sourceBodyFingerprints?.[d.sourcePath] !== fingerprint) throw new Error(`请先完整note_read当前来源再拆解：${d.sourcePath}`);
        fingerprints[d.sourcePath] = fingerprint;
      }
      const at = this.host.now(), id = `maintenance-${hash(`${input.productRunId}:${input.toolCallId}:p1`).slice(0, 32)}`;
      record = { schemaVersion: 1, recordId: id, runId: `${input.productRunId}:${input.toolCallId}`, originConversationId: input.conversationId, at, date: this.host.date(), summary: "拆解已保存，尚未提炼完成", sources: selected.map(p => ({ path: p, fingerprint: fingerprints[p], status: "failed", evidencePaths: [] })), result: createKnowledgeMaintenanceResultEnvelope({ status: "partial", issues: [{ code: "p1_pending", message: "维护阶段尚未完成" }] }), p1: { version: 1, phase: "plan", sourceFingerprints: fingerprints, folderBindingsRevision: input.folderBindingsRevision, decompositions: JSON.parse(JSON.stringify(decompositions)), writingPlan: [], drafts: {}, committedPages: {}, finalizedSources: [] } };
      await this.host.save(record);
      return this.receipt(record, "拆解已保存；下一步stage=plan提交写作清单。");
    }
    if (!record) {
      const complete = records.find(r => r.originConversationId === input.conversationId && r.p1?.phase === "completed" && (!selected.length || selected.every(p => r.sources.some(s => s.path === p))));
      if (complete && action.stage === "resume") return this.receipt(complete, "该清单已完成，成功页没有重写。");
      throw new Error("没有未完成清单；先stage=decompose。");
    }
    const state = record.p1!;
    if (state.folderBindingsRevision !== input.folderBindingsRevision) throw new Error("维护期间目录配置已变化，原清单保留，停止写入。");
    await this.assertSources(record);
    if (action.stage === "plan") {
      if (state.phase !== "plan") return this.receipt(record, "写作清单已固定，使用resume继续，不覆盖已有目标。");
      if (!Array.isArray(action.writingPlan) || action.writingPlan.length > 100) throw new Error("需要明确的writingPlan数组。");
      const ids = new Set<string>(), targets = new Set<string>();
      const plan: MaintenanceWritingItem[] = [];
      for (const item of action.writingPlan) {
        if (!item || !/^[A-Za-z0-9_-]{1,80}$/u.test(item.id) || ids.has(item.id) || !Array.isArray(item.sourcePaths) || !item.sourcePaths.length || new Set(item.sourcePaths).size !== item.sourcePaths.length || item.sourcePaths.some(p => !record!.sources.some(s => s.path === p))) throw new Error("清单ID、来源或条目无效。");
        const targetPath = await this.host.targetPath(item.targetPath);
        if (targets.has(targetPath)) throw new Error("同一目标只安排一页；先聚合重复知识点。");
        const before = await this.host.read(targetPath);
        if (!item.expectedTarget || (item.expectedTarget.kind === "missing" ? before !== null : item.expectedTarget.kind !== "file" || before === null || revision(before) !== item.expectedTarget.contentRevision)) throw new Error(`目标版本已变化，请重新note_read：${targetPath}`);
        if (before !== null && input.observedTargetRevisions?.[targetPath] !== revision(before)) throw new Error(`已有页必须先note_read当前版本：${targetPath}`);
        ids.add(item.id); targets.add(targetPath); plan.push({ ...item, targetPath, sourcePaths: [...item.sourcePaths] });
      }
      for (const d of state.decompositions) if (d.units.length && !plan.some(p => p.sourcePaths.includes(d.sourcePath))) throw new Error(`有知识点的来源未安排任何页：${d.sourcePath}`);
      state.writingPlan = plan; state.phase = "write";
      holdMaintenancePages(record.recordId, this.host.vaultRootPath, plan.map(p => p.targetPath));
      await this.host.save(record);
      if (!plan.length) await this.finalize(input, record);
      return this.receipt(record, "写作清单已持久化；按pendingPages逐页write。尚无草稿的页需继续写作。");
    }
    if (action.stage === "sections") {
      const item = state.writingPlan.find(p => p.targetPath === action.targetPath);
      if (!item || item.expectedTarget.kind !== "file") throw new Error("sections只能读取本清单内已有页。");
      const before = await this.host.read(item.targetPath);
      if (before === null || revision(before) !== item.expectedTarget.contentRevision) throw new Error("目标已变化，停止该清单；重新读取目标并在未提交前修订目标版本。");
      const snapshot = createMaintenanceSectionSnapshot(before);
      state.sectionSnapshots ??= {};
      state.sectionSnapshots[item.targetPath] = snapshot;
      await this.host.save(record);
      return { status: "completed", recordId: record.recordId, maintenanceStage: "sections", processedSourcePaths: [], message: JSON.stringify({ stage: "sections", targetPath: item.targetPath, snapshot, virtualRegions: { sources: `${snapshot.revision}:sources:new`, related: `${snapshot.revision}:related:new` } }) };
    }
    if (state.phase === "plan") return this.receipt(record, "尚未汇总；请先stage=plan。");
    if (action.stage === "write") {
      const item = state.writingPlan.find(p => p.id === action.pageId);
      if (!item) throw new Error("pageId不在固定清单内。");
      if (state.committedPages[item.id]) return this.receipt(record, "这页已成功，保留原页，不重复写入。");
      if (!state.drafts[item.id]) {
        let content: string;
        if (item.expectedTarget.kind === "missing") {
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
            content += `\n\n## ${kind === "related" ? "相关条目" : "来源"}\n${patch.content}`;
          }
        }
        const baseline = item.expectedTarget.kind === "file" ? (await this.host.read(item.targetPath)) ?? undefined : undefined;
        content = await this.host.preparePageContent?.(item, content, baseline) ?? content;
        content = await this.withSources(content, item, record, baseline);
        state.drafts[item.id] = { content, toolCallId: `${record.recordId}:${item.id}` };
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
    const preserved = retained.map(([source, revision]) => `[[${source}|原始材料]]${eol}<!-- echoink-source: ${JSON.stringify({ path: source, revision })} -->`).join(eol);
    const links = (preserved ? preserved + eol : "") + item.sourcePaths.map(p => `[[${p}|原始材料]]${eol}<!-- echoink-source: ${JSON.stringify({ path: p, revision: `sha256:${record.p1!.sourceFingerprints[p].split(":").at(-1)}` })} -->`).join(eol);
    if (!region) return content + `${eol}${eol}## 来源${eol}${links}${eol}`;
    // This is the only program-managed area; all other bytes stay verbatim.
    let sourceContent = content.slice(region.contentStart, region.end);
    for (const p of item.sourcePaths) sourceContent = sourceContent.replace(/<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu, (marker, json: string) => { try { return JSON.parse(json).path === p ? "" : marker; } catch { return marker; } });
    return content.slice(0, region.contentStart) + sourceContent + `${eol}${links}${eol}` + content.slice(region.end);
  }
  private async writePage(input: Readonly<PiKnowledgeMaintenanceToolInput>, item: MaintenanceWritingItem, record: KnowledgeMaintenanceRecord): Promise<void> {
    const state = record.p1!, draft = state.drafts[item.id];
    if (!draft || state.committedPages[item.id]) return;
    await serializeMaintenancePage(this.host.vaultRootPath, item.targetPath, async () => {
      await this.assertSources(record);
      const current = await this.host.read(item.targetPath);
      // Crash after write before receipt: authenticate exact bytes, then checkpoint only.
      if (current !== draft.content) {
        if (item.expectedTarget.kind === "missing" ? current !== null : current === null || revision(current) !== item.expectedTarget.contentRevision) throw new Error(`目标并发编辑冲突：${item.targetPath}；请重新读取，保留当前内容。`);
        if (!await this.host.commit({ ...input, p1RecordId: record.recordId, toolCallId: draft.toolCallId }, item, draft.content)) throw new Error(`页写入失败：${item.targetPath}；草稿与成功页已保留，可resume。`);
      }
      const readback = await this.host.read(item.targetPath);
      if (readback !== draft.content) throw new Error(`页回读不一致：${item.targetPath}`);
      state.committedPages[item.id] = { path: item.targetPath, contentRevision: revision(readback) };
      await this.host.save(record);
    });
  }
  private async finalize(input: Readonly<PiKnowledgeMaintenanceToolInput>, record: KnowledgeMaintenanceRecord): Promise<void> {
    const state = record.p1!;
    for (const source of record.sources) {
      if (state.finalizedSources.includes(source.path)) continue;
      const pages = state.writingPlan.filter(p => p.sourcePaths.includes(source.path));
      if (pages.some(p => !state.committedPages[p.id])) continue;
      await this.assertSources(record);
      const before = await this.host.read(source.path);
      if (before === null) throw new Error("原文暂不可读，反链待恢复。");
      const fields: MaintenanceSourceFields = { status: "已提炼", summary: state.decompositions.find(d => d.sourcePath === source.path)!.summary, targetPaths: pages.map(p => p.targetPath) };
      const content = patchMaintenanceSourceFrontmatter(before, fields);
      if (content !== before && !await this.host.commit({ ...input, p1RecordId: record.recordId, toolCallId: `${record.recordId}:source:${hash(source.path).slice(0, 16)}` }, { id: "source", targetPath: source.path, sourcePaths: [source.path], expectedTarget: { kind: "file", contentRevision: revision(before) } }, content, fields)) throw new Error(`知识页已保存，原文反链待恢复：${source.path}；resume只补原文。`);
      if (await this.host.read(source.path) !== content) throw new Error(`原文反链回读失败：${source.path}`);
      state.finalizedSources.push(source.path); source.status = "processed"; source.evidencePaths = pages.map(p => p.targetPath);
      await this.host.save(record);
    }
    if (record.sources.every(s => state.finalizedSources.includes(s.path))) { state.phase = "completed"; }
    else state.phase = state.writingPlan.every(p => state.committedPages[p.id]) ? "finalize" : "write";
    record.result = createKnowledgeMaintenanceResultEnvelope({ status: state.phase === "completed" ? state.writingPlan.length ? "completed" : "noop" : "partial", issues: state.phase === "completed" ? [] : [{ code: "p1_pending", message: "维护阶段尚未完成" }], notes: state.writingPlan.filter(p => state.committedPages[p.id]).map(p => knowledgeMaintenanceNoteFromReadback({ operation: p.expectedTarget.kind === "missing" ? "created" : "updated", path: p.targetPath, content: state.drafts[p.id].content })) });
    record.summary = state.phase === "completed" ? "知识清单与原文双链已完成" : "清单部分完成，保留未完页与反链";
    await this.host.save(record);
    if (state.phase === "completed") releaseMaintenancePages(record.recordId);
  }
  private receipt(record: KnowledgeMaintenanceRecord, message: string): PiKnowledgeMaintenanceToolResult {
    const state = record.p1!;
    return { status: "completed", recordId: record.recordId, maintenanceStage: state.phase === "decompose" ? "plan" : state.phase, processedSourcePaths: record.sources.filter(s => s.status === "processed").map(s => s.path), ...(state.phase === "completed" ? { maintenanceResult: record.result, producedPaths: Object.values(state.committedPages).map(p => p.path) } : {}), message: `${message}\n${JSON.stringify({ recordId: record.recordId, phase: state.phase, decompositions: state.decompositions, pendingPages: state.writingPlan.filter(p => !state.committedPages[p.id]).map(p => ({ ...p, hasDraft: !!state.drafts[p.id] })), committedPages: state.committedPages, pendingFinalization: record.sources.filter(s => !state.finalizedSources.includes(s.path)).map(s => s.path) })}` };
  }
}

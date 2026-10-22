import { MaintenanceP1Workflow } from "../knowledge-base/maintenance-p1-workflow";
import { collectMaintenanceCandidates } from "../knowledge-base/maintenance-dedup";
import { planMaintenanceDomainMaps } from "../knowledge-base/maintenance-domain-map";
import { KnowledgeMaintenancePreferenceRepository } from "../knowledge-base/knowledge-maintenance-preferences";
import type { MaintenanceDomainMapEntry, MaintenanceKnowledgeUnit, MaintenanceWikiDocument } from "../knowledge-base/maintenance-p2-contract";
import { maintenanceVisibleClassification } from "../knowledge-base/maintenance-p2-planning";
import { isMaintenanceSourceProcessed } from "../knowledge-base/maintenance-source-state";
import type { MaintenanceWritingItem, MaintenanceSourceFields } from "../knowledge-base/maintenance-p1-contract";
import { knowledgeBodyLinkSpans } from "../knowledge-base/knowledge-relations";
import { readKnowledgeLinkingDocument, buildKnowledgeLinkingTargets, deferKnowledgeLinkingNewLinks, validateKnowledgeLinkingNewLinks } from "../knowledge-base/knowledge-linking";
import type { KnowledgeLinkingDocument } from "../knowledge-base/knowledge-linking-types";
import { rebaseKnowledgePathRecords } from "../knowledge-base/root-paths-core";
import { latestMaintenanceSourceStates, type KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { knowledgeMaintenanceNoteFromReadback } from "../knowledge-base/knowledge-maintenance-result";
import { readRawDigestRegistry, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { registerKnowledgePrivateRoot, knowledgePrivateRoot } from "../knowledge-base/root-paths";
import { knowledgePathPolicy, knowledgePathRole, getKnowledgeFolderBindings, knowledgeRolePath, resolveKnowledgePath } from "../knowledge-base/root-paths";
import { knowledgeErrorDetail } from "../knowledge-base/initialization-error";
import { canonicalRawMarkdownForDigest, rawDigestFingerprint, isRawMarkdownPath, isKnowledgeMaintenanceSourcePath, rawDigestRecordFromMarkdown } from "../knowledge-base/raw-digest";
import { rawDigestStateForRecord } from "../knowledge-base/digest-status";
import { isBilingualWikiFolder, wikiFolderEnglishId } from "../knowledge-base/wiki-folder-names";
import { knowledgeMayCreateCategoryDirectory } from "../knowledge-base/folder-organization";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath
} from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type {
  PiKnowledgeMaintenanceToolInput,
  PiKnowledgeMaintenanceToolPort,
  PiKnowledgeMaintenanceToolResult
} from "../harness/pi-native/contracts";
import {
  atomicWriteJsonFile,
  isNodeErrorWithCode,
  readJsonFileIfPresent,
  serializePiNativeFileWrite
} from "../harness/pi-native/file-store-utils";
import type {
  VaultDomainService
} from "../harness/pi-native/vault-domain-service";
import { normalizeVaultRelativePath } from "../harness/pi-native/vault-target-resolver";
import {
  PHASE3_MAINTENANCE_RAW_INDEX_PATH,
  PHASE3_MAINTENANCE_TRACKER_PATH,
  Phase3KnowledgeMaintenanceService,
  Phase3MaintenanceError,
  type Phase3MaintenanceFaultPoint,
  type Phase3MaintenanceImmutableFileBinding,
  type Phase3MaintenanceProposal,
  type Phase3MaintenanceProposalAction,
  type Phase3MaintenanceProposalInput,
  type Phase3MaintenanceProposalPort,
  type Phase3MaintenanceSourceBinding,
  type Phase3MaintenanceSourceSnapshotPort,
  type Phase3MaintenanceStateStore,
  type Phase3MaintenanceStoredPreview,
  type Phase3MaintenanceTrackerPort,
  type Phase3MaintenanceTrackerSnapshot,
  type Phase3MaintenanceWalRecord
} from "../knowledge-base/phase3-maintenance-service";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
  echoInkKnowledgeMaintenanceProtocolPrompt,
  completeKnowledgeMaintenanceCandidateSources,
  validateKnowledgeMaintenanceCandidateSources
} from "../knowledge-base/knowledge-maintenance-protocol";
import {
  createKnowledgeMaintenanceResultEnvelope,
  parseKnowledgeMaintenanceResultEnvelope
} from "../knowledge-base/knowledge-maintenance-result";
import {
  KnowledgeAgentIndex,
  type KnowledgeAgentReliableRawKnowledge
} from "../knowledge-base/knowledge-agent-index";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LINKING_BACKGROUND_RECEIPT = "正文已写入并回读；本批正文的首次提及链接和老笔记反向关联由后台任务统一完成。关联仍可能进行中，不要为补链接反复调用 knowledge_maintain 或重写正文；不要把正文写入成功说成关联已完成。";
const CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export interface KnowledgeMaintenanceTerminalEvent {
  readonly input: Readonly<PiKnowledgeMaintenanceToolInput>;
  readonly result: Readonly<PiKnowledgeMaintenanceToolResult>;
  readonly at: number;
}

export interface CreateProductionPiKnowledgeMaintenanceOptions {
  readonly onTerminal?: (event: KnowledgeMaintenanceTerminalEvent) => void | Promise<void>;
  readonly vaultRootPath: string;
  readonly privateKnowledgeRootPath: string;
  readonly vaultId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly domainService: VaultDomainService;
  readonly knowledgeAgentIndex?: Pick<
    KnowledgeAgentIndex,
    "readReliableKnowledgeForRaw"
  > & Partial<Pick<KnowledgeAgentIndex, "scanLinkingDocuments" | "refresh" | "search">>;
  readonly automaticLinkingEnabled?: () => boolean;
  readonly processedSources?: () => Readonly<Record<string, { fingerprint?: string }>>;
  readonly now?: () => number;
  readonly createPreviewId?: () => string;
  readonly dateKey?: () => string;
  readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
  /** Reconcile private derived state after a confirmed Vault readback. */
  readonly onCommitted?: (
    producedPaths: readonly string[],
    linkingTargets?: readonly string[],
    taskId?: string,
    originConversationId?: string
  ) => void | string | Promise<void | string>;
  /** Opt in only when onCommitted schedules the shared outbound/reverse linking job. */
  readonly linkingOwnsDraftLinks?: boolean;
  /** Test-only naming seam for the frozen Manifest's exact WAL paths. */
  readonly walFileId?: (previewId: string) => string;
}

/**
 * Production Phase 3 boundary behind the one `knowledge_maintain` Pi Tool.
 * It owns no Agent, Session, Tool loop, or transcript. Preview/control bytes
 * stay below `.echoink/`; every formal write goes through VaultDomainService.
 */
export class ProductionPiKnowledgeMaintenanceToolPort
implements PiKnowledgeMaintenanceToolPort {
  readonly state: FilePhase3MaintenanceStateStore;
  private readonly p1: MaintenanceP1Workflow;
  private readonly maintenanceIndex: Pick<KnowledgeAgentIndex, "scanLinkingDocuments" | "search" | "refresh">;

  private readonly onTerminal?: CreateProductionPiKnowledgeMaintenanceOptions["onTerminal"];
  private readonly vaultRootPath: string;
  private readonly privateKnowledgeRootPath: string;
  private readonly vaultId: string;
  private readonly userId: string;
  private readonly deviceId: string;
  private readonly domainService: VaultDomainService;
  private readonly knowledgeAgentIndex?: Pick<
    KnowledgeAgentIndex,
    "readReliableKnowledgeForRaw"
  > & Partial<Pick<KnowledgeAgentIndex, "scanLinkingDocuments" | "refresh" | "search">>;
  private readonly automaticLinkingEnabled: () => boolean;
  private readonly processedSources?: CreateProductionPiKnowledgeMaintenanceOptions["processedSources"];
  private readonly sources: FilePhase3MaintenanceSourceSnapshotPort;
  private readonly tracker: Phase3MaintenanceTrackerPort;
  private readonly now: () => number;
  private readonly createPreviewId: () => string;
  private readonly dateKey: () => string;
  private readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
  private readonly onCommitted?: (
    producedPaths: readonly string[],
    linkingTargets?: readonly string[],
    taskId?: string,
    originConversationId?: string
  ) => void | string | Promise<void | string>;
  private readonly linkingOwnsDraftLinks: boolean;

  constructor(
    options: Readonly<CreateProductionPiKnowledgeMaintenanceOptions>
  ) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
    this.privateKnowledgeRootPath = path.resolve(
      options.privateKnowledgeRootPath
    );
    registerKnowledgePrivateRoot(this.vaultRootPath, this.privateKnowledgeRootPath);
    this.vaultId = requireNonEmpty(options.vaultId, "vaultId");
    this.userId = requireNonEmpty(options.userId, "userId");
    this.deviceId = requireNonEmpty(options.deviceId, "deviceId");
    this.domainService = options.domainService;
    this.knowledgeAgentIndex = options.knowledgeAgentIndex;
    this.maintenanceIndex = options.knowledgeAgentIndex?.scanLinkingDocuments && options.knowledgeAgentIndex?.search && options.knowledgeAgentIndex?.refresh
      ? options.knowledgeAgentIndex as Pick<KnowledgeAgentIndex, "scanLinkingDocuments" | "search" | "refresh">
      : new KnowledgeAgentIndex({ vaultPath: this.vaultRootPath, storageRootPath: this.privateKnowledgeRootPath });
    this.automaticLinkingEnabled = options.automaticLinkingEnabled ?? (() => true);
    this.processedSources = options.processedSources;
    this.now = options.now ?? Date.now;
    this.createPreviewId = options.createPreviewId ?? randomUUID;
    this.dateKey = options.dateKey ?? localDateKey;
    this.faultInjector = options.faultInjector;
    this.onCommitted = options.onCommitted;
    this.linkingOwnsDraftLinks = Boolean(options.linkingOwnsDraftLinks && options.onCommitted);
    this.onTerminal = options.onTerminal;
    this.state = new FilePhase3MaintenanceStateStore({
      storageRootPath: this.privateKnowledgeRootPath,
      vaultId: this.vaultId,
      vaultRootPath: this.vaultRootPath,
      walFileId: options.walFileId
    });
    this.sources = new FilePhase3MaintenanceSourceSnapshotPort({
      vaultRootPath: this.vaultRootPath,
      vaultId: this.vaultId
    });
    this.tracker = new PrivateMaintenanceTrackerPort(this.vaultRootPath);
    this.p1 = new MaintenanceP1Workflow({
      vaultRootPath: this.vaultRootPath,
      records: () => readPrivateMaintenanceRecords(this.privateKnowledgeRootPath, { vaultId: this.vaultId }),
      processedSources: (paths, records) => readProcessedMaintenanceSources(this.vaultRootPath, paths, records, this.processedSources?.()),
      save: record => this.state.saveP1Record(record),
      read: async relative => { const file = await readImmutableFileIfPresent(this.vaultRootPath, relative); return file ? UTF8_DECODER.decode(file.bytes) : null; },
      sourcePath: relative => { const actual = resolveKnowledgePath(this.vaultRootPath, normalizeVaultRelativePath(relative), false); if (!["raw", "inbox"].includes(knowledgePathRole(this.vaultRootPath, actual) ?? "") || !isKnowledgeMaintenanceSourcePath(actual)) throw new Error("来源不在Raw/Inbox范围"); return actual; },
      targetPath: async relative => { const actual = await this.normalizeCandidateTarget(relative); if (knowledgePathRole(this.vaultRootPath, actual) !== "wiki") throw new Error("P1只写Wiki"); return actual; },
      preparePageContent: (item, content, baseline) => this.prepareP1PageContent(item, content, baseline),
      candidates: units => this.maintenanceCandidates(units),
      planMaps: entries => this.maintenanceMaps(entries),
      refresh: async () => { await this.maintenanceIndex.refresh(); },
      templateNotice: async () => (await new KnowledgeMaintenancePreferenceRepository(this.privateKnowledgeRootPath).read()).templateNotice,
      commit: (input, item, content, fields) => this.commitP1Action(input, item, content, fields),
      now: this.now, date: this.dateKey
    });

  }

  async initialize(): Promise<void> {
    await this.state.initialize();
    await this.createService(
      new UnavailableMaintenanceProposalPort()
    ).recoverPendingOrThrow(this.vaultId);
    await this.p1.restoreHolds();
    // Only WALs carrying this feature's explicit intent can schedule work.
    // Starting persists a task but never waits for its runtime/judge flight.
    for (const record of await this.state.pendingLinkingRecords()) await this.ensurePendingLinking(record);
  }

  async execute(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    this.assertIdentity(input);
    if (input.folderBindingsRevision !== undefined && input.folderBindingsRevision !== (getKnowledgeFolderBindings(this.vaultRootPath)?.revision ?? 0)) return { status: "failed", errorCode: "preview_stale", processedSourcePaths: [], message: "知识库目录已变化，请重新读取。" };
    let result = await this.p1.execute(input);
    if (result.maintenanceResult && result.recordId) {
      try { await this.onTerminal?.({ input, result, at: this.now() }); } catch (error) { console.error("EchoInk maintenance history could not be saved", knowledgeErrorDetail(error)); }
      if (result.producedPaths?.length && this.onCommitted && result.recordId && input.p1?.stage !== "decompose") {
        const record = await readPrivateMaintenanceRecord(this.privateKnowledgeRootPath, result.recordId, this.vaultId);
        if (record?.p1 && !record.result.linkingTaskId) {
          record.pendingLinking ??= { taskId: record.recordId, sourcePaths: [...result.producedPaths], targetPaths: record.p1.writingPlan.filter(item => item.expectedTarget.kind === "missing").map(item => item.targetPath) };
          await this.state.saveP1Record(record);
          const settled = await this.ensurePendingLinking(record);
          result = { ...result, maintenanceResult: settled.result, message: settled.result.linkingTaskId ? `${result.message}\n${LINKING_BACKGROUND_RECEIPT}` : `${result.message}\n${settled.result.issues.filter(issue => issue.code === "linking_start_failed").map(issue => issue.message).join("\n")}` };
        }
      }
    }
    return result;
  }

  private async maintenanceWikiDocuments(): Promise<MaintenanceWikiDocument[]> {
    const documents: MaintenanceWikiDocument[] = [];
    for await (const doc of this.maintenanceIndex.scanLinkingDocuments()) if (knowledgePathRole(this.vaultRootPath, doc.path) === "wiki") documents.push({ path: doc.path, title: doc.title, aliases: doc.aliases, contentRevision: doc.version, content: doc.content });
    return documents;
  }
  private async maintenanceCandidates(units: readonly MaintenanceKnowledgeUnit[]) {
    // Refresh on each batch, independently of optional background linking.
    await this.maintenanceIndex.refresh();
    const documents = (await this.maintenanceWikiDocuments()).filter(doc => !doc.content.includes("<!-- echoink-domain-map:BEGIN"));
    const byPath = new Map(documents.map(doc => [doc.path, doc]));
    return collectMaintenanceCandidates(units, {
      listWiki: async () => documents,
      searchWiki: async query => {
        const result = await this.maintenanceIndex.search({ query: query.slice(0, 256), kinds: ["wiki"], limit: 50 });
        return result.hits.flatMap(hit => { const doc = byPath.get(hit.vaultRelativePath); return doc ? [doc] : []; });
      }
    });
  }
  private async maintenanceMaps(entries: readonly MaintenanceDomainMapEntry[]) {
    if (!entries.length) return [];
    const existing = await this.maintenanceWikiDocuments(), domains = new Set(entries.map(entry => entry.domain));
    const all = new Map<string, MaintenanceDomainMapEntry>(), historical = new Map<string, MaintenanceDomainMapEntry>();
    // Latest successful receipts fill missing fields; current visible attributes remain authoritative.
    for (const record of (await readPrivateMaintenanceRecords(this.privateKnowledgeRootPath, { vaultId: this.vaultId })).sort((a,b) => b.at - a.at)) if (record.p1?.p2) {
      for (const item of record.p1.writingPlan) {
        const unit = record.p1.decompositions.flatMap(d => d.units).find(unit => typeof unit !== "string" && item.knowledge?.unitIds.includes(unit.id));
        if (unit && typeof unit !== "string" && record.p1.committedPages[item.id] && !historical.has(item.targetPath)) historical.set(item.targetPath, { path: item.targetPath, title: unit.title, domain: item.knowledge?.domain ?? unit.domain, type: item.knowledge?.type ?? unit.type });
      }
    }
    for (const doc of existing) {
      if (doc.content.includes("<!-- echoink-domain-map:BEGIN")) continue;
      const visible = maintenanceVisibleClassification(doc.content), prior = historical.get(doc.path);
      const type = visible.type ?? prior?.type, domain = visible.domain ?? prior?.domain;
      if (type && domain && domains.has(domain)) all.set(doc.path, { path: doc.path, title: doc.title, type, domain });
    }
    for (const entry of entries) {
      const doc = existing.find(doc => doc.path === entry.path), visible = doc ? maintenanceVisibleClassification(doc.content) : {};
      all.set(entry.path, { ...entry, type: visible.type ?? entry.type, domain: visible.domain ?? entry.domain });
    }
    const wikiRoot = getKnowledgeFolderBindings(this.vaultRootPath)?.roles.wiki.writePath ?? "wiki";
    return planMaintenanceDomainMaps({ wikiRoot, entries: [...all.values()], existing });
  }

  /** Preserve the existing new-link safety/defer boundary without touching retained links. */
  private async prepareP1PageContent(item: MaintenanceWritingItem, content: string, baseline?: string): Promise<string> {
    const documents: KnowledgeLinkingDocument[] = [];
    if (this.knowledgeAgentIndex?.scanLinkingDocuments) for await (const doc of this.knowledgeAgentIndex.scanLinkingDocuments()) documents.push(doc);
    for (const target of new Set([...item.sourcePaths, ...knowledgeBodyLinkSpans(content).map(span => span.target.split("#")[0])])) {
      if (!target.includes("/") || /^(?:[a-z][a-z0-9+.-]*:|\/|\.\.)/iu.test(target)) continue;
      try {
        const relative = resolveKnowledgePath(this.vaultRootPath, normalizeVaultRelativePath(/\.(?:md|markdown)$/iu.test(target) ? target : `${target}.md`), false);
        if (!["wiki", "projects", "raw", "inbox"].includes(knowledgePathRole(this.vaultRootPath, relative) ?? "") || documents.some(doc => doc.path === relative)) continue;
        const current = await readImmutableFileIfPresent(this.vaultRootPath, relative);
        if (current) documents.push(readKnowledgeLinkingDocument(relative, UTF8_DECODER.decode(current.bytes), `sha256:${current.sha256}`));
      } catch { /* Unknown links stay subject to the ordinary new-link validator. */ }
    }
    const targets = buildKnowledgeLinkingTargets(documents);
    const checked = validateKnowledgeLinkingNewLinks(content, item.targetPath, targets, baseline);
    return this.linkingOwnsDraftLinks ? deferKnowledgeLinkingNewLinks(checked.content, item.targetPath, targets.filter(target => ["wiki", "projects"].includes(knowledgePathRole(this.vaultRootPath, target.path) ?? "")), baseline) : checked.content;
  }

  private maintenancePolicy(relative: string): string {
    const policy = knowledgePathPolicy(this.vaultRootPath, relative);
    return knowledgePathRole(this.vaultRootPath, relative) === "inbox" ? `raw/${relative}` : policy;
  }

  private async commitP1Action(input: Readonly<PiKnowledgeMaintenanceToolInput>, item: MaintenanceWritingItem, content: string, sourceFields?: MaintenanceSourceFields): Promise<boolean> {
    const preference = requirePreferenceSnapshot(input.preferenceSnapshot);
    const sourcePaths = item.sourcePaths;
    const before = await readImmutableFileIfPresent(this.vaultRootPath, item.targetPath);
    const proposal: Phase3MaintenanceProposalPort = { generate: async request => {
      if (!sourceFields) validateKnowledgeMaintenanceCandidateSources({ targetPath: item.targetPath, content, ...(before ? { baselineContent: UTF8_DECODER.decode(before.bytes) } : {}), selectedSources: request.selectedSources.map(source => ({ relativePath: source.raw.relativePath, contentSha256: source.raw.contentSha256 })) }, relative => this.maintenancePolicy(relative));
      return { shadowId: request.previewId, shadowRevision: sha256(content), actions: [{ targetPath: item.targetPath, content, expectedTarget: item.expectedTarget, ...(before ? { baselineContent: UTF8_DECODER.decode(before.bytes) } : {}), ...(sourceFields ? { sourceFields } : {}) }], bookkeeping: { p1RecordId: input.p1RecordId, readSourcePaths: sourcePaths, failedSourcePaths: sourcePaths, issues: [] } };
    } };
    const result = await this.createService(proposal).execute({ vaultId: this.vaultId, dateKey: this.dateKey(), explicitRawPaths: sourcePaths, preference, toolCall: { productRunId: input.productRunId, toolCallId: input.toolCallId, conversationId: input.conversationId, piSessionId: input.piSessionId, vaultId: input.vaultId, userId: this.userId, deviceId: this.deviceId }, ...(input.signal ? { signal: input.signal } : {}) });
    if (result.issues.some(issue => issue.code === "record_pending")) throw new Phase3MaintenanceError("record_pending", "页面已写入，私有收尾待恢复；请resume，成功页不会重写。");
    return result.appliedPaths.includes(item.targetPath);
  }

  private async ensurePendingLinking(record: KnowledgeMaintenanceRecord): Promise<KnowledgeMaintenanceRecord> {
    const pending = record.pendingLinking;
    if (!pending) return record;
    const successful = new Set(record.result.notes.map(note => note.path));
    const sources = pending.sourcePaths.filter(source => successful.has(source));
    const targets = pending.targetPaths.filter(target => successful.has(target));
    try {
      await this.knowledgeAgentIndex?.refresh?.();
      if (!this.automaticLinkingEnabled()) return record;
      if (!this.onCommitted) throw new Error("当前环境未接入后台关联调度器。");
      const taskId = await this.onCommitted(sources, targets, pending.taskId, record.originConversationId);
      if (!taskId) throw new Error("调度器未返回任务。");
      await this.faultInjector?.("after-linking-enqueue");
      await this.state.updateLinkingMetadata(record.recordId, createKnowledgeMaintenanceResultEnvelope({ ...record.result,
        linkingTaskId: taskId,
        issues: record.result.issues.filter(issue => issue.code !== "linking_start_failed")
      }), LINKING_BACKGROUND_RECEIPT);
    } catch (error) {
      if (!this.automaticLinkingEnabled()) return record;
      await this.state.updateLinkingMetadata(record.recordId, createKnowledgeMaintenanceResultEnvelope({ ...record.result,
        issues: [...record.result.issues.filter(issue => issue.code !== "linking_start_failed"), { code: "linking_start_failed", message: `知识已写入，关联补全待恢复：${knowledgeErrorDetail(error)}` }]
      }), "知识已写入；关联补全待恢复，原稿保留。");
    }
    return await readPrivateMaintenanceRecord(this.privateKnowledgeRootPath, record.recordId, this.vaultId) ?? record;
  }

  async finalizeNatural(request: Parameters<NonNullable<import("../harness/pi-native/contracts").PiKnowledgeRuntimePort["finalizeMaintenance"]>>[0]): Promise<Readonly<import("../harness/pi-native/contracts").PiKnowledgeMaintenanceSettlement>> {
    const records = await readPrivateMaintenanceRecords(this.privateKnowledgeRootPath, { vaultId: this.vaultId });
    const scope = request.scope;
    const paths = scope?.mode === "global" ? scope.sourcePaths ?? request.noteReadPaths : scope?.mode === "exact" || scope?.mode === "batch" ? scope.sourcePaths : scope?.mode === "query" ? scope.candidatePaths : request.noteReadPaths;
    const selected = [...new Set(paths)].filter(relative => ["raw", "inbox"].includes(knowledgePathRole(this.vaultRootPath, relative) ?? ""));
    // A no-record success must come from the production Tool's verified read-only
    // receipt in this turn, never merely from a completed assistant response.
    const noop = request.terminalState === "completed" && selected.length > 0 && (request.turnEntries ?? []).some(entry => {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "knowledge_maintain" || entry.message.isError) return false;
      const details = entry.message.details as Record<string, unknown> | undefined;
      return details?.source === "echoink-knowledge-maintenance" && details.status === "completed" && parseKnowledgeMaintenanceResultEnvelope(details.maintenanceResult)?.status === "noop" && Array.isArray(details.processedSourcePaths) && selected.every(relative => (details.processedSourcePaths as unknown[]).includes(relative));
    });
    const unfinished = records.find(record => record.p1 && record.p1.phase !== "completed" && record.sources.some(source => selected.includes(source.path)));
    if (noop && !unfinished) return { processedSourcePaths: selected, pendingSourcePaths: [], warnings: [] };
    const staged = unfinished?.originConversationId === request.conversationId ? unfinished : records.find(record => record.originConversationId === request.conversationId && record.p1 && record.sources.some(source => selected.includes(source.path)));
    if (unfinished && staged?.p1?.phase === "completed") return { processedSourcePaths: [], pendingSourcePaths: selected, warnings: ["这些来源仍有历史未完成清单，请回到原会话继续。"] };
    if (staged?.p1) {
      const recorded = staged.sources.filter(source => source.status === "processed" && selected.includes(source.path)).map(source => source.path);
      const processedSourcePaths = staged.p1.phase === "completed" ? request.terminalState === "completed" ? await readProcessedMaintenanceSources(this.vaultRootPath, recorded, records, this.processedSources?.()) : [] : recorded;
      return { processedSourcePaths, pendingSourcePaths: selected.filter(relative => !processedSourcePaths.includes(relative)), warnings: staged.p1.phase === "completed" ? [] : ["维护清单尚未完成，继续原清单；来源保持待处理。"] };
    }
    return { processedSourcePaths: [], pendingSourcePaths: selected, warnings: ["尚未通过拆解、汇总与收尾门禁，来源保持待处理。"] };
  }


  private async normalizeCandidateTarget(value: string): Promise<string> {
    const target = resolveKnowledgePath(this.vaultRootPath, normalizeVaultRelativePath(value));
    if (!/^(wiki|projects)\//u.test(knowledgePathPolicy(this.vaultRootPath, target)) || !target.endsWith(".md") || target.split("/").some((part) => part.startsWith("."))) throw new Error("候选只可写入 wiki 或 projects 的 Markdown。");
    const config = getKnowledgeFolderBindings(this.vaultRootPath);
    if (config) {
      const role = knowledgePathRole(this.vaultRootPath, target);
      if (role !== "wiki" && role !== "projects") throw new Error("知识成果位置未启用或不在绑定范围中。");
      const binding = config.roles[role];
      const root = binding.writePath;
      if (!root || !target.startsWith(`${root}/`)) throw new Error("候选不在当前默认知识成果保存位置中。");
      const segments = target.slice(root.length + 1).split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        const child = segments.slice(0, depth).join("/");
        const parent = path.join(this.vaultRootPath, root, child);
        const stat = await lstat(parent).catch(error => { if (isNodeErrorWithCode(error, "ENOENT")) return null; throw error; });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`目标父目录不可用：${root}/${child}`);
        if (!stat && !knowledgeMayCreateCategoryDirectory(config, `${root}/${child}`)) throw new Error(`尚未允许创建子目录：${root}/${child}；本候选保留待处理。`);
      }
      return target;
    }
    if (!knowledgePathPolicy(this.vaultRootPath, target).startsWith("wiki/")) return target;
    const parts = target.split("/");
    for (let depth = 1; depth < parts.length - 1; depth++) {
      const parent = parts.slice(0, depth).join("/");
      const name = parts[depth].replace(/^(.+?)\s*\(([a-z][a-z0-9_-]*)\)$/iu, "$1（$2）");
      const siblings: import("node:fs").Dirent[] = await readdir(path.join(this.vaultRootPath, parent), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      const id = wikiFolderEnglishId(name);
      const existing = siblings.find((entry) => entry.isDirectory() && (entry.name === name || (id && wikiFolderEnglishId(entry.name) === id)));
      if (existing) parts[depth] = existing.name;
      else if (isBilingualWikiFolder(name)) parts[depth] = name;
      else throw new Error(`分类 ${name} 需要中文（english-slug）；本候选跳过，其余继续。`);
    }
    return parts.join("/");
  }

  private createService(
    proposal: Phase3MaintenanceProposalPort
  ): Phase3KnowledgeMaintenanceService {
    return new Phase3KnowledgeMaintenanceService({
      resolvePath: (relative) => resolveKnowledgePath(this.vaultRootPath, relative),
      pathPolicy: (relative) => this.maintenancePolicy(relative),
      bindingRevision: () => getKnowledgeFolderBindings(this.vaultRootPath)?.revision ?? 0,
      privateRecords: true,
      finalizeRecord: async (wal) => { await this.faultInjector?.("before-private-record"); await this.state.finalizeRecord(wal); await this.faultInjector?.("after-private-record"); },
      domain: this.domainService,
      sources: this.sources,
      tracker: this.tracker,
      proposal,
      state: this.state,
      createPreviewId: this.createPreviewId,
      now: this.now,
      ...(this.faultInjector ? { faultInjector: this.faultInjector } : {})
    });
  }

  private assertIdentity(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): void {
    if (input.vaultId !== this.vaultId) {
      throw new Phase3MaintenanceError(
        "invalid_input",
        "Knowledge maintenance Tool Call belongs to another Vault"
      );
    }
    for (const key of [
      "conversationId",
      "piSessionId",
      "productRunId",
      "toolCallId"
    ] as const) requireNonEmpty(input[key], key);
  }
}

export function createProductionPiKnowledgeMaintenanceToolPort(
  options: Readonly<CreateProductionPiKnowledgeMaintenanceOptions>
): ProductionPiKnowledgeMaintenanceToolPort {
  return new ProductionPiKnowledgeMaintenanceToolPort(options);
}

interface FilePhase3MaintenanceStateStoreOptions {
  vaultRootPath?: string;
  storageRootPath: string;
  vaultId: string;
  walFileId?: (previewId: string) => string;
}

export class FilePhase3MaintenanceStateStore
implements Phase3MaintenanceStateStore {
  readonly rootPath: string;

  private readonly vaultId: string;
  private readonly walFileId: (previewId: string) => string;
  private readonly vaultRootPath?: string;

  constructor(options: Readonly<FilePhase3MaintenanceStateStoreOptions>) {
    this.vaultId = requireNonEmpty(options.vaultId, "vaultId");
    this.rootPath = path.resolve(options.storageRootPath);
    this.vaultRootPath = options.vaultRootPath;
    this.walFileId = options.walFileId ?? ((previewId) => previewId);
  }

  async initialize(): Promise<void> {
    await assertExistingPrivateStateDirectoriesSafe(this.rootPath);
  }

  /** Provider-independent startup only finishes records whose note actions already settled. */
  async recoverPrivateFinalization(): Promise<number> {
    let recovered = 0;
    for (const wal of await this.listRecoverableWals(this.vaultId)) {
      if (wal.version !== 2 || wal.status === "completed" || wal.status === "blocked" || wal.actions.some(entry => entry.status === "pending" || entry.status === "uncertain")) continue;
      await this.finalizeRecord(wal);
      await this.saveWal({ ...wal, status: "completed", sequence: wal.sequence + 1, updatedAt: Date.now(), error: undefined }, wal.sequence);
      recovered++;
    }
    return recovered;
  }

  async createPreview(
    preview: Parameters<Phase3MaintenanceStateStore["createPreview"]>[0]
  ): Promise<void> {
    this.assertVault(preview.vaultId);
    const previewId = requireControlId(preview.previewId);
    await serializePiNativeFileWrite(this.rootPath, async () => {
      await this.initializeUnlocked();
      const filePath = this.previewPath(previewId);
      if (await readJsonFileIfPresent(filePath, "Phase 3 preview") !== null) {
        throw new Error("phase3_preview_exists");
      }
      await writeControlEnvelope(filePath, this.vaultId, "preview", {
        preview,
        status: "active"
      });
    });
  }

  async loadPreview(
    previewIdInput: string
  ): Promise<Readonly<Phase3MaintenanceStoredPreview> | null> {
    const previewId = requireControlId(previewIdInput);
    const payload = await readControlEnvelope(
      this.previewPath(previewId),
      this.vaultId,
      "preview"
    );
    if (payload === null) return null;
    const stored = requireStoredPreview(payload);
    if (stored.preview.previewId !== previewId) {
      throw new Error("phase3_preview_identity_mismatch");
    }
    this.assertVault(stored.preview.vaultId);
    return stored;
  }

  async listActivePreviews(): Promise<
    readonly Readonly<Phase3MaintenanceStoredPreview>[]
  > {
    await this.initialize();
    let names: string[];
    try {
      names = await readdir(path.join(this.rootPath, "previews"));
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return Object.freeze([]);
      throw error;
    }
    const previews: Readonly<Phase3MaintenanceStoredPreview>[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const previewId = requireControlId(name.slice(0, -".json".length));
      const stored = await this.loadPreview(previewId);
      if (stored?.status === "active") previews.push(stored);
    }
    previews.sort((left, right) =>
      right.preview.createdAt - left.preview.createdAt
      || left.preview.previewId.localeCompare(right.preview.previewId, "en")
    );
    return Object.freeze(previews);
  }

  async setPreviewStatus(
    input: Parameters<Phase3MaintenanceStateStore["setPreviewStatus"]>[0]
  ): Promise<void> {
    const previewId = requireControlId(input.previewId);
    await serializePiNativeFileWrite(this.rootPath, async () => {
      const stored = await this.loadPreview(previewId);
      if (!stored) throw new Error("phase3_preview_missing");
      if (stored.status !== input.expected) {
        throw new Error("phase3_preview_status_conflict");
      }
      await writeControlEnvelope(
        this.previewPath(previewId),
        this.vaultId,
        "preview",
        {
          preview: stored.preview,
          status: input.status,
          ...(input.reason ? { reason: input.reason } : {})
        }
      );
    });
  }

  async createWal(
    wal: Parameters<Phase3MaintenanceStateStore["createWal"]>[0]
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    this.assertVault(wal.preview.vaultId);
    const previewId = requireControlId(wal.preview.previewId);
    return await serializePiNativeFileWrite(this.rootPath, async () => {
      await this.initializeUnlocked();
      const filePath = this.walPath(previewId);
      if (await readJsonFileIfPresent(filePath, "Phase 3 WAL") !== null) {
        throw new Error("phase3_wal_exists");
      }
      return await writeControlEnvelope(
        filePath,
        this.vaultId,
        "wal",
        wal
      );
    });
  }

  async loadWal(
    previewIdInput: string
  ): Promise<Readonly<Phase3MaintenanceWalRecord> | null> {
    const previewId = requireControlId(previewIdInput);
    const payload = await readControlEnvelope(
      this.walPath(previewId),
      this.vaultId,
      "wal"
    );
    if (payload === null) return null;
    const wal = requireWal(payload);
    if (wal.preview.previewId !== previewId) {
      throw new Error("phase3_wal_identity_mismatch");
    }
    this.assertVault(wal.preview.vaultId);
    return wal;
  }

  async listRecoverableWals(
    vaultId: string
  ): Promise<readonly Readonly<Phase3MaintenanceWalRecord>[]> {
    this.assertVault(vaultId);
    let names: string[];
    try {
      names = await readdir(path.join(this.rootPath, "wal"));
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: Phase3MaintenanceWalRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const payload = await readControlEnvelope(
        path.join(this.rootPath, "wal", name),
        this.vaultId,
        "wal"
      );
      if (payload === null) continue;
      const wal = requireWal(payload);
      this.assertVault(wal.preview.vaultId);
      records.push(wal);
    }
    return Object.freeze(records.map((record) => deepFreeze(record)));
  }

  async saveWal(
    wal: Parameters<Phase3MaintenanceStateStore["saveWal"]>[0],
    expectedSequence: number
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    this.assertVault(wal.preview.vaultId);
    const previewId = requireControlId(wal.preview.previewId);
    return await serializePiNativeFileWrite(this.rootPath, async () => {
      const current = await this.loadWal(previewId);
      if (!current) throw new Error("phase3_wal_missing");
      if (current.sequence !== expectedSequence) {
        throw new Error("phase3_wal_sequence_conflict");
      }
      return await writeControlEnvelope(
        this.walPath(previewId),
        this.vaultId,
        "wal",
        wal
      );
    });
  }

  async queueTerminalRecord(input: Readonly<PiKnowledgeMaintenanceToolInput>, record: KnowledgeMaintenanceRecord): Promise<void> {
    if (await this.loadWal(record.recordId)) return;
    const preference = input.preferenceSnapshot ?? { profileVersion: "terminal-v1", state: "default" as const, revision: `sha256:${sha256("terminal")}` };
    const preview = { protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION, preferenceProfileVersion: preference.profileVersion, preferenceState: preference.state, preferenceRevision: preference.revision,
      previewId: record.recordId, previewDigest: `sha256:${sha256(stableJson(record))}`, vaultId: this.vaultId, dateKey: record.date, sourceMode: "explicit" as const, selectedSources: [], remainingRawPaths: [], tracker: { binding: { kind: "missing" as const }, changedRawPaths: [] }, shadowId: record.recordId, shadowRevision: `sha256:${sha256(stableJson(record))}`, reportPath: "", actions: [], createdAt: record.at };
    await this.createWal({ version: 2, terminalRecord: record, preview, authorization: { approvalId: `terminal:${input.toolCallId}`, operationIdentity: record.runId, consumedAt: record.at, contract: { ...input, userId: "private-bookkeeping", deviceId: "private-bookkeeping", previewId: preview.previewId, previewDigest: preview.previewDigest, preferenceProfileVersion: preference.profileVersion, preferenceState: preference.state, preferenceRevision: preference.revision, orderedActions: [] } }, status: "prepared", sequence: 0, actions: [], createdAt: record.at, updatedAt: record.at });
  }

  async finalizeRecord(wal: Readonly<Phase3MaintenanceWalRecord>): Promise<void> {
    if (wal.preview.bookkeeping?.p1RecordId) {
      const parent = await readPrivateMaintenanceRecord(this.rootPath, wal.preview.bookkeeping.p1RecordId, this.vaultId);
      if (!parent?.p1 || parent.originConversationId !== wal.authorization.contract.conversationId) throw new Error("维护WAL缺少同归属P1记录");
      return; // Per-page WALs retain crash evidence; only the parent settles source/history state.
    }
    if (wal.terminalRecord) { await this.saveRecord({ ...wal.terminalRecord, originConversationId: wal.terminalRecord.originConversationId ?? wal.authorization.contract.conversationId }); return; }
    const runId = `${wal.authorization.contract.productRunId}:${wal.authorization.contract.toolCallId}`;
    const recordId = `maintenance-${sha256(runId).slice(0, 32)}`;
    const notes = wal.actions.filter((entry) => entry.status === "completed" && (entry.action.purpose === "knowledge" || (this.vaultRootPath ? ["wiki", "projects"].includes(knowledgePathRole(this.vaultRootPath, entry.action.targetPath) ?? "") : /^(wiki|projects)\//u.test(knowledgeRolePath(entry.action.targetPath)))))
      .map((entry) => knowledgeMaintenanceNoteFromReadback({ operation: entry.action.operation === "create" ? "created" : "updated", path: entry.action.targetPath, content: entry.action.content }));
    const issues = [...(wal.preview.bookkeeping?.issues ?? []), ...wal.actions.filter((entry) => entry.status !== "completed").map((entry) => ({ code: "write_failed", path: entry.action.targetPath, message: entry.error ?? "未完成写入" }))];
    const sources = wal.preview.selectedSources.map((source) => {
      const referencing = wal.actions.filter((entry) => entry.action.content.includes(`"path":"${source.raw.relativePath}"`) || entry.action.content.includes(`"path": "${source.raw.relativePath}"`));
      const evidencePaths = referencing.filter((entry) => entry.status === "completed").map((entry) => entry.action.targetPath);
      const read = referencing.length > 0 || wal.preview.bookkeeping?.readSourcePaths.includes(source.raw.relativePath);
      const failed = wal.preview.bookkeeping?.failedSourcePaths?.includes(source.raw.relativePath) || referencing.some((entry) => entry.status !== "completed");
      const processed = read && !failed && referencing.every((entry) => entry.status === "completed");
      return { path: source.raw.relativePath, fingerprint: source.raw.revision, status: processed ? "processed" as const : read || failed ? "failed" as const : "unread" as const, evidencePaths };
    });
    const at = wal.updatedAt;
    const result = createKnowledgeMaintenanceResultEnvelope({ status: issues.length ? notes.length ? "partial" : "failed" : notes.length ? "completed" : "noop", notes, issues, assessments: wal.preview.bookkeeping?.assessments });
    const linkingTargets = wal.preview.bookkeeping?.linkingTargetPaths;
    const pendingLinking = linkingTargets !== undefined && notes.length
      ? { taskId: recordId, sourcePaths: notes.map(note => note.path), targetPaths: linkingTargets.filter(target => notes.some(note => note.path === target)) }
      : undefined;
    await this.saveRecord({ schemaVersion: 1, originConversationId: wal.authorization.contract.conversationId, recordId, runId, at, date: wal.preview.dateKey, result, sources, ...(pendingLinking ? { pendingLinking } : {}), summary: issues.length ? "本轮有未完成项" : notes.length ? `已保存 ${notes.length} 篇知识笔记` : "本轮无需新增知识笔记" });
  }

  async pendingLinkingRecords(): Promise<KnowledgeMaintenanceRecord[]> {
    const records: KnowledgeMaintenanceRecord[] = [];
    const seen = new Set<string>();
    for (const wal of await this.listRecoverableWals(this.vaultId)) {
      if (wal.preview.bookkeeping?.linkingTargetPaths === undefined) continue;
      const recordId = `maintenance-${sha256(`${wal.authorization.contract.productRunId}:${wal.authorization.contract.toolCallId}`).slice(0, 32)}`;
      if (seen.has(recordId)) continue;
      seen.add(recordId);
      const record = await readPrivateMaintenanceRecord(this.rootPath, recordId, this.vaultId);
      if (record?.pendingLinking) {
        // Legacy pending records may recover only from their exact durable WAL
        // contract; the runId display string is never an identity parser.
        if (!record.originConversationId) {
          record.originConversationId = wal.authorization.contract.conversationId;
          await this.attachRecordOrigin(record.recordId, record.originConversationId);
        }
        records.push(record);
      }
    }
    for (const record of await readPrivateMaintenanceRecords(this.rootPath, { vaultId: this.vaultId })) if (record.p1 && record.pendingLinking && !seen.has(record.recordId)) records.push(record);
    return records;
  }

  private async attachRecordOrigin(recordId: string, originConversationId: string): Promise<void> {
    await serializePiNativeFileWrite(this.rootPath, async () => {
      const recordPath = path.join(await ensurePrivateStateDirectory(this.rootPath, ["records"]), `${requireControlId(recordId)}.json`);
      const previous = await readControlEnvelope(recordPath, this.vaultId, "record") as KnowledgeMaintenanceRecord | null;
      if (!previous || previous.originConversationId && previous.originConversationId !== originConversationId) throw new Error("维护记录来源冲突");
      if (!previous.originConversationId) await writeControlEnvelope(recordPath, this.vaultId, "record", { ...previous, originConversationId });
    });
  }

  async saveP1Record(record: KnowledgeMaintenanceRecord): Promise<void> {
    await serializePiNativeFileWrite(this.rootPath, async () => {
      const directory = await ensurePrivateStateDirectory(this.rootPath, ["records"]);
      const previous = await readPrivateMaintenanceRecord(this.rootPath, record.recordId, this.vaultId);
      if (previous && (!previous.p1 || previous.originConversationId !== record.originConversationId || previous.runId !== record.runId)) throw new Error("维护清单归属冲突");
      await writeControlEnvelope(path.join(directory, `${requireControlId(record.recordId)}.json`), this.vaultId, "record", record);
    });
  }

  async saveRecord(record: KnowledgeMaintenanceRecord): Promise<void> {
    await serializePiNativeFileWrite(this.rootPath, async () => {
      const directory = await ensurePrivateStateDirectory(this.rootPath, ["records"]);
      const recordPath = path.join(directory, `${requireControlId(record.recordId)}.json`);
      const previous = await readControlEnvelope(recordPath, this.vaultId, "record") as KnowledgeMaintenanceRecord | null;
      const persisted = previous ?? await writeControlEnvelope(recordPath, this.vaultId, "record", record);
      if (this.vaultRootPath) {
        const registry = await readRawDigestRegistry(this.vaultRootPath, true);
        for (const source of persisted.sources) if (source.status === "processed") registry.entries[source.path] = {
          rawPath: source.path, fingerprint: source.fingerprint, size: 0, mtime: 0, digestedAt: persisted.at, runId: persisted.runId, reportPath: "", evidencePaths: source.evidencePaths, confidence: "verified"
        };
        await writeRawDigestRegistry(this.vaultRootPath, registry);
      }
    });
  }

  /** Enrich the already-finalized outcome without replacing its source receipts. */
  async updateLinkingMetadata(recordId: string, result: import("../knowledge-base/knowledge-maintenance-result").KnowledgeMaintenanceResultEnvelope, summary: string): Promise<void> {
    const linkingIssues = result.issues.filter(issue => issue.code === "linking_start_failed" || issue.code === "link_target_skipped");
    if (!result.linkingTaskId && !linkingIssues.length) return;
    await serializePiNativeFileWrite(this.rootPath, async () => {
      const recordPath = path.join(await ensurePrivateStateDirectory(this.rootPath, ["records"]), `${requireControlId(recordId)}.json`);
      const previous = await readControlEnvelope(recordPath, this.vaultId, "record") as KnowledgeMaintenanceRecord | null;
      if (!previous) throw new Error("phase3_linking_record_missing");
      const issues = previous.result.issues.filter(issue => !(result.linkingTaskId && issue.code === "linking_start_failed"));
      for (const issue of linkingIssues) if (!issues.some(item => item.code === issue.code && item.path === issue.path && item.message === issue.message)) issues.push(issue);
      const enriched = createKnowledgeMaintenanceResultEnvelope({ ...previous.result,
        ...(result.linkingTaskId ? { linkingTaskId: result.linkingTaskId } : {}),
        status: linkingIssues.length && previous.result.status === "completed" ? "partial"
          : result.linkingTaskId && previous.result.status === "partial" && !issues.length ? "completed" : previous.result.status,
        issues
      });
      const { pendingLinking: _pending, ...settled } = previous;
      await writeControlEnvelope(recordPath, this.vaultId, "record", { ...(result.linkingTaskId ? settled : previous), result: enriched, summary });
    });
  }

  private async initializeUnlocked(): Promise<void> {
    await ensurePrivateStateDirectories(this.rootPath);
  }

  private assertVault(vaultId: string): void {
    if (vaultId !== this.vaultId) throw new Error("phase3_vault_mismatch");
  }

  private previewPath(previewId: string): string {
    return path.join(this.rootPath, "previews", `${previewId}.json`);
  }

  private walPath(previewId: string): string {
    return path.join(
      this.rootPath,
      "wal",
      `${requireControlId(this.walFileId(previewId))}.json`
    );
  }
}

class FilePhase3MaintenanceSourceSnapshotPort
implements Phase3MaintenanceSourceSnapshotPort {
  private readonly vaultRootPath: string;

  constructor(private readonly options: Readonly<{
    vaultRootPath: string;
    vaultId: string;
  }>) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
  }

  async snapshotRaw(input: Readonly<{
    vaultId: string;
    relativePath: string;
  }>): Promise<Readonly<Phase3MaintenanceSourceBinding>> {
    this.assertVault(input.vaultId);
    if (!["raw", "inbox"].includes(knowledgePathRole(this.vaultRootPath, input.relativePath) ?? "")) throw new Error("资料不在已绑定的来源范围内。");
    const raw = await readImmutableFile(
      this.vaultRootPath,
      normalizeVaultRelativePath(input.relativePath)
    );
    const text = UTF8_DECODER.decode(raw.bytes);
    const attachments: Phase3MaintenanceImmutableFileBinding[] = [];
    for (const relativePath of extractAttachmentPaths(raw.relativePath, canonicalRawMarkdownForDigest(text))) {
      const attachment = await readImmutableFileIfPresent(
        this.vaultRootPath,
        relativePath
      ).catch(() => null);
      if (attachment) attachments.push(fileBinding(attachment));
    }
    attachments.sort((left, right) => left.relativePath.localeCompare(
      right.relativePath,
      "en"
    ));
    return Object.freeze({
      raw: Object.freeze({ ...fileBinding(raw), revision: rawDigestFingerprint(raw.relativePath, raw.bytes), contentSha256: rawDigestFingerprint(raw.relativePath, raw.bytes).split(":").at(-1)!, byteLength: Buffer.byteLength(canonicalRawMarkdownForDigest(text), "utf8") }),
      attachments: Object.freeze(attachments)
    });
  }

  private assertVault(vaultId: string): void {
    if (vaultId !== this.options.vaultId) {
      throw new Error("phase3_source_vault_mismatch");
    }
  }
}

export async function rebasePrivateMaintenanceRecords(rootPath: string, from: string, to: string): Promise<void> {
  await serializePiNativeFileWrite(rootPath, async () => {
    for (const record of await readPrivateMaintenanceRecords(rootPath)) {
      const next = rebaseKnowledgePathRecords(record, from, to);
      if (JSON.stringify(next) === JSON.stringify(record)) continue;
      const target = path.join(rootPath, "records", `${record.recordId}.json`);
      const envelope = await readJsonFileIfPresent(target, "维护记录") as ControlEnvelope;
      await writeControlEnvelope(target, envelope.vaultId, "record", next);
    }
  });
}

async function readPrivateMaintenanceRecord(rootPath: string, recordId: string, vaultId?: string): Promise<KnowledgeMaintenanceRecord | null> {
  if (!/^maintenance-[a-f0-9]{32}$/u.test(recordId)) throw new Error("维护记录身份无效");
  const raw = await readJsonFileIfPresent(path.join(rootPath, "records", `${recordId}.json`), "维护记录");
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.vaultId !== "string") throw new Error("维护记录无效");
  const payload = parseControlEnvelope(raw, vaultId ?? raw.vaultId, "record").payload;
  if (!isRecord(payload)
    || payload.schemaVersion !== 1
    || payload.recordId !== recordId
    || typeof payload.runId !== "string"
    || payload.originConversationId !== undefined && (typeof payload.originConversationId !== "string" || !payload.originConversationId.trim() || /[\0\r\n]/u.test(payload.originConversationId))
    || typeof payload.at !== "number" || !Number.isFinite(payload.at)
    || typeof payload.date !== "string"
    || typeof payload.summary !== "string"
    || (payload.cancelled !== undefined && typeof payload.cancelled !== "boolean")
    || !Array.isArray(payload.sources)
    || payload.sources.some((source) => !isRecord(source)
      || typeof source.path !== "string" || typeof source.fingerprint !== "string"
      || !["processed", "unread", "failed"].includes(String(source.status))
      || !Array.isArray(source.evidencePaths) || source.evidencePaths.some((value) => typeof value !== "string"))) throw new Error("维护记录版本或身份无效");
  const result = parseKnowledgeMaintenanceResultEnvelope(payload.result);
  if (!result) throw new Error("维护记录结果无效");
  if (payload.pendingLinking !== undefined && (!isRecord(payload.pendingLinking)
    || payload.pendingLinking.taskId !== recordId
    || !Array.isArray(payload.pendingLinking.sourcePaths) || payload.pendingLinking.sourcePaths.some(value => typeof value !== "string" || !result.notes.some(note => note.path === value))
    || !Array.isArray(payload.pendingLinking.targetPaths) || payload.pendingLinking.targetPaths.some(value => typeof value !== "string" || !result.notes.some(note => note.path === value)))) throw new Error("维护关联恢复范围无效");
  return { ...payload, result } as unknown as KnowledgeMaintenanceRecord;
}

export async function readPrivateMaintenanceRecords(rootPath: string, options: Readonly<{
  vaultId?: string;
  onInvalidRecord?: (recordPath: string, error: unknown) => void;
}> = {}): Promise<KnowledgeMaintenanceRecord[]> {
  const directory = path.join(rootPath, "records");
  const names = await readdir(directory).catch((error: unknown) => { if (isNodeErrorWithCode(error, "ENOENT")) return []; throw error; });
  const records: KnowledgeMaintenanceRecord[] = [];
  for (const name of names) {
    if (!/^maintenance-[a-f0-9]{32}\.json$/u.test(name)) continue;
    try {
      const record = await readPrivateMaintenanceRecord(rootPath, name.slice(0, -5), options.vaultId);
      if (record) records.push(record);
    } catch (error) {
      if (options.onInvalidRecord) options.onInvalidRecord(path.join(directory, name), error);
      else console.warn("EchoInk skipped invalid maintenance record", path.join(directory, name), knowledgeErrorDetail(error));
    }
  }
  return records.sort((a, b) => b.at - a.at);
}

/** Same source-state precedence as scanning, restricted to the supplied paths. */
async function readProcessedMaintenanceSources(vaultRoot: string, paths: readonly string[], records: readonly KnowledgeMaintenanceRecord[], previous?: Readonly<Record<string, { fingerprint?: string }>>): Promise<string[]> {
  const registry = await readRawDigestRegistry(vaultRoot, true);
  const latest = latestMaintenanceSourceStates(records);
  const processed: string[] = [];
  for (const relative of paths) {
    const file = await readImmutableFileIfPresent(vaultRoot, relative);
    if (!file) continue;
    const markdown = UTF8_DECODER.decode(file.bytes);
    if (isMaintenanceSourceProcessed(markdown, { fingerprint: () => rawDigestFingerprint(relative, file.bytes), registry: registry.entries[relative], maintenance: latest.get(relative), previous: previous?.[relative] })) processed.push(relative);
  }
  return processed;
}

export async function privateMaintenanceSourceScope(vaultRoot: string, options: Readonly<{
  limit?: number; processedSources?: Readonly<Record<string, { fingerprint?: string }>>; readMaintenanceHistory?: boolean;
}> = {}) {
  const bindings = getKnowledgeFolderBindings(vaultRoot);
  const roots = bindings ? [...bindings.roles.raw.readPaths, ...bindings.roles.inbox.readPaths] : [resolveKnowledgePath(vaultRoot, "raw"), resolveKnowledgePath(vaultRoot, "inbox")];
  const candidates = new Set<string>();
  const walk = async (root: string): Promise<void> => {
    let cursor = vaultRoot;
    for (const segment of normalizeVaultRelativePath(root).split("/")) {
      cursor = path.join(cursor, segment);
      const stat = await lstat(cursor).catch(error => { if (isNodeErrorWithCode(error, "ENOENT")) return null; throw error; });
      if (!stat) return;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("来源扫描拒绝非普通目录或链接");
    }
    const entries = await readdir(path.join(vaultRoot, root), { withFileTypes: true }).catch(error => { if (isNodeErrorWithCode(error, "ENOENT")) return []; throw error; });
    for (const entry of entries) {
      const relative = `${root}/${entry.name}`;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && isKnowledgeMaintenanceSourcePath(relative) && ["raw", "inbox"].includes(knowledgePathRole(vaultRoot, relative) ?? "")) candidates.add(relative);
    }
  };
  for (const root of new Set(roots)) await walk(root);
  const privateRoot = knowledgePrivateRoot(vaultRoot);
  const sorted = [...candidates].sort();
  const processed = new Set(await readProcessedMaintenanceSources(vaultRoot, sorted, privateRoot && options.readMaintenanceHistory !== false ? await readPrivateMaintenanceRecords(privateRoot) : [], options.processedSources));
  const sourcePaths = sorted.filter(relative => !processed.has(relative));
  return { folderBindingsRevision: bindings?.revision ?? 0, sourcePaths: sourcePaths.slice(0, options.limit ?? 20) };
}

class PrivateMaintenanceTrackerPort implements Phase3MaintenanceTrackerPort {
  constructor(private readonly vaultRoot: string) {}
  async snapshot(): Promise<Readonly<Phase3MaintenanceTrackerSnapshot>> {
    // Execution checks its own durable record only; unrelated history cannot
    // become a prerequisite for committing an explicitly selected source.
    return { binding: { kind: "missing" }, changedRawPaths: (await privateMaintenanceSourceScope(this.vaultRoot, { limit: Infinity, readMaintenanceHistory: false })).sourcePaths };
  }
}

class UnavailableMaintenanceProposalPort
implements Phase3MaintenanceProposalPort {
  async generate(): Promise<never> {
    throw new Error("phase3_proposal_generation_not_available_during_confirm");
  }
}

interface ImmutableFileRead {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
}

async function readImmutableFile(
  vaultRootPath: string,
  relativePathInput: string
): Promise<Readonly<ImmutableFileRead>> {
  const relativePath = resolveKnowledgePath(vaultRootPath, normalizeVaultRelativePath(relativePathInput), false);
  const absolutePath = await resolveRegularFile(vaultRootPath, relativePath);
  const flags = fsConstants.O_RDONLY
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  const handle = await open(absolutePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("phase3_source_not_regular");
    const bytes = await handle.readFile();
    return Object.freeze({
      relativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } finally {
    await handle.close();
  }
}

async function readImmutableFileIfPresent(
  vaultRootPath: string,
  relativePath: string
): Promise<Readonly<ImmutableFileRead> | null> {
  try {
    return await readImmutableFile(vaultRootPath, relativePath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function resolveRegularFile(
  vaultRootPathInput: string,
  relativePath: string
): Promise<string> {
  const vaultRootPath = await realpath(vaultRootPathInput);
  let cursor = vaultRootPath;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("phase3_symbolic_link_rejected");
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error("phase3_parent_not_directory");
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error("phase3_source_not_regular");
    }
  }
  const resolved = await realpath(cursor);
  if (!isInside(vaultRootPath, resolved)) {
    throw new Error("phase3_source_outside_vault");
  }
  return resolved;
}

function fileBinding(
  file: Readonly<ImmutableFileRead>
): Readonly<Phase3MaintenanceImmutableFileBinding> {
  return Object.freeze({
    kind: "file" as const,
    relativePath: file.relativePath,
    revision: file.sha256,
    contentSha256: file.sha256,
    byteLength: file.bytes.length
  });
}

function extractAttachmentPaths(
  rawRelativePath: string,
  text: string
): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/!\[\[([^\]]+)\]\]/gu)) {
    if (match[1]) candidates.push(match[1].split(/[|#^]/u, 1)[0] ?? "");
  }
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)) {
    if (match[1]) candidates.push(match[1].split(/[?#]/u, 1)[0] ?? "");
  }
  const rawDirectory = path.posix.dirname(rawRelativePath);
  const normalized = new Set<string>();
  for (const raw of candidates) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw.trim().replace(/^<|>$/gu, ""));
    } catch {
      continue;
    }
    if (!decoded || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)) continue;
    if (decoded.startsWith("/") || decoded.includes("\\")) continue;
    try {
      const relativePath = normalizeVaultRelativePath(
        decoded.includes("/")
          ? decoded
          : path.posix.join(rawDirectory, decoded)
      );
      if (
        relativePath !== rawRelativePath
        && !relativePath.split("/").some((segment) => segment.startsWith("."))
      ) normalized.add(relativePath);
    } catch {
      // Invalid link text is not an attachment capability.
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right, "en"));
}

function parseChangedRawPaths(text: string): string[] {
  const changed = new Set<string>();
  let inChangedSection = false;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      inChangedSection = /(?:changed|变更|变化|待处理|未处理)/iu.test(
        heading[1] ?? ""
      );
      continue;
    }
    if (!inChangedSection && !/(?:changed|变更|变化)/iu.test(line)) continue;
    for (const match of line.matchAll(/(?:raw|[^\s/`[\]（）]+（raw）)\/[^`[\]\r\n]+?\.md\b/giu)) {
      try {
        changed.add(normalizeVaultRelativePath(match[0].trim()));
      } catch {
        // The service rejects invalid paths; the parser ignores non-path text.
      }
    }
  }
  return [...changed].sort((left, right) => left.localeCompare(right, "en"));
}

async function ensureSafeControlDirectories(
  vaultRootPathInput: string,
  relativePaths: readonly string[]
): Promise<void> {
  const vaultRootPath = await realpath(vaultRootPathInput);
  for (const relativePathInput of relativePaths) {
    const relativePath = normalizeVaultRelativePath(relativePathInput);
    let cursor = vaultRootPath;
    for (const segment of relativePath.split("/")) {
      cursor = path.join(cursor, segment);
      let stat = await lstat(cursor).catch((error: unknown) => {
        if (isNodeErrorWithCode(error, "ENOENT")) return null;
        throw error;
      });
      if (!stat) {
        await mkdir(cursor, { mode: 0o700 });
        stat = await lstat(cursor);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("phase3_control_path_unsafe");
      }
    }
    const resolved = await realpath(cursor);
    if (!isInside(vaultRootPath, resolved)) {
      throw new Error("phase3_control_path_outside_vault");
    }
  }
}

async function assertExistingPrivateStateDirectoriesSafe(
  rootPathInput: string
): Promise<void> {
  const stat = await lstat(rootPathInput).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("phase3_private_state_root_unsafe");
  }
  const rootPath = await realpath(rootPathInput);
  if (rootPath !== path.resolve(rootPathInput)) {
    throw new Error("phase3_private_state_root_changed");
  }
  for (const name of ["previews", "shadow", "wal"]) {
    const child = path.join(rootPath, name);
    const childStat = await lstat(child).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    });
    if (!childStat) continue;
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new Error("phase3_private_state_path_unsafe");
    }
    if (await realpath(child) !== child) {
      throw new Error("phase3_private_state_path_changed");
    }
  }
}

async function ensurePrivateStateDirectories(rootPath: string): Promise<void> {
  await Promise.all([
    ensurePrivateStateDirectory(rootPath, ["previews"]),
    ensurePrivateStateDirectory(rootPath, ["shadow"]),
    ensurePrivateStateDirectory(rootPath, ["wal"])
  ]);
}

async function ensurePrivateStateDirectory(
  rootPathInput: string,
  segments: readonly string[]
): Promise<string> {
  const rootPath = path.resolve(rootPathInput);
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("phase3_private_state_root_unsafe");
  }
  if (await realpath(rootPath) !== rootPath) {
    throw new Error("phase3_private_state_root_changed");
  }
  let cursor = rootPath;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(segment)) {
      throw new Error("phase3_private_state_segment_invalid");
    }
    cursor = path.join(cursor, segment);
    let stat = await lstat(cursor).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    });
    if (!stat) {
      await mkdir(cursor, { mode: 0o700 });
      stat = await lstat(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("phase3_private_state_path_unsafe");
    }
    if (await realpath(cursor) !== cursor) {
      throw new Error("phase3_private_state_path_changed");
    }
  }
  return cursor;
}

async function writeNewFileWithReadback(
  filePath: string,
  bytes: Buffer
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readback = await readFile(filePath);
  if (!readback.equals(bytes)) throw new Error("phase3_shadow_readback_failed");
}

interface ControlEnvelope {
  schemaVersion: 1;
  vaultId: string;
  kind: "preview" | "wal" | "record";
  payloadDigest: string;
  payload: unknown;
}

async function writeControlEnvelope<T>(
  filePath: string,
  vaultId: string,
  kind: ControlEnvelope["kind"],
  payload: T
): Promise<Readonly<T>> {
  const jsonPayload = JSON.parse(JSON.stringify(payload)) as unknown;
  const envelope: ControlEnvelope = {
    schemaVersion: 1,
    vaultId,
    kind,
    payloadDigest: sha256(stableJson(jsonPayload)),
    payload: jsonPayload
  };
  const readback = await atomicWriteJsonFile(
    filePath,
    envelope,
    `Phase 3 maintenance ${kind}`,
    (value) => parseControlEnvelope(value, vaultId, kind)
  );
  return deepFreeze(readback.payload as T);
}

async function readControlEnvelope(
  filePath: string,
  vaultId: string,
  kind: ControlEnvelope["kind"]
): Promise<unknown> {
  const value = await readJsonFileIfPresent(
    filePath,
    `Phase 3 maintenance ${kind}`
  );
  if (value === null) return null;
  return deepFreeze(parseControlEnvelope(value, vaultId, kind).payload);
}

function parseControlEnvelope(
  value: unknown,
  vaultId: string,
  kind: ControlEnvelope["kind"]
): ControlEnvelope {
  if (!isRecord(value)) throw new Error("phase3_control_document_invalid");
  if (
    value.schemaVersion !== 1
    || value.vaultId !== vaultId
    || value.kind !== kind
    || typeof value.payloadDigest !== "string"
    || value.payloadDigest !== sha256(stableJson(value.payload))
  ) {
    throw new Error("phase3_control_document_invalid");
  }
  return value as unknown as ControlEnvelope;
}

function requireStoredPreview(
  value: unknown
): Readonly<Phase3MaintenanceStoredPreview> {
  if (!isRecord(value) || !isRecord(value.preview)) {
    throw new Error("phase3_preview_document_invalid");
  }
  if (
    value.status !== "active"
    && value.status !== "confirmed"
    && value.status !== "invalid"
  ) throw new Error("phase3_preview_document_invalid");
  if (
    value.preview.protocolVersion
      !== ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
    ||
    typeof value.preview.preferenceProfileVersion !== "string"
    || (value.preview.preferenceState !== "default"
      && value.preview.preferenceState !== "custom")
    || typeof value.preview.preferenceRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.preview.preferenceRevision)
    ||
    typeof value.preview.previewId !== "string"
    || typeof value.preview.vaultId !== "string"
    || !Array.isArray(value.preview.actions)
  ) throw new Error("phase3_preview_document_invalid");
  return deepFreeze(value as unknown as Phase3MaintenanceStoredPreview);
}

function requireWal(value: unknown): Readonly<Phase3MaintenanceWalRecord> {
  if (
    !isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || !isRecord(value.preview)
    || value.preview.protocolVersion
      !== ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
    || typeof value.preview.preferenceProfileVersion !== "string"
    || (value.preview.preferenceState !== "default"
      && value.preview.preferenceState !== "custom")
    || typeof value.preview.preferenceRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.preview.preferenceRevision)
    || typeof value.preview.previewId !== "string"
    || typeof value.preview.vaultId !== "string"
    || !Number.isSafeInteger(value.sequence)
    || !Array.isArray(value.actions)
  ) throw new Error("phase3_wal_document_invalid");
  return deepFreeze(value as unknown as Phase3MaintenanceWalRecord);
}

function reliableKnowledgeNoopMessage(
  reliable: Readonly<KnowledgeAgentReliableRawKnowledge>
): string {
  const content = [
    `Raw ${reliable.rawPath} 未变化，已复用现有知识；knowledge_maintain=noop。`,
    ...reliable.entries.flatMap((entry) => [
      `\n## ${entry.title}`,
      `路径：${entry.vaultRelativePath}`,
      entry.content
    ])
  ].join("\n");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= 6_000) return content;
  return `${bytes.subarray(0, 5_900).toString("utf8").replace(/\uFFFD$/u, "")}\n\n（现有知识内容较长，已截断显示；本轮仍为 noop。）`;
}

function cancelledResult(): Readonly<PiKnowledgeMaintenanceToolResult> {
  return Object.freeze({
    status: "cancelled" as const,
    message: "Knowledge maintenance was cancelled before a new write started."
  });
}

function safeMaintenanceError(error: unknown): string {
  const code = error instanceof Phase3MaintenanceError ? error.code : "knowledge_maintenance_failed";
  const file = error instanceof Phase3MaintenanceError && error.relativePath ? `（${error.relativePath}）` : "";
  return `知识维护 ${code}${file}：${knowledgeErrorDetail(error)}；已完成内容保留，请只处理受影响项。`;
}

function candidateSourcePaths(content: string, selected: readonly string[]): string[] {
  const matches = selected.filter((relative) => content.includes(relative));
  return matches.length ? matches : [...selected];
}

function extractExplicitRawPaths(value: string, vaultRoot = ""): string[] {
  const paths = new Set<string>();
  for (const match of value.matchAll(/[^\s`[\]\r\n]+\/[^`[\]\r\n]+?\.md\b/giu)) {
    const candidate = normalizeVaultRelativePath(match[0].trim());
    if (knowledgePathRole(vaultRoot, candidate) !== "raw") throw new Error("指定资料不在来源范围，不能回退全局维护。");
    paths.add(candidate);
  }
  return [...paths].sort((left, right) => left.localeCompare(right, "en"));
}

function uniqueShadowFileName(
  targetPath: string,
  usedNames: Set<string>
): string {
  const normalized = targetPath
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^\p{L}\p{N}_. -]/gu, "-")
    .replace(/^\.+/u, "")
    .slice(0, 180) || "candidate";
  let candidate = normalized;
  if (usedNames.has(candidate)) {
    const extension = path.posix.extname(normalized);
    const stem = extension ? normalized.slice(0, -extension.length) : normalized;
    candidate = `${stem}-${sha256(targetPath).slice(0, 12)}${extension}`;
  }
  if (usedNames.has(candidate)) throw new Error("phase3_shadow_name_collision");
  usedNames.add(candidate);
  return candidate;
}

function requireControlId(value: string): string {
  const id = requireNonEmpty(value, "controlId");
  if (!CONTROL_ID.test(id)) throw new Error("phase3_control_id_invalid");
  return id;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label}_invalid`);
  }
  return value.trim();
}

function requirePreferenceSnapshot(
  value: PiKnowledgeMaintenanceToolInput["preferenceSnapshot"]
): Readonly<{
  profileVersion: string;
  state: "default" | "custom";
  revision: string;
}> {
  if (!value) {
    throw new Phase3MaintenanceError(
      "proposal_invalid",
      "Knowledge maintenance preference snapshot is missing"
    );
  }
  const profileVersion = requireNonEmpty(
    value.profileVersion,
    "preferenceProfileVersion"
  );
  if (value.state !== "default" && value.state !== "custom") {
    throw new Phase3MaintenanceError(
      "proposal_invalid",
      "Knowledge maintenance preference state is invalid"
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.revision)) {
    throw new Phase3MaintenanceError(
      "proposal_invalid",
      "Knowledge maintenance preference revision is invalid"
    );
  }
  return Object.freeze({
    profileVersion,
    state: value.state,
    revision: value.revision
  });
}

function localDateKey(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined)
    .sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

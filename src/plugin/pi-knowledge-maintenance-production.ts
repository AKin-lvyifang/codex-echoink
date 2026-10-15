import { rebaseKnowledgePathRecords } from "../knowledge-base/root-paths-core";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { knowledgeMaintenanceNoteFromReadback } from "../knowledge-base/knowledge-maintenance-result";
import { readRawDigestRegistry, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { knowledgePathPolicy, knowledgePathRole, getKnowledgeFolderBindings, knowledgeRolePath, resolveKnowledgePath } from "../knowledge-base/root-paths";
import { knowledgeErrorDetail } from "../knowledge-base/initialization-error";
import { canonicalRawMarkdownForDigest, rawDigestFingerprint, isRawMarkdownPath } from "../knowledge-base/raw-digest";
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
import type {
  KnowledgeAgentIndex,
  KnowledgeAgentReliableRawKnowledge
} from "../knowledge-base/knowledge-agent-index";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
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
  >;
  readonly now?: () => number;
  readonly createPreviewId?: () => string;
  readonly dateKey?: () => string;
  readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
  /** Reconcile private derived state after a confirmed Vault readback. */
  readonly onCommitted?: (
    producedPaths: readonly string[]
  ) => void | Promise<void>;
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
  >;
  private readonly sources: FilePhase3MaintenanceSourceSnapshotPort;
  private readonly tracker: Phase3MaintenanceTrackerPort;
  private readonly now: () => number;
  private readonly createPreviewId: () => string;
  private readonly dateKey: () => string;
  private readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
  private readonly onCommitted?: (
    producedPaths: readonly string[]
  ) => void | Promise<void>;

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
    this.now = options.now ?? Date.now;
    this.createPreviewId = options.createPreviewId ?? randomUUID;
    this.dateKey = options.dateKey ?? localDateKey;
    this.faultInjector = options.faultInjector;
    this.onCommitted = options.onCommitted;
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
    /* legacy tracker adapter retained for explicit old-version reads */
    /* this.tracker = new FilePhase3MaintenanceTrackerPort({
      vaultRootPath: this.vaultRootPath,
      vaultId: this.vaultId,
      domainService: this.domainService
    }); */
  }

  async initialize(): Promise<void> {
    await this.state.initialize();
    await this.createService(
      new UnavailableMaintenanceProposalPort()
    ).recoverPendingOrThrow(this.vaultId);
  }

  async execute(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    const recordId = `maintenance-${sha256(`${input.productRunId}:${input.toolCallId}`).slice(0, 32)}`;
    const saved = await readPrivateMaintenanceRecord(this.privateKnowledgeRootPath, recordId, this.vaultId);
    if (saved) {
      this.assertIdentity(input);
      return { status: saved.result.status === "failed" || saved.result.status === "write_uncertain" ? "failed" : "completed", message: saved.summary, maintenanceResult: saved.result, recordId: saved.recordId, producedPaths: saved.result.notes.map((note) => note.path), processedSourcePaths: saved.sources.filter((source) => source.status === "processed").map((source) => source.path) };
    }
    let result = await this.executeMaintenance(input);
    if (result.errorCode !== "record_pending") {
      try { await this.saveTerminalRecord(input, result, recordId); result = { ...result, recordId }; }
      catch { result = { ...result, errorCode: "record_pending", message: `${result.message}\n维护记录待恢复，已保存的知识笔记保留。` }; }
    }
    try {
      await this.onTerminal?.({ input, result, at: this.now() });
    } catch (error) {
      console.error("EchoInk maintenance history could not be saved", knowledgeErrorDetail(error));
    }
    return result;
  }

  async finalizeNatural(request: Parameters<NonNullable<import("../harness/pi-native/contracts").PiKnowledgeRuntimePort["finalizeMaintenance"]>>[0]): Promise<Readonly<import("../harness/pi-native/contracts").PiKnowledgeMaintenanceSettlement>> {
    const scope = request.scope;
    const paths = scope?.mode === "global" ? scope.sourcePaths ?? request.noteReadPaths : scope?.mode === "exact" || scope?.mode === "batch" ? scope.sourcePaths : scope?.mode === "query" ? scope.candidatePaths : request.noteReadPaths;
    const entries = request.turnEntries ?? request.entries;
    const { maintenanceSourceFingerprintsFromEntries } = await import("../harness/pi-native/pi-knowledge-maintenance-tool");
    const delivered = maintenanceSourceFingerprintsFromEntries(entries, this.vaultRootPath);
    const sources: KnowledgeMaintenanceRecord["sources"] = [];
    const issues: { code: string; message: string; path?: string }[] = [];
    const revision = request.folderBindingsRevision ?? (scope?.mode === "global" ? scope.folderBindingsRevision : undefined);
    const scopeChanged = revision !== undefined && revision !== (getKnowledgeFolderBindings(this.vaultRootPath)?.revision ?? 0);
    for (const relative of [...new Set(paths)].filter((relative) => scopeChanged || knowledgePathRole(this.vaultRootPath, relative) === "raw")) {
      if (scopeChanged) { sources.push({ path: relative, fingerprint: delivered[relative] ?? "", status: "failed", evidencePaths: [] }); issues.push({ code: "folder_bindings_changed", path: relative, message: "本轮目录配置改变，保留待处理" }); continue; }
      if (!delivered[relative]) { sources.push({ path: relative, fingerprint: "", status: "unread", evidencePaths: [] }); issues.push({ code: "source_unread", path: relative, message: "本轮未读取，保留待处理" }); continue; }
      try {
        const current = await readImmutableFile(this.vaultRootPath, relative);
        const fingerprint = rawDigestFingerprint(relative, current.bytes);
        const verified = fingerprint.split(":").at(-1) === delivered[relative].split(":").at(-1);
        sources.push({ path: relative, fingerprint, status: verified && request.terminalState === "completed" ? "processed" : "failed", evidencePaths: [] });
        if (!verified) issues.push({ code: "source_changed", path: relative, message: "来源正文改变，保留待处理" });
      } catch { sources.push({ path: relative, fingerprint: delivered[relative], status: "failed", evidencePaths: [] }); issues.push({ code: "source_unavailable", path: relative, message: "读取失败，保留待处理" }); }
    }
    const runId = `${request.productRunId}:natural`;
    const at = this.now();
    const result = createKnowledgeMaintenanceResultEnvelope({ status: request.terminalState !== "completed" ? "failed" : issues.length ? "partial" : "noop", issues });
    const record: KnowledgeMaintenanceRecord = { schemaVersion: 1, recordId: `maintenance-${sha256(runId).slice(0, 32)}`, runId, at, date: this.dateKey(), result, cancelled: request.terminalState === "cancelled", sources, summary: request.terminalState === "completed" ? issues.length ? "已读资料无需新增；另有来源待处理" : "本轮无需新增知识笔记" : "本轮未完成，来源保留待处理" };
    const input = { vaultId: request.vaultId, conversationId: request.conversationId, piSessionId: request.piSessionId, productRunId: request.productRunId, toolCallId: "natural", mode: "maintain" as const, request: "" };
    await this.state.queueTerminalRecord(input, record);
    await this.createService(new UnavailableMaintenanceProposalPort()).recoverPendingOrThrow(this.vaultId);
    await this.onTerminal?.({ input, result: { status: request.terminalState === "completed" ? "completed" : "failed", message: record.summary, maintenanceResult: result, recordId: record.recordId }, at });
    return { processedSourcePaths: sources.filter((source) => source.status === "processed").map((source) => source.path), pendingSourcePaths: sources.filter((source) => source.status !== "processed").map((source) => source.path), warnings: issues.map((issue) => issue.message) };
  }

  private async saveTerminalRecord(input: Readonly<PiKnowledgeMaintenanceToolInput>, result: Readonly<PiKnowledgeMaintenanceToolResult>, recordId: string): Promise<void> {
    const at = this.now();
    const verified = result.verifiedSourceFingerprints ?? {};
    const paths = [...new Set([...Object.keys(verified), ...(input.sourcePaths?.length ? input.sourcePaths : Object.keys(input.sourceBodyFingerprints ?? {}))])];
    const sources: KnowledgeMaintenanceRecord["sources"] = [];
    for (const relative of paths) {
      if (knowledgePathRole(this.vaultRootPath, relative) !== "raw") continue;
      const fingerprint = verified[relative] ?? input.sourceBodyFingerprints?.[relative];
      const processed = Boolean(fingerprint && result.maintenanceResult?.status === "noop");
      sources.push({ path: relative, fingerprint: fingerprint ?? "", status: processed ? "processed" : fingerprint ? "failed" : "unread", evidencePaths: [] });
    }
    await this.state.queueTerminalRecord(input, { schemaVersion: 1, recordId, runId: `${input.productRunId}:${input.toolCallId}`, at, date: this.dateKey(), cancelled: result.status === "cancelled", result: result.maintenanceResult ?? createKnowledgeMaintenanceResultEnvelope({ status: "failed", issues: [{ code: result.errorCode ?? "cancelled", message: result.message }] }), sources, summary: result.message });
    await this.createService(new UnavailableMaintenanceProposalPort()).recoverPendingOrThrow(this.vaultId);
  }

  private async executeMaintenance(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    const issues: { code: string; message: string; path?: string }[] = [];
    const failedSourcePaths = new Set<string>();
    try {
      this.assertIdentity(input);
      if (input.folderBindingsRevision !== undefined && input.folderBindingsRevision !== getKnowledgeFolderBindings(this.vaultRootPath)?.revision) throw new Phase3MaintenanceError("preview_stale", "知识库目录已变化，请重新读取并生成候选。");
      if (input.sourceBodyFingerprints) input = { ...input, sourceBodyFingerprints: Object.fromEntries(Object.entries(input.sourceBodyFingerprints).map(([relative, revision]) => [resolveKnowledgePath(this.vaultRootPath, relative, false), revision])) };
      if (input.signal?.aborted) return cancelledResult();
      const requestedActions = input.candidateActions ?? [];
      const requestedSources = (input.sourcePaths?.length ? [...input.sourcePaths] : extractExplicitRawPaths(input.request, this.vaultRootPath)).map((value) => resolveKnowledgePath(this.vaultRootPath, value, false));
      if (!requestedSources.length) requestedSources.push(...(input.globalSourcePaths ?? (await this.tracker.snapshot({ vaultId: this.vaultId })).changedRawPaths.filter(isRawMarkdownPath).slice(0, 20)));
      if (requestedActions.length === 0 && requestedSources.length === 1 && this.knowledgeAgentIndex) {
        const reliable = await this.knowledgeAgentIndex
          .readReliableKnowledgeForRaw(requestedSources[0])
          .catch(() => null);
        if (reliable?.entries.length) {
          const verifiedFile = await readImmutableFile(this.vaultRootPath, reliable.rawPath);
          const verifiedFingerprint = rawDigestFingerprint(reliable.rawPath, verifiedFile.bytes);
          if (verifiedFingerprint.split(":").at(-1) !== reliable.rawContentRevision.split(":").at(-1)) throw new Phase3MaintenanceError("preview_stale", "可靠知识对应的来源正文已变化，请重新阅读。", reliable.rawPath);
          return Object.freeze({
            status: "completed" as const,
            producedPaths: Object.freeze([]),
            processedSourcePaths: Object.freeze([reliable.rawPath]),
            verifiedSourceFingerprints: { [reliable.rawPath]: verifiedFingerprint },
            maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
              status: "noop",
              assessments: input.assessments
            }),
            protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
            preferenceProfileVersion: input.preferenceSnapshot?.profileVersion,
            preferenceState: input.preferenceSnapshot?.state,
            message: reliableKnowledgeNoopMessage(reliable)
          });
        }
      }
      if (!requestedSources.length) return { status: "completed", message: "没有待处理资料，本轮无需新增。", maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "noop" }) };
      const sourcePaths: string[] = [];
      const refreshedSources: Record<string, string> = {};
      const changed: string[] = [];
      for (const relativePath of requestedSources) {
        try {
          if (knowledgePathRole(this.vaultRootPath, relativePath) !== "raw") throw new Error("指定资料不在来源范围。");
          const file = await readImmutableFile(this.vaultRootPath, normalizeVaultRelativePath(relativePath));
          const fingerprint = rawDigestFingerprint(relativePath, file.bytes);
          const expected = input.sourceBodyFingerprints?.[relativePath];
          if (expected && expected.split(":").at(-1) !== fingerprint.split(":").at(-1)) {
            if (!changed.length) {
              // Only acknowledge the source actually included in this bounded Tool result.
              const text = UTF8_DECODER.decode(file.bytes);
              let excerpt = text;
              while (Buffer.byteLength(excerpt, "utf8") > 5_500) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
              refreshedSources[relativePath] = fingerprint;
              changed.push(`来源正文已变化，已自动重读 ${relativePath}。当前全文版本 ${fingerprint}；返回 ${Buffer.byteLength(excerpt, "utf8")} / ${file.bytes.length} 字节${excerpt === text ? "" : "（当前片段，需要更多内容时可继续读取）"}。请按当前内容重新判断，不重复提交旧候选：\n${excerpt}`);
            }
          }
          sourcePaths.push(relativePath);
        } catch (error) { issues.push({ code: "source_unavailable", path: relativePath, message: `读取 ${relativePath}：${knowledgeErrorDetail(error)}；该来源待处理。` }); }
      }
      if (changed.length) return Object.freeze({
        status: "failed", errorCode: "preview_stale", message: changed.join("\n\n"), refreshedSources,
        maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "failed", issues: Object.keys(refreshedSources).map((path) => ({ code: "source_changed", path, message: "正文已变化，已自动重读；请重新判断该来源的候选。" })) })
      });
      if (requestedSources.length && !sourcePaths.length) throw new Phase3MaintenanceError("invalid_input", issues.map((issue) => issue.message).join("\n"));
      const actions: NonNullable<PiKnowledgeMaintenanceToolInput["candidateActions"]>[number][] = [];
      for (const action of requestedActions) {
        try {
          const targetPath = await this.normalizeCandidateTarget(action.targetPath);
          const current = await readImmutableFileIfPresent(this.vaultRootPath, targetPath);
          const expected = action.expectedTarget;
          if (expected.kind === "missing" ? current !== null : !current || `sha256:${current.sha256}` !== expected.contentRevision) {
            throw new Error("目标已变化，已重读并保留最新内容；请重新读取此目标后调整候选。");
          }
          actions.push({ ...action, targetPath });
        } catch (error) { for (const source of candidateSourcePaths(action.content, requestedSources)) failedSourcePaths.add(source); issues.push({ code: "candidate_skipped", path: action.targetPath, message: `处理候选 ${action.targetPath}：${knowledgeErrorDetail(error)}` }); }
      }
      if (requestedActions.length && !actions.length) return Object.freeze({ status: "failed", errorCode: "proposal_invalid", message: issues.map((issue) => issue.message).join("\n"), maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "failed", issues }) });
      const preference = requirePreferenceSnapshot(input.preferenceSnapshot);
      const proposal = new FilePhase3MaintenanceShadowProposalPort({
          vaultRootPath: this.vaultRootPath,
          privateKnowledgeRootPath: this.privateKnowledgeRootPath,
          vaultId: this.vaultId,
          candidateActions: actions,
          failedSourcePaths,
          assessments: input.assessments,
          readSourcePaths: Object.keys(input.sourceBodyFingerprints ?? {}),
          issues
      });
      const committed = await this.createService(proposal).execute({
        vaultId: this.vaultId,
        dateKey: this.dateKey(),
        explicitRawPaths: sourcePaths,
        preference,
        toolCall: {
          productRunId: input.productRunId,
          toolCallId: input.toolCallId,
          conversationId: input.conversationId,
          piSessionId: input.piSessionId,
          vaultId: input.vaultId,
          userId: this.userId,
          deviceId: this.deviceId
        },
        ...(input.signal ? { signal: input.signal } : {})
      });
      const stale = committed.notes.length === 0 ? committed.issues.find((issue) => issue.code === "preview_stale" && (issue.path && knowledgePathPolicy(this.vaultRootPath, issue.path).startsWith("raw/"))) : undefined;
      if (stale?.path) throw new Phase3MaintenanceError("preview_stale", stale.message, stale.path);
      if (committed.appliedPaths.length && this.onCommitted) {
        await Promise.resolve(this.onCommitted(committed.appliedPaths))
          .catch(() => undefined);
      }
      return Object.freeze({
        status: committed.status === "completed" || committed.status === "partial" ? "completed" as const : "failed" as const,
        processedSourcePaths: Object.freeze((await readPrivateMaintenanceRecord(this.privateKnowledgeRootPath, `maintenance-${sha256(`${input.productRunId}:${input.toolCallId}`).slice(0, 32)}`, this.vaultId))?.sources.filter((source) => source.status === "processed").map((source) => source.path) ?? []),
        producedPaths: committed.appliedPaths,
        maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
          status: committed.status === "completed" && committed.notes.length === 0
            ? (requestedActions.length ? "failed" : "noop")
            : committed.status === "completed" && issues.length ? "partial" : committed.status,
          notes: committed.notes,
          issues: [...issues, ...committed.issues],
          systemPaths: committed.systemPaths,
          assessments: input.assessments
        }),
        protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
        preferenceProfileVersion:
          preference.profileVersion,
        preferenceState: preference.state,
        ...(committed.status === "completed"
          ? {}
          : { errorCode: committed.issues.some((issue) => issue.code === "record_pending") ? "record_pending" as const : committed.status === "write_uncertain"
              ? "write_uncertain" as const
              : "write_failed" as const }),
        message: [
          committed.status === "completed" && actions.length === 0
            ? (proposal.usedSourcePaths.size ? "已读取的 Raw 没有可提炼内容；原文保留，本轮未生成知识笔记。" : "本轮未生成知识笔记；未读或未采用的 Raw 保留为待处理。")
            : committed.status === "completed"
              ? "知识维护已安全写入并完成 Readback。"
              : committed.status === "partial"
                ? "知识维护部分完成；仅展示已回读验证的知识笔记。"
                : committed.status === "write_uncertain"
                  ? "知识写入状态不确定，已停止继续写入。"
                  : "知识维护失败，未完成回读验证的候选不会显示为成功。",
          ...issues.map((issue) => issue.message),
          ...committed.issues.map((issue) => issue.message),
          ...committed.appliedPaths.map((relativePath) => `- ${relativePath}`)
        ].join("\n")
      });
    } catch (error) {
      if (input.signal?.aborted) return cancelledResult();
      if (error instanceof Phase3MaintenanceError && error.code === "preview_stale" && (error.relativePath && knowledgePathPolicy(this.vaultRootPath, error.relativePath).startsWith("raw/"))) {
        try {
          const file = await readImmutableFile(this.vaultRootPath, error.relativePath);
          const fingerprint = rawDigestFingerprint(error.relativePath, file.bytes);
          let excerpt = UTF8_DECODER.decode(file.bytes);
          while (Buffer.byteLength(excerpt, "utf8") > 5_500) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
          return Object.freeze({ status: "failed", errorCode: "preview_stale", refreshedSources: { [error.relativePath]: fingerprint },
            message: `执行中来源正文变化，已自动重读 ${error.relativePath}。当前全文版本 ${fingerprint}；返回 ${Buffer.byteLength(excerpt, "utf8")} / ${file.bytes.length} 字节，请按当前内容重新判断该候选，其他来源无需重来：\n${excerpt}`,
            maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "failed", issues: [{ code: "source_changed", path: error.relativePath, message: "执行中正文变化，已自动重读，请修正受影响候选后继续。" }] }) });
        } catch { /* report the original specific failure if reread is unavailable */ }
      }
      return Object.freeze({
        status: "failed" as const,
        ...(error instanceof Phase3MaintenanceError
          ? { errorCode: error.code }
          : { errorCode: "knowledge_maintenance_failed" as const }),
        message: safeMaintenanceError(error),
        maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
          status: error instanceof Phase3MaintenanceError
            && error.code === "write_uncertain"
            ? "write_uncertain"
            : "failed",
          // Preserve per-candidate paths when the proposal rejects every item.
          // Settlement can then match a later successful correction precisely.
          issues: error instanceof Phase3MaintenanceError && error.code === "proposal_invalid" && issues.length
            ? issues : [{
            code: error instanceof Phase3MaintenanceError
              ? error.code
              : "knowledge_maintenance_failed",
            message: safeMaintenanceError(error),
            ...(error instanceof Phase3MaintenanceError && error.relativePath
              ? { path: error.relativePath }
              : {})
          }],
          assessments: input.assessments
        })
      });
    }
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
      pathPolicy: (relative) => knowledgePathPolicy(this.vaultRootPath, relative),
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
    if (wal.terminalRecord) { await this.saveRecord(wal.terminalRecord); return; }
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
    await this.saveRecord({ schemaVersion: 1, recordId, runId, at, date: wal.preview.dateKey, result, sources, summary: issues.length ? "本轮有未完成项" : notes.length ? `已保存 ${notes.length} 篇知识笔记` : "本轮无需新增知识笔记" });
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
    if (knowledgePathRole(this.vaultRootPath, input.relativePath) !== "raw") throw new Error("资料不在已绑定的来源范围内。");
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

export async function privateMaintenanceSourceScope(vaultRoot: string) {
  const index = await import("../knowledge-base/incremental-index");
  const registry = await readRawDigestRegistry(vaultRoot, true);
  const refreshed = await index.refreshKnowledgeBaseIndex(vaultRoot, { roots: ["raw"], validateRawSafety: true });
  return { folderBindingsRevision: getKnowledgeFolderBindings(vaultRoot)?.revision ?? 0, sourcePaths: Object.values(refreshed.index.entries).filter((entry) => entry.root === "raw" && isRawMarkdownPath(entry.path) && (!registry.entries[entry.path] || registry.entries[entry.path].fingerprint !== entry.fingerprint)).map((entry) => entry.path).sort().slice(0, 20) };
}

class PrivateMaintenanceTrackerPort implements Phase3MaintenanceTrackerPort {
  constructor(private readonly vaultRoot: string) {}
  async snapshot(): Promise<Readonly<Phase3MaintenanceTrackerSnapshot>> {
    const index = await import("../knowledge-base/incremental-index");
    const registry = await readRawDigestRegistry(this.vaultRoot, true);
    const sources = (await index.refreshKnowledgeBaseIndex(this.vaultRoot, { roots: ["raw"], validateRawSafety: true })).index;
    return { binding: { kind: "missing" }, changedRawPaths: Object.values(sources.entries).filter((entry) => entry.root === "raw" && (!registry.entries[entry.path] || registry.entries[entry.path].fingerprint !== entry.fingerprint)).map((entry) => entry.path) };
  }
}

class FilePhase3MaintenanceTrackerPort implements Phase3MaintenanceTrackerPort {
  private readonly vaultRootPath: string;

  constructor(private readonly options: Readonly<{
    vaultRootPath: string;
    vaultId: string;
    domainService: VaultDomainService;
  }>) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
  }

  async snapshot(input: Readonly<{
    vaultId: string;
  }>): Promise<Readonly<Phase3MaintenanceTrackerSnapshot>> {
    if (input.vaultId !== this.options.vaultId) {
      throw new Error("phase3_tracker_vault_mismatch");
    }
    const [file, readback] = await Promise.all([
      readImmutableFileIfPresent(
        this.vaultRootPath,
        PHASE3_MAINTENANCE_TRACKER_PATH
      ),
      this.options.domainService.readback({
        vaultId: input.vaultId,
        relativePath: resolveKnowledgePath(this.vaultRootPath, PHASE3_MAINTENANCE_TRACKER_PATH)
      })
    ]);
    if (!file) {
      if (readback.status !== "missing") {
        throw new Error("phase3_tracker_readback_mismatch");
      }
      return Object.freeze({
        binding: Object.freeze({ kind: "missing" as const }),
        changedRawPaths: Object.freeze([])
      });
    }
    if (
      readback.status !== "present"
      || !readback.snapshot
      || readback.snapshot.contentSha256 !== file.sha256
      || readback.snapshot.byteLength !== file.bytes.length
    ) {
      throw new Error("phase3_tracker_readback_mismatch");
    }
    return Object.freeze({
      binding: Object.freeze({
        kind: "file" as const,
        version: readback.snapshot.version,
        contentSha256: file.sha256,
        byteLength: file.bytes.length
      }),
      changedRawPaths: Object.freeze(parseChangedRawPaths(
        UTF8_DECODER.decode(file.bytes)
      ).map((source) => resolveKnowledgePath(this.vaultRootPath, source)))
    });
  }
}

class FilePhase3MaintenanceShadowProposalPort
implements Phase3MaintenanceProposalPort {
  readonly usedSourcePaths = new Set<string>();
  private readonly vaultRootPath: string;
  private readonly privateKnowledgeRootPath: string;

  constructor(private readonly options: Readonly<{
    vaultRootPath: string;
    privateKnowledgeRootPath: string;
    vaultId: string;
    issues: { code: string; message: string; path?: string }[];
    failedSourcePaths: Set<string>;
    assessments?: readonly import("../knowledge-base/knowledge-maintenance-result").KnowledgeMaintenanceAssessment[];
    readSourcePaths: readonly string[];
    candidateActions: readonly Readonly<{
      targetPath: string;
      content: string;
      expectedTarget: Readonly<
        | { kind: "missing" }
        | { kind: "file"; contentRevision: string }
      >;
    }>[];
  }>) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
    this.privateKnowledgeRootPath = path.resolve(
      options.privateKnowledgeRootPath
    );
  }

  async generate(
    input: Readonly<Phase3MaintenanceProposalInput>
  ): Promise<Readonly<Phase3MaintenanceProposal>> {
    if (input.vaultId !== this.options.vaultId) {
      throw new Error("phase3_shadow_vault_mismatch");
    }
    const previewId = requireControlId(input.previewId);
    const shadowRoot = await ensurePrivateStateDirectory(
      this.privateKnowledgeRootPath,
      ["shadow", previewId]
    );
    const knowledgeActions: { targetPath: string; content: string; expectedTarget: typeof this.options.candidateActions[number]["expectedTarget"] }[] = [];
    for (const action of this.options.candidateActions) {
      try {
        const content = completeKnowledgeMaintenanceCandidateSources({
          targetPath: action.targetPath, content: action.content,
          resolvePath: (value) => resolveKnowledgePath(this.vaultRootPath, value),
          selectedSources: input.selectedSources.map((source) => ({ relativePath: source.raw.relativePath, contentSha256: source.raw.contentSha256 }))
        });
        const adopted = validateKnowledgeMaintenanceCandidateSources({ targetPath: action.targetPath, content,
          selectedSources: input.selectedSources.map((source) => ({ relativePath: source.raw.relativePath, contentSha256: source.raw.contentSha256 })) });
        for (const source of adopted) this.usedSourcePaths.add(source.relativePath);
        knowledgeActions.push({ ...action, content });
      } catch (error) { for (const source of candidateSourcePaths(action.content, input.selectedSources.map((source) => source.raw.relativePath))) this.options.failedSourcePaths.add(source); this.options.issues.push({ code: "candidate_skipped", path: action.targetPath, message: `处理候选 ${action.targetPath}：${knowledgeErrorDetail(error)}` }); }
    }
    if (this.options.candidateActions.length && !knowledgeActions.length) throw new Phase3MaintenanceError("proposal_invalid", this.options.issues.map((issue) => issue.message).join("\n"));
    const usedNames = new Set<string>();
    for (const action of knowledgeActions) {
      const fileName = uniqueShadowFileName(action.targetPath, usedNames);
      await writeNewFileWithReadback(
        path.join(shadowRoot, fileName),
        Buffer.from(action.content, "utf8")
      );
    }
    for (const source of input.selectedSources) {
      if (this.options.readSourcePaths.includes(source.raw.relativePath)) this.usedSourcePaths.add(source.raw.relativePath);
    }
    const actions = Object.freeze(knowledgeActions);
    return Object.freeze({
      shadowId: previewId,
      bookkeeping: { readSourcePaths: this.options.readSourcePaths, failedSourcePaths: [...this.options.failedSourcePaths], assessments: this.options.assessments, issues: [...this.options.issues] },
      shadowRevision: sha256(stableJson(actions)),
      actions: Object.freeze(actions.map((action) =>
        Object.freeze({
          targetPath: action.targetPath,
          content: action.content,
          ...(action.expectedTarget
            ? { expectedTarget: action.expectedTarget }
            : {})
        })
      ))
    });
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
    try {
      const candidate = normalizeVaultRelativePath(match[0].trim());
      if (knowledgePathRole(vaultRoot, candidate) !== "raw") throw new Error("指定资料不在来源范围，不能回退全局维护。");
      paths.add(candidate);
    } catch (error) { throw error; }
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

import type { PdfDependencies } from "../../pdf-reading/service";
import { pdfReadingPage } from "../../pdf-reading/reading-page";
import { createHash } from "node:crypto";
import { defineTool, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import type { PdfReadingController } from "../../pdf-reading/controller";
import type { PiWorkspaceAccess } from "./pi-workspace-access";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy, secureVaultToolResult } from "./vault-tool-result-safety";
import { pdfNoteLink, pdfResultsTable } from "../../pdf-reading/results";
import type { PiChatPreparedDocument } from "./contracts";
import type { PdfAttachmentReceipt } from "../../pdf-reading/attachment-receipt";
import { pdfLanguage } from "../../pdf-reading/language";
import { extractKnowledgeLinks, resolveKnowledgeLink } from "../../knowledge-base/knowledge-relations";
import type { PdfJob, PdfOptions, PdfStartIntent, PdfTaskRequest } from "../../pdf-reading/types";
import type { FileDomainReceiptStore } from "./domain-receipt-store";
import { normalizeJsonValue, type ApprovalOperationContract, type FileApprovalTicketStore, type JsonValue, type WriteToolAuthorizationContext } from "./tool-authorization";
import { requireProPlugin, unavailableCapabilityAccess } from "../../membership/access";

export const PDF_TOOL_NAMES = ["pdf_reading_query", "pdf_reading_process"] as const;
type PdfArgs = { path?: string; attachmentId?: string; jobId?: string; enhanced?: boolean; reading?: boolean; summary?: boolean; translation?: boolean; translationLanguage?: string; readingOffset?: number };
interface PdfRunIdentity { vaultId: string; conversationId: string; piSessionId: string; productRunId: string }
export interface PdfApprovalInput extends PdfRunIdentity {
  requestId: string; toolCallId: string; toolId: "pdf_reading_process"; target: JsonValue; preview: JsonValue; signal: AbortSignal | undefined;
}
export interface PiPdfReadingSecurityOptions {
  assertToolAllowed?(name: string, args: Readonly<Record<string, unknown>>, resolvedTarget?: unknown, currentOperation?: Readonly<{ productRunId: string; toolCallId: string }>): Promise<void>;
  host(): PdfReadingController | null | undefined; access(): PiWorkspaceAccess | null | undefined;
  identity(): string; intentId(): string; conversationId?(): string;
  request?(): Readonly<PdfTaskRequest> | undefined;
  currentRunIdentity?(): PdfRunIdentity;
  approvals?: FileApprovalTicketStore; receipts?: FileDomainReceiptStore;
  confirmation?: { confirm(input: PdfApprovalInput): Promise<boolean> }; userId?: string; deviceId?: string;
  resumeIntentId?(): string | undefined; resumeOperations?(): readonly PiPdfResumeOperation[]; generator?: PdfDependencies["generator"];
  bindDeliveryJob?(jobId: string): void;
  bindSources(paths: readonly string[]): void; wikiPaths(rawPath: string): Promise<readonly string[]>;
  documents(): readonly Readonly<PiChatPreparedDocument>[];
  consume(attachmentId: string, sha256: string): Readonly<{ conversationId: string; userEntryId: string }> | null;
}
interface PdfPrepared {
  jobId: string; options: PdfOptions; intent?: PdfStartIntent; existing: boolean; attachmentId?: string; path?: string;
  sourceFingerprint?: string; request?: Readonly<PdfTaskRequest>; run: PdfRunIdentity;
  target: JsonValue; version: JsonValue; authorization?: Readonly<WriteToolAuthorizationContext>;
}
interface PdfCall { name: string; args: PdfArgs; identity: string; consumed: boolean; prepared?: PdfPrepared; result?: string; error?: boolean; status?: string; readbackVerified?: boolean; receipt?: PdfAttachmentReceipt; operationIdentity?: string }
export interface PiPdfResumeOperation { readonly toolCallId: string; readonly userEntryId: string; readonly arguments: Readonly<Record<string, unknown>>; readonly jobId: string; readonly sourceFingerprint?: string }
export class PiPdfReadingSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PDF_TOOL_NAMES[0]; readonly toolNames = PDF_TOOL_NAMES;
  private calls = new Map<string, PdfCall>();
  private seen = new Set<string>();
  constructor(private readonly options: PiPdfReadingSecurityOptions) {}
  private attachment(id: string): Readonly<PiChatPreparedDocument> {
    const document = this.options.documents().find(d => d.transport === "tool_reference" && d.attachmentId === id);
    if (!document) throw new Error("本轮 PDF 附件不可用；请查询当前附件或重新上传同一文件以恢复。");
    return document;
  }
  private writable(): void {
    const access = this.options.access();
    if (!access || access.mode === "plan" || access.permission === "read-only") throw new Error("tool_policy_blocked");
  }
  private runIdentity(): PdfRunIdentity | undefined {
    const run = this.options.currentRunIdentity?.();
    return run && { vaultId: run.vaultId, conversationId: run.conversationId, piSessionId: run.piSessionId, productRunId: run.productRunId };
  }
  private request(args: PdfArgs): Readonly<PdfTaskRequest> | undefined {
    const request = this.options.request?.();
    if (!request) return undefined;
    if (args.path || args.jobId && args.jobId !== request.jobId || args.attachmentId && args.attachmentId !== request.attachmentId)
      throw new Error("pdf_task_file_mismatch");
    const selected = request.options;
    if (args.enhanced !== undefined && args.enhanced !== (selected.engine === "mineru")
      || args.reading !== undefined && args.reading !== selected.reading
      || args.summary !== undefined && args.summary !== (selected.summary === true)
      || args.translation !== undefined && args.translation !== selected.translation
      || args.translationLanguage !== undefined && pdfLanguage(args.translationLanguage) !== pdfLanguage(selected.translationLanguage ?? "中文"))
      throw new Error("pdf_task_options_mismatch");
    return structuredClone(request);
  }
  private async check(args: PdfArgs, id: string, prepared: PdfPrepared, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("approval_cancelled");
    if (!isDeepStrictEqual(prepared.run, this.runIdentity()) || !isDeepStrictEqual(prepared.request, this.request(args))) throw new Error("pdf_task_context_changed");
    if (this.options.conversationId && this.options.conversationId() !== prepared.run.conversationId) throw new Error("pdf_task_context_changed");
    this.writable();
    const host = this.options.host();
    requireProPlugin(host?.api.deps.access ?? unavailableCapabilityAccess);
    if (!host?.api.deps.enabled()) throw new Error("请先启用 PDF 精读 · 提取。");
    await this.options.assertToolAllowed?.("pdf_reading_process", args, prepared.target, { productRunId: prepared.run.productRunId, toolCallId: id });
    if (!isDeepStrictEqual(prepared.run, this.runIdentity()) || !isDeepStrictEqual(prepared.request, this.request(args))) throw new Error("pdf_task_context_changed");
    this.writable();
  }
  private async sourceBytes(attachmentId?: string, path?: string): Promise<Uint8Array | undefined> {
    if (attachmentId) {
      const document = this.attachment(attachmentId);
      const bytes = new Uint8Array(document.bytes as Uint8Array);
      if (hash(bytes) !== document.sha256) { bytes.fill(0); throw new Error("pdf_source_changed"); }
      return bytes;
    }
    const files = this.options.host()!.api.files;
    return path && files.readBinary ? new Uint8Array(await files.readBinary(path)) : undefined;
  }
  private async fileVersions(paths: readonly string[]): Promise<JsonValue> {
    const files = this.options.host()!.api.files;
    return await Promise.all([...new Set(paths)].map(async path => {
      if (!await files.exists(path)) return { path, version: null };
      let bytes: Uint8Array;
      try { if (!files.readBinary) throw new Error("text_only"); bytes = await files.readBinary(path); }
      catch { bytes = new TextEncoder().encode(await files.read(path)); }
      return { path, version: hash(bytes) };
    }));
  }
  private async prepare(args: PdfArgs): Promise<PdfPrepared> {
    const host = this.options.host(); if (!host) throw new Error("PDF 插件不可用。");
    const run = this.runIdentity();
    if (!run || !this.options.approvals || !this.options.receipts || !this.options.confirmation || !this.options.userId || !this.options.deviceId
      || run.vaultId !== this.options.approvals.vaultId || run.vaultId !== this.options.receipts.vaultId) throw new Error("authorization_failed");
    const request = this.request(args);
    if (!request && args.jobId && [args.enhanced, args.reading, args.summary, args.translation, args.translationLanguage].some(value => value !== undefined))
      throw new Error("继续 PDF 任务不能改变原成果选项，请查询原任务后继续。");
    const operation = request?.jobId ?? hash(`${this.options.resumeIntentId?.() ?? this.options.intentId()}\n${JSON.stringify(args)}`);
    const ids = new Set(await host.api.files.listJobs());
    let jobId = args.jobId ?? request?.jobId ?? (ids.has(operation) ? operation : undefined);
    let attachmentId = args.attachmentId ?? (request && this.options.documents().some(document => document.transport === "tool_reference" && document.attachmentId === request.attachmentId)
      ? request.attachmentId : undefined);
    const document = attachmentId ? this.options.documents().find(document => document.transport === "tool_reference" && document.attachmentId === attachmentId) : undefined;
    if (!jobId && this.options.resumeIntentId?.()) {
      const matches: string[] = [];
      for (const previous of this.options.resumeOperations?.() ?? []) {
        if (!ids.has(previous.jobId)) continue;
        const samePath = args.path && previous.arguments.path === args.path;
        const sameAttachment = attachmentId && previous.arguments.attachmentId === attachmentId;
        const sameBytes = document && (await host.api.load(previous.jobId)).sourceFingerprint === document.sha256;
        if ((samePath || sameAttachment || sameBytes) && !matches.includes(previous.jobId)) matches.push(previous.jobId);
      }
      if (matches.length > 1) throw new Error("中断任务有多个相同来源的 PDF 任务；请先查询，再用明确的原 jobId 继续。");
      jobId = matches[0];
    }
    if (args.jobId && !ids.has(args.jobId) && request?.jobId !== args.jobId) throw new Error("PDF 任务不可用，请先查询历史。");
    const saved = jobId && ids.has(jobId) ? await host.api.load(jobId) : undefined;
    if (saved?.conversationId && saved.conversationId !== run.conversationId) throw new Error("pdf_task_conversation_mismatch");
    if (saved && request && (saved.sourceFingerprint !== request.sourceFingerprint || saved.original && !saved.original.plannedPath.startsWith(`${request.originalDirectory}/`))) throw new Error("pdf_task_file_mismatch");
    if (saved && request && (saved.options.engine !== request.options.engine || saved.options.reading !== request.options.reading
      || (saved.options.summary === true) !== (request.options.summary === true) || saved.options.wiki !== request.options.wiki
      || pdfLanguage(saved.options.translationLanguage ?? "中文") !== pdfLanguage(request.options.translationLanguage ?? "中文")
      || saved.options.translation !== request.options.translation && !(request.options.translation && !saved.options.translation && saved.sourceLanguage === pdfLanguage(request.options.translationLanguage ?? "中文"))))
      throw new Error("pdf_task_options_mismatch");
    if (attachmentId && !document) {
      // A cold resumed run can still mention its frozen, already-consumed ID.
      // Ignore only that exact stale reference after the durable original is
      // verified; live/reuploaded bytes always retain the normal hash checks.
      if (!request || attachmentId !== request.attachmentId || saved?.id !== request.jobId
        || saved.conversationId !== run.conversationId || !saved.original || saved.sourceFingerprint !== request.sourceFingerprint)
        throw new Error("本轮 PDF 附件不可用；请查询当前附件或重新上传同一文件以恢复。");
      const original = await host.api.readOriginal(saved); original.fill(0);
      attachmentId = undefined;
    }
    if (saved && document && saved.sourceFingerprint !== document.sha256) throw new Error("请选择本任务的同一 PDF，未替换远端任务。");
    const selected = request?.options ?? saved?.options ?? { engine: args.enhanced === undefined ? host.plugin.settings.pdfReading.engine : args.enhanced ? "mineru" : "local",
      reading: args.reading !== false, summary: args.summary === true, translation: args.translation === true,
      translationLanguage: pdfLanguage(args.translationLanguage ?? host.plugin.settings.pdfReading.translationLanguage), wiki: args.reading !== false || args.summary === true };
    const options: PdfOptions = { ...selected, translationLanguage: pdfLanguage(selected.translationLanguage ?? host.plugin.settings.pdfReading.translationLanguage) };
    const bytes = await this.sourceBytes(attachmentId, args.path);
    let intent: PdfStartIntent | undefined;
    try {
      if (request && bytes && (hash(bytes) !== request.sourceFingerprint || bytes.length !== request.byteLength || document?.attachment.name !== request.name)) throw new Error("pdf_task_file_mismatch");
      if (saved && bytes && saved.sourceFingerprint !== hash(bytes)) throw new Error("pdf_source_changed");
      if (!saved) {
        if (!bytes) throw new Error("请选择本轮 PDF 附件或库内确切 PDF 路径。");
        intent = await host.api.prepareStartIntent(document?.attachment.name ?? args.path!.split("/").at(-1)!, bytes, options, jobId ?? operation,
          { conversationId: run.conversationId, ...(request ? { originalDirectory: request.originalDirectory } : {}) });
      } else {
        intent = { id: saved.id, name: saved.name, sourceFingerprint: saved.sourceFingerprint!, byteLength: saved.original?.byteLength ?? bytes?.length ?? 0,
          options, rawDirectory: saved.rawDirectory, ...(saved.artifactPrefix ? { artifactPrefix: saved.artifactPrefix } : {}),
          ...(saved.original ? { original: structuredClone(saved.original) } : {}), ...(saved.conversationId ? { conversationId: saved.conversationId } : {}) };
      }
    } finally { bytes?.fill(0); }
    const original = saved?.original ?? intent?.original;
    const sourceFingerprint = saved?.sourceFingerprint ?? intent?.sourceFingerprint;
    const target = normalizeJsonValue({ jobId: saved?.id ?? intent!.id, sourcePath: args.path ?? null, originalPath: original?.plannedPath ?? null,
      rawDirectory: saved?.rawDirectory ?? intent!.rawDirectory, artifactPaths: saved?.artifacts.map(artifact => artifact.path) ?? [], options, sourceFingerprint,
      ...(saved?.options.engine === "mineru" && saved.batchId && (saved.uploadState === "uncertain" || saved.uploadState === "uploaded")
        ? { resumeMode: "poll-existing-batch", batchId: saved.batchId } : {}) });
    const paths = [original?.plannedPath, args.path, ...(saved?.artifacts.map(artifact => artifact.path) ?? [])].filter((value): value is string => !!value);
    const version = normalizeJsonValue({ sourceFingerprint, originalPath: original?.plannedPath ?? null,
      originalExpectedVersion: original ? sourceFingerprint : null, files: await this.fileVersions(paths) });
    if (original && await host.api.files.exists(original.plannedPath)) {
      if (!host.api.files.readBinary || hash(await host.api.files.readBinary(original.plannedPath)) !== sourceFingerprint) throw new Error("原PDF已经改过，请先核对。");
    } else if (saved?.original?.savedPath) throw new Error("原PDF找不到了，请先恢复后继续。");
    return { jobId: saved?.id ?? intent!.id, options, intent, existing: !!saved, attachmentId, path: args.path, sourceFingerprint, request, run, target, version };
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    try {
      if (this.seen.has(event.toolCallId) || signal?.aborted || !PDF_TOOL_NAMES.some(name => name === event.toolName)) throw new Error("authorization_failed");
      this.seen.add(event.toolCallId);
      const args = normalize(event.input, event.toolName);
      await this.options.assertToolAllowed?.(event.toolName, args, event.toolName === "pdf_reading_process" && this.options.request?.()
        ? { options: this.request(args)!.options } : undefined);
      const call: PdfCall = { name: event.toolName, args, identity: this.options.identity(), consumed: false };
      if (event.toolName === "pdf_reading_process") {
        this.writable();
        const prepared = await this.prepare(args);
        await this.check(args, event.toolCallId, prepared, signal);
        const { approvals, receipts, confirmation, userId, deviceId } = this.options;
        const contract: ApprovalOperationContract = { ...prepared.run, toolCallId: event.toolCallId, toolId: "pdf_reading_process", userId: userId!, deviceId: deviceId!,
          toolVersion: "pdf-reading-tools-v2", policyVersion: "pdf-reading-policy-v2", normalizedArguments: normalizeJsonValue(args),
          resolvedTarget: prepared.target, targetVersion: prepared.version,
          preview: normalizeJsonValue({ domain: "pdf", action: prepared.existing ? "resume-same-job" : "save-original-and-process", target: prepared.target,
            recipient: prepared.options.engine === "mineru" ? "PDF 将发送至 MinerU；复用已有上传批次，未知上传不重传。" : "本地提取。",
            model: prepared.options.reading || prepared.options.summary || prepared.options.translation ? "提取正文将发送给当前模型。" : "只提取原文，不调用模型。",
            delivery: { extract: true, reading: prepared.options.reading, summary: prepared.options.summary === true, translation: prepared.options.translation },
            knowledge: "原文和译文写入资料来源；精读、摘要经正式知识维护保存至 Wiki，内部分析不算已保存成果。原有源文件保留。" }) };
        const issuedAt = Date.now();
        const ticket = await approvals!.issue({ ...contract, issuedAt, expiresAt: issuedAt + 300_000 });
        let accepted: boolean;
        try { accepted = await confirmation!.confirm({ ...prepared.run, requestId: ticket.ticketId, toolCallId: event.toolCallId,
          toolId: "pdf_reading_process", target: ticket.resolvedTarget, preview: ticket.preview, signal }); }
        catch { await approvals!.resolve({ ticketId: ticket.ticketId, productRunId: prepared.run.productRunId, toolCallId: event.toolCallId, resolution: "cancelled" }); throw new Error("approval_cancelled"); }
        if (!accepted || signal?.aborted) {
          const resolution = signal?.aborted ? "cancelled" : "denied";
          await approvals!.resolve({ ticketId: ticket.ticketId, productRunId: prepared.run.productRunId, toolCallId: event.toolCallId, resolution });
          throw new Error(resolution === "cancelled" ? "approval_cancelled" : "approval_denied");
        }
        await this.check(args, event.toolCallId, prepared, signal);
        await this.assertVersions(prepared);
        prepared.authorization = await approvals!.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
        await receipts!.beginAuthorizedOperation(prepared.authorization);
        call.prepared = prepared;
        call.operationIdentity = ticket.operationIdentity;
      }
      this.calls.set(event.toolCallId, call);
    } catch (error) { return { block: true as const, reason: error instanceof Error ? error.message : "tool_policy_blocked" }; }
  }
  private async assertVersions(prepared: PdfPrepared): Promise<void> {
    const expected = (prepared.version as { files: Array<{ path: string; version: string | null }> }).files;
    if (!isDeepStrictEqual(await this.fileVersions(expected.map(file => file.path)), expected)) throw new Error("pdf_file_version_changed");
    const bytes = await this.sourceBytes(prepared.attachmentId, prepared.path);
    try { if (bytes && hash(bytes) !== prepared.sourceFingerprint) throw new Error("pdf_source_changed"); }
    finally { bytes?.fill(0); }
  }
  private async originalResult(job: PdfJob): Promise<{ text: string; verified: boolean }> {
    if (!job.original) return { text: "原 PDF：这份历史记录没有保存原件。", verified: false };
    const path = job.original.savedPath ?? job.original.plannedPath;
    try {
      const bytes = await this.options.host()!.api.readOriginal(job); bytes.fill(0);
      return { text: `原 PDF：${pdfNoteLink(path, "原文件")} · ${path} · ${job.original.savedPath ? "已保存并通过字节回读" : "文件已通过字节回读，保存关联待完成"}。`, verified: true };
    } catch (error) {
      const reason = error instanceof Error && error.message.includes("改过") ? "原 PDF 已经改过，请先核对，不能继续处理。"
        : error instanceof Error && error.message.includes("找不到") ? "原 PDF 找不到了，请先恢复，不能继续处理。"
          : "原 PDF 尚未通过回读，请先核对，不能继续处理。";
      return { text: `原 PDF：${path} · ${reason}`, verified: false };
    }
  }
  async execute(id: string, name: string, args: PdfArgs, signal?: AbortSignal): Promise<void> {
    const call = this.calls.get(id);
    if (!call || call.consumed || call.name !== name || call.identity !== this.options.identity() || JSON.stringify(call.args) !== JSON.stringify(normalize(args, name))) throw new Error("authorization_failed");
    await this.options.assertToolAllowed?.(name, args, call.prepared?.target,
      call.prepared ? { productRunId: call.prepared.run.productRunId, toolCallId: id } : undefined);
    call.consumed = true;
    try {
      const host = this.options.host(); if (!host) throw new Error("PDF 插件尚未准备好。");
      let jobs: PdfJob[];
      if (name === "pdf_reading_query") {
        const request = this.options.request?.();
        if (args.jobId && args.jobId === request?.jobId && !(await host.api.files.listJobs()).includes(args.jobId)) {
          call.status = "not_started";
          call.result = `这份 PDF 尚未开始，原件和成果还没有保存。请使用 pdf_reading_process 处理本任务附件 ${request.attachmentId}，沿用已冻结的 jobId 和成果选择；正式批准后才保存和处理。`;
          call.readbackVerified = true;
          return;
        }
        jobs = args.jobId ? [await host.api.load(args.jobId).catch(() => { throw new Error("PDF 任务记录暂时读不到，请核对任务或重新查询历史。"); })] : (await host.api.history()).slice(0, 20);
        if (args.jobId && jobs[0]?.conversationId && jobs[0].conversationId === this.runIdentity()?.conversationId) this.options.bindDeliveryJob?.(jobs[0].id);
      }
      else {
        this.writable();
        const prepared = call.prepared;
        if (!prepared?.authorization) throw new Error("authorization_failed");
        await this.check(call.args, id, prepared, signal);
        await this.assertVersions(prepared);
        const saved = prepared.existing ? await host.api.load(prepared.jobId) : undefined;
        const target = prepared.target as { resumeMode?: string; batchId?: string };
        if (target.resumeMode === "poll-existing-batch" && (!saved || saved.batchId !== target.batchId || saved.uploadState !== "uncertain" && saved.uploadState !== "uploaded"))
          throw new Error("pdf_file_version_changed");
        if (saved && prepared.intent && (saved.id !== prepared.intent.id || saved.name !== prepared.intent.name
          || saved.sourceFingerprint !== prepared.intent.sourceFingerprint || saved.rawDirectory !== prepared.intent.rawDirectory
          || saved.original?.plannedPath !== prepared.intent.original?.plannedPath || saved.original?.byteLength !== prepared.intent.original?.byteLength
          || saved.options.engine !== prepared.options.engine || saved.options.reading !== prepared.options.reading
          || (saved.options.summary === true) !== (prepared.options.summary === true) || saved.options.wiki !== prepared.options.wiki
          || pdfLanguage(saved.options.translationLanguage ?? host.plugin.settings.pdfReading.translationLanguage) !== pdfLanguage(prepared.options.translationLanguage ?? host.plugin.settings.pdfReading.translationLanguage)
          || saved.options.translation !== prepared.options.translation && !(prepared.options.translation && !saved.options.translation && saved.sourceLanguage === pdfLanguage(prepared.options.translationLanguage ?? "中文"))))
          throw new Error("pdf_file_version_changed");
        await this.options.receipts!.markEffectStarted(prepared.authorization.operationIdentity);
        const context = { conversationId: prepared.run.conversationId,
          ...(prepared.request ? { originalDirectory: prepared.request.originalDirectory } : {}), intent: prepared.intent,
          assertCanWrite: () => this.check(call.args, id, prepared, signal) };
        const bytes = await this.sourceBytes(prepared.attachmentId, prepared.path);
        let job: PdfJob;
        try {
          job = saved?.state === "completed" && (!saved.original || saved.original.savedPath) ? saved
            : saved ? await host.api.resume(prepared.jobId, signal, bytes, this.options.generator, context)
            : bytes ? await host.api.start(prepared.intent!.name, bytes, prepared.options, signal, prepared.jobId, this.options.generator, context)
            : await host.processVault(prepared.path!, prepared.options, signal, prepared.jobId, this.options.generator, context);
        } finally { bytes?.fill(0); }
        this.options.bindDeliveryJob?.(job.id);
        call.status = job.state; call.error = job.state !== "completed";
        jobs = [job];
      }
      call.status ??= "completed";
      if (name === "pdf_reading_query" && args.readingOffset !== undefined) {
        const reading = jobs[0]!.chunks.filter(c => c.reading).map(c => `第 ${c.page} 页 · 片段 ${c.part}\n${c.reading}`).join("\n\n");
        const page = pdfReadingPage(reading, args.readingOffset);
        call.result = `内部精读辅助材料（原文需另行实际读取），位置 ${args.readingOffset}/${page.total}。\nnextOffset=${page.nextOffset ?? "null（已到结尾）"}\n\n${page.text}`;
        call.readbackVerified = true;
        return;
      }
      const results: string[] = [];
      for (const job of jobs) {
        const original = await this.originalResult(job);
        const artifacts = await host.api.actualArtifacts(job);
        if (name === "pdf_reading_process" && job.state === "completed"
          && (!artifacts.some(a => a.kind === "raw") || job.artifacts.some(expected => !artifacts.some(actual => actual.path === expected.path)))) {
          throw new Error("已声明成果未全部通过回读；附件仍保留，请先查询任务与缺失文件。");
        }
        if (job.options.reading || job.options.summary) {
          const raw = artifacts.find(a => a.kind === "raw");
          if (raw) for (const path of await this.options.wikiPaths(raw.path)) {
            if (await host.api.files.exists(path) && (await host.api.files.read(path)).trim()) artifacts.push({ kind: "wiki", path });
          }
          if (name === "pdf_reading_process" || args.jobId) this.options.bindSources(artifacts.filter(a => a.kind === "raw" || a.kind === "translation").map(a => a.path));
        }
        const paths = artifacts.map(a => a.path), missing: string[] = [];
        for (const artifact of artifacts) {
          const content = await host.api.files.read(artifact.path);
          const relationshipText = artifact.kind === "raw" ? /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "" : content;
          const linked = extractKnowledgeLinks(relationshipText).flatMap(link => resolveKnowledgeLink({ link, sourcePath: artifact.path, paths, resolveAlias: value => value }));
          for (const other of artifacts) if (other.path !== artifact.path && !(artifact.kind === "wiki" && other.kind === "wiki") && !linked.includes(other.path)) missing.push(`${artifact.path} → ${other.path}`);
        }
        results.push(`任务 ${job.id} · ${job.name} · ${job.state}\n${original.text}\n${pdfResultsTable(artifacts)}\n${job.error ?? ""}\n${job.warnings.join("\n")}\n关系回读：${missing.length ? "尚待补充\n" + missing.join("\n") : "当前实际产物关系完整"}`);
        if (job.state !== "completed" && original.verified) results.push(`原件已经核实，但本任务处理尚未完成。完成的 PDF 回执只证明原件/当次文件已回读，不表示提取、翻译或知识交付完成。请调用 pdf_reading_process({"jobId":"${job.id}"}) 继续同一任务未完成的阶段，不需要临时附件；复用原件和已有结果，不重拷原件，未知远程上传只查询原批次，不重新 POST/PUT。`);
        if (job.options.reading || job.options.summary) {
          const done = job.chunks.filter(c => c.reading);
          results.push(`内部分析覆盖 ${done.length}/${job.chunks.length} 个片段。所选交付：${[job.options.reading ? "精读" : "", job.options.summary ? "摘要" : ""].filter(Boolean).join("、")}。${artifacts.some(a => a.kind === "wiki") ? "已找到版本可靠的 Wiki。" : "尚未确认 Wiki，不能声称知识沉淀完成。"}`);
          if (!artifacts.some(a => a.kind === "wiki")) results.push(`先用 pdf_reading_query(jobId, readingOffset=0) 分页续读全部内部分析；再 knowledge_read 实际 Raw（含译文），以这些路径作为 sourcePaths，经 knowledge_maintain 写入现有分类 Wiki，按本任务分别选中的精读/摘要交付对应段落，两项共用这些分析材料；只选摘要就不交付长篇精读。无需新增时明确说明。Wiki 同时链接所用原文及译文，译文标为生成辅助材料。`);

        }
        if (missing.length) results.push("使用 note_read 获取 Raw 最新 snapshot.version，再 metadata_update(relativePath, expectedVersion, patch.set) 在属性中加入实际笔记链接（如 pdf_related），保留其他属性和正文；Wiki 关系沿 knowledge_maintain 修订。完成后再次 query 本任务核对表格与关系，不猜路径、不另建会话。");
      }
      call.readbackVerified = true;
      const consumedAttachmentId = call.prepared?.attachmentId;
      if (name === "pdf_reading_process" && call.status === "completed" && consumedAttachmentId) {
        const document = this.attachment(consumedAttachmentId);
        const artifacts = await host.api.actualArtifacts(jobs[0]!);
        if (!artifacts.some(a => a.kind === "raw")) throw new Error("原文回读未确认；附件仍保留。");
        const binding = this.options.consume(consumedAttachmentId, document.sha256);
        if (!binding) throw new Error("附件消费未确认；请查询已有任务，不要重复提取。");
        call.receipt = { ...binding, attachmentId: consumedAttachmentId, sha256: document.sha256 };
      }
      if (name === "pdf_reading_query") results.unshift("本轮可处理的临时 PDF 附件：\n" + (this.options.documents().filter(d => d.transport === "tool_reference").map(d => `${d.attachmentId} · ${d.attachment.name}`).join("\n") || "无。"));
      call.result = results.join("\n\n") || "尚无 PDF 成果。";
    } catch (error) { call.result = error instanceof Error ? error.message : "PDF 处理失败；请先查询任务，不要盲目重做。"; call.error = true; }
    finally {
      if (call.prepared?.authorization) await this.recordReceipt(call);
    }
  }
  private async recordReceipt(call: PdfCall): Promise<void> {
    const prepared = call.prepared!, authorization = prepared.authorization!, store = this.options.receipts!;
    try {
      const host = this.options.host()!;
      const journal = await store.readOperation(authorization.operationIdentity);
      let verified = false, files: JsonValue = [], job: PdfJob | undefined;
      try {
        job = await host.api.load(prepared.jobId);
        const originalPath = job.original?.plannedPath;
        if (originalPath) verified = !!host.api.files.readBinary && job.sourceFingerprint === prepared.sourceFingerprint
          && await host.api.files.exists(originalPath) && hash(await host.api.files.readBinary(originalPath)) === prepared.sourceFingerprint;
        else verified = call.readbackVerified === true && (await host.api.actualArtifacts(job)).some(artifact => artifact.kind === "raw");
        if (verified) files = await this.fileVersions([...(originalPath ? [originalPath] : []), ...(prepared.path ? [prepared.path] : []), ...(await host.api.actualArtifacts(job)).map(artifact => artifact.path)]);
      } catch { /* Unknown publication remains uncertain; never manufacture a saved-file receipt. */ }
      if (journal?.effectState === "effect_started") await store.markEffectCompleted(authorization.operationIdentity);
      await store.persistReceipt({ operationIdentity: authorization.operationIdentity,
        status: verified ? "completed" : journal?.effectState === "authorized" ? "failed" : "uncertain",
        safeSummary: normalizeJsonValue({ jobId: prepared.jobId, originalSavedVerified: verified && !!job?.original,
          pipelineStatus: job?.state ?? "unknown", knowledgeDelivery: prepared.options.reading || prepared.options.summary ? "requires_formal_knowledge_readback" : "not_requested" }),
        readback: { checkedAt: Date.now(), readbackVerified: verified,
          observedTargetVersion: normalizeJsonValue({ sourceFingerprint: prepared.sourceFingerprint, files }),
          safeSummary: verified ? "Saved PDF files verified; internal analysis does not prove Wiki delivery" : "Inspect original operation before retrying" } });
    } catch {
      call.error = true; call.readbackVerified = false;
      call.result = "PDF 回执保存未确认；请查询原任务并核对原件，不要重新提取或上传。";
    }
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId);
    if (!call?.consumed || call.result === undefined || call.identity !== this.options.identity()) return { content: [{ type: "text" as const, text: "PDF 结果未确认。" }], details: {}, isError: true };
    const safe = await secureVaultToolResult({ toolId: call.name, effectType: call.name === "pdf_reading_query" ? "read" : "user_write", egressPolicy: "echoink-configured-provider-v1", sizeLimitBytes: 16000, value: call.result, egress: new EchoInkVaultToolEgressPolicy() });
    return { content: [{ type: "text" as const, text: safe.text }], details: { source: "echoink-pdf-reading", status: call.status ?? "failed", readbackVerified: call.readbackVerified === true, truncated: safe.truncated, ...(call.operationIdentity ? { operationIdentity: call.operationIdentity } : {}), ...(call.receipt ? { consumedAttachment: call.receipt } : {}) }, isError: !!call.error };
  }
}
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function normalize(input: unknown, name: string): PdfArgs {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PDF 参数无效。");
  const args = input as PdfArgs;
  const keys = name === "pdf_reading_query" ? ["jobId", "readingOffset"] : ["path", "attachmentId", "jobId", "enhanced", "reading", "summary", "translation", "translationLanguage"];
  if (Object.keys(args).some(key => !keys.includes(key)) || args.path !== undefined && (typeof args.path !== "string" || args.path.startsWith("/") || args.path.includes("\\") || args.path.split("/").some(part => part === ".." || part === ".") || !/\.pdf$/iu.test(args.path))
    || args.attachmentId !== undefined && (typeof args.attachmentId !== "string" || !/^pdf-[a-f0-9-]{36}$/u.test(args.attachmentId))
    || args.readingOffset !== undefined && (!args.jobId || !Number.isSafeInteger(args.readingOffset) || args.readingOffset < 0)
    || args.translationLanguage !== undefined && (typeof args.translationLanguage !== "string" || args.translation !== true || !pdfLanguage(args.translationLanguage))
    || args.jobId !== undefined && (typeof args.jobId !== "string" || !/^[a-z0-9-]+$/u.test(args.jobId))
    || name === "pdf_reading_process" && (args.jobId ? !!args.path : Number(!!args.path) + Number(!!args.attachmentId) > 1)
    || [args.enhanced, args.reading, args.summary, args.translation].some(value => value !== undefined && typeof value !== "boolean")) throw new Error("PDF 参数无效。");
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
}
export function createPdfReadingTools(security: PiPdfReadingSecurity) {
  return [
    defineTool({ name: PDF_TOOL_NAMES[0], label: "查询 PDF 阅读成果", description: "只读查询本轮 PDF 附件 ID、历史任务、经过字节回读的原件及核实存在的成果表。新文件先查询并精确选择附件 ID；多个附件必须询问选择。已保存原件且job未completed时，用pdf_reading_process(jobId)继续未完成阶段，不需要临时附件；completed PDF回执不表示整个PDF任务完成。正文可用 knowledge_read 读取。jobId + readingOffset 分页读取完整内部精读；按 next offset 续读。最终再次查询验证 Wiki、双向关系和真实成果表。超时后先查任务再决定继续。", parameters: Type.Object({ jobId: Type.Optional(Type.String()), readingOffset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, PDF_TOOL_NAMES[0], args, signal); return { content: [{ type: "text", text: "pdf_result_pending" }], details: {} }; } }),
    defineTool({ name: PDF_TOOL_NAMES[1], label: "PDF 精读 · 提取", description: "PRO：用 attachmentId 处理本轮临时 PDF 或 path 处理确切库内 PDF（二选一）。用 jobId 继续任务；query已核实保存原件时只传jobId，不需要临时附件，工具复用原件继续未完阶段。只有没有可用已存原件且确需输入时，才提供重新上传的同一附件ID；不能改变原任务选项。reading与summary是独立成果选择；默认reading=true、summary=false。导航任务文件、成果和保存目录由用户冻结，漏传时沿冻结选择，显式冲突则拒绝。新任务确认后先保存原PDF，原文/译文在资料来源，精读/摘要经knowledge_maintain写入Wiki，当前聊天完成。translation=true 时以 translationLanguage 指定目标语言，未指定使用设置默认语言；原文同语言则不重复创建。只提取不调用模型；enhanced 会上传至 MinerU。结果表必须原样保留完整路径和可点击链接，只列实际成功成果。要沉淀 Wiki，随后读取真实 Raw 并沿 knowledge_maintain；无需新增可正常说明。", parameters: Type.Object({ path: Type.Optional(Type.String()), attachmentId: Type.Optional(Type.String()), jobId: Type.Optional(Type.String()), enhanced: Type.Optional(Type.Boolean()), reading: Type.Optional(Type.Boolean()), summary: Type.Optional(Type.Boolean()), translation: Type.Optional(Type.Boolean()), translationLanguage: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })) }, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, PDF_TOOL_NAMES[1], args, signal); return { content: [{ type: "text", text: "pdf_result_pending" }], details: {} }; } })
  ];
}

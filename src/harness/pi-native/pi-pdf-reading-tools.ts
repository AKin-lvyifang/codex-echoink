import type { PdfDependencies } from "../../pdf-reading/service";
import { pdfReadingPage } from "../../pdf-reading/reading-page";
import { createHash } from "node:crypto";
import { defineTool, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { confirmModal } from "../../ui/modals";
import type { PdfReadingController } from "../../pdf-reading/controller";
import type { PiWorkspaceAccess } from "./pi-workspace-access";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy, secureVaultToolResult } from "./vault-tool-result-safety";
import { pdfResultsTable } from "../../pdf-reading/results";
import type { PiChatPreparedDocument } from "./contracts";
import type { PdfAttachmentReceipt } from "../../pdf-reading/attachment-receipt";
import { pdfLanguage } from "../../pdf-reading/language";
import { extractKnowledgeLinks, resolveKnowledgeLink } from "../../knowledge-base/knowledge-relations";
import type { PdfArtifact, PdfJob } from "../../pdf-reading/types";

export const PDF_TOOL_NAMES = ["pdf_reading_query", "pdf_reading_process"] as const;
type PdfArgs = { path?: string; attachmentId?: string; jobId?: string; enhanced?: boolean; reading?: boolean; translation?: boolean; translationLanguage?: string; readingOffset?: number };
interface PdfCall { name: string; args: PdfArgs; identity: string; consumed: boolean; result?: string; error?: boolean; status?: string; readbackVerified?: boolean; receipt?: PdfAttachmentReceipt }
export class PiPdfReadingSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PDF_TOOL_NAMES[0]; readonly toolNames = PDF_TOOL_NAMES;
  private calls = new Map<string, PdfCall>();
  constructor(private readonly options: { assertToolAllowed?(name: string, args: Readonly<Record<string, unknown>>): Promise<void>; host(): PdfReadingController | null | undefined; access(): PiWorkspaceAccess | null | undefined; identity(): string; intentId(): string; generator?: PdfDependencies["generator"]; bindSources(paths: readonly string[]): void; wikiPaths(rawPath: string): Promise<readonly string[]>; documents(): readonly Readonly<PiChatPreparedDocument>[]; consume(attachmentId: string, sha256: string): Readonly<{ conversationId: string; userEntryId: string }> | null }) {}
  private attachment(id: string): Readonly<PiChatPreparedDocument> {
    const document = this.options.documents().find(d => d.transport === "tool_reference" && d.attachmentId === id);
    if (!document) throw new Error("本轮 PDF 附件不可用；请查询当前附件或重新上传同一文件以恢复。");
    return document;
  }
  private writable(): void {
    const access = this.options.access();
    if (!access || access.mode === "plan" || access.permission === "read-only") throw new Error("tool_policy_blocked");
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    try {
      if (this.calls.has(event.toolCallId) || signal?.aborted || !PDF_TOOL_NAMES.some(name => name === event.toolName)) throw new Error("authorization_failed");
      const args = normalize(event.input, event.toolName);
      await this.options.assertToolAllowed?.(event.toolName, args);
      const identity = this.options.identity();
      if (event.toolName === "pdf_reading_process") {
        this.writable(); const host = this.options.host(); if (!host) throw new Error("PDF 插件不可用。");
        if (args.attachmentId) this.attachment(args.attachmentId);
        const saved = args.jobId ? await host.api.load(args.jobId) : undefined;
        const actual = saved?.options ?? { engine: args.enhanced === undefined ? host.plugin.settings.pdfReading.engine : args.enhanced ? "mineru" : "local", reading: args.reading !== false, translation: args.translation };
        const recipient = actual.engine === "mineru" ? "PDF 将发送至 MinerU；" : "本地提取；";
        const accepted = await confirmModal(host.plugin.app, "处理 PDF", `${args.attachmentId ? this.attachment(args.attachmentId).attachment.name : args.path ?? `继续任务 ${args.jobId}`}\n${recipient}${actual.reading || actual.translation ? "提取正文将发送给当前模型。" : ""}\n原文和译文写入 Raw，精读沿当前聊天沉淀 Wiki；原有源文件保留。`, "开始处理", "取消", { signal });
        if (!accepted) throw new Error("approval_denied");
        this.writable();
      }
      this.calls.set(event.toolCallId, { name: event.toolName, args, identity, consumed: false });
    } catch { return { block: true as const, reason: "tool_policy_blocked" }; }
  }
  async execute(id: string, name: string, args: PdfArgs, signal?: AbortSignal): Promise<void> {
    const call = this.calls.get(id);
    if (!call || call.consumed || call.name !== name || call.identity !== this.options.identity() || JSON.stringify(call.args) !== JSON.stringify(normalize(args, name))) throw new Error("authorization_failed");
    await this.options.assertToolAllowed?.(name, args);
    call.consumed = true;
    try {
      const host = this.options.host(); if (!host) throw new Error("PDF 插件尚未准备好。");
      let jobs: PdfJob[];
      if (name === "pdf_reading_query") jobs = args.jobId ? [await host.api.load(args.jobId)] : (await host.api.history()).slice(0, 20);
      else {
        this.writable();
        const operation = createHash("sha256").update(`${this.options.intentId()}\n${JSON.stringify(call.args)}`).digest("hex");
        const document = args.attachmentId ? this.attachment(args.attachmentId) : undefined;
        const options = { engine: args.enhanced === undefined ? host.plugin.settings.pdfReading.engine : args.enhanced ? "mineru" as const : "local" as const, reading: args.reading !== false, translation: args.translation === true, translationLanguage: pdfLanguage(args.translationLanguage ?? host.plugin.settings.pdfReading.translationLanguage), wiki: args.reading !== false };
        const job = args.jobId ? await host.api.resume(args.jobId, signal, document ? document.bytes as Uint8Array : undefined, this.options.generator)
          : document ? await host.api.start(document.attachment.name, document.bytes as Uint8Array, options, signal, operation, this.options.generator)
          : await host.processVault(args.path!, options, signal, operation, this.options.generator);
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
        const artifacts = await host.api.actualArtifacts(job);
        if (name === "pdf_reading_process" && job.state === "completed"
          && (!artifacts.some(a => a.kind === "raw") || job.artifacts.some(expected => !artifacts.some(actual => actual.path === expected.path)))) {
          throw new Error("已声明成果未全部通过回读；附件仍保留，请先查询任务与缺失文件。");
        }
        if (job.options.reading) {
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
        results.push(`任务 ${job.id} · ${job.name} · ${job.state}\n${pdfResultsTable(artifacts)}\n${job.error ?? ""}\n${job.warnings.join("\n")}\n关系回读：${missing.length ? "尚待补充\n" + missing.join("\n") : "当前实际产物关系完整"}`);
        if (job.options.reading) {
          const done = job.chunks.filter(c => c.reading);
          results.push(`内部精读覆盖 ${done.length}/${job.chunks.length} 个片段。${artifacts.some(a => a.kind === "wiki") ? "已找到版本可靠的 Wiki。" : "尚未确认 Wiki，不能声称知识沉淀完成。"}`);
          if (!artifacts.some(a => a.kind === "wiki")) results.push(`先用 pdf_reading_query(jobId, readingOffset=0) 分页续读全部内部精读；再 knowledge_read 实际 Raw（含译文），以这些路径作为 sourcePaths，经 knowledge_maintain 写入现有分类 Wiki，摘要作为段落；无需新增时明确说明。Wiki 同时链接所用原文及译文，译文标为生成辅助材料。`);

        }
        if (missing.length) results.push("使用 note_read 获取 Raw 最新 snapshot.version，再 metadata_update(relativePath, expectedVersion, patch.set) 在属性中加入实际笔记链接（如 pdf_related），保留其他属性和正文；Wiki 关系沿 knowledge_maintain 修订。完成后再次 query 本任务核对表格与关系，不猜路径、不另建会话。");
      }
      call.readbackVerified = true;
      if (name === "pdf_reading_process" && call.status === "completed" && args.attachmentId) {
        const document = this.attachment(args.attachmentId);
        const artifacts = await host.api.actualArtifacts(jobs[0]!);
        if (!artifacts.some(a => a.kind === "raw")) throw new Error("原文回读未确认；附件仍保留。");
        const binding = this.options.consume(args.attachmentId, document.sha256);
        if (!binding) throw new Error("附件消费未确认；请查询已有任务，不要重复提取。");
        call.receipt = { ...binding, attachmentId: args.attachmentId, sha256: document.sha256 };
      }
      if (name === "pdf_reading_query") results.unshift("本轮可处理的临时 PDF 附件：\n" + (this.options.documents().filter(d => d.transport === "tool_reference").map(d => `${d.attachmentId} · ${d.attachment.name}`).join("\n") || "无。"));
      call.result = results.join("\n\n") || "尚无 PDF 成果。";
    } catch (error) { call.result = error instanceof Error ? error.message : "PDF 处理失败；请先查询任务，不要盲目重做。"; call.error = true; }
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId);
    if (!call?.consumed || call.result === undefined || call.identity !== this.options.identity()) return { content: [{ type: "text" as const, text: "PDF 结果未确认。" }], details: {}, isError: true };
    const safe = await secureVaultToolResult({ toolId: call.name, effectType: call.name === "pdf_reading_query" ? "read" : "user_write", egressPolicy: "echoink-configured-provider-v1", sizeLimitBytes: 16000, value: call.result, egress: new EchoInkVaultToolEgressPolicy() });
    return { content: [{ type: "text" as const, text: safe.text }], details: { source: "echoink-pdf-reading", status: call.status ?? "failed", readbackVerified: call.readbackVerified === true, truncated: safe.truncated, ...(call.receipt ? { consumedAttachment: call.receipt } : {}) }, isError: !!call.error };
  }
}
function normalize(input: unknown, name: string): PdfArgs {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PDF 参数无效。");
  const args = input as PdfArgs;
  const keys = name === "pdf_reading_query" ? ["jobId", "readingOffset"] : ["path", "attachmentId", "jobId", "enhanced", "reading", "translation", "translationLanguage"];
  if (Object.keys(args).some(key => !keys.includes(key)) || args.path !== undefined && (typeof args.path !== "string" || args.path.startsWith("/") || args.path.includes("\\") || args.path.split("/").some(part => part === ".." || part === ".") || !/\.pdf$/iu.test(args.path))
    || args.attachmentId !== undefined && (typeof args.attachmentId !== "string" || !/^pdf-[a-f0-9-]{36}$/u.test(args.attachmentId))
    || args.readingOffset !== undefined && (!args.jobId || !Number.isSafeInteger(args.readingOffset) || args.readingOffset < 0)
    || args.translationLanguage !== undefined && (typeof args.translationLanguage !== "string" || args.translation !== true || !pdfLanguage(args.translationLanguage))
    || args.jobId !== undefined && (typeof args.jobId !== "string" || !/^[a-z0-9-]+$/u.test(args.jobId))
    || name === "pdf_reading_process" && ((args.jobId ? !!args.path : Number(!!args.path) + Number(!!args.attachmentId) !== 1) || !!args.jobId && [args.enhanced, args.reading, args.translation, args.translationLanguage].some(value => value !== undefined))
    || [args.enhanced, args.reading, args.translation].some(value => value !== undefined && typeof value !== "boolean")) throw new Error("PDF 参数无效。");
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
}
export function createPdfReadingTools(security: PiPdfReadingSecurity) {
  return [
    defineTool({ name: PDF_TOOL_NAMES[0], label: "查询 PDF 阅读成果", description: "只读查询本轮 PDF 附件 ID、历史任务及核实存在的成果表。处理前查询并精确选择附件 ID；多个附件必须询问选择。正文可用 knowledge_read 读取。jobId + readingOffset 分页读取完整内部精读；按 next offset 续读。最终再次查询验证 Wiki、双向关系和真实成果表。超时后先查任务再决定继续。", parameters: Type.Object({ jobId: Type.Optional(Type.String()), readingOffset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, PDF_TOOL_NAMES[0], args, signal); return { content: [{ type: "text", text: "pdf_result_pending" }], details: {} }; } }),
    defineTool({ name: PDF_TOOL_NAMES[1], label: "PDF 精读 · 提取", description: "PRO：用 attachmentId 处理本轮临时 PDF 或 path 处理确切库内 PDF（二选一）。用 jobId 继续任务，缺少临时输入时可同时传重新上传的同一附件 ID，不能改变原任务选项。默认 reading=true，用户明确只要原文才设 false。原文/译文在 Raw，精读在 Wiki，当前聊天完成。translation=true 时以 translationLanguage 指定目标语言，未指定使用设置默认语言；原文同语言则不重复创建。只提取不调用模型；enhanced 会上传至 MinerU。结果表必须原样保留完整路径和可点击链接，只列实际成功成果。要沉淀 Wiki，随后读取真实 Raw 并沿 knowledge_maintain；无需新增可正常说明。", parameters: Type.Object({ path: Type.Optional(Type.String()), attachmentId: Type.Optional(Type.String()), jobId: Type.Optional(Type.String()), enhanced: Type.Optional(Type.Boolean()), reading: Type.Optional(Type.Boolean()), translation: Type.Optional(Type.Boolean()), translationLanguage: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })) }, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, PDF_TOOL_NAMES[1], args, signal); return { content: [{ type: "text", text: "pdf_result_pending" }], details: {} }; } })
  ];
}

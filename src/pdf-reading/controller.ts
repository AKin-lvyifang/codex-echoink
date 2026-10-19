import { resolveKnowledgeRoleTarget, knowledgeRoleStatus, getKnowledgeFolderBindings, resolveKnowledgePathFromRoots, normalizeKnowledgeDirectory, classifyKnowledgePath } from "../knowledge-base/root-paths";
import { TFile, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getProPluginAccess, requireProPluginAction, unavailableCapabilityAccess } from "../membership/access";
import { extractLocalPdf } from "./local-extractor";
import { extractMinerPdf } from "./mineru";
import { PdfReadingService, type PdfDependencies } from "./service";
import { PdfVaultFiles } from "./vault-files";
import type { PdfJob, PdfOptions, PdfStartContext, PdfNavigationData, PdfNavigationArtifact, PdfNavigationEntry } from "./types";

export class PdfReadingController {
  readonly api: PdfReadingService;
  constructor(readonly plugin: CodexForObsidianPlugin) {
    const stateDirectory = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/pdf-reading`;
    this.api = new PdfReadingService(new PdfVaultFiles(plugin.app, stateDirectory, Boolean(plugin.settings.knowledgeBase.folderBindings)), stateDirectory, {
      access: plugin.accountService ?? unavailableCapabilityAccess, enabled: () => plugin.settings.pdfReading.enabled,
      sourceDirectory: () => getKnowledgeFolderBindings(plugin.getVaultPath()) ? resolveKnowledgeRoleTarget(plugin.getVaultPath(), "raw") : undefined as never,
      originalDirectory: () => {
        const directory = this.defaultOriginalDirectory();
        if (!directory) throw new Error("请先在设置中选择可用的资料来源，作为原 PDF 保存位置。");
        return directory;
      },
      validateOriginalDirectory: directory => this.validateOriginalDirectory(directory),
      validateArtifactDirectory: (directory, kind) => this.validateArtifactDirectory(directory, kind),
      imageDirectory: () => getKnowledgeFolderBindings(plugin.getVaultPath())?.roles.assets.enabled ? resolveKnowledgeRoleTarget(plugin.getVaultPath(), "assets") : undefined,
      canWriteKnowledge: () => knowledgeRoleStatus(plugin.getVaultPath(), "wiki") === "ready",
      local: extractLocalPdf,
      enhanced: (job, bytes, signal, persist, progress) => extractMinerPdf(job, bytes, plugin.settings.pdfReading.mineruToken, signal, persist, progress),
      generator: () => plugin.createPdfReadingGenerator()
    });
  }
  private bindings() { return getKnowledgeFolderBindings(this.plugin.getVaultPath()) ?? this.plugin.settings.knowledgeBase.folderBindings ?? null; }
  private validateOriginalDirectory(directory: string): void {
    if (normalizeKnowledgeDirectory(directory) !== directory || !(this.plugin.app.vault.getAbstractFileByPath(directory) instanceof TFolder)) throw new Error("原 PDF 保存位置已失效，请重新选择资料来源位置。");
    const bindings = this.bindings();
    if (bindings ? !bindings.roles.raw.enabled || bindings.migrationIssues.some(issue => issue.startsWith("raw：")) || classifyKnowledgePath(bindings, directory) !== "raw"
      : directory !== resolveKnowledgePathFromRoots("raw", this.api.files.roots()) && !directory.startsWith(`${resolveKnowledgePathFromRoots("raw", this.api.files.roots())}/`)) throw new Error("原 PDF 只能保存在已绑定的资料来源范围内。");
  }
  private validateArtifactDirectory(directory: string, kind: "raw" | "assets"): void {
    if (normalizeKnowledgeDirectory(directory) !== directory) throw new Error("PDF 成果位置无效。");
    const bindings = this.bindings();
    if (!bindings) return; // Preserve the existing isolated/legacy unmapped host behavior.
    const role = classifyKnowledgePath(bindings, directory);
    if (!(this.plugin.app.vault.getAbstractFileByPath(directory) instanceof TFolder)
      || bindings.migrationIssues.some(issue => issue.startsWith(`${kind}：`))
      || (kind === "raw" ? role !== "raw" : role !== "raw" && role !== "assets")) throw new Error("PDF 成果保存位置已失效或不再属于已绑定范围，请先核对。");
  }
  originalDirectories(): string[] {
    const walk = (folder: TFolder): TFolder[] => [folder, ...folder.children.flatMap(child => child instanceof TFolder ? walk(child) : [])];
    const bindings = this.bindings();
    const roots = bindings ? bindings.roles.raw.enabled ? bindings.roles.raw.readPaths : [] : [resolveKnowledgePathFromRoots("raw", this.api.files.roots())];
    return [...new Set(roots.flatMap(path => {
      const folder = this.plugin.app.vault.getAbstractFileByPath(path); return folder instanceof TFolder ? walk(folder).map(item => item.path) : [];
    }))].filter(directory => {
      try { this.validateOriginalDirectory(directory); return true; } catch { return false; }
    }).sort((a, b) => a.localeCompare(b));
  }
  defaultOriginalDirectory(): string {
    const saved = this.plugin.settings.pdfReading.originalDirectory;
    const bindings = this.bindings();
    const candidate = saved || (bindings ? bindings.roles.raw.writePath ?? "" : resolveKnowledgePathFromRoots("raw", this.api.files.roots()));
    try { this.validateOriginalDirectory(candidate); return candidate; } catch { return ""; }
  }
  async navigationData(jobId?: string): Promise<PdfNavigationData> {
    const errors: string[] = [];
    let jobs: PdfJob[] = [];
    try {
      if (jobId) jobs = [await this.api.load(jobId)];
      else { const history = await this.api.historyWithErrors(); jobs = history.jobs; errors.push(...history.errors); }
    }
    catch { errors.push("暂时读不到 PDF 记录，请重试。"); }
    const current = this.api.current;
    if (current && (!jobId || current.id === jobId)) jobs = [structuredClone(current), ...jobs.filter(job => job.id !== current.id)].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const entries: PdfNavigationEntry[] = [];
    const reader = (this.plugin as CodexForObsidianPlugin & { readPdfKnowledgeArtifacts?(rawPath: string): Promise<PdfNavigationArtifact[]> }).readPdfKnowledgeArtifacts;
    for (const job of jobs) {
      const artifacts: PdfNavigationArtifact[] = [];
      let originalState: PdfNavigationEntry["originalState"] = "not-saved";
      if (job.original) {
        const path = job.original.savedPath ?? job.original.plannedPath;
        originalState = "pending";
        try {
          if (!await this.api.files.exists(path)) originalState = job.original.savedPath ? "missing" : "pending";
          else {
            const bytes = await this.api.readOriginal(job); bytes.fill(0);
            originalState = job.original.savedPath ? "available" : "pending";
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("已经改过")) originalState = "changed";
          else errors.push(`${job.name}：原 PDF 暂时读不到，请重试。`);
        }
        artifacts.push({ kind: "original", path, label: "原文件", ...(originalState !== "available" ? { missing: true } : {}) });
      }
      for (const artifact of job.artifacts) {
        if (artifact.kind === "reading" && !job.options.reading) continue;
        let missing = true;
        try { missing = !await this.api.files.exists(artifact.path) || !(await this.api.files.read(artifact.path)).trim(); }
        catch { errors.push(`${job.name}：部分成果暂时读不到，请重试。`); }
        artifacts.push({ ...artifact, label: { raw: "提取原文", translation: "译文", reading: "精读", wiki: "知识成果" }[artifact.kind], ...(missing ? { missing: true } : {}) });
      }
      const raw = job.artifacts.find(artifact => artifact.kind === "raw");
      if (raw && reader) {
        try {
          for (const artifact of await reader.call(this.plugin, raw.path)) {
            if (artifact.kind === "reading" && !job.options.reading || artifact.kind === "summary" && !job.options.summary) continue;
            const filePath = artifact.path.split("#")[0];
            const missing = artifact.missing || !await this.api.files.exists(filePath) || !(await this.api.files.read(filePath)).trim();
            artifacts.push({ ...artifact, ...(missing ? { missing: true } : {}) });
          }
        } catch { errors.push(`${job.name}：知识成果关联暂时读不到，请重试。`); }
      } else if (raw && (job.options.reading || job.options.summary || job.options.wiki)) errors.push(`${job.name}：知识成果关联暂时读不到，请重试。`);
      const entry: PdfNavigationEntry = { job, artifacts: [...new Map(artifacts.map(artifact => [`${artifact.kind}:${artifact.path}`, artifact])).values()], originalState };
      if (job.conversationId) {
        try {
          const task = await this.plugin.readPiConversationCatalogEntry(job.conversationId);
          if (task) Object.assign(entry, { taskId: job.conversationId, ...(task.taskStatus ? { taskStatus: task.taskStatus } : {}) });
        } catch { errors.push(`${job.name}：关联任务状态暂时读不到，请重试。`); }
      }
      entries.push(entry);
    }
    return { entries, errors };
  }
  policy() { return getProPluginAccess(this.api.deps.access, this.plugin.settings.pdfReading.enabled); }
  async setEnabled(enabled: boolean): Promise<void> {
    requireProPluginAction(this.api.deps.access, this.plugin.settings.pdfReading.enabled, "toggle");
    const previous = this.plugin.settings.pdfReading.enabled;
    this.plugin.settings.pdfReading.enabled = enabled;
    try { await this.plugin.saveSettings(true); } catch (error) { this.plugin.settings.pdfReading.enabled = previous; throw error; }
    if (!enabled) this.api.cancel();
  }
  async processVault(path: string, options: PdfOptions, signal?: AbortSignal, operationId?: string, generation?: PdfDependencies["generator"], context?: PdfStartContext): Promise<PdfJob> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") throw new Error("请选择库内确切 PDF 路径。");
    const bytes = new Uint8Array(await this.plugin.app.vault.readBinary(file));
    try { return await this.api.start(file.name, bytes, options, signal, operationId, generation, context); } finally { bytes.fill(0); }
  }
  async openNote(path: string): Promise<void> {
    const [filePath] = path.split("#");
    if (!filePath || filePath.startsWith("/") || /[\\:\p{Cc}]/u.test(filePath) || filePath.split("/").some(part => !part || part === "." || part === "..")) throw new Error("PDF 成果路径无效。");
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error("成果已移动或不存在。");
    if (path.includes("#")) await this.plugin.app.workspace.openLinkText(path, "", true);
    else await this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}

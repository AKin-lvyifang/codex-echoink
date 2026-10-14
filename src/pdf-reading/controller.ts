import { resolveKnowledgeRoleTarget, knowledgeRoleStatus, getKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getProPluginAccess, requireProPluginAction, unavailableCapabilityAccess } from "../membership/access";
import { extractLocalPdf } from "./local-extractor";
import { extractMinerPdf } from "./mineru";
import { PdfReadingService, type PdfDependencies } from "./service";
import { PdfVaultFiles } from "./vault-files";
import type { PdfJob, PdfOptions } from "./types";

export class PdfReadingController {
  readonly api: PdfReadingService;
  constructor(readonly plugin: CodexForObsidianPlugin) {
    const stateDirectory = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/pdf-reading`;
    this.api = new PdfReadingService(new PdfVaultFiles(plugin.app, stateDirectory, Boolean(plugin.settings.knowledgeBase.folderBindings)), stateDirectory, {
      access: plugin.accountService ?? unavailableCapabilityAccess, enabled: () => plugin.settings.pdfReading.enabled,
      sourceDirectory: () => getKnowledgeFolderBindings(plugin.getVaultPath()) ? resolveKnowledgeRoleTarget(plugin.getVaultPath(), "raw") : undefined as never,
      imageDirectory: () => getKnowledgeFolderBindings(plugin.getVaultPath())?.roles.assets.enabled ? resolveKnowledgeRoleTarget(plugin.getVaultPath(), "assets") : undefined,
      canWriteKnowledge: () => knowledgeRoleStatus(plugin.getVaultPath(), "wiki") === "ready",
      local: extractLocalPdf,
      enhanced: (job, bytes, signal, persist, progress) => extractMinerPdf(job, bytes, plugin.settings.pdfReading.mineruToken, signal, persist, progress),
      generator: () => plugin.createPdfReadingGenerator()
    });
  }
  policy() { return getProPluginAccess(this.api.deps.access, this.plugin.settings.pdfReading.enabled); }
  async setEnabled(enabled: boolean): Promise<void> {
    requireProPluginAction(this.api.deps.access, this.plugin.settings.pdfReading.enabled, "toggle");
    const previous = this.plugin.settings.pdfReading.enabled;
    this.plugin.settings.pdfReading.enabled = enabled;
    try { await this.plugin.saveSettings(true); } catch (error) { this.plugin.settings.pdfReading.enabled = previous; throw error; }
    if (!enabled) this.api.cancel();
  }
  async processVault(path: string, options: PdfOptions, signal?: AbortSignal, operationId?: string, generation?: PdfDependencies["generator"]): Promise<PdfJob> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") throw new Error("请选择库内确切 PDF 路径。");
    const bytes = new Uint8Array(await this.plugin.app.vault.readBinary(file));
    try { return await this.api.start(file.name, bytes, options, signal, operationId, generation); } finally { bytes.fill(0); }
  }
  async openNote(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("成果已移动或不存在。");
    await this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}

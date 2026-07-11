import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { extractClipboardImageFiles, saveClipboardImageAttachments } from "../../core/clipboard-images";
import type { StoredAttachment } from "../../settings/settings";
import type { EchoInkResource } from "../../resources/types";
import { renderComposerAttachments } from "./composer";
import { absoluteVaultPath, isImagePath } from "./workspace-utils";

export interface CodexAttachmentHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  attachmentsEl: HTMLElement;
  attachments: StoredAttachment[];
  selectedSkill: EchoInkResource | null;
  renderToolbar(): void;
  renderAttachments(): void;
  runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void>;
}

export function renderAttachmentsView(host: CodexAttachmentHost): void {
  if (!host.attachmentsEl) return;
  renderComposerAttachments(host.attachmentsEl, { selectedSkill: host.selectedSkill, attachments: host.attachments }, {
    onRemoveSkill: () => {
      host.selectedSkill = null;
      host.renderAttachments();
      host.renderToolbar();
    },
    onRemoveAttachment: (attachmentPath) => {
      host.attachments = host.attachments.filter((attachment) => attachment.path !== attachmentPath);
      host.renderAttachments();
    }
  });
}

export function attachActiveFile(host: CodexAttachmentHost): void {
  const file = host.app.workspace.getActiveFile();
  if (!file) {
    new Notice("没有当前笔记");
    return;
  }
  host.attachments.push({
    type: isImagePath(file.path) ? "image" : "file",
    name: file.name,
    path: absoluteVaultPath(host.plugin.getVaultPath(), file.path)
  });
  host.renderAttachments();
}

export function pickFiles(host: CodexAttachmentHost, imagesOnly: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (imagesOnly) input.accept = "image/*";
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) continue;
      host.attachments.push({
        type: isImagePath(filePath) ? "image" : "file",
        name: file.name,
        path: filePath
      });
    }
    host.renderAttachments();
  };
  input.click();
}

export function pickKnowledgeBaseFiles(host: CodexAttachmentHost): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    const attachments: StoredAttachment[] = [];
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) continue;
      attachments.push({
        type: "file",
        name: file.name,
        path: filePath
      });
    }
    void host.runKnowledgeBaseShortcut("文件收藏", async () => {
      const paths = await host.plugin.getKnowledgeBaseManager()?.captureExternalFiles(attachments);
      return paths?.length ? `已收藏文件：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未选择文件。";
    });
  };
  input.click();
}

export function handleDroppedFiles(host: CodexAttachmentHost, event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  for (const file of files) {
    const filePath = (file as File & { path?: string }).path;
    if (!filePath) continue;
    host.attachments.push({
      type: isImagePath(filePath) ? "image" : "file",
      name: file.name,
      path: filePath
    });
  }
  host.renderAttachments();
}

export async function handlePastedFiles(host: CodexAttachmentHost, event: ClipboardEvent): Promise<void> {
  const files = extractClipboardImageFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  try {
    const pasted = await saveClipboardImageAttachments(files, { vaultPath: host.plugin.getVaultPath(), pluginDir: host.plugin.getPluginDataDirName() });
    host.attachments.push(...pasted);
    host.renderAttachments();
  } catch (error) {
    console.error("Codex paste image failed", error);
    new Notice("粘贴图片失败");
  }
}

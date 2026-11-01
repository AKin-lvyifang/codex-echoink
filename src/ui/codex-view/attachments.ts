import { getElectronFilePath } from "../../core/electron";
import { composerSelectionAnnotations, removeSelectionAnnotation, editAnnotationQuestion } from "../../selection-ask/draft";
import { renderSelectionAnnotationSummary } from "./selection-annotations";
import { Notice, TFile, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { extractClipboardImageFiles, saveClipboardImageAttachments } from "../../core/clipboard-images";
import { openPathInElectron } from "../../core/electron";
import { normalizeProcessFileRef } from "../../core/mapping";
import type { StoredAttachment } from "../../settings/settings";
import type { EchoInkResource } from "../../resources/types";
import { renderComposerAttachments } from "./composer";
import { createAttachmentResourceResolver } from "./attachment-resource";
import { absoluteVaultPath, isImagePath } from "./workspace-utils";
import {
  addComposerNoteMentionSelection,
  composerNoteMentionSelections,
  removeComposerNoteMentionSelection
} from "./note-mentions";
import {
  PI_DOCUMENT_ACCEPT,
  piDocumentKindForAttachment
} from "./pi-document-input";
import { conversationUiText } from "./ui-i18n";

export interface CodexAttachmentHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  attachmentsEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  attachments: StoredAttachment[];
  drawingRequested?: boolean;
  selectedSkill: EchoInkResource | null;
  renderToolbar(): void;
  onInputChanged?(): void;
  renderAttachments(): void;
}

export function renderAttachmentsView(host: CodexAttachmentHost): void {
  if (!host.attachmentsEl) return;
  renderComposerAttachments(host.attachmentsEl, {
    language: host.plugin.settings.settingsLanguage,
    selectedSkill: host.selectedSkill, drawingRequested: host.drawingRequested,
    noteMentions: composerNoteMentionSelections(host.inputEl),
    attachments: host.attachments,
    attachmentResolver: createAttachmentResourceResolver(
      host.app,
      host.plugin.getVaultPath(),
      host.plugin.settings.settingsLanguage
    )
  }, {
    onRemoveDrawing: () => { host.drawingRequested = false; host.onInputChanged?.(); host.renderAttachments(); host.renderToolbar(); },
    onRemoveSkill: () => {
      host.selectedSkill = null;
      host.renderAttachments();
      host.renderToolbar();
    },
    onRemoveNoteMention: (vaultRelativePath) => {
      removeComposerNoteMentionSelection(host.inputEl, vaultRelativePath);
      host.renderAttachments();
      host.renderToolbar();
    },
    onRemoveAttachment: (attachmentPath) => {
      host.attachments = host.attachments.filter((attachment) => attachment.path !== attachmentPath);
      host.renderAttachments();
    },
    onOpenAttachment: (attachment) => {
      void openComposerAttachment(host, attachment);
    }
  });
  const annotations = composerSelectionAnnotations(host.inputEl);
  if (annotations.length) {
    host.attachmentsEl.removeClass("is-empty");
    const summary = host.attachmentsEl.createDiv({ cls: "echoink-composer-annotation-slot" });
    const changed = () => { host.onInputChanged?.(); host.renderAttachments(); host.renderToolbar(); host.plugin.selectionAskController?.refresh(); };
    const remove = (id: string) => {
      removeSelectionAnnotation(host.inputEl, id);
    };
    renderSelectionAnnotationSummary(summary, annotations, host.plugin.settings.settingsLanguage, {
      onSource: (annotation) => { void host.plugin.selectionAskController?.openSource(annotation); },
      onEdit: (id) => { editAnnotationQuestion(host.inputEl, id, host.plugin.settings.settingsLanguage === "en"); host.onInputChanged?.(); host.renderToolbar(); },
      onRemove: (id) => { remove(id); changed(); },
      onRemoveAll: () => { annotations.forEach((annotation) => remove(annotation.id)); changed(); }
    }, host.app);
  }
  host.plugin.selectionAskController?.refresh();
}

export async function openComposerAttachment(
  host: CodexAttachmentHost,
  attachment: Readonly<StoredAttachment>
): Promise<void> {
  const ref = normalizeProcessFileRef(attachment.path, host.plugin.getVaultPath());
  if (!ref.openable) {
    new Notice(conversationUiText(host.plugin.settings.settingsLanguage, "这个文件路径无法打开", "This file path cannot be opened"));
    return;
  }
  const absolutePath = ref.absolutePath
    ?? (ref.kind === "vault"
      ? absoluteVaultPath(host.plugin.getVaultPath(), ref.path)
      : ref.kind === "external" ? ref.path : "");
  if (await openPathInElectron(absolutePath)) return;
  new Notice(conversationUiText(
    host.plugin.settings.settingsLanguage,
    `无法使用系统默认应用打开：${ref.displayPath}`,
    `Could not open with the system default app: ${ref.displayPath}`
  ));
}

export function attachActiveFile(host: CodexAttachmentHost): void {
  const file = currentDisplayedMarkdownFile(host.app);
  if (!file) {
    new Notice(conversationUiText(host.plugin.settings.settingsLanguage, "没有当前笔记", "There is no current note"));
    return;
  }
  addComposerNoteMentionSelection(host.inputEl, {
    vaultRelativePath: file.path,
    fileName: file.name
  });
  host.renderAttachments();
  host.renderToolbar();
}

export function currentDisplayedMarkdownFile(app: App): TFile | null {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile || !/\.md$/iu.test(activeFile.path)) return null;
  const displayed = app.workspace.getLeavesOfType("markdown").some((leaf) => {
    const view = leaf.view as typeof leaf.view & Readonly<{
      file?: TFile | null;
      containerEl?: HTMLElement;
    }>;
    if (view.file?.path !== activeFile.path) return false;
    const container = view.containerEl as (HTMLElement & { isShown?: () => boolean }) | undefined;
    return container?.isShown ? container.isShown() : Boolean(container?.isConnected);
  });
  return displayed ? activeFile : null;
}

export function pickFiles(host: CodexAttachmentHost, imagesOnly: boolean): void {
  const input = window.createEl("input");
  input.type = "file";
  input.multiple = true;
  input.accept = imagesOnly
    ? "image/*"
    : `image/*,${PI_DOCUMENT_ACCEPT}`;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      appendPiChatFile(host, file);
    }
    host.renderAttachments();
  };
  input.click();
}

export function handleDroppedFiles(host: CodexAttachmentHost, event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  for (const file of files) {
    appendPiChatFile(host, file);
  }
  host.renderAttachments();
}

function appendPiChatFile(host: CodexAttachmentHost, file: File): void {
  let filePath = (file as File & { path?: string }).path;
  // New Electron versions removed File.path; the host-owned picker still
  // supplies a local path through its public webUtils API.
  if (!filePath) {
    filePath = getElectronFilePath(file);
  }
  if (!filePath) {
    const name = file.name || conversationUiText(host.plugin.settings.settingsLanguage, "未命名文件", "Unnamed file");
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      `无法读取附件“${name}”的本地路径。`,
      `Could not read the local path for attachment “${name}”.`
    ));
    return;
  }
  const type = classifyLocalAttachmentType(filePath, file.type);
  const attachment: StoredAttachment = {
    type,
    name: file.name,
    path: filePath,
    ...(file.type ? { mimeType: file.type } : {}),
    sizeBytes: file.size,
    availability: "available"
  };
  if (type === "file" && !piDocumentKindForAttachment(attachment)) {
    new Notice(
      conversationUiText(
        host.plugin.settings.settingsLanguage,
        `不支持附件“${file.name}”。普通 Pi Chat 仅支持 PDF、Word、Markdown、HTML 和图片。`,
        `Attachment “${file.name}” is not supported. Regular Pi Chat supports only PDF, Word, Markdown, HTML, and images.`
      )
    );
    return;
  }
  host.attachments.push(attachment);
}

export function classifyLocalAttachmentType(
  filePath: string,
  mimeType?: string
): StoredAttachment["type"] {
  const normalizedMimeType = mimeType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const imageMimeType = Boolean(
    normalizedMimeType
    && normalizedMimeType.startsWith("image/")
    && normalizedMimeType.length > "image/".length
  );
  return imageMimeType || isImagePath(filePath) || /\.heif$/iu.test(filePath)
    ? "image"
    : "file";
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
    new Notice(conversationUiText(host.plugin.settings.settingsLanguage, "粘贴图片失败", "Could not paste image"));
  }
}

import { getDesktopFs } from "../../platform/desktop-filesystem";
import { getDesktopUrl } from "../../platform/desktop-paths";

import {
  normalizePath,
  Platform,
  TFile,
  type App
} from "obsidian";
import type { SettingsLanguage, StoredAttachment } from "../../settings/settings";
import { conversationUiText } from "./ui-i18n";

const { existsSync } = getDesktopFs();
const { fileURLToPath } = getDesktopUrl();

export type EchoInkAttachmentAvailability = "available" | "unavailable";

export type EchoInkAttachmentPresentationKind =
  | "image"
  | "video"
  | "pdf"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "archive"
  | "text"
  | "code"
  | "unknown";

export interface EchoInkAttachmentResourceView {
  readonly attachment: Readonly<StoredAttachment>;
  readonly displayName: string;
  readonly availability: EchoInkAttachmentAvailability;
  readonly resourceUri?: string;
  readonly vaultRelativePath?: string;
}

export interface EchoInkAttachmentResourceResolver {
  resolve(
    attachment: Readonly<StoredAttachment>,
    displayIndex?: number
  ): Readonly<EchoInkAttachmentResourceView>;
}

const VIDEO_EXTENSIONS = new Set([
  "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"
]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "ods", "tsv", "xls", "xlsb", "xlsm", "xlsx"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docm", "docx", "odt", "rtf"]);
const PRESENTATION_EXTENSIONS = new Set(["odp", "pot", "potx", "pps", "ppsx", "ppt", "pptx"]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip"]);
const CODE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cpp", "css", "go", "h", "html", "java", "js", "json", "jsx",
  "kt", "lua", "mjs", "php", "py", "rb", "rs", "sh", "sql", "svg", "swift", "toml",
  "ts", "tsx", "vue", "xml", "yaml", "yml", "zsh"
]);
const TEXT_EXTENSIONS = new Set(["log", "md", "markdown", "rst", "text", "txt"]);

const ATTACHMENT_PRESENTATION_ICONS: Readonly<Record<EchoInkAttachmentPresentationKind, string>> = Object.freeze({
  image: "image",
  video: "film",
  pdf: "file-text",
  spreadsheet: "table-2",
  document: "file-pen-line",
  presentation: "presentation",
  archive: "archive",
  text: "align-left",
  code: "code",
  unknown: "file"
});

export function attachmentPresentationKind(
  attachment: Readonly<StoredAttachment>
): EchoInkAttachmentPresentationKind {
  if (attachment.type === "image") return "image";
  const mimeType = normalizedMimeType(attachment.mimeType);
  const extension = fileExtension(attachment.name) || fileExtension(attachment.path);
  if (mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) return "video";
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (isSpreadsheetMimeType(mimeType) || SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  if (isPresentationMimeType(mimeType) || PRESENTATION_EXTENSIONS.has(extension)) return "presentation";
  if (isArchiveMimeType(mimeType) || ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (isDocumentMimeType(mimeType) || DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (isCodeMimeType(mimeType) || CODE_EXTENSIONS.has(extension)) return "code";
  if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) return "text";
  return "unknown";
}

export function attachmentPresentationIcon(
  attachment: Readonly<StoredAttachment>
): string {
  return ATTACHMENT_PRESENTATION_ICONS[attachmentPresentationKind(attachment)];
}

/** Returns a stable local-path identity for merging transient and durable projections. */
export function attachmentPathIdentity(
  attachment: Readonly<StoredAttachment>
): string | null {
  const source = attachment.path.trim();
  if (!source) return null;
  if (/^(?:blob:|data:|https?:)/iu.test(source)) return source;
  if (/^file:/iu.test(source)) {
    const localPath = localPathFromFileUri(source);
    return localPath ? normalizeAbsolutePath(localPath) : source;
  }
  return normalizeAbsolutePath(source);
}

/** Shared resource resolver used by Composer and durable message attachments. */
export function createAttachmentResourceResolver(
  app: App,
  vaultPath: string,
  language: SettingsLanguage = "zh-CN"
): EchoInkAttachmentResourceResolver {
  const normalizedVaultPath = normalizeAbsolutePath(vaultPath);
  return Object.freeze({
    resolve: (
      attachment: Readonly<StoredAttachment>,
      displayIndex = 0
    ) => resolveAttachmentResource(
      app,
      normalizedVaultPath,
      attachment,
      displayIndex,
      language
    )
  });
}

export function attachmentDisplayName(
  attachment: Readonly<StoredAttachment>,
  displayIndex = 0,
  language: SettingsLanguage = "zh-CN"
): string {
  const supplied = attachment.name.trim();
  const fallback = fileNameFromPath(attachment.path)
    || conversationUiText(language, "附件", "Attachment");
  const name = supplied || fallback;
  if (!/^clipboard-[0-9]+-[0-9]+(?:\.[A-Za-z0-9]+)?$/u.test(name)) {
    return name;
  }
  const extension = fileExtension(name);
  const ordinal = Math.max(0, Math.trunc(displayIndex)) + 1;
  return conversationUiText(
    language,
    `粘贴图片 ${ordinal}${extension ? `.${extension}` : ""}`,
    `Pasted image ${ordinal}${extension ? `.${extension}` : ""}`
  );
}

function resolveAttachmentResource(
  app: App,
  vaultPath: string,
  attachment: Readonly<StoredAttachment>,
  displayIndex: number,
  language: SettingsLanguage
): Readonly<EchoInkAttachmentResourceView> {
  const displayName = attachmentDisplayName(attachment, displayIndex, language);
  const base = {
    attachment: Object.freeze({ ...attachment }),
    displayName
  };
  const source = attachment.path.trim();
  if (!source || /^data:/iu.test(source)) {
    return Object.freeze({ ...base, availability: "unavailable" as const });
  }
  if (/^(?:blob:|https?:)/iu.test(source)) {
    return Object.freeze({
      ...base,
      availability: "available" as const,
      resourceUri: source
    });
  }

  const vaultRelativePath = toVaultRelativePath(source, vaultPath);
  if (vaultRelativePath) {
    const file = app.vault.getAbstractFileByPath(vaultRelativePath);
    if (file instanceof TFile) {
      return Object.freeze({
        ...base,
        availability: "available" as const,
        resourceUri: app.vault.getResourcePath(file),
        vaultRelativePath
      });
    }
    const localPath = localPathForVaultResource(
      source,
      vaultPath,
      vaultRelativePath
    );
    if (Platform.isDesktopApp && localPath && existsSync(localPath)) {
      const adapterResourceUri = app.vault.adapter.getResourcePath(
        normalizePath(vaultRelativePath)
      );
      return Object.freeze({
        ...base,
        availability: "available" as const,
        resourceUri: adapterResourceUri || localFileUri(localPath),
        vaultRelativePath
      });
    }
    return Object.freeze({
      ...base,
      availability: "unavailable" as const,
      vaultRelativePath
    });
  }

  if (/^file:/iu.test(source)) {
    const localPath = localPathFromFileUri(source);
    const available = Boolean(
      Platform.isDesktopApp
      && localPath
      && existsSync(localPath)
    );
    return Object.freeze({
      ...base,
      availability: available ? "available" as const : "unavailable" as const,
      ...(available ? { resourceUri: source } : {})
    });
  }
  if (isAbsolutePath(source) && Platform.isDesktopApp) {
    if (!existsSync(source)) {
      return Object.freeze({ ...base, availability: "unavailable" as const });
    }
    return Object.freeze({
      ...base,
      availability: "available" as const,
      resourceUri: localFileUri(source)
    });
  }
  return Object.freeze({ ...base, availability: "unavailable" as const });
}

function toVaultRelativePath(source: string, vaultPath: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)) return null;
  const normalizedSource = normalizeAbsolutePath(source);
  if (!isAbsolutePath(normalizedSource)) {
    const relative = normalizePath(normalizedSource.replace(/^\/+/, ""));
    return relative || null;
  }
  if (!vaultPath) return null;
  if (normalizedSource === vaultPath) return null;
  const prefix = `${vaultPath}/`;
  if (!normalizedSource.startsWith(prefix)) return null;
  const relative = normalizePath(normalizedSource.slice(prefix.length));
  return relative || null;
}

function localPathForVaultResource(
  source: string,
  vaultPath: string,
  vaultRelativePath: string
): string | null {
  if (isAbsolutePath(source)) return source;
  if (!vaultPath) return null;
  return `${vaultPath}/${vaultRelativePath}`;
}

function normalizedMimeType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSpreadsheetMimeType(mimeType: string): boolean {
  return mimeType === "text/csv"
    || mimeType === "text/tab-separated-values"
    || /(?:spreadsheet|excel)/u.test(mimeType);
}

function isDocumentMimeType(mimeType: string): boolean {
  return /(?:msword|wordprocessing|opendocument\.text|rtf)/u.test(mimeType);
}

function isPresentationMimeType(mimeType: string): boolean {
  return /(?:presentation|powerpoint)/u.test(mimeType);
}

function isArchiveMimeType(mimeType: string): boolean {
  return /(?:7z|bzip2|compressed|gzip|rar|tar|zip)/u.test(mimeType);
}

function isCodeMimeType(mimeType: string): boolean {
  return mimeType === "application/json"
    || mimeType === "application/sql"
    || mimeType === "application/xml"
    || mimeType === "application/yaml"
    || mimeType === "application/x-yaml"
    || /(?:ecmascript|javascript|typescript)/u.test(mimeType);
}

function normalizeAbsolutePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function localFileUri(filePath: string): string {
  const encoded = encodeURI(filePath).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
  return `file://${encoded}`;
}

function localPathFromFileUri(source: string): string | null {
  try {
    return fileURLToPath(source);
  } catch {
    return null;
  }
}

function fileNameFromPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).trim();
}

function fileExtension(value: string): string {
  const dot = value.lastIndexOf(".");
  return dot > 0 ? value.slice(dot + 1).toLowerCase() : "";
}

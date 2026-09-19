import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { extractPdfText } from "./pdf-text-extractor";
import type { PiChatPreparedDocument } from "../../harness/pi-native/contracts";
import {
  buildPiDocumentProviderContext,
  resolvePiDocumentTransport,
  type PiDocumentCapabilityTarget
} from "../../harness/pi-native/pi-document-context";
import { estimatePiContextTokens } from "../../harness/pi-native/pi-context-budget";
import type { StoredAttachment } from "../../settings/settings";

export const PI_DOCUMENT_ACCEPT = [
  ".pdf",
  ".doc",
  ".docx",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/html"
].join(",");

export const PI_DOCUMENT_MAX_COUNT = 8;
export const PI_DOCUMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const PI_DOCUMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export type PiDocumentKind = "pdf" | "word" | "markdown" | "html";

export interface PiChatPreparedDocumentSet {
  readonly documents: readonly Readonly<PiChatPreparedDocument>[];
  /** Hidden Pi context content. It contains no local paths or binary data. */
  readonly contextText: string;
  readonly estimatedInputTokens: number;
  readonly totalBytes: number;
}

export type PiDocumentInputErrorCode =
  | "unsupported_format"
  | "too_many_documents"
  | "file_too_large"
  | "total_too_large"
  | "unreadable"
  | "encrypted"
  | "invalid_utf8"
  | "damaged"
  | "textless"
  | "input_budget_exceeded";

export class PiDocumentInputError extends Error {
  constructor(
    readonly code: PiDocumentInputErrorCode,
    readonly fileName: string | null,
    message: string
  ) {
    super(message);
    this.name = "PiDocumentInputError";
  }
}

export function piDocumentKindForAttachment(
  attachment: Pick<StoredAttachment, "name" | "path" | "mimeType">
): PiDocumentKind | null {
  const extension = fileExtension(attachment.name) || fileExtension(attachment.path);
  if (extension === "pdf") return "pdf";
  if (extension === "doc" || extension === "docx") return "word";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  return null;
}

export function isPiDocumentAttachment(
  attachment: Pick<StoredAttachment, "type" | "name" | "path" | "mimeType">
): boolean {
  return attachment.type === "file" && piDocumentKindForAttachment(attachment) !== null;
}

export async function preparePiChatDocuments(
  attachments: readonly Readonly<StoredAttachment>[],
  options: Readonly<{
    /** Current model input capacity remaining before adding these documents. */
    availableInputTokens: number;
    /** Exact Provider/API/base URL/model/adapter identity frozen for this turn. */
    capabilityTarget: Readonly<PiDocumentCapabilityTarget>;
  }>
): Promise<Readonly<PiChatPreparedDocumentSet>> {
  const fileAttachments = attachments.filter((attachment) => attachment.type === "file");
  for (const attachment of fileAttachments) {
    if (!piDocumentKindForAttachment(attachment)) {
      throw new PiDocumentInputError(
        "unsupported_format",
        displayName(attachment),
        `不支持文档“${displayName(attachment)}”的格式。请选择 PDF、Word、Markdown 或 HTML 文件。`
      );
    }
  }
  if (fileAttachments.length > PI_DOCUMENT_MAX_COUNT) {
    throw new PiDocumentInputError(
      "too_many_documents",
      null,
      `单轮最多添加 ${PI_DOCUMENT_MAX_COUNT} 个文档；请移除部分文件后重试。`
    );
  }
  if (!fileAttachments.length) {
    return Object.freeze({
      documents: Object.freeze([]),
      contextText: "",
      estimatedInputTokens: 0,
      totalBytes: 0
    });
  }
  if (!Number.isSafeInteger(options.availableInputTokens) || options.availableInputTokens < 1) {
    throw new PiDocumentInputError(
      "input_budget_exceeded",
      null,
      "当前模型已没有可用输入容量；请新开会话、减少上下文或切换容量更大的模型。"
    );
  }

  const documents: PiChatPreparedDocument[] = [];
  let totalBytes = 0;
  for (const attachment of fileAttachments) {
    const prepared = await prepareOneDocument(
      attachment,
      options.capabilityTarget
    );
    totalBytes += prepared.attachment.sizeBytes;
    if (totalBytes > PI_DOCUMENT_MAX_TOTAL_BYTES) {
      throw new PiDocumentInputError(
        "total_too_large",
        prepared.attachment.name,
        `加入“${prepared.attachment.name}”后文档总大小超过 50 MiB；请减少文件后重试。`
      );
    }
    documents.push(prepared);
  }

  const contextText = buildPiDocumentContext(documents);
  const estimatedInputTokens = estimatePiContextTokens(contextText).tokens;
  if (estimatedInputTokens > options.availableInputTokens) {
    throw new PiDocumentInputError(
      "input_budget_exceeded",
      null,
      `文档内容预计需要 ${estimatedInputTokens} tokens，超过当前模型剩余的 ${options.availableInputTokens} tokens；请减少文档、缩短内容、新开会话或切换容量更大的模型。`
    );
  }

  return Object.freeze({
    documents: Object.freeze(documents.map((document) => Object.freeze({
      ...document,
      attachment: Object.freeze({ ...document.attachment })
    }))),
    contextText,
    estimatedInputTokens,
    totalBytes
  });
}

export function buildPiDocumentContext(
  documents: readonly Readonly<PiChatPreparedDocument>[]
): string {
  return buildPiDocumentProviderContext(documents);
}

export function reconcilePiDocumentTransports(
  documents: readonly Readonly<PiChatPreparedDocument>[],
  capabilityTarget: Readonly<PiDocumentCapabilityTarget>
): readonly Readonly<PiChatPreparedDocument>[] {
  return Object.freeze(documents.map((document) => {
    if (
      document.transport === "extracted_text"
      || resolvePiDocumentTransport(
        capabilityTarget,
        document.attachment.mimeType
      ) === "native"
    ) {
      return Object.freeze({
        ...document,
        bytes: new Uint8Array(document.bytes),
        attachment: Object.freeze({ ...document.attachment })
      });
    }
    const text = document.text?.trim() ?? "";
    if (!text) {
      throw new PiDocumentInputError(
        "textless",
        document.attachment.name,
        `入队后“${document.attachment.name}”已无法使用原生 PDF 输入，且冻结快照没有可提取文字；请恢复原 Provider 配置或重新发送。`
      );
    }
    return Object.freeze({
      ...document,
      bytes: new Uint8Array(document.bytes),
      transport: "extracted_text" as const,
      text,
      attachment: Object.freeze({ ...document.attachment })
    });
  }));
}

async function prepareOneDocument(
  attachment: Readonly<StoredAttachment>,
  capabilityTarget: Readonly<PiDocumentCapabilityTarget>
): Promise<PiChatPreparedDocument> {
  const name = displayName(attachment);
  const kind = piDocumentKindForAttachment(attachment);
  if (!kind) {
    throw new PiDocumentInputError(
      "unsupported_format",
      name,
      `不支持文档“${name}”的格式。请选择 PDF、Word、Markdown 或 HTML 文件。`
    );
  }
  const replay = attachment.documentReplay;
  if (replay) {
    const mimeType = canonicalDocumentMimeType(kind, attachment);
    const text = typeof replay.text === "string"
      ? replay.text.split("\u0000").join("").trim()
      : null;
    if (
      replay.name !== name
      || replay.kind !== kind
      || replay.mimeType !== mimeType
      || !Number.isSafeInteger(replay.sizeBytes)
      || replay.sizeBytes < 1
      || !/^[a-f0-9]{64}$/u.test(replay.sha256)
      || (text === null && (kind !== "pdf" || mimeType !== "application/pdf"))
    ) {
      throw new PiDocumentInputError(
        "damaged",
        name,
        `文档“${name}”的冻结提取文本已不可用；请重新添加原文件后发送。`
      );
    }
    if (text === null) {
      throw new PiDocumentInputError(
        "textless",
        name,
        `文档“${name}”的持久化重放没有原始冻结字节，也没有冻结提取文本；为避免读取后来变化的源文件，请重新添加当前文件后发送。`
      );
    }
    if (!text) {
      throw new PiDocumentInputError(
        "damaged",
        name,
        `文档“${name}”的冻结提取文本已不可用；请重新添加原文件后发送。`
      );
    }
    return {
      attachment: Object.freeze({
        type: "file",
        name,
        path: attachment.path,
        mimeType,
        sizeBytes: replay.sizeBytes,
        availability: attachment.availability === "unavailable"
          ? "unavailable"
          : "available"
      }),
      kind,
      bytes: new Uint8Array(),
      sha256: replay.sha256,
      transport: "extracted_text",
      text
    };
  }
  const localPath = localPathFromAttachment(attachment.path);
  let sizeBytes: number;
  let bytes: Buffer;
  try {
    const info = await stat(localPath);
    if (!info.isFile()) throw new Error("not_a_file");
    sizeBytes = info.size;
    if (sizeBytes > PI_DOCUMENT_MAX_FILE_BYTES) {
      throw new PiDocumentInputError(
        "file_too_large",
        name,
        `文档“${name}”大小超过 20 MiB；请压缩或拆分后重试。`
      );
    }
    bytes = await readFile(localPath);
    sizeBytes = bytes.byteLength;
    if (sizeBytes < 1 || sizeBytes > PI_DOCUMENT_MAX_FILE_BYTES) {
      throw new PiDocumentInputError(
        "file_too_large",
        name,
        `文档“${name}”大小超过 20 MiB；请压缩或拆分后重试。`
      );
    }
  } catch (error) {
    if (error instanceof PiDocumentInputError) throw error;
    throw new PiDocumentInputError(
      "unreadable",
      name,
      `无法读取文档“${name}”；请确认文件仍在本机、没有被移动，并且 EchoInk 有读取权限。`
    );
  }

  const mimeType = canonicalDocumentMimeType(kind, attachment);
  const transport = resolvePiDocumentTransport(capabilityTarget, mimeType);
  let extracted: string;
  try {
    extracted = await extractDocumentText(bytes, kind, name);
  } catch (error) {
    if (error instanceof PiDocumentInputError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/password|encrypted|encryption/iu.test(detail)) {
      throw new PiDocumentInputError(
        "encrypted",
        name,
        `文档“${name}”已加密或受密码保护；请先在本机解除保护后重试。`
      );
    }
    throw new PiDocumentInputError(
      "damaged",
      name,
      `无法解析文档“${name}”；文件可能已损坏或格式与扩展名不一致，请用原应用重新保存后重试。`
    );
  }
  const text = normalizeExtractedText(extracted);
  if (!text && transport === "extracted_text") {
    throw new PiDocumentInputError(
      "textless",
      name,
      `文档“${name}”没有可提取文字；扫描版 PDF 暂不支持 OCR，请改用包含可选择文字的文件。`
    );
  }

  return {
    kind,
    bytes: new Uint8Array(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    transport,
    ...(text ? { text } : {}),
    attachment: {
      type: "file",
      name,
      path: attachment.path,
      mimeType,
      sizeBytes,
      availability: "available"
    }
  };
}

async function extractDocumentText(
  bytes: Buffer,
  kind: PiDocumentKind,
  fileName: string
): Promise<string> {
  if (kind === "markdown") return decodeUtf8Strict(bytes, fileName);
  if (kind === "html") return extractLocalHtmlText(decodeUtf8Strict(bytes, fileName));
  if (kind === "pdf") {
    return extractPdfText(bytes);
  }
  const extractor = await createWordExtractor();
  const document = await extractor.extract(bytes);
  return String(document.getBody());
}

async function createWordExtractor(): Promise<Readonly<{
  extract(source: Buffer): Promise<Readonly<{ getBody(): string }>>;
}>> {
  if (typeof require === "undefined") {
    (globalThis as typeof globalThis & { require?: NodeJS.Require }).require =
      createRequire(`${process.cwd()}/package.json`);
  }
  const imported: unknown = await import("word-extractor");
  const Constructor = (imported as Readonly<{ default: new () => {
    extract(source: Buffer): Promise<Readonly<{ getBody(): string }>>;
  } }>).default;
  return new Constructor();
}

function decodeUtf8Strict(bytes: Buffer, fileName: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PiDocumentInputError(
      "invalid_utf8",
      fileName,
      `文档“${fileName}”不是有效的 UTF-8；请用 UTF-8 编码重新保存后重试。`
    );
  }
}

export function extractLocalHtmlText(html: string): string {
  let safe = html.replace(/<!--[\s\S]*?-->/gu, " ");
  for (const tag of ["script", "style", "noscript", "svg", "iframe"]) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "giu");
    let previous = "";
    while (previous !== safe) {
      previous = safe;
      safe = safe.replace(pattern, " ");
    }
    safe = safe.replace(new RegExp(`<${tag}\\b[^>]*\\/?\\s*>`, "giu"), " ");
  }
  safe = safe
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<\/(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return decodeHtmlEntities(safe);
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = Object.freeze({
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: "\""
  });
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu, (
    entity: string,
    decimal: string | undefined,
    hexadecimal: string | undefined,
    name: string | undefined
  ) => {
    const codePoint = decimal
      ? Number.parseInt(decimal, 10)
      : hexadecimal
        ? Number.parseInt(hexadecimal, 16)
        : null;
    if (codePoint !== null) {
      try {
        return codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      } catch {
        return entity;
      }
    }
    return named[name?.toLowerCase() ?? ""] ?? entity;
  });
}

function normalizeExtractedText(value: string): string {
  return value
    .split("\u0000").join("")
    .replace(/[\t\f\v ]+\n/gu, "\n")
    .replace(/\n[\t\f\v ]+/gu, "\n")
    .replace(/[\t\f\v ]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function localPathFromAttachment(value: string): string {
  const source = value.trim();
  if (/^file:/iu.test(source)) {
    try {
      return fileURLToPath(source);
    } catch {
      return source;
    }
  }
  return source;
}

function canonicalDocumentMimeType(
  kind: PiDocumentKind,
  attachment: Pick<StoredAttachment, "name" | "path" | "mimeType">
): string {
  const extension = fileExtension(attachment.name) || fileExtension(attachment.path);
  if (kind === "pdf") return "application/pdf";
  if (kind === "markdown") return "text/markdown";
  if (kind === "html") return "text/html";
  return extension === "doc"
    ? "application/msword"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function displayName(attachment: Pick<StoredAttachment, "name" | "path">): string {
  const supplied = attachment.name.trim();
  if (supplied) return supplied;
  const normalized = attachment.path.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).trim() || "未命名文档";
}

function fileExtension(value: string): string {
  const normalized = value.split(/[?#]/u, 1)[0] ?? "";
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const dot = normalized.lastIndexOf(".");
  return dot > slash ? normalized.slice(dot + 1).toLowerCase() : "";
}

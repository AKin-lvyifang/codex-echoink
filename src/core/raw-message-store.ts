import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";

import type { ChatMessage } from "../settings/settings";
import { CURRENT_PLUGIN_ID, pluginDataDir } from "../plugin/plugin-data-paths";

const { mkdir, readFile, writeFile } = getDesktopFsPromises();
const path = getDesktopPath();

export { CURRENT_PLUGIN_ID, pluginDataDir } from "../plugin/plugin-data-paths";
export const RAW_TEXT_THRESHOLD = 30_000;
export const LARGE_MESSAGE_THRESHOLD = 80_000;
export const RAW_PREVIEW_HEAD = 12_000;
export const RAW_PREVIEW_TAIL = 4_000;

interface RawWrite {
  rawRef: string;
  text: string;
}

export function rawStorageDir(vaultPath: string, pluginDir = CURRENT_PLUGIN_ID): string {
  return path.join(pluginDataDir(vaultPath, pluginDir), "raw");
}

export function rawRefForMessage(messageId: string): string {
  return `raw/${sanitizeRawFileName(messageId || `msg-${Date.now()}`)}.txt`;
}

export function resolveRawRef(vaultPath: string, rawRef: string, pluginDir = CURRENT_PLUGIN_ID): string {
  const normalized = rawRef.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith("raw/") || normalized.includes("..")) {
    throw new Error("非法原文引用");
  }
  return path.join(pluginDataDir(vaultPath, pluginDir), normalized);
}

export async function writeRawText(vaultPath: string, rawRef: string, text: string, pluginDir = CURRENT_PLUGIN_ID): Promise<void> {
  const target = resolveRawRef(vaultPath, rawRef, pluginDir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

export async function readRawText(vaultPath: string, rawRef: string, pluginDir = CURRENT_PLUGIN_ID): Promise<string> {
  return readFile(resolveRawRef(vaultPath, rawRef, pluginDir), "utf8");
}

export function prepareRawMessage(message: ChatMessage, fullText: string, threshold = thresholdForMessage(message)): RawWrite | null {
  const shouldExternalize = message.rawRef ? fullText.length > threshold || Boolean(message.rawTruncatedForPreview) : shouldExternalizeMessage(message, fullText, threshold);
  if (!shouldExternalize) {
    message.text = fullText;
    delete message.previewText;
    delete message.rawRef;
    delete message.rawSize;
    delete message.rawLines;
    delete message.rawTruncatedForPreview;
    return null;
  }

  const rawRef = message.rawRef ?? rawRefForMessage(message.id);
  const previewText = buildPreviewText(fullText);
  message.text = previewText;
  message.previewText = previewText;
  message.rawRef = rawRef;
  message.rawSize = fullText.length;
  message.rawLines = countLines(fullText);
  message.rawTruncatedForPreview = true;
  return { rawRef, text: fullText };
}

export function displayTextForMessage(message: ChatMessage): string {
  return message.previewText ?? message.text ?? "";
}

export function buildPreviewText(text: string, head = RAW_PREVIEW_HEAD, tail = RAW_PREVIEW_TAIL): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[内容过大，已收起 ${omitted.toLocaleString()} 字，展开后加载全文]\n\n${text.slice(-tail)}`;
}

export function shouldExternalizeMessage(message: ChatMessage, text = message.text ?? "", threshold = thresholdForMessage(message)): boolean {
  if (!text) return false;
  return text.length > threshold;
}

export function thresholdForMessage(message: ChatMessage): number {
  return isProcessItemType(message.itemType) ? RAW_TEXT_THRESHOLD : LARGE_MESSAGE_THRESHOLD;
}

export function isLargeRawMessage(message: ChatMessage): boolean {
  return Boolean(message.rawRef || message.rawTruncatedForPreview || (message.text?.length ?? 0) > thresholdForMessage(message));
}

export function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function sanitizeRawFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || `msg-${Date.now()}`;
}

function isProcessItemType(itemType?: string): boolean {
  return itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall";
}

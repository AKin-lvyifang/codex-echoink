import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { StoredAttachment } from "../settings/settings";
import { pluginDataDir } from "./raw-message-store";

interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike>;
  files?: ArrayLike<File>;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif"]);

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif"
};

export function extractClipboardImageFiles(data: ClipboardDataLike | null | undefined): File[] {
  if (!data) return [];
  const itemFiles = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" || item.type?.startsWith("image/"))
    .map((item) => item.getAsFile?.() ?? null)
    .filter((file): file is File => Boolean(file && isImageFile(file)));
  if (itemFiles.length) return itemFiles;
  return Array.from(data.files ?? []).filter(isImageFile);
}

export function imageExtensionForMime(mimeType: string, fileName = ""): string | null {
  const normalizedMime = mimeType.toLowerCase();
  if (MIME_EXTENSIONS[normalizedMime]) return MIME_EXTENSIONS[normalizedMime];
  const nameExtension = path.extname(fileName).replace(/^\./, "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(nameExtension)) return nameExtension === "jpeg" ? "jpg" : nameExtension;
  if (!normalizedMime.startsWith("image/")) return null;
  const mimeExtension = normalizedMime.slice("image/".length).replace(/\+xml$/, "").replace(/[^a-z0-9]/g, "");
  return mimeExtension || "png";
}

export async function saveClipboardImageAttachment(file: File, options: { vaultPath: string; timestamp?: number; index?: number }): Promise<StoredAttachment> {
  const vaultPath = options.vaultPath.trim();
  if (!vaultPath) throw new Error("缺少 Obsidian 仓库路径");
  const timestamp = options.timestamp ?? Date.now();
  const index = options.index ?? 0;
  const extension = imageExtensionForMime(file.type, file.name) ?? "png";
  const name = `clipboard-${timestamp}-${index}.${extension}`;
  const target = path.join(pluginDataDir(vaultPath), "clipboard", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return { type: "image", name, path: target };
}

export async function saveClipboardImageAttachments(files: File[], options: { vaultPath: string; timestamp?: number }): Promise<StoredAttachment[]> {
  const timestamp = options.timestamp ?? Date.now();
  const attachments: StoredAttachment[] = [];
  for (let index = 0; index < files.length; index += 1) {
    attachments.push(await saveClipboardImageAttachment(files[index], { vaultPath: options.vaultPath, timestamp, index }));
  }
  return attachments;
}

function isImageFile(file: File): boolean {
  return Boolean(imageExtensionForMime(file.type, file.name));
}

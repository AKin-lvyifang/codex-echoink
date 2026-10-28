import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import {
  convertToPng,
  resizeImage
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  PiInlineImageMimeType,
  PiPreparedInlineImage
} from "../../harness/pi/contracts";
import type { PiChatPreparedImage } from "../../harness/pi-native/contracts";
import type { StoredAttachment } from "../../settings/settings";
import { attachmentDisplayName } from "./attachment-resource";

const { readFile } = getDesktopFsPromises();

const DIRECT_IMAGE_MIME_TYPES = new Set<PiInlineImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

type PiConvertibleImageMimeType =
  | "image/bmp"
  | "image/heic"
  | "image/heif"
  | "image/svg+xml";

const CONVERTIBLE_IMAGE_MIME_TYPES = new Set<PiConvertibleImageMimeType>([
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/svg+xml"
]);

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs"
]);

const HEIF_BRANDS = new Set(["mif1", "msf1"]);

export type PiDetectedImageMimeType =
  | PiInlineImageMimeType
  | PiConvertibleImageMimeType;

export type PiImageInputErrorCode =
  | "ordinary_file_unsupported"
  | "image_unreadable"
  | "image_format_unsupported"
  | "image_conversion_failed"
  | "image_resize_failed";

export class PiImageInputError extends Error {
  constructor(
    readonly code: PiImageInputErrorCode,
    readonly fileName: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PiImageInputError";
  }
}

export async function preparePiChatImages(
  attachments: readonly Readonly<StoredAttachment>[]
): Promise<readonly Readonly<PiChatPreparedImage>[]> {
  const prepared: PiChatPreparedImage[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const displayName = attachmentDisplayName(attachment, index);
    if (attachment.type !== "image") {
      throw new PiImageInputError(
        "ordinary_file_unsupported",
        displayName,
        `普通 Pi Chat 只支持图片附件：“${displayName}”不会发送。`
      );
    }
    prepared.push(await preparePiChatImage(attachment, index));
  }
  return Object.freeze(prepared);
}

export async function preparePiChatImage(
  attachment: Readonly<StoredAttachment>,
  displayIndex = 0
): Promise<Readonly<PiChatPreparedImage>> {
  const displayName = attachmentDisplayName(attachment, displayIndex);
  if (attachment.type !== "image") {
    throw new PiImageInputError(
      "ordinary_file_unsupported",
      displayName,
      `普通 Pi Chat 只支持图片附件：“${displayName}”不会发送。`
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(attachment.path));
  } catch (error) {
    throw new PiImageInputError(
      "image_unreadable",
      displayName,
      `无法读取图片附件“${displayName}”，请确认本地文件仍然存在。`,
      { cause: error }
    );
  }

  const detectedMimeType = detectPiImageMimeType(bytes, attachment.mimeType);
  if (!detectedMimeType) {
    throw new PiImageInputError(
      "image_format_unsupported",
      displayName,
      `无法识别图片附件“${displayName}”的真实格式。`
    );
  }

  let resizeBytes = bytes;
  let resizeMimeType: string = detectedMimeType;
  if (isConvertibleImageMimeType(detectedMimeType)) {
    let converted: Awaited<ReturnType<typeof convertToPng>>;
    try {
      converted = await convertToPng(
        Buffer.from(bytes).toString("base64"),
        detectedMimeType
      );
    } catch (error) {
      throw new PiImageInputError(
        "image_conversion_failed",
        displayName,
        `无法转换图片附件“${displayName}”，本轮没有发送。`,
        { cause: error }
      );
    }
    if (
      !converted
      || normalizeDirectImageMimeType(converted.mimeType) !== "image/png"
      || !validBase64Payload(converted.data)
    ) {
      throw new PiImageInputError(
        "image_conversion_failed",
        displayName,
        `无法转换图片附件“${displayName}”，本轮没有发送。`
      );
    }
    resizeBytes = new Uint8Array(Buffer.from(converted.data, "base64"));
    resizeMimeType = converted.mimeType;
  }

  let resized: Awaited<ReturnType<typeof resizeImage>>;
  try {
    resized = await resizeImage(resizeBytes, resizeMimeType);
  } catch (error) {
    throw new PiImageInputError(
      "image_resize_failed",
      displayName,
      `无法处理图片附件“${displayName}”，图片可能已损坏或无法缩放。`,
      { cause: error }
    );
  }
  if (!resized) {
    throw new PiImageInputError(
      "image_resize_failed",
      displayName,
      `无法处理图片附件“${displayName}”，图片可能已损坏或无法缩放。`
    );
  }

  const preparedMimeType = normalizeDirectImageMimeType(resized.mimeType);
  if (!preparedMimeType || !validBase64Payload(resized.data)) {
    throw new PiImageInputError(
      "image_resize_failed",
      displayName,
      `无法处理图片附件“${displayName}”，Pi 未返回有效图片内容。`
    );
  }

  return Object.freeze({
    content: Object.freeze<PiPreparedInlineImage>({
      kind: "inline_image",
      preflight: "approved",
      data: resized.data,
      mimeType: preparedMimeType
    }),
    attachment: Object.freeze({
      type: "image" as const,
      name: displayName,
      path: attachment.path,
      mimeType: detectedMimeType,
      availability: "available" as const
    })
  });
}

export function piImageContentFromPrepared(
  prepared: Readonly<PiPreparedInlineImage>
): ImageContent {
  return {
    type: "image",
    data: prepared.data,
    mimeType: prepared.mimeType
  };
}

export function detectPiImageMimeType(
  bytes: Uint8Array,
  declaredMimeType?: string
): PiDetectedImageMimeType | null {
  const detected = detectPiImageMagic(bytes);
  if (detected) return detected;
  return normalizeDetectedImageMimeType(declaredMimeType) ?? null;
}

function detectPiImageMagic(bytes: Uint8Array): PiDetectedImageMimeType | null {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return "image/gif";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp";

  const brands = isoBaseMediaBrands(bytes);
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "image/heic";
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "image/heif";

  const prefix = Buffer.from(bytes.subarray(0, 4_096)).toString("utf8");
  if (/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(prefix)) {
    return "image/svg+xml";
  }
  return null;
}

function normalizeDetectedImageMimeType(
  value: string | undefined
): PiDetectedImageMimeType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/x-png") return "image/png";
  if (normalized === "image/x-ms-bmp") return "image/bmp";
  if (
    DIRECT_IMAGE_MIME_TYPES.has(normalized as PiInlineImageMimeType)
    || CONVERTIBLE_IMAGE_MIME_TYPES.has(
      normalized as PiConvertibleImageMimeType
    )
  ) {
    return normalized as PiDetectedImageMimeType;
  }
  return undefined;
}

function normalizeDirectImageMimeType(
  value: string
): PiInlineImageMimeType | undefined {
  const normalized = normalizeDetectedImageMimeType(value);
  return normalized && DIRECT_IMAGE_MIME_TYPES.has(normalized as PiInlineImageMimeType)
    ? normalized as PiInlineImageMimeType
    : undefined;
}

function isConvertibleImageMimeType(
  value: PiDetectedImageMimeType
): value is PiConvertibleImageMimeType {
  return CONVERTIBLE_IMAGE_MIME_TYPES.has(value as PiConvertibleImageMimeType);
}

function isoBaseMediaBrands(bytes: Uint8Array): string[] {
  if (bytes.byteLength < 12 || ascii(bytes, 4, 8) !== "ftyp") return [];
  const declaredLength = readUint32Be(bytes, 0);
  const limit = Math.min(
    bytes.byteLength,
    declaredLength >= 12 ? declaredLength : bytes.byteLength,
    128
  );
  const offsets = [8];
  for (let offset = 16; offset + 4 <= limit; offset += 4) offsets.push(offset);
  return offsets.map((offset) => ascii(bytes, offset, offset + 4));
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.byteLength < end) return "";
  return String.fromCharCode(...bytes.subarray(start, end));
}

function hasBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function validBase64Payload(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").byteLength > 0;
}

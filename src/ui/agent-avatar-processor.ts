import type { AgentAvatarState } from "../harness/memory/agent-identity-model";

export const AGENT_AVATAR_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_AVATAR_SOURCE_MAX_EDGE = 4096;
export const AGENT_AVATAR_OUTPUT_EDGE = 256;
export const AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS = 400_000;
export const AGENT_AVATAR_WEBP_QUALITY = 0.82;

export const AGENT_AVATAR_ACCEPTED_TYPES: readonly string[] = Object.freeze([
  "image/svg+xml"
]);

export type AvatarRejectionCode =
  | "unsupported_type"
  | "source_too_large"
  | "svg_invalid"
  | "svg_not_square"
  | "svg_unsafe"
  | "image_too_large"
  | "output_too_large"
  | "output_invalid"
  | "decode_failed";

export class AvatarProcessingError extends Error {
  readonly code: AvatarRejectionCode;

  constructor(code: AvatarRejectionCode) {
    super(`avatar_processing:${code}`);
    this.code = code;
  }
}

export interface AvatarSvgCanvas {
  readonly width: number;
  readonly height: number;
}

export interface AvatarRenderResult {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly dataUrl: string;
}

export type AvatarRenderer = (
  file: Blob,
  canvas: AvatarSvgCanvas
) => Promise<AvatarRenderResult>;

export function validateAvatarSourceType(type: string): boolean {
  return AGENT_AVATAR_ACCEPTED_TYPES.includes(type.toLowerCase());
}

export function validateAvatarSourceSize(size: number): boolean {
  return Number.isFinite(size) && size > 0 && size <= AGENT_AVATAR_SOURCE_MAX_BYTES;
}

export function validateAvatarDataUrl(
  dataUrl: string
): { ok: true; mimeType: "image/webp" | "image/png" } | { ok: false; code: AvatarRejectionCode } {
  if (typeof dataUrl !== "string" || !dataUrl) return { ok: false, code: "output_invalid" };
  if (dataUrl.startsWith("data:image/webp;base64,")) {
    return dataUrl.length <= AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS
      ? { ok: true, mimeType: "image/webp" }
      : { ok: false, code: "output_too_large" };
  }
  if (dataUrl.startsWith("data:image/png;base64,")) {
    return dataUrl.length <= AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS
      ? { ok: true, mimeType: "image/png" }
      : { ok: false, code: "output_too_large" };
  }
  return { ok: false, code: "output_invalid" };
}

/**
 * Validate the source before it reaches an image decoder. Resource-bearing
 * elements and attributes are rejected wholesale; custom avatars do not need
 * linked images, CSS imports, scripts, event handlers, or foreign documents.
 */
export function validateAgentAvatarSvg(markup: string): AvatarSvgCanvas {
  const source = markup.replace(/^\uFEFF/u, "").trim();
  if (!source) throw new AvatarProcessingError("svg_invalid");

  const withoutDeclaration = source.replace(/^<\?xml[\s\S]*?\?>\s*/iu, "");
  const rootMatch = withoutDeclaration.match(/^<svg\b([^>]*)>/iu);
  if (!rootMatch || !/<\/svg>\s*$/iu.test(withoutDeclaration)) {
    throw new AvatarProcessingError("svg_invalid");
  }

  const unsafeMarkup = [
    /<!DOCTYPE\b/iu,
    /<!ENTITY\b/iu,
    /<\?(?!xml\b)/iu,
    /<\s*(?:script|foreignObject|iframe|object|embed|image|audio|video|link|style|base)\b/iu,
    /\s(?:on[a-z0-9:_-]+)\s*=/iu,
    /\s(?:href|xlink:href|src)\s*=/iu,
    /(?:javascript|vbscript):/iu,
    /(?:url|expression)\s*\(/iu,
    /@import\b/iu
  ];
  if (unsafeMarkup.some((pattern) => pattern.test(withoutDeclaration))) {
    throw new AvatarProcessingError("svg_unsafe");
  }

  const rootAttributes = rootMatch[1];
  const viewBoxValue = readSvgAttribute(rootAttributes, "viewBox");
  const widthValue = readSvgAttribute(rootAttributes, "width");
  const heightValue = readSvgAttribute(rootAttributes, "height");
  let viewBoxCanvas: AvatarSvgCanvas | null = null;
  if (viewBoxValue !== null) {
    const values = viewBoxValue.trim().split(/[\s,]+/u).map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      throw new AvatarProcessingError("svg_invalid");
    }
    viewBoxCanvas = { width: values[2], height: values[3] };
    validateCanvas(viewBoxCanvas);
  }

  let intrinsicCanvas: AvatarSvgCanvas | null = null;
  if (widthValue !== null || heightValue !== null) {
    if (widthValue === null || heightValue === null) {
      throw new AvatarProcessingError("svg_invalid");
    }
    intrinsicCanvas = {
      width: parseSvgLength(widthValue),
      height: parseSvgLength(heightValue)
    };
    validateCanvas(intrinsicCanvas);
  }

  const canvas = intrinsicCanvas ?? viewBoxCanvas;
  if (!canvas) throw new AvatarProcessingError("svg_invalid");
  return Object.freeze(canvas);
}

export async function processAgentAvatar(
  file: Blob,
  type: string,
  size: number,
  renderer: AvatarRenderer
): Promise<Extract<AgentAvatarState, { kind: "custom" }>> {
  if (!validateAvatarSourceType(type)) throw new AvatarProcessingError("unsupported_type");
  if (!validateAvatarSourceSize(size)) throw new AvatarProcessingError("source_too_large");

  let markup: string;
  try {
    markup = await file.text();
  } catch {
    throw new AvatarProcessingError("svg_invalid");
  }
  const canvas = validateAgentAvatarSvg(markup);

  let rendered: AvatarRenderResult;
  try {
    rendered = await renderer(
      new Blob([markup], { type: "image/svg+xml" }),
      canvas
    );
  } catch (error) {
    if (error instanceof AvatarProcessingError) throw error;
    throw new AvatarProcessingError("decode_failed");
  }

  validateCanvas({ width: rendered.sourceWidth, height: rendered.sourceHeight });
  const validated = validateAvatarDataUrl(rendered.dataUrl);
  if (!validated.ok) throw new AvatarProcessingError(validated.code);

  return Object.freeze({
    kind: "custom",
    mimeType: validated.mimeType,
    dataUrl: rendered.dataUrl,
    width: AGENT_AVATAR_OUTPUT_EDGE,
    height: AGENT_AVATAR_OUTPUT_EDGE
  });
}

export function createBrowserAvatarRenderer(): AvatarRenderer {
  return async (file, canvas): Promise<AvatarRenderResult> => {
    let bitmap: ImageBitmap | null = null;
    let imageUrl: string | null = null;
    try {
      const safeBlob = await normalizeSvgForRasterization(file, canvas);
      let source: ImageBitmap | HTMLImageElement;
      try {
        bitmap = await createImageBitmap(safeBlob);
        source = bitmap;
      } catch {
        // Some browser engines decode SVG through <img> but reject SVG blobs
        // in createImageBitmap. The same validated, normalized SVG stays local.
        imageUrl = URL.createObjectURL(safeBlob);
        const image = document.createElement("img");
        source = await new Promise<HTMLImageElement>((resolve, reject) => {
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("avatar_decode_failed"));
          image.src = imageUrl!;
        });
      }
      const sourceWidth = bitmap ? bitmap.width : (source as HTMLImageElement).naturalWidth;
      const sourceHeight = bitmap ? bitmap.height : (source as HTMLImageElement).naturalHeight;
      validateCanvas({ width: sourceWidth, height: sourceHeight });

      const output = document.createElement("canvas");
      output.width = AGENT_AVATAR_OUTPUT_EDGE;
      output.height = AGENT_AVATAR_OUTPUT_EDGE;
      const context = output.getContext("2d");
      if (!context) throw new Error("avatar_canvas_unavailable");
      context.drawImage(
        source,
        0,
        0,
        sourceWidth,
        sourceHeight,
        0,
        0,
        AGENT_AVATAR_OUTPUT_EDGE,
        AGENT_AVATAR_OUTPUT_EDGE
      );

      let blob = await canvasToBlob(output, "image/webp", AGENT_AVATAR_WEBP_QUALITY);
      if (!blob) blob = await canvasToBlob(output, "image/png");
      if (!blob) throw new Error("avatar_export_failed");
      return { sourceWidth, sourceHeight, dataUrl: await blobToDataUrl(blob) };
    } finally {
      bitmap?.close();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    }
  };
}

function readSvgAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, "iu"));
  return match?.[2] ?? null;
}

function parseSvgLength(value: string): number {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:px)?$/iu);
  if (!match) throw new AvatarProcessingError("svg_invalid");
  return Number(match[1]);
}

function validateCanvas(canvas: AvatarSvgCanvas): void {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height)
    || canvas.width <= 0 || canvas.height <= 0) {
    throw new AvatarProcessingError("svg_invalid");
  }
  if (Math.max(canvas.width, canvas.height) > AGENT_AVATAR_SOURCE_MAX_EDGE) {
    throw new AvatarProcessingError("image_too_large");
  }
  if (Math.abs(canvas.width - canvas.height) > 0.001) {
    throw new AvatarProcessingError("svg_not_square");
  }
}

async function normalizeSvgForRasterization(file: Blob, canvas: AvatarSvgCanvas): Promise<Blob> {
  const source = await file.text();
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) {
    throw new AvatarProcessingError("svg_invalid");
  }
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  root.setAttribute("width", String(canvas.width));
  root.setAttribute("height", String(canvas.height));
  return new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("avatar_read_failed"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("avatar_read_failed"));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

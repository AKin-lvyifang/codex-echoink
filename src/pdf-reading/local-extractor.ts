import { loadPdfJs } from "obsidian";
import { pdfAbort, type PdfExtraction } from "./types";

interface PdfPageProxy {
  getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean; transform?: number[] }> }>;
  getViewport(input: { scale: number }): { width: number; height: number };
  render(input: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}
export interface PdfEngine {
  getDocument(input: Record<string, unknown>): { promise: Promise<{ numPages: number; getPage(number: number): Promise<PdfPageProxy> }>; destroy(): Promise<void> };
}

/** Obsidian owns PDF.js. Page numbers always come from its page API. */
export async function extractLocalPdf(bytes: Uint8Array, signal: AbortSignal,
  progress: (stage: string) => void, engine?: PdfEngine,
  renderPage: (page: PdfPageProxy, signal: AbortSignal) => Promise<Uint8Array> = renderPageImage
): Promise<PdfExtraction> {
  const pdf = engine ?? await loadPdfJs() as PdfEngine;
  const task = pdf.getDocument({ data: new Uint8Array(bytes), cMapUrl: "/lib/pdfjs/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/lib/pdfjs/standard_fonts/", useSystemFonts: true, isEvalSupported: false });
  const result: PdfExtraction = { pages: [], images: [], warnings: ["本地提取保留分页文字和页面图像；复杂表格、公式请对照页面图像，扫描页请改用增强解析。"], engine: "local" };
  const cancel = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    pdfAbort(signal);
    const doc = await task.promise;
    if (doc.numPages > 200) throw new Error("单篇最多处理 200 页，请拆分后再试。");
    for (let number = 1; number <= doc.numPages; number++) {
      pdfAbort(signal);
      progress(`提取第 ${number} / ${doc.numPages} 页`);
      const page = await doc.getPage(number);
      try {
        const { items } = await page.getTextContent();
        let previousY: number | undefined;
        const text = items.filter(item => typeof item.str === "string").map(item => {
          const y = item.transform?.[5];
          const newline = previousY !== undefined && y !== undefined && Math.abs(y - previousY) > 3;
          previousY = y;
          return `${newline ? "\n" : ""}${item.str}${item.hasEOL ? "\n" : " "}`;
        }).join("").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
        const imagePath = `images/page-${number}.png`;
        result.images.push({ path: imagePath, bytes: await renderPage(page, signal) });
        result.pages.push({ number, markdown: `${text || "（此页没有可提取文字，需增强解析识别。）"}\n\n![第 ${number} 页页面图像](${imagePath})` });
        if (!text) result.warnings.push(`第 ${number} 页无文字层；精读与翻译不包含此页图像中的内容。`);
      } finally { page.cleanup(); }
    }
  } catch (error) {
    try { await task.destroy(); } catch { /* Preserve the parsing error. */ }
    throw error;
  } finally { signal.removeEventListener("abort", cancel); }
  await task.destroy();
  return result;
}

async function renderPageImage(page: PdfPageProxy, signal: AbortSignal): Promise<Uint8Array> {
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(1.4, 1800 / Math.max(original.width, original.height)) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法保存 PDF 页面图像。");
  const task = page.render({ canvasContext: context, viewport });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    pdfAbort(signal); await task.promise; pdfAbort(signal);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("页面图像保存失败。")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { signal.removeEventListener("abort", cancel); canvas.width = canvas.height = 0; }
}

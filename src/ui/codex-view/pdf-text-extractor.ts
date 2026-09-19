import { loadPdfJs } from "obsidian";

// Obsidian owns the engine and shared worker. Keep this adapter limited to the
// public PDF.js text API instead of shipping a second engine with the plugin.
interface PdfTextEngine {
  getDocument(options: {
    data: Uint8Array;
    cMapUrl: string;
    cMapPacked: boolean;
    standardFontDataUrl: string;
    useSystemFonts: boolean;
    isEvalSupported: boolean;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(page: number): Promise<{
        getTextContent(): Promise<{
          items: Array<{ str?: string; hasEOL?: boolean }>;
        }>;
      }>;
    }>;
    destroy(): Promise<void>;
  };
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfJs = await loadPdfJs() as PdfTextEngine;
  const task = pdfJs.getDocument({
    // A worker may transfer/detach this buffer. Never give it the attachment's
    // frozen buffer (or a Buffer.slice view of it).
    data: new Uint8Array(bytes),
    // These are Obsidian's bundled resources, also used by its own PDF viewer.
    cMapUrl: "/lib/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/lib/pdfjs/standard_fonts/",
    useSystemFonts: true,
    isEvalSupported: false
  });
  let text: string;
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const { items } = await page.getTextContent();
      pages.push(items
        .filter((item) => typeof item.str === "string")
        .map((item) => item.str + (item.hasEOL ? "\n" : ""))
        .join(""));
    }
    // Match the previous extractor's page and whitespace semantics.
    text = pages.join("\n")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ ?\n ?/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n");
  } catch (error) {
    // Release a rejected loading/reading task without replacing its original
    // parsing/password error if teardown also fails.
    try {
      await task.destroy();
    } catch {
      // The original parsing error remains the useful failure to report.
    }
    throw error;
  }
  await task.destroy();
  return text;
}

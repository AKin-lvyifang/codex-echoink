import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setPdfJsForTests } from "../obsidian-shim";
import { extractPdfText } from "../../ui/codex-view/pdf-text-extractor";

export const BILINGUAL_PDF_TEXT =
  "First page.\n中文第一页\nNext line.\nSecond page.\n中文第二页\nNext line.";

export async function runPdfTextExtractorTests(): Promise<void> {
  // Real parsing through the test PDF.js engine; not Obsidian host acceptance.
  const bytes = await readFile("src/tests/fixtures/pdf/bilingual-multipage.pdf");
  const original = Buffer.from(bytes);
  assert.equal(await extractPdfText(bytes), BILINGUAL_PDF_TEXT);
  assert.deepEqual(bytes, original);

  for (const failure of [null, "load", "page", "text"] as const) {
    let destroyed = 0;
    const workerOptions = Object.freeze({ workerSrc: "host-owned-worker" });
    const parseError = new Error(`fixture ${failure}`);
    setPdfJsForTests({
      GlobalWorkerOptions: workerOptions,
      getDocument(options: { data: Uint8Array; cMapUrl: string; cMapPacked: boolean; standardFontDataUrl: string }) {
        assert.notEqual(options.data.buffer, bytes.buffer);
        assert.deepEqual(options.data, new Uint8Array(original));
        assert.equal(options.cMapUrl, "/lib/pdfjs/cmaps/");
        assert.equal(options.cMapPacked, true);
        assert.equal(options.standardFontDataUrl, "/lib/pdfjs/standard_fonts/");
        structuredClone(options.data, { transfer: [options.data.buffer] });
        assert.equal(options.data.byteLength, 0, "simulate worker buffer transfer");
        return {
          promise: failure === "load" ? Promise.reject(parseError) : Promise.resolve({
            numPages: 2,
            async getPage(page: number) {
              if (failure === "page") throw parseError;
              return {
                async getTextContent() {
                  if (failure === "text") throw parseError;
                  return { items: [{ str: `page ${page}`, hasEOL: true }, { type: "markedContent" }, { str: "中文" }] };
                }
              };
            }
          }),
          async destroy() {
            destroyed++;
            if (failure === "load") throw new Error("teardown failure must not replace parse error");
          }
        };
      }
    });
    try {
      if (failure) await assert.rejects(extractPdfText(bytes), (error: unknown) => error === parseError);
      else assert.equal(await extractPdfText(bytes), "page 1\n中文\npage 2\n中文");
      assert.equal(destroyed, 1);
      assert.deepEqual(bytes, original, "frozen attachment survives worker transfer");
      assert.equal(workerOptions.workerSrc, "host-owned-worker");
    } finally {
      setPdfJsForTests(undefined);
    }
  }
}

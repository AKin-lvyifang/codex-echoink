export const PDF_READING_NAME = "PDF 精读 · 提取";
export interface PdfReadingSettings { enabled: boolean; mineruToken: string; engine: "local" | "mineru"; translationLanguage: string }
export interface PdfPage { number: number; markdown: string }
export interface PdfImage { path: string; bytes: Uint8Array }
export interface PdfExtraction { pages: PdfPage[]; images: PdfImage[]; warnings: string[]; engine: "local" | "mineru" }
export interface PdfOptions { engine: "local" | "mineru"; reading: boolean; translation: boolean; translationLanguage?: string; wiki: boolean }
export interface PdfArtifact { kind: "raw" | "reading" | "translation" | "wiki"; path: string }
export interface PdfChunk { page: number; part: number; source: string; reading?: string; translation?: string }
export interface PdfJob {
  version: 1; id: string; name: string; createdAt: number; options: PdfOptions;
  state: "running" | "completed" | "partial" | "cancelled" | "failed";
  stage: string; error?: string; batchId?: string; uploadUrl?: string; sourceFingerprint?: string; wikiState?: "running" | "completed" | "failed"; uploadState?: "prepared" | "uploaded" | "uncertain";
  artifactPrefix?: string;
  imageDirectory?: string;
  imagePaths?: string[];
  rawDirectory: string; sourceLanguage?: string; artifacts: PdfArtifact[]; pages: PdfPage[];
  chunks: PdfChunk[]; warnings: string[]; published: Partial<Record<"reading" | "translation", string>>;
}
export interface PdfFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBinary?(path: string): Promise<Uint8Array>;
  create(path: string, value: string | Uint8Array): Promise<void>;
  replace(path: string, value: string, expected?: string): Promise<void>;
  listJobs(): Promise<string[]>;
  roots(): string[];
}
export const pdfAbort = (signal: AbortSignal): void => { if (signal.aborted) throw new Error("处理已取消，已保存的成果保留。"); };
export function pdfStem(name: string): string {
  return name.replace(/\.pdf$/iu, "").replace(/[\\/:*?"<>|#\[\]\x00-\x1f]/gu, " ").trim().slice(0, 90) || "PDF";
}

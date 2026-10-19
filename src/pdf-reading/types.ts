export const PDF_READING_NAME = "PDF 精读 · 提取";
export interface PdfReadingSettings { enabled: boolean; mineruToken: string; engine: "local" | "mineru"; translationLanguage: string; originalDirectory?: string }
export interface PdfPage { number: number; markdown: string }
export interface PdfImage { path: string; bytes: Uint8Array }
export interface PdfExtraction { pages: PdfPage[]; images: PdfImage[]; warnings: string[]; engine: "local" | "mineru" }
export interface PdfOptions { engine: "local" | "mineru"; reading: boolean; translation: boolean; translationLanguage?: string; wiki: boolean; summary?: boolean }
export interface PdfArtifact { kind: "raw" | "reading" | "translation" | "wiki"; path: string }
export interface PdfChunk { page: number; part: number; source: string; reading?: string; translation?: string }
/** Desktop source copy; plannedPath is durable before any bytes are written. */
export interface PdfOriginal { plannedPath: string; savedPath?: string; byteLength: number }
export interface PdfStartIntent {
  id: string; name: string; sourceFingerprint: string; byteLength: number; options: PdfOptions;
  rawDirectory: string; artifactPrefix?: string; original?: PdfOriginal; conversationId?: string;
}
export interface PdfStartContext {
  conversationId?: string; originalDirectory?: string; intent?: Readonly<PdfStartIntent>;
  /** Current run, capability, directory and cancellation checks at each publication boundary. */
  assertCanWrite?: () => Promise<void>;
}
export interface PdfHistory { jobs: PdfJob[]; errors: string[] }
/** Host-owned task choices. No local binary body or external file path enters this context. */
export interface PdfTaskRequest {
  jobId: string; attachmentId: string; name: string; sourceFingerprint: string; byteLength: number;
  originalDirectory: string; options: PdfOptions;
}
export interface PdfNavigationStart {
  attachment: import("../settings/settings").StoredAttachment;
  options: PdfOptions; originalDirectory: string;
}
export interface PdfNavigationArtifact { kind: "original" | "raw" | "translation" | "reading" | "summary" | "wiki"; path: string; label: string; missing?: boolean }
export interface PdfNavigationEntry { job: PdfJob; artifacts: PdfNavigationArtifact[]; originalState: "available" | "not-saved" | "missing" | "changed" | "pending"; taskId?: string; taskStatus?: import("../agents/task-metadata").ConversationTaskStatus }
export interface PdfNavigationData { entries: PdfNavigationEntry[]; errors: string[] }
export interface PdfJob {
  version: 1; id: string; name: string; createdAt: number; options: PdfOptions;
  state: "running" | "completed" | "partial" | "cancelled" | "failed";
  stage: string; error?: string; batchId?: string; uploadUrl?: string; sourceFingerprint?: string; wikiState?: "running" | "completed" | "failed"; uploadState?: "prepared" | "uploaded" | "uncertain";
  conversationId?: string;
  original?: PdfOriginal;
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

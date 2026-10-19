import type { PdfNavigationEntry, PdfTaskRequest } from "./types";

/** A completed extractor is only one part of the explicitly selected task. */
export function assertPdfTaskDelivery(request: Readonly<Pick<PdfTaskRequest, "jobId" | "sourceFingerprint" | "options"> & { requiresOriginal?: boolean }>, entry: PdfNavigationEntry | undefined, noNewSourcePaths: readonly string[] = []): void {
  if (!entry || entry.job.id !== request.jobId || entry.job.sourceFingerprint !== request.sourceFingerprint) throw new Error("PDF 任务记录未核实，请继续查询本任务。");
  if ((request.requiresOriginal !== false || entry.job.original) && entry.originalState !== "available") throw new Error("原 PDF 未通过回读，请核对后继续。");
  if (entry.job.state !== "completed") throw new Error(entry.job.error || "PDF 处理尚未完成，已经保存的成果保留。");
  const artifacts = entry.artifacts.filter(artifact => !artifact.missing);
  const raw = artifacts.find(artifact => artifact.kind === "raw");
  if (!raw) throw new Error("提取原文未通过回读，已保存的原件保留。");
  // The extractor may explicitly skip an already same-language translation.
  if (request.options.translation && entry.job.options.translation && !artifacts.some(artifact => artifact.kind === "translation")) throw new Error("译文尚未保存并回读，请继续本任务。");
  if (noNewSourcePaths.includes(raw.path)) return;
  for (const [kind, selected, label] of [["reading", request.options.reading, "精读"], ["summary", request.options.summary, "摘要"]] as const) {
    if (selected && !artifacts.some(artifact => artifact.kind === kind)) throw new Error(`${label}尚未保存到知识成果，请继续本任务；内部分析已经保留。`);
  }
}

/** A title mentioning both outputs is not two delivered sections. Skip fenced examples and empty headings. */
export function pdfKnowledgeSection(content: string, kind: "reading" | "summary"): string | null {
  const lines = content.split("\n"); let fence = "";
  const wanted = kind === "reading" ? /^(?:精读|close reading)(?:\s*[:：·—-]|$)/iu : /^(?:摘要|summary)(?:\s*[:：·—-]|$)/iu;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(lines[i])?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; continue; }
    if (fence) continue;
    const heading = /^(#{2,6})\s+(.+?)\s*#*$/u.exec(lines[i]);
    if (!heading || !wanted.test(heading[2])) continue;
    let body = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = /^(#{1,6})\s+/u.exec(lines[j]);
      if (next && next[1].length <= heading[1].length) break;
      if (!next) body += lines[j].trim();
    }
    if (body) return heading[2];
  }
  return null;
}

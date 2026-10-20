import type { PdfArtifact } from "./types";
export const PDF_ARTIFACT_LABELS = { raw: "提取正文", reading: "精读笔记", translation: "AI 译文", wiki: "已补充的知识" };
export function pdfNoteLink(path: string, label: string): string {
  const [target, ...heading] = path.split("#");
  const href = target.split("/").map(part => encodeURIComponent(part).replace(/\(/gu, "%28").replace(/\)/gu, "%29")).join("/") + (heading.length ? "#" + encodeURIComponent(heading.join("#")) : "");
  return `[${label.replace(/[[\]|]/gu, " ")}](<${href}>)`;
}
export function pdfResultsTable(artifacts: readonly PdfArtifact[]): string {
  if (!artifacts.length) return "尚无已保存的成果。";
  return ["| 产物 | 笔记链接 | 保存路径 |", "| --- | --- | --- |", ...artifacts.map(item =>
    `| ${PDF_ARTIFACT_LABELS[item.kind]} | ${pdfNoteLink(item.path, item.path.split("/").pop()!.replace(/\.md$/u, ""))} | \`${item.path.replace(/`/gu, "&#96;")}\` |`)].join("\n");
}

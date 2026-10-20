import type { GenerationRequest } from "./types";
export function generationFileStem(title: string, templateName: string): string {
  const clean = (value: string, limit: number) => Array.from(value).slice(0, limit).join("")
    .replace(/[<>:"/\\|?*\p{C}#^\[\]]/gu, "").replace(/\s+/gu, " ").replace(/[. ]+$/gu, "").trim();
  const topic = clean(title, 20) || "生成成果";
  let stem = `${topic} · ${clean(templateName, 40) || "自制格式"}`;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) stem = `成果 ${stem}`;
  return stem;
}
export function generationSourceLink(sourcePath: string): string {
  const target = sourcePath.replace(/\.md$/iu, "");
  const name = target.split("/").at(-1) ?? target;
  return `[[${target}|${name}]]`;
}
function localGenerationTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid time value");
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function generationReportMarkdown(request: GenerationRequest, markdown: string, successfullyReadPaths: readonly string[]): string {
  if (!markdown.trim()) throw new Error("生成报告正文为空，本轮尚未写入文件。");
  return ["---", `类型: ${JSON.stringify("报告")}`, `模板: ${JSON.stringify(request.template.name)}`,
    `来源:\n${successfullyReadPaths.map(source => `  - ${JSON.stringify(generationSourceLink(source))}`).join("\n")}`,
    `生成时间: ${JSON.stringify(localGenerationTime(request.createdAt))}`, "---", "", markdown.trim(), ""].join("\n");
}

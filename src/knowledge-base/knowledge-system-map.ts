import { maintenanceDomainMapModeMarker } from "./maintenance-domain-map";
import { renderKnowledgeFrameworkMap, type KnowledgeFramework } from "./knowledge-system-analysis";
import type { KnowledgeSystemTask } from "./knowledge-system-task";

/** Keep handwritten prose and provenance, replacing only the approved domain's structure. */
export function renderKnowledgeSystemBlock(
  task: Pick<KnowledgeSystemTask, "domain" | "block" | "documents" | "mapPath">,
  framework: KnowledgeFramework,
): string {
  const old = task.block ?? "",
    eol = old.includes("\r\n") ? "\r\n" : "\n";
  const paths = new Set(task.documents.map((doc) => doc.path));
  let inGaps = false,
    inSources = false,
    fence = "";
  const handwritten: string[] = [],
    sources: string[] = [];
  for (const line of old.split(/\r?\n/u)) {
    if (/^<!-- echoink-domain-map:(?:BEGIN|END|MODE) /u.test(line)) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker) {
      handwritten.push(line);
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      }
      continue;
    }
    if (/^###\s+/u.test(line)) {
      inGaps = /^###\s+缺口\s*$/u.test(line);
      inSources = /^###\s+来源\s*$/u.test(line);
      if (inSources) sources.push(line);
      continue;
    }
    if (inSources) {
      sources.push(line);
      continue;
    }
    if (/^##\s+/u.test(line) || (inGaps && /^-\s+/u.test(line))) continue;
    const linkLine = line.replace(/ ?<!-- echoink-placement: \{[^\r\n]*\} -->/u, "");
    const link =
      /^\s*-\s+\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/u.exec(linkLine)?.[1] ??
      /^\s*-\s+\[[^\]]*\]\(<?([^)>]+)>?\)\s*$/u.exec(linkLine)?.[1];
    if (link) {
      let decoded = link;
      try {
        decoded = decodeURIComponent(link);
      } catch {
        /* Keep unrecognized user text. */
      }
      const parts = task.mapPath.split("/").slice(0, -1);
      for (const part of decoded.split("/")) {
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
      }
      if (
        paths.has(decoded) ||
        paths.has(decoded + ".md") ||
        paths.has(parts.join("/")) ||
        task.documents.some((doc) => doc.path.split("/").at(-1)?.replace(/\.md$/iu, "") === decoded)
      )
        continue;
    }
    if (line.trim() || (handwritten.length && handwritten.at(-1)?.trim())) handwritten.push(line);
  }
  const map = renderKnowledgeFrameworkMap(task.domain, framework).split("\n"),
    heading = map.shift()!;
  const token = encodeURIComponent(task.domain);
  return [
    `<!-- echoink-domain-map:BEGIN ${token} -->`,
    maintenanceDomainMapModeMarker("tree"),
    heading,
    "",
    ...handwritten,
    ...map,
    ...sources,
    `<!-- echoink-domain-map:END ${token} -->`,
  ].join(eol);
}

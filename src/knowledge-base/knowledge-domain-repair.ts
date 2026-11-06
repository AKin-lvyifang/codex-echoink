import { readMaintenanceDomainBlocks } from "./maintenance-domain-map";
import {
  patchKnowledgeProperties,
  readMaintenanceFrontmatterProperty,
} from "./maintenance-source-frontmatter";

/** Preserve every byte inside both trees, including handwritten branches and comments. */
export function mergeKnowledgeDomainMaps(content: string, keep: string, remove: string): string {
  const blocks = readMaintenanceDomainBlocks(content);
  const source = blocks.find((block) => block.domain === remove);
  if (!source) return content;
  const target = blocks.find((block) => block.domain === keep);
  const sourceText = content.slice(source.start, source.end);
  const begin = `<!-- echoink-domain-map:BEGIN ${encodeURIComponent(remove)} -->`;
  const end = `<!-- echoink-domain-map:END ${encodeURIComponent(remove)} -->`;
  let after: string;
  if (!target) {
    after = sourceText
      .replace(begin, `<!-- echoink-domain-map:BEGIN ${encodeURIComponent(keep)} -->`)
      .replace(end, `<!-- echoink-domain-map:END ${encodeURIComponent(keep)} -->`)
      .replace(/^## .+$/mu, `## ${keep}`);
    return content.slice(0, source.start) + after + content.slice(source.end);
  }
  const body = sourceText
    .slice(begin.length)
    .replace(/^\r?\n<!-- echoink-domain-map:MODE (?:tree|list) -->/u, "")
    .replace(/^\r?\n## [^\r\n]+/u, "")
    .replace(end, "")
    .replace(/<!-- echoink-domain-map:sources -->/gu, "");
  const targetText = content.slice(target.start, target.end);
  const targetEnd = `<!-- echoink-domain-map:END ${encodeURIComponent(keep)} -->`;
  const mode = source.mode === "tree" || target.mode === "tree" ? "tree" : "list";
  after = targetText.replace(
    /<!-- echoink-domain-map:MODE (?:tree|list) -->/u,
    `<!-- echoink-domain-map:MODE ${mode} -->`,
  );
  const heads = [...body.matchAll(/^### ([^\r\n]+)\r?\n/gmu)];
  const prefix = body.slice(0, heads[0]?.index ?? body.length);
  if (prefix.trim()) after = after.replace(targetEnd, `${prefix}\n${targetEnd}`);
  for (let index = 0; index < heads.length; index++) {
    const head = heads[index];
    const payload = body.slice(
      head.index + head[0].length,
      heads[index + 1]?.index ?? body.length,
    );
    const existing = [...after.matchAll(/^### ([^\r\n]+)\r?\n/gmu)];
    const match = existing.find((item) => item[1] === head[1]);
    const position = match
      ? (existing[existing.indexOf(match) + 1]?.index ?? after.indexOf(targetEnd))
      : after.indexOf(targetEnd);
    const prior = match ? after.slice(match.index + match[0].length, position) : "";
    const shared = match && head[1] === "缺口"
      ? payload.split(/\r?\n/u).filter(line => !/^[-+*]\s/u.test(line) || !prior.includes(line.trim())).join("\n")
      : payload;
    const addition = match ? shared : head[0] + shared;
    after = after.slice(0, position) + "\n" + addition.trimEnd() + "\n" + after.slice(position);
  }
  let result = content;
  for (const edit of [
    { start: target.start, end: target.end, after },
    { start: source.start, end: source.end, after: "" },
  ].sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
  return result;
}

/** Relocate a source block into a different map without replacing either note's handwritten surroundings. */
export function rehomeKnowledgeDomainBlock(
  source: string,
  target: string,
  keep: string,
  remove: string,
) {
  const block = readMaintenanceDomainBlocks(source).find((block) => block.domain === remove);
  if (!block) return null;
  const combined = target + "\n\n" + source.slice(block.start, block.end);
  return {
    source: source.slice(0, block.start) + source.slice(block.end),
    target: mergeKnowledgeDomainMaps(combined, keep, remove),
  };
}

export function domainValue(content: string): string | null {
  const value = readMaintenanceFrontmatterProperty(content, "领域");
  return !value.error && typeof value.value === "string" ? value.value : null;
}
export function updateKnowledgeDomain(content: string, keep: string): string {
  const field = readMaintenanceFrontmatterProperty(content, "领域");
  if (field.error || typeof field.value !== "string")
    throw new Error("领域属性类型不兼容，原值保留。");
  return patchKnowledgeProperties(content, { 领域: keep });
}

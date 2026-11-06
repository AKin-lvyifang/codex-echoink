import type { App } from "obsidian";
import { isScalar, parseDocument, visit } from "yaml";
import { knowledgeLinkDestination } from "./folder-link-renames";
import type { KnowledgeCheckupIssue } from "./knowledge-checkup";
import {
  patchKnowledgeProperties,
  readMaintenanceFrontmatterProperty,
} from "./maintenance-source-frontmatter";

/** Ignore is an explicit user decision, so it belongs to the note; diagnostic findings do not. */
export function ignoreKnowledgeCheckup(content: string, key: string): string {
  const field = readMaintenanceFrontmatterProperty(content, "体检忽略");
  if (
    field.error ||
    (field.present &&
      (!Array.isArray(field.value) || field.value.some((v) => typeof v !== "string")))
  )
    throw new Error("体检忽略属性必须是文本列表，原值保留。");
  return patchKnowledgeProperties(content, {
    体检忽略: [...new Set([...((field.value as string[]) ?? []), key])],
  });
}

/** Native-cache positions select body links; YAML ranges preserve every unselected property byte. */
export function fixKnowledgeBrokenLinks(
  app: App,
  path: string,
  content: string,
  changes: readonly { issue: KnowledgeCheckupIssue; target: string }[],
): string {
  const file = app.vault.getFileByPath(path),
    cache = file && app.metadataCache.getFileCache(file);
  if (!cache) throw new Error("链接已变化，请重新快查。");
  const replacements = new Map<string, string>();
  for (const { issue, target } of changes) {
    const original = issue.original,
      span = original && knowledgeLinkDestination(original);
    if (!original || !span || !app.vault.getFileByPath(target))
      throw new Error("链接目标已变化，请重新快查。");
    const raw = original.slice(span.start, span.end),
      hash = raw.indexOf("#"),
      suffix = hash < 0 ? "" : raw.slice(hash);
    const destination = span.wiki
      ? target.replace(/\.md$/iu, "")
      : encodeURI(target).replace(/#/gu, "%23");
    const label =
      span.wiki && !original.slice(span.end).startsWith("|") ? "|" + raw.replace(/#/u, " > ") : "";
    replacements.set(
      original,
      original.slice(0, span.start) + destination + suffix + label + original.slice(span.end),
    );
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
    const after = replacements.get(ref.original);
    if (!after) continue;
    if (content.slice(ref.position.start.offset, ref.position.end.offset) !== ref.original)
      throw new Error("链接正文已变化，请重新快查。");
    edits.push({ start: ref.position.start.offset, end: ref.position.end.offset, text: after });
  }
  if ((cache.frontmatterLinks ?? []).some((ref) => replacements.has(ref.original))) {
    const front = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(content);
    if (!front) throw new Error("链接属性已变化，请重新快查。");
    const doc = parseDocument(front[1]),
      offset = front[0].indexOf(front[1]);
    if (doc.errors.length) throw new Error("链接属性无法读取，原值保留。");
    visit(doc, (_key, node) => {
      if (!isScalar(node) || typeof node.value !== "string" || !node.range) return;
      let value = node.value;
      for (const ref of cache.frontmatterLinks ?? []) {
        const after = replacements.get(ref.original);
        if (after) value = value.split(ref.original).join(after);
      }
      if (value === node.value) return;
      edits.push({
        start: offset + node.range[0],
        end: offset + node.range[1],
        text:
          node.type === "QUOTE_SINGLE"
            ? "'" + value.replace(/'/gu, "''") + "'"
            : JSON.stringify(value),
      });
    });
  }
  if (!edits.length) throw new Error("没有找到原链接，请重新快查。");
  let next = content;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return next;
}

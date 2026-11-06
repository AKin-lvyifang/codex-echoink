import type { App, ReferenceCache } from "obsidian";
import { parseDocument, isScalar, visit } from "yaml";
import { getDesktopPath } from "../platform/desktop-paths";
import { projectedKnowledgeLinks } from "./knowledge-link-resolution";
import { knowledgeLinkDestination } from "./folder-link-renames";
import type { KnowledgeSystemMoveFile, KnowledgeSystemMoveLinks } from "./knowledge-system-move";

const path = getDesktopPath().posix;
interface Edit {
  start: number;
  end: number;
  after: string;
}

/** Reuse the native-link destination parser, preserving labels, Markdown titles and subpaths byte for byte. */
function renamedReference(
  app: App,
  original: string,
  link: string,
  source: string,
  nextSource: string,
  moved: ReadonlyMap<string, string>,
  resolveAfter: (link: string, source: string) => string | null,
  subpath?: (target: string, suffix: string) => string,
): string | null {
  const span = knowledgeLinkDestination(original);
  if (!span) return null;
  const raw = original.slice(span.start, span.end);
  const hash = raw.indexOf("#");
  const rawPath = hash < 0 ? raw : raw.slice(0, hash);
  const previousSuffix = hash < 0 ? "" : raw.slice(hash);
  const linkPath = link.split("#")[0];
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(linkPath)) return null;
  const target = linkPath
    ? app.metadataCache.getFirstLinkpathDest(linkPath, source)
    : app.vault.getFileByPath(source);
  if (!target) return null;
  const suffix = subpath?.(target.path, previousSuffix) ?? previousSuffix;
  const nextTarget = moved.get(target.path) ?? target.path;
  // Heading-only and block-only links continue to refer to the moved file itself.
  if (!rawPath && nextTarget === nextSource && suffix === previousSuffix) return null;
  if (span.wiki && resolveAfter(linkPath, nextSource) === nextTarget && suffix === previousSuffix) return null;
  if (!span.wiki && source === nextSource && target.path === nextTarget) return null;
  let destination: string;
  if (span.wiki) {
    destination = nextTarget.replace(/\.md$/iu, "");
    const label = original.slice(span.end).startsWith("|") ? "" : "|" + raw.replace(/#/u, " > ");
    return original.slice(0, span.start) + destination + suffix + label + original.slice(span.end);
  } else {
    destination = path.relative(path.dirname(nextSource), nextTarget);
    if (rawPath.startsWith("./") && !destination.startsWith(".")) destination = "./" + destination;
    destination = encodeURI(destination).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
    if (!raw.includes("<")) destination = destination.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  }
  return original.slice(0, span.start) + destination + suffix + original.slice(span.end);
}

/** Capture all affected references before the first rename, including relative outbound and property links. */
export async function captureKnowledgeMoveLinks(
  app: App,
  files: readonly KnowledgeSystemMoveFile[],
  subpath?: (target: string, suffix: string) => string,
  relocatedSources?: ReadonlySet<string>,
): Promise<KnowledgeSystemMoveLinks[]> {
  const moved = new Map(files.map((file) => [file.from, file.to]));
  const resolveAfter = projectedKnowledgeLinks(
    app.vault.getFiles().map((file) => file.path),
    moved,
  );
  const result: KnowledgeSystemMoveLinks[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) {
      if (moved.has(file.path)) throw new Error(`笔记链接索引尚未就绪，请稍后再确认：${file.path}`);
      continue;
    }
    const nextSource = !relocatedSources || relocatedSources.has(file.path)
      ? moved.get(file.path) ?? file.path : file.path;
    const body: Array<ReferenceCache & { position: ReferenceCache["position"] }> = [
      ...(cache.links ?? []),
      ...(cache.embeds ?? []),
    ];
    const change = (ref: { original: string; link: string }) =>
      renamedReference(app, ref.original, ref.link, file.path, nextSource, moved, resolveAfter, subpath);
    const bodyChanges = body
      .map((ref) => ({ ref, after: change(ref) }))
      .filter((item) => item.after && item.after !== item.ref.original);
    const propertyChanges = (cache.frontmatterLinks ?? [])
      .map((ref) => ({ ref, after: change(ref) }))
      .filter((item) => item.after && item.after !== item.ref.original);
    if (!bodyChanges.length && !propertyChanges.length) continue;
    const edits: Edit[] = [];
    const before = await app.vault.read(file);
    for (const { ref, after } of bodyChanges) {
      const { start, end } = ref.position;
      if (before.slice(start.offset, end.offset) !== ref.original)
        throw new Error(`链接索引已变化，请刷新提案：${file.path}`);
      edits.push({ start: start.offset, end: end.offset, after: after! });
    }
    if (propertyChanges.length) {
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(before);
      if (!match) throw new Error(`笔记属性已变化，请刷新提案：${file.path}`);
      const offset = match[0].indexOf(match[1]);
      const yaml = parseDocument(match[1]);
      if (yaml.errors.length) throw new Error(`笔记属性无法读取，原文保留：${file.path}`);
      visit(yaml, (_key, node) => {
        if (!isScalar(node) || typeof node.value !== "string" || !node.range) return;
        let value = node.value;
        for (const { ref, after } of propertyChanges) {
          if (!value.includes(ref.original)) continue;
          if (after) value = value.split(ref.original).join(after);
        }
        if (value === node.value) return;
        const after =
          node.type === "QUOTE_SINGLE"
            ? "'" + value.replace(/'/gu, "''") + "'"
            : JSON.stringify(value);
        edits.push({ start: offset + node.range[0], end: offset + node.range[1], after });
      });
    }
    let after = before;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
    if (after !== before) result.push({ sourcePath: file.path, path: nextSource, before, after });
  }
  return result;
}

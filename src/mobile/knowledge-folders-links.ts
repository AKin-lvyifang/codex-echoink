import type { App, ReferenceCache } from "obsidian";
import { rebaseKnowledgePath } from "../knowledge-base/root-paths-core";
import { within, parentPath, type FolderInventory } from "./knowledge-folders-io";

interface LinkSpan { start: number; end: number; original: string; replacement: string; target: string }
export interface FolderLinkChange { path: string; nextPath: string; before: string; after: string; spans: LinkSpan[] }
const decode = (text: string): string => { try { return decodeURIComponent(text); } catch { return text; } };
function normalized(path: string): string | null {
  const result: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") { if (!result.length) return null; result.pop(); }
    else if (part && part !== ".") result.push(part);
  }
  return result.join("/");
}
function relative(from: string, to: string): string {
  const source = from.split("/").filter(Boolean), target = to.split("/");
  while (source.length && target.length && source[0] === target[0]) { source.shift(); target.shift(); }
  return [...source.map(() => ".."), ...target].join("/");
}
function destination(original: string): { start: number; end: number; wiki: boolean } | null {
  const wiki = /^!?\[\[/u.exec(original);
  if (wiki) { const end = original.search(/[|\]]/u); return end >= wiki[0].length ? { start: wiki[0].length, end, wiki: true } : null; }
  const prefix = /^!?\[[\s\S]*?\]\(\s*/u.exec(original);
  if (!prefix) return null;
  let start = prefix[0].length;
  if (original[start] === "<") { const end = original.indexOf(">", ++start); return end >= start ? { start, end, wiki: false } : null; }
  let depth = 0;
  for (let end = start; end < original.length; end++) {
    const character = original[end];
    if (character === "\\") { end++; continue; }
    if (character === "(") depth++;
    if (character === ")") { if (!depth) return { start, end, wiki: false }; depth--; }
    if (/\s/u.test(character) && !depth) return { start, end, wiki: false };
  }
  return null;
}
function resolve(app: App, raw: string, source: string, paths: readonly string[]): string | null {
  const path = decode(raw.replace(/\\([\\()[\] ])/gu, "$1"));
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(path)) return null;
  const file = app.metadataCache.getFirstLinkpathDest?.(path, source);
  if (file && paths.includes(file.path)) return file.path;
  const rooted = normalized(path), local = normalized(`${parentPath(source)}/${path}`);
  const choices = path.startsWith("/") ? [rooted] : /^\.\.?\//u.test(path) ? [local] : [rooted, local];
  const found = [...new Set(choices.flatMap(candidate => candidate ? paths.filter(item => item === candidate || item === `${candidate}.md`) : []))];
  return found.length === 1 ? found[0] : null;
}
/** Only metadata-confirmed links are read or rewritten; prose is never searched. */
export async function captureMoveLinks(app: App, inventory: FolderInventory, from: string, to: string): Promise<FolderLinkChange[]> {
  const paths = [...inventory.directories, ...inventory.files.map(file => file.path)], result: FolderLinkChange[] = [];
  for (const source of app.vault.getMarkdownFiles()) {
    if (!paths.includes(source.path)) continue;
    const cache = app.metadataCache.getFileCache(source);
    if (!cache) throw new Error(`内部链接索引尚未就绪，请稍后重新预览：${source.path}`);
    const refs: ReferenceCache[] = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    const spans: LinkSpan[] = [];
    for (const ref of refs) {
      const span = destination(ref.original);
      if (!span) continue;
      const raw = ref.original.slice(span.start, span.end), fragment = raw.indexOf("#"), path = fragment < 0 ? raw : raw.slice(0, fragment);
      const target = resolve(app, path, source.path, paths);
      if (!target || (!within(target, from) && !(within(source.path, from) && /^\.\.?\//u.test(path)))) continue;
      const moved = rebaseKnowledgePath(target, from, to), nextSource = rebaseKnowledgePath(source.path, from, to);
      let replacement = /^\.\.?\//u.test(path) ? relative(parentPath(nextSource), moved) : path.startsWith("/") ? `/${moved}` : moved;
      if (!/\.md$/iu.test(path) && /\.md$/iu.test(moved)) replacement = replacement.slice(0, -3);
      if (path.startsWith("./") && !replacement.startsWith(".")) replacement = `./${replacement}`;
      if (path.endsWith("/")) replacement += "/";
      if (!span.wiki || /%[\da-f]{2}/iu.test(path)) replacement = encodeURI(replacement).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
      spans.push({ start: ref.position.start.offset + span.start, end: ref.position.start.offset + span.start + path.length,
        original: path, replacement, target: moved });
    }
    if (!spans.length) continue;
    const before = await app.vault.read(source);
    spans.sort((a, b) => a.start - b.start);
    if (spans.some((span, index) => before.slice(span.start, span.end) !== span.original || index > 0 && spans[index - 1].end > span.start)) throw new Error(`内部链接索引已变化，请重新预览：${source.path}`);
    let after = before;
    for (const span of [...spans].reverse()) after = after.slice(0, span.start) + span.replacement + after.slice(span.end);
    result.push({ path: source.path, nextPath: rebaseKnowledgePath(source.path, from, to), before, after, spans });
  }
  return result;
}
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Native rename can choose shorter link spelling. Accept only equivalent targets. */
export async function finishMoveLinks(app: App, changes: readonly FolderLinkChange[], current: FolderInventory, guard: () => void): Promise<void> {
  const paths = [...current.directories, ...current.files.map(file => file.path)];
  for (const change of changes) {
    const file = app.vault.getFileByPath?.(change.nextPath) ?? app.vault.getMarkdownFiles().find(candidate => candidate.path === change.nextPath);
    if (!file) throw new Error(`内部链接文件位置未确认：${change.nextPath}`);
    const observed = await app.vault.read(file);
    if (observed === change.after) continue;
    let pattern = "^", cursor = 0;
    for (const span of change.spans) { pattern += escaped(change.before.slice(cursor, span.start)) + "([^\\r\\n]*?)"; cursor = span.end; }
    const match = new RegExp(pattern + escaped(change.before.slice(cursor)) + "$", "u").exec(observed);
    if (!match || change.spans.some((span, index) => match[index + 1] !== span.original && resolve(app, match[index + 1], change.nextPath, paths) !== span.target)) {
      throw new Error(`目录移动期间链接或正文出现其他变化，保留当前内容：${change.nextPath}`);
    }
    guard();
    await app.vault.process(file, latest => {
      guard(); if (latest !== observed) throw new Error(`链接文件已变化：${change.nextPath}`);
      return change.after;
    });
    if (await app.vault.read(file) !== change.after) throw new Error(`内部链接保存回读未确认：${change.nextPath}`);
  }
}

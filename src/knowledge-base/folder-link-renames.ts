import { getDesktopPath } from "../platform/desktop-paths";
import { type App, type ReferenceCache, type TFile } from "obsidian";
import { rebaseKnowledgePath } from "./root-paths";

const path = getDesktopPath();

interface LinkEdit { original: string; replacement: string; start: number; end: number }
export interface FolderLinkRenamePlan { path: string; content: string; edits: LinkEdit[]; replacementCounts: Record<string, number> }

function references(app: App, file: TFile): ReferenceCache[] {
  const cache = app.metadataCache.getFileCache(file);
  return [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
}

/** Locate only the destination of a metadata-confirmed link; keep its label/title intact. */
function destination(original: string): { start: number; end: number; wiki: boolean } | null {
  const wiki = /^!?\[\[/u.exec(original);
  if (wiki) {
    const end = original.search(/[|\]]/u);
    return end >= wiki[0].length ? { start: wiki[0].length, end, wiki: true } : null;
  }
  const prefix = /^!?\[[\s\S]*?\]\(\s*/u.exec(original);
  if (!prefix) return null;
  let start = prefix[0].length;
  if (original[start] === "<") {
    const end = original.indexOf(">", ++start);
    return end >= start ? { start, end, wiki: false } : null;
  }
  let depth = 0;
  for (let end = start; end < original.length; end++) {
    const char = original[end];
    if (char === "\\") { end++; continue; }
    if (char === "(") depth++;
    if (char === ")") { if (!depth) return { start, end, wiki: false }; depth--; }
    if (/\s/u.test(char) && !depth) return { start, end, wiki: false };
  }
  return null;
}

function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function absoluteVaultLink(app: App, rawPath: string): { relative: string; base: string; url?: URL } | null {
  const adapter = app.vault.adapter as { getBasePath?(): string } | undefined;
  const basePath = adapter?.getBasePath?.();
  if (!basePath) return null;
  const base = path.posix.normalize(basePath.replace(/\\/gu, "/")).replace(/\/$/u, "");
  let target = decoded(rawPath).replace(/\\/gu, "/");
  let url: URL | undefined;
  if (/^file:\/\//iu.test(rawPath)) {
    try {
      url = new URL(rawPath);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search) return null;
      target = decoded(url.pathname);
      if (/^[a-z]:\//iu.test(base) && /^\/[a-z]:\//iu.test(target)) target = target.slice(1);
    } catch { return null; }
  }
  target = path.posix.normalize(target);
  if (!target.startsWith(`${base}/`)) return null;
  return { relative: target.slice(base.length + 1).replace(/\/$/u, ""), base, ...(url ? { url } : {}) };
}

function replacement(app: App, original: string, source: string, from: string, to: string): string | null {
  const span = destination(original);
  if (!span) return null;
  const raw = original.slice(span.start, span.end);
  const hash = raw.indexOf("#");
  const rawPath = hash < 0 ? raw : raw.slice(0, hash);
  const suffix = hash < 0 ? "" : raw.slice(hash);
  const unescapedPath = rawPath.replace(/\\([\\()[\] ])/gu, "$1");
  const linkPath = decoded(unescapedPath);
  const absolute = absoluteVaultLink(app, unescapedPath);
  if (!linkPath || (!absolute && /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(linkPath))) return null;
  // Resolved file links belong to Obsidian's renameFile implementation.
  if (app.metadataCache.getFirstLinkpathDest?.(linkPath, source)) return null;
  const rooted = linkPath.startsWith("/");
  const explicitRelative = /^\.\.?\//u.test(linkPath);
  const clean = (value: string) => path.posix.normalize(value).replace(/^\/+|\/$/gu, "");
  const rootPath = clean(linkPath);
  const relativePath = clean(path.posix.join(path.posix.dirname(source), linkPath));
  const candidates = absolute ? [absolute.relative] : rooted ? [rootPath] : explicitRelative ? [relativePath] : [...new Set([rootPath, relativePath])];
  const existing = candidates.filter((value) => app.vault.getAbstractFileByPath(value));
  if (existing.length !== 1) return null; // Ambiguous or already broken links stay untouched.
  const target = existing[0];
  const newTarget = rebaseKnowledgePath(target, from, to);
  const newSource = rebaseKnowledgePath(source, from, to);
  const relative = !absolute && (explicitRelative || (!rooted && target === relativePath && relativePath !== rootPath));
  if (target === newTarget && (!relative || source === newSource)) return null;
  let next = relative ? path.posix.relative(path.posix.dirname(newSource), newTarget) || "." : newTarget;
  if (absolute) next = `${absolute.base}/${next}`;
  else if (rooted) next = `/${next}`;
  if (rawPath.startsWith("./") && !next.startsWith(".")) next = `./${next}`;
  if (linkPath.endsWith("/") && !next.endsWith("/")) next += "/";
  // Wiki links accept spaces; Markdown destinations must retain valid encoding.
  if (absolute?.url) { absolute.url.pathname = next; next = absolute.url.href; }
  else if (!span.wiki || /%[\da-f]{2}/iu.test(rawPath)) next = encodeURI(next).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
  return original.slice(0, span.start) + next + suffix + original.slice(span.end);
}

/** Snapshot only real targets before moving; no substring/basename guesses or body scans. */
export async function captureFolderLinkRenames(app: App, from: string, to: string): Promise<FolderLinkRenamePlan[]> {
  if (!app.vault.getAbstractFileByPath(from)) return [];
  const plans: FolderLinkRenamePlan[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const edits: LinkEdit[] = [];
      const refs = references(app, file);
      for (const ref of refs) {
        const next = replacement(app, ref.original, file.path, from, to);
        if (next && next !== ref.original) edits.push({ original: ref.original, replacement: next, start: ref.position.start.offset, end: ref.position.end.offset });
      }
      if (!edits.length) break;
      const content = await app.vault.read(file);
      if (edits.some((edit) => content.slice(edit.start, edit.end) !== edit.original)) {
        if (attempt === 19) throw new Error(`目录引用索引尚未就绪：${file.path}，请稍后重试`);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        continue;
      }
      const replacementCounts = Object.fromEntries(edits.map((edit) => [edit.replacement, refs.filter((ref) => ref.original === edit.replacement).length]));
      plans.push({ path: rebaseKnowledgePath(file.path, from, to), content, edits, replacementCounts });
      break;
    }
  }
  return plans;
}

/** Native rename may update other links first, shifting offsets. Refresh only when needed. */
export async function applyFolderLinkRenames(app: App, plans: readonly FolderLinkRenamePlan[]): Promise<void> {
  for (const plan of plans) {
    let applied = false;
    for (let attempt = 0; attempt < 20 && !applied; attempt++) {
      const file = app.vault.getFileByPath(plan.path);
      if (!file) throw new Error(`目录引用来源已变化：${plan.path}`);
      const content = await app.vault.read(file);
      let edits = plan.edits;
      if (content !== plan.content) {
        const refs = references(app, file);
        edits = [];
        let valid = refs.every((ref) => content.slice(ref.position.start.offset, ref.position.end.offset) === ref.original);
        for (const original of new Set(plan.edits.map((edit) => edit.original))) {
          const expected = plan.edits.filter((edit) => edit.original === original);
          const current = refs.filter((ref) => ref.original === original || ref.original === expected[0].replacement);
          if (current.length !== expected.length + plan.replacementCounts[expected[0].replacement]) { valid = false; break; }
          for (const ref of current) if (ref.original === original) edits.push({ ...expected[0], start: ref.position.start.offset, end: ref.position.end.offset });
        }
        if (!valid) { await new Promise((resolve) => window.setTimeout(resolve, 50)); continue; }
      }
      await app.vault.process(file, (latest) => {
        if (latest !== content) return latest; // Retry from current content, never overwrite a concurrent edit.
        applied = true;
        let next = latest;
        for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
          if (next.slice(edit.start, edit.end) !== edit.original) throw new Error(`目录引用内容已变化：${plan.path}`);
          next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
        }
        return next;
      });
      if (applied && edits.length) {
        // A parent rename can immediately follow this child rename. Do not let
        // that next capture use the old child destinations still in the cache.
        let indexed = false;
        for (let retry = 0; retry < 20 && !indexed; retry++) {
          const latest = await app.vault.read(file);
          const refs = references(app, file);
          indexed = refs.every((ref) => latest.slice(ref.position.start.offset, ref.position.end.offset) === ref.original)
            && [...new Set(edits.map((edit) => edit.replacement))].every((replacement) =>
              refs.filter((ref) => ref.original === replacement).length >= edits.filter((edit) => edit.replacement === replacement).length);
          if (!indexed) await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        if (!indexed) throw new Error(`目录引用已更新，索引尚未就绪：${plan.path}，请稍后重试`);
      }
    }
    if (!applied) throw new Error(`目录引用索引或内容仍在变化：${plan.path}，链接同步未完成`);
  }
}

import { getDesktopCrypto } from "../platform/desktop-crypto";
import { getDesktopPath } from "../platform/desktop-paths";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { diffChars } from "diff";
import { knowledgeBodyLinkSpans, knowledgeBodyMask } from "./knowledge-relations";
import type { KnowledgeLinkingDocument, KnowledgeLinkingMention, KnowledgeLinkingPatchResult, KnowledgeLinkingProposal, KnowledgeLinkingTarget } from "./knowledge-linking-types";

const { createHash } = getDesktopCrypto();

const path = getDesktopPath();

interface FrontmatterRange { start: number; end: number; close: number; closed: boolean }

function frontmatterRange(content: string): FrontmatterRange | null {
  const bom = content.startsWith("\uFEFF") ? 1 : 0;
  const opening = content.slice(bom).match(/^---[ \t]*(?:\r\n|\n|\r)/u);
  if (!opening) return null;
  const start = bom + opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gmu;
  closing.lastIndex = start;
  const match = closing.exec(content);
  return match ? { start, close: match.index, end: match.index + match[0].length, closed: true }
    : { start, close: content.length, end: content.length, closed: false };
}

function parseFrontmatter(content: string) {
  const range = frontmatterRange(content);
  if (!range) return null;
  if (!range.closed) throw new Error("Frontmatter is not closed.");
  const source = content.slice(range.start, range.close);
  const document = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || (document.contents && !isMap(document.contents))) throw new Error("Frontmatter is not an unambiguous YAML mapping.");
  const pair = isMap(document.contents) ? document.contents.items.find((item) => isScalar(item.key) && item.key.value === "aliases") : undefined;
  const node = pair?.value;
  let aliases: string[] = [];
  if (node) {
    if (isScalar(node) && (node.value === null || typeof node.value === "string")) aliases = node.value ? [node.value] : [];
    else if (isSeq(node) && node.items.every((item) => isScalar(item) && typeof item.value === "string" && !item.anchor && !item.tag)) aliases = node.items.map((item) => String((item as { value: string }).value));
    else throw new Error("aliases must be a string or a list of strings.");
    if ((isScalar(node) || isSeq(node)) && (node.anchor || node.tag)) throw new Error("Anchored or tagged aliases cannot be expanded safely.");
  }
  return { range, source, document, pair, node, aliases: [...new Set(aliases.filter((alias) => alias.trim()))] };
}

export function readKnowledgeLinkingDocument(documentPath: string, content: string, version: string): KnowledgeLinkingDocument {
  let aliases: string[] = [];
  try { aliases = parseFrontmatter(content)?.aliases ?? []; } catch { /* Reading remains possible; an aliases edit will reject malformed YAML. */ }
  const body = knowledgeBodyMask(content, false);
  const heading = body.match(/^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?\r?$/mu)?.[1]?.trim();
  return { path: documentPath, content, version, title: heading || path.posix.basename(documentPath, path.posix.extname(documentPath)), aliases };
}

function safeTargetPath(value: string): boolean {
  return typeof value === "string" && !!value && !hasControlCharacters(value) && !/[\\|[\]#^]/u.test(value)
    && !path.posix.isAbsolute(value) && !/^[a-z][a-z\d+.-]*:/iu.test(value)
    && !value.split("/").some((part) => !part || part === "." || part === "..") && /\.(?:md|markdown)$/iu.test(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** The caller supplies only authorized Wiki/Projects documents, including valid batch targets. */
export function buildKnowledgeLinkingTargets(documents: readonly KnowledgeLinkingDocument[]): KnowledgeLinkingTarget[] {
  const targets = new Map<string, KnowledgeLinkingTarget>();
  for (const document of documents) {
    if (!safeTargetPath(document.path)) continue;
    targets.set(document.path, { path: document.path, title: document.title, aliases: [...new Set(document.aliases)] });
  }
  return [...targets.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function targetNames(target: KnowledgeLinkingTarget): string[] {
  return [...new Set([target.title, path.posix.basename(target.path, path.posix.extname(target.path)), ...target.aliases].filter((name) => typeof name === "string" && !!name.trim() && !/[\r\n]/u.test(name)))];
}

function resolveTarget(raw: string, sourcePath: string, targets: readonly KnowledgeLinkingTarget[]): string[] {
  let value = raw.trim().replace(/\\([ ()])/gu, "$1");
  try { value = decodeURIComponent(value); } catch { /* Literal percent characters remain literal. */ }
  value = value.split("#")[0];
  if (!value) return [sourcePath];
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value)) return [];
  const valid = targets.filter((target) => safeTargetPath(target.path));
  const withoutExtension = (text: string) => text.replace(/\.(?:md|markdown)$/iu, "");
  const exact = valid.filter((target) => withoutExtension(target.path) === withoutExtension(value.replace(/^\//u, "")));
  if (exact.length) return exact.map((target) => target.path);
  if (value.includes("/")) {
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), value));
    return valid.filter((target) => withoutExtension(target.path) === withoutExtension(relative)).map((target) => target.path);
  }
  const name = withoutExtension(value).toLowerCase();
  return [...new Set(valid.filter((target) => targetNames(target).some((candidate) => candidate.toLowerCase() === name)).map((target) => target.path))];
}

/** Every lexical candidate is retained: semantic selection (including user agent) belongs to AI. */
export function scanKnowledgeLinkingMentions(document: KnowledgeLinkingDocument, targets: readonly KnowledgeLinkingTarget[]): KnowledgeLinkingMention[] {
  const mask = knowledgeBodyMask(document.content);
  const linked = new Set(knowledgeBodyLinkSpans(document.content).flatMap((span) => {
    const resolved = resolveTarget(span.target, document.path, targets);
    return resolved.length === 1 ? resolved : [];
  }));
  const names = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.path === document.path || linked.has(target.path) || !safeTargetPath(target.path)) continue;
    for (const name of targetNames(target)) {
      const paths = names.get(name) ?? new Set<string>(); paths.add(target.path); names.set(name, paths);
    }
  }
  const mentions = new Map<string, KnowledgeLinkingMention>();
  for (const [name, targetPaths] of names) {
    const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
    for (const match of mask.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if ((/^[A-Za-z\d_]/u.test(name) && /[A-Za-z\d_]/u.test(mask[start - 1] ?? ""))
        || (/[A-Za-z\d_]$/u.test(name) && /[A-Za-z\d_]/u.test(mask[end] ?? ""))) continue;
      const text = document.content.slice(start, end);
      if (text.toLowerCase() !== match[0].toLowerCase()) continue;
      for (const targetPath of targetPaths) mentions.set(`${start}:${end}:${targetPath}`, { start, end, text, targetPath });
    }
  }
  return [...mentions.values()].sort((a, b) => a.start - b.start || b.end - a.end || a.targetPath.localeCompare(b.targetPath));
}

function appendAliases(content: string, proposed: readonly string[]): { content: string; added: string[] } {
  if (proposed.some((value) => typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value) || value.includes("\0"))) throw new Error("Proposed aliases must be nonempty single-line strings.");
  const parsed = parseFrontmatter(content);
  const existing = new Set(parsed?.aliases ?? []);
  const added = [...new Set(proposed.map((value) => value.trim()))].filter((value) => !existing.has(value));
  if (!added.length) return { content, added };
  const newline = content.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const encoded = added.map((value) => JSON.stringify(value));
  if (!parsed) {
    const bom = content.startsWith("\uFEFF") ? 1 : 0;
    return { content: content.slice(0, bom) + `---${newline}aliases: [${encoded.join(", ")}]${newline}---${newline}` + content.slice(bom), added };
  }
  const { range, source, node, pair } = parsed;
  let updated: string;
  if (!pair) {
    const prefix = source && !/[\r\n]$/u.test(source) ? newline : "";
    updated = source + `${prefix}aliases: [${encoded.join(", ")}]${newline}`;
  } else if (isSeq(node) && node.range) {
    if (node.flow) {
      const close = node.range[1] - 1;
      if (source[close] !== "]") throw new Error("aliases flow sequence has no safe closing range.");
      const last = node.items.at(-1);
      const lastEnd = last && isScalar(last) ? last.range?.[1] : undefined;
      const tail = lastEnd === undefined ? "" : source.slice(lastEnd, close).replace(/#[^\r\n]*/gu, "");
      const comma = lastEnd !== undefined && !tail.includes(",");
      const separator = /[\r\n]/u.test(source.slice(node.range[0], close)) ? newline + "  " : (node.items.length ? " " : "");
      updated = source.slice(0, close) + separator + encoded.join(", ") + source.slice(close);
      if (comma) updated = updated.slice(0, lastEnd) + "," + updated.slice(lastEnd);
    } else {
      const end = node.range[1];
      const lineStart = Math.max(source.lastIndexOf("\n", node.range[0] - 1), source.lastIndexOf("\r", node.range[0] - 1)) + 1;
      const indent = source.slice(lineStart, node.range[0]);
      if (!/^ *$/u.test(indent) || source[node.range[0]] !== "-") throw new Error("aliases block sequence has no safe insertion range.");
      const prefix = end && !/[\r\n]/u.test(source[end - 1]) ? newline : "";
      updated = source.slice(0, end) + prefix + encoded.map((value) => `${indent}- ${value}${newline}`).join("") + source.slice(end);
    }
  } else if (isScalar(node) && node.range) {
    const [start, end] = node.range;
    const raw = source.slice(start, end);
    const block = node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL";
    const values = parsed.aliases.map((value) => JSON.stringify(value));
    // Preserve a simple scalar's spelling and its trailing comment verbatim.
    const first = !block && node.value !== null ? raw : values.join(", ");
    const replacement = `[${[first, ...encoded].filter(Boolean).join(", ")}]` + (/[\r\n]$/u.test(raw) ? newline : source[end] === "#" ? " " : "");
    updated = source.slice(0, start) + replacement + source.slice(end);
  } else throw new Error("aliases has no safe source range.");
  const result = content.slice(0, range.start) + updated + content.slice(range.close);
  const verified = parseFrontmatter(result);
  if (!verified || verified.aliases.length !== existing.size + added.length || [...existing, ...added].some((value) => !verified.aliases.includes(value))) throw new Error("aliases expansion could not be verified.");
  return { content: result, added };
}

export function buildKnowledgeLinkingPatch(document: KnowledgeLinkingDocument, proposal: KnowledgeLinkingProposal, targets: readonly KnowledgeLinkingTarget[], options: { allowAliases: boolean }): KnowledgeLinkingPatchResult {
  const reject = (reason: string, mention?: KnowledgeLinkingMention): KnowledgeLinkingPatchResult => ({ patch: null, rejected: [{ path: document.path, reason, ...(mention ? { mention } : {}) }] });
  if (!safeTargetPath(document.path)) return reject("The source is not a safe Markdown path.");
  if (proposal.path !== document.path || proposal.version !== document.version || document.version !== `sha256:${createHash("sha256").update(document.content, "utf8").digest("hex")}`) return reject("The source version changed or the proposal does not address the full original document.");
  if (!Array.isArray(proposal.mentions) || (proposal.aliases !== undefined && !Array.isArray(proposal.aliases))) return reject("Invalid linking proposal.");
  if (proposal.mentions.some((mention) => !mention || typeof mention !== "object" || typeof mention.text !== "string" || typeof mention.targetPath !== "string")) return reject("Invalid mention proposal.");
  if (!options.allowAliases && proposal.aliases?.length) return reject("Automatic linking cannot edit frontmatter.");
  const candidates = new Set(scanKnowledgeLinkingMentions(document, targets).map((mention) => JSON.stringify(mention)));
  const mentions = [...proposal.mentions].sort((a, b) => a.start - b.start || a.end - b.end);
  const usedTargets = new Set<string>();
  let previousEnd = -1;
  for (const mention of mentions) {
    if (!Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end) || mention.start < 0 || mention.end > document.content.length || mention.start >= mention.end
      || document.content.slice(mention.start, mention.end) !== mention.text || /[\r\n|[\]]/u.test(mention.text)
      || !candidates.has(JSON.stringify({ start: mention.start, end: mention.end, text: mention.text, targetPath: mention.targetPath }))) return reject("A mention does not match an authorized plain-text span in the original.", mention);
    if (mention.start < previousEnd || usedTargets.has(mention.targetPath)) return reject("Overlapping mentions or multiple links to the same target are not allowed.", mention);
    usedTargets.add(mention.targetPath); previousEnd = mention.end;
  }
  let after = "", offset = 0;
  const inserted: { start: number; end: number; text: string }[] = [];
  for (const mention of mentions) {
    const unchanged = document.content.slice(offset, mention.start);
    after += unchanged;
    const start = after.length;
    after += `[[${mention.targetPath}|${mention.text}]]`;
    inserted.push({ start, end: after.length, text: mention.text }); offset = mention.end;
  }
  after += document.content.slice(offset);
  let restored = after;
  for (const span of inserted.reverse()) restored = restored.slice(0, span.start) + span.text + restored.slice(span.end);
  if (!Buffer.from(restored, "utf8").equals(Buffer.from(document.content, "utf8"))) return reject("The body changed beyond the inserted link syntax.");
  let addedAliases: string[] = [];
  try {
    if (options.allowAliases && proposal.aliases?.length) {
      const expanded = appendAliases(after, proposal.aliases); after = expanded.content; addedAliases = expanded.added;
    }
  } catch (error) { return reject(error instanceof Error ? error.message : "Could not safely expand aliases."); }
  return { patch: after === document.content ? null : { path: document.path, before: document.content, after, mentions, addedAliases }, rejected: [] };
}

function newBodyLinks(content: string, previousContent?: string): ReturnType<typeof knowledgeBodyLinkSpans> {
  const current = knowledgeBodyLinkSpans(content);
  const old = knowledgeBodyLinkSpans(previousContent ?? "");
  if (!old.length) return current;
  const identity = (span: ReturnType<typeof knowledgeBodyLinkSpans>[number], original: string) => JSON.stringify([span.kind, span.embed, span.target.trim(), original]);
  const changes = diffChars(previousContent!, content, { timeout: 100 });
  if (!changes) throw new Error("无法可靠对齐已有链接，保留原稿，请缩小本次修改。");
  const protectedSpans = new Set<string>();
  let before = 0, after = 0;
  const currentByRange = new Map(current.map(span => [`${span.start}:${span.end}`, span]));
  for (const change of changes) {
    const length = change.value.length;
    if (!change.added && !change.removed) {
      for (const span of old) {
        if (span.start < before || span.end > before + length) continue;
        const key = `${after + span.start - before}:${after + span.end - before}`;
        const retained = currentByRange.get(key);
        if (retained && identity(span, previousContent!.slice(span.start, span.end)) === identity(retained, content.slice(retained.start, retained.end))) protectedSpans.add(key);
      }
    }
    if (!change.added) before += length;
    if (!change.removed) after += length;
  }
  return current.filter(span => !protectedSpans.has(`${span.start}:${span.end}`));
}

/** First accepted non-overlapping occurrence per target; equal-span target ambiguity stays plain. */
export function selectKnowledgeLinkingMentions(accepted: readonly KnowledgeLinkingMention[]): { mentions: KnowledgeLinkingMention[]; ambiguous: KnowledgeLinkingMention[] } {
  const ordered = [...new Map(accepted.map(mention => [JSON.stringify(mention), mention])).values()].sort((a, b) => a.start - b.start || b.end - a.end || a.targetPath.localeCompare(b.targetPath));
  const mentions: KnowledgeLinkingMention[] = [], ambiguous: KnowledgeLinkingMention[] = [];
  const usedTargets = new Set<string>();
  let previousEnd = -1;
  for (let index = 0; index < ordered.length;) {
    const start = ordered[index].start;
    const group: KnowledgeLinkingMention[] = [];
    while (index < ordered.length && ordered[index].start === start) group.push(ordered[index++]);
    if (start < previousEnd) continue;
    const available = group.filter(mention => !usedTargets.has(mention.targetPath));
    if (!available.length) continue;
    const longest = available.filter(mention => mention.end === available[0].end);
    if (new Set(longest.map(mention => mention.targetPath)).size > 1) {
      ambiguous.push(...longest); previousEnd = longest[0].end; continue;
    }
    const chosen = longest[0];
    mentions.push(chosen); usedTargets.add(chosen.targetPath); previousEnd = chosen.end;
  }
  return { mentions, ambiguous };
}

/** Remove only newly authored knowledge-link syntax; the shared judge owns placement. */
export function deferKnowledgeLinkingNewLinks(content: string, sourcePath: string, knowledgeTargets: readonly KnowledgeLinkingTarget[], previousContent?: string): string {
  let result = content;
  for (const span of newBodyLinks(content, previousContent).reverse()) {
    if (span.embed || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(span.target)) continue;
    const resolved = resolveTarget(span.target, sourcePath, knowledgeTargets);
    if (resolved.length === 1 && resolved[0] !== sourcePath) result = result.slice(0, span.start) + span.text + result.slice(span.end);
  }
  return result;
}

/** Protect pre-existing link occurrences; only new invalid links are reverted to their display text. */
export function validateKnowledgeLinkingNewLinks(content: string, sourcePath: string, targets: readonly KnowledgeLinkingTarget[], previousContent?: string): { content: string; warnings: string[] } {
  const warnings: string[] = [];
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const span of newBodyLinks(content, previousContent)) {
    if (span.embed || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(span.target)) continue;
    const resolved = resolveTarget(span.target, sourcePath, targets);
    if (resolved.length === 1 && resolved[0] !== sourcePath) continue;
    warnings.push(`Link target ${span.target} is ${resolved.length > 1 ? "ambiguous" : resolved[0] === sourcePath ? "the same note" : "unavailable"}; kept the original words.`);
    replacements.push({ start: span.start, end: span.end, text: span.text });
  }
  let result = content;
  for (const replacement of replacements.reverse()) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  return { content: result, warnings };
}

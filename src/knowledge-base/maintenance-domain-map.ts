import { sha256Hex } from "../utils/sha256";
import type {
  MaintenanceDomainMapDraft,
  MaintenanceDomainMapEntry,
  MaintenanceDomainMapInput,
  MaintenanceKnowledgeType,
  MaintenanceWikiDocument
} from "./maintenance-p2-contract";

export const MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER = "<!-- echoink-domain-map:sources -->";
export const MAINTENANCE_DOMAIN_MAP_TYPES: readonly MaintenanceKnowledgeType[] = [
  "概念", "方法 / 流程", "观点 / 论断", "工具 / 产品", "案例 / 事件", "人物 / 组织", "趋势 / 主题"
];
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const identity = (value: string): string => value.normalize("NFC").toLowerCase();
const markerPrefix = "<!-- echoink-domain-map:";
const parent = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const within = (path: string, root: string): boolean => root === "" || path.startsWith(root + "/");
const join = (directory: string, name: string): string => directory ? `${directory}/${name}` : name;

function assertPath(path: string, allowRoot = false): void {
  if ((path === "" && allowRoot)) return;
  if (!path || /[\\\u0000-\u001f\u007f]/u.test(path) || path.startsWith("/") || /^[a-z]:/iu.test(path) ||
    path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`领域地图路径无效：${path}`);
  }
}

function safeDomain(domain: string): string {
  const safe = domain.normalize("NFC").replace(/[<>:"/\\|?*#\[\]\u0000-\u001f\u007f]/gu, "_").trim().replace(/^[. ]+|[. ]+$/gu, "");
  if (!safe || new TextEncoder().encode(`${safe}索引.md`).length > 240) throw new Error("领域名称不能生成安全的索引文件名。");
  return safe;
}

function markdownText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/gu, " ").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/[\\`*_[\]{}()#!|]/gu, "\\$&");
}

function relativeLink(targetPath: string, entryPath: string): string {
  const from = parent(targetPath).split("/").filter(Boolean);
  const to = entryPath.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common).map(segment => encodeURIComponent(segment))].join("/");
}

interface ManagedBlock { domain: string; start: number; end: number }

/** Parse only exact whole-line markers; refuse malformed, nested, or duplicate blocks. */
function managedBlocks(content: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  let open: { domain: string; start: number; sources: number } | undefined;
  let fence: string | undefined;
  let frontmatter = false;
  let comment = false;
  let rawTag: string | undefined;
  let offset = 0;
  for (const lineWithEol of content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const line = lineWithEol.replace(/\r?\n$/u, "");
    if (offset === 0 && /^\uFEFF?---[ \t]*$/u.test(line)) frontmatter = true;
    else if (frontmatter && /^(?:---|\.\.\.)[ \t]*$/u.test(line)) frontmatter = false;
    const fenceMatch = /^ {0,3}(?:> ?)*(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})/u.exec(line);
    const hidden = frontmatter || !!fence || comment || !!rawTag;
    if (line.includes(markerPrefix)) {
      if (hidden) throw new Error("领域地图标记位于代码、属性或 HTML 内，无法安全确定边界。");
      if (line === MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER) {
        if (!open || ++open.sources > 1) throw new Error("领域地图来源标记位于受管块之外或重复。");
      } else {
        const match = /^<!-- echoink-domain-map:(BEGIN|END) ([^\s]+) -->$/u.exec(line);
        if (!match) throw new Error("领域地图标记损坏或位置有歧义，保留原文。");
        let domain: string;
        try { domain = decodeURIComponent(match[2]); } catch { throw new Error("领域地图标记编码损坏，保留原文。"); }
        if (!domain || encodeURIComponent(domain) !== match[2]) throw new Error("领域地图标记编码不规范，保留原文。");
        if (match[1] === "BEGIN") {
          if (open || blocks.some(block => identity(block.domain) === identity(domain))) throw new Error("领域地图标记嵌套或重复，保留原文。");
          open = { domain, start: offset, sources: 0 };
        } else {
          if (!open || open.domain !== domain) throw new Error("领域地图起止标记不匹配，保留原文。");
          // EOL belongs to the original suffix, so even trailing whitespace is preserved.
          blocks.push({ ...open, end: offset + line.length });
          open = undefined;
        }
      }
    }
    if (!frontmatter) {
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length &&
          line.slice(line.indexOf(fenceMatch[1]) + fenceMatch[1].length).trim() === "") fence = undefined;
      } else if (!comment && !rawTag && fenceMatch) fence = fenceMatch[1];
      if (!fence) {
        if (rawTag && new RegExp(`</${rawTag}\\s*>`, "iu").test(line)) rawTag = undefined;
        else if (!rawTag && !comment) {
          const tag = /<(pre|script|style|textarea)(?:\s|>)/iu.exec(line)?.[1];
          if (tag && !new RegExp(`</${tag}\\s*>`, "iu").test(line)) rawTag = tag;
        }
        // Complete own marker comments do not leave this state open.
        for (const token of line.match(/<!--|-->/gu) ?? []) comment = token === "<!--";
      }
    }
    offset += lineWithEol.length;
  }
  if (open) throw new Error("领域地图结束标记缺失，保留原文。");
  if (frontmatter || fence || comment || rawTag) throw new Error("目标存在未闭合的属性、代码或 HTML 区域，无法安全追加地图。");
  return blocks;
}

function chooseTarget(
  domain: string,
  entries: readonly MaintenanceDomainMapEntry[],
  existing: readonly MaintenanceWikiDocument[],
  root: string
): string {
  const filename = `${safeDomain(domain)}索引.md`;
  const named = existing.filter(document => identity(basename(document.path)) === identity(filename));
  if (named.length > 1) throw new Error(`领域 ${domain} 有多个同名索引，需明确目标。`);
  if (named.length === 1) return named[0].path;
  const directories = entries.map(entry => parent(entry.path));
  const indexes = existing.filter(document => identity(basename(document.path)) === "index.md" && directories.length > 0 &&
    directories.every(directory => directory === parent(document.path) || within(directory, parent(document.path))));
  indexes.sort((a, b) => b.path.split("/").length - a.path.split("/").length || compare(a.path, b.path));
  if (indexes.length > 1 && indexes[0].path.split("/").length === indexes[1].path.split("/").length) {
    throw new Error(`领域 ${domain} 的目录索引不唯一，需明确目标。`);
  }
  return indexes[0]?.path ?? join(root, filename);
}

/** Plan all paths before rendering; no file operations or semantic/type inference. */
export function planMaintenanceDomainMaps(input: MaintenanceDomainMapInput): MaintenanceDomainMapDraft[] {
  const root = input.wikiRoot.replace(/\/+$/u, "");
  if (input.wikiRoot !== "" && root === "") throw new Error("领域地图路径无效：不能使用绝对根目录。");
  assertPath(root, true);
  const documents = new Map<string, MaintenanceWikiDocument>();
  const occupied = new Map<string, string>();
  for (const document of input.existing) {
    assertPath(document.path);
    if (!within(document.path, root)) continue;
    const prior = documents.get(document.path);
    if (prior && (prior.content !== document.content || prior.contentRevision !== document.contentRevision)) throw new Error(`索引快照冲突：${document.path}`);
    const samePath = occupied.get(identity(document.path));
    if (samePath && samePath !== document.path) throw new Error(`索引路径大小写或字符规范冲突：${document.path}`);
    occupied.set(identity(document.path), document.path);
    documents.set(document.path, document);
  }
  const entries = new Map<string, MaintenanceDomainMapEntry>();
  const entryPaths = new Map<string, string>();
  const domains = new Map<string, string>();
  for (const entry of input.entries) {
    assertPath(entry.path);
    if (!within(entry.path, root)) throw new Error(`领域条目不在绑定 Wiki 内：${entry.path}`);
    if (!entry.domain.trim() || entry.domain !== entry.domain.trim()) throw new Error("领域名称为空或首尾有歧义空白。");
    if (!MAINTENANCE_DOMAIN_MAP_TYPES.includes(entry.type)) throw new Error(`未知知识类型：${entry.type}`);
    const domainKey = identity(entry.domain);
    if (domains.has(domainKey) && domains.get(domainKey) !== entry.domain) throw new Error(`领域名称存在大小写或字符规范冲突：${entry.domain}`);
    domains.set(domainKey, entry.domain);
    const prior = entries.get(entry.path);
    if (prior && (prior.domain !== entry.domain || prior.type !== entry.type || prior.title !== entry.title)) throw new Error(`同一路径的地图属性冲突：${entry.path}`);
    const samePath = entryPaths.get(identity(entry.path));
    if (samePath && samePath !== entry.path) throw new Error(`地图条目路径大小写或字符规范冲突：${entry.path}`);
    entryPaths.set(identity(entry.path), entry.path);
    entries.set(entry.path, entry);
  }
  const plans = [...domains.values()].sort(compare).map(domain => {
    const domainEntries = [...entries.values()].filter(entry => entry.domain === domain);
    return { domain, entries: domainEntries, path: chooseTarget(domain, domainEntries, [...documents.values()], root) };
  });
  const targets = new Map<string, typeof plans>();
  for (const plan of plans) {
    const key = identity(plan.path);
    const group = targets.get(key);
    // A real shared index can own several independently managed domain blocks.
    // An absent fallback with two lossy filename encodings is still ambiguous.
    if (group && !documents.has(plan.path)) throw new Error(`多个领域选中同一地图路径且没有共享索引：${plan.path}`);
    if (group) group.push(plan);
    else targets.set(key, [plan]);
  }
  const knownMaps = new Set([...documents.values()].filter(document => document.content.includes(markerPrefix)).map(document => document.path));
  return [...targets.values()].map((group): MaintenanceDomainMapDraft => {
    const path = group[0].path;
    const document = documents.get(path);
    const before = document?.content ?? "";
    const blocks = managedBlocks(before);
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const updates = group.map(plan => {
      const own = blocks.find(block => identity(block.domain) === identity(plan.domain));
      if (own && own.domain !== plan.domain) throw new Error(`领域地图名称存在字符规范或大小写歧义：${path}`);
      return { plan, own };
    });
    const appended = updates.filter(update => !update.own);
    const replaced = updates.filter(update => update.own).sort((a, b) => a.own!.start - b.own!.start);
    // One page draft gets one provenance insertion, inside the last updated block
    // in actual document order. Existing provenance in updated blocks is replaced.
    const sourcesOwner = appended.at(-1) ?? replaced.at(-1)!;
    const render = (update: typeof updates[number]): string => {
      const { plan } = update;
      const token = encodeURIComponent(plan.domain);
      const lines = [`<!-- echoink-domain-map:BEGIN ${token} -->`, `## ${markdownText(plan.domain)}领域地图`, ""];
      for (const type of MAINTENANCE_DOMAIN_MAP_TYPES) {
        const items = plan.entries.filter(entry => entry.type === type && !targets.has(identity(entry.path)) && !knownMaps.has(entry.path))
          .sort((a, b) => compare(a.path, b.path));
        if (items.length) lines.push(`### ${type}`, ...items.map(entry => `- [${markdownText(entry.title)}](<${relativeLink(path, entry.path)}>)`), "");
      }
      if (update === sourcesOwner) lines.push(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER);
      lines.push(`<!-- echoink-domain-map:END ${token} -->`);
      return lines.join(eol);
    };
    let content = before;
    for (const update of [...replaced].reverse()) {
      content = content.slice(0, update.own!.start) + render(update) + content.slice(update.own!.end);
    }
    for (const update of appended) {
      content += (content ? (content.endsWith("\n\n") || content.endsWith("\r\n\r\n") ? "" : content.endsWith("\n") ? eol : eol + eol) : "") + render(update) + eol;
    }
    if (content.split(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER).length !== 2) {
      throw new Error(`其他领域仍有未完成的来源占位符，需一并更新其受管块：${path}`);
    }
    return {
      targetPath: path,
      domain: group[0].domain,
      ...(group.length > 1 ? { domains: group.map(plan => plan.domain) } : {}),
      content,
      expectedTarget: document ? { kind: "file", contentRevision: `sha256:${sha256Hex(before)}` } : { kind: "missing" }
    };
  });
}

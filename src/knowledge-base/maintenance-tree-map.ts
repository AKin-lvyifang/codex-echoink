import { readMaintenanceDomainBlocks } from "./maintenance-domain-map";
import { assertKnowledgeGapTitle } from "./knowledge-system-analysis";
import {
  patchKnowledgeProperties,
  readMaintenanceFrontmatterProperty,
} from "./maintenance-source-frontmatter";
import type {
  MaintenanceDomainMapEntry,
  MaintenanceMapBlockPatch,
  MaintenanceTreeJob,
  MaintenanceTreePlan,
} from "./maintenance-p2-contract";

interface Line {
  text: string;
  start: number;
  end: number;
}
export function domainMapBlock(content: string, domain: string): string | null {
  const block = readMaintenanceDomainBlocks(content).find((block) => block.domain === domain);
  return block ? content.slice(block.start, block.end) : null;
}
export function applyDomainMapBlockPatches(
  content: string,
  patches: readonly MaintenanceMapBlockPatch[],
): string {
  let result = content;
  for (const patch of patches) {
    const block = readMaintenanceDomainBlocks(result).find(
      (block) => block.domain === patch.domain,
    );
    if (patch.before === null) {
      if (block) throw new Error(`领域区块已出现，不能覆盖：${patch.domain}`);
      const eol = result.includes("\r\n") ? "\r\n" : "\n";
      result +=
        (result.endsWith(eol + eol) || !result ? "" : result.endsWith(eol) ? eol : eol + eol) +
        patch.after +
        eol;
    } else {
      if (!block || result.slice(block.start, block.end) !== patch.before)
        throw new Error(`领域区块并发冲突，保留手写内容：${patch.domain}`);
      result = result.slice(0, block.start) + patch.after + result.slice(block.end);
    }
  }
  return result;
}
function lines(content: string): Line[] {
  let cursor = 0,
    fence = "";
  const chunks: string[] = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  return chunks.map((value: string): Line => {
    const text = value.replace(/\r?\n$/u, ""),
      marker = /^ {0,3}(`{3,}|~{3,})/u.exec(text)?.[1];
    const hidden = !!fence || !!marker;
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    }
    const row = { text: hidden ? "" : text, start: cursor, end: cursor + value.length };
    cursor += value.length;
    return row;
  });
}
function section(
  content: string,
  title: string,
): { start: number; body: number; end: number } | null {
  const rows = lines(content),
    heads = rows.filter((row) => /^###\s+/u.test(row.text));
  const found = heads.filter((row) => row.text.replace(/^###\s+/u, "").trim() === title);
  if (found.length > 1) throw new Error(`知识树分支名称重复：${title}`);
  if (!found.length) return null;
  const current = found[0],
    endMarker = content.lastIndexOf("<!-- echoink-domain-map:END");
  return {
    start: current.start,
    body: current.end,
    end: heads.find((row) => row.start > current.start)?.start ?? endMarker,
  };
}
function linkTarget(text: string): string | undefined {
  return /\[\[([^\]|#]+)(?:[^\]]*)\]\]/u.exec(text)?.[1] ?? /\]\(<?([^)>]+)>?\)/u.exec(text)?.[1];
}
function resolve(
  raw: string,
  mapPath: string,
  entries: readonly MaintenanceDomainMapEntry[],
): string | undefined {
  const value = decodeURIComponent(raw),
    md = /\.md$/iu.test(value) ? value : value + ".md";
  if (entries.some((entry) => entry.path === md)) return md;
  const parts = [...mapPath.split("/").slice(0, -1)];
  for (const part of md.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const relative = parts.join("/");
  if (entries.some((entry) => entry.path === relative)) return relative;
  const matches = entries.filter(
    (entry) => entry.path.split("/").at(-1) === md || entry.title === value,
  );
  return matches.length === 1 ? matches[0].path : undefined;
}
export function treeMapPendingCount(block: string): number {
  const range = section(block, "待归位");
  return range
    ? lines(block).filter(
        (row) =>
          row.start >= range.body &&
          row.start < range.end &&
          /^\s*-\s+/u.test(row.text) &&
          linkTarget(row.text),
      ).length
    : 0;
}
export function treeMapBranches(block: string): string[] {
  return lines(block)
    .filter((row) => /^###\s+/u.test(row.text))
    .map((row) => row.text.replace(/^###\s+/u, "").trim())
    .filter((title) => title !== "缺口" && title !== "来源");
}
export function treeMapGapTitles(block: string): string[] {
  const range = section(block, "缺口");
  return range
    ? lines(block)
        .filter(
          (row) =>
            row.start >= range.body &&
            row.start < range.end &&
            /^-\s+/u.test(row.text) &&
            !linkTarget(row.text),
        )
        .map((row) => row.text.replace(/^-\s+/u, "").trim())
    : [];
}

/** The recommendation belongs to the pending line in the user's map, not plugin state. */
export function treeMapSuggestedBranch(line: string): string | undefined {
  const value = /<!-- echoink-placement: (\{[^\r\n]*\}) -->/u.exec(line)?.[1];
  if (!value) return undefined;
  try {
    const suggestion = JSON.parse(value) as { branch?: unknown };
    return typeof suggestion.branch === "string" ? suggestion.branch : undefined;
  } catch {
    return undefined;
  }
}

export function rejectTreeMapGap(content: string, domain: string, title: string): string {
  const block = domainMapBlock(content, domain);
  if (!block) throw new Error("地图已变化，请刷新后重试。");
  const range = section(block, "缺口");
  const row = lines(block).find(
    (row) =>
      range &&
      row.start >= range.body &&
      row.start < range.end &&
      row.text.replace(/^-\s+/u, "").trim() === title,
  );
  if (!row) throw new Error("这条缺口已变化，请刷新后重试。");
  const previous = readMaintenanceFrontmatterProperty(content, "不算缺口");
  if (
    previous.error ||
    (previous.present &&
      (!Array.isArray(previous.value) || previous.value.some((value) => typeof value !== "string")))
  ) {
    throw new Error("不算缺口属性必须是文本列表，原值保留。");
  }
  const next = applyDomainMapBlockPatches(content, [
    {
      domain,
      before: block,
      after: block.slice(0, row.start) + block.slice(row.end),
    },
  ]);
  return patchKnowledgeProperties(next, {
    不算缺口: [...new Set([...((previous.value as string[]) ?? []), title])],
  });
}

export function acceptTreeMapSuggestion(
  content: string,
  domain: string,
  mapPath: string,
  entryPath: string,
  branch: string,
  entries: readonly MaintenanceDomainMapEntry[],
): string {
  const block = domainMapBlock(content, domain);
  if (!block) throw new Error("地图已变化，请刷新后重试。");
  const pending = section(block, "待归位");
  const matches = lines(block).filter(
    (row) =>
      pending &&
      row.start >= pending.body &&
      row.start < pending.end &&
      linkTarget(row.text) &&
      resolve(linkTarget(row.text)!, mapPath, entries) === entryPath,
  );
  const row = matches[0];
  const target = section(block, branch);
  if (
    matches.length !== 1 ||
    treeMapSuggestedBranch(row.text) !== branch ||
    !target ||
    ["待归位", "来源", "缺口"].includes(branch)
  ) {
    throw new Error("归位建议已变化，请刷新后重试。");
  }
  const line = block
    .slice(row.start, row.end)
    .replace(/ ?<!-- echoink-placement: \{[^\r\n]*\} -->/u, "");
  const edits = [
    { start: row.start, end: row.end, text: "" },
    { start: target.end, end: target.end, text: line },
  ].sort((a, b) => b.start - a.start);
  let next = block;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return applyDomainMapBlockPatches(content, [{ domain, before: block, after: next }]);
}

export function appendTreeMapSources(block: string, links: string): string {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const sources = section(block, "来源"),
    at = sources?.end ?? block.lastIndexOf("<!-- echoink-domain-map:END");
  if (at < 0) throw new Error("知识树领域区块缺少结束标记。");
  return block.slice(0, at) + (sources ? "" : `### 来源${eol}`) + links + eol + block.slice(at);
}

/** Only insert new links and edit gap bullet lines. Existing headings, notes and prose stay byte exact. */
export function applyTreePlacement(
  job: MaintenanceTreeJob,
  plan: MaintenanceTreePlan,
  allEntries: readonly MaintenanceDomainMapEntry[],
  declined: readonly string[] = [],
): string {
  if (!Array.isArray(plan.placements) || !Array.isArray(plan.gaps) || plan.gaps.length > 3)
    throw new Error("归位提案必须含placements和最多3个框架级缺口。");
  const allowed = new Set(job.entries.map((entry) => entry.path));
  if (
    new Set(plan.placements.map((item) => item.path)).size !== plan.placements.length ||
    plan.placements.some((item) => !allowed.has(item.path) || !item.reason?.trim())
  )
    throw new Error("归位只能处理本批条目，且须给出提案理由。");
  let content = job.block;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const known = () =>
    new Set(
      lines(content)
        .flatMap((row) => {
          const raw = linkTarget(row.text);
          return raw ? [resolve(raw, job.targetPath, allEntries)] : [];
        })
        .filter(Boolean),
    );
  const newEntries = job.entries.filter((entry) => !known().has(entry.path));
  if (newEntries.some((entry) => !plan.placements.some((item) => item.path === entry.path)))
    throw new Error("本批新条目必须归位，拿不准则放待归位。");
  for (const item of plan.placements) {
    if (known().has(item.path)) continue;
    let range = section(content, item.branch);
    if (!range && item.branch === "待归位") {
      const at =
        section(content, "缺口")?.start ?? content.lastIndexOf("<!-- echoink-domain-map:END");
      content = content.slice(0, at) + `### 待归位${eol}${eol}` + content.slice(at);
      range = section(content, item.branch);
    }
    if (!range || ["缺口", "来源"].includes(item.branch))
      throw new Error("归位目标须为已有唯一分支，或待归位。");
    if (
      item.suggestedBranch &&
      (item.branch !== "待归位" ||
        !section(content, item.suggestedBranch) ||
        ["待归位", "来源", "缺口"].includes(item.suggestedBranch))
    ) {
      throw new Error("待归位建议必须指向已有唯一分支。");
    }
    let at = range.end,
      indent = "";
    if (item.parentPath) {
      const candidates = lines(content).filter(
        (row) =>
          row.start >= range.body &&
          row.start < range.end &&
          linkTarget(row.text) &&
          resolve(linkTarget(row.text)!, job.targetPath, allEntries) === item.parentPath,
      );
      if (candidates.length !== 1 || !/^-\s+/u.test(candidates[0].text))
        throw new Error("下位条目必须放在本分支唯一的第一层父条目下。");
      indent = "  ";
      at = candidates[0].end;
      for (const row of lines(content).filter((row) => row.start >= at && row.start < range.end)) {
        if (!/^ {2,}-\s+/u.test(row.text)) break;
        at = row.end;
      }
    }
    const title =
      allEntries.find((entry) => entry.path === item.path)?.title ??
      item.path.split("/").at(-1)!.replace(/\.md$/iu, "");
    const suggestion = item.suggestedBranch
      ? ` <!-- echoink-placement: ${JSON.stringify({ branch: item.suggestedBranch }).replace(/-->/gu, "--\\u003e")} -->`
      : "";
    content =
      content.slice(0, at) +
      `${indent}- [[${item.path}|${title}]]${suggestion}${eol}` +
      content.slice(at);
  }
  const paths = new Set(allEntries.map((entry) => entry.path));
  for (const gap of plan.gaps) {
    assertKnowledgeGapTitle(gap.title);
    if (
      !gap.reason?.trim() ||
      !gap.evidencePaths?.length ||
      gap.evidencePaths.some((path) => !paths.has(path))
    )
      throw new Error("缺口依据必须来自本领域全文。");
  }
  for (const title of treeMapGapTitles(job.block))
    if (!plan.gaps.some((gap) => gap.title === title) && !declined.includes(title)) {
      const resolved = plan.resolvedGaps?.find((gap) => gap.title === title);
      if (!resolved?.reason?.trim() || !resolved.evidencePaths?.some((path) => allowed.has(path)))
        throw new Error("删除已填补的缺口须给出本批新条目的依据。");
    }
  let gapRange = section(content, "缺口");
  const gaps = plan.gaps.filter((gap) => !declined.includes(gap.title));
  if (!gapRange && gaps.length) {
    const at = content.lastIndexOf("<!-- echoink-domain-map:END");
    content = content.slice(0, at) + `### 缺口${eol}${eol}` + content.slice(at);
    gapRange = section(content, "缺口");
  }
  if (gapRange) {
    for (const row of lines(content)
      .filter(
        (row) =>
          row.start >= gapRange!.body &&
          row.start < gapRange!.end &&
          /^-\s+/u.test(row.text) &&
          !linkTarget(row.text),
      )
      .reverse())
      content = content.slice(0, row.start) + content.slice(row.end);
    gapRange = section(content, "缺口")!;
    content =
      content.slice(0, gapRange.body) +
      gaps.map((gap) => `- ${gap.title}${eol}`).join("") +
      content.slice(gapRange.body);
    gapRange = section(content, "缺口")!;
    if (!gaps.length && !content.slice(gapRange.body, gapRange.end).trim())
      content = content.slice(0, gapRange.start) + content.slice(gapRange.end);
  }
  return content;
}

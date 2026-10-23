import { maintenancePageTitle, MAINTENANCE_KNOWLEDGE_TYPES } from "./maintenance-page-metadata";
import { appendMissingMaintenanceFrontmatterProperties, isMaintenanceSourceTargetPath, patchMaintenanceUpgradeSourceFrontmatter, readMaintenanceFrontmatterProperty, readMaintenanceSourceStateProperty } from "./maintenance-source-frontmatter";
import { isMaintenanceCanonicalSourceStatus, resolveMaintenanceSourceState } from "./maintenance-source-state";
import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";
import type { MaintenanceCanonicalSourceStatus, MaintenanceUpgradeFile, MaintenanceUpgradeIssue, MaintenanceUpgradePlan, MaintenanceUpgradePlanInput, MaintenanceUpgradePreview } from "./maintenance-upgrade-contract";

const withoutExtension = (value: string) => value.replace(/\.(?:md|markdown)$/iu, "");
const basename = (value: string) => value.split("/").at(-1) ?? value;
const nameKey = (value: string) => withoutExtension(value).normalize("NFKC").trim().toLowerCase();
const UNREADABLE_PROPERTIES_MESSAGE = "这页的属性没法明确识别，原文件会保留，请核对后再试。";

function fileTitle(file: MaintenanceUpgradeFile): string {
  try { return maintenancePageTitle(file.content, file.path); }
  catch { return withoutExtension(basename(file.path)); }
}

function resolveRelativePath(base: string, value: string): string | undefined {
  const segments: string[] = [];
  for (const part of (base ? `${base}/${value}` : value).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!segments.length) return undefined; segments.pop(); }
    else segments.push(part);
  }
  return segments.join("/");
}

function linkTarget(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value.trim().replace(/^<|>$/gu, "")).split(/[#^]/u, 1)[0];
    return decoded && !/^(?:[a-z][a-z\d+.-]*:|\/|~\/)/iu.test(decoded) && !/[\\\u0000-\u001f\u007f]/u.test(decoded) ? decoded : undefined;
  } catch { return undefined; }
}

/** Never reads a Vault or calls a model; every candidate is a frozen scanned file. */
export function buildMaintenanceUpgradePlan(input: MaintenanceUpgradePlanInput): MaintenanceUpgradePlan {
  const createdAt = input.now ?? Date.now();
  const plan: MaintenanceUpgradePlan = {
    version: 1, id: input.id ?? `maintenance-upgrade-${createdAt.toString(36)}`, createdAt,
    bindingRevision: input.bindingRevision, sourceItems: [], wikiItems: [],
    rootAdditions: [...new Map((input.rootAdditions ?? []).map(root => [`${root.role}\0${root.path}`, { ...root }])).values()],
    issues: [], counts: { sourceCount: 0, sourceStatusCount: 0, sourceLinkCount: 0, backlinkCount: 0, wikiCount: 0 }
  };
  const seenIssues = new Set<string>();
  const issue = (file: MaintenanceUpgradeFile, message: string, kind: MaintenanceUpgradeIssue["kind"] = "review") => {
    const key = `${file.path}\0${kind}\0${message}`;
    if (!seenIssues.has(key)) { seenIssues.add(key); plan.issues.push({ path: file.path, title: fileTitle(file), message, kind }); }
  };
  const files = [...new Map(input.files.map(file => [file.path, file])).values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  const sources = files.filter(file => file.role === "raw" || file.role === "inbox");
  const wikis = files.filter(file => file.role === "wiki");
  plan.counts.sourceCount = sources.length;
  const sourceNames = new Map<string, Set<string>>(), sourcePaths = new Set(sources.map(file => file.path));
  const wikiPaths = new Set(wikis.map(file => file.path));
  const sourceRoots = new Set(sources.map(file => file.path.split("/")[0]));
  const reverse = new Map<string, Set<string>>();
  for (const file of sources) {
    const aliases = readMaintenanceFrontmatterProperty(file.content, "aliases").value;
    const names = [basename(file.path), fileTitle(file), ...(Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === "string") : typeof aliases === "string" ? [aliases] : [])];
    for (const name of names) {
      const key = nameKey(name);
      if (key) { const paths = sourceNames.get(key) ?? new Set<string>(); paths.add(file.path); sourceNames.set(key, paths); }
    }
  }

  for (const wiki of wikis) {
    const type = readMaintenanceFrontmatterProperty(wiki.content, "类型");
    if (type.error) issue(wiki, UNREADABLE_PROPERTIES_MESSAGE, "unavailable");
    else if (!type.present) {
      try {
        appendMissingMaintenanceFrontmatterProperties(wiki.content, { 类型: "" });
        plan.wikiItems.push({ path: wiki.path, title: fileTitle(wiki), revision: wiki.revision, content: wiki.content });
      } catch { issue(wiki, UNREADABLE_PROPERTIES_MESSAGE, "unavailable"); }
    }
    else if (!MAINTENANCE_KNOWLEDGE_TYPES.some(value => value === type.value)) issue(wiki, "这页的“类型”不在七种知识类型里，先保留，请你核对。");

    const regions = createMaintenanceSectionSnapshot(wiki.content).regions;
    const inSources = (offset: number) => regions.some(region => region.kind === "sources" && offset >= region.start && offset < region.end);
    const add = (value: string, display: string | undefined, required: boolean) => {
      const target = linkTarget(value);
      if (!target) { if (required) issue(wiki, `来源链接“${value}”暂时打不开，原链接先保留，请你核对。`); return; }
      const directory = wiki.path.slice(0, Math.max(0, wiki.path.lastIndexOf("/")));
      const relative = resolveRelativePath(directory, target);
      const direct = resolveRelativePath("", target);
      const candidates = [...new Set([direct, relative].filter((path): path is string => Boolean(path)))];
      const exact = candidates.flatMap(path => [path, `${path}.md`, `${path}.markdown`]).filter(path => sourcePaths.has(path));
      let matches = [...new Set(exact)];
      // A real path is stronger than a display label or a coinciding H1.
      const isWiki = candidates.some(path => [path, `${path}.md`, `${path}.markdown`].some(item => wikiPaths.has(item)));
      if (!matches.length && isWiki) return;
      if (!matches.length) matches = [...new Set([...(sourceNames.get(nameKey(target)) ?? []), ...(sourceNames.get(nameKey(basename(target))) ?? [])])];
      if (!matches.length && display) matches = [...(sourceNames.get(nameKey(display)) ?? [])];
      if (matches.length === 1) {
        const targets = reverse.get(matches[0]) ?? new Set<string>(); targets.add(wiki.path); reverse.set(matches[0], targets);
      } else if (matches.length > 1) issue(wiki, `来源“${value}”有 ${matches.length} 篇同名资料，分不清是哪一篇，原链接先保留。`);
      else if (required || sourceRoots.has(target.split("/")[0]) || /^(?:raw|inbox|原始资料|收件箱)(?:[（(/]|$)/iu.test(target)) {
        issue(wiki, `没有找到来源“${value}”对应的资料，原链接先保留，请你核对。`);
      }
    };
    // Code examples do not establish source relationships. Keep offsets stable.
    let fence: string | undefined;
    const bodyStart = regions[0]?.start ?? 0;
    const body = wiki.content.slice(0, bodyStart).replace(/[^\r\n]/gu, " ") + wiki.content.slice(bodyStart);
    const visible = body.split(/(?<=\n)/u).map(line => {
      const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (match) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
        return line.replace(/[^\r\n]/gu, " ");
      }
      return fence ? line.replace(/[^\r\n]/gu, " ") : line;
    }).join("");
    const markers = [...visible.matchAll(/<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu)];
    if ([...visible.matchAll(/<!--\s*echoink-source\b/giu)].length !== markers.length) issue(wiki, "这页有一处旧来源信息不完整，原文先保留，请你核对。");
    for (const marker of markers) {
      try {
        const value: unknown = JSON.parse(marker[1]);
        if (!value || typeof value !== "object" || typeof (value as { path?: unknown }).path !== "string") throw new Error("invalid marker");
        add((value as { path: string }).path, undefined, true);
      } catch { issue(wiki, "这页有一处旧来源信息看不出指向哪篇资料，原文先保留，请你核对。"); }
    }
    const readable = visible.replace(/<!--[\s\S]*?-->/gu, value => value.replace(/[^\r\n]/gu, " ")).replace(/`[^`\r\n]*`/gu, value => " ".repeat(value.length));
    for (const match of readable.matchAll(/\[\[([^\]\r\n]+)\]\]/gu)) {
      const [target, display] = match[1].split("|", 2);
      const line = readable.slice(readable.lastIndexOf("\n", match.index) + 1, match.index);
      add(target, display, inSources(match.index) || /来源|原始材料|source/iu.test(line));
    }
    for (const match of readable.matchAll(/(?<!!)\[([^\]\r\n]*)\]\((<[^>\r\n]+>|[^)\r\n]+)\)/gu)) {
      const target = match[2].replace(/\s+["'][\s\S]*$/u, "");
      if (/^[a-z][a-z\d+.-]*:/iu.test(target)) continue;
      const line = readable.slice(readable.lastIndexOf("\n", match.index) + 1, match.index);
      add(target, match[1], inSources(match.index) || /来源|原始材料|source/iu.test(line));
    }
  }

  const statusForState: Record<string, MaintenanceCanonicalSourceStatus> = { digested: "已提炼", failed: "提炼失败", changed: "待重新提炼", calibration: "待校准", pending: "未提炼" };
  for (const file of sources) {
    const status = readMaintenanceSourceStateProperty(file.content), targets = readMaintenanceFrontmatterProperty(file.content, "提炼到");
    const supplied = input.evidence?.[file.path] ?? {};
    const resolution = resolveMaintenanceSourceState(file.content, { ...supplied, ...(file.fingerprint ? { fingerprint: () => file.fingerprint! } : {}) });
    // Preview alone inspects historical fingerprints even when a standard state
    // already wins. Daily standard-state readers never compute a body digest.
    const legacyProcessed = readMaintenanceFrontmatterProperty(file.content, "已处理").value;
    const legacyFingerprint = readMaintenanceFrontmatterProperty(file.content, "提炼指纹").value;
    const completedFingerprints = [
      ...(supplied.maintenance?.status === "processed" ? [supplied.maintenance.fingerprint] : []),
      ...(supplied.registry ? [supplied.registry.fingerprint] : []),
      ...((status.value === "已提炼" || legacyProcessed === true || legacyProcessed === "已处理" || legacyProcessed === "processed") && typeof legacyFingerprint === "string" ? [legacyFingerprint] : [])
    ].filter(value => typeof value === "string" && Boolean(value.trim()));
    const currentFingerprint = completedFingerprints.length ? file.fingerprint ?? supplied.fingerprint?.() : undefined;
    if (currentFingerprint && completedFingerprints.some(value => value !== currentFingerprint)) {
      issue(file, "可选：重新提炼。这页在上次整理后改过，看不出改的是排版还是内容。原文不动；想更新的话，可以让 Agent 重新整理这页。", "optional-reingest");
    }
    const inferred = [...(reverse.get(file.path) ?? [])].filter(isMaintenanceSourceTargetPath).sort((a, b) => a.localeCompare(b, "en"));
    const declaredTargetPaths = Array.isArray(targets.value) ? targets.value.flatMap(value => {
      const match = typeof value === "string" ? /^\[\[(.+)\]\]$/u.exec(value) : null;
      return match && isMaintenanceSourceTargetPath(match[1]) ? [match[1]] : [];
    }) : [];
    const existingTargetPaths = declaredTargetPaths.filter(targetPath => wikiPaths.has(targetPath));
    for (const targetPath of declaredTargetPaths.filter(targetPath => !wikiPaths.has(targetPath))) {
      issue(file, `“提炼到”里的 Wiki 页面“${targetPath}”找不到了，原链接先保留，请你核对。`);
    }
    if (resolution.state === "digested" && !existingTargetPaths.length && !inferred.length) {
      issue(file, "看不出这篇资料整理到了哪页 Wiki，先不补链接，仍算已提炼。");
    }
    if (status.error || targets.error) { issue(file, UNREADABLE_PROPERTIES_MESSAGE, "unavailable"); continue; }
    if (status.present && !isMaintenanceCanonicalSourceStatus(status.value)) issue(file, "这篇资料的“提炼状态”看不明白，先保留，请你核对。");
    if (targets.present && (!Array.isArray(targets.value) || targets.value.some(value => {
      const match = typeof value === "string" ? /^\[\[(.+)\]\]$/u.exec(value) : null;
      return !match || !isMaintenanceSourceTargetPath(match[1]);
    }))) issue(file, "这篇资料的“提炼到”没写成 Wiki 链接列表，先保留，请你核对。");
    const addStatus = !status.present ? statusForState[resolution.state] : undefined;
    const addTargetPaths = !targets.present && inferred.length ? inferred : undefined;
    if (addStatus === undefined && addTargetPaths === undefined) continue;
    try {
      patchMaintenanceUpgradeSourceFrontmatter(file.content, { ...(addStatus ? { status: addStatus } : {}), ...(addTargetPaths ? { targetPaths: addTargetPaths } : {}) });
    } catch { issue(file, UNREADABLE_PROPERTIES_MESSAGE, "unavailable"); continue; }
    plan.sourceItems.push({ path: file.path, title: fileTitle(file), revision: file.revision, content: file.content, state: resolution.state,
      ...(addStatus ? { addStatus } : {}), ...(addTargetPaths ? { addTargetPaths } : {}) });
    if (addStatus) plan.counts.sourceStatusCount++;
    if (addTargetPaths) { plan.counts.sourceLinkCount++; plan.counts.backlinkCount += addTargetPaths.length; }
  }
  plan.counts.wikiCount = plan.wikiItems.length;
  return plan;
}

export function previewMaintenanceUpgradePlan(plan: MaintenanceUpgradePlan): MaintenanceUpgradePreview {
  return {
    id: plan.id, createdAt: plan.createdAt, counts: { ...plan.counts },
    rootAdditions: plan.rootAdditions.map(root => ({ ...root })), issues: plan.issues.map(issue => ({ ...issue })),
    automatic: [
      ...plan.sourceItems.map(item => ({ path: item.path, title: item.title, properties: [
        ...(item.addStatus ? [`提炼状态：${item.addStatus}`] : []),
        ...(item.addTargetPaths ? [`提炼到：${item.addTargetPaths.length} 页`] : [])
      ] })),
      ...plan.wikiItems.map(item => ({ path: item.path, title: item.title, properties: ["类型"], description: "确认后让 Agent 从七种知识类型中选择；拿不准时标上“类型待确认”。" }))
    ]
  };
}

import * as fsp from "fs/promises";
import * as path from "path";
import { emptyArrayOnMissingPathOrWarn } from "../core/error-handling";
import type {
  StructureNormalizationMove,
  StructureNormalizationPathRewrite,
  StructureNormalizationResult,
  StructureNormalizationSkipped,
  StructureNormalizationUpdatedLink
} from "./types";
import { exists, normalizeSlashes, walkFiles } from "./utils";

export interface StructureNormalizationOptions {
  lastReportPath?: string;
  includeRawMoves?: boolean;
}

interface MoveCandidate {
  from: string;
  to: string;
  kind: "file" | "directory";
  reason: string;
  moveAssetsWithMarkdown?: boolean;
}

const KNOWLEDGE_ROOTS = ["raw", "wiki", "outputs", "inbox", "projects"] as const;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".html"]);
const CHINESE_TEXT = /\p{Script=Han}/u;

const FIXED_MOVES: MoveCandidate[] = [
  { from: "raw/articles/GitHub项目收集", to: "raw/articles/github-trending", kind: "directory", reason: "raw 来源目录英文化" },
  { from: "raw/articles/OpenAI官方文档", to: "raw/articles/openai-docs", kind: "directory", reason: "raw 来源目录英文化" },
  { from: "raw/articles/微信公众号", to: "raw/articles/wechat-official-accounts", kind: "directory", reason: "raw 来源目录英文化" },
  { from: "raw/articles/飞书文档", to: "raw/articles/feishu-docs", kind: "directory", reason: "raw 来源目录英文化" },
  { from: "raw/clippings/文章", to: "raw/clippings/articles", kind: "directory", reason: "raw 剪藏目录英文化" },
  { from: "raw/策略信号系统介绍.md", to: "raw/articles/investment/策略信号系统介绍.md", kind: "file", reason: "raw 根目录普通资料归入投资来源", moveAssetsWithMarkdown: true },
  { from: "inbox/Clippings", to: "inbox/clippings", kind: "directory", reason: "inbox 剪藏目录英文化" },
  { from: "inbox/桌面 TodoList 调研", to: "inbox/research/desktop-todolist", kind: "directory", reason: "inbox 调研资料归入 research" },
  { from: "inbox/skills-local-audit.md", to: "inbox/research/skills-local-audit.md", kind: "file", reason: "inbox 根目录调研笔记归入 research" },
  { from: "inbox/日常记录.md", to: "inbox/ideas/日常记录.md", kind: "file", reason: "inbox 根目录想法笔记归入 ideas" }
];

const PROJECT_PHASE_DIRS: Array<{ fromName: string; toName: string; reason: string }> = [
  { fromName: "10-沉淀", toName: "insights", reason: "项目沉淀阶段目录英文化" },
  { fromName: "20-实践", toName: "execution", reason: "项目实践阶段目录英文化" },
  { fromName: "30-原始资料", toName: "sources", reason: "项目原始资料阶段目录英文化" },
  { fromName: "99-归档", toName: "archive", reason: "项目归档阶段目录英文化" }
];

export async function normalizeKnowledgeBaseStructure(
  vaultPath: string,
  options: StructureNormalizationOptions = {}
): Promise<StructureNormalizationResult> {
  const result: StructureNormalizationResult = {
    moves: [],
    skipped: [],
    updatedLinks: [],
    remainingRootNotes: [],
    remainingChineseDirs: [],
    risks: [],
    pathRewrites: []
  };
  if (options.includeRawMoves === true) {
    result.risks.push("raw 自动移动已显式开启；执行前应确认 Obsidian 元数据自动更新规则不会改写 raw frontmatter。");
  } else {
    await recordSkippedRawMoveCandidates(vaultPath, result);
  }
  const candidates = await buildMoveCandidates(vaultPath, options);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.from)) continue;
    seen.add(candidate.from);
    await applyMoveCandidate(vaultPath, candidate, result);
  }
  if (result.pathRewrites.length) {
    result.updatedLinks = await updateKnowledgeBaseTextReferences(vaultPath, result.pathRewrites);
  }
  result.remainingRootNotes = await findRemainingRootNotes(vaultPath);
  result.remainingChineseDirs = await findRemainingChineseDirs(vaultPath);
  if (options.lastReportPath) {
    const rewritten = rewriteKnowledgeBaseRelativePath(options.lastReportPath, result.pathRewrites);
    if (rewritten !== normalizeSlashes(options.lastReportPath)) result.updatedLastReportPath = rewritten;
  }
  return result;
}

export function rewriteKnowledgeBaseRelativePath(relativePath: string, rewrites: StructureNormalizationPathRewrite[]): string {
  let next = normalizeSlashes(relativePath);
  for (const rewrite of [...rewrites].sort((left, right) => right.from.length - left.from.length)) {
    if (next === rewrite.from) {
      next = rewrite.to;
      continue;
    }
    if (rewrite.kind === "directory" && next.startsWith(`${rewrite.from}/`)) {
      next = `${rewrite.to}${next.slice(rewrite.from.length)}`;
    }
  }
  return next;
}

async function buildMoveCandidates(vaultPath: string, options: StructureNormalizationOptions): Promise<MoveCandidate[]> {
  return [
    ...FIXED_MOVES.filter((candidate) => options.includeRawMoves === true || !isRawMoveCandidate(candidate)),
    ...await outputMoveCandidates(vaultPath),
    ...await projectPhaseMoveCandidates(vaultPath)
  ];
}

async function recordSkippedRawMoveCandidates(vaultPath: string, result: StructureNormalizationResult): Promise<void> {
  for (const candidate of FIXED_MOVES) {
    if (!isRawMoveCandidate(candidate)) continue;
    const from = normalizeSlashes(candidate.from);
    const to = normalizeSlashes(candidate.to);
    if (!await exists(path.join(vaultPath, from))) continue;
    addSkip(result, {
      from,
      to,
      reason: "raw 自动移动已关闭，避免 Obsidian 元数据规则改写原始资料"
    });
  }
}

function isRawMoveCandidate(candidate: MoveCandidate): boolean {
  return normalizeSlashes(candidate.from).startsWith("raw/") || normalizeSlashes(candidate.to).startsWith("raw/");
}

async function outputMoveCandidates(vaultPath: string): Promise<MoveCandidate[]> {
  const outputsPath = path.join(vaultPath, "outputs");
  const entries = await fsp.readdir(outputsPath, { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn("read maintenance report output directory"));
  const candidates: MoveCandidate[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name === ".ingest-tracker.md") continue;
    const from = `outputs/${entry.name}`;
    if (entry.isDirectory() && ["maintenance", "reviews", "publishing", "instructions", "migrations"].includes(entry.name)) continue;
    if (entry.isFile() && /^kb-(?:maintenance|check)-\d{4}-\d{2}-\d{2}\.md$/i.test(entry.name)) {
      candidates.push({ from, to: `outputs/maintenance/${entry.name}`, kind: "file", reason: "维护/体检报告归入 maintenance" });
      continue;
    }
    if (entry.isFile() && /^knowledge-base-review-/i.test(entry.name)) {
      candidates.push({ from, to: `outputs/reviews/${entry.name}`, kind: "file", reason: "知识库周报归入 reviews" });
      continue;
    }
    if (/xhs/i.test(entry.name)) {
      candidates.push({ from, to: `outputs/publishing/xiaohongshu/${entry.name}`, kind: entry.isDirectory() ? "directory" : "file", reason: "小红书发布素材归入 publishing/xiaohongshu" });
      continue;
    }
    if (/instructions/i.test(entry.name)) {
      candidates.push({ from, to: `outputs/instructions/${entry.name}`, kind: entry.isDirectory() ? "directory" : "file", reason: "说明文档归入 instructions" });
      continue;
    }
    if (/^old-wiki-merge-/i.test(entry.name)) {
      candidates.push({ from, to: `outputs/migrations/${entry.name}`, kind: entry.isDirectory() ? "directory" : "file", reason: "迁移报告归入 migrations" });
    }
  }
  return candidates;
}

async function projectPhaseMoveCandidates(vaultPath: string): Promise<MoveCandidate[]> {
  const projectsPath = path.join(vaultPath, "projects");
  const projects = await fsp.readdir(projectsPath, { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn("read projects directory for structure normalization"));
  const candidates: MoveCandidate[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith(".")) continue;
    for (const phase of PROJECT_PHASE_DIRS) {
      candidates.push({
        from: `projects/${project.name}/${phase.fromName}`,
        to: `projects/${project.name}/${phase.toName}`,
        kind: "directory",
        reason: phase.reason
      });
    }
  }
  return candidates;
}

async function applyMoveCandidate(vaultPath: string, candidate: MoveCandidate, result: StructureNormalizationResult): Promise<void> {
  const from = normalizeSlashes(candidate.from);
  const to = normalizeSlashes(candidate.to);
  if (!isKnowledgeRelativePath(from) || !isKnowledgeRelativePath(to)) {
    addSkip(result, { from, to, reason: "跨出知识区，跳过" });
    return;
  }
  const fromAbs = path.join(vaultPath, from);
  const toAbs = path.join(vaultPath, to);
  if (!await exists(fromAbs)) return;
  const stat = await fsp.stat(fromAbs).catch(() => null);
  if (!stat || (candidate.kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    addSkip(result, { from, to, reason: "源类型不匹配，跳过" });
    return;
  }
  const targetExists = await exists(toAbs);
  const caseOnlyMove = targetExists && isCaseOnlyMove(fromAbs, toAbs);
  const shouldMergeDirectory = targetExists && !caseOnlyMove && candidate.kind === "directory";
  if (targetExists && !caseOnlyMove) {
    if (!shouldMergeDirectory) {
      addSkip(result, { from, to, reason: "目标路径已存在，存在同名冲突，跳过" });
      return;
    }
    const targetStat = await fsp.stat(toAbs).catch(() => null);
    if (!targetStat?.isDirectory()) {
      addSkip(result, { from, to, reason: "目标路径已存在但不是文件夹，跳过" });
      return;
    }
    const conflicts = await findDirectoryMergeConflicts(fromAbs, toAbs);
    if (conflicts.length) {
      addSkip(result, { from, to, reason: `目标目录存在同名冲突：${conflicts.slice(0, 3).join("，")}` });
      return;
    }
  }
  const assetMove = await companionAssetMove(vaultPath, candidate);
  if (assetMove?.blockedReason) {
    addSkip(result, { from, to, reason: assetMove.blockedReason });
    return;
  }
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  if (caseOnlyMove) await renameCaseOnly(fromAbs, toAbs);
  else if (shouldMergeDirectory) await mergeDirectoryContents(fromAbs, toAbs);
  else await fsp.rename(fromAbs, toAbs);
  if (assetMove?.fromAbs && assetMove.toAbs) {
    await fsp.mkdir(path.dirname(assetMove.toAbs), { recursive: true });
    await fsp.rename(assetMove.fromAbs, assetMove.toAbs);
    result.pathRewrites.push({
      from: normalizeSlashes(path.relative(vaultPath, assetMove.fromAbs)),
      to: normalizeSlashes(path.relative(vaultPath, assetMove.toAbs)),
      kind: "directory"
    });
  }
  const move: StructureNormalizationMove = { from, to, kind: candidate.kind, reason: candidate.reason };
  result.moves.push(move);
  result.pathRewrites.push({ from, to, kind: candidate.kind });
}

async function findDirectoryMergeConflicts(fromAbs: string, toAbs: string, base = ""): Promise<string[]> {
  const conflicts: string[] = [];
  const entries = await fsp.readdir(fromAbs, { withFileTypes: true });
  for (const entry of entries) {
    const fromEntry = path.join(fromAbs, entry.name);
    const toEntry = path.join(toAbs, entry.name);
    const relative = normalizeSlashes(path.join(base, entry.name));
    const targetStat = await fsp.stat(toEntry).catch(() => null);
    if (entry.isDirectory()) {
      if (!targetStat) continue;
      if (!targetStat.isDirectory()) {
        conflicts.push(relative);
        continue;
      }
      conflicts.push(...await findDirectoryMergeConflicts(fromEntry, toEntry, relative));
      continue;
    }
    if (entry.isFile()) {
      if (targetStat) conflicts.push(relative);
      continue;
    }
    conflicts.push(relative);
  }
  return conflicts;
}

async function mergeDirectoryContents(fromAbs: string, toAbs: string): Promise<void> {
  await fsp.mkdir(toAbs, { recursive: true });
  const entries = await fsp.readdir(fromAbs, { withFileTypes: true });
  for (const entry of entries) {
    const fromEntry = path.join(fromAbs, entry.name);
    const toEntry = path.join(toAbs, entry.name);
    const targetStat = await fsp.stat(toEntry).catch(() => null);
    if (entry.isDirectory() && targetStat?.isDirectory()) {
      await mergeDirectoryContents(fromEntry, toEntry);
      continue;
    }
    await fsp.rename(fromEntry, toEntry);
  }
  await fsp.rmdir(fromAbs);
}

async function renameCaseOnly(fromAbs: string, toAbs: string): Promise<void> {
  const temp = await uniqueTempSibling(fromAbs);
  await fsp.rename(fromAbs, temp);
  await fsp.rename(temp, toAbs);
}

async function uniqueTempSibling(fromAbs: string): Promise<string> {
  const dir = path.dirname(fromAbs);
  const base = path.basename(fromAbs);
  for (let index = 0; index < 20; index += 1) {
    const candidate = path.join(dir, `.codex-rename-${Date.now()}-${index}-${base}`);
    if (!await exists(candidate)) return candidate;
  }
  throw new Error(`无法创建临时重命名路径：${fromAbs}`);
}

async function companionAssetMove(vaultPath: string, candidate: MoveCandidate): Promise<{ fromAbs?: string; toAbs?: string; blockedReason?: string } | null> {
  if (!candidate.moveAssetsWithMarkdown || candidate.kind !== "file" || path.extname(candidate.from).toLowerCase() !== ".md") return null;
  const fromAssets = path.join(vaultPath, stripMarkdownExtension(candidate.from) + ".assets");
  if (!await exists(fromAssets)) return null;
  const toAssets = path.join(vaultPath, stripMarkdownExtension(candidate.to) + ".assets");
  const stat = await fsp.stat(fromAssets).catch(() => null);
  if (!stat?.isDirectory()) return { blockedReason: "附件目录不是文件夹，跳过" };
  if (await exists(toAssets)) return { blockedReason: "附件目录目标已存在，存在同名冲突，跳过" };
  return { fromAbs: fromAssets, toAbs: toAssets };
}

async function updateKnowledgeBaseTextReferences(vaultPath: string, rewrites: StructureNormalizationPathRewrite[]): Promise<StructureNormalizationUpdatedLink[]> {
  const files = await walkKnowledgeTextFiles(vaultPath);
  const updated: StructureNormalizationUpdatedLink[] = [];
  for (const file of files) {
    const relativePath = normalizeSlashes(path.relative(vaultPath, file));
    const replacements = buildTextReplacementPairs(rewrites, relativePath);
    const text = await fsp.readFile(file, "utf8").catch(() => "");
    if (!text) continue;
    let next = text;
    let count = 0;
    for (const replacement of replacements) {
      const currentCount = countOccurrences(next, replacement.from);
      if (!currentCount) continue;
      next = next.split(replacement.from).join(replacement.to);
      count += currentCount;
    }
    if (!count || next === text) continue;
    await fsp.writeFile(file, next, "utf8");
    updated.push({ path: relativePath, replacements: count });
  }
  return updated;
}

function buildTextReplacementPairs(rewrites: StructureNormalizationPathRewrite[], fileRelativePath: string): Array<{ from: string; to: string }> {
  const pairs = new Map<string, string>();
  for (const rewrite of rewrites) {
    pairs.set(rewrite.from, rewrite.to);
    if (rewrite.kind === "file" && /\.md$/i.test(rewrite.from)) {
      pairs.set(stripMarkdownExtension(rewrite.from), stripMarkdownExtension(rewrite.to));
    }
    if (rewrite.kind === "directory" && rewrite.from.startsWith("raw/")) {
      pairs.set(rewrite.from.slice("raw/".length), rewrite.to.slice("raw/".length));
    }
    if (rewrite.kind === "directory" && rewrite.from.startsWith("projects/")) {
      const parent = normalizeSlashes(path.dirname(rewrite.from));
      if (fileRelativePath === parent || fileRelativePath.startsWith(`${parent}/`)) {
        pairs.set(path.basename(rewrite.from), path.basename(rewrite.to));
      }
    }
  }
  return Array.from(pairs.entries())
    .map(([from, to]) => ({ from, to }))
    .sort((left, right) => right.from.length - left.from.length);
}

async function walkKnowledgeTextFiles(vaultPath: string): Promise<string[]> {
  const result: string[] = [];
  for (const root of KNOWLEDGE_ROOTS) {
    if (root === "raw") {
      const rawIndex = path.join(vaultPath, "raw", "index.md");
      if (await exists(rawIndex)) result.push(rawIndex);
      continue;
    }
    const rootPath = path.join(vaultPath, root);
    result.push(...await walkTextFiles(rootPath));
  }
  return result;
}

async function walkTextFiles(dir: string): Promise<string[]> {
  return walkFiles(dir, {
    shouldSkipEntry: (entry) => entry.name === ".DS_Store" || (entry.isDirectory() && entry.name.startsWith(".")),
    shouldIncludeFile: (entry) => TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === ".ingest-tracker.md",
    onReadDirError: (error) => {
      emptyArrayOnMissingPathOrWarn("walk markdown directory for structure normalization")(error);
    }
  });
}

async function findRemainingRootNotes(vaultPath: string): Promise<string[]> {
  const allowed: Record<string, Set<string>> = {
    raw: new Set(["index.md", "README.md"]),
    wiki: new Set(["index.md", "README.md", "00-索引.md"]),
    outputs: new Set([".ingest-tracker.md", "README.md", "index.md"]),
    inbox: new Set(["README.md", "index.md"]),
    projects: new Set(["00-索引.md", "README.md", "index.md"])
  };
  const notes: string[] = [];
  for (const root of KNOWLEDGE_ROOTS) {
    const entries = await fsp.readdir(path.join(vaultPath, root), { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn(`detect case conflicts under ${root}`));
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".") || path.extname(entry.name).toLowerCase() !== ".md") continue;
      if (allowed[root]?.has(entry.name)) continue;
      notes.push(`${root}/${entry.name}`);
    }
  }
  return notes.sort((left, right) => left.localeCompare(right));
}

async function findRemainingChineseDirs(vaultPath: string): Promise<string[]> {
  const result: string[] = [];
  for (const root of KNOWLEDGE_ROOTS) {
    await walkFiles(path.join(vaultPath, root), {
      shouldSkipEntry: (entry) => entry.isDirectory() && entry.name.startsWith("."),
      shouldIncludeFile: () => false,
      onDirectory: (entry, full) => {
        if (CHINESE_TEXT.test(entry.name) && !entry.name.endsWith(".assets")) {
          result.push(normalizeSlashes(path.relative(vaultPath, full)));
        }
      },
      onReadDirError: (error) => {
        emptyArrayOnMissingPathOrWarn("walk conflict directory for structure normalization")(error);
      }
    });
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function isKnowledgeRelativePath(relativePath: string): boolean {
  const first = normalizeSlashes(relativePath).split("/")[0];
  return KNOWLEDGE_ROOTS.includes(first as typeof KNOWLEDGE_ROOTS[number]);
}

function isCaseOnlyMove(fromAbs: string, toAbs: string): boolean {
  const from = path.resolve(fromAbs);
  const to = path.resolve(toAbs);
  return from !== to && from.toLowerCase() === to.toLowerCase();
}

function addSkip(result: StructureNormalizationResult, skipped: StructureNormalizationSkipped): void {
  result.skipped.push(skipped);
  result.risks.push(`${skipped.from}${skipped.to ? ` -> ${skipped.to}` : ""}：${skipped.reason}`);
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

function countOccurrences(text: string, search: string): number {
  if (!search) return 0;
  return text.split(search).length - 1;
}

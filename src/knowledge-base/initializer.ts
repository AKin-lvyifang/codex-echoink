import * as fsp from "fs/promises";
import * as path from "path";
import { emptyArrayOnMissingPathOrWarn } from "../core/error-handling";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE, LEGACY_CLAUDE_RULES_FILE } from "./constants";
import { exists, normalizeSlashes, walkFiles } from "./utils";
import { buildVaultProfileTemplate } from "../workflows/knowledge/profile/profile-parser";

export const KNOWLEDGE_BASE_TEMPLATE_VERSION = "v0.7";

export type KnowledgeBaseInitializationStatus = "not-started" | "preview-ready" | "initialized" | "failed";
export type KnowledgeBaseInitializationTarget = "raw/articles" | "raw/attachments" | "inbox" | "projects" | "outputs" | "journal" | "wiki-review" | "ignore";

export interface KnowledgeBaseInitializationSuggestion {
  path: string;
  target: KnowledgeBaseInitializationTarget;
  reason: string;
}

export interface KnowledgeBaseInitializationPreview {
  status: "preview-ready";
  templateVersion: string;
  rulesFilePath: string;
  directories: string[];
  indexFiles: string[];
  suggestions: KnowledgeBaseInitializationSuggestion[];
  skipped: string[];
  summary: string;
}

export interface KnowledgeBaseInitializationResult {
  status: "initialized";
  templateVersion: string;
  rulesFilePath: string;
  createdDirectories: string[];
  createdFiles: string[];
  skippedFiles: string[];
  summary: string;
}

interface WikiDomainTemplate {
  id: string;
  title: string;
  description: string;
}

const WIKI_DOMAINS: WikiDomainTemplate[] = [
  { id: "ai-intelligence", title: "AI 与智能体", description: "大模型、Agent、Prompt、AI 工具" },
  { id: "product-method", title: "产品方法", description: "产品思维、方法论、需求分析" },
  { id: "business-industry", title: "商业与行业", description: "商业模式、行业分析、市场调研" },
  { id: "content-creation", title: "内容创作", description: "写作、视频、社交媒体、公开表达" },
  { id: "knowledge-workflow", title: "知识管理与工作流", description: "Obsidian、AI 协作、效率工具" },
  { id: "personal", title: "个人系统", description: "个人档案、目标、生活管理、长期复盘" }
];

const TEMPLATE_DIRECTORIES = [
  "raw",
  "raw/articles",
  "raw/articles/github-trending",
  "raw/articles/openai-docs",
  "raw/articles/wechat-official-accounts",
  "raw/articles/feishu-docs",
  "raw/articles/investment",
  "raw/clippings",
  "raw/clippings/articles",
  "raw/attachments",
  "wiki",
  ...WIKI_DOMAINS.map((domain) => `wiki/${domain.id}`),
  "projects",
  "outputs",
  "outputs/maintenance",
  "outputs/reviews",
  "outputs/publishing/xiaohongshu",
  "outputs/instructions",
  "outputs/migrations",
  "inbox",
  "inbox/ideas",
  "inbox/research",
  "inbox/clippings",
  "journal",
  "journal/daily",
  "journal/weekly",
  "journal/monthly",
  "journal/quarterly",
  "journal/yearly",
  "templates",
  "assets",
  "archive"
];

const TEMPLATE_INDEX_FILES = [
  "wiki/index.md",
  "raw/index.md",
  "outputs/.ingest-tracker.md",
  ...WIKI_DOMAINS.map((domain) => `wiki/${domain.id}/00-索引.md`)
];

const KNOWN_TOP_LEVEL_DIRS = new Set([
  ".obsidian",
  ".git",
  ".codex",
  ".codex-memory",
  ".claude",
  ".claudian",
  ".opencode",
  ".omx",
  ".agents",
  "node_modules",
  "raw",
  "wiki",
  "projects",
  "outputs",
  "inbox",
  "journal",
  "templates",
  "assets",
  "archive",
  "testing"
]);

export async function buildKnowledgeBaseInitializationPreview(vaultPath: string): Promise<KnowledgeBaseInitializationPreview> {
  const rulesFilePath = chooseRulesFilePath();
  const suggestions = await scanInitializationSuggestions(vaultPath);
  const skipped = suggestions.filter((item) => item.target === "ignore").map((item) => item.path);
  const actionableSuggestions = suggestions.filter((item) => item.target !== "ignore");
  const preview: Omit<KnowledgeBaseInitializationPreview, "summary"> = {
    status: "preview-ready",
    templateVersion: KNOWLEDGE_BASE_TEMPLATE_VERSION,
    rulesFilePath,
    directories: TEMPLATE_DIRECTORIES,
    indexFiles: TEMPLATE_INDEX_FILES,
    suggestions: actionableSuggestions,
    skipped
  };
  return {
    ...preview,
    summary: formatKnowledgeBaseInitializationPreview(preview)
  };
}

export async function executeKnowledgeBaseInitialization(
  vaultPath: string,
  preview: KnowledgeBaseInitializationPreview,
  now = new Date()
): Promise<KnowledgeBaseInitializationResult> {
  assertAllowedRulesFilePath(preview.rulesFilePath);
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const dir of preview.directories) {
    const absolute = path.join(vaultPath, dir);
    const existed = await exists(absolute);
    await fsp.mkdir(absolute, { recursive: true });
    if (!existed) createdDirectories.push(dir);
  }

  await writeFileIfMissing(vaultPath, preview.rulesFilePath, buildKnowledgeBaseRulesTemplate(now), createdFiles, skippedFiles);
  await writeFileIfMissing(vaultPath, "wiki/index.md", buildWikiIndexTemplate(now), createdFiles, skippedFiles);
  await writeFileIfMissing(vaultPath, "raw/index.md", buildRawIndexTemplate(now), createdFiles, skippedFiles);
  await writeFileIfMissing(vaultPath, "outputs/.ingest-tracker.md", buildTrackerTemplate(now), createdFiles, skippedFiles);
  for (const domain of WIKI_DOMAINS) {
    await writeFileIfMissing(vaultPath, `wiki/${domain.id}/00-索引.md`, buildDomainIndexTemplate(domain, now), createdFiles, skippedFiles);
  }

  const result: Omit<KnowledgeBaseInitializationResult, "summary"> = {
    status: "initialized",
    templateVersion: KNOWLEDGE_BASE_TEMPLATE_VERSION,
    rulesFilePath: preview.rulesFilePath,
    createdDirectories,
    createdFiles,
    skippedFiles
  };
  return {
    ...result,
    summary: formatKnowledgeBaseInitializationResult(result)
  };
}

export function formatKnowledgeBaseInitializationPreview(input: Omit<KnowledgeBaseInitializationPreview, "summary">): string {
  return [
    "## LLM Wiki 初始化预览",
    "",
    `一眼结论：将按通用 LLM Wiki 模板初始化当前 vault，预览阶段不会写入文件。`,
    "",
    `- 模板版本：${input.templateVersion}`,
    `- 将生成规则文件：${input.rulesFilePath}`,
    `- 将创建目录：${input.directories.length} 个`,
    `- 将创建索引/记录文件：${input.indexFiles.length} 个`,
    `- 已有笔记建议：${input.suggestions.length} 条，仅建议，不会移动`,
    "",
    "## 安全边界",
    "- 不删除文件。",
    "- 不覆盖已有文件。",
    "- 不移动已有笔记。",
    "- 不修改 raw/ 原始资料整文件。",
    "",
    "## 确认执行",
    "发送 `/init confirm` 后才会创建目录和规则文件。"
  ].join("\n");
}

function formatKnowledgeBaseInitializationResult(input: Omit<KnowledgeBaseInitializationResult, "summary">): string {
  return [
    "## LLM Wiki 初始化完成",
    "",
    `一眼结论：已创建标准目录和规则文件；已有文件未覆盖，已有笔记未移动。`,
    "",
    `- 规则文件：${input.rulesFilePath}`,
    `- 新建目录：${input.createdDirectories.length} 个`,
    `- 新建文件：${input.createdFiles.length} 个`,
    `- 已存在未覆盖：${input.skippedFiles.length} 个`,
    "",
    "下一步建议：发送 `/check 初始化后体检当前 vault，只报告问题，不移动文件，不删除文件。`"
  ].join("\n");
}

function chooseRulesFilePath(): string {
  return DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
}

async function scanInitializationSuggestions(vaultPath: string): Promise<KnowledgeBaseInitializationSuggestion[]> {
  const files = await walkVaultFiles(vaultPath, 220).catch(emptyArrayOnMissingPathOrWarn("walk vault files for knowledge base initialization"));
  const suggestions: KnowledgeBaseInitializationSuggestion[] = [];
  for (const filePath of files) {
    const relativePath = normalizeSlashes(path.relative(vaultPath, filePath));
    const firstPart = relativePath.split("/")[0];
    if (!relativePath || KNOWN_TOP_LEVEL_DIRS.has(firstPart)) continue;
    suggestions.push(await classifyExistingFile(filePath, relativePath));
  }
  return suggestions.slice(0, 80);
}

async function classifyExistingFile(filePath: string, relativePath: string): Promise<KnowledgeBaseInitializationSuggestion> {
  const lower = relativePath.toLowerCase();
  const ext = path.extname(lower);
  const sample = ext === ".md" || ext === ".markdown" || ext === ".txt"
    ? await fsp.readFile(filePath, "utf8").then((text) => text.slice(0, 4000), () => "")
    : "";
  const haystack = `${lower}\n${sample}`;
  if (/\.(png|jpe?g|webp|gif|pdf|docx)$/.test(lower)) return { path: relativePath, target: "raw/attachments", reason: "附件或文档资料应先进入 raw/attachments" };
  if (/日记|周记|月记|复盘|journal|daily|weekly|monthly/.test(haystack)) return { path: relativePath, target: "journal", reason: "时间线内容建议进入 journal" };
  if (/prd|项目|需求|会议|roadmap|spec|design doc|project/.test(haystack)) return { path: relativePath, target: "projects", reason: "项目资料建议进入 projects" };
  if (/输出|发布|文章草稿|小红书|公众号|周报|报告|draft|output|post/.test(haystack)) return { path: relativePath, target: "outputs", reason: "协作产出建议进入 outputs" };
  if (/https?:\/\/|剪藏|转载|原文|source|article|clip/.test(haystack)) return { path: relativePath, target: "raw/articles", reason: "外部来源建议进入 raw/articles" };
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") return { path: relativePath, target: "inbox", reason: "未明确归属的文本先进入 inbox 等待分流" };
  return { path: relativePath, target: "ignore", reason: "暂不处理的系统或未知文件" };
}

async function walkVaultFiles(root: string, maxFiles: number): Promise<string[]> {
  return walkFiles(root, {
    maxFiles,
    shouldSkipEntry: (entry, full) => {
      if (entry.name.startsWith(".") && entry.name !== ".ingest-tracker.md") return true;
      if (!entry.isDirectory()) return false;
      const relative = normalizeSlashes(path.relative(root, full));
      const firstPart = relative.split("/")[0];
      return KNOWN_TOP_LEVEL_DIRS.has(firstPart);
    }
  });
}

async function writeFileIfMissing(vaultPath: string, relativePath: string, content: string, createdFiles: string[], skippedFiles: string[]): Promise<void> {
  const absolute = path.join(vaultPath, relativePath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  if (await exists(absolute)) {
    skippedFiles.push(relativePath);
    return;
  }
  await fsp.writeFile(absolute, content, "utf8");
  createdFiles.push(relativePath);
}

export function buildKnowledgeBaseRulesTemplate(now: Date): string {
  return buildVaultProfileTemplate(now);
}

function buildWikiIndexTemplate(now: Date): string {
  return [
    "---",
    `created: ${formatDateTime(now)}`,
    `updated: ${formatDateTime(now)}`,
    "type: index",
    "---",
    "",
    "# Wiki 知识索引",
    "",
    "> AI 维护的结构化知识库。每个领域至少包含一个领域索引页。",
    "",
    "## 领域",
    "",
    ...WIKI_DOMAINS.map((domain) => `- [[${domain.id}/00-索引|${domain.title}]] — ${domain.description}`),
    ""
  ].join("\n");
}

function buildRawIndexTemplate(now: Date): string {
  return [
    "---",
    `created: ${formatDateTime(now)}`,
    `updated: ${formatDateTime(now)}`,
    "type: index",
    "---",
    "",
    "# 原始资料索引",
    "",
    "> 原始资料层。知识库维护时正文、标题、路径、附件只读，插件可写托管元属性，不自动移动；从这里提炼后必须进入 Wiki / Projects 正文并保留来源证据。普通 Agent 对话可按用户明确指令整理 raw 文件。",
    "",
    "## articles/",
    "",
    "文章、网页、博客、公众号、README 等文本资料。",
    "",
    "- `github-trending/`：GitHub Trending 简报。",
    "- `openai-docs/`：OpenAI 官方文档。",
    "- `wechat-official-accounts/`：微信公众号全文归档。",
    "- `feishu-docs/`：飞书文档摘录。",
    "- `investment/`：投资和策略原始资料。",
    "",
    "## clippings/",
    "",
    "剪藏、摘录、标注；文章剪藏优先进入 `clippings/articles/`。",
    "",
    "## attachments/",
    "",
    "PDF、图片、DOCX 等附件资料。",
    ""
  ].join("\n");
}

function buildTrackerTemplate(now: Date): string {
  return [
    "---",
    `created: ${formatDateTime(now)}`,
    "source: codex-echoink",
    "---",
    "",
    "# Ingest Tracker",
    "",
    "<!-- codex-echoink-kb:start -->",
    "",
    `## Codex EchoInk 处理记录（${formatDateTime(now)}）`,
    "",
    "- 暂无",
    "",
    "<!-- codex-echoink-kb:end -->",
    ""
  ].join("\n");
}

function buildDomainIndexTemplate(domain: WikiDomainTemplate, now: Date): string {
  return [
    "---",
    `created: ${formatDate(now)}`,
    `updated: ${formatDateTime(now)}`,
    "type: index",
    "---",
    "",
    `# ${domain.title} — 索引`,
    "",
    `> ${domain.description}`,
    "",
    "## 概念",
    "",
    "## 指南",
    "",
    "## 参考",
    ""
  ].join("\n");
}

function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function assertAllowedRulesFilePath(relativePath: string): void {
  if (relativePath === DEFAULT_KNOWLEDGE_BASE_RULES_FILE || relativePath === AGENTS_RULES_FILE || relativePath === LEGACY_CLAUDE_RULES_FILE || relativePath === "CLAUDE.kb-template.md") return;
  throw new Error("初始化规则文件路径不合法。");
}

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseSettings } from "../settings/settings";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "./constants";
import { buildKnowledgeBaseRulesTemplate, KNOWLEDGE_BASE_TEMPLATE_VERSION } from "./initializer";

export type KnowledgeBaseRulesRepairStatus = "created" | "patched" | "ok";

export interface KnowledgeBaseRulesRepairResult {
  status: KnowledgeBaseRulesRepairStatus;
  rulesFilePath: string;
  missingRules: string[];
  summary: string;
}

type RulesSettings = Pick<KnowledgeBaseSettings, "useCustomRulesFile" | "rulesFilePath">;

const MINIMUM_RULES_MARKER = "<!-- codex-echoink-kb-minimum-rules:start -->";
const MINIMUM_RULES_END_MARKER = "<!-- codex-echoink-kb-minimum-rules:end -->";

const MINIMUM_RULE_CHECKS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "raw/ 管理只读边界", patterns: [/raw\//i, /(知识库管理|维护任务|维护动作|维护、提炼、体检)/, /(只读|禁止删除|禁止移动|禁止改写|不修改正文)/] },
  { label: "raw/ 普通对话授权边界", patterns: [/raw\//i, /(普通 Agent 对话|普通对话)/, /(明确要求|用户指令|按用户)/] },
  { label: "wiki/ 长期知识区", patterns: [/wiki\//i, /(结构化知识|长期知识|主要工作区|可读写|读写)/] },
  { label: "wiki/index.md 索引入口", patterns: [/wiki\/index\.md/i] },
  { label: "outputs/.ingest-tracker.md 追踪记录", patterns: [/outputs\/\.ingest-tracker\.md|ingest-tracker/i] },
  { label: "维护报告写入 outputs/", patterns: [/(维护报告|体检报告|报告写入|每日知识库维护报告)/, /outputs\//i] },
  { label: "禁止删除文件", patterns: [/(禁止删除|不得删除|不删除)/] }
];

export async function repairKnowledgeBaseRulesFile(
  vaultPath: string,
  settings: RulesSettings,
  now = new Date()
): Promise<KnowledgeBaseRulesRepairResult> {
  const rulesFilePath = resolveKnowledgeBaseRulesFilePath(settings);
  const absolutePath = resolveVaultFilePath(vaultPath, rulesFilePath);
  const existed = await exists(absolutePath);
  if (!existed) {
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsp.writeFile(absolutePath, buildKnowledgeBaseRulesTemplate(now), "utf8");
    return {
      status: "created",
      rulesFilePath,
      missingRules: [],
      summary: `已创建知识库指南：${rulesFilePath}`
    };
  }

  const current = await fsp.readFile(absolutePath, "utf8");
  const missingRules = detectMissingKnowledgeBaseRules(current);
  if (!missingRules.length) {
    return {
      status: "ok",
      rulesFilePath,
      missingRules: [],
      summary: `知识库指南可用：${rulesFilePath}`
    };
  }

  const minimumBlock = buildKnowledgeBaseMinimumRulesBlock(now);
  const patched = replaceMinimumRulesBlock(current, minimumBlock) ?? `${current.trimEnd()}\n\n${minimumBlock}`;
  await fsp.writeFile(absolutePath, patched, "utf8");
  return {
    status: "patched",
    rulesFilePath,
    missingRules,
    summary: `已补齐知识库指南：${rulesFilePath}`
  };
}

export function detectMissingKnowledgeBaseRules(content: string): string[] {
  return MINIMUM_RULE_CHECKS
    .filter((check) => !check.patterns.every((pattern) => pattern.test(content)))
    .map((check) => check.label);
}

export function resolveKnowledgeBaseRulesFilePath(settings: RulesSettings): string {
  const rawPath = settings.useCustomRulesFile ? settings.rulesFilePath : AGENTS_RULES_FILE;
  const clean = normalizeRulesPath(rawPath);
  if (!/\.md$/i.test(clean)) throw new Error("知识库指南必须是当前 Vault 内的 Markdown 文件。");
  return clean;
}

function buildKnowledgeBaseMinimumRulesBlock(now: Date): string {
  const stamp = now.toISOString().slice(0, 16);
  return [
    MINIMUM_RULES_MARKER,
    "",
    `## Codex 知识库最小运行规则`,
    "",
    `> 自动补齐时间：${stamp}。模板版本：${KNOWLEDGE_BASE_TEMPLATE_VERSION}。`,
    "",
    "### 目录职责",
    "",
    "- `raw/` 是原始资料与待整理来源区；知识库管理任务中只读，除 `raw/index.md` 外不修改正文。",
    "- 普通 Agent 对话中，如果用户明确要求整理 `raw/`，例如移动、删除、合并、重命名或重新归类 raw 文件，可以按用户指令和当前权限执行。",
    "- `wiki/` 是长期结构化知识区，是 Agent 的主要读写工作区。",
    "- `wiki/index.md` 是知识库入口；领域索引使用 `wiki/<领域>/00-索引.md`。",
    "- `outputs/` 用来保存维护报告、协作产物和 `outputs/.ingest-tracker.md`。",
    "- `inbox/` 是临时入口，只能整理和分流；需要移动、删除或归档时先让用户确认。",
    "",
    "### 每日维护流程",
    "",
    "1. 先读取本规则文件、`raw/index.md`、`wiki/index.md`、`outputs/.ingest-tracker.md`。",
    "2. 用文件修改时间和 tracker 对比，找出新增或变更的 `raw/` 文件；跳过 `.base` 和附件缓存目录。",
    "3. 将可消化内容写入 `wiki/<领域>/`，保留 raw 来源回链，补充关键概念和相关 wiki 双向链接。",
    "4. 更新受影响的领域索引、`wiki/index.md`、`raw/index.md` 和 `outputs/.ingest-tracker.md`。",
    "5. 执行 Lint：检查断链、孤儿页、过时或 draft 内容、索引链接有效性。",
    "6. 把维护报告写入 `outputs/`，包含新增/变更文件、已消化内容、体检发现和状态。",
    "",
    "### 安全边界",
    "",
    "- 知识库维护、提炼、体检任务中禁止删除、移动或改写 `raw/` 原文。",
    "- 不要把知识库管理任务的 raw 只读边界扩展成普通 Agent 对话的全局限制。",
    "- 无法判断归属领域时先跳过并在报告中说明。",
    "- 默认中文回复；先结论，再依据；不编造来源。",
    "",
    MINIMUM_RULES_END_MARKER
  ].join("\n");
}

function replaceMinimumRulesBlock(content: string, replacement: string): string | null {
  const start = content.indexOf(MINIMUM_RULES_MARKER);
  const end = content.indexOf(MINIMUM_RULES_END_MARKER);
  if (start < 0 || end < start) return null;
  const endWithMarker = end + MINIMUM_RULES_END_MARKER.length;
  return `${content.slice(0, start).trimEnd()}\n\n${replacement}\n\n${content.slice(endWithMarker).trimStart()}`.trimEnd();
}

function resolveVaultFilePath(vaultPath: string, relativePath: string): string {
  const vaultRoot = path.resolve(vaultPath);
  const absolutePath = path.resolve(vaultRoot, relativePath);
  if (absolutePath !== vaultRoot && !absolutePath.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new Error("知识库指南路径必须在当前 Vault 内。");
  }
  return absolutePath;
}

function normalizeRulesPath(value: string): string {
  const clean = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
}

async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

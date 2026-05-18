import * as os from "os";
import * as path from "path";
import type {
  CodexSkill,
  PermissionMode,
  ProcessEventSummary,
  ProcessFileRef,
  ReasoningEffort,
  SandboxPolicy,
  ServiceTierChoice,
  TokenUsage,
  UiMode,
  UserInput
} from "../types/app-server";
import type { StoredAttachment } from "../settings/settings";

export const DEFAULT_REPLY_STYLE_INSTRUCTION =
  "回复格式要求：使用中文；先给结论，再给关键依据；短段落；能用列表就用列表；对比、取舍、验收项优先用 Markdown 表格；避免整段长文。";

export function normalizeServiceTier(value: ServiceTierChoice): "fast" | "flex" | null {
  if (value === "fast" || value === "flex") return value;
  return null;
}

export function buildSandboxPolicy(mode: PermissionMode, vaultPath: string, writableRootsOverride?: string[]): SandboxPolicy {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") {
    return {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: false
    };
  }

  const writableRoots = [...(writableRootsOverride?.length ? writableRootsOverride : [vaultPath]), os.tmpdir(), process.env.TMPDIR].filter((item): item is string => {
    return typeof item === "string" && item.trim().length > 0;
  });

  return {
    type: "workspaceWrite",
    writableRoots: Array.from(new Set(writableRoots)),
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

export function buildCollaborationMode(mode: UiMode, model: string | null | undefined, effort: ReasoningEffort) {
  if (mode !== "plan") return null;
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  return {
    mode: "plan",
    settings: {
      ...(trimmedModel ? { model: trimmedModel } : {}),
      reasoning_effort: effort,
      developer_instructions: null
    }
  };
}

export function buildUserInput(text: string, attachments: StoredAttachment[], skill?: CodexSkill | null, styleInstruction = DEFAULT_REPLY_STYLE_INSTRUCTION): UserInput[] {
  const input: UserInput[] = [];
  if (skill) {
    input.push({ type: "skill", name: skill.name, path: skill.path });
  }
  if (styleInstruction.trim()) {
    input.push({ type: "text", text: styleInstruction.trim(), text_elements: [] });
  }
  const attachmentContext = buildAttachmentContext(attachments);
  if (attachmentContext) {
    input.push({ type: "text", text: attachmentContext, text_elements: [] });
  }
  const trimmed = text.trim();
  if (trimmed) {
    input.push({ type: "text", text: trimmed, text_elements: [] });
  }
  for (const attachment of attachments) {
    if (attachment.type === "image") {
      input.push({ type: "localImage", path: attachment.path });
    } else {
      input.push({ type: "mention", name: attachment.name, path: attachment.path });
    }
  }
  return input;
}

export function buildAttachmentContext(attachments: StoredAttachment[]): string {
  const files = attachments.filter((attachment) => attachment.type === "file");
  if (!files.length) return "";
  const lines = files.map((file) => `- ${file.name}: ${file.path}`);
  return [
    "用户已附带以下文件作为本轮上下文。",
    "这些附件只作为上下文，不代表本轮工作区；如需读写文件，必须以会话工作区为准。",
    "如果用户说“当前笔记”“这个文档”“已添加的笔记”，优先指这些文件；请直接读取这些路径，不要再猜测当前文档。",
    ...lines
  ].join("\n");
}

export function getSlashQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)\/([^\s/]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function filterSkills(skills: CodexSkill[], query: string): CodexSkill[] {
  const q = query.trim().toLowerCase();
  return skills
    .filter((skill) => skill.enabled !== false)
    .filter((skill) => {
      if (!q) return true;
      return skill.name.toLowerCase().includes(q) || (skill.description || "").toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 12);
}

export function contextPercent(totalTokens?: number, contextWindow?: number | null): number {
  if (!totalTokens || !contextWindow || contextWindow <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((totalTokens / contextWindow) * 100)));
}

export function contextUsageTokens(tokenUsage?: TokenUsage): { currentTokens: number; cumulativeTokens: number } {
  const cumulativeTokens = tokenUsage?.total?.totalTokens ?? 0;
  const currentTokens = tokenUsage?.last?.totalTokens ?? tokenUsage?.last?.inputTokens ?? cumulativeTokens;
  return { currentTokens, cumulativeTokens };
}

export function contextUsageView(tokenUsage?: TokenUsage): {
  percent: number | null;
  label: string;
  totalTokens: number;
  contextWindow: number | null;
  angle: number;
  title: string;
} {
  const { currentTokens, cumulativeTokens } = contextUsageTokens(tokenUsage);
  const contextWindow = tokenUsage?.modelContextWindow ?? null;
  if (!currentTokens || !contextWindow || contextWindow <= 0) {
    return {
      percent: null,
      label: "--",
      totalTokens: currentTokens,
      contextWindow,
      angle: 0,
      title: "暂未读取到上下文容量"
    };
  }
  const percent = contextPercent(currentTokens, contextWindow);
  const titleLines = [`上下文 ${percent}%，${currentTokens} / ${contextWindow} tokens`];
  if (cumulativeTokens && cumulativeTokens !== currentTokens) titleLines.push(`累计消耗 ${cumulativeTokens} tokens`);
  return {
    percent,
    label: `${percent}%`,
    totalTokens: currentTokens,
    contextWindow,
    angle: percent * 3.6,
    title: titleLines.join("\n")
  };
}

export function basename(filePath: string): string {
  return path.basename(filePath);
}

export function normalizeProcessFileRef(rawPath: string, vaultPath: string, basePath?: string): ProcessFileRef {
  const cleaned = cleanCandidatePath(rawPath);
  const normalizedVault = path.resolve(vaultPath || "/");
  if (!cleaned) {
    return {
      name: "未知文件",
      path: "",
      displayPath: "未知文件",
      kind: "unknown",
      openable: false
    };
  }

  if (path.isAbsolute(cleaned)) {
    const absolutePath = path.normalize(cleaned);
    const relative = path.relative(normalizedVault, absolutePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      const displayPath = normalizeSlashes(relative);
      return {
        name: path.basename(displayPath),
        path: displayPath,
        displayPath,
        kind: "vault",
        openable: true,
        absolutePath
      };
    }
    return {
      name: path.basename(absolutePath),
      path: absolutePath,
      displayPath: absolutePath,
      kind: "external",
      openable: true,
      absolutePath
    };
  }

  const displayPath = normalizeSlashes(cleaned.replace(/^\.\//, ""));
  if (basePath && looksLikePath(displayPath)) {
    return normalizeProcessFileRef(path.resolve(basePath, displayPath), vaultPath);
  }
  return {
    name: path.basename(displayPath),
    path: displayPath,
    displayPath,
    kind: looksLikePath(displayPath) ? "vault" : "unknown",
    openable: looksLikePath(displayPath)
  };
}

export function extractProcessFileRefs(value: unknown, vaultPath: string, basePath?: string): ProcessFileRef[] {
  const text = collectSearchableText(value);
  const candidates = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s"'`([{])((?:\.{1,2}\/)?(?:[\w\u4e00-\u9fa5@+.-]+\/)+[\w\u4e00-\u9fa5@+.-]+\.[\w.-]+)/g)) {
    candidates.add(match[1]);
  }
  for (const match of text.matchAll(/(?:^|[\s"'`([{])((?:\/Users|\/Volumes|\/private|\/tmp|\/var|\/opt|\/usr|\/Applications)\/[^\s"'`)\]}<>]+)/g)) {
    candidates.add(match[1]);
  }

  const seen = new Set<string>();
  const refs: ProcessFileRef[] = [];
  for (const candidate of candidates) {
    const ref = normalizeProcessFileRef(candidate, vaultPath, basePath);
    const key = `${ref.kind}:${ref.path}`;
    if (!ref.openable || seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs.slice(0, 8);
}

export function summarizeProcessEvent(itemType: string, payload: any, vaultPath: string, basePath?: string): ProcessEventSummary {
  const files = extractProcessFileRefs(payload, vaultPath, basePath);
  if (itemType === "reasoning") {
    const text = reasoningTextFromPayload(payload);
    const running = payload?.status === "running" || payload?.status === "in_progress" || payload?.status === "inProgress";
    return {
      title: running ? "正在思考" : "已思考",
      detail: compactText(text || (running ? "正在接收思考过程" : "整理了思考过程")),
      files,
      defaultOpen: true,
      kind: "reasoning"
    };
  }
  if (itemType === "plan") {
    return {
      title: "更新计划",
      detail: "整理当前步骤和进度",
      files,
      defaultOpen: true,
      kind: "plan"
    };
  }
  if (itemType === "fileChange") {
    return {
      title: "编辑文件",
      detail: files.length ? `涉及 ${files.length} 个文件` : "记录文件改动",
      files,
      defaultOpen: false,
      kind: "edit"
    };
  }
  if (itemType === "mcpToolCall") {
    const toolName = [payload?.server, payload?.tool].filter(Boolean).join(".");
    return {
      title: toolName ? `使用工具：${toolName}` : "使用工具",
      detail: compactText(payload?.message ?? payload?.status ?? "调用外部工具"),
      files,
      defaultOpen: false,
      kind: "tool"
    };
  }
  if (itemType === "dynamicToolCall" || itemType === "collabAgentToolCall") {
    const toolName = [payload?.namespace, payload?.tool].filter(Boolean).join(".");
    return {
      title: toolName ? `使用工具：${toolName}` : "使用工具",
      detail: compactText(payload?.message ?? payload?.status ?? "调用工具"),
      files,
      defaultOpen: false,
      kind: "tool"
    };
  }
  if (itemType === "commandExecution") {
    const commandText = String(payload?.command ?? payload?.text ?? payload ?? "");
    const command = commandSummary(commandText);
    return {
      title: command.title,
      detail: command.detail || compactText(commandText || payload?.status || "执行命令"),
      files,
      defaultOpen: false,
      kind: command.kind
    };
  }
  return {
    title: "处理过程",
    detail: compactText(payload?.message ?? payload?.status ?? "记录执行过程"),
    files,
    defaultOpen: false,
    kind: "other"
  };
}

export function processGroupStateId(items: Array<{ id?: string; runId?: string }>): string {
  const first = items[0];
  const last = items[items.length - 1];
  return `group-${first?.runId ?? "none"}-${first?.id ?? "process"}-${last?.id ?? first?.id ?? "process"}-${items.length}`;
}

export function reasoningTextFromPayload(payload: any): string {
  return joinTextFragments([payload?.text, payload?.summary, payload?.content]);
}

function commandSummary(command: string): { title: string; detail: string; kind: ProcessEventSummary["kind"] } {
  const trimmed = command.trim();
  const targetName = commandTargetName(trimmed);
  if (/\b(rg|grep|find|fd)\b/.test(trimmed)) return { title: "搜索文件", detail: targetName ? `搜索 ${targetName}` : "搜索文件", kind: "search" };
  if (/\b(sed|cat|less|head|tail|nl|wc|ls)\b/.test(trimmed)) return { title: "查看文件", detail: targetName ? `Read ${targetName}` : "Read files", kind: "view" };
  if (/\b(apply_patch)\b/.test(trimmed)) return { title: "编辑文件", detail: "已编辑文件", kind: "edit" };
  if (/\b(python|node|npm|pnpm|yarn|swift|xcodebuild|tsc|eslint|vitest|jest|pytest|cargo|go test)\b/.test(trimmed)) return { title: "运行检查", detail: `已运行 ${compactCommand(trimmed)}`, kind: "run" };
  return { title: "使用命令", detail: `已运行 ${compactCommand(trimmed)}`, kind: "command" };
}

function commandTargetName(command: string): string {
  const refs = extractProcessFileRefs(command, "");
  if (!refs.length) return "";
  return refs[refs.length - 1].name;
}

function compactCommand(command: string): string {
  const firstLine = command.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
}

function collectSearchableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(collectSearchableText).join("\n");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(collectSearchableText).join("\n");
  }
  return "";
}

function cleanCandidatePath(value: string): string {
  return value
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/[,:;]+$/, "")
    .replace(/^['"`]+|['"`]+$/g, "");
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || /\.[a-z0-9]{1,8}$/i.test(value);
}

function joinTextFragments(values: unknown[]): string {
  const fragments: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) fragments.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") fragments.push(String(value));
  };
  for (const value of values) visit(value);
  return fragments.join("\n").trim();
}

function compactText(value: string): string {
  const compacted = String(value || "").replace(/\s+/g, " ").trim();
  if (!compacted) return "";
  return compacted.length > 96 ? `${compacted.slice(0, 95)}...` : compacted;
}

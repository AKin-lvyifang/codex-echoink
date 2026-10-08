import type { PermissionMode } from "../../types/app-server";
import type { PiChatMode, PiConversationMemoryMode } from "./contracts";
import { normalizeObsidianCliRequest, obsidianCliEffect } from "./obsidian-cli-policy";

export interface PiWorkspaceAccess {
  readonly permission: PermissionMode;
  readonly mode: PiChatMode;
  readonly memoryMode: PiConversationMemoryMode;
}

export function normalizePiWorkspacePermission(value: unknown): PermissionMode {
  return value === "workspace-write" || value === "danger-full-access"
    ? value
    : "read-only";
}

const CONTENT_READ_TOOLS = new Set([
  "vault_search", "note_read", "knowledge_search", "knowledge_read",
  "memory_search", "memory_read", "task_update", "user_question", "obsidian_context", "obsidian_cli", "obsidian_plugin_search"
]);

/** Commands describe intent. Only this turn's access and tool metadata grant capability. */
export function piWorkspaceAllowsTool(input: PiWorkspaceAccess & Readonly<{
  toolName: string;
  planToolNames: readonly string[];
  memoryToolNames: readonly string[];
  externalReadToolNames: readonly string[];
  toolArguments?: Record<string, unknown>;
}>): boolean {
  // Tool publication admits its read capability; dispatch checks the actual command again.
  if (input.toolName === "obsidian_cli" && input.toolArguments) {
    try {
      if (obsidianCliEffect(normalizeObsidianCliRequest(input.toolArguments)) !== "read"
        && (input.mode === "plan" || input.permission === "read-only")) return false;
    } catch { return false; }
  }
  if (input.memoryMode === "no_memory" && input.memoryToolNames.includes(input.toolName)) {
    return false;
  }
  if (input.mode === "plan") return input.planToolNames.includes(input.toolName);
  if (input.permission !== "read-only") return true;
  return CONTENT_READ_TOOLS.has(input.toolName)
    || input.externalReadToolNames.includes(input.toolName);
}

export function piWorkspaceAccessPrompt(access: PiWorkspaceAccess): string {
  return [
    `本条消息冻结的工作区权限：${access.permission}。`,
    access.mode === "plan"
      ? "当前为 Plan：只分析和记录计划，不执行内容写入。"
      : access.permission === "read-only"
        ? "当前只读：可读取已准入的本地与外部资料；不得写入笔记、个人记忆、知识维护内容或执行外部副作用。"
        : "当前可使用已准入的读写工具；仅按用户写入意图和已有确认流程执行，遵守 Vault 范围。",
    "ask、maintain 和检索结果只描述任务与依据，不改变工作区权限。用户明确要求不要写入时必须遵守。"
  ].join("\n");
}

/**
 * agent-identity-state.ts — Agent 身份（名称 + 头像）数据模型。
 *
 * 身份与人格是两套状态（人格系统重构草案 §8 最新决定）：
 * - 名称和头像属于「Agent 身份」，不是人格 trait，也不是 Memory。
 * - 只有用户可以在设置中修改；做梦、对话、Memory、Provider 一律无权修改。
 * - 存储于 `.echoink/agents/echoink/agent-identity.json`
 *   （schema `echoink.agent-identity.v1`）。
 * - 身份不写入 settings.json，也不塞进 personality-state.json。
 */

import path from "node:path";
import {
  cognitiveJsonText,
  cognitiveReadJsonOrNull
} from "./cognitive-file-utils";

export * from "./agent-identity-model";
import { AGENT_IDENTITY_RELATIVE_PATH, defaultAgentIdentityState, parseAgentIdentityState, type AgentIdentityState } from "./agent-identity-model";

export function agentIdentityStateJson(state: AgentIdentityState): string {
  return cognitiveJsonText(state);
}

// ---------------------------------------------------------------------------
// Store (read + cache; writes go through the repository transaction)
// ---------------------------------------------------------------------------

export class AgentIdentityStateStore {
  readonly filePath: string;
  private cache: AgentIdentityState | null = null;

  constructor(storageRoot: string) {
    this.filePath = path.join(storageRoot, AGENT_IDENTITY_RELATIVE_PATH);
  }

  /** 读取落盘身份；文件不存在时返回默认运行状态（不自动写文件）。 */
  async read(): Promise<AgentIdentityState> {
    if (this.cache) return this.cache;
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    this.cache = raw ? parseAgentIdentityState(raw) ?? defaultAgentIdentityState() : defaultAgentIdentityState();
    return this.cache;
  }

  /** 当前缓存快照（未读取过时返回默认状态），供同步 UI 使用。 */
  peek(): AgentIdentityState {
    return this.cache ?? defaultAgentIdentityState();
  }

  /** 事务提交成功后更新缓存。 */
  updateCache(state: AgentIdentityState): void {
    this.cache = state;
  }

  invalidate(): void {
    this.cache = null;
  }
}

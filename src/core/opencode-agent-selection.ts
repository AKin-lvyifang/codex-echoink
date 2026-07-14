import type { AgentProfileInfo } from "../agent/types";

export function requireDirectOpenCodeAgent(requestedAgent: string, availableAgents: AgentProfileInfo[]): AgentProfileInfo {
  const requested = normalizeOpenCodeAgentName(requestedAgent);
  const selected = availableAgents.find((agent) =>
    [agent.id, agent.name, agent.displayName].some((value) => normalizeOpenCodeAgentName(value) === requested)
  );
  if (!selected) throw new Error(`OpenCode Agent 不存在：${requestedAgent}`);
  if (selected.mode === "subagent") {
    throw new Error(`OpenCode Agent ${selected.displayName || selected.name} 是后端内部子代理，不能直接执行增强提示词；请选择 primary Agent，或留空使用内置 enhance-prompt。`);
  }
  return selected;
}

export function assertOpenCodeAgentSelection(requestedAgent: string, effectiveAgent: string): void {
  if (!requestedAgent.trim()) return;
  if (!effectiveAgent.trim()) {
    throw new Error(`OpenCode 未返回实际 Agent，无法确认已按设置使用 ${requestedAgent}`);
  }
  if (normalizeOpenCodeAgentName(requestedAgent) === normalizeOpenCodeAgentName(effectiveAgent)) return;
  throw new Error(`OpenCode 未按设置使用 Agent：请求 ${requestedAgent}，实际 ${effectiveAgent}`);
}

function normalizeOpenCodeAgentName(value: string): string {
  return value.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim().toLowerCase();
}

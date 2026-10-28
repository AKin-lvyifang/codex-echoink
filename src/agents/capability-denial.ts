/** User-facing copy shared by submission and resume checks. Keep internal faults separate. */
export function agentCapabilityDenialText(reason: string, capability: string, language: string): string {
  const en = language === "en";
  const names: Record<string, [string, string]> = { knowledge: ["知识库", "Knowledge"], journal: ["日记", "Journal"], todos: ["待办", "Tasks"], finance: ["财务", "Finance"], "english-diary": ["英文日记", "English diary"], "pdf-reading": ["PDF 精读", "PDF reading"], review: ["复盘", "Review"], "web-search": ["联网搜索", "Web search"] };
  const label = names[capability]?.[en ? 1 : 0] ?? (capability.startsWith("mcp:") ? "MCP" : capability.startsWith("vault-skill:") ? (en ? "Skill" : "我的 Skill") : (en ? "This capability" : "这项能力"));
  const messages: Record<string, [string, string]> = {
    agent_missing: ["负责这件事的 Agent 已不存在。", "The assigned Agent no longer exists."],
    agent_disabled: [`${label}能力已被关闭，请开启后再继续。`, `${label} is disabled for this Agent. Enable it before continuing.`],
    module_disabled: [`${label}已关闭，请开启后再继续。`, `${label} is disabled. Enable it before continuing.`],
    pro_required: [`继续使用${label}需要 PRO。`, `Continuing with ${label} requires PRO.`],
    read_only: ["当前只允许读取，不能继续这项写入。", "The current workspace is read-only; this write cannot continue."],
    resource_disabled: ["这项工具或 Skill 已关闭，请开启后再继续。", "This tool or Skill is disabled. Enable it before continuing."],
    scope_required: ["这项操作没有可核对的范围，无法在当前能力下继续。", "This operation has no verifiable scope under the current capabilities."]
  };
  return (messages[reason] ?? ["这项操作当前不可用，请检查能力和工具设置后再继续。", "This operation is unavailable. Check capability and tool settings before continuing."])[en ? 1 : 0];
}

export class AgentCapabilityDeniedError extends Error {
  readonly code: string;
  constructor(readonly reason: string, readonly capabilityId: string, language?: string) {
    const code = `agent_capability_${reason}:${capabilityId}`;
    super(language ? agentCapabilityDenialText(reason, capabilityId, language) : code);
    this.code = code;
  }
}

export function knownAgentCapabilityDenial(error: unknown): { reason: string; capabilityId: string } | undefined {
  const value = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : typeof error === "string" ? error : "";
  const match = /^agent_capability_(agent_missing|agent_disabled|module_disabled|pro_required|read_only|resource_disabled|scope_required):(.+)$/u.exec(value);
  if (match) return { reason: match[1], capabilityId: match[2] };
  if (value === "agent_capability_agent_missing") return { reason: "agent_missing", capabilityId: "conversation" };
}

export function agentCapabilityErrorText(error: unknown, language: string): string | undefined {
  const denial = knownAgentCapabilityDenial(error);
  if (denial) return agentCapabilityDenialText(denial.reason, denial.capabilityId, language);
  const message = error instanceof Error ? error.message : error;
  if (message === "agent_capability_knowledge_denied") return language === "en"
    ? "Knowledge was unavailable for this turn. Check the Agent capabilities and Knowledge settings."
    : "本轮无法使用知识库，请检查 Agent 能力与知识库设置。";
}

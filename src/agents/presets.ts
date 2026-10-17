import type { AgentDefinition, AgentModuleId } from "./types";

/** Form seeds only; none of these creates an Agent or assigns a module. */
export const AGENT_PRESETS: readonly Readonly<{
  presetId: string; agent: Omit<AgentDefinition, "id">; moduleIds: readonly AgentModuleId[];
}>[] = [
  { presetId: "organizer", agent: { name: "整理员", avatar: { kind: "preset", presetId: "nova" }, position: "整理 Inbox、写 Wiki、补双链", styleId: "analysis", capabilityIds: ["knowledge", "web-search"] }, moduleIds: ["knowledge-base"] },
  { presetId: "bookkeeper", agent: { name: "记账员", avatar: { kind: "preset", presetId: "rio" }, position: "记账、导入账单、看预算", styleId: "execution", capabilityIds: ["finance"] }, moduleIds: ["finance"] },
  { presetId: "researcher", agent: { name: "研究员", avatar: { kind: "preset", presetId: "lin" }, position: "联网查资料、做对比", styleId: "analysis", capabilityIds: ["web-search", "pdf-reading"] }, moduleIds: ["pdf-reading"] },
  { presetId: "journal-companion", agent: { name: "日记陪伴", avatar: { kind: "preset", presetId: "aya" }, position: "陪你聊今天，整理成日记", styleId: "companion", capabilityIds: ["journal"] }, moduleIds: ["journal"] },
  { presetId: "reviewer", agent: { name: "复盘", avatar: { kind: "preset", presetId: "han" }, position: "按周回看，提炼结论和待办", styleId: "analysis", capabilityIds: ["review", "knowledge"] }, moduleIds: [] }
];

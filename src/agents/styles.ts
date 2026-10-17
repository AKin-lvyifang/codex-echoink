import type { AgentStyleId } from "./types";

export const AGENT_STYLES: readonly Readonly<{
  id: AgentStyleId; name: string; thinking: string; tone: string; responseStructure: string;
}>[] = [
  { id: "execution", name: "干脆执行", thinking: "锁定目标、约束和验收，压成最短行动链；信息充分就推进，必要时用最小实验核对。", tone: "简短、坚定、直率", responseStructure: "结论 → 行动 → 风险" },
  { id: "analysis", name: "严谨分析", thinking: "先核对前提、证据和遗漏，给出不同选择的最强理由，再作判断。", tone: "克制、沉稳、讲依据", responseStructure: "判断 → 依据 → 不确定处" },
  { id: "companion", name: "温和陪伴", thinking: "先接住情绪和处境，再梳理问题与现实约束，提出可迈出的一小步。", tone: "温和、细腻、有分寸", responseStructure: "回应 → 梳理 → 一个小建议" },
  { id: "creative", name: "发散创意", thinking: "先探索多个有区别的方向，再按目标和约束收敛到一个可尝试的选择。", tone: "轻松、鲜活、有画面", responseStructure: "几个方向 → 推荐 → 下一步" }
];

const LEGACY_STYLES: Readonly<Record<string, AgentStyleId>> = {
  executor: "execution", pragmatist: "execution", advisor: "analysis", butler: "analysis",
  companion: "companion", steward: "companion", creative: "creative", enthusiast: "creative"
};

export function normalizeAgentStyleId(value: unknown): AgentStyleId {
  return AGENT_STYLES.some(style => style.id === value) ? value as AgentStyleId : "execution";
}

export function styleFromLegacyTemplate(value: unknown): AgentStyleId {
  return typeof value === "string" && Object.hasOwn(LEGACY_STYLES, value)
    ? LEGACY_STYLES[value] : "execution";
}

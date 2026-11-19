import { getDecisionClient, type TurnJudgment, type TurnSkillOption } from "../membership/decision-client";

/**
 * 手机端智能判断：和桌面一样每轮一次 /turn（选技能、新鲜度、记账把关），记忆单独一次 /memory，
 * 两个请求带同一个 turnId（用排队轮次的 id，重试也不会重复扣）。拿不到结果时返回 null，调用方走原来的逻辑。
 */

/** Last three user / assistant texts of the session, for the judgment's context. */
export function recentMessageTexts(messages: readonly unknown[], limit = 3): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.map(part => { const value = part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? (part as { text?: unknown }).text : ""; return typeof value === "string" ? value : ""; }).join("")
      : "";
    if (text.trim()) texts.push(text.trim());
  }
  return texts.slice(-limit);
}

export async function judgeMobileTurn(input: { turnId: string; sessionId: string; text: string; recent: readonly string[]; skills: readonly TurnSkillOption[] }): Promise<TurnJudgment | null> {
  const client = getDecisionClient();
  if (!client?.ready() || !input.text.trim()) return null;
  return await client.judgeTurn({ turnId: input.turnId, conversationId: input.sessionId, text: input.text, recent: input.recent,
    skills: input.skills, checks: input.skills.length ? ["fresh", "financeWrite"] : ["financeWrite"] }).catch(() => null);
}

/** The cached /turn result of this queued turn; null when none was requested. */
export async function mobileTurnJudgment(turnId: string | undefined): Promise<TurnJudgment | null> {
  return await getDecisionClient()?.turnResult(turnId).catch(() => null) ?? null;
}

/** Skill decision for MobileSkillsService; undefined keeps the old rules. */
export function mobileSkillDecision(judged: TurnJudgment | null): { skillId: string | null; fresh?: boolean } | undefined {
  if (!judged?.skill) return undefined;
  const threshold = getDecisionClient()?.thresholds().fresh ?? 0.5;
  return { skillId: judged.skill.id, ...(judged.fresh !== undefined ? { fresh: judged.fresh >= threshold } : {}) };
}

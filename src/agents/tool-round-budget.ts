export const TOOL_ROUND_LIMIT = 60;
export const EXTENDED_TOOL_ROUND_LIMIT = 150;
export const TOOL_ROUND_STOP_MESSAGE = "模型一直在调用工具，已自动停止，可以发‘继续’接着做";
export const TOOL_ROUND_BLOCK_MESSAGE = "本次工具调用已达上限，不要再调用工具，用已有信息回答；查不到就直说。";

/** One accepted user input owns the budget, including all internal retries. */
export class ToolRoundBudget {
  private rounds = 0;
  private limit = TOOL_ROUND_LIMIT;
  upgrade(extended: boolean): void {
    if (extended) this.limit = EXTENDED_TOOL_ROUND_LIMIT;
  }
  block(): { block: true; reason: string } | undefined {
    return this.rounds >= this.limit ? { block: true, reason: TOOL_ROUND_BLOCK_MESSAGE } : undefined;
  }
  /** Called after the whole batch has results, including invalid/unknown calls. */
  endTurn(message: { role: string; content?: unknown }): boolean {
    if (message.role !== "assistant" || !Array.isArray(message.content)
      || !message.content.some((part: unknown) => part !== null && typeof part === "object" && "type" in part && part.type === "toolCall")) return false;
    return ++this.rounds >= this.limit + 3;
  }
}

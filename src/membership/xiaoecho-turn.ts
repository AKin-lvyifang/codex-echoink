export type XiaoechoPurpose = "conversation" | "tool_step" | "memory" | "title" | "skill_review" | "compaction" | "other";

export interface XiaoechoTurn {
  readonly conversationId: string;
  readonly turnId: string;
  readonly purpose: XiaoechoPurpose;
  readonly cache?: boolean;
  readonly shortReply?: boolean;
}

export function withXiaoechoTurn(payload: unknown, provider: string, turn: XiaoechoTurn | undefined): unknown {
  if (!turn || provider !== "xiaoecho" || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...payload, echoink_turn: {
    conversationId: turn.conversationId, turnId: turn.turnId, purpose: turn.purpose,
    ...(turn.purpose === "conversation" && turn.shortReply === true ? { shortReply: true } : {})
  } };
}

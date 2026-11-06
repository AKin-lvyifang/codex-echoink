import type { InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ToolRoundBudget } from "../../agents/tool-round-budget";

/** Compose the guard before the sole security handler; no extra tool handler. */
export function withToolRoundLimit(inline: InlineExtension, currentBudget: () => ToolRoundBudget | undefined,
  stop: () => void): InlineExtension {
  const factory = typeof inline === "function" ? inline : inline.factory;
  return {
    name: typeof inline === "function" ? "echoink-controlled" : inline.name,
    hidden: true,
    factory: async pi => {
      const guarded = new Proxy(pi, {
        get(target, property) {
          if (property !== "on") { const value: unknown = Reflect.get(target, property); return value; }
          return (event: string, handler: (...args: never[]) => unknown) => {
            if (event === "tool_call") {
              pi.on("tool_call", async (event, ctx) => currentBudget()?.block()
                ?? await handler(event as never, ctx as never) as ToolCallEventResult | undefined);
            } else (pi.on as (event: string, handler: (...args: never[]) => unknown) => void)(event, handler);
          };
        }
      });
      await factory(guarded);
      pi.on("turn_end", (event, ctx) => {
        if (currentBudget()?.endTurn(event.message)) {
          // The product stop path records the cause and clears queues. Never await idle here.
          stop();
          ctx.abort();
        }
      });
    }
  };
}

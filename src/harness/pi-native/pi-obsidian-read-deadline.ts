import type { Agent } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isObsidianCliRead } from "./obsidian-cli-policy";

const READ_DEADLINE_MS = 30_000;
const TIMEOUT_REASON = "obsidian_cli_timeout";
const CANCELLED_REASON = "obsidian_cli_cancelled";

interface ReadCall {
  signal: AbortSignal;
  parent?: AbortSignal;
  prepare(): ReturnType<NonNullable<Agent["beforeToolCall"]>>;
  blockedReason?: string;
}

async function waitForRead<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("obsidian_cli_read_stopped", { cause: signal.reason }));
    signal.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      try { resolve(await work()); }
      catch (error) { reject(error instanceof Error ? error : new Error("obsidian_cli_read_failed", { cause: error })); }
      finally { signal.removeEventListener("abort", onAbort); }
    })();
  });
}

function stoppedResult(call: ReadCall) {
  const cancelled = call.parent?.aborted === true;
  const status = cancelled ? "cancelled" : "failed";
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status, reason: cancelled ? CANCELLED_REASON : TIMEOUT_REASON }) }],
    details: { source: "echoink-obsidian", effect: "read", status },
    isError: true
  };
}

/** Pi waits for every beforeToolCall in order. Defer only read-only CLI checks
 * to the concurrent execution phase, where one stuck check cannot hold up unrelated reads. */
export class PiObsidianReadDeadline {
  private readonly calls = new Map<string, ReadCall>();

  constructor(private readonly discardCall: (id: string) => void, private readonly timeoutMs = READ_DEADLINE_MS) {}

  signalForCall(id: string): AbortSignal | undefined { return this.calls.get(id)?.signal; }

  install(agent: Pick<Agent, "subscribe" | "beforeToolCall" | "afterToolCall">): void {
    const before = agent.beforeToolCall;
    const after = agent.afterToolCall;
    const receivedAt = new WeakMap<object, number>();
    agent.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        receivedAt.set(event.message, performance.now());
      }
      if (event.type === "agent_end") {
        for (const id of this.calls.keys()) this.discardCall(id);
        this.calls.clear();
      }
    });
    agent.beforeToolCall = async (context, parent) => {
      const id = context.toolCall.id;
      if (!isObsidianCliRead(context.toolCall.name, context.args)) return await before?.(context, parent);
      if (this.calls.has(id)) return { block: true, reason: "authorization_failed" };
      const now = performance.now();
      const remaining = Math.ceil((receivedAt.get(context.assistantMessage) ?? now) + this.timeoutMs - now);
      if (remaining <= 0) return { block: true, reason: TIMEOUT_REASON };
      const deadline = AbortSignal.timeout(remaining);
      const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
      this.calls.set(id, { signal, parent, prepare: async () => await before?.(context, signal) });
      return undefined;
    };
    agent.afterToolCall = async (context, signal) => {
      const id = context.toolCall.id;
      const call = this.calls.get(id);
      if (!call) return await after?.(context, signal);
      try {
        if (call.blockedReason) {
          // Let the security extension drop its denied-call record.
          await waitForRead(call.signal, async () => await after?.(context, call.signal));
          return { content: [{ type: "text", text: call.blockedReason }], details: {}, isError: true };
        }
        return await waitForRead(call.signal, async () => await after?.(context, call.signal));
      } catch (error) {
        if (call.signal.aborted) return stoppedResult(call);
        throw error;
      } finally {
        this.discardCall(id);
        this.calls.delete(id);
      }
    };
  }

  wrapTool(tool: ToolDefinition): ToolDefinition {
    if (tool.name !== "obsidian_cli") return tool;
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate, context) => {
        const call = this.calls.get(id);
        if (!call) return await tool.execute(id, args, signal, onUpdate, context);
        try {
          return await waitForRead(call.signal, async () => {
            const prepared = await call.prepare();
            call.signal.throwIfAborted();
            if (prepared?.block) {
              call.blockedReason = prepared.reason || "Tool execution was blocked";
              return { content: [{ type: "text", text: call.blockedReason }], details: {} };
            }
            return await tool.execute(id, args, call.signal, onUpdate, context);
          });
        } catch (error) {
          if (call.signal.aborted) return stoppedResult(call);
          throw error;
        }
      }
    };
  }
}

import { knowledgeSystemTaskPrompt } from "../../knowledge-base/knowledge-system-prompt";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { type KnowledgeSystemTaskService } from "../../knowledge-base/knowledge-system-task";

export const KNOWLEDGE_SYSTEM_TOOLS = [
  "knowledge_system_read",
  "knowledge_system_propose",
] as const;
export function createKnowledgeSystemTools(
  service: KnowledgeSystemTaskService,
  conversationId: string,
) {
  return [
    defineTool({
      name: KNOWLEDGE_SYSTEM_TOOLS[0],
      label: "读取领域全文",
      description:
        "Read the next unread full-text chunk of this task's frozen domain. Repeat until read equals tot" +
        "al. Optional path/offset reuses a checkpoint, never skips unread text. This tool cannot write n" +
        "otes.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(_id, args) {
        const result = await service.readNext(conversationId, args.path, args.offset);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: { source: "knowledge-system", read: result.read, total: result.total },
        };
      },
    }),
    defineTool({
      name: KNOWLEDGE_SYSTEM_TOOLS[1],
      label: "提交知识体系提案",
      description:
        "Submit exactly two complete frameworks after reading every domain article. json is the JSON obj" +
        "ect specified by the system prompt, including per-entry reasons and short framework gaps. Saves" +
        " a versioned proposal for the user's confirmation card; cannot confirm, write or move notes.",
      parameters: Type.Object({ json: Type.String() }),
      async execute(_id, args) {
        const result = await service.propose(conversationId, JSON.parse(args.json));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: { source: "knowledge-system", ...result },
        };
      },
    }),
  ];
}
export function knowledgeSystemInlineExtension(
  service: KnowledgeSystemTaskService,
  conversationId: string,
  identity: () => Promise<string>,
): InlineExtension {
  return {
    name: "echoink-knowledge-system",
    hidden: true,
    factory: async (pi) => {
      pi.on("tool_call", async (event) =>
        KNOWLEDGE_SYSTEM_TOOLS.some((name) => name === event.toolName)
          ? undefined
          : { block: true, reason: "梳理会话只允许读取全文和提交提案。" },
      );
      pi.on("tool_result", async (event) =>
        KNOWLEDGE_SYSTEM_TOOLS.some((name) => name === event.toolName)
          ? undefined
          : { content: [{ type: "text", text: "梳理工具范围不匹配。" }], isError: true },
      );
      pi.on("before_agent_start", async (event) => {
        await service.ready;
        const task = service.forConversation(conversationId);
        if (!task) throw new Error("梳理任务暂不可用。");
        return {
          systemPrompt: `${event.systemPrompt}\n\n${await identity()}\n\n${knowledgeSystemTaskPrompt(task)}`,
        };
      });
    },
  };
}

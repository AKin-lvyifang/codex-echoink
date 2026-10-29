import type { AgentDefinition } from "../../agents/types";
import { isExpertAgent } from "../../agents/persona";
import { WORKSPACE_ROOT, workspacePath } from "../../workspace/service";
import { formatMobileDateTime } from "../../mobile/date-display";
import { shellElement } from "./shell-controls";

export function mobileExpertEvents(agent: AgentDefinition | undefined, conversationId: string): Array<{ id: string; at: number; text: string }> {
  if (!isExpertAgent(agent)) return [];
  return agent.expert.events.filter(event => event.conversationId === conversationId).map(event => ({ id: event.id, at: event.at,
    text: event.id === "disclosure" ? `我以${agent.name}的视角和你聊，依据公开著作与资料推断。` : `重新聘请 · ${formatMobileDateTime(event.at)}`
  })).sort((a, b) => a.at - b.at);
}

/** Use only a successful workspace receipt, never model text or arbitrary tool arguments. */
export function mobileWorkspacePreviewPath(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const message = result as { role?: string; toolName?: string; isError?: boolean; details?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (message.role !== "toolResult" || message.isError || !["workspace_create", "workspace_update"].includes(message.toolName ?? "")) return undefined;
  let value = message.details;
  if (!value) try { value = JSON.parse(message.content?.find(block => block.type === "text")?.text ?? "null") as unknown; } catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const path = (value as { previewPath?: unknown }).previewPath;
  if (typeof path !== "string" || !path.startsWith(`${WORKSPACE_ROOT}/`) || !/\.html$/iu.test(path)) return undefined;
  try { return workspacePath(path); } catch { return undefined; }
}

export function mobileAgentCreationChoice(document: Document, options: { create(): Promise<void>; hire(): Promise<void>; close(): void; error(error: unknown): void }): HTMLElement {
  const choices = shellElement(document, "div", "em-actions echoink-agent-creation-choices");
  for (const [label, action] of [["自己组建", () => options.create()], ["聘请专家", () => options.hire()]] as const) {
    const button = shellElement(document, "button", "em-wide-action", label); button.type = "button";
    button.addEventListener("click", () => { options.close(); void action().catch(error => options.error(error)); }); choices.append(button);
  }
  return choices;
}

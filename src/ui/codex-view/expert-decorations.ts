import { ownedDiv } from "../owned-dom";
import { Notice } from "obsidian";
import { isExpertAgent } from "../../agents/persona";
import { normalizeExpertDisclosure } from "../../experts/disclosure";
import type { AgentDefinition } from "../../agents/types";
import type { ChatMessage } from "../../settings/settings";
import { createOriginButton } from "../../settings/origin-controls";
import { workspacePath } from "../../workspace/service";
import type { MessageListRenderedRow } from "./message-list";

/** Only public lifecycle events and user-authored artifact paths reach this view. */
export function renderExpertConversationDecorations(root: HTMLElement, agent: AgentDefinition | undefined, conversationId: string,
  messages: readonly ChatMessage[], openPreview: (path: string) => Promise<void>, renderedRows?: readonly MessageListRenderedRow[]): void {
  for (const event of Array.from(root.querySelectorAll(".echoink-expert-event"))) event.remove();
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]"));
  const rowForMessage = (id: string) => renderedRows?.find(row => row.messageIds.includes(id))?.element
    ?? nodes.find(node => node.dataset.messageId === id)?.closest<HTMLElement>(".codex-virtual-row");
  const insertedBefore = new Map<HTMLElement, HTMLElement>();
  if (isExpertAgent(agent)) for (const event of agent.expert.events.filter(event => event.conversationId === conversationId).sort((a, b) => a.at - b.at)) {
    const following = messages.find(message => message.createdAt >= event.at);
    const anchor = following ? rowForMessage(following.id) : messages.length ? rowForMessage(messages[messages.length - 1].id) : root;
    // The event belongs to its timeline row. An offscreen anchor must never
    // turn an old declaration into a new event appended at the visible end.
    if (!anchor || !root.contains(anchor)) continue;
    const row = ownedDiv(root.ownerDocument); row.className = "echoink-expert-event";
    row.textContent = event.id === "disclosure" ? normalizeExpertDisclosure(agent.expert.disclosure) ?? `我以${agent.name}的视角和你聊，基于公开著作推断。`
      : `重新聘请 · ${new Date(event.at).toLocaleDateString()}`;
    if (!following) anchor.append(row);
    else {
      const previous = insertedBefore.get(anchor);
      if (previous) previous.after(row); else anchor.prepend(row);
      insertedBefore.set(anchor, row);
    }
  }
  for (const message of messages) {
    const node = nodes.find(node => node.dataset.messageId === message.id);
    if (!node || node.querySelector(".echoink-workspace-preview-action")) continue;
    if (message.role !== "tool" && message.itemType !== "toolCall" && message.processKind !== "tool") continue;
    const artifact = message.workspaceArtifact;
    if (message.status !== "completed" || artifact?.source !== "echoink-workspace" || !artifact.previewPath) continue;
    let path: string;
    try {
      path = workspacePath(artifact.previewPath);
      if (path !== artifact.path || path !== artifact.previewPath || !/\.html$/iu.test(path)) continue;
    } catch { continue; }
    const button = createOriginButton(node, { text: "预览", cls: "echoink-workspace-preview-action" });
    button.onclick = () => { void openPreview(path).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
  }
}

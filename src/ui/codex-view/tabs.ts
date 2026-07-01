import { setIcon } from "obsidian";
import type { StoredSession } from "../../settings/settings";
import { isKnowledgeBaseSession } from "../../settings/settings";

export interface CodexTabsCallbacks {
  onActivate: (session: StoredSession, knowledgeSession: boolean) => void;
  onContextMenu: (event: MouseEvent, session: StoredSession) => void;
  onRename: (session: StoredSession, knowledgeSession: boolean) => void;
  onCreateSession: () => void;
}

export function renderCodexTabs(
  container: HTMLElement,
  sessions: StoredSession[],
  activeSessionId: string,
  knowledgeBaseSessionId: string,
  callbacks: CodexTabsCallbacks
): void {
  container.empty();
  let chatIndex = 0;
  sessions.forEach((session) => {
    const knowledgeSession = isKnowledgeBaseSession(session, knowledgeBaseSessionId);
    if (!knowledgeSession) chatIndex += 1;
    const tab = container.createEl("button", {
      cls: `codex-tab ${session.id === activeSessionId ? "is-active" : ""} ${knowledgeSession ? "is-knowledge-base" : ""}`.trim(),
      text: knowledgeSession ? "知识库" : String(chatIndex),
      attr: { type: "button", title: knowledgeSession ? "知识库管理（常驻）" : (session.title || "新会话") }
    });
    tab.onclick = () => callbacks.onActivate(session, knowledgeSession);
    tab.oncontextmenu = (event) => callbacks.onContextMenu(event, session);
    tab.ondblclick = () => callbacks.onRename(session, knowledgeSession);
  });
  const newButton = container.createEl("button", { cls: "codex-tab-new", attr: { type: "button", "aria-label": "新建会话" } });
  setIcon(newButton, "plus");
  newButton.onclick = callbacks.onCreateSession;
}

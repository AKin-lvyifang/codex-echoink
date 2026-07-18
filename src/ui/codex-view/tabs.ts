import { setIcon } from "obsidian";
import type { StoredSession } from "../../settings/settings";
import { isKnowledgeBaseSession } from "../../settings/settings";

export interface CodexTabsCallbacks {
  onActivate: (session: StoredSession, knowledgeSession: boolean) => void;
  onContextMenu: (event: MouseEvent, session: StoredSession) => void;
  onRename: (session: StoredSession, knowledgeSession: boolean) => void;
  onDeleteSessions: (sessionIds: string[]) => void;
  onCreateSession: () => void;
}

export interface CodexSessionNavigatorModel {
  knowledgeSession: StoredSession | null;
  activeSession: StoredSession | null;
  chatSessions: StoredSession[];
  chatCount: number;
  runningSessionId: string;
}

interface CodexSessionNavigatorState {
  open: boolean;
  managing: boolean;
  query: string;
  selectedIds: Set<string>;
  focusedIndex: number;
}

const navigatorStates = new WeakMap<HTMLElement, CodexSessionNavigatorState>();

export function buildCodexSessionNavigatorModel(
  sessions: StoredSession[],
  activeSessionId: string,
  knowledgeBaseSessionId: string,
  runningSessionId = "",
  query = ""
): CodexSessionNavigatorModel {
  const knowledgeSession = sessions.find((session) => isKnowledgeBaseSession(session, knowledgeBaseSessionId)) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const chatSessions = sessions
    .filter((session) => !isKnowledgeBaseSession(session, knowledgeBaseSessionId))
    .filter((session) => !normalizedQuery || session.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.title.localeCompare(right.title, "zh-CN"));
  return {
    knowledgeSession,
    activeSession: sessions.find((session) => session.id === activeSessionId) ?? null,
    chatSessions,
    chatCount: sessions.filter((session) => !isKnowledgeBaseSession(session, knowledgeBaseSessionId)).length,
    runningSessionId
  };
}

export function formatSessionUpdatedAt(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "较早";
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;

  const updated = new Date(updatedAt);
  const current = new Date(now);
  if (sameLocalDate(updated, current)) return `今天 ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;

  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (sameLocalDate(updated, yesterday)) return "昨天";
  if (updated.getFullYear() === current.getFullYear()) return `${updated.getMonth() + 1} 月 ${updated.getDate()} 日`;
  return `${updated.getFullYear()}/${updated.getMonth() + 1}/${updated.getDate()}`;
}

export function renderCodexTabs(
  container: HTMLElement,
  sessions: StoredSession[],
  activeSessionId: string,
  knowledgeBaseSessionId: string,
  callbacks: CodexTabsCallbacks,
  runningSessionId = ""
): void {
  const state = navigatorStateFor(container);
  const allModel = buildCodexSessionNavigatorModel(sessions, activeSessionId, knowledgeBaseSessionId, runningSessionId);
  const validIds = new Set(allModel.chatSessions.map((session) => session.id));
  state.selectedIds = new Set([...state.selectedIds].filter((sessionId) => validIds.has(sessionId) && sessionId !== runningSessionId));

  const rerender = () => renderCodexTabs(
    container,
    sessions,
    activeSessionId,
    knowledgeBaseSessionId,
    callbacks,
    runningSessionId
  );
  const activate = (session: StoredSession) => {
    callbacks.onActivate(session, isKnowledgeBaseSession(session, knowledgeBaseSessionId));
    state.open = false;
    state.managing = false;
    state.query = "";
    state.selectedIds.clear();
    rerender();
  };
  const createSession = () => {
    callbacks.onCreateSession();
    state.open = false;
    state.managing = false;
    state.query = "";
    state.selectedIds.clear();
    rerender();
  };

  container.empty();
  container.addClass("codex-session-navigator");

  const knowledgeButton = container.createEl("button", {
    cls: `codex-session-knowledge ${allModel.knowledgeSession?.id === activeSessionId ? "is-active" : ""}`.trim(),
    text: "知识库",
    attr: {
      type: "button",
      title: "知识库管理（常驻）"
    }
  });
  if (allModel.knowledgeSession) {
    const knowledgeSession = allModel.knowledgeSession;
    knowledgeButton.onclick = () => activate(knowledgeSession);
    knowledgeButton.oncontextmenu = (event) => callbacks.onContextMenu(event, knowledgeSession);
    knowledgeButton.ondblclick = () => callbacks.onRename(knowledgeSession, true);
  } else {
    knowledgeButton.disabled = true;
  }

  const activeTitle = allModel.activeSession?.title || "暂无会话";
  const currentButton = container.createEl("button", {
    cls: `codex-session-current ${allModel.activeSession && !isKnowledgeBaseSession(allModel.activeSession, knowledgeBaseSessionId) ? "is-active" : ""}`.trim(),
    attr: {
      type: "button",
      title: activeTitle,
      "aria-label": `当前会话 ${activeTitle}`,
      "aria-expanded": state.open ? "true" : "false"
    }
  });
  const currentCopy = currentButton.createSpan({ cls: "codex-session-current-copy" });
  currentCopy.createSpan({ cls: "codex-session-current-label", text: "当前会话" });
  currentCopy.createSpan({ cls: "codex-session-current-title", text: activeTitle });
  const currentChevron = currentButton.createSpan({ cls: "codex-session-current-chevron" });
  setIcon(currentChevron, "chevron-down");
  currentChevron.toggleClass("is-open", state.open);
  currentButton.onclick = () => toggleSessionPicker(state, rerender);
  if (allModel.activeSession) {
    const activeSession = allModel.activeSession;
    currentButton.oncontextmenu = (event) => callbacks.onContextMenu(event, activeSession);
    currentButton.ondblclick = () => callbacks.onRename(activeSession, isKnowledgeBaseSession(activeSession, knowledgeBaseSessionId));
  }

  const allButton = container.createEl("button", {
    cls: `codex-session-all ${state.open ? "is-active" : ""}`.trim(),
    attr: {
      type: "button",
      title: "查看全部会话",
      "aria-label": `查看全部 ${allModel.chatCount} 个会话`,
      "aria-expanded": state.open ? "true" : "false"
    }
  });
  const allIcon = allButton.createSpan({ cls: "codex-session-all-icon" });
  setIcon(allIcon, "list");
  allButton.createSpan({ cls: "codex-session-all-text", text: "全部" });
  allButton.createSpan({ cls: "codex-session-count", text: String(allModel.chatCount) });
  allButton.onclick = () => toggleSessionPicker(state, rerender);

  const newButton = container.createEl("button", {
    cls: "codex-tab-new codex-session-new",
    attr: {
      type: "button",
      "aria-label": "新建会话",
      title: "新建会话"
    }
  });
  setIcon(newButton, "plus");
  newButton.onclick = createSession;

  if (state.open) {
    renderSessionPicker(container, sessions, activeSessionId, knowledgeBaseSessionId, runningSessionId, callbacks, state, activate, rerender);
  }
}

function renderSessionPicker(
  container: HTMLElement,
  sessions: StoredSession[],
  activeSessionId: string,
  knowledgeBaseSessionId: string,
  runningSessionId: string,
  callbacks: CodexTabsCallbacks,
  state: CodexSessionNavigatorState,
  activate: (session: StoredSession) => void,
  rerender: () => void
): void {
  const backdrop = container.createEl("button", {
    cls: "codex-session-picker-backdrop",
    attr: {
      type: "button",
      "aria-label": "关闭全部会话"
    }
  });
  backdrop.onclick = () => closeSessionPicker(state, rerender);

  const picker = container.createDiv({
    cls: "codex-session-picker",
    attr: {
      role: "dialog",
      "aria-label": "全部会话",
      "aria-modal": "false"
    }
  });
  const header = picker.createDiv({ cls: "codex-session-picker-header" });
  const heading = header.createDiv({ cls: "codex-session-picker-heading" });
  const headingLine = heading.createDiv({ cls: "codex-session-picker-title-line" });
  headingLine.createEl("h2", { text: "全部会话" });
  const totalCount = sessions.filter((session) => !isKnowledgeBaseSession(session, knowledgeBaseSessionId)).length;
  headingLine.createSpan({ cls: "codex-session-count", text: String(totalCount) });
  heading.createDiv({ cls: "codex-session-picker-subtitle", text: "按最近使用排序" });

  const headerActions = header.createDiv({ cls: "codex-session-picker-header-actions" });
  const manageButton = headerActions.createEl("button", {
    cls: `codex-session-manage ${state.managing ? "is-active" : ""}`.trim(),
    text: state.managing ? "完成" : "管理",
    attr: {
      type: "button",
      "aria-pressed": state.managing ? "true" : "false"
    }
  });
  manageButton.onclick = () => {
    state.managing = !state.managing;
    state.selectedIds.clear();
    state.focusedIndex = 0;
    rerender();
  };
  const closeButton = headerActions.createEl("button", {
    cls: "codex-session-picker-close",
    attr: {
      type: "button",
      "aria-label": "关闭全部会话",
      title: "关闭"
    }
  });
  setIcon(closeButton, "x");
  closeButton.onclick = () => closeSessionPicker(state, rerender);

  const searchWrap = picker.createDiv({ cls: "codex-session-search" });
  const searchIcon = searchWrap.createSpan({ cls: "codex-session-search-icon" });
  setIcon(searchIcon, "search");
  const searchInput = searchWrap.createEl("input", {
    cls: "codex-session-search-input",
    attr: {
      type: "search",
      placeholder: "搜索会话",
      "aria-label": "搜索会话",
      autocomplete: "off"
    }
  });
  searchInput.value = state.query;
  const searchHint = searchWrap.createEl("kbd", { text: "/" });
  const body = picker.createDiv({ cls: "codex-session-picker-body" });
  const footer = picker.createDiv({ cls: "codex-session-picker-footer" });

  let focusedRow: HTMLElement | null = null;
  const renderBody = () => {
    body.empty();
    footer.empty();
    focusedRow = null;
    const model = buildCodexSessionNavigatorModel(sessions, activeSessionId, knowledgeBaseSessionId, runningSessionId, state.query);
    const selectableIds = model.chatSessions.filter((session) => session.id !== runningSessionId).map((session) => session.id);
    const selectableSet = new Set(selectableIds);
    state.selectedIds = new Set([...state.selectedIds].filter((sessionId) => selectableSet.has(sessionId)));
    state.focusedIndex = Math.min(Math.max(0, state.focusedIndex), Math.max(0, model.chatSessions.length - 1));

    body.createDiv({ cls: "codex-session-section-label", text: "常驻" });
    if (model.knowledgeSession) {
      const knowledgeRow = body.createEl("button", {
        cls: `codex-session-knowledge-row ${model.knowledgeSession.id === activeSessionId ? "is-active" : ""}`.trim(),
        attr: {
          type: "button",
          "aria-label": "打开知识库常驻频道"
        }
      });
      const knowledgeIcon = knowledgeRow.createSpan({ cls: "codex-session-knowledge-icon" });
      setIcon(knowledgeIcon, "database");
      const knowledgeCopy = knowledgeRow.createSpan({ cls: "codex-session-row-copy" });
      knowledgeCopy.createSpan({ cls: "codex-session-row-title", text: "知识库" });
      knowledgeCopy.createSpan({ cls: "codex-session-row-meta", text: "常驻频道 · 不计入会话数量" });
      const pin = knowledgeRow.createSpan({ cls: "codex-session-pin" });
      setIcon(pin, "pin");
      const knowledgeSession = model.knowledgeSession;
      knowledgeRow.onclick = () => activate(knowledgeSession);
      knowledgeRow.oncontextmenu = (event) => callbacks.onContextMenu(event, knowledgeSession);
    }

    const sectionHeading = body.createDiv({ cls: "codex-session-section-heading" });
    sectionHeading.createDiv({ cls: "codex-session-section-label", text: "最近会话" });
    if (state.managing && selectableIds.length > 0) {
      const allSelected = selectableIds.every((sessionId) => state.selectedIds.has(sessionId));
      const selectAllButton = sectionHeading.createEl("button", {
        cls: "codex-session-select-all",
        text: allSelected ? "取消全选" : `全选可删除 ${selectableIds.length} 项`,
        attr: { type: "button" }
      });
      selectAllButton.onclick = () => {
        state.selectedIds = allSelected ? new Set() : new Set(selectableIds);
        renderBody();
      };
    }

    const list = body.createDiv({
      cls: "codex-session-list",
      attr: {
        role: "listbox",
        "aria-label": "会话列表",
        "aria-multiselectable": state.managing ? "true" : "false"
      }
    });
    for (const [index, session] of model.chatSessions.entries()) {
      const running = session.id === runningSessionId;
      const active = session.id === activeSessionId;
      const selected = state.selectedIds.has(session.id);
      const row = list.createDiv({
        cls: [
          "codex-session-row",
          active ? "is-active" : "",
          index === state.focusedIndex ? "is-focused" : "",
          running ? "is-running" : ""
        ].filter(Boolean).join(" "),
        attr: {
          role: "option",
          tabindex: "-1",
          title: session.title,
          "data-session-id": session.id,
          "aria-selected": state.managing ? (selected ? "true" : "false") : (active ? "true" : "false")
        }
      });
      if (index === state.focusedIndex) focusedRow = row;

      if (state.managing) {
        const checkbox = row.createEl("button", {
          cls: `codex-session-checkbox ${selected ? "is-selected" : ""}`.trim(),
          attr: {
            type: "button",
            "aria-label": running ? `${session.title} 正在运行，不能选择` : `选择 ${session.title}`,
            "aria-pressed": selected ? "true" : "false"
          }
        });
        checkbox.disabled = running;
        if (selected) setIcon(checkbox, "check");
        checkbox.onclick = (event) => {
          event.stopPropagation();
          if (!running) toggleSelectedSession(state, session.id, renderBody);
        };
      } else {
        const leading = row.createSpan({ cls: "codex-session-row-leading" });
        if (running) {
          setIcon(leading, "loader-circle");
          leading.addClass("is-spinning");
        } else {
          leading.createSpan({ cls: active ? "codex-session-active-dot" : "codex-session-dot" });
        }
      }

      const copy = row.createDiv({ cls: "codex-session-row-copy" });
      copy.createDiv({ cls: "codex-session-row-title", text: session.title });
      const meta = copy.createDiv({ cls: "codex-session-row-meta" });
      meta.createSpan({ text: running ? "Agent 正在运行" : formatSessionUpdatedAt(session.updatedAt) });
      if (active) meta.createSpan({ cls: "codex-session-current-badge", text: "当前" });

      if (!state.managing) {
        const actions = row.createDiv({ cls: "codex-session-row-actions" });
        const renameButton = actions.createEl("button", {
          cls: "codex-session-row-action",
          attr: {
            type: "button",
            "aria-label": `重命名 ${session.title}`,
            title: "重命名"
          }
        });
        setIcon(renameButton, "pencil");
        renameButton.onclick = (event) => {
          event.stopPropagation();
          callbacks.onRename(session, false);
        };
        const deleteButton = actions.createEl("button", {
          cls: "codex-session-row-action is-danger",
          attr: {
            type: "button",
            "aria-label": running ? "运行中的会话不能删除" : `删除 ${session.title}`,
            title: running ? "运行中的会话不能删除" : "删除"
          }
        });
        deleteButton.disabled = running;
        setIcon(deleteButton, "trash-2");
        deleteButton.onclick = (event) => {
          event.stopPropagation();
          if (!running) callbacks.onDeleteSessions([session.id]);
        };
      }

      row.onclick = () => {
        state.focusedIndex = index;
        if (state.managing) {
          if (!running) toggleSelectedSession(state, session.id, renderBody);
        } else {
          activate(session);
        }
      };
      row.oncontextmenu = (event) => callbacks.onContextMenu(event, session);
      row.ondblclick = () => {
        if (!state.managing) callbacks.onRename(session, false);
      };
    }

    if (model.chatSessions.length === 0) {
      const empty = list.createDiv({ cls: "codex-session-empty" });
      const emptyIcon = empty.createSpan();
      setIcon(emptyIcon, "search");
      empty.createDiv({ cls: "codex-session-empty-title", text: "没有找到会话" });
      empty.createDiv({ cls: "codex-session-empty-copy", text: "换一个关键词试试" });
    }

    if (state.managing) {
      footer.addClass("is-managing");
      footer.createSpan({
        cls: "codex-session-selection-summary",
        text: state.selectedIds.size ? `已选 ${state.selectedIds.size} 个` : "选择要删除的会话"
      });
      const deleteSelected = footer.createEl("button", {
        cls: "codex-session-delete-selected",
        attr: {
          type: "button",
          "aria-label": state.selectedIds.size ? `删除 ${state.selectedIds.size} 个会话` : "删除会话"
        }
      });
      const deleteIcon = deleteSelected.createSpan();
      setIcon(deleteIcon, "trash-2");
      deleteSelected.createSpan({ text: state.selectedIds.size ? `删除 ${state.selectedIds.size}` : "删除" });
      deleteSelected.disabled = state.selectedIds.size === 0;
      deleteSelected.onclick = () => callbacks.onDeleteSessions([...state.selectedIds]);
    } else {
      footer.removeClass("is-managing");
      renderShortcut(footer, ["↑", "↓"], "选择");
      renderShortcut(footer, ["Enter"], "打开");
      renderShortcut(footer, ["Esc"], "关闭");
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const model = buildCodexSessionNavigatorModel(sessions, activeSessionId, knowledgeBaseSessionId, runningSessionId, state.query);
    if (event.key === "/") {
      if (event.target !== searchInput) {
        event.preventDefault();
        searchInput.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.query) {
        state.query = "";
        searchInput.value = "";
        state.focusedIndex = 0;
        renderBody();
      } else if (state.managing) {
        state.managing = false;
        state.selectedIds.clear();
        rerender();
      } else {
        closeSessionPicker(state, rerender);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!model.chatSessions.length) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      state.focusedIndex = Math.min(model.chatSessions.length - 1, Math.max(0, state.focusedIndex + direction));
      renderBody();
      focusedRow?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      const session = model.chatSessions[state.focusedIndex];
      if (!session) return;
      event.preventDefault();
      if (state.managing) {
        if (session.id !== runningSessionId) toggleSelectedSession(state, session.id, renderBody);
      } else {
        activate(session);
      }
    }
  };
  picker.onkeydown = handleKeyDown;
  searchInput.oninput = () => {
    state.query = searchInput.value;
    state.focusedIndex = 0;
    renderBody();
  };
  searchHint.onclick = () => searchInput.focus();
  renderBody();

  if (typeof window !== "undefined") {
    window.setTimeout(() => searchInput.focus(), 0);
  }
}

function navigatorStateFor(container: HTMLElement): CodexSessionNavigatorState {
  const existing = navigatorStates.get(container);
  if (existing) return existing;
  const state: CodexSessionNavigatorState = {
    open: false,
    managing: false,
    query: "",
    selectedIds: new Set(),
    focusedIndex: 0
  };
  navigatorStates.set(container, state);
  return state;
}

function toggleSessionPicker(state: CodexSessionNavigatorState, rerender: () => void): void {
  state.open = !state.open;
  if (state.open) {
    state.managing = false;
    state.query = "";
    state.selectedIds.clear();
    state.focusedIndex = 0;
  }
  rerender();
}

function closeSessionPicker(state: CodexSessionNavigatorState, rerender: () => void): void {
  state.open = false;
  state.managing = false;
  state.query = "";
  state.selectedIds.clear();
  state.focusedIndex = 0;
  rerender();
}

function toggleSelectedSession(state: CodexSessionNavigatorState, sessionId: string, rerenderBody: () => void): void {
  if (state.selectedIds.has(sessionId)) state.selectedIds.delete(sessionId);
  else state.selectedIds.add(sessionId);
  rerenderBody();
}

function renderShortcut(container: HTMLElement, keys: string[], label: string): void {
  const shortcut = container.createSpan({ cls: "codex-session-shortcut" });
  for (const key of keys) shortcut.createEl("kbd", { text: key });
  shortcut.createSpan({ text: label });
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

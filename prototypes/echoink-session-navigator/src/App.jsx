import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  Database,
  List,
  LoaderCircle,
  Pencil,
  PenLine,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";

const SESSION_TITLES = [
  "排查维护报告卡片样式变化",
  "排查知识库维护命令错误",
  "修复 v1.3 Obsidian 检测失败",
  "合并收藏图标并调整增强提示词",
  "仪表盘 + 一键修复",
  "Hermes 对话栏优化",
  "记忆系统 Memory V2",
  "任务：系统注入 LLM",
  "评估 Graphify 可借鉴功能",
  "排查对话栏链接图标 bugfix",
  "设计 maintain 执行与报告卡片",
  "规划 EchoInk 下一阶段路线",
  "分析 NotebookLM 差距",
  "知识库 Raw 分层提炼方案",
  "自动维护报告卡片统一",
  "Release 安全门禁排查",
  "优化对话过程信息展示",
  "知识库首页健康度复核",
  "多 Agent 安装流程验收",
  "Obsidian 社区插件审核",
  "写作增强提示词收口",
  "测试 Vault 四步提炼",
  "MCP 与 Skill 资源清理",
  "会话缓存恢复策略",
  "Codex 登录状态检测",
  "知识库关系检索增强",
  "编辑区改写交互验收",
  "本周产品问题复盘",
  "EchoInk 下一版本计划",
  "待办：整理发布素材",
];

const relativeTimes = [
  "刚刚",
  "8 分钟前",
  "今天 14:32",
  "今天 11:05",
  "昨天",
  "昨天",
  "7 月 16 日",
  "7 月 16 日",
  "7 月 15 日",
  "7 月 15 日",
  "7 月 14 日",
  "7 月 13 日",
];

function makeSessions(count) {
  return SESSION_TITLES.slice(0, count).map((title, index) => ({
    id: `session-${index + 1}`,
    title,
    updatedLabel: relativeTimes[index] ?? `7 月 ${Math.max(1, 13 - index)} 日`,
    running: index === 1,
  }));
}

function IconButton({ label, children, className = "", ...props }) {
  return (
    <button
      className={`icon-button ${className}`}
      type="button"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

function SessionRow({
  session,
  active,
  focused,
  managing,
  selected,
  onActivate,
  onToggleSelect,
  onDelete,
  onRename,
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);

  const submitRename = () => {
    const next = draftTitle.trim();
    if (next) onRename(session.id, next);
    setRenaming(false);
  };

  return (
    <div
      className={[
        "session-row",
        active ? "is-active" : "",
        focused ? "is-focused" : "",
        session.running ? "is-running" : "",
      ].join(" ")}
      role="option"
      aria-selected={active}
      data-session-id={session.id}
      onClick={() => {
        if (managing) {
          if (!session.running) onToggleSelect(session.id);
          return;
        }
        if (!renaming) onActivate(session.id);
      }}
    >
      {managing ? (
        <button
          className="selection-box"
          type="button"
          aria-label={session.running ? `${session.title} 正在运行，不能选择` : `选择 ${session.title}`}
          aria-pressed={selected}
          disabled={session.running}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(session.id);
          }}
        >
          {selected ? <Check size={14} strokeWidth={2.6} /> : null}
        </button>
      ) : (
        <span className="session-leading" aria-hidden="true">
          {session.running ? (
            <LoaderCircle className="spin" size={16} />
          ) : active ? (
            <span className="active-dot" />
          ) : (
            <span className="session-index-dot" />
          )}
        </span>
      )}

      <div className="session-copy">
        {renaming ? (
          <input
            className="rename-input"
            aria-label={`重命名 ${session.title}`}
            value={draftTitle}
            autoFocus
            onChange={(event) => setDraftTitle(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.stopPropagation();
                submitRename();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setDraftTitle(session.title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <div className="session-title" title={session.title}>
            {session.title}
          </div>
        )}
        <div className="session-meta">
          {session.running ? "Agent 正在运行" : session.updatedLabel}
          {active ? <span className="current-label">当前</span> : null}
        </div>
      </div>

      {!managing && !renaming ? (
        <div className="row-actions">
          <IconButton
            label={`重命名 ${session.title}`}
            onClick={(event) => {
              event.stopPropagation();
              setDraftTitle(session.title);
              setRenaming(true);
            }}
          >
            <Pencil size={16} />
          </IconButton>
          <IconButton
            label={session.running ? "运行中的会话不能删除" : `删除 ${session.title}`}
            className="danger-icon"
            disabled={session.running}
            onClick={(event) => {
              event.stopPropagation();
              onDelete([session.id]);
            }}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}

function SessionPicker({
  sessions,
  activeId,
  onActivate,
  onClose,
  onCreate,
  onDeleteConfirmed,
  onRename,
}) {
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState([]);
  const searchRef = useRef(null);

  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return sessions;
    return sessions.filter((session) => session.title.toLocaleLowerCase("zh-CN").includes(normalized));
  }, [query, sessions]);

  const selectableIds = filteredSessions.filter((session) => !session.running).map((session) => session.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));

  useEffect(() => {
    setFocusedIndex((current) => Math.min(current, Math.max(0, filteredSessions.length - 1)));
  }, [filteredSessions.length]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (pendingDelete.length) return;
      if (event.key === "Escape") {
        if (query) setQuery("");
        else if (managing) {
          setManaging(false);
          setSelectedIds([]);
        } else onClose();
        return;
      }
      if (event.key === "/" && document.activeElement !== searchRef.current) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedIndex((current) => Math.min(current + 1, filteredSessions.length - 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIndex((current) => Math.max(current - 1, 0));
      }
      if (event.key === "Enter" && document.activeElement !== searchRef.current && filteredSessions[focusedIndex]) {
        event.preventDefault();
        const session = filteredSessions[focusedIndex];
        if (managing) {
          if (!session.running) toggleSelect(session.id);
        } else onActivate(session.id);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredSessions, focusedIndex, managing, onActivate, onClose, pendingDelete.length, query]);

  const toggleSelect = (id) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((sessionId) => sessionId !== id) : [...current, id],
    );
  };

  const requestDelete = (ids) => {
    const safeIds = ids.filter((id) => !sessions.find((session) => session.id === id)?.running);
    if (safeIds.length) setPendingDelete(safeIds);
  };

  const confirmDelete = () => {
    onDeleteConfirmed(pendingDelete);
    setSelectedIds([]);
    setPendingDelete([]);
    setManaging(false);
  };

  return (
    <>
      <button className="picker-backdrop" type="button" aria-label="关闭全部会话" onClick={onClose} />
      <section className="session-picker" aria-label="全部会话">
        <header className="picker-header">
          <div>
            <div className="picker-title-line">
              <h2>全部会话</h2>
              <span className="count-badge">{sessions.length}</span>
            </div>
            <p>按最近使用排序</p>
          </div>
          <div className="picker-header-actions">
            <button
              className={`text-button ${managing ? "is-active" : ""}`}
              type="button"
              onClick={() => {
                setManaging((current) => !current);
                setSelectedIds([]);
              }}
            >
              {managing ? "完成" : "管理"}
            </button>
            <IconButton label="关闭全部会话" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        </header>

        <div className="search-wrap">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="搜索会话"
            aria-label="搜索会话"
            onChange={(event) => {
              setQuery(event.target.value);
              setFocusedIndex(0);
            }}
          />
          {query ? (
            <IconButton label="清空搜索" className="search-clear" onClick={() => setQuery("")}>
              <X size={15} />
            </IconButton>
          ) : (
            <kbd>/</kbd>
          )}
        </div>

        <div className="picker-scroll">
          <div className="section-label">常驻</div>
          <button className="knowledge-row" type="button" onClick={() => onActivate("knowledge")}>
            <span className="knowledge-icon">
              <Database size={18} />
            </span>
            <span className="knowledge-copy">
              <strong>知识库</strong>
              <small>常驻频道 · 不计入会话数量</small>
            </span>
            <Pin size={16} className="pin-icon" aria-hidden="true" />
          </button>

          <div className="section-heading">
            <div className="section-label">最近会话</div>
            {managing ? (
              <button
                className="select-all-button"
                type="button"
                onClick={() => setSelectedIds(allSelected ? [] : selectableIds)}
              >
                {allSelected ? "取消全选" : `全选可删除 ${selectableIds.length} 项`}
              </button>
            ) : null}
          </div>

          <div className="session-list" role="listbox" aria-label="会话列表">
            {filteredSessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === activeId}
                focused={index === focusedIndex}
                managing={managing}
                selected={selectedIds.includes(session.id)}
                onActivate={onActivate}
                onToggleSelect={toggleSelect}
                onDelete={requestDelete}
                onRename={onRename}
              />
            ))}
          </div>

          {!filteredSessions.length ? (
            <div className="empty-state">
              <Search size={22} />
              <strong>没有找到会话</strong>
              <span>换一个关键词试试</span>
            </div>
          ) : null}
        </div>

        {managing ? (
          <footer className="manage-footer">
            <span>{selectedIds.length ? `已选 ${selectedIds.length} 个` : "选择要删除的会话"}</span>
            <button
              className="delete-button"
              type="button"
              disabled={!selectedIds.length}
              onClick={() => requestDelete(selectedIds)}
            >
              <Trash2 size={16} />
              删除{selectedIds.length ? ` ${selectedIds.length}` : ""}
            </button>
          </footer>
        ) : (
          <footer className="shortcut-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 打开</span>
            <span><kbd>Esc</kbd> 关闭</span>
          </footer>
        )}
      </section>

      {pendingDelete.length ? (
        <div className="confirm-layer" role="presentation">
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <span className="confirm-icon">
              <Trash2 size={20} />
            </span>
            <h3 id="delete-title">删除 {pendingDelete.length} 个会话？</h3>
            <p>会话记录和关联的 Agent 缓存将一起清理。此操作不能撤销。</p>
            <div className="confirm-actions">
              <button className="secondary-button" type="button" onClick={() => setPendingDelete([])}>
                取消
              </button>
              <button className="danger-button" type="button" onClick={confirmDelete}>
                确认删除
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function EchoInkSidebar({ count, theme, widthMode, initialPickerOpen = true }) {
  const [sessions, setSessions] = useState(() => makeSessions(count));
  const [activeId, setActiveId] = useState("session-1");
  const [pickerOpen, setPickerOpen] = useState(initialPickerOpen);

  useEffect(() => {
    const nextSessions = makeSessions(count);
    setSessions(nextSessions);
    setActiveId("session-1");
  }, [count]);

  const activeSession = sessions.find((session) => session.id === activeId) ?? sessions[0];

  const activate = (id) => {
    if (id === "knowledge") {
      setActiveId("knowledge");
      setPickerOpen(false);
      return;
    }
    setActiveId(id);
    setPickerOpen(false);
  };

  const createSession = () => {
    const id = `session-new-${Date.now()}`;
    const newSession = {
      id,
      title: `新会话 ${sessions.length + 1}`,
      updatedLabel: "刚刚",
      running: false,
    };
    setSessions((current) => [newSession, ...current]);
    setActiveId(id);
    setPickerOpen(false);
  };

  const deleteSessions = (ids) => {
    setSessions((current) => {
      const next = current.filter((session) => !ids.includes(session.id));
      if (ids.includes(activeId)) setActiveId(next[0]?.id ?? "knowledge");
      return next;
    });
  };

  const renameSession = (id, title) => {
    setSessions((current) =>
      current.map((session) => (session.id === id ? { ...session, title, updatedLabel: "刚刚" } : session)),
    );
  };

  return (
    <div
      className={`plugin-frame ${theme === "dark" ? "theme-dark" : "theme-light"} ${widthMode === "narrow" ? "is-narrow" : ""}`}
    >
      <header className="echoink-header">
        <div className="brand">
          <Bot size={22} strokeWidth={2.1} />
          <span>EchoInk</span>
        </div>
        <div className="header-actions">
          <button className="write-button" type="button">
            <PenLine size={17} />
            <span>写作</span>
          </button>
          <button className="backend-button" type="button">
            <Bot size={16} />
            <span>Codex</span>
            <ChevronDown size={15} />
          </button>
          <IconButton label="资源">
            <List size={20} />
          </IconButton>
          <IconButton label="设置">
            <Settings size={20} />
          </IconButton>
        </div>
      </header>

      <nav className="session-bar" aria-label="会话导航">
        <button
          className={`knowledge-button ${activeId === "knowledge" ? "is-active" : ""}`}
          type="button"
          onClick={() => setActiveId("knowledge")}
        >
          知识库
        </button>
        <button
          className={`current-session-button ${activeId !== "knowledge" ? "is-active" : ""}`}
          type="button"
          onClick={() => setPickerOpen(true)}
          title={activeSession?.title}
        >
          <span className="current-session-copy">
            <small>当前会话</small>
            <strong>{activeId === "knowledge" ? "知识库管理" : activeSession?.title ?? "暂无会话"}</strong>
          </span>
          <ChevronDown size={16} className={pickerOpen ? "rotate" : ""} />
        </button>
        <button
          className={`all-sessions-button ${pickerOpen ? "is-active" : ""}`}
          type="button"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((current) => !current)}
        >
          <List size={17} />
          <span>全部</span>
          <b>{sessions.length}</b>
        </button>
        <IconButton label="新建会话" className="new-session-button" onClick={createSession}>
          <Plus size={20} />
        </IconButton>
      </nav>

      <main className="conversation">
        <div className="message user-message">这个会话栏以后需要能装下很多会话。</div>
        <article className="assistant-message">
          <div className="assistant-name">
            <span className="assistant-avatar"><Bot size={15} /></span>
            <strong>EchoInk</strong>
          </div>
          <p>方哥，收到。会话多时可以从顶部的“全部”入口统一查找和管理。</p>
          <div className="result-card">
            <div className="result-card-head">
              <span className="result-icon"><Archive size={17} /></span>
              <strong>会话导航优化</strong>
            </div>
            <div className="result-row"><span>当前会话</span><b>{sessions.length}</b></div>
            <div className="result-row"><span>快捷选择</span><b>已启用</b></div>
            <div className="result-row"><span>批量管理</span><b>可用</b></div>
          </div>
        </article>
      </main>

      <footer className="composer">
        <textarea aria-label="给 EchoInk 发消息" placeholder="给 EchoInk 发消息…" />
        <div className="composer-actions">
          <IconButton label="添加附件"><Plus size={18} /></IconButton>
          <button className="model-chip" type="button">GPT-5.6 <ChevronDown size={14} /></button>
          <button className="send-button" type="button" aria-label="发送"><PenLine size={17} /></button>
        </div>
      </footer>

      {pickerOpen ? (
        <SessionPicker
          sessions={sessions}
          activeId={activeId}
          onActivate={activate}
          onClose={() => setPickerOpen(false)}
          onCreate={createSession}
          onDeleteConfirmed={deleteSessions}
          onRename={renameSession}
        />
      ) : null}
    </div>
  );
}

export function App() {
  const [count, setCount] = useState(12);
  const [theme, setTheme] = useState("light");
  const [widthMode, setWidthMode] = useState("standard");

  return (
    <main className="prototype-page">
      <section className="prototype-stage">
        <EchoInkSidebar count={count} theme={theme} widthMode={widthMode} />
      </section>

      <aside className="prototype-controls" aria-label="原型控制">
        <div>
          <span className="control-eyebrow">ECHOINK PROTOTYPE</span>
          <h1>会话选择器</h1>
          <p>验证十几个到三十个会话时的查看、切换和批量清理体验。</p>
        </div>

        <div className="control-group">
          <span>会话数量</span>
          <div className="segmented-control">
            {[4, 12, 30].map((value) => (
              <button
                key={value}
                className={count === value ? "is-active" : ""}
                type="button"
                onClick={() => setCount(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span>侧栏宽度</span>
          <div className="segmented-control">
            <button
              className={widthMode === "standard" ? "is-active" : ""}
              type="button"
              onClick={() => setWidthMode("standard")}
            >
              标准
            </button>
            <button
              className={widthMode === "narrow" ? "is-active" : ""}
              type="button"
              onClick={() => setWidthMode("narrow")}
            >
              窄栏
            </button>
          </div>
        </div>

        <div className="control-group">
          <span>主题</span>
          <div className="segmented-control">
            <button
              className={theme === "light" ? "is-active" : ""}
              type="button"
              onClick={() => setTheme("light")}
            >
              浅色
            </button>
            <button
              className={theme === "dark" ? "is-active" : ""}
              type="button"
              onClick={() => setTheme("dark")}
            >
              深色
            </button>
          </div>
        </div>

        <div className="prototype-note">
          <strong>试用重点</strong>
          <span>点击“全部 12”展开/收起</span>
          <span>搜索、上下键、Enter、Esc</span>
          <span>点击“管理”进入批量删除</span>
          <span>悬停卡片直接重命名/删除</span>
        </div>
      </aside>
    </main>
  );
}

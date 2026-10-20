import { formatMobileDateTime } from "../../mobile/date-display";
import { GENERAL_ASSISTANT_ID } from "../../agents/types";
import type { WorkbenchSignal, WorkbenchSnapshot } from "../../home/workbench-types";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import type { MobileSession } from "../../mobile/store";
import { formatMobileWorkbenchDate } from "../../mobile/workbench-format";
import type { MobileShellPage } from "../mobile/shell-types";
import { shellIconButton } from "../mobile/shell-controls";
import { createInlineQuestion } from "./composer";
import type { IPadPageContext } from "./workbench-contract";
import { IPAD_MODULES, ipadAvatar, ipadButton, ipadClock, ipadDateGroup, ipadElement as el,
  ipadIcon, ipadStatus, ipadTaskProjection, ipadTasks, ipadTaskStatus, ipadTaskSummary,
  ipadTaskTime, ipadTaskUnread } from "./workbench-elements";

function section(ctx: IPadPageContext, label: string): { element: HTMLElement; heading: HTMLElement; count: HTMLElement } {
  const element = el(ctx.document, "section", "pd-section"), heading = el(ctx.document, "div", "pd-section-heading");
  const count = el(ctx.document, "span", "pd-count");
  heading.append(el(ctx.document, "h2", "", label), count); element.append(heading); element.hidden = true;
  return { element, heading, count };
}

/** Keep unchanged cards attached, including an actively edited question. */
function reconcile(parent: HTMLElement, children: HTMLElement[]): void {
  children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null); });
  while (parent.children.length > children.length) parent.lastElementChild?.remove();
}

function cardNavigation(ctx: IPadPageContext, card: HTMLElement, taskId: string): void {
  card.setAttribute("role", "link"); card.tabIndex = 0;
  const open = () => { void ctx.navigate({ kind: "task", taskId }).catch(error => ctx.error(error)); };
  card.addEventListener("click", event => { if (!(event.target as HTMLElement).closest("button,input,textarea,select,a,label,details")) open(); });
  card.addEventListener("keydown", event => {
    if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); }
  });
}

function interruptedAt(task: MobileSession): string {
  const at = task.interruption?.at ?? task.taskInterruptedAt;
  const reasons = { app_closed: "应用关闭时中断", user_stopped: "已停止", plugin_disabled: "插件关闭时中断", run_failed: "执行失败时中断",
    process_unknown: "发现上次未正常结束", watchdog: "运行超时中断", app_backgrounded: "切到后台时中断" };
  const reason = task.interruption ? reasons[task.interruption.reason] : "已中断";
  return at === undefined ? "未记录中断时间" : `${formatMobileDateTime(at)} ${reason}`;
}

export function createHomePage(ctx: IPadPageContext): MobileShellPage {
  const content = el(ctx.document, "div", "pd-workbench");
  const header = el(ctx.document, "div", "pd-workbench-heading"), copy = el(ctx.document, "div", "pd-grow");
  const date = el(ctx.document, "div", "pd-home-date"); copy.append(el(ctx.document, "h1", "", "工作台"), date);
  const newTask = ipadButton(ctx.document, "新任务", () => { void ctx.navigate({ kind: "agent", agentId: GENERAL_ASSISTANT_ID }).catch(error => ctx.error(error)); }, "is-primary", "plus");
  newTask.disabled = !!ctx.host.store.unavailableReason;
  header.append(copy,
    shellIconButton(ctx.document, "搜索笔记", "search", () => { void ctx.host.openSearch().catch(error => ctx.error(error)); }),
    shellIconButton(ctx.document, "EchoInk 设置", "settings", () => { void ctx.host.openLegacy("settings").catch(error => ctx.error(error)); }),
    newTask);
  const navigation = el(ctx.document, "nav", "pd-module-nav"); navigation.setAttribute("aria-label", "模块");
  for (const module of IPAD_MODULES.slice(0, 5)) {
    const button = el(ctx.document, "button", "pd-module-button"); button.type = "button";
    button.append(ipadIcon(ctx.document, module.icon), el(ctx.document, "span", "", module.name));
    button.addEventListener("click", () => { void ctx.host.openModule(module.id).catch(error => ctx.error(error)); }); navigation.append(button);
  }
  const taskGroups = (["interrupted", "waiting", "running"] as const).map((status, index) => {
    const area = section(ctx, ["上次中断", "等你回应", "正在进行"][index]), cards = el(ctx.document, "div", "pd-cards");
    area.element.append(cards); return { ...area, status, cards };
  });
  const signals = section(ctx, "可以交给 Agent"), signalRows = el(ctx.document, "div", "pd-rows"); signals.element.append(signalRows);
  const completed = section(ctx, "今天完成"), completedRows = el(ctx.document, "div", "pd-rows"); completed.element.append(completedRows);
  const todos = section(ctx, "今日待办"), todoRows = el(ctx.document, "div", "pd-rows"); todos.element.append(todoRows);
  todos.heading.append(ipadButton(ctx.document, "全部待办", () => { void ctx.host.openModule("todos").catch(error => ctx.error(error)); }, "is-text pd-section-more", "chevron-right"));
  const readError = el(ctx.document, "div", "pd-error"); readError.setAttribute("role", "alert"); readError.hidden = true;
  content.append(header, navigation, ...taskGroups.map(group => group.element), signals.element, completed.element, todos.element, readError);
  if (ctx.host.store.unavailableReason) content.insertBefore(readError, taskGroups[0].element);
  let disposed = false, showAll = false, snapshot: WorkbenchSnapshot | undefined, loading = false, reload = false, signature = "", factsFailure = "";
  let nextFactRefresh = Infinity;
  const cards = new Map<string, { element: HTMLElement; who: HTMLElement; title: HTMLElement; step: HTMLElement;
    question?: ReturnType<typeof createInlineQuestion>; actions?: HTMLElement }>();
  const signalCache = new Map<string, { element: HTMLElement; signature: string; signal: WorkbenchSignal }>();
  const todoCache = new Map<string, { element: HTMLElement; todo: ParsedTodoRecord; check: HTMLInputElement; title: HTMLElement; detail: HTMLElement }>();
  const pendingTodos = new Set<string>();

  const taskCard = (task: MobileSession): HTMLElement => {
    let card = cards.get(task.id);
    if (!card) {
      const element = el(ctx.document, "div", "pd-task-card"), who = el(ctx.document, "div", "pd-task-who");
      element.dataset.taskId = task.id; cardNavigation(ctx, element, task.id);
      const body = el(ctx.document, "div", "pd-task-copy"), title = el(ctx.document, "div", "pd-task-title"), step = el(ctx.document, "div", "pd-task-step");
      body.append(title, step); element.append(who, body); card = { element, who, title, step }; cards.set(task.id, card);
    }
    const agent = ctx.host.settings().agentRegistry.agents.find(item => item.id === task.agentId);
    const status = ipadTaskStatus(task);
    const selected = ctx.host.store.state.page.kind === "detail" && ctx.host.store.state.page.taskId === task.id;
    card.element.classList.toggle("is-selected", selected);
    if (selected) card.element.setAttribute("aria-current", "page"); else card.element.removeAttribute("aria-current");
    card.who.replaceChildren();
    if (agent) card.who.append(ipadAvatar(ctx.document, agent));
    card.who.append(el(ctx.document, "span", "pd-task-agent", agent?.name ?? task.runs?.at(-1)?.agentSnapshot?.name ?? ""), ipadStatus(ctx.document, task));
    card.title.textContent = task.title;
    card.step.textContent = status === "waiting"
      ? ctx.host.runtime.stateFor(task.id).interaction?.questions[0]?.prompt || ipadTaskSummary(task)
      : ipadTaskSummary(task); card.step.hidden = !card.step.textContent;
    if (status === "waiting") {
      if (!card.question) { card.question = createInlineQuestion(ctx, task.id); card.element.append(card.question.element); }
    } else if (card.question) { card.question.dispose(); card.question.element.remove(); card.question = undefined; }
    if (status === "interrupted") {
      if (!card.actions) {
        const actions = el(ctx.document, "div", "pd-card-actions"), time = el(ctx.document, "span", "pd-sub pd-grow");
        const resume = ipadButton(ctx.document, "继续", () => {
          resume.disabled = true;
          void ctx.host.resumeTask(task.id).catch(error => ctx.error(error))
            .finally(() => { if (!disposed) resume.disabled = ctx.host.runtime.stateFor(task.id).resuming === true; });
        }, "", "play");
        actions.append(time, resume); card.actions = actions; card.element.append(actions);
      }
      card.actions.querySelector(".pd-sub")!.textContent = interruptedAt(task);
      card.actions.querySelector<HTMLButtonElement>("button")!.disabled = ctx.host.runtime.stateFor(task.id).resuming === true;
    } else if (card.actions) { card.actions.remove(); card.actions = undefined; }
    return card.element;
  };

  const renderTasks = (force = false) => {
    if (disposed) return;
    const tasks = ipadTasks(ctx.host.store.state.sessions), registry = ctx.host.settings().agentRegistry;
    const next = ipadTaskProjection(tasks) + JSON.stringify([registry, ctx.host.store.state.page]);
    if (!force && signature === next) return; signature = next;
    const active = tasks.filter(task => ipadTaskStatus(task) !== "completed");
    for (const [id, card] of cards) if (!active.some(task => task.id === id)) {
      card.question?.dispose(); card.element.remove(); cards.delete(id);
    }
    for (const group of taskGroups) {
      const tasksInGroup = active.filter(task => ipadTaskStatus(task) === group.status).sort((a, b) => b.updatedAt - a.updatedAt);
      group.element.hidden = !tasksInGroup.length; group.count.textContent = `${tasksInGroup.length}`;
      reconcile(group.cards, tasksInGroup.map(taskCard));
    }
    const done = tasks.filter(task => ipadTaskStatus(task) === "completed" && ipadDateGroup(ipadTaskTime(task)) === "今天")
      .sort((a, b) => ipadTaskTime(b) - ipadTaskTime(a));
    completed.element.hidden = !done.length; completed.count.textContent = `${done.length}`;
    completedRows.replaceChildren();
    for (const task of done) {
      const agent = registry.agents.find(item => item.id === task.agentId), row = el(ctx.document, "button", "pd-row pd-completed-row"); row.type = "button";
      const selected = ctx.host.store.state.page.kind === "detail" && ctx.host.store.state.page.taskId === task.id;
      row.classList.toggle("is-selected", selected); if (selected) row.setAttribute("aria-current", "page");
      if (agent) row.append(ipadAvatar(ctx.document, agent));
      const copy = el(ctx.document, "span", "pd-grow");
      copy.append(el(ctx.document, "span", "pd-row-title", task.title), el(ctx.document, "span", "pd-sub", [agent?.name, ipadTaskSummary(task)].filter(Boolean).join(" · "))); row.append(copy);
      if (ipadTaskUnread(task)) { const dot = el(ctx.document, "span", "pd-dot"); dot.setAttribute("aria-label", "有新结果"); row.append(dot); }
      row.append(el(ctx.document, "span", "pd-time", ipadClock(ipadTaskTime(task))));
      row.addEventListener("click", () => { void ctx.navigate({ kind: "task", taskId: task.id }).catch(error => ctx.error(error)); }); completedRows.append(row);
    }
    date.textContent = formatMobileWorkbenchDate();
  };

  const signalRow = (signal: WorkbenchSignal): HTMLElement => {
    const registry = ctx.host.settings().agentRegistry, owner = registry.agents.find(agent => agent.id === registry.moduleOwners[signal.moduleId]);
    const signature = JSON.stringify([signal.icon, signal.description, signal.prompt, signal.source.objects, signal.source.versions, owner?.id, owner?.name]);
    const previous = signalCache.get(signal.key);
    if (previous?.signature === signature) { previous.signal = signal; return previous.element; }
    const row = el(ctx.document, "div", "pd-row pd-signal-row"), entry = { element: row, signature, signal };
    signalCache.set(signal.key, entry);
    row.append(ipadIcon(ctx.document, signal.icon), el(ctx.document, "div", "pd-grow", signal.description));
    const action = ipadButton(ctx.document, `交给${owner?.name ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)?.name ?? "总助"}`, () => { void handoff(false); }); row.append(action);
    const handoff = async (replace: boolean) => {
      action.disabled = true;
      try {
        const result = await ctx.host.workbench.handoff(entry.signal, replace); if (disposed) return;
        if (result.conflict) {
          if (row.querySelector(".pd-confirm")) return;
          const confirm = el(ctx.document, "div", "pd-confirm", "已有未发送的内容，是否替换？"), choices = el(ctx.document, "div", "pd-confirm-actions");
          choices.append(ipadButton(ctx.document, "保留原稿", () => { confirm.remove(); void ctx.navigate({ kind: "agent", agentId: result.agentId }).catch(error => ctx.error(error)); }),
            ipadButton(ctx.document, "替换草稿", () => { confirm.remove(); void handoff(true); }, "is-primary")); confirm.append(choices); row.append(confirm);
        } else await ctx.navigate({ kind: "agent", agentId: result.agentId });
      } catch (error) { if (!disposed) ctx.error(error); }
      finally { action.disabled = false; }
    };
    return row;
  };

  const todoRow = (todo: ParsedTodoRecord): HTMLElement => {
    const key = todo.id || `${todo.lineStart}:${todo.title}`;
    let entry = todoCache.get(key);
    if (!entry) {
      const element = el(ctx.document, "div", "pd-row pd-todo-row"), label = el(ctx.document, "label", "pd-todo-check"), check = el(ctx.document, "input", ""); check.type = "checkbox";
      const title = el(ctx.document, "div", "pd-grow"), detail = el(ctx.document, "div", "pd-todo-detail"); label.append(check); element.append(label, title, detail);
      entry = { element, todo, check, title, detail }; todoCache.set(key, entry);
      const current = entry;
      check.addEventListener("change", () => {
        if (pendingTodos.has(key)) return;
        const target = current.todo, done = check.checked; pendingTodos.add(key); check.disabled = true;
        void ctx.host.services.getTodoStore().toggleDone(target, done).then(() => loadFacts(), error => {
          check.checked = target.done; if (!disposed) ctx.error(error);
        }).finally(() => { pendingTodos.delete(key); if (!disposed) renderFacts(); });
      });
    }
    entry.todo = todo; entry.check.disabled = pendingTodos.has(key);
    if (!pendingTodos.has(key)) entry.check.checked = todo.done;
    entry.check.setAttribute("aria-label", `完成 ${todo.title}`); entry.title.textContent = todo.title; entry.detail.replaceChildren();
    if (todo.project) { const project = el(ctx.document, "span", "pd-project"); project.append(ipadIcon(ctx.document, "folder"), el(ctx.document, "span", "", todo.project)); entry.detail.append(project); }
    entry.detail.append(el(ctx.document, "span", "pd-due", ipadDateGroup(new Date(`${todo.dueDate}T12:00:00`).getTime())));
    return entry.element;
  };

  const more = ipadButton(ctx.document, "", () => { showAll = !showAll; renderFacts(); }, "is-text pd-section-more"); signals.heading.append(more);
  const renderFacts = () => {
    if (disposed || !snapshot) return;
    signals.element.hidden = !snapshot.signals.length; signals.count.textContent = `${snapshot.signals.length}`;
    more.hidden = snapshot.signals.length <= 5; more.setAttribute("aria-expanded", String(showAll));
    more.querySelector(".pd-button-visible")!.replaceChildren(el(ctx.document, "span", "", showAll ? "收起" : `还有 ${Math.max(0, snapshot.signals.length - 5)} 条`), ipadIcon(ctx.document, showAll ? "chevron-up" : "chevron-down"));
    const shown = showAll ? snapshot.signals : snapshot.signals.slice(0, 5);
    reconcile(signalRows, shown.map(signalRow));
    for (const key of signalCache.keys()) if (!snapshot.signals.some(signal => signal.key === key)) signalCache.delete(key);
    todos.element.hidden = !snapshot.todayTodos.length; todos.count.textContent = `${snapshot.todayTodos.length}`;
    reconcile(todoRows, snapshot.todayTodos.map(todoRow));
    for (const key of todoCache.keys()) if (!snapshot.todayTodos.some(todo => (todo.id || `${todo.lineStart}:${todo.title}`) === key)) todoCache.delete(key);
    readError.textContent = [...snapshot.issues, factsFailure].filter(Boolean).join("\n"); readError.hidden = !readError.textContent;
  };

  const loadFacts = async () => {
    if (disposed) return;
    if (loading) { reload = true; return; } loading = true;
    try {
      const next = await ctx.host.workbench.load();
      if (!disposed) { snapshot = next; factsFailure = ""; nextFactRefresh = Math.max(Date.now() + 1000, next.nextRefreshAt ?? Infinity); renderFacts(); }
    } catch (error) {
      if (!disposed) { nextFactRefresh = Date.now() + 60_000; factsFailure = error instanceof Error ? error.message : String(error); readError.textContent = [...snapshot?.issues ?? [], factsFailure].join("\n"); readError.hidden = false; }
    } finally { loading = false; if (reload && !disposed) { reload = false; void loadFacts(); } }
  };

  renderTasks(); void loadFacts();
  const unsubscribeRuntime = ctx.host.runtime.subscribe(() => renderTasks());
  const unsubscribeFacts = ctx.host.workbench.subscribe(() => { renderTasks(); void loadFacts(); });
  const unsubscribeIdentity = ctx.host.services.subscribeIdentity(() => { renderTasks(); renderFacts(); });
  let localDay = new Date().toDateString();
  const window = ctx.document.defaultView;
  const clock = window?.setInterval(() => {
    const now = Date.now(), nextDay = new Date(now).toDateString();
    if (nextDay !== localDay) { localDay = nextDay; renderTasks(true); void loadFacts(); }
    if (!loading && now >= nextFactRefresh) void loadFacts();
    date.textContent = formatMobileWorkbenchDate();
    for (const [id, card] of cards) {
      const task = ctx.host.store.getSession(id);
      if (task && ipadTaskStatus(task) === "running") card.who.querySelector(".pd-status")?.replaceWith(ipadStatus(ctx.document, task));
    }
  }, 1000);
  return { id: "ipad-home", title: "工作台", header: "content", content, dispose() {
    if (disposed) return; disposed = true; window?.clearInterval(clock);
    unsubscribeRuntime(); unsubscribeFacts(); unsubscribeIdentity();
    for (const card of cards.values()) card.question?.dispose(); cards.clear(); signalCache.clear(); todoCache.clear();
  } };
}

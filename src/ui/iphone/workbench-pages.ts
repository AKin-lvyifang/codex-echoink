import { formatMobileDateTime } from "../../mobile/date-display";
import { formatMobileWorkbenchDate } from "../../mobile/workbench-format";
import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "../../agents/types";
import type { WorkbenchSignal, WorkbenchSnapshot } from "../../home/workbench-types";
import type { MobileSession } from "../../mobile/store";
import type { MobileShellPage } from "../mobile/shell-types";
import { shellIconButton } from "../mobile/shell-controls";
import { createIPhoneComposer, createInlineQuestion, requestIPhoneTaskResume } from "./composer";
import type { IPhonePageContext } from "./workbench-contract";
import { IPHONE_MODULES, iphoneAvatar, iphoneButton, iphoneClock, iphoneDateGroup, iphoneElement as el,
  iphoneIcon, iphoneStatus, iphoneTaskProjection, iphoneTasks, iphoneTaskStatus, iphoneTaskSummary,
  iphoneTaskTime, iphoneTaskUnread } from "./workbench-elements";

export { createAgentFormPage } from "./agent-form";

function agentStrip(ctx: IPhonePageContext, current?: string): HTMLElement {
  const strip = el(ctx.document, "nav", "ip-agent-strip"); strip.setAttribute("aria-label", "Agent");
  const tasks = iphoneTasks(ctx.host.store.state.sessions);
  for (const agent of ctx.host.settings().agentRegistry.agents) {
    const mine = tasks.filter(task => task.agentId === agent.id);
    const waiting = mine.filter(task => iphoneTaskStatus(task) === "waiting").length;
    const interrupted = mine.some(task => iphoneTaskStatus(task) === "interrupted");
    const running = mine.some(task => iphoneTaskStatus(task) === "running");
    const unread = mine.some(iphoneTaskUnread);
    const button = el(ctx.document, "button", `ip-agent-avatar${current === agent.id ? " is-selected" : ""}`);
    button.type = "button"; button.dataset.agentId = agent.id;
    button.setAttribute("aria-label", [agent.name, waiting ? `${waiting} 件等你回应` : "", interrupted ? "有中断" : "", running ? "正在进行" : "", unread ? "有新结果" : ""].filter(Boolean).join(" · "));
    if (current === agent.id) button.setAttribute("aria-current", "page");
    button.append(iphoneAvatar(ctx.document, agent));
    if (waiting || interrupted || running || unread) {
      const kind = waiting ? "waiting" : interrupted ? "interrupted" : running ? "running" : "unread";
      const badge = el(ctx.document, "span", `ip-agent-badge is-${kind}`); badge.setAttribute("aria-hidden", "true");
      if (waiting) badge.textContent = `${waiting}`;
      else if (interrupted) badge.textContent = "!";
      else if (running) badge.append(iphoneIcon(ctx.document, "loader-circle"));
      button.append(badge);
    }
    button.addEventListener("click", () => { if (current !== agent.id) void ctx.navigate({ kind: "agent", agentId: agent.id }, !!current).catch(error => ctx.error(error)); });
    strip.append(button);
  }
  strip.append(shellIconButton(ctx.document, "新建 Agent", "user-plus", () => { void ctx.navigate({ kind: "agent-form" }).catch(error => ctx.error(error)); }));
  return strip;
}

async function openNewTask(ctx: IPhonePageContext, agentId: string): Promise<void> {
  await ctx.navigate({ kind: "agent", agentId });
  ctx.document.querySelector<HTMLTextAreaElement>(".echoink-iphone .eis-page:not([hidden]) .eis-footer textarea")?.focus();
}

function section(ctx: IPhonePageContext, label: string, count: number): { element: HTMLElement; heading: HTMLElement } {
  const element = el(ctx.document, "section", "ip-section"), heading = el(ctx.document, "div", "ip-section-heading");
  heading.append(el(ctx.document, "h2", "", label), el(ctx.document, "span", "ip-count", `${count}`)); element.append(heading);
  return { element, heading };
}

function cardNavigation(ctx: IPhonePageContext, card: HTMLElement, taskId: string): void {
  card.setAttribute("role", "link"); card.tabIndex = 0;
  const open = () => { void ctx.navigate({ kind: "task", taskId }).catch(error => ctx.error(error)); };
  card.addEventListener("click", event => { if (!(event.target as HTMLElement).closest("button,input,textarea,select,a,label,details")) open(); });
  card.addEventListener("keydown", event => { if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } });
}

function interruptedAt(task: MobileSession): string {
  const at = task.interruption?.at ?? task.taskInterruptedAt;
  const reasons = { app_closed: "应用关闭时中断", user_stopped: "已停止", plugin_disabled: "插件关闭时中断", run_failed: "执行失败时中断",
    process_unknown: "发现上次未正常结束", watchdog: "运行超时中断", app_backgrounded: "切到后台时中断" };
  const reason = task.interruption ? reasons[task.interruption.reason] : "已中断";
  return at === undefined ? "未记录中断时间" : `${formatMobileDateTime(at)} ${reason}`;
}

export function createHomePage(ctx: IPhonePageContext): MobileShellPage {
  const content = el(ctx.document, "div", "ip-workbench");
  const header = el(ctx.document, "div", "ip-workbench-heading"), copy = el(ctx.document, "div", "ip-grow");
  const date = el(ctx.document, "div", "ip-home-date"); copy.append(el(ctx.document, "h1", "", "工作台"), date);
  const newTask = iphoneButton(ctx.document, "新任务", () => { void openNewTask(ctx, GENERAL_ASSISTANT_ID).catch(error => ctx.error(error)); }, "is-primary", "plus");
  newTask.disabled = !!ctx.host.store.unavailableReason;
  header.append(copy, shellIconButton(ctx.document, "EchoInk 设置", "settings", () => { void ctx.host.openLegacy("settings").catch(error => ctx.error(error)); }), newTask);
  const strip = el(ctx.document, "div", "ip-strip-slot"), navigation = el(ctx.document, "nav", "ip-module-nav"); navigation.setAttribute("aria-label", "模块");
  for (const module of IPHONE_MODULES.slice(0, 5)) {
    const button = el(ctx.document, "button", "ip-module-button"); button.type = "button";
    button.append(iphoneIcon(ctx.document, module.icon), el(ctx.document, "span", "", module.name));
    button.addEventListener("click", () => { void ctx.host.openModule(module.id).catch(error => ctx.error(error)); }); navigation.append(button);
  }
  const topTasks = el(ctx.document, "div", "ip-task-groups"), signals = el(ctx.document, "div", "ip-signals"), bottomTasks = el(ctx.document, "div", "ip-completed-group"), todos = el(ctx.document, "div", "ip-home-todos");
  const readError = el(ctx.document, "div", "ip-error"); readError.setAttribute("role", "alert"); readError.hidden = true;
  content.append(header, strip, navigation, topTasks, signals, bottomTasks, todos, readError);
  if (ctx.host.store.unavailableReason) content.insertBefore(readError, topTasks);
  let disposed = false, showAll = false, snapshot: WorkbenchSnapshot | undefined, loading = false, reload = false, signature = "";
  const questions = new Map<string, ReturnType<typeof createInlineQuestion>>();

  const taskCard = (task: MobileSession, agent: AgentDefinition | undefined): HTMLElement => {
    const card = el(ctx.document, "div", "ip-task-card"); card.dataset.taskId = task.id; cardNavigation(ctx, card, task.id);
    const who = el(ctx.document, "div", "ip-task-who");
    if (agent) who.append(iphoneAvatar(ctx.document, agent));
    who.append(el(ctx.document, "span", "ip-task-agent", agent?.name ?? task.runs?.at(-1)?.agentSnapshot?.name ?? ""), iphoneStatus(ctx.document, task));
    const body = el(ctx.document, "div", "ip-task-copy"); body.append(el(ctx.document, "div", "ip-task-title", task.title), el(ctx.document, "div", "ip-task-step", iphoneTaskSummary(task))); card.append(who, body);
    if (iphoneTaskStatus(task) === "waiting") {
      let question = questions.get(task.id);
      if (!question) {
        question = createInlineQuestion(ctx, task.id, async () => {
          if (!disposed && ctx.shell.activePageId === "iphone-home") await ctx.navigate({ kind: "task", taskId: task.id });
        });
        questions.set(task.id, question);
      }
      card.append(question.element);
    } else if (iphoneTaskStatus(task) === "interrupted") {
      const actions = el(ctx.document, "div", "ip-card-actions"); actions.append(el(ctx.document, "span", "ip-sub ip-grow", interruptedAt(task)));
      const resume = iphoneButton(ctx.document, "继续", () => {
        resume.disabled = true;
        void (async () => {
          try { await requestIPhoneTaskResume(ctx, task.id, task.draft, () => { if (!disposed) void ctx.navigate({ kind: "task", taskId: task.id }).catch(error => ctx.error(error)); }); }
          finally { resume.disabled = false; }
        })().catch(error => ctx.error(error));
      }, "", "play");
      resume.disabled = ctx.host.runtime.stateFor(task.id).resuming === true; actions.append(resume); card.append(actions);
    }
    return card;
  };
  const renderTasks = (force = false) => {
    if (disposed) return;
    const tasks = iphoneTasks(ctx.host.store.state.sessions), registry = ctx.host.settings().agentRegistry;
    const next = iphoneTaskProjection(tasks) + JSON.stringify(registry);
    if (!force && signature === next) return; signature = next;
    for (const [id, question] of questions) {
      if (!tasks.some(task => task.id === id && iphoneTaskStatus(task) === "waiting")) { question.dispose(); questions.delete(id); }
    }
    strip.replaceChildren(agentStrip(ctx)); topTasks.replaceChildren(); bottomTasks.replaceChildren();
    date.textContent = formatMobileWorkbenchDate();
    for (const [status, label] of [["interrupted", "上次中断"], ["waiting", "等你回应"], ["running", "正在进行"]] as const) {
      const group = tasks.filter(task => iphoneTaskStatus(task) === status).sort((a, b) => b.updatedAt - a.updatedAt);
      if (!group.length) continue;
      const area = section(ctx, label, group.length), cards = el(ctx.document, "div", "ip-cards");
      for (const task of group) cards.append(taskCard(task, registry.agents.find(agent => agent.id === task.agentId)));
      area.element.append(cards); topTasks.append(area.element);
    }
    const completed = tasks.filter(task => iphoneTaskStatus(task) === "completed" && iphoneDateGroup(iphoneTaskTime(task)) === "今天").sort((a, b) => iphoneTaskTime(b) - iphoneTaskTime(a));
    if (completed.length) {
      const area = section(ctx, "今天完成", completed.length), rows = el(ctx.document, "div", "ip-rows");
      for (const task of completed) {
        const agent = registry.agents.find(item => item.id === task.agentId), row = el(ctx.document, "button", "ip-row ip-completed-row"); row.type = "button";
        if (agent) row.append(iphoneAvatar(ctx.document, agent));
        const copy = el(ctx.document, "span", "ip-grow"); copy.append(el(ctx.document, "span", "ip-row-title", task.title), el(ctx.document, "span", "ip-sub ip-ellipsis", [agent?.name, iphoneTaskSummary(task)].filter(Boolean).join(" · "))); row.append(copy);
        if (iphoneTaskUnread(task)) { const dot = el(ctx.document, "span", "ip-dot"); dot.setAttribute("aria-label", "有新结果"); row.append(dot); }
        row.append(el(ctx.document, "span", "ip-time", iphoneClock(iphoneTaskTime(task)))); row.addEventListener("click", () => { void ctx.navigate({ kind: "task", taskId: task.id }).catch(error => ctx.error(error)); }); rows.append(row);
      }
      area.element.append(rows); bottomTasks.append(area.element);
    }
  };
  const signalRow = (signal: WorkbenchSignal): HTMLElement => {
    const row = el(ctx.document, "div", "ip-row ip-signal-row"), ownerId = ctx.host.settings().agentRegistry.moduleOwners[signal.moduleId];
    const owner = ctx.host.settings().agentRegistry.agents.find(agent => agent.id === ownerId);
    row.append(iphoneIcon(ctx.document, signal.icon), el(ctx.document, "div", "ip-grow", signal.description));
    const action = iphoneButton(ctx.document, `交给${owner?.name ?? "总助"}`, () => { void handoff(false); }); row.append(action);
    const handoff = async (replace: boolean) => {
      action.disabled = true;
      try {
        const result = await ctx.host.workbench.handoff(signal, replace); if (disposed) return;
        if (result.conflict) {
          if (row.querySelector(".ip-confirm")) return;
          const confirm = el(ctx.document, "div", "ip-confirm", "已有未发送的内容，是否替换？"); const choices = el(ctx.document, "div", "ip-confirm-actions");
          choices.append(iphoneButton(ctx.document, "保留原稿", () => { confirm.remove(); void openNewTask(ctx, result.agentId).catch(error => ctx.error(error)); }),
            iphoneButton(ctx.document, "替换草稿", () => { confirm.remove(); void handoff(true); }, "is-primary")); confirm.append(choices); row.append(confirm);
        } else await openNewTask(ctx, result.agentId);
      } catch (error) { ctx.error(error); }
      finally { action.disabled = false; }
    };
    return row;
  };
  const renderFacts = () => {
    if (disposed || !snapshot) return;
    signals.replaceChildren(); todos.replaceChildren();
    if (snapshot.signals.length) {
      const area = section(ctx, "可以交给 Agent", snapshot.signals.length), rows = el(ctx.document, "div", "ip-rows");
      if (snapshot.signals.length > 3) {
        const more = iphoneButton(ctx.document, showAll ? "收起" : `还有 ${snapshot.signals.length - 3} 条`, () => { showAll = !showAll; renderFacts(); }, "is-text ip-section-more", showAll ? "chevron-up" : "chevron-down");
        more.setAttribute("aria-expanded", `${showAll}`); area.heading.append(more);
      }
      for (const signal of showAll ? snapshot.signals : snapshot.signals.slice(0, 3)) rows.append(signalRow(signal));
      area.element.append(rows); signals.append(area.element);
    }
    if (snapshot.todayTodos.length) {
      const area = section(ctx, "今日待办", snapshot.todayTodos.length), rows = el(ctx.document, "div", "ip-rows");
      area.heading.append(iphoneButton(ctx.document, "全部待办", () => { void ctx.host.openModule("todos").catch(error => ctx.error(error)); }, "is-text ip-section-more", "chevron-right"));
      const source = snapshot.todoSource;
      for (const todo of snapshot.todayTodos) {
        const row = el(ctx.document, "div", "ip-row ip-todo-row"), label = el(ctx.document, "label", "ip-todo-check"), check = el(ctx.document, "input", ""); check.type = "checkbox"; check.checked = todo.done; check.setAttribute("aria-label", `完成 ${todo.title}`); label.append(check); row.append(label, el(ctx.document, "div", "ip-grow", todo.title));
        if (todo.project) { const project = el(ctx.document, "span", "ip-project"); project.append(iphoneIcon(ctx.document, "folder"), el(ctx.document, "span", "", todo.project)); row.append(project); }
        row.append(el(ctx.document, "span", "ip-due", iphoneDateGroup(new Date(`${todo.dueDate}T12:00:00`).getTime())));
        check.addEventListener("change", () => { check.disabled = true; void Promise.resolve().then(() => {
          if (!source) throw new Error("待办来源尚未确认，请重新读取工作台。");
          return ctx.host.services.getTodoStore().toggleDone(todo, check.checked, source.version, source.path);
        }).then(() => { void loadFacts(); }, error => { check.checked = todo.done; ctx.error(error); }).finally(() => { check.disabled = false; }); }); rows.append(row);
      }
      area.element.append(rows); todos.append(area.element);
    }
    readError.textContent = snapshot.issues.join("\n"); readError.hidden = !snapshot.issues.length;
  };
  const loadFacts = async () => {
    if (loading) { reload = true; return; } loading = true;
    try { const next = await ctx.host.workbench.load(); if (!disposed) { snapshot = next; renderFacts(); } }
    catch (error) { if (!disposed) { readError.textContent = error instanceof Error ? error.message : String(error); readError.hidden = false; } }
    finally { loading = false; if (reload && !disposed) { reload = false; void loadFacts(); } }
  };
  renderTasks(); void loadFacts();
  const unsubscribeRuntime = ctx.host.runtime.subscribe(() => { renderTasks(); });
  const unsubscribeFacts = ctx.host.workbench.subscribe(() => { renderTasks(); void loadFacts(); });
  const unsubscribeIdentity = ctx.host.services.subscribeIdentity(() => { renderTasks(); renderFacts(); });
  let localDay = new Date().toDateString();
  const window = ctx.document.defaultView;
  const clock = window?.setInterval(() => {
    const now = Date.now(), nextDay = new Date(now).toDateString();
    if (nextDay !== localDay) {
      localDay = nextDay; renderTasks(true);
      // The retained home owns the clock; Agent lists reuse its notification.
      ctx.host.workbench.refreshTasks?.();
    }
    if (snapshot?.nextRefreshAt !== undefined && now >= snapshot.nextRefreshAt) void loadFacts();
    date.textContent = formatMobileWorkbenchDate();
    // Updating elapsed time must not discard a partially answered inline question.
    for (const card of Array.from(topTasks.querySelectorAll<HTMLElement>(".ip-task-card"))) {
      const task = ctx.host.store.getSession(card.dataset.taskId!);
      if (task && iphoneTaskStatus(task) === "running") card.querySelector(".ip-status")?.replaceWith(iphoneStatus(ctx.document, task));
    }
  }, 60_000);
  return { id: "iphone-home", title: "工作台", header: "content", content, dispose() { disposed = true; window?.clearInterval(clock); unsubscribeRuntime(); unsubscribeFacts(); unsubscribeIdentity(); questions.forEach(question => question.dispose()); questions.clear(); } };
}

export function createAgentPage(ctx: IPhonePageContext, agentId: string): MobileShellPage {
  if (ctx.host.store.unavailableReason) {
    const content = el(ctx.document, "div", "ip-error", ctx.host.store.unavailableReason); content.setAttribute("role", "alert");
    return { id: `iphone-agent-${agentId}`, title: "Agent", content };
  }
  const content = el(ctx.document, "div", "ip-agent-page"), strip = el(ctx.document, "div", "ip-strip-slot"), list = el(ctx.document, "div", "ip-agent-tasks"); content.append(strip, list);
  const actions = shellIconButton(ctx.document, "编辑 Agent", "pencil", () => { void ctx.navigate({ kind: "agent-form", agentId }).catch(error => ctx.error(error)); });
  const composer = createIPhoneComposer(ctx, { agentId }); let signature = "", disposed = false;
  const initial = ctx.host.settings().agentRegistry.agents.find(agent => agent.id === agentId);
  const page: MobileShellPage = { id: `iphone-agent-${agentId}`, title: initial?.name ?? "Agent", subtitle: initial?.position || "0 件事", content, actions, footer: composer.element, canLeave: composer.canLeave };
  const render = () => {
    if (disposed) return;
    const agent = ctx.host.settings().agentRegistry.agents.find(item => item.id === agentId), tasks = iphoneTasks(ctx.host.store.state.sessions).filter(task => task.agentId === agentId);
    const next = new Date().toDateString() + iphoneTaskProjection(iphoneTasks(ctx.host.store.state.sessions)) + JSON.stringify(ctx.host.settings().agentRegistry);
    if (next === signature) return; signature = next; strip.replaceChildren(agentStrip(ctx, agentId)); list.replaceChildren();
    if (!agent) { list.append(el(ctx.document, "div", "ip-empty", "这个 Agent 已被删除。")); composer.element.hidden = true; actions.disabled = true; return; }
    page.title = agent.name; page.subtitle = [agent.position, `${tasks.length} 件事`].filter(Boolean).join(" · ");
    const header = actions.closest(".eis-header"); if (header) { const title = header.querySelector(".eis-title"), subtitle = header.querySelector(".eis-subtitle"); if (title) title.textContent = page.title; if (subtitle) subtitle.textContent = page.subtitle; }
    actions.setAttribute("aria-label", `编辑 ${agent.name}`);
    if (!tasks.length) { list.append(el(ctx.document, "div", "ip-empty", `还没有交给${agent.name}的事。`)); return; }
    const active = tasks.filter(task => iphoneTaskStatus(task) !== "completed").sort((a, b) => b.updatedAt - a.updatedAt);
    const completed = tasks.filter(task => iphoneTaskStatus(task) === "completed").sort((a, b) => iphoneTaskTime(b) - iphoneTaskTime(a));
    const groups: [string, MobileSession[]][] = active.length ? [["进行中", active]] : [];
    for (const task of completed) {
      const key = iphoneDateGroup(iphoneTaskTime(task)); const group = groups.find(([label]) => label === key);
      if (group) group[1].push(task); else groups.push([key, [task]]);
    }
    for (const [label, items] of groups) {
      list.append(el(ctx.document, "div", "ip-task-group-label", label));
      for (const task of items) {
        const card = el(ctx.document, "button", "ip-list-task"); card.type = "button"; card.dataset.taskId = task.id;
        const top = el(ctx.document, "span", "ip-list-task-top"); top.append(el(ctx.document, "span", "ip-list-task-title", task.title), iphoneStatus(ctx.document, task));
        card.append(top, el(ctx.document, "span", "ip-sub ip-ellipsis", iphoneTaskSummary(task)));
        card.addEventListener("click", () => { void ctx.navigate({ kind: "task", taskId: task.id }).catch(error => ctx.error(error)); }); list.append(card);
      }
    }
  };
  render(); const unsubscribe = ctx.host.runtime.subscribe(render), identity = ctx.host.services.subscribeIdentity(render), facts = ctx.host.workbench.subscribe(render);
  page.dispose = () => { disposed = true; unsubscribe(); identity(); facts(); composer.dispose(); }; return page;
}

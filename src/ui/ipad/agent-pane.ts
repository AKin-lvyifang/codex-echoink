import { runErrors } from "../../run-reports/recent-errors";
import { Notice } from "obsidian";
import { GENERAL_ASSISTANT_ID } from "../../agents/types";
import { IPadShell } from "./shell";
import { createAgentPage } from "./agent-pages";
import { createAgentFormPage } from "./agent-form";
import { createTaskPage } from "./task-detail";
import { requestIPadTaskResume } from "./composer";
import type { IPadAgentRoute, IPadPageContext, IPadWorkbenchHost } from "./workbench-contract";
import { ipadAvatar, ipadElement as el, ipadIcon, ipadTasks, ipadTaskProjection, ipadTaskStatus, ipadTaskUnread } from "./workbench-elements";

/** The host owns sidebar tabs and visibility; this controller owns only its content. */
export class IPadAgentPane {
  readonly shell: IPadShell;
  private readonly context: IPadPageContext;
  private readonly strip: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly observer?: MutationObserver;
  private serial: Promise<void> = Promise.resolve();
  private closed = false;
  private basePageId = "";
  private observedPageId?: string;
  private activeSync?: { id: string; promise: Promise<void> };
  private stripSignature = "";
  private readonly projections = new Map<string, string>();

  constructor(private readonly root: HTMLElement, private readonly host: IPadWorkbenchHost) {
    root.classList.add("echoink-ipad", "pd-agent-pane");
    this.strip = el(root.ownerDocument, "nav", "pd-agent-strip"); this.strip.setAttribute("aria-label", "Agents");
    this.pane = el(root.ownerDocument, "div", "pd-agent-shell"); root.append(this.strip, this.pane);
    this.shell = new IPadShell(this.pane, { onError: error => this.error(error) });
    this.context = { root, host, document: root.ownerDocument, shell: this.shell,
      navigate: (route, replace) => route.kind === "home" ? host.openHome() : this.navigate(route, replace), error: error => this.error(error) };
    const Observer = root.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => {
        if (this.closed || this.observedPageId === this.shell.activePageId) return;
        this.observedPageId = this.shell.activePageId; this.renderStrip();
        void this.syncActivePage().catch(error => this.error(error));
      });
      this.observer.observe(this.pane, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    }
    this.unsubscribe.push(host.runtime.subscribe(id => {
      if (id) {
        const task = host.store.getSession(id), next = task ? ipadTaskProjection([task]) : "";
        if (this.projections.get(id) === next) return;
      }
      this.renderStrip();
    }), host.services.subscribeIdentity(() => this.renderStrip()), host.workbench.subscribe(() => this.renderStrip()));
  }

  async mount(): Promise<void> {
    if (this.closed || this.shell.activePageId) return;
    await this.host.agents.snapshot();
    if (this.closed) return;
    const saved = this.host.store.state.page;
    const task = saved.kind === "detail" ? this.host.store.getSession(saved.taskId) : undefined;
    const requested = task?.agentId ?? (saved.kind === "list" ? saved.agentId : undefined);
    const agentId = this.host.settings().agentRegistry.agents.some(agent => agent.id === requested) ? requested! : GENERAL_ASSISTANT_ID;
    this.basePageId = `ipad-agent-${agentId}`; this.shell.mount(createAgentPage(this.context, agentId));
    this.renderStrip();
    if (task && !task.archivedAt && (task.taskStatus || task.messages.length > 0 || task.draft)) {
      const page = createTaskPage(this.context, task.id);
      if (!await this.shell.push(page)) page.dispose?.();
    }
    this.renderStrip(); await this.syncActivePage();
  }

  navigate(route: IPadAgentRoute, replace = false): Promise<void> {
    if (this.host.store.unavailableReason && route.kind === "task") return this.navigate({ kind: "agent", agentId: GENERAL_ASSISTANT_ID }, replace);
    const next = this.serial.catch(() => {}).then(async () => {
      if (this.closed) return;
      if (!this.shell.activePageId) await this.mount();
      if (this.closed) return;
      const targetId = route.kind === "agent" ? `ipad-agent-${route.agentId}` : route.kind === "task" ? `task:${route.taskId}` : `ipad-agent-form-${route.agentId ?? "new"}`;
      if (this.shell.activePageId === targetId) return;
      if (this.shell.hasPage(targetId)) {
        if (await this.shell.backTo(targetId)) { this.renderStrip(); await this.syncActivePage(); }
        return;
      }
      if (route.kind === "agent") {
        if (!await this.showAgent(route.agentId)) return;
      } else {
        if (route.kind === "task") {
          const task = this.host.store.getSession(route.taskId);
          if (!task || task.archivedAt) throw new Error("任务已不存在。");
          if (!await this.showAgent(task.agentId)) return;
        } else if (route.agentId && !await this.showAgent(route.agentId)) return;
        const page = route.kind === "task" ? createTaskPage(this.context, route.taskId) : createAgentFormPage(this.context, route.agentId);
        // A task always retains its owning list underneath it, including deep links.
        const replaceForm = route.kind === "agent-form" && replace && this.shell.activePageId?.startsWith("ipad-agent-form-");
        const moved = replaceForm ? await this.shell.replace(page) : await this.shell.push(page);
        if (!moved) { page.dispose?.(); return; }
      }
      this.renderStrip(); await this.syncActivePage();
    });
    this.serial = next; return next;
  }

  /** All continue entry points resolve in this pane, including its current reply draft. */
  async resumeTask(taskId: string): Promise<void> {
    await this.navigate({ kind: "task", taskId });
    const pageId = `task:${taskId}`;
    if (this.closed || this.shell.activePageId !== pageId) return;
    const ready = await this.shell.requestLeave(() => true);
    if (!ready || this.closed || this.shell.activePageId !== pageId) return;
    await requestIPadTaskResume(this.context, taskId);
  }

  private async showAgent(agentId: string): Promise<boolean> {
    const id = `ipad-agent-${agentId}`;
    if (this.shell.activePageId === id) return true;
    if (!this.host.settings().agentRegistry.agents.some(agent => agent.id === agentId)) throw new Error("这个 Agent 已被删除。");
    if (this.shell.hasPage(id)) return this.shell.backTo(id);
    if (this.basePageId && this.shell.hasPage(this.basePageId) && !await this.shell.backTo(this.basePageId)) return false;
    const page = createAgentPage(this.context, agentId);
    if (!await this.shell.replace(page)) { page.dispose?.(); return false; }
    this.basePageId = id; return true;
  }

  private currentAgent(): string | undefined {
    const id = this.shell.activePageId;
    if (id?.startsWith("task:")) return this.host.store.getSession(id.slice(5))?.agentId;
    return id?.startsWith("ipad-agent-") && !id.startsWith("ipad-agent-form-") ? id.slice("ipad-agent-".length) : undefined;
  }

  private renderStrip(): void {
    if (this.closed) return;
    const tasks = ipadTasks(this.host.store.state.sessions), registry = this.host.settings().agentRegistry;
    const signature = this.currentAgent() + JSON.stringify(registry.agents) + ipadTaskProjection(tasks);
    if (signature === this.stripSignature) return;
    this.stripSignature = signature; this.projections.clear();
    for (const task of tasks) this.projections.set(task.id, ipadTaskProjection([task]));
    const scroll = this.strip.scrollLeft, focused = (this.root.ownerDocument.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-agent-id]")?.dataset.agentId;
    this.strip.replaceChildren();
    for (const agent of registry.agents) {
      const mine = tasks.filter(task => task.agentId === agent.id), waiting = mine.filter(task => ipadTaskStatus(task) === "waiting").length;
      const interrupted = mine.some(task => ipadTaskStatus(task) === "interrupted"), running = mine.some(task => ipadTaskStatus(task) === "running"), unread = mine.some(ipadTaskUnread);
      const button = el(this.root.ownerDocument, "button", `pd-agent-avatar${this.currentAgent() === agent.id ? " is-selected" : ""}`); button.type = "button"; button.dataset.agentId = agent.id;
      const label = [agent.name, waiting ? `${waiting} 件等你回应` : "", interrupted ? "有中断" : "", running ? "正在进行" : "", unread ? "有新结果" : ""].filter(Boolean).join(" · ");
      button.setAttribute("aria-label", label); button.title = label; button.setAttribute("aria-pressed", String(this.currentAgent() === agent.id)); button.append(ipadAvatar(this.root.ownerDocument, agent));
      if (waiting || interrupted || running || unread) {
        const kind = waiting ? "waiting" : interrupted ? "interrupted" : running ? "running" : "unread";
        const badge = el(this.root.ownerDocument, "span", `pd-agent-badge is-${kind}`); badge.setAttribute("aria-hidden", "true");
        if (waiting) badge.textContent = `${waiting}`; else if (interrupted) badge.textContent = "!"; else if (running) badge.append(ipadIcon(this.root.ownerDocument, "loader-circle")); button.append(badge);
      }
      button.addEventListener("click", () => { void this.navigate({ kind: "agent", agentId: agent.id }).catch(error => this.error(error)); }); this.strip.append(button);
    }
    const add = el(this.root.ownerDocument, "button", "pd-agent-add"); add.type = "button"; add.setAttribute("aria-label", "新建 Agent"); add.append(ipadIcon(this.root.ownerDocument, "user-plus"));
    add.addEventListener("click", () => { void this.navigate({ kind: "agent-form" }).catch(error => this.error(error)); }); this.strip.append(add);
    this.strip.scrollLeft = scroll;
    if (focused) Array.from(this.strip.querySelectorAll<HTMLElement>("[data-agent-id]")).find(node => node.dataset.agentId === focused)?.focus({ preventScroll: true });
  }

  private syncActivePage(): Promise<void> {
    if (this.closed || this.host.store.unavailableReason) return Promise.resolve();
    const pageId = this.shell.activePageId, agentId = this.currentAgent();
    if (!pageId || !agentId) return Promise.resolve();
    if (this.activeSync?.id === pageId) return this.activeSync.promise;
    const taskId = pageId.startsWith("task:") ? pageId.slice(5) : undefined;
    const promise: Promise<void> = this.host.store.update(state => {
      if (this.closed || this.shell.activePageId !== pageId) return;
      if (taskId) {
        state.activeSessionId = taskId; state.page = { kind: "detail", taskId };
        const task = state.sessions.find(task => task.id === taskId);
        if (task) task.lastReadAt = Math.max(task.lastReadAt ?? 0, task.unreadAnswerAt ?? 0);
      } else state.page = { kind: "list", agentId };
    }).then(() => {
      if (this.shell.activePageId === pageId) this.host.workbench.refreshTasks?.();
    }).finally(() => { if (this.activeSync?.promise === promise) this.activeSync = undefined; });
    this.activeSync = { id: pageId, promise }; return promise;
  }

  private error(error: unknown): void { runErrors.record("mobile.page", error, { conversationId: this.shell.activePageId?.startsWith("task:") ? this.shell.activePageId.slice(5) : undefined }); new Notice(error instanceof Error ? error.message : String(error)); }
  dispose(): void {
    if (this.closed) return; this.closed = true; this.observer?.disconnect(); this.unsubscribe.forEach(unsubscribe => unsubscribe());
    this.shell.dispose(); this.strip.remove(); this.pane.remove(); this.root.classList.remove("echoink-ipad", "pd-agent-pane");
  }
}

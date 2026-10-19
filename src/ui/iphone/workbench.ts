import { Notice } from "obsidian";
import { IPhoneShell } from "./shell";
import { createAgentPage, createHomePage } from "./workbench-pages";
import { createAgentFormPage } from "./agent-form";
import { createTaskPage } from "./task-detail";
import type { IPhonePageContext, IPhoneRoute, IPhoneWorkbenchHost } from "./workbench-contract";
import type { MobileSettingsRoute } from "../mobile/settings-pages";
import type { AgentModuleId } from "../../agents/types";
import { MobileUI } from "../mobile/mobile-ui";
import { shellElement } from "../mobile/shell-controls";
import { readNativeJournalSettings } from "../../home/native-journal";

/** iPhone page composition. iPad never instantiates this controller. */
export class IPhoneWorkbench {
  readonly shell: IPhoneShell;
  private readonly context: IPhonePageContext;
  private serial = Promise.resolve();
  private closed = false;
  constructor(private readonly root: HTMLElement, private readonly host: IPhoneWorkbenchHost) {
    this.shell = new IPhoneShell(root, { onError: error => this.error(error) });
    this.context = { host, document: root.ownerDocument, shell: this.shell,
      navigate: (route, replace) => this.navigate(route, replace), error: error => this.error(error) };
  }
  async mount(): Promise<void> {
    this.shell.mount(createHomePage(this.context));
    const page = this.host.store.state.page;
    if (page.kind === "detail") {
      const task = this.host.store.state.sessions.find(task => task.id === page.taskId);
      if (task && (task.messages.length || task.draft)) {
        await this.navigate({ kind: "agent", agentId: task.agentId });
        await this.navigate({ kind: "task", taskId: task.id });
      }
    }
  }
  navigate(route: IPhoneRoute, replace = false): Promise<void> {
    const next = this.serial.catch(() => {}).then(async () => {
      if (this.closed) return;
      if (route.kind === "task" && this.shell.activePageId !== `task:${route.taskId}`) {
        const task = this.host.store.getSession(route.taskId);
        if (!task) throw new Error("任务已不存在。");
        const list = createAgentPage(this.context, task.agentId);
        if (this.shell.activePageId !== list.id) {
          if (this.shell.hasPage(list.id)) {
            list.dispose?.();
            if (!await this.shell.backTo(list.id)) return;
          } else if (!await this.shell.push(list)) { list.dispose?.(); return; }
        } else list.dispose?.();
      }
      const page = route.kind === "home" ? createHomePage(this.context)
        : route.kind === "agent" ? createAgentPage(this.context, route.agentId)
        : route.kind === "task" ? createTaskPage(this.context, route.taskId)
        : createAgentFormPage(this.context, route.agentId);
      if (page.id === this.shell.activePageId) { page.dispose?.(); return; }
      const existing = this.shell.hasPage(page.id);
      const moved = existing ? await this.shell.backTo(page.id) : replace ? await this.shell.replace(page) : await this.shell.push(page);
      if (existing) page.dispose?.();
      if (!moved) { if (!existing) page.dispose?.(); return; }
      if (route.kind === "agent") await this.host.store.update(state => { state.page = { kind: "list", agentId: route.agentId }; });
      if (route.kind === "task") await this.host.store.update(state => {
        state.activeSessionId = route.taskId; state.page = { kind: "detail", taskId: route.taskId };
        const task = state.sessions.find(task => task.id === route.taskId);
        if (task) task.lastReadAt = Date.now();
      });
      if (route.kind === "task") this.host.workbench.refreshTasks?.();
    });
    this.serial = next;
    return next;
  }
  async openLegacy(page: MobileSettingsRoute): Promise<void> {
    const content = shellElement(this.root.ownerDocument, "div", "ip-legacy");
    const ui = new MobileUI(content, {
      app: this.host.app, store: this.host.store, runtime: this.host.runtime, services: this.host.services,
      settings: this.host.settings, saveSettings: this.host.saveSettings, settingsOnly: true,
      accountService: this.host.accountService, version: this.host.version,
      settingsRoot: page, onSettingsRootBack: async () => { await this.shell.back(); },
      openChat: async () => { await this.shell.back(); }, openNote: this.host.openNote,
      beginRender: () => {}, renderMarkdown: this.host.renderMarkdown
    });
    ui.mount();
    const accepted = await this.shell.push({ id: `legacy:${page}`, title: "设置", header: "content", content, dispose: () => ui.destroy() });
    if (!accepted) ui.destroy();
  }
  async openModule(module: AgentModuleId): Promise<void> {
    if (module === "todos") return this.openLegacy("todos");
    if (module === "knowledge-base") return this.openLegacy("knowledge");
    if (module === "finance") { await this.host.services.lifestyle.open("finance"); return; }
    if (module !== "journal" && module !== "english-diary") return;
    const title = module === "journal" ? "日记" : "英文日记";
    const settings = this.host.settings();
    const journal = module === "journal" ? readNativeJournalSettings(this.host.app, settings.journalDirectory, settings.knowledgeBase.folderBindings) : undefined;
    if (journal && !journal.available) throw new Error("日记目录尚未配置。");
    const directory = module === "journal"
      ? journal!.folder
      : this.host.services.safePath(settings.englishDiary.englishDirectory);
    const files = this.host.app.vault.getMarkdownFiles().filter(file => directory ? file.path.startsWith(`${directory}/`) : !file.path.includes("/")).sort((a, b) => b.stat.mtime - a.stat.mtime);
    const content = shellElement(this.root.ownerDocument, "div", "ip-module-files");
    if (!files.length) content.append(shellElement(this.root.ownerDocument, "p", "ip-empty", "还没有记录。"));
    for (const file of files) {
      const button = shellElement(this.root.ownerDocument, "button", "ip-file-row", file.basename);
      button.type = "button"; button.addEventListener("click", () => { void this.host.openNote(file.path).catch(error => this.error(error)); }); content.append(button);
    }
    await this.shell.push({ id: `module:${module}`, title, content });
  }
  private error(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }
  dispose(): void { this.closed = true; this.shell.dispose(); }
}

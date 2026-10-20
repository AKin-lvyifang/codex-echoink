import { type App, setIcon } from "obsidian";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId } from "../agents/types";
import { AgentEditorController } from "../ui/codex-view/agent-editor";
import type { AgentEditorHost } from "../ui/codex-view/agent-editor-contract";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import { createOriginButton, createOriginSelect, disposeOriginControls } from "./origin-controls";
import { attachSettingsTooltip, createSettingsGroup, createSettingsNavigationRow, createSettingsSection } from "./settings-v2";

export interface DesktopAgentSettingsHost extends Omit<AgentEditorHost, "onClose" | "backLabel" | "confirmLeave"> {
  readonly app?: Pick<App, "scope" | "keymap">;
  setAgentModuleOwner(moduleId: AgentModuleId, agentId: string): Promise<void>;
}
export interface DesktopAgentSettingsNavigation {
  redraw(): void;
  restoreFocus?(focusKey: string): void;
}
const moduleNames: Record<AgentModuleId, readonly [string, string]> = {
  "knowledge-base": ["知识库", "Knowledge"], journal: ["日记", "Journal"], review: ["复盘", "Review"], todos: ["待办", "To-dos"],
  finance: ["财务", "Finance"], "english-diary": ["英文日记", "English diary"], "pdf-reading": ["PDF 精读", "PDF reading"]
};
const moduleOrder: readonly AgentModuleId[] = ["knowledge-base", "journal", "review", "todos", "finance", "english-diary", "pdf-reading"];

/** Desktop Settings owns only navigation and presentation; the plugin owns writes. */
export class DesktopAgentSettings {
  private editor: AgentEditorController | null = null;
  private editorHost: HTMLElement | null = null;
  private summaryHost: HTMLElement | null = null;
  private focusAgent: string | undefined;
  private pendingLeave: (() => void) | null = null;
  private readonly pendingOwners = new Set<AgentModuleId>();
  private readonly ownerErrors = new Map<AgentModuleId, string>();
  private summaryScroll = 0;
  private disposed = false;
  constructor(private readonly host: DesktopAgentSettingsHost, private readonly navigation: DesktopAgentSettingsNavigation) {}

  get returnFocusKey(): string { return this.focusAgent ? `agent:${this.focusAgent}:edit` : "agent:new"; }
  get isDetail(): boolean { return this.editor !== null; }
  get hasDraft(): boolean { return this.submitting || this.editor?.hasUnsavedChanges() === true; }
  get submitting(): boolean { return this.pendingOwners.size > 0 || this.editor?.isPending() === true; }
  private text(zh: string, en: string): string { return this.host.settings.settingsLanguage === "en" ? en : zh; }
  private moduleName(module: AgentModuleId): string { return moduleNames[module][this.host.settings.settingsLanguage === "en" ? 1 : 0]; }
  private owner(module: AgentModuleId): AgentDefinition {
    const registry = this.host.settings.agentRegistry;
    return registry.agents.find(agent => agent.id === registry.moduleOwners[module]) ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
  }

  renderSummary(parent: HTMLElement): void {
    if (this.disposed) return;
    this.clearSummary();
    const root = this.summaryHost = parent.createDiv({ cls: "echoink-agent-settings" });
    const agents = createSettingsSection(root, { title: "Agent", surface: "flat" });
    const header = agents.querySelector<HTMLElement>(".echoink-settings-section-header")!;
    const add = createOriginButton(header, { cls: "is-icon", attr: { "aria-label": this.text("新建 Agent", "New Agent"), "data-echoink-focus-key": "agent:new" } });
    setIcon(add, "plus"); add.onclick = () => this.open();
    const list = createSettingsGroup(agents); list.addClass("echoink-agent-settings-list");
    for (const agent of this.host.settings.agentRegistry.agents) {
      const owned = AGENT_MODULE_IDS.filter(module => this.host.settings.agentRegistry.moduleOwners[module] === agent.id);
      const row = createSettingsNavigationRow(list, { title: agent.name, description: agent.position || undefined,
        focusKey: `agent:${agent.id}:edit`, onActivate: () => this.open(agent.id) });
      row.addClass("echoink-agent-settings-row");
      if (owned.length) {
        const fullList = `${this.text("负责", "Responsible for")} ${owned.map(module => this.moduleName(module)).join(this.text("、", ", "))}`;
        const modules = row.createSpan({ cls: "echoink-agent-settings-modules", text: owned.length > 3 ? this.text(`负责 ${owned.length} 个模块`, `Responsible for ${owned.length} modules`) : fullList });
        row.insertBefore(modules, row.querySelector(".echoink-settings-navigation-trailing"));
        const activate = row.onclick;
        attachSettingsTooltip(row, fullList, row, { interactive: false });
        row.onclick = activate;
      }
      const avatar = row.createSpan({ cls: "echoink-agent-settings-avatar", attr: { "aria-hidden": "true" } }); this.avatar(avatar, agent);
      row.insertBefore(avatar, row.firstChild);
      if (agent.id === GENERAL_ASSISTANT_ID) row.querySelector<HTMLElement>(".echoink-settings-navigation-title")?.createSpan({ cls: "settings-badge echoink-agent-settings-builtin", text: this.text("内置", "Built-in") });
    }
    const owners = createSettingsSection(root, { title: this.text("模块负责人", "Module owners"), surface: "flat" });
    const ownerList = createSettingsGroup(owners);
    for (const module of moduleOrder) {
      const row = ownerList.createDiv({ cls: "echoink-agent-owner-row", attr: { "data-agent-owner-module": module } });
      const label = row.createEl("label", { text: this.moduleName(module), attr: { id: `echoink-agent-owner-label-${module}` } });
      const controls = row.createDiv({ cls: "echoink-agent-owner-control" });
      const initial = this.owner(module);
      const avatar = controls.createSpan({ cls: "echoink-agent-owner-avatar echoink-agent-settings-avatar", attr: { "aria-hidden": "true" } }); this.avatar(avatar, initial);
      const select = createOriginSelect(controls, { attr: { "aria-labelledby": label.id, "aria-label": this.text(`${this.moduleName(module)}负责人`, `${this.moduleName(module)} owner`), "data-echoink-focus-key": `agent:owner:${module}` } },
        this.host.settings.agentRegistry.agents.map(agent => ({ value: agent.id, label: agent.name })), initial.id, this.host.app).element;
      select.disabled = this.pendingOwners.has(module);
      const status = row.createDiv({ cls: `echoink-agent-owner-status${this.ownerErrors.has(module) ? " is-error" : ""}`, text: this.ownerErrors.get(module) ?? "", attr: { role: "status", "aria-live": "polite" } });
      select.onchange = () => {
        if (this.pendingOwners.has(module) || this.disposed) return;
        const next = select.value;
        this.pendingOwners.add(module); this.ownerErrors.delete(module); select.disabled = true;
        status.removeClass("is-error");
        status.textContent = this.text("正在保存…", "Saving…");
        void this.host.setAgentModuleOwner(module, next).catch(error => {
          const saved = this.owner(module); select.value = saved.id;
          const message = `${this.text(`负责人未保存，仍由 ${saved.name} 负责。`, `The owner was not saved. ${saved.name} is still responsible.`)} ${error instanceof Error ? error.message : String(error)}`;
          this.ownerErrors.set(module, message); status.addClass("is-error"); status.textContent = message;
        }).finally(() => {
          this.pendingOwners.delete(module);
          if (this.disposed) return;
          select.value = this.owner(module).id; select.disabled = false;
          if (!this.ownerErrors.has(module)) status.textContent = this.text("已保存", "Saved");
          this.navigation.redraw();
        });
      };
    }
    list.scrollTop = this.summaryScroll;
  }

  open(agentId?: string): void {
    if (this.disposed || this.submitting) return;
    if (this.editor) { this.requestLeave(() => this.startEditor(agentId)); return; }
    this.startEditor(agentId);
  }
  private startEditor(agentId?: string): void {
    this.focusAgent = agentId;
    this.clearSummary();
    const host = this.host;
    this.editor = new AgentEditorController({
      get settings() { return host.settings; }, draftCacheKey: this.host.draftCacheKey,
      backLabel: this.text("返回 Agent 设置", "Back to Agent settings"), confirmLeave: true,
      loadResources: () => this.host.loadResources(), getCapabilityAvailability: id => this.host.getCapabilityAvailability?.(id) ?? { available: true },
      saveAgent: (agent, modules, baseline) => this.host.saveAgent(agent, modules, baseline), deleteAgent: id => this.host.deleteAgent(id), getDeleteCounts: id => this.host.getDeleteCounts(id),
      onClose: id => {
        const focus = id ?? this.focusAgent;
        this.clearEditor();
        this.navigation.restoreFocus?.(focus ? `agent:${focus}:edit` : "agent:new");
        this.navigation.redraw();
      }
    });
    this.editor.open(agentId); this.navigation.redraw();
  }

  renderDetail(parent: HTMLElement): void {
    if (!this.editor || this.disposed) return;
    if (!this.editorHost || this.editorHost.ownerDocument !== parent.ownerDocument) {
      this.editorHost?.remove();
      this.editorHost = parent.createDiv({ cls: "echoink-agent-settings-editor" });
      this.editor.render(this.editorHost);
    } else parent.appendChild(this.editorHost);
    if (this.pendingLeave) { const done = this.pendingLeave; this.pendingLeave = null; this.requestLeave(done); }
  }
  requestLeave(done: () => void): void {
    if (this.submitting) return;
    if (!this.editor) { done(); return; }
    if (!this.editorHost?.isConnected && this.editor.hasUnsavedChanges()) { this.pendingLeave = done; return; }
    this.editor.requestLeave(() => { this.clearEditor(); done(); });
  }
  suspend(): void { this.clearSummary(); this.editorHost?.remove(); }
  dispose(): void { this.disposed = true; this.pendingLeave = null; this.clearSummary(); this.clearEditor(); }

  private clearSummary(): void {
    if (!this.summaryHost) return;
    this.summaryScroll = this.summaryHost.querySelector<HTMLElement>(".echoink-agent-settings-list")?.scrollTop ?? this.summaryScroll;
    disposeOriginControls(this.summaryHost); this.summaryHost.remove(); this.summaryHost = null;
  }
  private clearEditor(): void { this.editor?.dispose(); this.editor = null; this.editorHost?.remove(); this.editorHost = null; }
  private avatar(parent: HTMLElement, agent: AgentDefinition): void {
    const source = resolveAgentAvatarUrl(agent.avatar);
    if (!source) { setIcon(parent, "bot"); return; }
    const image = parent.createEl("img", { cls: "echoink-agent-settings-avatar-image", attr: { src: source, alt: "" } });
    image.onerror = () => { image.remove(); setIcon(parent, "bot"); };
  }
}

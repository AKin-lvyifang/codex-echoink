import { getModuleOwner } from "../agents/registry";
import { WORKBENCH_MODULES } from "../home/module-navigation";
import { agentRoleGroups } from "../agents/roster-groups";
import { isAgentHired } from "../agents/persona";
import { agentPositionDescription } from "../agents/identity";
import { type App, setIcon } from "obsidian";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId } from "../agents/types";
import { AgentEditorController } from "../ui/codex-view/agent-editor";
import type { AgentEditorCreationOptions, AgentEditorHost } from "../ui/codex-view/agent-editor-contract";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import { createOriginButton, createOriginSelect, disposeOriginControls } from "./origin-controls";
import { createSettingsGroup, createSettingsNavigationRow, createSettingsSection } from "./settings-v2";

export interface DesktopAgentSettingsHost extends Omit<AgentEditorHost, "onClose" | "backLabel" | "confirmLeave"> {
  readonly app?: Pick<App, "scope" | "keymap">;
  openExpertHall?(): Promise<void>;
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
  private owner(module: AgentModuleId): AgentDefinition | null { return getModuleOwner(this.host.settings.agentRegistry, module); }

  renderSummary(parent: HTMLElement): void {
    if (this.disposed) return;
    this.clearSummary();
    const root = this.summaryHost = parent.createDiv({ cls: "echoink-agent-settings" });
    const sections = new Map(agentRoleGroups(this.host.settings.agentRegistry.agents.filter(isAgentHired), this.host.settings.settingsLanguage === "en").map(group => {
      const section = createSettingsSection(root, { title: group.label, surface: "flat" });
      section.dataset.agentGroup = group.id;
      const list = createSettingsGroup(section); list.addClass("echoink-agent-settings-list");
      return [group.id, { section, list, agents: group.agents }] as const;
    }));
    const agents = sections.get("role")!.section;
    const header = agents.querySelector<HTMLElement>(".echoink-settings-section-header")!;
    const actions = header.createDiv({ cls: "echoink-agent-settings-actions" });
    const add = createOriginButton(actions, { cls: "is-icon", attr: { "aria-label": this.text("新建 Agent", "New Agent"), "data-echoink-focus-key": "agent:new" } });
    setIcon(add, "plus"); add.onclick = () => this.open();
    const list = sections.get("role")!.list;
    for (const agent of agentRoleGroups(this.host.settings.agentRegistry.agents.filter(isAgentHired)).flatMap(group => group.agents)) {
      const list = sections.get(agent.id === GENERAL_ASSISTANT_ID ? "main" : "role")!.list;
      const main = agent.id === GENERAL_ASSISTANT_ID;
      const row = createSettingsNavigationRow(list, { title: agent.name,
        description: main ? undefined : agent.position || agentPositionDescription(agent) || undefined,
        value: main ? this.text(agent.companyApprovalMode === "assistant" ? "总助审批" : "我来审批", agent.companyApprovalMode === "assistant" ? "Assistant approves" : "I approve") : undefined,
        focusKey: `agent:${agent.id}:edit`, onActivate: () => this.open(agent.id) });
      row.addClass("echoink-agent-settings-row");
      const avatar = row.createSpan({ cls: "echoink-agent-settings-avatar", attr: { "aria-hidden": "true" } }); this.avatar(avatar, agent);
      row.insertBefore(avatar, row.firstChild);
    }
    const owners = createSettingsSection(root, { title: this.text("模块负责人", "Module owners"), surface: "flat" });
    const count = AGENT_MODULE_IDS.filter(module => !this.owner(module)).length;
    if (count) owners.querySelector(".echoink-settings-section-header")?.createSpan({ cls: "echoink-agent-owner-count", text: this.text(`${count} 个未指定`, `${count} unassigned`) });
    const ownerList = createSettingsGroup(owners);
    for (const module of moduleOrder) {
      const row = ownerList.createDiv({ cls: "echoink-agent-owner-row", attr: { "data-agent-owner-module": module } });
      const label = row.createEl("label", { text: this.moduleName(module), attr: { id: `echoink-agent-owner-label-${module}` } });
      const icon = row.createSpan({ cls: "echoink-agent-owner-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, WORKBENCH_MODULES.find(item => item.id === module)?.icon ?? "chart-no-axes-combined"); row.insertBefore(icon, label);
      const controls = row.createDiv({ cls: "echoink-agent-owner-control" });
      const initial = this.owner(module);
      const select = createOriginSelect(controls, { attr: { "aria-labelledby": label.id, "aria-label": this.text(`${this.moduleName(module)}负责人`, `${this.moduleName(module)} owner`), "data-echoink-focus-key": `agent:owner:${module}` } },
        [{ value: "", label: initial ? this.text("不指定", "Unassigned") : this.text("未指定", "Unassigned"), renderIcon: (node: HTMLElement) => { node.replaceChildren(); setIcon(node, "circle-dashed"); } }, ...this.host.settings.agentRegistry.agents.filter(agent => agent.id !== GENERAL_ASSISTANT_ID && isAgentHired(agent)).map(agent => ({ value: agent.id, label: agent.name, renderIcon: (node: HTMLElement) => this.avatar(node, agent) })), { value: "__new_agent__", label: this.text("新建 Agent…", "New Agent…"), group: " " }], initial?.id ?? "", this.host.app).element;
      select.disabled = this.pendingOwners.has(module);
      const status = row.createDiv({ cls: `echoink-agent-owner-status${this.ownerErrors.has(module) ? " is-error" : ""}`, text: this.ownerErrors.get(module) ?? "", attr: { role: "status", "aria-live": "polite" } });
      select.onchange = () => {
        if (this.pendingOwners.has(module) || this.disposed) return;
        const next = select.value;
        if (next === "__new_agent__") { this.open(undefined, { moduleIds: [module] }); return; }
        this.pendingOwners.add(module); this.ownerErrors.delete(module); select.disabled = true;
        status.removeClass("is-error");
        status.textContent = this.text("正在保存…", "Saving…");
        void this.host.setAgentModuleOwner(module, next).catch(error => {
          const saved = this.owner(module); select.value = saved?.id ?? "";
          const message = `${this.text(`负责人未保存，仍由 ${saved?.name ?? this.text("未指定", "Unassigned")} 负责。`, `The owner was not saved. ${saved?.name ?? this.text("未指定", "Unassigned")} is still responsible.`)} ${error instanceof Error ? error.message : String(error)}`;
          this.ownerErrors.set(module, message); status.addClass("is-error"); status.textContent = message;
        }).finally(() => {
          this.pendingOwners.delete(module);
          if (this.disposed) return;
          select.value = this.owner(module)?.id ?? ""; select.disabled = false;
          if (!this.ownerErrors.has(module)) status.textContent = this.text("已保存", "Saved");
          this.navigation.redraw();
        });
      };
    }
    list.scrollTop = this.summaryScroll;
  }

  open(agentId?: string, options: AgentEditorCreationOptions = {}): void {
    if (this.disposed || this.submitting) return;
    if (this.editor) { this.requestLeave(() => this.startEditor(agentId, options)); return; }
    this.startEditor(agentId, options);
  }
  private startEditor(agentId?: string, options: AgentEditorCreationOptions = {}): void {
    this.focusAgent = agentId;
    this.clearSummary();
    const host = this.host;
    this.editor = new AgentEditorController({
      get settings() { return host.settings; }, draftCacheKey: this.host.draftCacheKey,
      backLabel: this.text("返回 Agent 设置", "Back to Agent settings"), confirmLeave: true,
      loadResources: () => this.host.loadResources(), getCapabilityAvailability: id => this.host.getCapabilityAvailability?.(id) ?? { available: true },
      saveAgent: (agent, modules, baseline) => this.host.saveAgent(agent, modules, baseline), deleteAgent: id => this.host.deleteAgent(id), getDeleteCounts: id => this.host.getDeleteCounts(id),
      dismissExpert: id => host.dismissExpert!(id), showExpertAbout: id => host.showExpertAbout?.(id),
      onClose: id => {
        const focus = id ?? this.focusAgent;
        this.clearEditor();
        this.navigation.restoreFocus?.(focus ? `agent:${focus}:edit` : "agent:new");
        this.navigation.redraw();
        options.onReturn?.();
      }
    });
    this.editor.open(agentId, options); this.navigation.redraw();
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
    parent.replaceChildren();
    const source = resolveAgentAvatarUrl(agent.avatar);
    if (!source) { setIcon(parent, "bot"); return; }
    const image = parent.createEl("img", { cls: "echoink-agent-settings-avatar-image", attr: { src: source, alt: "" } });
    image.onerror = () => { image.remove(); setIcon(parent, "bot"); };
  }
}

import { Modal, Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentModuleId } from "../agents/types";
import { AGENT_MODULE_NAMES, GENERAL_ASSISTANT_ID } from "../agents/types";
import { isAgentHired } from "../agents/persona";
import { getModuleOwner } from "../agents/registry";
import { createOriginButton, createOriginRadioGroup, disposeOriginControls } from "../settings/origin-controls";
import { resolveAgentAvatarUrl } from "./agent-avatar-presets";

export const MODULE_LABELS = AGENT_MODULE_NAMES;
export function moduleOwnerLabel(plugin: Pick<CodexForObsidianPlugin, "settings">, module: AgentModuleId): string {
  const owner = getModuleOwner(plugin.settings.agentRegistry, module), en = plugin.settings.settingsLanguage === "en";
  return owner ? en ? `Assign to ${owner.name}` : `交给 ${owner.name}` : en ? "Assign owner" : "指定负责人";
}

/** No task exists until the owner has been saved. The explicit primary action runs once. */
export class ModuleOwnerModal extends Modal {
  private busy = false;
  private closed = false;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly module: AgentModuleId,
    private readonly run?: () => Promise<unknown>) { super(plugin.app); }
  onOpen(): void {
    const en = this.plugin.settings.settingsLanguage === "en", name = MODULE_LABELS[this.module][en ? 1 : 0];
    this.modalEl.addClass("echoink-module-owner-modal", "echoink-theme-boundary");
    this.titleEl.setText(en ? `${name} has no owner` : `${name}还没有负责人`);
    const body = this.contentEl.createDiv({ cls: "echoink-module-owner-list" });
    const error = this.contentEl.createDiv({ cls: "echoink-module-owner-error", attr: { role: "status" } });
    let selected = "";
    const group = createOriginRadioGroup(body, "", this.titleEl.textContent ?? "", value => {
      selected = value; const agent = this.plugin.settings.agentRegistry.agents.find(a => a.id === value);
      start.textContent = en ? `Assign to ${agent?.name ?? "Ta"}` : `交给 ${agent?.name ?? "Ta"}`;
      start.disabled = !selected || this.busy;
    });
    for (const agent of this.plugin.settings.agentRegistry.agents.filter(a => a.id !== GENERAL_ASSISTANT_ID && isAgentHired(a))) {
      const row = group.element.createEl("label", { cls: "echoink-module-owner-option" });
      group.addItem(row, agent.id, false).setAttribute("aria-label", agent.name);
      const avatar = resolveAgentAvatarUrl(agent.avatar);
      if (avatar) row.createEl("img", { attr: { src: avatar, alt: "" } });
      const text = row.createDiv({ cls: "echoink-module-owner-copy" }); text.createSpan({ text: agent.name });
      if (agent.position) text.createDiv({ cls: "echoink-module-owner-position", text: agent.position });
    }
    const footer = this.contentEl.createDiv({ cls: "echoink-module-owner-actions" });
    const cancel = createOriginButton(footer, { text: en ? "Cancel" : "取消" }); cancel.onclick = () => { if (!this.busy) this.close(); };
    const create = createOriginButton(footer, { text: en ? "New Agent" : "新建 Agent" });
    create.onclick = () => {
      if (this.busy) return;
      this.close(); void this.plugin.openModuleAgentCreation(this.module).catch(e => new Notice(String(e)));
    };
    const start = createOriginButton(footer, { text: en ? "Assign to Ta" : "交给 Ta", cls: "is-primary mod-cta" }); start.disabled = true;
    start.onclick = () => {
      if (!selected || this.busy) return;
      this.busy = true; group.element.inert = true; start.disabled = create.disabled = cancel.disabled = true; error.textContent = "";
      void (async () => {
        try {
          await this.plugin.setAgentModuleOwner(this.module, selected);
          if (this.closed) return;
          this.close();
          await this.run?.();
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure);
          if (this.contentEl.isConnected) error.textContent = message; else new Notice(message);
          this.busy = false; group.element.inert = false; start.disabled = !selected; create.disabled = cancel.disabled = false;
        }
      })();
    };
  }
  onClose(): void { this.closed = true; disposeOriginControls(this.contentEl); this.contentEl.empty(); }
}

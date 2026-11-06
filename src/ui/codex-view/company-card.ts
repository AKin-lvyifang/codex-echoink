import { getModuleOwner } from "../../agents/registry";
import { MODULE_LABELS } from "../module-owner-modal";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { companyApprovals, companyDecisions } from "../../company/interaction-bridge";
import { projectEstimatedTurns, projectMilestones } from "../../company/logic";
import { GENERAL_ASSISTANT_ID } from "../../agents/types";
import type { CompanyProject } from "../../company/types";
import { applyAmicroButton, setAmicroButtonPending } from "../../settings/amicro-buttons";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";

/** Program-owned controls appended to the original router conversation. */
export class CompanyConversationCard {
  private root?: HTMLElement;
  private signature = "";
  private readonly busy = new Set<string>();
  constructor(private readonly plugin: CodexForObsidianPlugin) {}
  dispose(): void {
    if (this.root) disposeOriginControls(this.root);
    this.root?.remove(); this.root = undefined; this.signature = "";
  }
  render(parent: HTMLElement, routerId: string): void {
    const service = this.plugin.companyService;
    const dispatch = service?.dispatchOf(routerId);
    const ownerId = dispatch?.routerConversationId ?? routerId;
    const project = dispatch ? undefined : service?.projectForRouter(ownerId);
    const approvals = service ? companyApprovals(this.plugin, service.doc, { routerId: ownerId }).filter(a => !dispatch || a.dispatch.id === dispatch.id) : [];
    const waiting = service ? companyDecisions(this.plugin, service.doc, { routerId: ownerId }).filter(d => !dispatch || d.id === dispatch.id) : [];
    const assignments = service?.pendingModuleAssignments(ownerId) ?? [];
    if (!service || !assignments.length && project?.status !== "proposed" && !approvals.length && !waiting.length) { this.dispose(); return; }
    const signature = JSON.stringify([routerId, project, assignments, this.plugin.settings.agentRegistry, approvals.map(a => a.key), waiting, [...this.busy]]);
    if (this.root?.parentElement === parent && this.signature === signature) return;
    this.dispose(); this.signature = signature;
    const root = this.root = parent.createDiv({ cls: "codex-message assistant echoink-company-message", attr: { "data-company-router": routerId, "data-message-tail": "true" } });
    if (project?.status === "proposed") this.proposal(root, project, () => {
      if (this.root?.parentElement === parent && this.root.dataset.companyRouter === routerId) this.render(parent, routerId);
    });
    for (const request of assignments) {
      const row = root.createDiv({ cls: "echoink-company-owner-required", attr: { role: "status" } });
      const owner = getModuleOwner(this.plugin.settings.agentRegistry, request.moduleId);
      row.createSpan({ text: owner ? `${MODULE_LABELS[request.moduleId][0]}已指定 ${owner.name}` : `${MODULE_LABELS[request.moduleId][0]}还没有负责人` });
      const action = this.button(row, owner ? `交给 ${owner.name}` : "指定负责人", "secondary");
      const resume = async () => { action.disabled = true; try { await service.retryModuleAssignment(request.id); } finally { this.signature = ""; this.render(parent, routerId); } };
      action.onclick = () => { if (action.disabled) return; if (owner) void resume().catch(error => new Notice(errorMessage(error))); else this.plugin.openModuleOwnerPicker(request.moduleId, resume); };
    }
    const pending = [...waiting, ...approvals.map(a => a.dispatch)];
    for (const id of new Set(pending.map(d => d.projectId ?? ""))) {
      const item = id ? service.projectOf(id) : undefined;
      const count = pending.filter(d => (d.projectId ?? "") === id).length;
      const row = root.createDiv({ cls: "echoink-company-waiting", attr: { role: "status" } });
      row.createSpan({ text: `${item ? `${item.name} · ` : ""}${count} 件等你定` });
      const open = this.button(row, item ? "去项目页" : "去工作台", "secondary");
      open.onclick = () => { void (item ? this.plugin.activateProjectPage(item.id) : this.plugin.activateHomeView()).catch(error => new Notice(errorMessage(error))); };
    }
  }
  private button(parent: HTMLElement, text: string, variant: "primary" | "secondary"): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls: `echoink-company-button is-${variant}`, attr: { type: "button" } });
    applyAmicroButton(button, { variant }); return button;
  }
  private proposal(parent: HTMLElement, project: CompanyProject, refresh: () => void): void {
    const card = parent.createEl("section", { cls: "echoink-company-proposal", attr: { "aria-label": "开工卡" } });
    card.createEl("h2", { text: project.name });
    card.createDiv({ text: project.goal });
    const members = [...new Set([GENERAL_ASSISTANT_ID, ...project.plan.map(t => t.agentId)])];
    const name = (id: string) => this.plugin.settings.agentRegistry.agents.find(a => a.id === id)?.name ?? id;
    const facts = card.createEl("dl", { cls: "echoink-company-facts" });
    const fact = (label: string, text: string) => { facts.createEl("dt", { text: label }); facts.createEl("dd", { text }); };
    fact("成员", members.map(id => `${name(id)}${project.roles[id] ? `：${project.roles[id]}` : ""}`).join("；"));
    const doc = this.plugin.companyService?.doc;
    if (doc) fact("里程碑", projectMilestones(doc, project).map(step => step.title).join(" → "));
    fact("预计轮次", `${projectEstimatedTurns(project)} 轮`);
    const tasks = card.createEl("ol", { cls: "echoink-company-plan" });
    for (const task of project.plan) {
      const label = (id: string) => project.plan.find(t => t.id === id)?.label ?? id;
      const row = tasks.createEl("li"); row.createSpan({ text: `${name(task.agentId)} · ${task.label}` });
      if (task.milestone || task.dependsOn.length) row.createDiv({ cls: "echoink-company-caption", text: [task.milestone,
        task.dependsOn.length ? `等「${task.dependsOn.map(label).join("」「")}」` : "可直接开工"].filter(Boolean).join(" · ") });
    }
    card.createEl("h3", { text: "验收标准" });
    const criteria = card.createEl("ul", { cls: "echoink-company-criteria" });
    project.criteria.forEach(text => criteria.createEl("li", { text }));
    const actions = card.createDiv({ cls: "echoink-company-actions" });
    const cancel = this.button(actions, "先不开", "secondary"), start = this.button(actions, "开工", "primary");
    cancel.disabled = start.disabled = this.busy.has(project.id);
    const run = (action: "start" | "cancelProposal") => async () => {
      if (this.busy.has(project.id)) return;
      this.busy.add(project.id); cancel.disabled = start.disabled = true; setAmicroButtonPending(action === "start" ? start : cancel, true);
      try {
        const service = this.plugin.companyService;
        const result = await service?.[action](project.routerConversationId, project.id);
        if (action === "start" && service?.projectOf(project.id)?.status === "proposed" && result?.trim()) new Notice(result);
      }
      catch (error) { new Notice(errorMessage(error)); }
      finally { this.busy.delete(project.id); this.signature = ""; refresh(); }
    };
    cancel.onclick = () => { void run("cancelProposal")(); };
    start.onclick = () => { void run("start")(); };
  }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { AgentDefinition } from "../agents/types";
import { renderExpertHall, type ExpertHallHandle } from "./hall";
import type { ExpertContentService } from "./service";

export const EXPERT_HALL_VIEW_TYPE = "echoink-expert-hall";
export interface ExpertHallViewHost {
  content: ExpertContentService;
  getAgents(): AgentDefinition[];
  hire(id: string): Promise<void>;
  dismiss(agentId: string): Promise<void>;
  open(agentId: string): Promise<void>;
  upgrade(): Promise<void>;
}
export type ExpertHallHost = ExpertHallViewHost;
type ExpertHallViewState = { aboutId?: string };

/** Shared ItemView: the host keeps the actual Agent transaction and navigation. */
export class ExpertHallView extends ItemView {
  private hall?: ExpertHallHandle;
  private aboutId?: string;
  private opened = false;
  constructor(leaf: WorkspaceLeaf, private readonly host: ExpertHallViewHost) { super(leaf); }
  getViewType(): string { return EXPERT_HALL_VIEW_TYPE; }
  getDisplayText(): string { return "专家"; }
  getIcon(): string { return "sparkles"; }
  getState(): ExpertHallViewState { return this.aboutId ? { aboutId: this.aboutId } : {}; }
  async setState(state: ExpertHallViewState, result: ViewStateResult): Promise<void> {
    this.aboutId = typeof state?.aboutId === "string" && state.aboutId ? state.aboutId : undefined;
    if (this.opened) await this.refresh();
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.classList.add("echoink-expert-view");
    this.contentEl.replaceChildren();
    this.hall = renderExpertHall(this.contentEl, {
      document: this.contentEl.ownerDocument, service: this.host.content,
      getHiredIds: () => this.host.getAgents().flatMap(agent => agent.kind === "expert" && agent.expert?.hired ? [agent.expert.expertId] : []),
      onHire: expert => this.host.hire(expert.id),
      onDismiss: expert => this.host.dismiss(this.agentId(expert.id)),
      onOpen: expert => this.host.open(this.agentId(expert.id)),
      onUpgrade: () => this.host.upgrade(),
      onViewChange: aboutId => { this.aboutId = aboutId; this.app.workspace.requestSaveLayout(); },
    });
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.opened = false; this.hall?.dispose(); this.hall = undefined;
    this.contentEl.classList.remove("echoink-expert-view"); this.contentEl.replaceChildren();
  }
  async refresh(forceCatalog = false): Promise<void> {
    const hall = this.hall;
    if (!hall || !this.opened) return;
    await hall.refresh(forceCatalog);
    if (this.opened && hall === this.hall && this.aboutId) await hall.showAbout(this.aboutId);
  }
  private agentId(expertId: string): string {
    const agent = this.host.getAgents().find(item => item.kind === "expert" && item.expert?.expertId === expertId && item.expert.hired);
    if (!agent) throw new Error("此专家尚未聘请，请刷新后重试。");
    return agent.id;
  }
}

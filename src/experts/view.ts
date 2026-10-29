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
type ExpertHallViewState = { expertId?: string; aboutId?: string };

/** Shared ItemView: the host keeps the actual Agent transaction and navigation. */
export class ExpertHallView extends ItemView {
  private hall?: ExpertHallHandle;
  private expertId?: string;
  private opened = false;
  constructor(leaf: WorkspaceLeaf, private readonly host: ExpertHallViewHost) { super(leaf); }
  getViewType(): string { return EXPERT_HALL_VIEW_TYPE; }
  getDisplayText(): string { return "专家"; }
  getIcon(): string { return "sparkles"; }
  getState(): ExpertHallViewState { return this.expertId ? { expertId: this.expertId } : {}; }
  async setState(state: ExpertHallViewState, result: ViewStateResult): Promise<void> {
    const id = state?.expertId ?? state?.aboutId;
    this.expertId = typeof id === "string" && id ? id : undefined;
    if (this.opened) {
      if (this.expertId) await this.hall?.showDetail(this.expertId);
      else this.hall?.showHall();
    }
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.classList.add("echoink-expert-view", "echoink-theme-boundary");
    this.contentEl.replaceChildren();
    this.hall = renderExpertHall(this.contentEl, {
      document: this.contentEl.ownerDocument, service: this.host.content, initialExpertId: this.expertId,
      getHiredIds: () => this.host.getAgents().flatMap(agent => agent.kind === "expert" && agent.expert?.hired ? [agent.expert.expertId] : []),
      onHire: expert => this.host.hire(expert.id),
      onDismiss: expert => this.host.dismiss(this.agentId(expert.id)),
      onUpgrade: () => this.host.upgrade(),
      onViewChange: expertId => { this.expertId = expertId; this.app.workspace.requestSaveLayout(); },
    });
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.opened = false; this.hall?.dispose(); this.hall = undefined;
    this.contentEl.classList.remove("echoink-expert-view", "echoink-theme-boundary"); this.contentEl.replaceChildren();
  }
  async refresh(forceCatalog = false): Promise<void> {
    const hall = this.hall;
    if (!hall || !this.opened) return;
    await hall.refresh(forceCatalog);
  }
  private agentId(expertId: string): string {
    const agent = this.host.getAgents().find(item => item.kind === "expert" && item.expert?.expertId === expertId && item.expert.hired);
    if (!agent) throw new Error("此专家尚未聘请，请刷新后重试。");
    return agent.id;
  }
}

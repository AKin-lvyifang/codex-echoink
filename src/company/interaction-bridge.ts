import type CodexForObsidianPlugin from "../main";
import { Notice } from "obsidian";
import type { PiAgentApprovalDecisionBinding } from "../plugin/pi-agent-approval-broker";
import type { PiTurnInteractionDecisionBinding } from "../plugin/pi-turn-interaction-broker";
import { normalizeEchoInkQuestionAnswers, type EchoInkQuestionInteraction } from "../types/conversation-turn";
import { InteractionDockController } from "../ui/codex-view/interaction-dock";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import type { CompanyDocument, CompanyDispatch } from "./types";
import { pendingDecisions } from "./logic";

export interface CompanyApproval {
  readonly dispatch: CompanyDispatch;
  readonly key: string;
  readonly binding: PiAgentApprovalDecisionBinding;
}

/** A projection of the existing live ticket. No company-owned approval state. */
export interface CompanyInteractionScope { readonly routerId?: string; readonly projectId?: string; readonly includeJudging?: boolean }
export function companyApprovals(plugin: CodexForObsidianPlugin, doc: CompanyDocument, scope: CompanyInteractionScope = {}): CompanyApproval[] {
  const pending = plugin.getConversationRunService().pendingInteractions;
  return doc.dispatches.flatMap(dispatch => {
    if (scope.routerId && dispatch.routerConversationId !== scope.routerId || scope.projectId && dispatch.projectId !== scope.projectId) return [];
    const interaction = pending.get(dispatch.id);
    if (interaction?.kind !== "confirmation" || interaction.status !== "pending" || interaction.conversationId !== dispatch.id) return [];
    const binding = plugin.piAgentApprovalBinding({ conversationId: dispatch.id, piSessionId: interaction.piSessionId,
      productRunId: interaction.turnId, toolCallId: interaction.toolCallId });
    const key = [dispatch.id, interaction.piSessionId, interaction.turnId, interaction.toolCallId].join(":");
    return binding && (scope.includeJudging || !plugin.companyApprovalCoordinator?.isJudging(key)) ? [{ dispatch, key, binding }] : [];
  });
}

// This holds only an active submission, never a question or answer. Dispatch.report/status remain authoritative.
const submitting = new WeakMap<CodexForObsidianPlugin, Set<string>>();
const decisionKey = (dispatch: CompanyDispatch) => JSON.stringify([dispatch.id, dispatch.status, dispatch.report]);
export function companyDecisions(plugin: CodexForObsidianPlugin, doc: CompanyDocument, scope: CompanyInteractionScope = {}): CompanyDispatch[] {
  return pendingDecisions(doc).filter(d => (!scope.routerId || d.routerConversationId === scope.routerId)
    && (!scope.projectId || d.projectId === scope.projectId) && !submitting.get(plugin)?.has(decisionKey(d)));
}

function refreshCompanyInteraction(plugin: CodexForObsidianPlugin, dispatch: CompanyDispatch): void {
  const runs = plugin.getConversationRunService();
  runs.refreshTask(dispatch.id); runs.refreshTask(dispatch.routerConversationId);
  plugin.notifyHomeSurfacesChanged();
}

/** Adapts a dispatch report to the existing Question control; task_message owns the actual answer transition. */
export function companyDecisionBinding(plugin: CodexForObsidianPlugin, dispatch: CompanyDispatch): PiTurnInteractionDecisionBinding {
  const key = decisionKey(dispatch), report = dispatch.report!;
  const interaction: EchoInkQuestionInteraction = { kind: "question", status: "pending", conversationId: dispatch.id,
    piSessionId: plugin.settings.sessions?.find(s => s.id === dispatch.id)?.piSessionId ?? dispatch.id,
    turnId: `company-${report.at}`, interactionId: `company-${dispatch.id}-${report.at}`, createdAt: report.at, updatedAt: report.at,
    questions: [{ questionId: dispatch.id, prompt: report.question || report.summary || dispatch.brief,
      selection: "single", options: (report.options ?? []).map((label, i) => ({ optionId: String(i), label })), allowSupplement: true }] };
  return { interaction, submit(answers) {
    const service = plugin.companyService;
    const current = service?.dispatchOf(dispatch.id);
    if (!service || !current || decisionKey(current) !== key || !pendingDecisions(service.doc).some(d => d.id === current.id)) return false;
    const flights = submitting.get(plugin) ?? new Set<string>();
    if (flights.has(key)) return false;
    let answer: string;
    try {
      const normalized = normalizeEchoInkQuestionAnswers(interaction, answers)[0];
      answer = [...normalized.selectedOptionIds.map(id => interaction.questions[0].options.find(o => o.optionId === id)!.label), normalized.supplement ?? ""].filter(Boolean).join("\n");
    } catch { return false; }
    if (!answer.trim()) return false;
    submitting.set(plugin, flights); flights.add(key);
    refreshCompanyInteraction(plugin, dispatch);
    void service.message(dispatch.routerConversationId, dispatch.id, answer).catch(error => {
      new Notice(error instanceof Error ? error.message : String(error));
    }).finally(() => { flights.delete(key); refreshCompanyInteraction(plugin, dispatch); });
    return true;
  } };
}

/** The same live approval/question rows are mounted in both the workbench group and a project's 等你定 section. */
let surfaceSequence = 0;
export class CompanyInteractionController {
  private readonly surfaceId = ++surfaceSequence;
  private readonly docks = new Map<string, InteractionDockController>();
  constructor(private readonly plugin: CodexForObsidianPlugin) {}
  dispose(): void { for (const dock of this.docks.values()) dock.dispose(); this.docks.clear(); }
  render(container: HTMLElement, scope: CompanyInteractionScope = {}, onChanged: () => void = () => {}): void {
    const doc = this.plugin.companyService?.doc;
    const rows = doc ? [...companyApprovals(this.plugin, doc, scope).map(approval => ({ key: `approval:${approval.key}`, dispatch: approval.dispatch, approval })),
      ...companyDecisions(this.plugin, doc, scope).map(dispatch => ({ key: `question:${decisionKey(dispatch)}`, dispatch, approval: undefined }))] : [];
    const wanted = new Set(rows.map(row => row.key));
    for (const [key, dock] of this.docks) if (!wanted.has(key)) { dock.dispose(); this.docks.delete(key); }
    for (const node of Array.from(container.children) as HTMLElement[]) if (!wanted.has(node.dataset.companyInteraction!)) node.remove();
    for (const row of rows) {
      let node = Array.from(container.children).find(el => (el as HTMLElement).dataset.companyInteraction === row.key) as HTMLElement | undefined;
      if (node) continue;
      node = container.createDiv({ cls: "echoink-company-interaction", attr: { "data-company-interaction": row.key } });
      const agent = this.plugin.settings.agentRegistry.agents.find(a => a.id === row.dispatch.agentId);
      const project = row.dispatch.projectId ? doc?.projects.find(p => p.id === row.dispatch.projectId) : undefined;
      const surface = node.createDiv({ cls: "codex-interaction-dock echoink-company-interaction-dock" });
      const dock = this.docks.get(row.key) ?? new InteractionDockController(); this.docks.set(row.key, dock);
      const question = row.approval ? undefined : companyDecisionBinding(this.plugin, row.dispatch);
      // DOM ids/radio names belong to this mount; both bindings still submit to the same dispatch.
      const questionBinding = question ? { ...question, interaction: { ...question.interaction, interactionId: `surface-${this.surfaceId}-${question.interaction.interactionId}` } } : undefined;
      const resolved = () => { refreshCompanyInteraction(this.plugin, row.dispatch); this.render(container, scope, onChanged); onChanged(); };
      dock.render(surface, { sessionId: row.dispatch.id, language: this.plugin.settings.settingsLanguage,
        companyCompact: { name: agent?.name ?? row.dispatch.agentId, avatarUrl: agent ? resolveAgentAvatarUrl(agent.avatar) : null,
          ...(!scope.projectId && project ? { context: project.name } : {}) },
        ...(row.approval ? { confirmation: { binding: row.approval.binding, onResolved: resolved } }
          : { question: { binding: questionBinding!, onResolved: resolved } }),
        onStale: resolved, onScheduleMeasure() {} });
    }
  }
}

export function companyRouterWaiting(plugin: CodexForObsidianPlugin, routerId: string): boolean {
  const doc = plugin.companyService?.doc;
  return !!doc && (companyApprovals(plugin, doc, { routerId }).length > 0
    || companyDecisions(plugin, doc, { routerId }).length > 0);
}

/** Reuse the original unread marker; this callback never starts a model turn. */
export async function notifyCompanyDecision(plugin: CodexForObsidianPlugin, routerId: string, _projectId?: string): Promise<void> {
  await plugin.setPiConversationTaskMetadata(routerId, { unreadAnswerAt: Date.now() });
  plugin.getConversationRunService().refreshTask(routerId);
  plugin.notifyHomeSurfacesChanged();
}

/** Subscribe before initialize(), so restored workers cannot outrun the UI bridge. */
export function observeCompanyInteractions(plugin: CodexForObsidianPlugin): () => void {
  const runs = plugin.getConversationRunService();
  const known = new Map<string, string>();
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    const doc = plugin.companyService?.doc;
    if (!doc) return;
    const current = new Map(companyApprovals(plugin, doc).map(item => [item.dispatch.id, item]));
    for (const [id, item] of current) {
      if (known.get(id) === item.key) continue;
      known.set(id, item.key);
      void notifyCompanyDecision(plugin, item.dispatch.routerConversationId).catch(error => console.error("Company approval unread update failed", error));
    }
    for (const id of [...known.keys()]) if (!current.has(id)) {
      known.delete(id);
      const router = doc.dispatches.find(d => d.id === id)?.routerConversationId;
      if (router) runs.refreshTask(router);
    }
  };
  const unsubscribeRuns = runs.subscribe({ refresh, clearAcceptedDraft() {}, isTaskVisible: () => false });
  const unsubscribeCompany = plugin.companyService?.subscribe(refresh);
  const unsubscribeCoordinator = plugin.companyApprovalCoordinator?.subscribe(() => {
    refresh();
    for (const dispatch of plugin.companyService?.doc.dispatches ?? []) runs.refreshTask(dispatch.routerConversationId);
    plugin.notifyHomeSurfacesChanged();
  });
  refresh();
  return () => { disposed = true; unsubscribeRuns(); unsubscribeCompany?.(); unsubscribeCoordinator?.(); known.clear(); };
}

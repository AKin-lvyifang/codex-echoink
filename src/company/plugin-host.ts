import { getModuleOwner } from "../agents/registry";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getDesktopPath } from "../platform/desktop-paths";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { newId, getActiveApiProviderModel, type StoredSession } from "../settings/settings";
import { resolveComposerReasoningState } from "../ui/composer-reasoning";
import { createPiConversationShell } from "../ui/codex-view/session-controller";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import type { QueuedTurnOutcome } from "../ui/codex-view/runner-context";
import { agentPositionDescription } from "../agents/identity";
import { isAgentHired } from "../agents/persona";
import type { TurnOptions } from "../ui/turn-options";
import { CompanyService, type CompanyHost } from "./service";
import { CompanyStore } from "./store";
import { companyRouterPermission, ensureCompanyProjectFolder } from "./folder-bridge";
import { notifyCompanyDecision, observeCompanyInteractions } from "./interaction-bridge";
import { createCompanyApprovalCoordinator } from "./approval-coordinator";

const path = getDesktopPath();

/** The real plugin behind CompanyService. Turns run through the same ConversationRunService as any task. */
export function createCompanyHost(plugin: CodexForObsidianPlugin): CompanyHost {
  const runs = () => plugin.getConversationRunService();
  const workerFlights = new Map<string, Promise<void>>();
  const session = (id: string): StoredSession | undefined => plugin.settings.sessions.find(item => item.id === id);
  const options = (inheritFrom?: string): TurnOptions => {
    const inherited = inheritFrom ? runs().lastTurnOptions.get(inheritFrom) : undefined;
    if (inherited) { const { companyApprovalKey: _approvalKey, ...rest } = inherited; return { ...rest }; }
    const selected = getActiveApiProviderModel(plugin.settings);
    if (!selected) throw new Error("请先在设置里选择默认 Provider 和模型。");
    return { cwd: plugin.getVaultPath(), providerSettingsId: selected.provider.id, runtimeProviderId: selected.provider.runtimeProviderId, model: selected.model.id,
      reasoning: resolveComposerReasoningState(plugin.settings, selected.provider.id, selected.model.id)?.effort ?? "none",
      permission: plugin.settings.defaultPermission, mode: "agent", mcpEnabled: true };
  };
  const projection = async (id: string) => (await plugin.readPiConversationProjection(id)).messages;
  return {
    now: () => Date.now(),
    newId: prefix => newId(prefix),
    agents: () => plugin.settings.agentRegistry.agents.map(agent => ({ id: agent.id, name: agent.name, position: agentPositionDescription(agent), hired: isAgentHired(agent) })),
    moduleOwner: module => getModuleOwner(plugin.settings.agentRegistry, module)?.id ?? null,
    routerPermission: routerId => companyRouterPermission(plugin, routerId),
    createWorker: input => {
      const existing = workerFlights.get(input.id); if (existing) return existing;
      const flight = Promise.resolve().then(async () => {
        const entry = await plugin.readPiConversationCatalogEntry(input.id) ?? await plugin.createPiConversation({ conversationId: input.id, title: input.title, agentId: input.agentId, cwd: plugin.getVaultPath(),
          defaultMemoryMode: plugin.settings.memory.useLongTermMemory === false ? "no_memory" : "normal", titleSource: "manual" });
        if (!session(entry.conversationId)) plugin.settings.sessions.push(createPiConversationShell({ plugin } as never, entry));
        await plugin.setPiConversationTaskMetadata(entry.conversationId, { companyRole: "worker", ...(input.projectId ? { projectId: input.projectId } : {}) });
      }).finally(() => { if (workerFlights.get(input.id) === flight) workerFlights.delete(input.id); });
      workerFlights.set(input.id, flight); return flight;
    },
    startTurn: async (id, text, permission, inheritFrom) => {
      const turnOptions = { ...options(inheritFrom ?? id), permission, companyProgrammatic: true };
      const outcome = await runs().start({ id: newId("company-turn"), sessionId: id, text, attachments: [], skill: null, turnOptions, kind: "chat", createdAt: Date.now() }, "composer");
      if (outcome !== "running" && outcome !== "completed") throw new Error("这件活没能开工，请检查模型设置。");
    },
    isRunning: id => runs().isTurnActive(id),
    canReceiveReports: routerId => !plugin.companyApprovalCoordinator?.hasPendingJudgment(routerId)
      && !(runs().isTurnActive(routerId) && runs().lastTurnOptions.get(routerId)?.companyApprovalKey),
    steer: async (id, text) => {
      if (!runs().isTurnActive(id)) return false;
      try { await plugin.steerPiConversation(id, text); return true; } catch { return false; }
    },
    stop: id => runs().stopTask(id, "user_stopped"),
    lastAssistantText: async id => [...await projection(id)].reverse().find(message => message.role === "assistant" && message.text.trim())?.text,
    latestUserText: async id => [...await projection(id)].reverse().find(message => message.role === "user" && message.text.trim() && !message.text.startsWith("〔员工汇报〕"))?.text,
    setRouterMetadata: async (id, patch) => { await plugin.setPiConversationTaskMetadata(id, patch); },
    ensureFolder: (name, routerId) => ensureCompanyProjectFolder(plugin, name, routerId),
    notifyDecision: (routerId, projectId) => notifyCompanyDecision(plugin, routerId, projectId)
  };
}

/** Loads the store and wires turn settlement. Desktop only; failure leaves the classic assistant intact. */
export async function startCompanyService(plugin: CodexForObsidianPlugin): Promise<CompanyService | null> {
  let unsubscribeSettled: (() => void) | undefined, unsubscribeInteractions: (() => void) | undefined,
    unsubscribeApprovalReports: (() => void) | undefined, stopCoordinator: (() => void) | undefined;
  try {
    const file = path.join(pluginDataDir(plugin.getVaultPath(), plugin.getPluginDataDirName()), "pi-agent-product-v1", "company.v1.json");
    const service = new CompanyService(new CompanyStore(file), createCompanyHost(plugin));
    plugin.companyService = service;
    plugin.companyApprovalCoordinator = createCompanyApprovalCoordinator(plugin);
    stopCoordinator = plugin.companyApprovalCoordinator.start();
    unsubscribeInteractions = observeCompanyInteractions(plugin);
    const flushReports = () => {
      if (!service.doc.dispatches.some(dispatch => dispatch.reportPending)) return;
      void service.flushPendingReports().catch(error => console.error("EchoInk pending company reports could not flush", error));
    };
    // A failed/uncertain judgment falls back only after run() returns, just after its settled event.
    unsubscribeApprovalReports = plugin.companyApprovalCoordinator.subscribe(flushReports);
    unsubscribeSettled = plugin.getConversationRunService().onTurnSettled((id, outcome, turnStartedAt) => {
      const role = session(plugin, id)?.companyRole;
      if (role === "router") { flushReports(); return; }
      if (!service.dispatchOf(id)) {
        void recordDirectStaffActivity(plugin, service, id, outcome, turnStartedAt).catch(error => console.error("EchoInk employee activity could not be recorded", error));
        return;
      }
      if (role !== "worker") return;
      // The run service has already written taskStatus; it tells waiting/interrupted apart from completed.
      const status = session(plugin, id)?.taskStatus;
      const settled = outcome === "failed" || outcome === "cancelled" ? "interrupted" : status === "waiting" ? "waiting" : status === "interrupted" ? "interrupted" : "completed";
      void service.onWorkerSettled(id, settled, turnStartedAt).catch(error => {
        console.error("EchoInk company report failed", error);
        new Notice("员工做完了，但汇报没能送到总助，请打开这件任务查看。");
      });
    });
    await service.initialize();
    plugin.register(unsubscribeInteractions);
    plugin.register(unsubscribeSettled);
    plugin.register(() => { unsubscribeApprovalReports?.(); stopCoordinator?.(); plugin.companyApprovalCoordinator = null; });
    return service;
  } catch (error) {
    unsubscribeInteractions?.(); unsubscribeSettled?.(); unsubscribeApprovalReports?.(); stopCoordinator?.(); plugin.companyService = null; plugin.companyApprovalCoordinator = null;
    console.error("EchoInk company service unavailable", error);
    return null;
  }
}
const session = (plugin: CodexForObsidianPlugin, id: string) => plugin.settings.sessions.find(item => item.id === id);

/** Snapshot the saved projection synchronously, before the run owner starts the next queued turn. */
export function recordDirectStaffActivity(plugin: CodexForObsidianPlugin, service: CompanyService, id: string,
  outcome: QueuedTurnOutcome, turnStartedAt: number): Promise<void> {
  const task = session(plugin, id);
  if (outcome !== "completed" || !task || task.taskStatus !== "completed" || !task.agentId || task.agentId === GENERAL_ASSISTANT_ID
    || task.companyRole || service.dispatchOf(id) || plugin.getConversationRunService().lastTurnOptions.get(id)?.companyProgrammatic
    || task.bodyAuthority !== "pi_session_only" || !task.piSessionId) return Promise.resolve();
  const source = [...task.messages].reverse().find(message => message.role === "user" && message.turnId && message.createdAt >= turnStartedAt);
  if (!source?.turnId) return Promise.resolve();
  const answer = [...task.messages].reverse().find(message => message.role === "assistant" && message.turnId === source.turnId
    && message.status === "completed" && message.text.trim());
  return service.recordStaffActivity({ conversationId: id, piSessionId: task.piSessionId, turnId: source.turnId, agentId: task.agentId,
    title: source.text.trim() || task.title.trim() || "已完成任务", summary: answer?.text ?? "任务已完成。", at: answer?.completedAt ?? source.createdAt });
}

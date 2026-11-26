import { CAUSE } from "../core/error-copy";
import { getModuleOwner } from "../agents/registry";
import { MarkdownView, Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getDesktopOs, getDesktopPath } from "../platform/desktop-paths";
import { resolveDesktopSyncDeviceId } from "../sync/device-id";
import { SyncDeviceStore } from "../sync/device-store";
import { CompanySyncMirror } from "../sync/company-mirror";
import { SyncOverviewService } from "../sync/overview-service";
import { SyncRequestService } from "../sync/requests";
import { SyncConversationExporter } from "../sync/conversation-sync";
import { friendlyDeviceName, neutralFromChatMessages, type SyncConversationSource } from "../sync/conversations";
import { createCloudSyncController } from "../sync/cloud/host";
import { mountCloudSyncIndicators } from "../sync/cloud/status-indicators";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { newId, getActiveApiProviderModel, type StoredSession } from "../settings/settings";
import { resolveComposerReasoningState } from "../ui/composer-reasoning";
import { createPiConversationShell } from "../ui/codex-view/session-controller";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { withAgentModel } from "../agents/agent-model";
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
export function createCompanyHost(plugin: CodexForObsidianPlugin, deviceId?: string): CompanyHost {
  const runs = () => plugin.getConversationRunService();
  const workerFlights = new Map<string, Promise<void>>();
  const session = (id: string): StoredSession | undefined => plugin.settings.sessions.find(item => item.id === id);
  const options = (inheritFrom?: string): TurnOptions => {
    const inherited = inheritFrom ? runs().lastTurnOptions.get(inheritFrom) : undefined;
    if (inherited) { const { companyApprovalKey: _approvalKey, ...rest } = inherited; return { ...rest }; }
    const selected = getActiveApiProviderModel(plugin.settings);
    if (!selected) throw new Error(CAUSE.providerNotConfigured[0]);
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
    ...(deviceId ? { deviceId: () => deviceId } : {}),
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
      // A conversation keeps its own (possibly manually switched) model; anything inherited runs on the Agent's model.
      const source = inheritFrom ?? id, own = source === id && runs().lastTurnOptions.has(id);
      const base = options(source);
      const turnOptions = { ...(own ? base : withAgentModel(plugin.settings, session(id)?.agentId, base)), permission, companyProgrammatic: true };
      const outcome = await runs().start({ id: newId("company-turn"), sessionId: id, text, attachments: [], skill: null, turnOptions, kind: "chat", createdAt: Date.now() }, "composer");
      if (outcome !== "running" && outcome !== "completed") throw new Error("任务未能开始。请在 设置 → 模型服务 中检查模型。");
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
    // The device id lives in Obsidian's per-Vault local storage, never in a file a sync tool would carry.
    let deviceId: string | undefined;
    try { deviceId = await resolveDesktopSyncDeviceId(plugin.app); plugin.syncDeviceId = deviceId; }
    catch (error) { console.error("EchoInk sync device id unavailable", error); }
    const service = new CompanyService(new CompanyStore(file), createCompanyHost(plugin, deviceId));
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
        new Notice("员工已完成任务，但汇报未能送达总助。请打开该任务查看结果。");
      });
    });
    await service.initialize();
    plugin.register(unsubscribeInteractions);
    plugin.register(unsubscribeSettled);
    plugin.register(() => { unsubscribeApprovalReports?.(); stopCoordinator?.(); plugin.companyApprovalCoordinator = null; });
    if (deviceId) await startCompanySync(plugin, service, deviceId);
    return service;
  } catch (error) {
    unsubscribeInteractions?.(); unsubscribeSettled?.(); unsubscribeApprovalReports?.(); stopCoordinator?.(); plugin.companyService = null; plugin.companyApprovalCoordinator = null;
    console.error("EchoInk company service unavailable", error);
    return null;
  }
}
const session = (plugin: CodexForObsidianPlugin, id: string) => plugin.settings.sessions.find(item => item.id === id);

/** Mirrors this device's record into `EchoInk/同步数据/` and reads the other devices'. Failure keeps the old storage as is. */
async function startCompanySync(plugin: CodexForObsidianPlugin, service: CompanyService, deviceId: string): Promise<void> {
  const fs = plugin.app.vault.adapter;
  let deviceName = "电脑";
  try { deviceName = friendlyDeviceName(getDesktopOs().hostname()) || deviceName; } catch { /* keep the generic name */ }
  startCloudSync(plugin, deviceId, deviceName);
  if (plugin.settings.syncMirrorEnabled === false) return;
  const overview = new SyncOverviewService({ fs, deviceId, onError: error => console.error("EchoInk sync overview could not read", error) });
  plugin.syncOverview = overview;
  overview.subscribe(() => plugin.notifyHomeSurfacesChanged());
  overview.start();
  const device = new SyncDeviceStore({ fs, deviceId, deviceName, deviceKind: "desktop" });
  const requests = new SyncRequestService({ fs, device, service, deviceName: id => overview.deviceName(id), changed: () => plugin.notifyHomeSurfacesChanged(),
    onError: error => console.error("EchoInk sync requests could not process", error) });
  plugin.syncRequests = requests;
  const note = (file: { path: string }) => { overview.noteVaultChange(file.path); requests.noteVaultChange(file.path); };
  plugin.registerEvent(plugin.app.vault.on("create", note));
  plugin.registerEvent(plugin.app.vault.on("modify", note));
  plugin.registerEvent(plugin.app.vault.on("delete", note));
  plugin.registerEvent(plugin.app.vault.on("rename", note));
  plugin.register(() => { overview.stop(); requests.stop(); if (plugin.syncOverview === overview) plugin.syncOverview = null; if (plugin.syncRequests === requests) plugin.syncRequests = null; });
  const mirror = new CompanySyncMirror({ device, store: { snapshot: () => service.doc, subscribe: listener => service.subscribe(listener) },
    onError: error => console.error("EchoInk company sync mirror could not write", error) });
  const started = await mirror.start();
  if (started.status === "failed") {
    console.error("EchoInk company sync mirror unavailable", started.error);
    new Notice("同步数据未能准备完成，已保持原样，本机功能不受影响。请稍后重试同步。");
    return;
  }
  plugin.register(() => { mirror.stop(); });
  requests.start();
  // Conversations: every settled turn appends to this device's mirror; the first start exports the last 30 days.
  const exporter = new SyncConversationExporter({ fs, device,
    list: async () => (await plugin.listPiConversations(["active", "archived"])).map(entry => ({ id: entry.conversationId, updatedAt: entry.updatedAt })),
    read: id => readDesktopConversation(plugin, id), onError: error => console.error("EchoInk conversation sync could not export", error) });
  plugin.register(plugin.getConversationRunService().onTurnSettled(id => { void exporter.exportOne(id); }));
  void exporter.migrate().catch(error => console.error("EchoInk conversation sync migration failed", error));
}

/** Idle time after the last keystroke before a synced note is written to disk. */
const EARLY_SAVE_MS = 500;
function startCloudSync(plugin: CodexForObsidianPlugin, deviceId: string, deviceName: string): void {
  // EchoInk cloud sync rides on the same device id and folder; it only runs once the user turned it on with their password.
  const cloud = createCloudSyncController({ app: plugin.app, pluginDir: plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`, deviceId, deviceKind: "desktop", defaultDeviceName: deviceName,
    account: () => plugin.accountService, settings: () => plugin.settings.cloudSync, saveSettings: () => plugin.saveSettings(true), onLocalWrite: () => plugin.notifyHomeSurfacesChanged() });
  plugin.cloudSync = cloud;
  // The workbench can mount before company/cloud initialization finishes.
  plugin.notifyHomeSurfacesChanged();
  plugin.registerEvent(plugin.app.vault.on("create", file => cloud.noteVaultChange(file.path, "create")));
  plugin.registerEvent(plugin.app.vault.on("modify", file => cloud.noteVaultChange(file.path, "modify")));
  plugin.registerEvent(plugin.app.vault.on("delete", file => cloud.noteVaultChange(file.path, "delete")));
  plugin.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => cloud.noteVaultChange(file.path, "rename", oldPath)));
  if (plugin.accountService) plugin.register(plugin.accountService.subscribe(() => { void cloud.accountChanged(); }));
  plugin.registerDomEvent(window, "online", () => cloud.wake());
  plugin.registerDomEvent(window, "focus", () => cloud.wake());
  plugin.register(() => { cloud.dispose(); if (plugin.cloudSync === cloud) plugin.cloudSync = null; });
  mountCloudSyncIndicators(plugin);
  // Obsidian writes a note about 2 s after typing stops; for synced notes write it after 0.5 s so the edit reaches other devices sooner.
  const pendingSaves = new Map<MarkdownView, number>();
  plugin.registerEvent(plugin.app.workspace.on("editor-change", (_editor, info) => {
    if (!(info instanceof MarkdownView) || !info.file || !plugin.settings.cloudSync.enabled || !cloud.tracks(info.file.path)) return;
    const view = info, previous = pendingSaves.get(view); if (previous !== undefined) window.clearTimeout(previous);
    pendingSaves.set(view, window.setTimeout(() => { pendingSaves.delete(view); void view.save().catch(() => undefined); }, EARLY_SAVE_MS));
  }));
  plugin.register(() => { for (const id of pendingSaves.values()) window.clearTimeout(id); pendingSaves.clear(); });
  void cloud.start().catch(error => console.error("EchoInk cloud sync could not start", error));
}

async function readDesktopConversation(plugin: CodexForObsidianPlugin, id: string): Promise<SyncConversationSource | null> {
  const entry = await plugin.readPiConversationCatalogEntry(id);
  if (!entry || entry.status === "deleted") return null;
  const projection = await plugin.readPiConversationProjection(id);
  const messages = neutralFromChatMessages(projection.messages, entry.updatedAt);
  if (!messages.some(message => message.role === "user")) return null;
  const fork = entry.syncForkOf ? entry.syncForkOf.split(":") : null;
  return { id, title: entry.title, agentId: entry.agentId ?? GENERAL_ASSISTANT_ID, status: entry.status, createdAt: entry.createdAt, updatedAt: entry.updatedAt, messages,
    ...(fork && fork.length >= 2 ? { forkOf: { deviceId: fork[0], conversationId: fork.slice(1).join(":") } } : {}) };
}

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

import { Notice, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID } from "../agents/types";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import type { WorkbenchDataPort, WorkbenchSignal, WorkbenchTaskSource } from "./workbench-types";
import { getWorkbenchDataService } from "./workbench-data";
import { WorkbenchSetupRequired } from "./workbench-action-feedback";

const SIGNAL_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);

/** Decode local draft intent without treating it as permission to perform any action. */
export function parseWorkbenchTaskSource(value: unknown): WorkbenchTaskSource | null {
  if (typeof value !== "string") return null;
  try {
    const raw = JSON.parse(value) as Partial<WorkbenchTaskSource>;
    if (!raw || raw.version !== 1 || !SIGNAL_IDS.has(raw.signalId!)
      || !AGENT_MODULE_IDS.includes(raw.moduleId!) || typeof raw.businessKey !== "string" || !raw.businessKey.trim()
      || typeof raw.prompt !== "string" || !Array.isArray(raw.objects) || raw.objects.some(item => typeof item !== "string")
      || typeof raw.capturedAt !== "number" || !Number.isFinite(raw.capturedAt) || raw.capturedAt < 0) return null;
    const versions = raw.versions && typeof raw.versions === "object" && !Array.isArray(raw.versions)
      ? Object.fromEntries(Object.entries(raw.versions).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
    return { version: 1, signalId: raw.signalId!, businessKey: raw.businessKey.trim(), moduleId: raw.moduleId!,
      objects: [...new Set(raw.objects)], prompt: raw.prompt, capturedAt: raw.capturedAt, ...(versions ? { versions } : {}) };
  } catch { return null; }
}

/** Recheck scope and dispatch an isolated task; never send another Composer's draft. */
export async function launchWorkbenchSignal(
  plugin: CodexForObsidianPlugin,
  signal: WorkbenchSignal,
  data: Pick<WorkbenchDataPort, "load"> = getWorkbenchDataService(plugin)
): Promise<boolean> {
  const snapshot = await data.load();
  const current = snapshot.signals.find(item => item.key === signal.key && item.id === signal.id);
  if (!current) {
    new Notice(plugin.settings.settingsLanguage === "en" ? "This reminder has changed." : "这条提醒已更新。");
    return false;
  }
  const registry = plugin.settings.agentRegistry;
  const assigned = registry.moduleOwners[current.moduleId];
  const owner = registry.agents.some(agent => agent.id === assigned) ? assigned : GENERAL_ASSISTANT_ID;
  if (current.moduleId === "knowledge-base") {
    const roles = plugin.settings.knowledgeBase.folderBindings?.roles;
    const exists = (path: string) => plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder;
    const sources = roles?.raw.enabled && roles.raw.readPaths.some(exists);
    const outcomes = roles && [roles.wiki, roles.projects].some(role => role.enabled && !!role.writePath && exists(role.writePath));
    if (!outcomes || current.id !== 14 && !sources) throw new WorkbenchSetupRequired(
      plugin.settings.settingsLanguage === "en" ? "Set up knowledge folders first." : "先设置知识库目录。", "knowledge");
  }
  const taskId = await plugin.startWorkbenchSignalTask(owner, current);
  if (!taskId) throw new Error(plugin.settings.settingsLanguage === "en" ? "The task was not accepted. Please try again." : "任务尚未受理，请重试。");
  return true;
}

/** Keep the question's identity when another task is active in the sidebar. */
export async function answerWorkbenchQuestion(
  plugin: CodexForObsidianPlugin,
  entry: Readonly<PiConversationCatalogEntry>,
  questionId: string,
  optionId: string
): Promise<boolean> {
  const current = await plugin.readPiConversationCatalogEntry(entry.conversationId);
  const pending = plugin.getConversationRunService().pendingInteractions.get(entry.conversationId);
  let accepted = false;
  if (current?.status === "active" && pending?.kind === "question" && pending.status === "pending"
    && current.pendingResponse?.runId === entry.pendingResponse?.runId
    && current.pendingResponse?.questionId === questionId
    && pending.turnId === current.pendingResponse.runId && pending.piSessionId === current.piSessionId
    && pending.questions.length === 1) {
    const question = pending.questions[0];
    if (question.questionId === questionId && question.selection === "single" && question.options.some(option => option.optionId === optionId)) {
      const binding = plugin.piTurnInteractionBinding({ conversationId: current.conversationId,
        piSessionId: current.piSessionId, productRunId: pending.turnId, interactionId: pending.interactionId });
      accepted = binding?.submit([{ questionId, selectedOptionIds: [optionId] }]) ?? false;
    }
  }
  if (!accepted) new Notice(plugin.settings.settingsLanguage === "en"
    ? "This question has been handled. Check the latest record." : "这个问题已处理，请查看最新记录。");
  await plugin.openTaskDetail(entry.conversationId);
  return accepted;
}

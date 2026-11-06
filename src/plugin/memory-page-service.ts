import type CodexForObsidianPlugin from "../main";
import type { PiLocalDataService } from "./pi-local-data-service";
import { getActiveApiProviderModel } from "../settings/settings";
import { calculatePiEffectiveInputBudget, personalMemoryRecallTokenBudget } from "../harness/pi-native/pi-effective-input-budget";
import { conversationIdFromMemorySource, productRunIdFromMemorySource } from "../harness/memory/dream-source-group";
import type { MemoryPagePort, MemoryReceipt } from "../home/memory/memory-page-types";
import type { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { memoryLifecycle, memoryRelevanceEntry, memoryRelevanceScorer, rankMemory } from "../harness/memory/memory-relevance";
import { MEMORY_CATEGORIES, type MemoryPageRequest, type MemoryPageSnapshot, type MemorySource } from "../home/memory/memory-page-types";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
export interface MemoryConversation {
  conversationId: string;
  status: string;
  title: string;
}
export function memorySourceView(source: string, conversations: readonly MemoryConversation[], date: string, language = "zh-CN"): MemorySource {
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  if (source.startsWith("ui:") || source.startsWith("user-edit:") || source.startsWith("user-control:"))
    return { text: t("你手动修改", "Edited by you") };
  if (source.startsWith("mobile:"))
    return { text: t("手机端对话", "Mobile conversation") };
  if (source.startsWith("pi://")) {
    const parts = source.slice(5).split("?", 1)[0].split("/").map(decodeURIComponent);
    const productRun = productRunIdFromMemorySource(source);
    if (productRun && parts[2] === productRun)
      return { text: t("手机端对话", "Mobile conversation") };
    const conversationId = conversationIdFromMemorySource(source);
    const conversation = conversations.find(item => item.conversationId === conversationId);
    if (conversation?.status === "active" && parts[3])
      return { text: conversation.title || t(`${date} 的对话`, `Conversation on ${date}`), conversationId: conversation.conversationId, entryId: parts[3] };
    if (!conversation)
      return { text: t(`${date} 的对话（已删除或不可定位）`, `Conversation on ${date} (deleted or unavailable)`) };
    const status = conversation.status === "archived" ? t("（已归档）", "(archived)") : t("（已删除）", "(deleted)");
    return { text: `${conversation.title || date} ${status}` };
  }
  return { text: source || t(`${date} 记下`, `Recorded on ${date}`) };
}
/** Read-only projection shared by every state of the desktop memory page. */
export async function queryMemoryPage(input: {
  repository: PersonalMemoryRepository;
  conversations: readonly MemoryConversation[];
  enabled: boolean;
  tokenBudget: number;
  language?: string;
  request: MemoryPageRequest;
}): Promise<MemoryPageSnapshot> {
  const { repository, conversations, enabled, request } = input;
  const now = request.now ?? Date.now();
  const [state, profile, clues, activityState] = await Promise.all([
    repository.readUserControlState(), repository.readUserProfileControlSnapshot(),
    repository.readSecondaryForUserControl(), repository.previewMemoryActivity(now)
  ]);
  if (state.revision !== profile.revision)
    throw new Error(input.language === "en" ? "Memories just changed. Please try again." : "记忆刚刚发生变化，请重试。");
  const records = new Map(state.records.map(record => [record.id, record]));
  const historyFor = (record: PersonalMemoryRecord) => {
    const history: PersonalMemoryRecord[] = [];
    const visited = new Set([record.id]);
    let id = record.supersedes;
    while (id && !visited.has(id)) {
      visited.add(id);
      const previous = records.get(id);
      if (!previous)
        break;
      history.push(previous);
      id = previous.supersedes;
    }
    return history.sort((a, b) => b.date.localeCompare(a.date) || b.revision - a.revision);
  };
  const stars = state.records.filter(record => record.status === "current").map(record => ({
    ...record, ...memoryLifecycle(record, activityState, now),
    category: MEMORY_CATEGORIES.find(category => (category.kinds as readonly string[]).includes(record.kind))!.id,
    lastRecalledAt: activityState.records[record.id]?.lastRecalledAt,
    recallCount: activityState.records[record.id]?.recallCount ?? 0,
    sourceView: memorySourceView(record.source, conversations, record.date, input.language), history: historyFor(record),
    profiles: profile.items.filter(item => item.sourceMemoryIds.includes(record.id)),
    clues: clues.filter(clue => clue.parentId === record.id && clue.status === "current")
  }));
  const query = request.query?.trim().slice(0, 2000);
  let preview: MemoryPageSnapshot["preview"];
  if (query) {
    const prepared = await new PersonalMemoryRecallHarness(repository).prepareTurnContext({
      memoryMode: enabled ? "normal" : "no_memory", preview: true, now, query, tokenBudget: input.tokenBudget,
      vaultId: await repository.readVaultId(), conversationId: "memory-page-preview", piSessionId: "memory-page-preview", productRunId: "memory-page-preview"
    });
    const entries = new Map(stars.map(star => [star.id, memoryRelevanceEntry(star)]));
    const score = memoryRelevanceScorer([...entries.values()], query, "search");
    const faded = stars.filter(star => star.layer === "faded")
      .map(star => ({ id: star.id, score: rankMemory(score(entries.get(star.id)!), star, activityState, now, query, "search").score }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const core = prepared.core ?? [];
    const candidates = prepared.recall?.candidates ?? [];
    const recalled = [...core.map(record => record.id), ...candidates.map(record => record.id)];
    const reasons: Record<string, string | undefined> = {};
    for (const record of core) reasons[record.id] = "pinned";
    for (const record of candidates) reasons[record.id] = record.recallReason;
    preview = {
      query,
      reasons,
      recalled,
      faded: faded.map(item => item.id).filter(id => !recalled.includes(id))
    };
  }
  return { revision: state.revision, now, enabled, stars, profile: profile.items, activityState, preview, receipt: request.receipt };
}
/** Assembles the page boundary from the existing local store and user controls. */
export function createMemoryPagePort(plugin: CodexForObsidianPlugin, localData: () => Promise<PiLocalDataService>, receipt: () => MemoryReceipt | undefined): MemoryPagePort {
  const t = (zh: string, en: string) => plugin.settings.settingsLanguage === "en" ? en : zh;
  return {
    query: async (request) => {
      const local = await localData();
      local.assertMemoryAvailable();
      const active = getActiveApiProviderModel(plugin.settings);
      const tokenBudget = active ? personalMemoryRecallTokenBudget(calculatePiEffectiveInputBudget({
        contextWindow: active.model.contextWindow,
        maxOutputReserve: Math.min(active.model.maxOutputTokens, active.model.modelMaxTokens)
      }).effectiveInputBudget) : 1200;
      return queryMemoryPage({ repository: local.personalMemory, conversations: await local.catalog.list(), enabled: plugin.settings.memory.useLongTermMemory, request, tokenBudget, language: plugin.settings.settingsLanguage });
    },
    pin: async (id, pinned, revision) => {
      await (await localData()).personalMemory.setPinnedFromUserControl(id, pinned, revision);
    },
    restore: async (id) => {
      await (await localData()).personalMemory.restoreMemoryActivity(id);
    },
    correct: async (id, title, content, revision) => {
      const state = await plugin.getEchoInkPersonalMemoryState();
      const record = state.records.find(record => record.id === id);
      if (!record)
        throw new Error(t("这条记忆已不存在，请刷新后重试。", "This memory no longer exists. Refresh and try again."));
      const result = await plugin.applyEchoInkPersonalMemoryCorrection({ targetId: id, title, content, recallWhen: record.recallWhen, reason: "你手动修正了这条记忆", expectedRevision: revision });
      if (!result.record)
        throw new Error(t("记忆修正没有返回结果。", "The correction returned no memory."));
      return result.record.id;
    },
    forget: async (id, revision) => {
      await plugin.forgetEchoInkPersonalMemory(id, "你在记忆页选择忘记", revision);
    },
    undoForget: async (id, revision) => {
      await plugin.restoreEchoInkPersonalMemory(id, revision);
    },
    saveProfile: async (key, text, revision) => {
      await plugin.saveEchoInkUserProfile({ profileKey: key, text, expectedRevision: revision });
    },
    deleteProfile: async (key, revision) => {
      await plugin.deleteEchoInkUserProfile({ profileKey: key, expectedRevision: revision });
    },
    source: async (source) => {
      if (!source.conversationId || !source.entryId)
        return;
      const entry = await (await localData()).catalog.get(source.conversationId);
      if (entry?.status !== "active")
        throw new Error(t("这段来源对话已归档或删除。", "This source conversation has been archived or deleted."));
      await plugin.openTaskDetail(source.conversationId);
      plugin.getCodexView()?.revealPiEntry(source.entryId);
    },
    back: async () => {
      const current = receipt();
      if (current) {
        await plugin.openTaskDetail(current.conversationId);
        if (current.messageId)
          plugin.getCodexView()?.revealMessage(current.messageId);
      }
      else
        await plugin.activateHomeView();
    }
  };
}

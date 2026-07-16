import * as assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FileConversationStore } from "../../harness/conversation/conversation-store";
import { EchoInkSettingsStore } from "../../plugin/settings-store";
import { normalizeSettingsData, type CodexForObsidianSettings } from "../../settings/settings";

export async function runHarnessV2ConversationStoreTests(): Promise<void> {
  await assertConversationStorePersistsChatAndKnowledgeSessions();
  await assertConversationStoreCanTrimMigratedSettingsMessages();
  await assertConversationStoreDeletesSessionAndIndexEntry();
  await assertSettingsStoreMigratesAndRestoresConversationHistory();
  await assertConversationStoreParticipatesInDurableCommit();
}

async function assertSettingsStoreMigratesAndRestoresConversationHistory(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-settings-conversation-"));
  let persisted: unknown = {
    settingsVersion: 29,
    activeSessionId: "chat-reload",
    editorActions: {
      enabled: true,
      model: "gpt-5.5",
      actions: []
    },
    sessions: [{
      id: "chat-reload",
      title: "重载会话",
      cwd: vaultPath,
      threadId: "legacy-thread-reload",
      messages: [
        { id: "reload-user", role: "user", text: "记住 V3 口令", createdAt: 1 },
        {
          id: "reload-assistant",
          role: "assistant",
          text: "已记住",
          createdAt: 2,
          backendId: "codex-cli",
          runUsage: { total_tokens: 3, input_tokens: 2, output_tokens: 1 }
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }]
  };

  const firstPlugin = fakeSettingsPlugin(vaultPath, () => persisted, (next) => { persisted = next; });
  const firstStore = new EchoInkSettingsStore(firstPlugin as any);
  await firstStore.loadSettings();
  await firstStore.saveSettings(true, { flushKnowledgeBaseHistory: false });

  const saved = persisted as CodexForObsidianSettings;
  const savedChat = saved.sessions.find((session) => session.id === "chat-reload");
  assert.deepEqual(savedChat?.messages, [], "settings data must not keep full chat history");
  assert.equal(savedChat?.threadId, undefined, "legacy native thread id must not remain in settings data");
  assert.equal(saved.editorActions.enabled, true, "main editor settings must survive conversation migration");

  const secondPlugin = fakeSettingsPlugin(vaultPath, () => persisted, (next) => { persisted = next; });
  const secondStore = new EchoInkSettingsStore(secondPlugin as any);
  await secondStore.loadSettings();
  const restored = secondPlugin.settings.sessions.find((session) => session.id === "chat-reload");
  assert.deepEqual(restored?.messages.map((message) => message.text), ["记住 V3 口令", "已记住"]);
  assert.deepEqual(restored?.messages[1]?.runUsage, { totalTokens: 3, inputTokens: 2, outputTokens: 1 });
  assert.equal(restored?.backendBindings?.["codex-cli"]?.nativeThreadId, "legacy-thread-reload");
  assert.equal(restored?.contextSnapshot?.summarizedThroughMessageId, "reload-assistant");
}

async function assertConversationStoreDeletesSessionAndIndexEntry(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-delete-"));
  const store = new FileConversationStore({ rootPath, now: () => 20 });
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "chat-delete",
      title: "待删除",
      cwd: "/vault",
      messages: [{ id: "m1", role: "user", text: "delete me", createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings;
  await store.persistSettingsSessions(settings);

  assert.equal(await store.deleteSession("chat-delete"), true);
  assert.equal(await store.readSession("chat-delete"), null);
  assert.deepEqual((await store.readIndex()).sessions, []);
  assert.equal(await store.deleteSession("chat-delete"), false);
}

async function assertConversationStorePersistsChatAndKnowledgeSessions(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-"));
  const store = new FileConversationStore({ rootPath, now: () => 10 });
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [
      {
        id: "chat-1",
        title: "普通对话",
        cwd: "/vault",
        threadId: "legacy-thread-1",
        backendBindings: {
          "codex-cli": {
            backendId: "codex-cli",
            nativeThreadId: "codex-thread-1",
            nativeExecutionKind: "thread",
            syncedSessionRevision: 1,
            lastUsedAt: 2
          }
        },
        messages: [
          { id: "c1", role: "user", text: "hello", createdAt: 1 },
          {
            id: "c2",
            role: "assistant",
            text: "world",
            createdAt: 2,
            backendId: "codex-cli",
            model: "gpt-5.5",
            profile: "writer",
            runUsage: { totalTokens: 11, inputTokens: 8, outputTokens: 3 }
          }
        ],
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: "knowledge-1",
        kind: "knowledge-base",
        title: "Knowledge",
        cwd: "/vault",
        messages: [
          { id: "k1", role: "user", text: "/ask Harness?", createdAt: 3 },
          { id: "k2", role: "assistant", text: "Harness 是主控。", createdAt: 4, backendId: "hermes" }
        ],
        createdAt: 3,
        updatedAt: 4
      }
    ]
  }).settings;

  const result = await store.persistSettingsSessions(settings);
  const index = await store.readIndex();
  const chat = await store.readSession("chat-1");
  const knowledge = await store.readSession("knowledge-1");
  const chatMetadata = await readFile(path.join(rootPath, "sessions", "chat-1", "metadata.json"), "utf8");
  const chatMessages = await readFile(path.join(rootPath, "sessions", "chat-1", "messages.jsonl"), "utf8");
  const chatSnapshots = await readFile(path.join(rootPath, "sessions", "chat-1", "snapshots.jsonl"), "utf8");

  assert.deepEqual(result, { sessionCount: 2, messageCount: 4, trimmedSettingsMessageCount: 0 });
  assert.deepEqual(index.sessions.map((session) => session.sessionId), ["knowledge-1", "chat-1"]);
  assert.equal(chat?.messages.length, 2);
  assert.equal(chat?.backendBindings?.["codex-cli"]?.nativeThreadId, "codex-thread-1");
  assert.doesNotMatch(chatMetadata, /legacy-thread-1|"threadId"/);
  assert.equal(chat?.messages[1]?.backendId, "codex-cli");
  assert.equal(chat?.messages[1]?.modelId, "gpt-5.5");
  assert.equal(chat?.messages[1]?.profileId, "writer");
  assert.deepEqual(chat?.messages[1]?.runUsage, { totalTokens: 11, inputTokens: 8, outputTokens: 3 });
  assert.equal(chat?.contextSnapshot?.summarizedFromMessageId, "c1");
  assert.equal(chat?.contextSnapshot?.summarizedThroughMessageId, "c2");
  assert.equal(chat?.contextSnapshot?.sourceMessageCount, 2);
  assert.match(chat?.contextSnapshot?.rollingSummary ?? "", /user: hello/);
  assert.match(chatSnapshots, /"summarizedThroughMessageId":"c2"/);
  assert.equal(knowledge?.kind, "knowledge-base");
  assert.equal(knowledge?.messages[1]?.backendId, "hermes");
  assert.match(chatMessages, /"id":"c1"/);
  assert.match(chatMessages, /"runUsage":\{"totalTokens":11,"inputTokens":8,"outputTokens":3\}/);
}

async function assertConversationStoreCanTrimMigratedSettingsMessages(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-trim-"));
  const store = new FileConversationStore({ rootPath });
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "legacy-chat",
      title: "旧对话",
      cwd: "/vault",
      messages: [
        { id: "m1", role: "user", text: "旧消息", createdAt: 1 }
      ],
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings;

  const result = await store.persistSettingsSessions(settings, { trimSettingsMessages: true });
  const restored = await store.readSession("legacy-chat");

  assert.equal(result.trimmedSettingsMessageCount, 1);
  assert.deepEqual(settings.sessions[0].messages, []);
  assert.equal(restored?.messages[0]?.text, "旧消息");
}

async function assertConversationStoreParticipatesInDurableCommit(): Promise<void> {
  const [settingsSource, harnessSource, sessionSource] = await Promise.all([
    readFile("src/plugin/settings-store.ts", "utf8"),
    readFile("src/plugin/harness-service.ts", "utf8"),
    readFile("src/ui/codex-view/session-controller.ts", "utf8")
  ]);
  assert.match(settingsSource, /flushConversationStore\(options\.strictConversationStore !== false\)/);
  assert.match(settingsSource, /persistSettingsSessions\(this\.plugin\.settings\)/);
  assert.match(settingsSource, /saveData\(settingsForDataSave\(this\.plugin\.settings\)\)/);
  assert.match(settingsSource, /delete session\.threadId/);
  assert.match(settingsSource, /readSession\(session\.id\)/);
  assert.match(settingsSource, /session\.messages = \[\]/);
  assert.match(harnessSource, /commitEchoInkSessionDeletion[\s\S]*saveSettings\(true[\s\S]*deleteStoredConversationSession\(session\.id\)[\s\S]*cleanupSessionNativeExecutions/);
  assert.match(harnessSource, /resetEchoInkSessionNativeCache[\s\S]*leaseStatus: "cleanup-pending"[\s\S]*saveSettings\(true[\s\S]*cleanupSessionNativeExecutions/);
  assert.match(harnessSource, /cleanupSessionNativeExecutions[\s\S]*cleanupCommitted/);
  assert.match(sessionSource, /deleteSession\(host[\s\S]*commitEchoInkSessionDeletion\(session\)/);
  assert.match(sessionSource, /catch \(error\)[\s\S]*settings\.sessions = previousSessions[\s\S]*activeSessionId = previousActiveSessionId/);
  assert.match(sessionSource, /resetSessionNativeCache[\s\S]*resetEchoInkSessionNativeCache\(session\)/);
  const menuSource = await readFile("src/ui/codex-view/menus.ts", "utf8");
  assert.match(menuSource, /重置 Agent 缓存[\s\S]*onResetCache/);
}

function fakeSettingsPlugin(
  vaultPath: string,
  load: () => unknown,
  save: (data: unknown) => void
): { settings: CodexForObsidianSettings; loadData(): Promise<unknown>; saveData(data: unknown): Promise<void>; getVaultPath(): string; getPluginDataDirName(): string } {
  return {
    settings: undefined as unknown as CodexForObsidianSettings,
    async loadData() { return load(); },
    async saveData(data) { save(JSON.parse(JSON.stringify(data))); },
    getVaultPath() { return vaultPath; },
    getPluginDataDirName() { return "codex-echoink"; }
  };
}

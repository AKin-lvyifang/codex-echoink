import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { generateConversationTitle } from "../plugin/conversation-title";
import { workbenchResultType } from "../home/workbench-result";
import type { ChatMessage } from "../settings/settings";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";

export async function runWorkbenchHomeRefreshTests(): Promise<void> {
  const blank = structuredClone(DEFAULT_SETTINGS);
  blank.sessions = [{ id: "empty", title: "空会话", createdAt: 1, updatedAt: 1, cwd: "/fixture", messages: [] }];
  assert.equal(normalizeSettingsData(blank).settings.workbenchOnboardingDismissed, false, "an empty conversation is not onboarding completion");
  blank.sessions[0].messages.push({ id: "user", role: "user", text: "你好", createdAt: 1 });
  assert.equal(normalizeSettingsData(blank).settings.workbenchOnboardingDismissed, true, "legacy user messages migrate to a permanent flag");
  blank.sessions = []; blank.workbenchOnboardingDismissed = true;
  assert.equal(normalizeSettingsData(blank).settings.workbenchOnboardingDismissed, true, "deleting all conversations does not restore onboarding");
  assert.equal(normalizeSettingsData({}).settings.knowledgeBase.initialized, false);
  blank.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  blank.knowledgeBase.folderBindings.roles.raw.readPaths = ["Sources"];
  assert.equal(normalizeSettingsData(blank).settings.knowledgeBase.initialized, false, "first-install scanned directories are not a saved initialization");
  delete blank.knowledgeBase.initialized;
  assert.equal(normalizeSettingsData(blank).settings.knowledgeBase.initialized, true, "bound legacy directories complete initialization");
  blank.knowledgeBase.folderBindings = null; blank.knowledgeBase.initialized = true;
  assert.equal(normalizeSettingsData(blank).settings.knowledgeBase.initialized, true, "a dismissed reminder stays dismissed without directory bindings");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "echoink-home-refresh-"));
  try {
    const catalog = new FileConversationCatalog({ storageRootPath: root, vaultId: "refresh-test" }); await catalog.initialize();
    const create = (id: string, pending = true) => catalog.upsert({ conversationId: id, piSessionId: `pi-${id}`, vaultId: "refresh-test", title: "原始请求", ...(pending ? { titleSource: "pending" as const } : {}), status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 2 });
    await create("once"); let calls = 0;
    const input = { catalog, conversationId: "once", requests: ["你好"], generate: async () => { calls++; return "整理收件箱"; }, changed() {} };
    await generateConversationTitle(input); assert.equal(calls, 0); assert.equal((await catalog.get("once"))?.titleSource, "pending");
    input.requests.push("把收件箱里的笔记整理一下");
    await Promise.all([generateConversationTitle(input), generateConversationTitle(input)]); assert.equal(calls, 1);
    assert.equal((await catalog.get("once"))?.title, "整理收件箱"); assert.equal((await catalog.get("once"))?.updatedAt, 2, "titles are not user conversation activity");
    await generateConversationTitle(input); assert.equal(calls, 1);
    await create("manual"); let release!: (text: string) => void; let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
    const flight = generateConversationTitle({ ...input, conversationId: "manual", generate: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    await waiting; await catalog.rename("manual", "用户自己的名字"); release("不能覆盖"); await flight;
    assert.equal((await catalog.get("manual"))?.title, "用户自己的名字"); assert.equal((await catalog.get("manual"))?.titleSource, "manual");
    await create("failed"); let failedCalls = 0;
    const failed = { ...input, conversationId: "failed", generate: async (): Promise<string> => { failedCalls++; throw Error("offline"); } };
    await generateConversationTitle(failed); await generateConversationTitle(failed); assert.equal(failedCalls, 1); assert.equal((await catalog.get("failed"))?.titleSource, "fallback");
    await create("legacy", false); await generateConversationTitle({ ...input, conversationId: "legacy" }); assert.equal(calls, 1);
    const stale = (await catalog.get("once"))!; await catalog.rename("once", "手动名称"); await catalog.upsert({ ...stale, updatedAt: Date.now() + 10 }); assert.equal((await catalog.get("once"))?.title, "手动名称");

    const message = (overrides: Partial<ChatMessage>): ChatMessage => ({ id: "message", role: "assistant", text: "结果", createdAt: 30, runId: "new", ...overrides });
    const plan = { schemaVersion: 1 as const, planId: "plan", title: "计划", status: "pending" as const, version: 1, source: "agent" as const, steps: [], createdAt: 1, updatedAt: 30, productRunId: "new" };
    const messages = [message({ role: "user", createdAt: 20 }), message({ taskPlan: plan, createdAt: 1 }), message({})];
    assert.equal(workbenchResultType(messages, 20), "plan");
    assert.equal(workbenchResultType([...messages, message({ savedNotePath: "outputs/result.md" })], 20), "note");
    assert.equal(workbenchResultType([...messages, message({ role: "user", runId: "later", createdAt: 40 }), message({ runId: "later", createdAt: 41 })], 40), "answer");

    console.log("PASS workbench home: once-only titles, manual rename race, durable fallback, per-turn results");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

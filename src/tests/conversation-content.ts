import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TFile, TFolder } from "obsidian";
import { DEFAULT_CONVERSATION_CONTENT_DIRECTORY, emptyKnowledgeFolderBindings, knowledgeConversationLocation, normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { rememberConversationContentDirectory } from "../plugin/conversation-content-settings";
import { saveAnswerAsNote, type AnswerSaveVault } from "../ui/codex-view/answer-save";

export async function runConversationContentTests(root: string): Promise<void> {
  const original = emptyKnowledgeFolderBindings();
  original.collectionTargets = { web: null, wechat: null, text: "对话收藏" };
  Object.assign(original.roles.outputs, { enabled: true, readPaths: ["复盘"], writePath: "复盘" });
  assert.equal(normalizeKnowledgeFolderBindings(original)!.collectionTargets!.text, "对话收藏", "old text wins over review output");
  delete original.collectionTargets;
  assert.equal(normalizeKnowledgeFolderBindings(original)!.collectionTargets!.text, "复盘", "old output is the second migration source");
  original.roles.outputs.writePath = null;
  const migrated = normalizeKnowledgeFolderBindings(original)!;
  assert.deepEqual(knowledgeConversationLocation(migrated), { directory: DEFAULT_CONVERSATION_CONTENT_DIRECTORY, createIfMissing: true });
  const reload = normalizeKnowledgeFolderBindings(migrated)!;
  assert.deepEqual(knowledgeConversationLocation(reload), knowledgeConversationLocation(migrated), "pending first save survives reload");
  await mkdir(root, { recursive: true });
  let saves = 0;
  const plugin = {
    getVaultPath: () => root,
    settings: { knowledgeBase: { folderBindings: migrated } },
    saveSettings: async () => { saves++; }
  };
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  const vault: AnswerSaveVault = {
    getAbstractFileByPath: relative => {
      const absolute = path.join(root, relative);
      if (!existsSync(absolute)) return null;
      return Object.assign(statSync(absolute).isDirectory() ? new TFolder() : new TFile(), { path: relative });
    },
    createFolder: async relative => { await mkdir(path.join(root, relative)); return Object.assign(new TFolder(), { path: relative }); },
    create: async (relative, body) => { await writeFile(path.join(root, relative), body, { flag: "wx" }); return Object.assign(new TFile(), { path: relative }); }
  };
  try {
    const capture = new KnowledgeBaseCaptureService(plugin as never);
    const collected = (await capture.captureChatInput("raw-articles", "共用目录的收藏文字", []))[0];
    assert.equal(path.posix.dirname(collected), DEFAULT_CONVERSATION_CONTENT_DIRECTORY);
    assert.equal(saves, 1);
    assert.equal(plugin.settings.knowledgeBase.folderBindings.conversationDirectoryPending, false);
    assert.notEqual(plugin.settings.knowledgeBase.folderBindings.configured, true, "manual saving never completes Knowledge initialization");
    const saved = await saveAnswerAsNote(vault, { folderBindings: plugin.settings.knowledgeBase.folderBindings, question: "共用位置", answerMarkdown: "原样回答", conversationId: "synthetic", sourcePaths: [], onDirectoryReady: directory => rememberConversationContentDirectory(plugin as never, directory) });
    assert.equal(path.posix.dirname(saved), path.posix.dirname(collected), "Save as note and text collection use the exact same folder");
    assert.match(await readFile(path.join(root, saved), "utf8"), /原样回答/u);
    assert.equal(saves, 1, "an initialized location does not remigrate on each save");
    await rm(path.join(root, DEFAULT_CONVERSATION_CONTENT_DIRECTORY), { recursive: true });
    await assert.rejects(capture.captureChatInput("raw-articles", "已删除目录不得静默重建", []), /对话栏内容的保存位置不存在，去设置/u);
    await assert.rejects(saveAnswerAsNote(vault, { folderBindings: plugin.settings.knowledgeBase.folderBindings, question: "拒绝", answerMarkdown: "不落盘", conversationId: "synthetic", sourcePaths: [] }), /对话栏内容的保存位置不存在，去设置/u);
    assert.equal(existsSync(path.join(root, DEFAULT_CONVERSATION_CONTENT_DIRECTORY)), false);
    console.log("PASS conversation content: three migrations, pending reload, shared writes, first-save persistence and missing-location refusal");
  } finally { release(); }
}

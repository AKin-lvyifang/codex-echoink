import assert from "node:assert/strict";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { rebaseFolderSettingsPaths } from "../knowledge-base/folder-settings-paths";
import { KNOWLEDGE_ROOT_ROLES } from "../knowledge-base/root-paths-core";

function settingsFixture() {
  const folderBindings = emptyKnowledgeFolderBindings();
  folderBindings.revision = 9;
  folderBindings.configured = true;
  folderBindings.collectionTargets = { web: "库/原始资料/甲", wechat: "库/原始资料/乙" };
  folderBindings.inboxRecallExclusions = ["库/旧收件箱", "库-old/旧收件箱"];
  folderBindings.migrationIssues = ["库/这是说明，不是路径字段"];
  for (const role of KNOWLEDGE_ROOT_ROLES) Object.assign(folderBindings.roles[role], {
    enabled: false,
    readPaths: [`库/${role}`], writePath: `库/${role}`,
    allowedSubdirectories: ["库/这是相对分类名"],
    allowedSubdirectoryRoots: [`库/${role}`], autoOrganizePaths: [`库/${role}`]
  });
  Object.assign(folderBindings.roles.raw, {
    readPaths: ["库/原始资料/甲", "库/原始资料/乙", "库/原始资料-old"],
    writePath: "库/原始资料/乙",
    allowedSubdirectoryRoots: ["库/原始资料/乙"], autoOrganizePaths: ["库/原始资料/甲"]
  });
  return {
    knowledgeBase: { folderBindings, lastError: "库/保留错误原文", initialization: { lastPreviewSummary: "库/保留说明" } },
    journalDirectory: "库/日记",
    sessions: [{ journalDirectory: "库/日记/项目", title: "库/标题", messages: [{ text: "库/正文" }] }, { title: "没有日记范围" }],
    review: { enabled: false, outputDir: "库/复盘", scheduleTime: "21:00" },
    englishDiary: { enabled: false, englishDirectory: "库/英文日记", expressionDirectory: "库/英文日记/表达库",
      englishDirectoryMode: "custom" as const, expressionDirectoryMode: "role" as const, providerSettingsId: "库/服务标识",
      legacyEnglishDirectories: ["库/旧日记", "库-old/旧日记"], legacyExpressionDirectories: ["库/旧表达库"] },
    pdfReading: { enabled: false, originalDirectory: "库/原始资料", translationLanguage: "库/原文" },
    lifestyle: { finance: { enabled: false, analysisDirectory: "库/财务分析", merchants: [{ name: "库/商户" }] }, future: { path: "库/保留未知设置" } },
    mobileUi: { knowledgePaths: { raw: "库/原始资料", wiki: "库/wiki", inbox: "库/inbox" }, appearance: "dark" },
    instructions: "库/保留普通文字",
    other: { outputDir: "库/普通同名字段", path: "库/普通 path 字段", "库/普通键": "库/普通值" }
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function runKnowledgeFolderRenameTests(): void {
  const settings = deepFreeze(settingsFixture());
  const original = structuredClone(settings);
  const moved = rebaseFolderSettingsPaths(settings, { type: "rename", kind: "folder", from: "库/原始资料", to: "资料/新来源" });
  assert.deepEqual(moved.knowledgeBase.folderBindings.roles.raw.readPaths, ["资料/新来源/甲", "资料/新来源/乙", "库/原始资料-old"]);
  assert.equal(moved.knowledgeBase.folderBindings.roles.raw.writePath, "资料/新来源/乙");
  assert.deepEqual(moved.knowledgeBase.folderBindings.roles.raw.allowedSubdirectoryRoots, ["资料/新来源/乙"]);
  assert.deepEqual(moved.knowledgeBase.folderBindings.roles.raw.autoOrganizePaths, ["资料/新来源/甲"]);
  assert.deepEqual(moved.knowledgeBase.folderBindings.collectionTargets, { web: "资料/新来源/甲", wechat: "资料/新来源/乙" });
  assert.equal(moved.pdfReading.originalDirectory, "资料/新来源", "an exact directory match follows the full destination path");
  assert.equal(moved.mobileUi.knowledgePaths.raw, "资料/新来源");
  assert.equal(moved.knowledgeBase.folderBindings.revision, 10);
  assert.equal(moved.journalDirectory, settings.journalDirectory);

  const parent = rebaseFolderSettingsPaths(settings, { type: "rename", kind: "folder", from: "库", to: "笔记/知识" });
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const before = settings.knowledgeBase.folderBindings.roles[role], after = parent.knowledgeBase.folderBindings.roles[role];
    assert.deepEqual(after.readPaths, before.readPaths.map(directory => `笔记/知识${directory.slice(1)}`), `${role} full read paths follow their parent`);
    assert.equal(after.writePath, `笔记/知识${before.writePath!.slice(1)}`);
    assert.deepEqual(after.allowedSubdirectories, before.allowedSubdirectories, "child approvals are relative names, not Vault paths");
    assert.equal(after.enabled, false, "folder identity changes also update disabled bindings");
  }
  assert.deepEqual(parent.knowledgeBase.folderBindings.inboxRecallExclusions, ["笔记/知识/旧收件箱", "库-old/旧收件箱"]);
  assert.equal(parent.knowledgeBase.folderBindings.revision, 10, "one folder event advances the binding revision once");
  assert.equal(parent.journalDirectory, "笔记/知识/日记");
  assert.equal(parent.sessions[0].journalDirectory, "笔记/知识/日记/项目");
  assert.deepEqual(parent.sessions[1], settings.sessions[1]);
  assert.equal(parent.review.outputDir, "笔记/知识/复盘");
  assert.equal(parent.englishDiary.englishDirectory, "笔记/知识/英文日记");
  assert.equal(parent.englishDiary.expressionDirectory, "笔记/知识/英文日记/表达库");
  assert.deepEqual(parent.englishDiary.legacyEnglishDirectories, ["笔记/知识/旧日记", "库-old/旧日记"]);
  assert.deepEqual(parent.englishDiary.legacyExpressionDirectories, ["笔记/知识/旧表达库"]);
  assert.equal(parent.pdfReading.originalDirectory, "笔记/知识/原始资料");
  assert.equal(parent.lifestyle.finance.analysisDirectory, "笔记/知识/财务分析");
  assert.deepEqual(parent.mobileUi.knowledgePaths, { raw: "笔记/知识/原始资料", wiki: "笔记/知识/wiki", inbox: "笔记/知识/inbox" });
  for (const module of [parent.review, parent.englishDiary, parent.pdfReading, parent.lifestyle.finance]) assert.equal(module.enabled, false);
  assert.equal(parent.englishDiary.englishDirectoryMode, "custom");
  assert.equal(parent.englishDiary.expressionDirectoryMode, "custom");
  assert.equal(parent.instructions, settings.instructions);
  assert.deepEqual(parent.other, settings.other, "ordinary keys and similarly named fields are never recursively rebased");
  assert.deepEqual(parent.lifestyle.future, settings.lifestyle.future);
  assert.deepEqual(parent.lifestyle.finance.merchants, settings.lifestyle.finance.merchants);
  assert.deepEqual(parent.knowledgeBase.initialization, settings.knowledgeBase.initialization);
  assert.equal(parent.knowledgeBase.lastError, settings.knowledgeBase.lastError);
  assert.deepEqual(parent.knowledgeBase.folderBindings.migrationIssues, settings.knowledgeBase.folderBindings.migrationIssues);
  assert.equal(parent.sessions[0].title, settings.sessions[0].title);
  assert.deepEqual(parent.sessions[0].messages, settings.sessions[0].messages);
  assert.equal(parent.englishDiary.providerSettingsId, settings.englishDiary.providerSettingsId);
  assert.equal(parent.pdfReading.translationLanguage, settings.pdfReading.translationLanguage);
  assert.deepEqual(settings, original, "the helper never mutates its input");

  const roleDirectories = { englishDiary: { enabled: false, englishDirectory: "输出/英文日记", expressionDirectory: "输出/英文日记/表达库",
    englishDirectoryMode: "role" as const, expressionDirectoryMode: "role" as const,
    legacyEnglishDirectories: ["旧位置/日记"], legacyExpressionDirectories: ["旧位置/表达库"] } };
  const diaryRename = rebaseFolderSettingsPaths(roleDirectories, { type: "rename", kind: "folder", from: "输出/英文日记", to: "输出/英语" });
  assert.equal(diaryRename.englishDiary.englishDirectory, "输出/英语");
  assert.equal(diaryRename.englishDiary.expressionDirectory, "输出/英语/表达库");
  assert.equal(diaryRename.englishDiary.englishDirectoryMode, "custom");
  assert.equal(diaryRename.englishDiary.expressionDirectoryMode, "custom");
  const expressionRename = rebaseFolderSettingsPaths(roleDirectories, { type: "rename", kind: "folder", from: "输出/英文日记/表达库", to: "输出/Expressions" });
  assert.equal(expressionRename.englishDiary.expressionDirectory, "输出/Expressions");
  assert.equal(expressionRename.englishDiary.englishDirectoryMode, "role", "an unaffected current directory retains its mode");
  assert.equal(expressionRename.englishDiary.expressionDirectoryMode, "custom");
  const legacyRename = rebaseFolderSettingsPaths(roleDirectories, { type: "rename", kind: "folder", from: "旧位置", to: "新旧位置" });
  assert.deepEqual(legacyRename.englishDiary.legacyEnglishDirectories, ["新旧位置/日记"]);
  assert.deepEqual(legacyRename.englishDiary.legacyExpressionDirectories, ["新旧位置/表达库"]);
  assert.equal(legacyRename.englishDiary.englishDirectoryMode, "role", "legacy-only changes do not pin the current directory");
  assert.equal(legacyRename.englishDiary.expressionDirectoryMode, "role");

  const direct = rebaseFolderSettingsPaths({ journalDirectory: "旧目录", review: { outputDir: "旧目录/复盘" } },
    { type: "rename", kind: "folder", from: "旧目录", to: "新目录" });
  assert.deepEqual(direct, { journalDirectory: "新目录", review: { outputDir: "新目录/复盘" } });
  const prefix = { journalDirectory: "raw-old", review: { outputDir: "other/raw" }, pdfReading: { originalDirectory: "raw-old/PDF" } };
  assert.equal(rebaseFolderSettingsPaths(prefix, { type: "rename", kind: "folder", from: "raw", to: "sources" }), prefix);
  assert.equal(rebaseFolderSettingsPaths(settings, { type: "rename", kind: "file", from: "库", to: "新库" }), settings);
  assert.equal(rebaseFolderSettingsPaths(settings, { type: "delete", kind: "folder", path: "库" }), settings);
  assert.equal(rebaseFolderSettingsPaths(settings, { type: "delete", kind: "file", path: "库/日记.md" }), settings);
  assert.equal(rebaseFolderSettingsPaths(settings, { type: "rename", kind: "folder", from: "库", to: "库" }), settings);
  assert.equal(rebaseFolderSettingsPaths(settings, { type: "rename", kind: "folder", from: "", to: "新库" }), settings);
  assert.equal(rebaseFolderSettingsPaths({ journalDirectory: "", knowledgeBase: { folderBindings: null } },
    { type: "rename", kind: "folder", from: "库", to: "新库" }).journalDirectory, "", "a Vault-root journal stays at the root");
  console.log("Knowledge folder rename tests passed: direct, parent, move, prefix, disabled modules, deletion, and free text.");
}

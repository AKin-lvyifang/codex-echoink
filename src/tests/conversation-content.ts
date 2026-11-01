import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConversationContentLocationError, ensureConversationContentDirectory, type ConversationContentDirectoryHost } from "../knowledge-base/conversation-content";
import { DEFAULT_ANSWER_CONTENT_DIRECTORY, DEFAULT_GENERATION_CONTENT_DIRECTORY, KNOWLEDGE_COLLECTION_KINDS, emptyKnowledgeFolderBindings, knowledgeCollectionDescription, knowledgeCollectionDirectory, knowledgeCollectionKinds, knowledgeCollectionLabel, knowledgeCollectionTargets, knowledgeConversationLocation, knowledgeFolderBindingsSignature, knowledgeOutputLocation, migrateKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings, type KnowledgeFolderBindings, type KnowledgeOutputKind } from "../knowledge-base/folder-bindings";
import { rememberConversationContentDirectory } from "../plugin/conversation-content-settings";

function assertOutputMigrations(): KnowledgeFolderBindings {
  const original = emptyKnowledgeFolderBindings();
  original.collectionTargets = { web: null, wechat: null, text: "旧对话收藏" };
  original.conversationDirectoryPending = true;
  Object.assign(original.roles.raw, { enabled: true, readPaths: ["旧资料"], writePath: "旧资料", allowedSubdirectories: ["articles/手动收集"] });
  Object.assign(original.roles.outputs, { enabled: true, readPaths: ["复盘"], writePath: "复盘" });
  for (const kind of ["answer", "generation"] as const) {
    assert.deepEqual(knowledgeOutputLocation(original, kind), { directory: "复盘", createIfMissing: false }, "old text and Raw never override the old output");
  }
  original.collectionTargets.answer = "独立回答";
  let migrated = normalizeKnowledgeFolderBindings(original)!;
  assert.deepEqual(knowledgeOutputLocation(migrated, "answer"), { directory: "独立回答", createIfMissing: false });
  assert.deepEqual(knowledgeOutputLocation(migrated, "generation"), { directory: "复盘", createIfMissing: false }, "generation migrates independently of the answer choice");
  delete original.collectionTargets.answer;
  original.collectionTargets.generation = "独立生成";
  migrated = normalizeKnowledgeFolderBindings(original)!;
  assert.deepEqual(knowledgeOutputLocation(migrated, "answer"), { directory: "复盘", createIfMissing: false });
  assert.deepEqual(knowledgeOutputLocation(migrated, "generation"), { directory: "独立生成", createIfMissing: false });
  migrated.roles.outputs.writePath = "后来改动";
  assert.equal(knowledgeOutputLocation(migrated, "answer").directory, "复盘", "migration materializes the old output only once");
  assert(!Object.hasOwn(migrated.collectionTargets!, "text"));

  original.roles.outputs.writePath = null;
  delete original.collectionTargets.generation;
  original.conversationDirectoryPending = false;
  migrated = normalizeKnowledgeFolderBindings(original)!;
  assert.deepEqual(knowledgeOutputLocation(migrated, "answer"), { directory: DEFAULT_ANSWER_CONTENT_DIRECTORY, createIfMissing: true });
  assert.deepEqual(knowledgeOutputLocation(migrated, "generation"), { directory: DEFAULT_GENERATION_CONTENT_DIRECTORY, createIfMissing: true });
  assert.deepEqual(knowledgeConversationLocation(migrated), knowledgeOutputLocation(migrated, "answer"), "the compatibility alias means answer only");
  assert.equal(migrated.conversationDirectoryPending, undefined);
  assert.deepEqual(normalizeKnowledgeFolderBindings(migrated), migrated, "independent pending flags survive reload");
  assert(!KNOWLEDGE_COLLECTION_KINDS.includes("text" as never));
  assert.deepEqual(knowledgeCollectionKinds(migrated), ["web", "wechat", "files", "images", "answer", "generation"]);
  assert.equal(knowledgeCollectionDirectory(migrated, "answer"), DEFAULT_ANSWER_CONTENT_DIRECTORY);
  assert.equal(knowledgeCollectionDirectory(migrated, "generation"), DEFAULT_GENERATION_CONTENT_DIRECTORY);
  for (const kind of KNOWLEDGE_COLLECTION_KINDS) assert(knowledgeCollectionDescription(kind).length);
  assert.equal(knowledgeCollectionLabel("answer"), "存为笔记的回答");
  assert.equal(knowledgeCollectionLabel("generation"), "从资料生成");
  assert.match(knowledgeCollectionDescription("answer"), /整段回答/u);
  assert.match(knowledgeCollectionDescription("generation"), /生成模板.*笔记.*Canvas/u);

  const legacy = emptyKnowledgeFolderBindings();
  Object.assign(legacy.roles.raw, { enabled: true, readPaths: ["旧资料"], writePath: "旧资料", allowedSubdirectories: ["attachments", "articles/文件收藏", "articles/手动收集"] });
  assert.deepEqual(normalizeKnowledgeFolderBindings(legacy)!.collectionTargets, {
    web: "旧资料", wechat: "旧资料", files: "旧资料/attachments", images: "旧资料/attachments",
    answer: DEFAULT_ANSWER_CONTENT_DIRECTORY, generation: DEFAULT_GENERATION_CONTENT_DIRECTORY, fileText: "旧资料/articles/文件收藏"
  }, "all other legacy collection destinations keep their migration rules");
  const observed = migrateKnowledgeFolderBindings(["raw"]);
  assert.equal(knowledgeOutputLocation(observed, "answer").createIfMissing, true);
  assert.equal(knowledgeOutputLocation(observed, "generation").createIfMissing, true);
  const explicitMissing = structuredClone(migrated);
  explicitMissing.collectionTargets!.answer = null;
  explicitMissing.roles.outputs.writePath = "不要回退";
  assert.equal(knowledgeCollectionDirectory(normalizeKnowledgeFolderBindings(explicitMissing), "answer"), null, "an explicit invalid choice never redirects the answer");
  return migrated;
}

function assertBindingInterfaces(original: KnowledgeFolderBindings): void {
  const signature = knowledgeFolderBindingsSignature(original);
  const legacy = structuredClone(original);
  legacy.collectionTargets!.text = "ignored";
  legacy.conversationDirectoryPending = true;
  assert.equal(knowledgeFolderBindingsSignature(legacy), signature, "retired text fields do not affect effective drafts");
  for (const kind of ["answer", "generation"] as const) {
    const changed = structuredClone(original);
    changed.collectionTargets![kind] = `新位置/${kind}`;
    assert.notEqual(knowledgeFolderBindingsSignature(changed), signature);
    const ready = structuredClone(original);
    if (kind === "answer") ready.answerDirectoryPending = false;
    else ready.generationDirectoryPending = false;
    assert.notEqual(knowledgeFolderBindingsSignature(ready), signature, "each first-save state participates in stale-plan checks");
  }
  const rebased = rebaseKnowledgeFolderBindings(original, "收藏", "新收藏");
  assert.equal(rebased.collectionTargets!.answer, "新收藏/回答");
  assert.equal(rebased.collectionTargets!.generation, "新收藏/生成");
  assert.equal(rebased.revision, original.revision + 1);
  assert.equal(knowledgeFolderBindingsSignature(rebaseKnowledgeFolderBindings(rebased, "新收藏", "收藏")), signature, "both effective locations support the existing rebase interface");
  assert.equal(rebaseKnowledgeFolderBindings(original, "无关", "其他").revision, original.revision);
}

function directoryHost(root: string, ready?: ConversationContentDirectoryHost["ready"]): ConversationContentDirectoryHost {
  return {
    kind: async directory => {
      try { return (await stat(path.join(root, directory))).isDirectory() ? "folder" : "file"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    },
    createFolder: async directory => { await mkdir(path.join(root, directory)); },
    ready
  };
}

async function assertFirstSaveAndDeletion(root: string, first: KnowledgeOutputKind): Promise<void> {
  await mkdir(root, { recursive: true });
  let saves = 0;
  const plugin = {
    settings: { knowledgeBase: { folderBindings: null as KnowledgeFolderBindings | null } },
    saveSettings: async () => { saves++; }
  };
  for (const kind of [first, first === "answer" ? "generation" : "answer"] as const) {
    const expected = knowledgeOutputLocation(plugin.settings.knowledgeBase.folderBindings, kind).directory;
    const host = directoryHost(root, directory => rememberConversationContentDirectory(plugin as never, directory, kind));
    assert.equal(await ensureConversationContentDirectory(host, plugin.settings.knowledgeBase.folderBindings, kind), expected);
    const saved = plugin.settings.knowledgeBase.folderBindings!;
    assert.equal(knowledgeOutputLocation(saved, kind).createIfMissing, false);
    assert.notEqual(saved.configured, true, "saving an output never completes Knowledge initialization");
    assert(!Object.hasOwn(saved.collectionTargets!, "text"));
    assert.deepEqual(knowledgeCollectionTargets(saved), saved.collectionTargets);
    assert.equal(await ensureConversationContentDirectory(host, saved, kind), expected);
    assert.equal(saves, kind === first ? 1 : 2, "a ready destination is not persisted again");
    if (kind === first) assert.equal(knowledgeOutputLocation(saved, first === "answer" ? "generation" : "answer").createIfMissing, true, "saving one output leaves the other first save available");
    await rm(path.join(root, expected), { recursive: true });
    const reloaded = normalizeKnowledgeFolderBindings(saved)!;
    await assert.rejects(ensureConversationContentDirectory(host, reloaded, kind), (error: unknown) => error instanceof ConversationContentLocationError && error.kind === kind && error.message === `${kind === "answer" ? "存为笔记的回答" : "从资料生成"}的保存位置不存在，去设置`);
    assert.equal(await host.kind(expected), "missing", "a deleted destination is never recreated");
  }
  assert.equal(saves, 2);
}

async function assertPersistenceFailure(root: string): Promise<void> {
  const previous = normalizeKnowledgeFolderBindings(emptyKnowledgeFolderBindings())!;
  const plugin = { settings: { knowledgeBase: { folderBindings: previous } }, saveSettings: async () => { throw new Error("settings failed"); } };
  await assert.rejects(rememberConversationContentDirectory(plugin as never, DEFAULT_GENERATION_CONTENT_DIRECTORY, "generation"), /settings failed/u);
  assert.equal(plugin.settings.knowledgeBase.folderBindings, previous, "a failed settings write restores the prior binding object");
  assert.equal(knowledgeOutputLocation(previous, "generation").createIfMissing, true);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "收藏"), "a file blocks the parent directory");
  for (const kind of ["answer", "generation"] as const) await assert.rejects(ensureConversationContentDirectory(directoryHost(root), previous, kind), (error: unknown) => error instanceof ConversationContentLocationError && error.kind === kind);
  const invalid = structuredClone(previous);
  invalid.collectionTargets!.answer = "../outside";
  await assert.rejects(ensureConversationContentDirectory(directoryHost(root), invalid), ConversationContentLocationError);
  assert.equal(new ConversationContentLocationError().kind, "answer");
}

export async function runConversationContentTests(root: string): Promise<void> {
  const migrated = assertOutputMigrations();
  assertBindingInterfaces(migrated);
  await assertFirstSaveAndDeletion(path.join(root, "answer-first"), "answer");
  await assertFirstSaveAndDeletion(path.join(root, "generation-first"), "generation");
  await assertPersistenceFailure(path.join(root, "persistence-failure"));
  console.log("PASS output locations: independent migration, retired text, rebase/signatures, first-save persistence and deleted-location refusal");
}

import assert from "node:assert/strict";
import { TFile, type App } from "obsidian";
import {
  addComposerNoteMentionSelection,
  buildNoteMentionCatalog,
  buildVaultNoteMentionCatalog,
  cachedComposerNoteMentionCatalog,
  closeComposerNoteMentionMenu,
  composerNoteMentionMenuState,
  handleComposerNoteMentionKeyDown,
  noteMentionQueryAtCursor,
  reconcileComposerNoteMentionMenuAtCursor,
  normalizeNoteAliases,
  removeNoteMentionQuery,
  searchNoteMentionCatalog,
  setComposerNoteMentionMenu,
  snapshotComposerNoteMentions
} from "../ui/codex-view/note-mentions";
import { RuntimeTurnQueue } from "../ui/turn-queue";
import {
  buildPiNoteMentionContextMessage,
  noteMentionReferencesFromPiContext
} from "../harness/pi-native/pi-note-mentions";

export async function runNoteMentionTests(): Promise<void> {
  const catalog = buildNoteMentionCatalog([
    {
      vaultRelativePath: "projects/项目复盘.md",
      fileName: "项目复盘.md",
      aliases: ["周会总结", "复盘材料"]
    },
    {
      vaultRelativePath: "archive/周会总结.md",
      fileName: "周会总结.md",
      aliases: "项目复盘"
    },
    {
      vaultRelativePath: "daily/晨间记录.md",
      fileName: "晨间记录.md"
    },
    {
      vaultRelativePath: "assets/项目复盘.png",
      fileName: "项目复盘.png"
    }
  ]);

  assert.equal(catalog.length, 3, "catalog contains Markdown notes only");
  const collidingSearchKeys = buildNoteMentionCatalog([
    { vaultRelativePath: "a-b.md", fileName: "a-b.md" },
    { vaultRelativePath: "ab.md", fileName: "ab.md" },
    { vaultRelativePath: "a/b.md", fileName: "b.md" }
  ]);
  assert.deepEqual(
    collidingSearchKeys.map((entry) => entry.vaultRelativePath).sort(),
    ["a-b.md", "a/b.md", "ab.md"],
    "distinct Vault paths remain distinct even when their flattened fuzzy-search keys collide"
  );
  const vaultCatalog = buildVaultNoteMentionCatalog({
    vault: {
      getMarkdownFiles: () => [{ path: "项目/路线.md", name: "路线.md" } as TFile]
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { aliases: ["产品路线"] } })
    }
  } as Pick<App, "vault" | "metadataCache">);
  assert.equal(searchNoteMentionCatalog(vaultCatalog, "产品路线")[0]?.vaultRelativePath, "项目/路线.md",
    "Vault catalog reads frontmatter array aliases");
  assert.equal(searchNoteMentionCatalog(catalog, "项目复盘")[0]?.vaultRelativePath, "projects/项目复盘.md");
  assert.equal(searchNoteMentionCatalog(catalog, "projects2026").length, 0);
  assert.equal(searchNoteMentionCatalog(catalog, "projects项目")[0]?.vaultRelativePath, "projects/项目复盘.md");
  assert.equal(searchNoteMentionCatalog(catalog, "周会总结")[0]?.vaultRelativePath, "archive/周会总结.md",
    "direct filename outranks another note's alias");
  assert.equal(searchNoteMentionCatalog(catalog, "复盘材料")[0]?.vaultRelativePath, "projects/项目复盘.md");
  assert.equal(searchNoteMentionCatalog(catalog, "xiangmufupan")[0]?.vaultRelativePath, "projects/项目复盘.md");
  assert.equal(searchNoteMentionCatalog(catalog, "xmfp")[0]?.vaultRelativePath, "projects/项目复盘.md");
  assert.deepEqual(
    searchNoteMentionCatalog(catalog, "").map((item) => item.vaultRelativePath),
    ["archive/周会总结.md", "daily/晨间记录.md", "projects/项目复盘.md"],
    "bare @ results use normalized-path stable order"
  );
  assert.deepEqual(normalizeNoteAliases("单个别名"), ["单个别名"]);
  assert.deepEqual(normalizeNoteAliases(["数组别名", 3, "数组别名", " 第二别名 "]), ["数组别名", "第二别名"]);

  const parsed = noteMentionQueryAtCursor("请比较 @项目复盘 后续", 9);
  assert.deepEqual(parsed, { start: 4, end: 9, query: "项目复盘" });
  assert.equal(noteMentionQueryAtCursor("请比较 @项目 复盘", 10), null, "spaces close the active mention query");
  assert.deepEqual(noteMentionQueryAtCursor("@项目", 3), { start: 0, end: 3, query: "项目" });
  assert.equal(noteMentionQueryAtCursor("foo@bar", 7), null, "inline @ does not open note completion");
  assert.equal(noteMentionQueryAtCursor("test@example.com", 16), null, "email addresses do not open note completion");
  assert.equal(noteMentionQueryAtCursor("`@code`", 6), null, "inline code tokens do not open note completion");
  assert.deepEqual(removeNoteMentionQuery("请比较 @项目复盘 后续", parsed!), {
    value: "请比较  后续",
    cursor: 4
  });

  const cacheInput = {
    value: "@",
    selectionStart: 1,
    removeAttribute: () => undefined
  } as unknown as HTMLTextAreaElement;
  let catalogBuilds = 0;
  const getCatalog = () => cachedComposerNoteMentionCatalog(cacheInput, () => {
    catalogBuilds += 1;
    return catalog;
  });
  assert.equal(getCatalog(), catalog);
  setComposerNoteMentionMenu(cacheInput, {
    results: catalog,
    onSelect: () => undefined,
    onRender: () => undefined,
    onClose: () => undefined
  });
  assert.equal(getCatalog(), catalog);
  assert.equal(catalogBuilds, 1, "one open @ menu session reuses its Vault catalog");
  closeComposerNoteMentionMenu(cacheInput);
  assert.equal(getCatalog(), catalog);
  assert.equal(catalogBuilds, 2, "closing the @ menu invalidates its temporary catalog");

  const input = {
    value: "@项目",
    selectionStart: 3,
    removeAttribute: () => undefined
  } as unknown as HTMLTextAreaElement;
  let selectedPath = "";
  let renders = 0;
  let closes = 0;
  setComposerNoteMentionMenu(input, {
    results: catalog.slice(0, 2),
    onSelect: (entry) => { selectedPath = entry.vaultRelativePath; },
    onRender: () => { renders += 1; },
    onClose: () => { closes += 1; }
  });
  assert.equal(handleComposerNoteMentionKeyDown(keyEvent("ArrowDown"), input), true);
  assert.equal(composerNoteMentionMenuState(input).activeIndex, 1);
  assert.equal(renders, 1);
  assert.equal(handleComposerNoteMentionKeyDown(keyEvent("Enter", true), input), false,
    "IME composition Enter never selects a note");
  assert.equal(selectedPath, "");
  for (const key of ["Process", "Unidentified"]) {
    assert.equal(handleComposerNoteMentionKeyDown(keyEvent(key), input), false, `${key} never selects or navigates a note`);
    assert.equal(selectedPath, "");
  }
  assert.equal(handleComposerNoteMentionKeyDown(keyEvent("Enter"), input), true);
  assert.equal(selectedPath, catalog[1]?.vaultRelativePath);
  assert.equal(handleComposerNoteMentionKeyDown(keyEvent("Escape"), input), true);
  assert.equal(closes, 1);

  setComposerNoteMentionMenu(input, {
    results: catalog.slice(0, 1),
    onSelect: (entry) => { selectedPath = entry.vaultRelativePath; },
    onRender: () => { renders += 1; },
    onClose: () => { closes += 1; }
  });
  input.selectionStart = 0;
  assert.equal(reconcileComposerNoteMentionMenuAtCursor(input), false,
    "moving the cursor outside the active @ query closes the stale menu");
  assert.equal(composerNoteMentionMenuState(input).open, false);

  setComposerNoteMentionMenu(input, {
    results: catalog.slice(0, 1),
    onSelect: (entry) => { selectedPath = entry.vaultRelativePath; },
    onRender: () => { renders += 1; },
    onClose: () => { closes += 1; }
  });
  assert.equal(handleComposerNoteMentionKeyDown(keyEvent("Enter"), input), false,
    "Enter is not swallowed when the cursor no longer has an active @ query");
  assert.equal(composerNoteMentionMenuState(input).open, false);

  const snapshotInput = {
    removeAttribute: () => undefined
  } as unknown as HTMLTextAreaElement;
  addComposerNoteMentionSelection(snapshotInput, {
    vaultRelativePath: "projects/项目复盘.md",
    fileName: "项目复盘.md"
  });
  const noteFile = new TFile("projects/项目复盘.md");
  let currentBody = "# 第一版\n\n完整正文";
  const snapshots = await snapshotComposerNoteMentions({
    vault: {
      getAbstractFileByPath: (path: string) => path === noteFile.path ? noteFile : null,
      read: async () => currentBody
    }
  } as unknown as Pick<App, "vault">, snapshotInput);
  currentBody = "# 第二版";
  assert.equal(snapshots[0]?.content, "# 第一版\n\n完整正文",
    "the whole note body is frozen when the draft is captured");

  const queue = new RuntimeTurnQueue();
  const sourceSnapshot = { ...snapshots[0]! };
  queue.enqueue({
    id: "note-queue",
    sessionId: "note-session",
    text: "比较这篇笔记",
    attachments: [],
    noteMentions: [sourceSnapshot],
    skill: null,
    turnOptions: {
      providerSettingsId: "provider",
      model: "model",
      reasoning: "high",
      serviceTier: "fast",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 1
  });
  sourceSnapshot.content = "外部变化";
  assert.equal(queue.peekNext("note-session")?.noteMentions?.[0]?.content, "# 第一版\n\n完整正文",
    "the runtime queue owns a deep copy of the frozen body");

  const contextMessage = buildPiNoteMentionContextMessage(snapshots)!;
  assert.equal(contextMessage.display, false);
  assert.match(String(contextMessage.content), /不可信的用户背景材料/u);
  assert.match(String(contextMessage.content), /完整正文/u);
  assert.deepEqual(
    noteMentionReferencesFromPiContext(contextMessage.customType, contextMessage.details),
    [{ vaultRelativePath: "projects/项目复盘.md", fileName: "项目复盘.md" }],
    "durable display metadata never contains the note body"
  );

  console.log("PASS conversation-ui: note mention catalog searches name, path, aliases, full pinyin, and initials");
}

function keyEvent(key: string, isComposing = false): KeyboardEvent {
  return {
    key,
    isComposing,
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  } as unknown as KeyboardEvent;
}

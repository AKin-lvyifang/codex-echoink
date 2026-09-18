import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { pluginDataDir, pluginInstallDir, preparePluginDataRoot } from "../plugin/plugin-data-paths";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { createDurablePiSession } from "../harness/pi-native/pi-session-durability";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { HomeActivityService } from "../home/home-activity-service";
import { refreshKnowledgeBaseIndex, commitKnowledgeBaseIndexCheckpoint, clearKnowledgeBaseIndexMemoryCache } from "../knowledge-base/incremental-index";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { runKnowledgeBaseShortcut } from "../ui/codex-view/turn-runner";
import { openTestNoticeMessages } from "./obsidian-shim";
export { Notice } from "./obsidian-shim";
export { conversationUiText } from "../ui/codex-view/ui-i18n";

export async function runCommunityWarningFixesTests(first: Window, second: Window, createCapture: (host: any) => () => void) {
  await dataRoots();
  measuredRows(first, second);
  await runShortcutFailureTests(createCapture);
  console.log("Community warning fixes regression: PASS");
}

async function dataRoots() {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-warning-fixes-")));
  const bindings: Array<{ dispose(): void }> = [];
  try {
    const id = "codex-echoink";
    for (const [caseName, dir, configDir] of [
      ["default", undefined, ".obsidian"],
      ["custom-fallback", undefined, ".obsidian-work"],
      ["custom-manifest", ".obsidian-work/plugins/codex-echoink", ".ignored"]
    ]) {
      const vault = path.join(temp, caseName!);
      await mkdir(vault);
      const manifest = { id, dir };
      const expected = path.join(vault, pluginInstallDir(manifest, configDir));
      // An empty previous location must not force fallback.
      await mkdir(path.join(vault, ".obsidian/plugins", dir ?? id), { recursive: true });
      const binding = await preparePluginDataRoot(vault, manifest, configDir!);
      bindings.push(binding);
      assert.equal(binding.rootPath, expected);
      assert.equal(binding.usingPreviousRoot, false);
      assert.equal(pluginDataDir(vault), expected);
      assert.equal(pluginDataDir(vault, pluginInstallDir(manifest, configDir)), expected);
      await mkdir(path.join(vault, "wiki"));
      await writeFile(path.join(vault, "wiki/note.md"), "# Knowledge fixture\n");
      const index = await refreshKnowledgeBaseIndex(vault, { roots: ["wiki"] });
      assert.equal(index.indexPath, path.join(expected, "knowledge-index-v1.json"));
      await commitKnowledgeBaseIndexCheckpoint(vault, index, "lint", { full: true, paths: ["wiki/note.md"], deletedPaths: [], neighborPaths: [] });
      clearKnowledgeBaseIndexMemoryCache(vault);
      const reloaded = await refreshKnowledgeBaseIndex(vault, { roots: ["wiki"] });
      assert.ok(reloaded.index.checkpoints.lint?.["wiki/note.md"]);
      assert.equal(reloaded.reusedCount, 1);
    }
    // Two live Vaults retain independent choices, including symlink aliases.
    const vault = path.join(temp, "legacy");
    await mkdir(vault);
    const dir = ".obsidian-work/plugins/codex-echoink";
    const oldRoot = path.join(vault, ".obsidian/plugins", dir);
    const storage = path.join(oldRoot, "pi-agent-product-v1");
    const catalog = new FileConversationCatalog({ storageRootPath: storage, vaultId: "fixture" });
    await catalog.initialize();
    const durable = createDurablePiSession({
      api: { codingAgentVersion: "0.82.1", currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, root, cwd) => SessionManager.open(file, root, cwd) },
      sessionRoot: catalog.sessionRootPath, cwd: vault
    });
    durable.sessionManager.appendMessage({ role: "user", content: "Existing conversation", timestamp: Date.now() });
    await catalog.upsert({ conversationId: "existing", piSessionId: durable.piSessionId, vaultId: "fixture", title: "Existing", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 1, sessionFile: durable.sessionFile });
    const memory = new PersonalMemoryRepository({ vaultPath: storage, vaultId: "fixture", watchExternalChanges: false });
    await memory.initialize();
    const memoryBefore = await readFile(memory.layout.memory, "utf8");
    await memory.dispose();
    const activity = new HomeActivityService(path.join(oldRoot, "home-activity.json"));
    await activity.initialize();
    activity.record("Existing.md", "created");
    await activity.dispose();
    const catalogBefore = await readFile(catalog.filePath, "utf8");
    const sessionBefore = await readFile(durable.sessionFile, "utf8");
    const alias = path.join(temp, "legacy-alias");
    await symlink(vault, alias, "dir");
    for (const both of [false, true]) {
      const newRoot = path.join(vault, dir);
      if (both) {
        await mkdir(newRoot, { recursive: true });
        await writeFile(path.join(newRoot, "home-activity.json"), "new-root-preserved");
      }
      const binding = await preparePluginDataRoot(alias, { id, dir }, ".obsidian-work");
      bindings.push(binding);
      assert.equal(binding.rootPath, oldRoot);
      assert.equal(binding.usingPreviousRoot, true);
      assert.equal(binding.installRootHasData, both);
      assert.equal(pluginDataDir(vault), oldRoot);
      assert.equal(pluginDataDir(alias, dir), oldRoot);
      assert.equal(pluginDataDir(path.join(temp, "custom-fallback")), path.join(temp, "custom-fallback/.obsidian-work/plugins", id));
      const reopened = new FileConversationCatalog({ storageRootPath: path.join(pluginDataDir(vault), "pi-agent-product-v1"), vaultId: "fixture" });
      await reopened.initialize();
      const entry = await reopened.get("existing");
      assert.equal(entry?.sessionFile, durable.sessionFile);
      const session = SessionManager.open(entry!.sessionFile!, reopened.sessionRootPath, vault);
      assert.ok(JSON.stringify(session.getEntries()).includes("Existing conversation"));
      const reloadedActivity = new HomeActivityService(path.join(pluginDataDir(vault), "home-activity.json"));
      await reloadedActivity.initialize();
      assert.equal(reloadedActivity.snapshot().events[0]?.path, "Existing.md");
      await reloadedActivity.dispose();
      assert.equal(await readFile(path.join(pluginDataDir(vault), "pi-agent-product-v1/.echoink/shared-user/MEMORY.md"), "utf8"), memoryBefore);
      assert.equal(await readFile(catalog.filePath, "utf8"), catalogBefore);
      assert.equal(await readFile(durable.sessionFile, "utf8"), sessionBefore);
      if (both) assert.equal(await readFile(path.join(newRoot, "home-activity.json"), "utf8"), "new-root-preserved");
      await mkdir(path.join(vault, "wiki"), { recursive: true });
      await writeFile(path.join(vault, "wiki/legacy.md"), "# Legacy knowledge");
      assert.equal((await refreshKnowledgeBaseIndex(vault, { roots: ["wiki"] })).indexPath, path.join(oldRoot, "knowledge-index-v1.json"));
      binding.dispose();
      assert.equal(pluginDataDir(alias, dir), path.join(alias, dir));
    }
    console.log("Default/custom roots, empty/legacy/dual stores, Vault isolation, native Pi session reopen, memory/activity/index: PASS");
  } finally {
    for (const binding of bindings) binding.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}

function measuredRows(first: Window, second: Window) {
  for (const [name, win] of [["main", first], ["popout", second]] as const) {
    const messages = win.document.createElement("div");
    const list = win.document.createElement("div");
    const row = win.document.createElement("div");
    row.dataset.rowId = "message-row";
    row.getBoundingClientRect = () => ({ height: 123.5 } as DOMRect);
    list.append(row, win.document.createElementNS("http://www.w3.org/2000/svg", "svg"));
    Object.defineProperty(messages, "clientHeight", { value: 500 });
    Object.defineProperty(messages, "scrollHeight", { value: 1000 });
    if (name === "popout") assert.equal(row instanceof HTMLElement, false);
    const observed: Element[] = [];
    let resize: () => void = () => {};
    (win as any).ResizeObserver = class {
      constructor(callback: () => void) { resize = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    };
    const renderer = new CodexMessageListRenderer();
    const state = renderer as any;
    state.env = { messagesEl: messages, virtualListEl: list, shouldFollowBottom: () => true };
    let rerenders = 0;
    state.scheduleMeasuredRowsRerender = () => { rerenders += 1; };
    assert.equal(renderer.measureVisibleVirtualRows(messages, list, true, { rerender: false }), true);
    assert.equal(state.virtualRowHeights.get("message-row"), 124);
    assert.equal(messages.scrollTop, 1000);
    state.observeVisibleVirtualRows(messages, list);
    assert.deepEqual(observed, [row]);
    row.getBoundingClientRect = () => ({ height: 201 } as DOMRect);
    resize();
    assert.equal(state.virtualRowHeights.get("message-row"), 201);
    assert.equal(rerenders, 1);
    renderer.dispose();
  }
  console.log("Two-window production row measurement and ResizeObserver registration/callback: PASS");
}

export async function runShortcutFailureTests(createCapture: (host: any) => () => void) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const fail of ["initial-save", "all-saves", "runner", "final-save", "externalize", "mutation-final", "success", "entry-rejection"]) {
      openTestNoticeMessages.length = 0;
      const session = { id: "fixture", messages: [] as any[], updatedAt: 0 };
      let saves = 0, runners = 0, mutations = 0, statuses = 0;
      let finished: Promise<void> = Promise.resolve();
      const host: any = {
        running: false, ensureSession: () => session,
        renderTabs() {}, renderMessages() {}, renderToolbar() {}, applyStatus() { statuses += 1; },
        plugin: {
          settings: { settingsLanguage: "en" },
          withEchoInkConversationMutation: async (_: string, action: () => Promise<void>) => {
            mutations += 1;
            if (fail === "mutation-final" && mutations === 2) throw new Error("mutation-final");
            return action();
          },
          saveSettings: async () => {
            saves += 1;
            if (fail === "all-saves" || (fail === "initial-save" && saves === 1) || (fail === "final-save" && saves === 2)) throw new Error(fail);
          },
          externalizeMessageText: async () => { if (fail === "externalize") throw new Error(fail); },
          getKnowledgeSurfaceService: () => ({ captureLink: async () => {
            runners += 1;
            if (fail === "runner") throw new Error(fail);
            return ["Saved.md"];
          } })
        },
        runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>) {
          finished = fail === "entry-rejection" ? Promise.reject(new Error(fail)) : runKnowledgeBaseShortcut(host, label, runner);
          return finished;
        }
      };
      createCapture(host)();
      // Let the DOM callback's detached promise settle without adding a test catch.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, [], fail);
      assert.equal(host.running, false, fail);
      if (fail !== "entry-rejection") {
        await finished;
        assert.equal(statuses, 1, fail);
        assert.equal(session.messages[1].status, fail === "success" ? "completed" : "failed", fail);
      }
      assert.equal(runners, ["initial-save", "all-saves", "entry-rejection"].includes(fail) ? 0 : 1, fail);
      assert.equal(openTestNoticeMessages.length, 1, fail);
      assert.match(openTestNoticeMessages[0]!, fail === "success" ? /^Save$/ : /failed|Could not save/i, fail);
    }
    console.log("Real capture callback: initial/final persistence failures, operation failure, entry rejection and success; no unhandled rejection: PASS");
  } finally { process.off("unhandledRejection", onUnhandled); }
}

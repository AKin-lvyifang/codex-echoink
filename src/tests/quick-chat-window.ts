import assert from "node:assert/strict";
import { Platform } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { QuickChatWindowController } from "../plugin/quick-chat-window";
import type { QuickGlobalShortcutBridge } from "../core/quick-window-bridge";
import { CodexView } from "../ui/codex-view";
import {
  addComposerNoteMentionSelection,
  composerNoteMentionSelections,
  removeComposerNoteMentionSelection
} from "../ui/codex-view/note-mentions";

/** The Electron registry is process-wide, including other Vaults and plugins. */
export async function runQuickChatWindowTests(): Promise<void> {
  migrationRetainsNoteReferencesWithTheDraft();
  const registrations = new Map<string, () => void>();
  const bridge: QuickGlobalShortcutBridge = {
    register(accelerator, callback) {
      if (registrations.has(accelerator)) return false;
      registrations.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) { registrations.delete(accelerator); },
    isRegistered(accelerator) { return registrations.has(accelerator); }
  };
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const wasDesktop = Platform.isDesktopApp;
  const controllers: QuickChatWindowController[] = [];
  const createController = () => {
    const settings = { quickChat: { enabled: true, hotkey: "CommandOrControl+Shift+E" } };
    const plugin = {
      settings,
      registerEvent: () => undefined,
      app: { workspace: { on: () => ({}) } }
    } as unknown as CodexForObsidianPlugin;
    const controller = new QuickChatWindowController(plugin);
    controllers.push(controller);
    return { controller, settings };
  };
  try {
    Platform.isDesktopApp = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { require: () => ({ globalShortcut: bridge }) }
    });
    const first = createController();
    const second = createController();
    assert.deepEqual(first.controller.applySettings(), { ok: true, reason: "" });
    const firstCallback = registrations.get(first.settings.quickChat.hotkey);
    assert.deepEqual(second.controller.applySettings(), { ok: false, reason: "occupied" });
    assert.equal(registrations.get(first.settings.quickChat.hotkey), firstCallback,
      "another Vault must not replace the first Vault's shortcut");
    second.controller.dispose();
    assert.equal(registrations.get(first.settings.quickChat.hotkey), firstCallback,
      "unloading the unsuccessful claimant must not unregister the owner");

    first.settings.quickChat.hotkey = "CommandOrControl+Shift+K";
    assert.deepEqual(first.controller.applySettings(), { ok: true, reason: "" });
    assert.equal(registrations.has("CommandOrControl+Shift+E"), false,
      "changing a shortcut releases this controller's old key");
    assert.equal(registrations.has("CommandOrControl+Shift+K"), true);
    assert.deepEqual(first.controller.applySettings(), { ok: true, reason: "" },
      "reapplying the same controller's settings remains valid");

    const otherPluginCallback = () => undefined;
    registrations.set("CommandOrControl+Shift+X", otherPluginCallback);
    first.settings.quickChat.hotkey = "CommandOrControl+Shift+X";
    assert.deepEqual(first.controller.applySettings(), { ok: false, reason: "occupied" });
    assert.equal(registrations.get("CommandOrControl+Shift+X"), otherPluginCallback,
      "changing to another plugin's shortcut must preserve its callback");
    assert.equal(registrations.has("CommandOrControl+Shift+K"), false);
    first.controller.dispose();
    assert.equal(registrations.get("CommandOrControl+Shift+X"), otherPluginCallback);

    const reloaded = createController();
    assert.deepEqual(reloaded.controller.applySettings(), { ok: true, reason: "" });
    reloaded.settings.quickChat.enabled = false;
    assert.deepEqual(reloaded.controller.applySettings(), { ok: false, reason: "disabled" });
    assert.equal(registrations.has(reloaded.settings.quickChat.hotkey), false);
    reloaded.settings.quickChat.enabled = true;
    assert.deepEqual(reloaded.controller.applySettings(), { ok: true, reason: "" });
  } finally {
    for (const controller of controllers) controller.dispose();
    Platform.isDesktopApp = wasDesktop;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function migrationRetainsNoteReferencesWithTheDraft(): void {
  const plugin = { settings: { activeSessionId: "conversation-a" } } as unknown as CodexForObsidianPlugin;
  const createView = (draft: string) => {
    const view = new CodexView({} as CodexView["leaf"], plugin);
    const input = { value: draft, setSelectionRange: () => undefined } as unknown as HTMLTextAreaElement;
    // Exercise the real migration methods while isolating their DOM rendering.
    Object.assign(view, {
      inputEl: input,
      renderAttachments: () => undefined,
      renderQueue: () => undefined,
      renderTabs: () => undefined,
      renderMessages: () => undefined,
      renderToolbar: () => undefined,
      applyStatus: () => undefined,
      sessionById: () => null
    });
    return { view, input };
  };
  const note = { vaultRelativePath: "项目/计划.md", fileName: "计划.md" };
  const source = createView("请结合这份笔记回答");
  addComposerNoteMentionSelection(source.input, note);
  const snapshot = source.view.exportMigrationState();
  const sidebar = createView("");
  sidebar.view.importMigrationState(snapshot);
  assert.equal(sidebar.input.value, source.input.value);
  assert.deepEqual(composerNoteMentionSelections(sidebar.input), [note],
    "returning to the sidebar must retain the note references used on send");
  sidebar.view.importMigrationState(snapshot);
  assert.deepEqual(composerNoteMentionSelections(sidebar.input), [note],
    "reapplying the migration must not duplicate note chips");
  removeComposerNoteMentionSelection(sidebar.input, note.vaultRelativePath);
  assert.deepEqual(composerNoteMentionSelections(source.input), [note],
    "successor edits must not mutate the original composer selections");

  addComposerNoteMentionSelection(sidebar.input, note);
  const emptyDraft = createView("");
  sidebar.view.importMigrationState(emptyDraft.view.exportMigrationState());
  assert.equal(sidebar.input.value, "");
  assert.deepEqual(composerNoteMentionSelections(sidebar.input), [],
    "a draft without references must not retain a prior draft's note chips");
}

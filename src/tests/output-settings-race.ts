import assert from "node:assert/strict";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { rememberConversationContentDirectory } from "../plugin/conversation-content-settings";
import { emptyKnowledgeFolderBindings, knowledgeOutputLocation, normalizeKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";

for (const kind of ["answer", "generation"] as const) {
  const previous = normalizeKnowledgeFolderBindings(emptyKnowledgeFolderBindings())!;
  let started!: () => void, rejectFirst!: (error: Error) => void;
  const firstSaveStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0, persisted: KnowledgeFolderBindings | null = null;
  const plugin = {
    settings: { knowledgeBase: { folderBindings: previous } },
    saveSettings: async () => {
      if (++calls === 1) { started(); await new Promise<void>((_, reject) => { rejectFirst = reject; }); }
      else persisted = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    }
  };
  // Exercise the real service method; all roles are disabled and both default
  // outputs are pending, so this fixture neither inspects nor writes a Vault.
  const host = { plugin, folderOperationBusy: false, withStructureMutation: async (operation: () => Promise<unknown>) => operation() };
  const next = structuredClone(previous); next.organization!.enabled = false;
  const saving = EchoInkKnowledgeSurfaceService.prototype.saveDirectoryBindings.call(host as never, next);
  const failed = assert.rejects(saving, /绑定保存失败，保留较新的配置/u);
  await firstSaveStarted;
  await rememberConversationContentDirectory(plugin as never, knowledgeOutputLocation(plugin.settings.knowledgeBase.folderBindings, kind).directory, kind);
  rejectFirst(new Error("settings write rejected"));
  await failed;
  assert.equal(calls, 2, "an old failure does not save over the newer commit");
  assert.equal(knowledgeOutputLocation(plugin.settings.knowledgeBase.folderBindings, kind).createIfMissing, false);
  assert.equal(knowledgeOutputLocation(persisted, kind).createIfMissing, false, "the successful first-save state survives reload");
  assert.equal(knowledgeOutputLocation(persisted, kind === "answer" ? "generation" : "answer").createIfMissing, true);
}
console.log("PASS output settings race: failed directory edit preserves concurrent answer/generation first-save commits");

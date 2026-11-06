import { ModuleOwnerRequired } from "../agents/registry";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { ownedEl, ownedFragment } from "../ui/owned-dom";

export class WorkbenchSetupRequired extends Error {
  constructor(message: string, readonly target: "knowledge" | "models" | "conversation") { super(message); }
}

/** Every workbench action reports failure at its visible entry, including setup links. */
export function showWorkbenchActionFailure(plugin: CodexForObsidianPlugin, error: unknown): void {
  if (error instanceof ModuleOwnerRequired) { plugin.openModuleOwnerPicker(error.moduleId); return; }
  const english = plugin.settings.settingsLanguage === "en";
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof WorkbenchSetupRequired)) {
    new Notice(`${english ? "Could not complete the action" : "操作未完成"}：${message}`);
    return;
  }
  const doc = plugin.app.workspace.containerEl.ownerDocument;
  const content = ownedFragment(doc); content.append(`${message} `);
  const button = ownedEl(doc, "button"); button.type = "button";
  button.textContent = error.target === "knowledge" ? (english ? "Initialize knowledge" : "去初始化")
    : error.target === "models" ? (english ? "Set up a model" : "去设置模型") : (english ? "Open conversation" : "打开对话栏");
  content.append(button);
  const notice = new Notice(content, 15000);
  button.onclick = event => {
    event.stopPropagation(); button.disabled = true;
    void (error.target === "knowledge" ? plugin.openWorkbenchSetup("knowledge")
      : error.target === "models" ? plugin.openWorkbenchSetup("models") : plugin.activateView())
      .then(() => notice.hide()).catch(reason => { button.disabled = false; showWorkbenchActionFailure(plugin, reason); });
  };
}

import type EchoInkMobilePlugin from "../../src/mobile/plugin";
import { MobileWorkspace, MOBILE_VIEW, MOBILE_SETTINGS_VIEW } from "../../src/mobile/workspace";
import { VIEW_TYPE_ECHOINK_HOME } from "../../src/home/view-type";
import { IPAD_SHELL_HOME_VIEW, IPAD_SHELL_AGENT_VIEW, IPAD_SHELL_SETTINGS_VIEW } from "../../src/mobile/shell-workspace";
import { LIFE_VIEW_TYPES } from "../../src/lifestyle/view";

/** Synthetic leaves exercise the production registration, navigation and ItemViews. */
export function mobileWorkspaceFixture(plugin: EchoInkMobilePlugin, containers: { chat: HTMLElement; home: HTMLElement; settings: HTMLElement }, tablet: boolean, legacy = false) {
  const workspace = plugin.app.workspace as any;
  const rootSplit = {}, rightSplit = {}, leaves: any[] = [], factories = new Map<string, (leaf: any) => any>();
  let active: any;
  const makeLeaf = (root: object) => {
    const leaf: any = { app: plugin.app, containerEl: containers.chat, contentEl: containers.chat, view: { getViewType: () => "empty" },
      getRoot: () => root, getViewState: () => ({ type: leaf.view.getViewType(), state: leaf.file ? { file: leaf.file.path } : {} }),
      async setViewState(state: { type: string }) {
        const element = state.type === MOBILE_SETTINGS_VIEW || state.type === IPAD_SHELL_SETTINGS_VIEW ? containers.settings : state.type === VIEW_TYPE_ECHOINK_HOME || state.type === IPAD_SHELL_HOME_VIEW || state.type === LIFE_VIEW_TYPES.finance ? containers.home : containers.chat;
        leaf.containerEl = leaf.contentEl = element;
        leaf.view = factories.get(state.type)?.(leaf) ?? { getViewType: () => state.type };
        // Native setViewState can finish before the async ItemView.onOpen body.
        leaf.opening = Promise.resolve(leaf.view.onOpen?.());
        void leaf.opening.catch(() => {});
      },
      restoreDeferred(type: string) { leaf.deferredType = type; leaf.view = { getViewType: () => type }; },
      async loadIfDeferred() {
        leaf.loads = (leaf.loads ?? 0) + 1;
        if (leaf.deferredType) { const type = leaf.deferredType; delete leaf.deferredType; await leaf.setViewState({ type }); }
      },
      async openFile(file: { path: string }) {
        leaf.file = file; leaf.view = { getViewType: () => "markdown" };
        const element = containers.home.ownerDocument.createElement("article");
        element.className = "fixture-note"; element.textContent = file.path; element.hidden = false;
        containers.home.parentElement!.append(element); leaf.containerEl = leaf.contentEl = element;
        workspace.trigger("file-open", file);
      },
      async detach() { await leaf.view.onClose?.(); leaves.splice(leaves.indexOf(leaf), 1); leaf.containerEl.hidden = true; }
    }; leaves.push(leaf); return leaf;
  };
  Object.assign(workspace, { rootSplit, rightSplit, registerView: (type: string, factory: (leaf: any) => any) => factories.set(type, factory),
    iterateAllLeaves: (callback: (leaf: any) => void) => leaves.forEach(callback),
    getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.view.getViewType() === type),
    getLeaf: () => makeLeaf(rootSplit), getRightLeaf: () => makeLeaf(rightSplit),
    setActiveLeaf: (leaf: any) => { void workspace.revealLeaf(leaf); },
    async revealLeaf(leaf: any) {
      if (leaf.deferredType) await leaf.loadIfDeferred();
      active = leaf;
      if (leaf.getRoot() === rootSplit) {
        for (const other of leaves) if (other.getRoot() === rootSplit && other.containerEl !== leaf.containerEl) other.containerEl.hidden = true;
        containers.home.hidden = leaf.containerEl !== containers.home; containers.settings.hidden = leaf.containerEl !== containers.settings;
        if (!tablet) containers.chat.hidden = true;
      } else if (!tablet) { containers.home.hidden = containers.settings.hidden = true; }
      leaf.containerEl.hidden = false;
      if (tablet && leaf.getRoot() === rightSplit) document.body.classList.add("fixture-sidebar-open");
      workspace.trigger("active-leaf-change", leaf);
    }
  });
  plugin.navigation = new MobileWorkspace(workspace, tablet); plugin.registerWorkspaceViews();
  if (legacy) {
    plugin.navigation = new MobileWorkspace(workspace, tablet);
    const current = plugin.showPage.bind(plugin);
    plugin.showPage = async page => {
      if (!tablet) return current(page);
      const leaf = await plugin.navigation.openSettings();
      (leaf.view as { showPage(page: string): void }).showPage(page);
    };
  }
  return { leaves, get active() { return active; }, restoreDeferredSettings() { const leaf = makeLeaf(rootSplit); leaf.restoreDeferred(MOBILE_SETTINGS_VIEW); return leaf; }, async closeSettings() { for (const type of [MOBILE_SETTINGS_VIEW, IPAD_SHELL_SETTINGS_VIEW]) for (const leaf of workspace.getLeavesOfType(type)) await leaf.detach(); await plugin.navigation.openHome(); },
    async dispose() { for (const leaf of [...leaves]) await leaf.detach(); plugin.workbench?.dispose(); plugin.ipadNavigation?.dispose(); plugin.iphoneNavigation?.dispose(); }, chatType: tablet ? IPAD_SHELL_AGENT_VIEW : MOBILE_VIEW };
}

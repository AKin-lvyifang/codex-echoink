import type EchoInkMobilePlugin from "../../src/mobile/plugin";
import { MobileWorkspace, MOBILE_VIEW, MOBILE_SETTINGS_VIEW } from "../../src/mobile/workspace";
import { VIEW_TYPE_ECHOINK_HOME } from "../../src/home/view-type";
import { LIFE_VIEW_TYPES } from "../../src/lifestyle/view";

/** Synthetic leaves exercise the production registration, navigation and ItemViews. */
export function mobileWorkspaceFixture(plugin: EchoInkMobilePlugin, containers: { chat: HTMLElement; home: HTMLElement; settings: HTMLElement }, tablet: boolean) {
  const workspace = plugin.app.workspace as any;
  const rootSplit = {}, rightSplit = {}, leaves: any[] = [], factories = new Map<string, (leaf: any) => any>();
  let active: any;
  const makeLeaf = (root: object) => {
    const leaf: any = { app: plugin.app, containerEl: containers.chat, contentEl: containers.chat, view: { getViewType: () => "empty" },
      getRoot: () => root, getViewState: () => ({ type: leaf.view.getViewType(), state: {} }),
      async setViewState(state: { type: string }) {
        const element = state.type === MOBILE_SETTINGS_VIEW ? containers.settings : state.type === VIEW_TYPE_ECHOINK_HOME || state.type === LIFE_VIEW_TYPES.finance ? containers.home : containers.chat;
        leaf.containerEl = leaf.contentEl = element;
        leaf.view = factories.get(state.type)?.(leaf) ?? { getViewType: () => state.type };
        await leaf.view.onOpen?.();
      },
      restoreDeferred(type: string) { leaf.deferredType = type; leaf.view = { getViewType: () => type }; },
      async openFile(file: { path: string }) { workspace.trigger("file-open", file); },
      async detach() { await leaf.view.onClose?.(); leaves.splice(leaves.indexOf(leaf), 1); leaf.containerEl.hidden = true; }
    }; leaves.push(leaf); return leaf;
  };
  Object.assign(workspace, { rootSplit, rightSplit, registerView: (type: string, factory: (leaf: any) => any) => factories.set(type, factory),
    iterateAllLeaves: (callback: (leaf: any) => void) => leaves.forEach(callback),
    getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.view.getViewType() === type),
    getLeaf: () => makeLeaf(rootSplit), getRightLeaf: () => makeLeaf(rightSplit),
    setActiveLeaf: (leaf: any) => { void workspace.revealLeaf(leaf); },
    async revealLeaf(leaf: any) {
      if (leaf.deferredType) { const type = leaf.deferredType; delete leaf.deferredType; await Promise.resolve(); await leaf.setViewState({ type }); }
      active = leaf;
      if (leaf.getRoot() === rootSplit) {
        containers.home.hidden = leaf.containerEl !== containers.home; containers.settings.hidden = leaf.containerEl !== containers.settings;
        if (!tablet) containers.chat.hidden = true;
      } else if (!tablet) { containers.home.hidden = containers.settings.hidden = true; }
      leaf.containerEl.hidden = false;
      workspace.trigger("active-leaf-change", leaf);
    }
  });
  plugin.navigation = new MobileWorkspace(workspace, tablet); plugin.registerWorkspaceViews();
  return { leaves, get active() { return active; }, restoreDeferredSettings() { const leaf = makeLeaf(rootSplit); leaf.restoreDeferred(MOBILE_SETTINGS_VIEW); return leaf; }, async closeSettings() { for (const leaf of workspace.getLeavesOfType(MOBILE_SETTINGS_VIEW)) await leaf.detach(); await plugin.navigation.openHome(); },
    async dispose() { for (const leaf of [...leaves]) await leaf.detach(); }, chatType: MOBILE_VIEW };
}

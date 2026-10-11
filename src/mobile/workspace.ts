import type { TFile, Workspace, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_ECHOINK_HOME } from "../home/view-type";

export const MOBILE_VIEW = "echoink-mobile";

/** Explicit navigation only: the host owns sidebar pinning, drawers and splits. */
export class MobileWorkspace {
  private reader?: { leaf: WorkspaceLeaf; path: string };
  private pending: Promise<void> = Promise.resolve();
  constructor(private workspace: Workspace, private isTablet: boolean) {}
  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.pending.catch(() => {}).then(action); this.pending = next; return next;
  }
  private center(): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.workspace.iterateAllLeaves(leaf => { if (leaf.getRoot() === this.workspace.rootSplit) leaves.push(leaf); });
    return leaves;
  }
  private path(leaf: WorkspaceLeaf): string | undefined {
    return leaf.view.getViewType() === "markdown" ? leaf.getViewState().state?.file as string | undefined : undefined;
  }
  open(): Promise<void> {
    return this.serial(async () => {
      const existing = this.workspace.getLeavesOfType(MOBILE_VIEW);
      let leaf = existing.find(item => !this.isTablet || item.getRoot() === this.workspace.rightSplit);
      if (!leaf) {
        leaf = this.isTablet ? this.workspace.getRightLeaf(false) ?? undefined : this.workspace.getLeaf("tab");
        if (!leaf) throw new Error("无法创建 EchoInk 原生右侧栏。");
        await leaf.setViewState({ type: MOBILE_VIEW, active: true });
        // Migrate only legacy EchoInk chat tabs, after the new view is ready.
        for (const old of existing) if (this.isTablet && old !== leaf && old.getRoot() === this.workspace.rootSplit) old.detach();
      }
      await this.workspace.revealLeaf(leaf);
    });
  }
  openHome(): Promise<void> {
    return this.serial(async () => {
      let leaf = this.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME).find(item => item.getRoot() === this.workspace.rootSplit);
      if (!leaf) { leaf = this.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE_ECHOINK_HOME, active: true }); }
      await this.workspace.revealLeaf(leaf);
    });
  }
  openNote(file: TFile, _conversation?: WorkspaceLeaf): Promise<void> {
    return this.serial(async () => {
      const center = this.center();
      let leaf = center.find(item => this.path(item) === file.path);
      if (!leaf && this.reader && center.includes(this.reader.leaf) && !this.reader.leaf.getViewState().pinned && this.path(this.reader.leaf) === this.reader.path) leaf = this.reader.leaf;
      if (!leaf) leaf = this.workspace.getLeaf("tab");
      if (this.path(leaf) !== file.path) await leaf.openFile(file, { active: true });
      this.reader = { leaf, path: file.path };
      await this.workspace.revealLeaf(leaf);
    });
  }
}

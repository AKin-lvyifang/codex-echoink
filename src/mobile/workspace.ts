import type { TFile, Workspace, WorkspaceLeaf } from "obsidian";

export const MOBILE_VIEW = "echoink-mobile";
const SPLIT_MIN_WIDTH = 820;

/** Only explicit navigation creates panes; resizing never changes host layout. */
export class MobileWorkspace {
  private paired?: { leaf: WorkspaceLeaf; path: string };
  private pending: Promise<void> = Promise.resolve();
  constructor(private workspace: Workspace, private isTablet: boolean) {}

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.pending.catch(() => {}).then(action);
    this.pending = next;
    return next;
  }
  private leaves(): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.workspace.iterateAllLeaves(leaf => { if (leaf.getRoot() === this.workspace.rootSplit) leaves.push(leaf); });
    return leaves;
  }
  private wide(leaf: WorkspaceLeaf): boolean {
    // A wide window may already contain narrow panes. Only split the actual view.
    return this.isTablet && leaf.view.containerEl.clientWidth >= SPLIT_MIN_WIDTH;
  }
  private path(leaf: WorkspaceLeaf): string | undefined {
    return leaf.view.getViewType() === "markdown" ? leaf.getViewState().state?.file as string | undefined : undefined;
  }
  open(): Promise<void> {
    return this.serial(async () => {
      // Do not reset an existing ItemView: it owns the draft, focus and request.
      let leaf = this.workspace.getLeavesOfType(MOBILE_VIEW)[0];
      const current = this.workspace.getMostRecentLeaf(this.workspace.rootSplit);
      const path = current && this.path(current);
      if (!leaf) {
        if (current && path && this.wide(current)) {
          leaf = this.workspace.createLeafBySplit(current, "vertical");
          this.paired = { leaf: current, path };
        } else leaf = this.workspace.getLeaf("tab");
        await leaf.setViewState({ type: MOBILE_VIEW, active: true });
      } else if (current && path && current.parent === leaf.parent && this.wide(current)) {
        // A conversation opened in a narrow tab can later become a wide pair.
        const leaves = this.leaves();
        let reader = leaves.find(item => item.parent !== leaf.parent && this.path(item) === path);
        if (!reader && this.paired && leaves.includes(this.paired.leaf) && this.paired.leaf.parent !== leaf.parent
          && !this.paired.leaf.getViewState().pinned && this.path(this.paired.leaf) === this.paired.path) reader = this.paired.leaf;
        if (!reader) reader = this.workspace.createLeafBySplit(leaf, "vertical", true);
        if (this.path(reader) !== path) await reader.setViewState({ ...current.getViewState(), pinned: false, active: true });
        this.paired = { leaf: reader, path };
      }
      await this.workspace.revealLeaf(leaf);
    });
  }
  openNote(file: TFile, conversation: WorkspaceLeaf): Promise<void> {
    return this.serial(async () => {
      const leaves = this.leaves();
      const wide = this.wide(conversation);
      const beside = (leaf: WorkspaceLeaf) => leaf !== conversation && leaf.parent !== conversation.parent;
      let reader = leaves.find(leaf => this.path(leaf) === file.path && beside(leaf));
      if (!reader && !wide) reader = leaves.find(leaf => this.path(leaf) === file.path);
      if (!reader && this.paired && leaves.includes(this.paired.leaf)
        && (!wide || beside(this.paired.leaf)) && !this.paired.leaf.getViewState().pinned && this.path(this.paired.leaf) === this.paired.path) reader = this.paired.leaf;
      if (!reader) reader = wide && leaves.includes(conversation)
        ? this.workspace.createLeafBySplit(conversation, "vertical", true)
        : this.workspace.getLeaf("tab");
      if (this.path(reader) !== file.path) await reader.openFile(file, { active: true });
      this.paired = { leaf: reader, path: file.path };
      await this.workspace.revealLeaf(reader);
    });
  }
}

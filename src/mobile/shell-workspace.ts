import type { TFile, Workspace, WorkspaceLeaf } from "obsidian";

/** Not registered by the production plugin until the corresponding page ships. */
export const IPHONE_SHELL_VIEW = "echoink-iphone-shell";
export const IPAD_SHELL_HOME_VIEW = "echoink-ipad-workbench-shell";
export const IPAD_SHELL_AGENT_VIEW = "echoink-ipad-agent-shell";
export const IPAD_SHELL_SETTINGS_VIEW = "echoink-ipad-settings-shell";

/** Serializes host leaf creation, not page rendering or Agent execution. */
class ShellLeafQueue {
  private pending: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(protected readonly workspace: Workspace) {}

  protected serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(async () => {
      if (this.disposed) throw new Error("页面已经关闭。");
      return action();
    });
    this.pending = next;
    return next;
  }

  protected async reveal(leaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    if (!this.disposed) await this.workspace.revealLeaf(leaf);
    return leaf;
  }

  protected async center(type: string): Promise<WorkspaceLeaf> {
    let leaf = this.workspace.getLeavesOfType(type).find(candidate => candidate.getRoot() === this.workspace.rootSplit);
    if (!leaf) {
      leaf = this.workspace.getLeaf("tab");
      await leaf.setViewState({ type, active: true });
    }
    return this.reveal(leaf);
  }

  protected async note(file: TFile): Promise<WorkspaceLeaf> {
    let existing: WorkspaceLeaf | undefined;
    this.workspace.iterateAllLeaves(leaf => {
      if (leaf.getRoot() === this.workspace.rootSplit && leaf.view.getViewType() === "markdown"
        && leaf.getViewState().state?.file === file.path) existing ??= leaf;
    });
    const leaf = existing ?? this.workspace.getLeaf("tab");
    if (!existing) await leaf.openFile(file, { active: true });
    return this.reveal(leaf);
  }

  dispose(): void { this.disposed = true; }
}

export class IPhoneShellWorkspace extends ShellLeafQueue {
  open(): Promise<WorkspaceLeaf> { return this.serial(() => this.center(IPHONE_SHELL_VIEW)); }
  openNote(file: TFile): Promise<WorkspaceLeaf> { return this.serial(() => this.note(file)); }
}

export class IPadShellWorkspace extends ShellLeafQueue {
  openHome(): Promise<WorkspaceLeaf> { return this.serial(() => this.center(IPAD_SHELL_HOME_VIEW)); }
  openSettings(): Promise<WorkspaceLeaf> { return this.serial(() => this.center(IPAD_SHELL_SETTINGS_VIEW)); }
  openAgent(): Promise<WorkspaceLeaf> {
    return this.serial(async () => {
      let leaf = this.workspace.getLeavesOfType(IPAD_SHELL_AGENT_VIEW)
        .find(candidate => candidate.getRoot() === this.workspace.rightSplit);
      if (!leaf) {
        leaf = this.workspace.getRightLeaf(false) ?? undefined;
        if (!leaf) throw new Error("无法创建 EchoInk 原生右侧栏。");
        await leaf.setViewState({ type: IPAD_SHELL_AGENT_VIEW, active: true });
      }
      return this.reveal(leaf);
    });
  }
  openNote(file: TFile): Promise<WorkspaceLeaf> { return this.serial(() => this.note(file)); }
}

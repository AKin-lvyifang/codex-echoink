import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { createOriginButton, createOriginInput, disposeOriginControls } from "../../settings/origin-controls";
import { renderAnimateIcon } from "../../ui/animate-icon";
import { ForegroundView } from "../../ui/foreground-view";
import { MemoryMapRenderer } from "./memory-map-renderer";
import { renderMemoryPanel, type MemoryPanelActions, type MemoryPanelState } from "./memory-panel";
import type { MemoryPagePort, MemoryPageRequest, MemoryPageSnapshot } from "./memory-page-types";
export const MEMORY_PAGE_VIEW_TYPE = "echoink-memory-page";
/** Coordinates one read port and existing user-control transactions; renderers never own I/O. */
export class MemoryPageView extends ItemView {
  private port: MemoryPagePort;
  private snapshot: MemoryPageSnapshot | null = null;
  private request: MemoryPageRequest = {};
  private state: MemoryPanelState = { mode: "overview" };
  private map: MemoryMapRenderer | null = null;
  private panel!: HTMLElement;
  private status!: HTMLElement;
  private canvas!: HTMLElement;
  private search!: HTMLInputElement;
  private foreground: ForegroundView | null = null;
  private resize: ResizeObserver | null = null;
  private summary!: HTMLElement;
  private back!: HTMLButtonElement;
  private generation = 0;
  private closed = true;
  private busy = false;
  private error = "";
  private forgottenId: string | null = null;
  private readonly actions: MemoryPanelActions;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.port = plugin.createMemoryPagePort(() => this.request.receipt);
    this.actions = {
      overview: () => {
        this.state = { mode: this.summaryMode() };
        this.draw();
      },
      select: id => {
        this.state = { mode: "detail", id };
        this.draw();
      },
      layer: layer => {
        this.state = { mode: "list", layer };
        this.draw();
      },
      profile: key => {
        this.state = { mode: "profile", profileKey: key };
        this.draw();
      },
      edit: () => {
        const star = this.current();
        if (star) {
          this.state = { mode: "detail", id: star.id, editing: true, title: star.title, content: star.content };
          this.draw();
        }
      },
      cancelEdit: () => {
        this.state = { mode: "detail", id: this.state.id };
        this.draw();
      },
      draft: (field, value) => {
        this.state[field] = value;
      },
      save: () => void this.mutate(async () => {
        const star = this.current()!;
        const title = this.state.title?.trim() ?? "";
        const content = this.state.content?.trim() ?? "";
        if (!title || !content)
          throw new Error(this.t("标题和正文不能为空。", "Title and content are required."));
        const id = await this.port.correct(star.id, title, content, this.snapshot!.revision);
        this.state = { mode: "detail", id };
        return this.t("记忆已修正", "Memory corrected");
      }),
      pin: () => void this.mutate(async () => {
        const star = this.current()!;
        await this.port.pin(star.id, !star.pinned, this.snapshot!.revision);
        return star.pinned ? this.t("已取消固定", "Memory unpinned") : this.t("已固定到核心", "Pinned to core");
      }),
      restore: () => void this.mutate(async () => {
        await this.port.restore(this.current()!.id);
        return this.t("记忆已恢复", "Memory restored");
      }),
      confirmForget: confirm => {
        this.state.confirmForget = confirm;
        this.draw();
      },
      forget: () => void this.mutate(async () => {
        const id = this.current()!.id;
        await this.port.forget(id, this.snapshot!.revision);
        this.forgottenId = id;
        this.state = { mode: "overview" };
        return this.t("已忘记，可撤销", "Memory forgotten; undo is available");
      }),
      saveProfile: () => void this.mutate(async () => {
        const item = this.snapshot!.profile.find(item => item.profileKey === this.state.profileKey)!;
        await this.port.saveProfile(item.profileKey, this.state.profileText ?? item.text, this.snapshot!.revision);
        this.state.profileText = undefined;
        return this.t("画像已保存", "Profile saved");
      }),
      deleteProfile: () => void this.mutate(async () => {
        await this.port.deleteProfile(this.state.profileKey!, this.snapshot!.revision);
        this.state = { mode: "profile" };
        return this.t("画像已删除", "Profile item deleted");
      }),
      confirmProfileDelete: confirm => {
        this.state.confirmProfileDelete = confirm;
        this.draw();
      },
      source: source => void this.navigate(() => this.port.source(source))
    };
  }
  getViewType(): string {
    return MEMORY_PAGE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.t("记忆", "Memory");
  }
  getIcon(): string {
    return "brain";
  }
  private t(zh: string, en: string): string {
    return this.plugin.settings.settingsLanguage === "en" ? en : zh;
  }
  private current() {
    return this.snapshot?.stars.find(star => star.id === this.state.id);
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-memory-page");
    this.shell();
    this.foreground = new ForegroundView(this, active => {
      if (active && !this.busy && !this.editing())
        void this.refresh();
    });
    const window = this.contentEl.ownerDocument.defaultView!;
    this.resize = new window.ResizeObserver(() => this.contentEl.toggleClass("is-stacked", this.contentEl.clientWidth <= 760));
    this.resize.observe(this.contentEl);
    this.registerInterval(window.setInterval(() => {
      if (this.foreground?.isActive() && !this.busy && !this.editing())
        void this.refresh();
    }, 60000));
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.map?.dispose();
    this.map = null;
    this.resize?.disconnect();
    this.resize = null;
    this.foreground?.dispose();
    this.foreground = null;
    disposeOriginControls(this.contentEl);
  }
  openPage(request: MemoryPageRequest = {}): void {
    this.request = request;
    this.state = { mode: request.receipt ? "receipt" : request.query ? "search" : "overview" };
    if (this.search)
      this.search.value = request.query ?? "";
    if (!this.closed)
      void this.refresh();
  }
  refreshIfSettingsChanged(): void {
    if (!this.editing())
      void this.refresh();
  }
  refreshLanguage(): void {
    if (this.closed)
      return;
    this.map?.dispose();
    disposeOriginControls(this.contentEl);
    this.shell();
    void this.refresh();
  }
  private summaryMode(): MemoryPanelState["mode"] {
    if (this.request.query)
      return "search";
    return this.request.receipt ? "receipt" : "overview";
  }
  private editing(): boolean {
    return this.state.editing === true || this.state.profileText !== undefined;
  }
  private shell(): void {
    this.contentEl.empty();
    const page = this.contentEl.createDiv({ cls: "memory-page-content" });
    const header = page.createDiv({ cls: "memory-page-header" });
    const title = header.createDiv({ cls: "memory-page-title" });
    this.back = createOriginButton(title, { cls: "memory-button is-icon", attr: { "aria-label": this.t("返回", "Back") } });
    setIcon(this.back, "arrow-left");
    this.back.onclick = () => void this.navigate(() => this.port.back());
    title.createEl("h1", { text: this.t("记忆", "Memory") });
    const search = header.createEl("form", { cls: "memory-search", attr: { role: "search" } });
    setIcon(search.createSpan({ cls: "memory-search-icon" }), "search");
    this.search = createOriginInput(search, { attr: { placeholder: this.t("问一句，看会想起什么", "Ask what you would recall"), "aria-label": this.t("记忆搜索预演", "Preview memory recall"), type: "search" }, value: this.request.query ?? "" });
    search.onsubmit = event => {
      event.preventDefault();
      this.request = { query: this.search.value.trim(), receipt: this.request.receipt };
      this.state = { mode: this.request.query ? "search" : "overview" };
      void this.refresh();
    };
    this.status = page.createDiv({ cls: "memory-page-status", attr: { "aria-live": "polite" } });
    const columns = page.createDiv({ cls: "memory-page-columns" });
    const mapColumn = columns.createDiv({ cls: "memory-map-column" });
    this.summary = mapColumn.createDiv({ cls: "memory-recall-summary" });
    this.canvas = mapColumn.createDiv({ cls: "memory-page-canvas" });
    this.panel = columns.createDiv({ cls: "memory-page-panel" });
    this.map = new MemoryMapRenderer(this.canvas, { select: this.actions.select, profile: () => this.actions.profile(), layer: this.actions.layer, category: category => {
        this.state = { mode: "list", category };
        this.draw();
      } });
  }
  async refresh(): Promise<void> {
    if (this.closed)
      return;
    const generation = ++this.generation;
    if (!this.snapshot)
      this.status.setText(this.t("正在读取记忆…", "Reading memories…"));
    try {
      const snapshot = await this.port.query(this.request);
      if (this.closed || generation !== this.generation)
        return;
      this.snapshot = snapshot;
      this.error = "";
      this.draw();
    }
    catch (error) {
      if (this.closed || generation !== this.generation)
        return;
      this.error = error instanceof Error ? error.message : String(error);
      this.draw(true);
    }
  }
  private draw(failed = false): void {
    if (this.closed)
      return;
    disposeOriginControls(this.status);
    this.status.empty();
    if (this.error) {
      this.status.createSpan({ cls: "memory-error", text: `${this.t("读取或保存记忆失败", "Memory could not be read or saved")}：${this.error}` });
      const retry = createOriginButton(this.status, { text: this.t("重试", "Retry"), cls: "memory-button is-secondary" });
      retry.onclick = () => void this.refresh();
    }
    this.canvas.hidden = failed;
    this.panel.hidden = failed;
    if (failed || !this.snapshot)
      return;
    if (!this.snapshot.enabled)
      this.status.createDiv({ cls: "memory-disabled", text: this.t("长期记忆已停用，已有内容仍可查看和修正。", "Long-term memory is disabled. Existing memories can still be viewed and corrected.") });
    if (this.forgottenId) {
      const undo = createOriginButton(this.status, { text: this.t("已忘记 · 撤销", "Forgotten · Undo"), cls: "memory-button is-tertiary" });
      undo.disabled = this.busy;
      undo.onclick = () => void this.mutate(async () => {
        const id = this.forgottenId!;
        await this.port.undoForget(id, this.snapshot!.revision);
        this.forgottenId = null;
        this.state = { mode: "detail", id };
        return this.t("已恢复", "Restored");
      });
    }
    this.drawSummary();
    let highlighted: readonly string[] | undefined;
    let connections: readonly string[] = [];
    if (this.state.mode === "detail" && this.state.id)
      highlighted = [this.state.id];
    else if (this.state.mode === "list")
      highlighted = this.snapshot.stars.filter(star => this.state.layer ? star.layer === this.state.layer : star.category === this.state.category).map(star => star.id);
    else if (this.state.mode === "profile" && this.state.profileKey)
      connections = highlighted = this.snapshot.profile.find(item => item.profileKey === this.state.profileKey)?.sourceMemoryIds ?? [];
    else if (this.state.mode === "search")
      connections = highlighted = this.snapshot.preview?.recalled ?? [];
    else if (this.state.mode === "receipt")
      connections = highlighted = this.snapshot.receipt?.sources.map(source => source.id) ?? [];
    this.map?.update(this.snapshot, { selectedId: this.state.mode === "detail" ? this.state.id : undefined, highlightIds: highlighted, connectionIds: connections, showClues: this.state.mode === "detail", language: this.plugin.settings.settingsLanguage });
    renderMemoryPanel(this.panel, this.snapshot, this.state, this.actions, this.busy, this.plugin.settings.settingsLanguage);
  }
  private drawSummary(): void {
    disposeOriginControls(this.summary);
    this.summary.empty();
    this.summary.hidden = !["search", "receipt"].includes(this.state.mode);
    this.back.setAttribute("aria-label", this.request.receipt ? this.t("回到对话", "Back to conversation") : this.t("返回", "Back"));
    if (this.summary.hidden || !this.snapshot)
      return;
    const receipt = this.state.mode === "receipt" ? this.snapshot.receipt : undefined;
    const question = receipt ? receipt.question : this.snapshot.preview?.query;
    const count = receipt ? receipt.sources.length : this.snapshot.preview?.recalled.length ?? 0;
    renderAnimateIcon(this.summary.createSpan({ cls: "memory-summary-icon", attr: { "aria-hidden": "true" } }), "brain");
    this.summary.createSpan({ cls: "memory-summary-question", text: question ? `“${question}”` : "" });
    this.summary.createSpan({ cls: "memory-summary-count", text: this.t(`想起 ${count} 条`, `Recalled ${count}`) });
    const close = createOriginButton(this.summary, { cls: "memory-button is-icon", attr: { "aria-label": this.t("关闭想起摘要", "Close recall summary") } });
    setIcon(close, "x");
    close.onclick = () => {
      this.request = {};
      this.search.value = "";
      this.state = { mode: "overview" };
      void this.refresh();
    };
  }
  private async mutate(action: () => Promise<string>): Promise<void> {
    if (this.busy || !this.snapshot)
      return;
    this.busy = true;
    this.error = "";
    this.draw();
    try {
      const message = await action();
      if (!this.closed) {
        await this.refresh();
        new Notice(message);
      }
    }
    catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    finally {
      this.busy = false;
      if (!this.closed)
        this.draw();
    }
  }
  private async navigate(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    }
    catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}

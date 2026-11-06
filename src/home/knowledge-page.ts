import { ModuleOwnerRequired } from "../agents/registry";
import { moduleOwnerLabel } from "../ui/module-owner-modal";
import { KnowledgeCheckupPanel } from "./knowledge-checkup/panel";
import { KnowledgeMapPanel } from "./knowledge-map/panel";
import { renderKnowledgeStatistics } from "./knowledge-map/statistics";
import { ItemView, Notice, TFolder, setIcon, type EventRef, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { renderActivityHeatmap, setActivityHeatmapsActive } from "../settings/activity-heatmap";
import { knowledgeMaintenanceHistoryTitle, knowledgeMaintenanceHistoryDescription, knowledgeMaintenanceHistoryStatus, knowledgeUpgradeHistorySummary, renderKnowledgeMaintenanceHistoryList, renderKnowledgeMaintenanceRecordDetail, openKnowledgeMaintenancePath } from "../settings/knowledge-maintenance-history";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { MaintenanceUpgradePreview, MaintenanceUpgradeSnapshot, MaintenanceUpgradeSurface } from "../knowledge-base/maintenance-upgrade-contract";
import { maintenanceActivityText, maintenanceTaskStateLabel, maintenanceTaskTitle, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import { maintenancePageLabel } from "../knowledge-base/maintenance-user-copy";
import { renderMaintenanceProgressBar } from "../ui/codex-view/knowledge-linking-progress";
import { ForegroundView } from "../ui/foreground-view";
import { loadKnowledgePageData, type KnowledgePageSnapshot } from "./knowledge-page-data";
import { getWorkbenchDataService } from "./workbench-data";
import { prefillWorkbenchModule } from "./module-navigation";


export const KNOWLEDGE_PAGE_VIEW_TYPE = "echoink-knowledge-page";
type Page = "overview" | "health" | "history" | "upgrade";

/** Knowledge handoffs stay drafts; legacy upgrades write only after their preview is confirmed. */
export class KnowledgePageView extends ItemView {
  private checkupPanel: KnowledgeCheckupPanel | null = null;
  private mapPanel: KnowledgeMapPanel | null = null;
  private closed = true;
  private foreground: ForegroundView | null = null;
  private releases: Array<() => void> = [];
  private generation = 0;
  private pending = true;
  private scheduled = false;
  private settingsSignature = "";
  private snapshot: KnowledgePageSnapshot | null = null;
  private page: Page = "overview";
  private detail: KnowledgeMaintenanceRecord | null = null;
  private detailBack: Page = "history";
  private historyState = { date: "", page: 1, listScroll: 0 };
  private secondaryCleanup: (() => void) | null = null;
  private heatmapSignature = "";
  private heatmapPending = false;
  private overviewScroll = 0;
  private upgradePreview: MaintenanceUpgradePreview | null = null;
  private upgradeBusy = false;
  private upgradeError = "";
  private upgradeSignature = "";
  private upgradeListScroll = 0;
  private upgradeReadGeneration = 0;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) { super(leaf); }
  getViewType(): string { return KNOWLEDGE_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.t("知识库", "Knowledge"); }
  getIcon(): string { return "library"; }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private field(name: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-knowledge="${name}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }
  private signature(): string { return JSON.stringify([new Date().toDateString(), this.plugin.settings.settingsLanguage, this.plugin.settings.knowledgeBase, this.plugin.settings.agentRegistry]); }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-knowledge-page");
    this.renderShell();
    this.foreground = new ForegroundView(this, active => {
      if (active) { this.syncHeatmaps(); this.subscribe(); void this.refresh(); }
      else { this.syncHeatmaps(); this.unsubscribe(); this.generation++; this.pending = true; }
    });
    if (this.active()) this.subscribe();
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.checkupPanel?.dispose(); this.checkupPanel = null;
    this.closed = true; this.syncHeatmaps(); this.generation++; this.upgradeReadGeneration++; this.unsubscribe();
    this.secondaryCleanup?.(); this.secondaryCleanup = null;
    this.foreground?.dispose(); this.foreground = null;
    disposeOriginControls(this.contentEl);
  }
  private subscribe(): void {
    if (this.releases.length) return;
    const observe = (host: { offref(ref: EventRef): void }, ref: EventRef) => this.releases.push(() => host.offref(ref));
    observe(this.app.vault, this.app.vault.on("create", () => this.scheduleRefresh()));
    observe(this.app.vault, this.app.vault.on("delete", () => this.scheduleRefresh()));
    observe(this.app.vault, this.app.vault.on("rename", () => this.scheduleRefresh()));
    observe(this.app.vault, this.app.vault.on("modify", () => this.scheduleRefresh()));
    observe(this.app.metadataCache, this.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
    observe(this.app.metadataCache, this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    this.releases.push(getWorkbenchDataService(this.plugin).subscribe(() => this.scheduleRefresh()));
    const system = this.plugin.getKnowledgeSystemService();
    this.releases.push(system.subscribe(task => {
      if (task?.phase === "completed") this.scheduleRefresh();
      else this.mapPanel?.refreshActions();
    }));
    void system.ready.then(() => { if (this.active()) this.mapPanel?.refreshActions(); });
    const source = this.plugin.getKnowledgeActivitySource?.();
    if (source) this.releases.push(source.subscribe(snapshot => {
      if (snapshot.maintenance.some(activity => activity.taskKind === "upgrade")) void this.refreshUpgrade();
    }));
  }
  private unsubscribe(): void { for (const release of this.releases.splice(0)) release(); }
  private scheduleRefresh(): void {
    this.pending = true;
    if (this.scheduled || !this.active()) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (this.pending && this.active()) void this.refresh(); });
  }
  refreshIfSettingsChanged(): void { if (this.signature() !== this.settingsSignature) { this.pending = true; if (this.active()) void this.refresh(); } }
  refreshLanguage(): void { this.heatmapSignature = ""; this.refreshIfSettingsChanged(); }
  private loadSnapshot(): Promise<KnowledgePageSnapshot> { return loadKnowledgePageData(this.plugin); }
  async refresh(): Promise<void> {
    if (this.page === "health" && this.checkupPanel) { await this.checkupPanel.refresh(); return; }
    this.pending = true;
    if (!this.active()) return;
    this.pending = false;
    const generation = ++this.generation, upgradeReadGeneration = this.upgradeReadGeneration;
    this.settingsSignature = this.signature(); this.renderHeader();
    if (!this.snapshot) this.field("status").setText(this.t("正在读取知识库…", "Reading knowledge…"));
    try {
      const next = await this.loadSnapshot();
      if (this.closed || generation !== this.generation || !this.active()) return;
      if (this.snapshot && upgradeReadGeneration !== this.upgradeReadGeneration) {
        next.upgrade = this.snapshot.upgrade;
        if (this.snapshot.errors.upgrade) next.errors.upgrade = this.snapshot.errors.upgrade; else delete next.errors.upgrade;
      }
      this.snapshot = next;
      this.reset(this.field("status")); this.renderOverview(); this.renderSecondary();
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      const status = this.field("status"); this.reset(status);
      status.createSpan({ text: this.t("知识库状态暂时读不到", "Knowledge is unavailable") + `：${this.error(error)}` + (this.snapshot ? this.t(" · 尚未更新", " · Not updated") : "") });
      this.button(status, this.t("重试", "Retry"), () => this.refresh());
    }
  }
  openPage(page: Page): void {
    if (this.page === "overview" && !this.detail && page !== "overview") this.overviewScroll = this.contentEl.scrollTop;
    this.page = page; this.detail = null;
    if (!this.contentEl.querySelector('[data-knowledge="overview"]')) return;
    this.showPage(); this.renderSecondary();
    if (this.active() && (page === "overview" || !this.snapshot)) void this.refresh();
  }
  private reset(host: HTMLElement): void { disposeOriginControls(host); host.empty(); }
  private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private button(host: HTMLElement, text: string, action: () => unknown, cls = "is-tertiary"): HTMLButtonElement {
    const button = createOriginButton(host, { text, cls: `knowledge-button ${cls}` });
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          applyAmicroButton(button, { variant: cls.includes("is-primary") ? "primary" : "secondary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await Promise.resolve(result); } finally { button.disabled = false; setAmicroButtonPending(button, false); }
        }
      } catch (error) { if (error instanceof ModuleOwnerRequired) this.plugin.openModuleOwnerPicker(error.moduleId, async () => action()); else new Notice(this.error(error)); }
    };
    return button;
  }
  private renderIcon(host: HTMLElement, name: string): void { setIcon(host.createSpan({ cls: "knowledge-icon", attr: { "aria-hidden": "true" } }), name); }
  private renderShell(): void {
    this.reset(this.contentEl);
    const inner = this.contentEl.createDiv({ cls: "knowledge-inner" });
    inner.createDiv({ cls: "knowledge-status", attr: { "data-knowledge": "status", role: "status", "aria-live": "polite" } });
    const overview = inner.createDiv({ attr: { "data-knowledge": "overview" } });
    overview.createDiv({ cls: "knowledge-header", attr: { "data-knowledge": "header" } });
    const reminders = overview.createDiv({ cls: "knowledge-map-reminders", attr: { "data-knowledge": "reminders" } });
    overview.createDiv({ cls: "knowledge-upgrade-banner", attr: { "data-knowledge": "upgrade", role: "status" } });
    overview.createDiv({ cls: "knowledge-location-reminders", attr: { "data-knowledge": "locations" } });
    overview.createDiv({ cls: "knowledge-metrics", attr: { "data-knowledge": "metrics" } });
    overview.createEl("section", { cls: "knowledge-activity", attr: { "data-knowledge": "activity" } });
    const map = overview.createEl("section", { attr: { "data-knowledge": "map" } });
    this.mapPanel = new KnowledgeMapPanel(map, reminders, this.plugin, () => this.refresh());
    overview.createEl("section", { cls: "knowledge-recent", attr: { "data-knowledge": "recent" } });
    inner.createDiv({ attr: { "data-knowledge": "secondary" } });
    this.field("activity").addEventListener("focusout", () => queueMicrotask(() => { if (this.heatmapPending && !this.closed) this.renderHeatmap(); }));
    this.renderHeader(); this.showPage();
  }
  private renderHeader(): void {
    const header = this.field("header");
    if (!header.firstChild) {
      const title = header.createDiv({ cls: "knowledge-title" });
      const back = this.button(title, "", () => this.plugin.activateHomeView({ keepRightSidebar: true }), "is-icon");
      back.setAttribute("aria-label", this.t("返回工作台", "Back to workbench")); setIcon(back, "arrow-left"); title.createEl("h1");
      this.button(header, "", () => prefillWorkbenchModule(this.plugin, "knowledge-base", this.t("帮我看看知识库里有哪些值得整理的内容", "Help me review what is worth organizing in my knowledge base")), "is-primary").dataset.knowledge = "owner";
    }
    header.querySelector("h1")!.setText(this.t("知识库", "Knowledge"));
    const label = moduleOwnerLabel(this.plugin, "knowledge-base");
    this.field("owner").setText(label);
  }
  private heading(host: HTMLElement, title: string): HTMLElement { const heading = host.createDiv({ cls: "knowledge-heading" }); heading.createEl("h2", { text: title }); return heading; }
  private regionError(host: HTMLElement, message?: string): void {
    if (!message) return;
    const error = host.createDiv({ cls: "knowledge-error", attr: { role: "status" } }); error.createSpan({ text: message });
    this.button(error, this.t("重试", "Retry"), () => this.refresh());
  }
  private renderOverview(): void {
    const data = this.snapshot!;
    this.renderUpgradeBanner();
    this.mapPanel?.update(
      data.mapDomains ?? [], data.systemReminders ?? [],
      data.directories.find(directory => directory.role === "inbox")?.count ?? null,
      data.errors.system,
    );
    renderKnowledgeStatistics(
      this.field("metrics"), data, this.plugin.settings.settingsLanguage === "en",
      () => this.openPage("health"),
      () => { void this.openInbox().catch(error => new Notice(this.error(error))); },
    );
    this.renderLocations(); this.renderHeatmap(); this.renderRecent();
  }
  private upgradeService(): Partial<MaintenanceUpgradeSurface> | null { return this.plugin.getKnowledgeSurfaceService(); }
  private upgradeActivity(): Readonly<MaintenanceActivity> | undefined {
    const recordId = this.snapshot?.upgrade?.recordId;
    return this.plugin.getKnowledgeActivitySource?.()?.snapshot().maintenance
      .filter(activity => activity.taskKind === "upgrade" && (!recordId || activity.id === recordId))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  /** Activity events trigger a read of the existing upgrade state, without another timer or ledger. */
  private async refreshUpgrade(): Promise<void> {
    if (!this.active() || !this.snapshot) return;
    const read = ++this.upgradeReadGeneration;
    try {
      const upgrade = await this.upgradeService()?.getUpgradeSnapshot?.();
      if (this.closed || !this.active() || read !== this.upgradeReadGeneration || !this.snapshot) return;
      this.snapshot.upgrade = upgrade ?? null; delete this.snapshot.errors.upgrade;
    } catch (error) {
      if (this.closed || !this.active() || read !== this.upgradeReadGeneration || !this.snapshot) return;
      this.snapshot.errors.upgrade = this.error(error);
    }
    this.renderUpgradeBanner(); if (this.page === "upgrade") this.renderSecondary();
  }
  private upgradeHasWork(upgrade: MaintenanceUpgradeSnapshot): boolean {
    const counts = upgrade.counts;
    return counts.sourceStatusCount > 0 || counts.sourceLinkCount > 0 || counts.backlinkCount > 0 || counts.wikiCount > 0
      || !!upgrade.preview?.automatic.length || !!upgrade.preview?.rootAdditions.length || !!upgrade.preview?.issues.length;
  }
  private upgradeResult(upgrade: MaintenanceUpgradeSnapshot): string {
    const done = upgrade.completed;
    return done ? this.t(`已补 ${done.sources} 篇资料状态 · ${done.links} 条链接 · ${done.wiki} 页 Wiki 类型`, `${done.sources} source statuses · ${done.links} links · ${done.wiki} Wiki types added`) : "";
  }
  private renderUpgradeBanner(): void {
    const host = this.field("upgrade"), upgrade = this.snapshot?.upgrade, error = this.snapshot?.errors.upgrade;
    this.reset(host); host.hidden = !error && (!upgrade || upgrade.status === "ready" && !this.upgradeHasWork(upgrade));
    if (host.hidden) return;
    if (error || upgrade?.status === "failed" && !upgrade.recordId) {
      host.createSpan({ text: this.t("旧资料检查暂时没完成", "Legacy check is unavailable") + `：${error || upgrade?.message || this.t("请重试", "Retry")}` });
      this.button(host, this.t("重试", "Retry"), () => this.openUpgradePreview(), "is-secondary").disabled = this.upgradeBusy; return;
    }
    if (!upgrade) return;
    if (upgrade.status === "scanning") { host.createSpan({ text: this.t("正在检查旧资料…", "Checking legacy notes…") }); return; }
    if (upgrade.purpose === "checkup") {
      if (upgrade.status !== "completed") {
        host.createSpan({ text: upgrade.status === "running" ? "正在修复知识库" : "知识库修复尚未完成" });
        this.button(host, "查看修复", () => this.openPage("health"), "is-secondary");
      }
      return;
    }
    const ready = upgrade.status === "ready", activity = this.upgradeActivity();
    const additions: string[] = [];
    if (upgrade.counts.sourceStatusCount) additions.push(this.t(`${upgrade.counts.sourceStatusCount} 篇资料待补状态`, `${upgrade.counts.sourceStatusCount} sources need status`));
    if (upgrade.counts.sourceLinkCount) additions.push(this.t(`${upgrade.counts.sourceLinkCount} 篇资料待补链接`, `${upgrade.counts.sourceLinkCount} sources need links`));
    if (upgrade.counts.wikiCount) additions.push(this.t(`${upgrade.counts.wikiCount} 页 Wiki 待补类型`, `${upgrade.counts.wikiCount} Wiki notes need types`));
    const automatic = additions.length > 0 || !!upgrade.preview?.automatic.length || !!upgrade.preview?.rootAdditions.length;
    const text = ready ? additions.length ? this.t(`有 ${additions.join("，")}`, additions.join(", "))
      : upgrade.preview?.automatic.length ? this.t("有旧资料待补属性", "Legacy notes need properties")
      : upgrade.preview?.rootAdditions.length ? this.t("有旧文件夹需要接着使用", "Legacy folders are ready to reconnect")
      : this.t(`有 ${upgrade.preview?.issues.length ?? 0} 项旧资料需要核对`, `${upgrade.preview?.issues.length ?? 0} legacy items need review`)
      : upgrade.status === "completed" ? this.upgradeResult(upgrade) || this.t("旧知识升级已完成", "Legacy knowledge upgrade completed")
      : activity ? maintenanceActivityText(activity, this.plugin.settings.settingsLanguage === "en") : upgrade.message || this.t(upgrade.status === "running" ? "正在升级旧知识" : "旧知识升级没做完", upgrade.status === "running" ? "Upgrading legacy knowledge" : "Legacy upgrade is not finished");
    host.createSpan({ text });
    this.button(host, ready ? automatic ? this.t("查看并升级", "Review and upgrade") : this.t("查看清单", "Review items") : this.t("查看升级", "View upgrade"), () => ready ? this.openUpgradePreview() : this.openPage("upgrade"), "is-secondary").disabled = this.upgradeBusy;
  }
  private async openUpgradePreview(paths?: readonly string[]): Promise<void> {
    if (this.upgradeBusy) return;
    const preview = this.upgradeService()?.previewUpgrade;
    if (!preview) throw new Error(this.t("旧资料检查暂时不可用", "Legacy check is unavailable"));
    this.upgradeBusy = true; this.renderUpgradeBanner();
    try {
      const service = this.upgradeService()!;
      const next = await service.previewUpgrade!(paths);
      const upgrade = await service.getUpgradeSnapshot?.();
      if (this.closed) return;
      this.upgradePreview = next; this.upgradeError = "";
      if (this.snapshot) { this.snapshot.upgrade = upgrade ?? { status: "ready", counts: next.counts, preview: next }; delete this.snapshot.errors.upgrade; }
      this.openPage("upgrade");
    } catch (error) {
      this.upgradeError = this.error(error);
      if (this.snapshot) this.snapshot.errors.upgrade = this.upgradeError;
    } finally {
      this.upgradeBusy = false;
      if (!this.closed) { this.renderUpgradeBanner(); if (this.page === "upgrade") this.renderSecondary(); }
    }
  }
  private async upgradeAction(action: "confirm" | "stop" | "resume"): Promise<void> {
    if (this.upgradeBusy) return;
    const service = this.upgradeService(), previewId = this.upgradePreview?.id;
    if (!service || action === "confirm" && !previewId) return;
    this.upgradeBusy = true; this.upgradeError = ""; this.generation++; this.upgradeReadGeneration++;
    this.renderSecondary();
    try {
      let next: MaintenanceUpgradeSnapshot | undefined;
      if (action === "confirm") {
        if (!service.confirmUpgrade) throw new Error(this.t("升级暂时不可用", "Upgrade is unavailable"));
        next = await service.confirmUpgrade(previewId!);
      } else if (action === "resume") {
        if (!service.resumeUpgrade) throw new Error(this.t("继续升级暂时不可用", "Resume is unavailable"));
        next = await service.resumeUpgrade();
      } else {
        if (!service.stopUpgrade) throw new Error(this.t("停止升级暂时不可用", "Stop is unavailable"));
        await service.stopUpgrade(); next = await service.getUpgradeSnapshot?.();
      }
      if (!this.closed && this.snapshot && next) { this.upgradeReadGeneration++; this.snapshot.upgrade = next; delete this.snapshot.errors.upgrade; }
    } catch (error) {
      if (error instanceof ModuleOwnerRequired) this.plugin.openModuleOwnerPicker(error.moduleId, () => this.upgradeAction(action));
      else this.upgradeError = this.error(error);
    }
    finally {
      this.upgradeBusy = false;
      if (!this.closed) { this.renderUpgradeBanner(); if (this.page === "upgrade") this.renderSecondary(); }
    }
  }
  private renderUpgradePage(host: HTMLElement): void {
    const upgrade = this.snapshot?.upgrade, activity = this.upgradeActivity();
    const preview = upgrade?.recordId ? upgrade.preview ?? this.upgradePreview : this.upgradePreview ?? upgrade?.preview;
    const signature = JSON.stringify([upgrade, preview, activity, this.upgradeBusy, this.upgradeError, this.snapshot?.errors.upgrade, this.plugin.settings.settingsLanguage]);
    if (signature === this.upgradeSignature && host.querySelector(".knowledge-upgrade-page")) return;
    this.upgradeSignature = signature;
    const oldList = host.querySelector<HTMLElement>(".knowledge-upgrade-list");
    if (oldList) this.upgradeListScroll = oldList.scrollTop;
    const focused = host.contains(host.ownerDocument.activeElement) ? (host.ownerDocument.activeElement as HTMLElement)?.dataset.upgradeAction : undefined;
    this.secondaryCleanup?.(); this.secondaryCleanup = null; this.reset(host);
    const page = host.createDiv({ cls: "knowledge-upgrade-page" });
    this.button(page, this.t("返回知识库", "Back to knowledge"), () => this.openPage("overview")).dataset.upgradeAction = "back";
    page.createEl("h1", { text: this.t("知识库升级检查", "Legacy knowledge upgrade") });
    const showingPreview = preview && (!upgrade || upgrade.status === "ready" || upgrade.status === "scanning" || upgrade.status === "failed" && !upgrade.recordId);
    if (showingPreview) {
      page.createEl("p", { cls: "knowledge-upgrade-intro", text: this.t("确认后会补上资料状态、Wiki 类型和资料指向 Wiki 的链接。原文、已有属性和旧报告都不改。", "Confirmation adds source statuses, Wiki types and links from sources to Wiki notes. Original text, existing properties and old reports stay unchanged.") });
      const list = page.createDiv({ cls: "knowledge-upgrade-list", attr: { role: "region", "aria-label": this.t("升级预览清单", "Upgrade preview"), tabindex: "0" } });
      this.heading(list, this.t("会自动补的", "Automatic additions"));
      const rows = list.createDiv({ cls: "knowledge-upgrade-rows" });
      const titleCounts = new Map<string, number>();
      for (const item of preview.automatic) titleCounts.set(item.title, (titleCounts.get(item.title) ?? 0) + 1);
      for (const item of preview.automatic) {
        const row = rows.createDiv({ cls: "knowledge-upgrade-row" });
        row.createEl("strong", { text: maintenancePageLabel(item.title) });
        if (item.path && (titleCounts.get(item.title) ?? 0) > 1) row.createDiv({ cls: "knowledge-upgrade-location", text: this.t(`位置：${item.path}`, `Location: ${item.path}`) });
        for (const property of item.properties) row.createDiv({ text: property });
        if (item.description) row.createDiv({ text: item.description });
      }
      if (!preview.automatic.length) rows.createDiv({ cls: "knowledge-empty", text: this.t("没有需要自动补的属性", "No properties need adding") });
      if (preview.rootAdditions.length) {
        this.heading(list, this.t("会继续使用的旧文件夹", "Legacy folders to keep using"));
        const roots = list.createDiv({ cls: "knowledge-upgrade-rows" });
        for (const root of preview.rootAdditions) {
          const role = root.role === "outputs" ? this.t("旧维护报告", "Legacy reports") : this.roleLabel(root.role);
          roots.createDiv({ cls: "knowledge-upgrade-row", text: `${root.path} · ${role}` });
        }
      }
      this.heading(list, this.t("需要你看的清单", "Items to review"));
      for (const item of preview.issues) {
        const row = list.createDiv({ cls: "knowledge-upgrade-issue" });
        row.createDiv({ text: `${item.title || item.path ? `${maintenancePageLabel(item.title || item.path!)}：` : ""}${item.message}` });
      }
      if (!preview.issues.length) list.createDiv({ cls: "knowledge-empty", text: this.t("没有需要你核对的项目", "No items need review") });
      list.scrollTop = this.upgradeListScroll;
      const actions = page.createDiv({ cls: "knowledge-upgrade-actions" });
      this.button(actions, this.t("暂不升级", "Not now"), () => this.openPage("overview"), "is-secondary").dataset.upgradeAction = "cancel";
      const confirm = this.button(actions, this.t("确认升级", "Confirm upgrade"), () => this.upgradeAction("confirm"), "is-primary"); confirm.dataset.upgradeAction = "confirm";
      confirm.disabled = this.upgradeBusy || !preview.automatic.length && !preview.rootAdditions.length;
      // A preview restored from the service is also the only accepted confirmation identity.
      this.upgradePreview = preview;
    } else {
      const status = page.createDiv({ cls: "knowledge-upgrade-progress", attr: { role: "status", "aria-live": "polite" } });
      status.createEl("strong", { text: activity ? `${maintenanceTaskTitle(activity, this.plugin.settings.settingsLanguage === "en")} · ${maintenanceTaskStateLabel(activity, this.plugin.settings.settingsLanguage === "en")}`
        : this.t(upgrade?.status === "completed" ? "已完成" : upgrade?.status === "running" ? "进行中" : "没做完", upgrade?.status === "completed" ? "Completed" : upgrade?.status === "running" ? "In progress" : "Not finished") });
      if (activity) { status.createDiv({ text: maintenanceActivityText(activity, this.plugin.settings.settingsLanguage === "en") }); renderMaintenanceProgressBar(status, activity); }
      const result = upgrade && this.upgradeResult(upgrade);
      if (result && activity?.status !== "completed") status.createDiv({ text: result });
      if (upgrade?.message && !activity) status.createDiv({ text: upgrade.message });
      const unfinishedIssues = preview?.issues.filter(item => item.executionFailure) ?? [];
      if (activity?.failures.length || unfinishedIssues.length) {
        const reasons = page.createEl("details", { cls: "knowledge-rules" }); reasons.createEl("summary", { text: this.t("未处理原因", "Unfinished items") });
        for (const failure of activity?.failures ?? []) reasons.createDiv({ text: failure.message });
        for (const issue of unfinishedIssues) reasons.createDiv({ text: `${maintenancePageLabel(issue.title || issue.path!)}：${issue.message}` });
      }
      const reviewIssues = preview?.issues.filter(item => !item.executionFailure) ?? [];
      if (reviewIssues.length) {
        const review = page.createEl("details", { cls: "knowledge-rules knowledge-upgrade-review" });
        review.createEl("summary", { text: this.t("需要你看的清单", "Items to review") });
        review.createEl("p", { text: this.t("下面这些资料请你再看一眼，也可以之后再整理。原文件都保留了，升级已补好的内容不受影响。", "You can review these notes now or organize them later. Original files are preserved, and completed additions are unaffected.") });
        for (const issue of reviewIssues) {
          const row = review.createDiv({ cls: "knowledge-upgrade-issue" });
          row.createDiv({ text: `${issue.title || issue.path ? `${maintenancePageLabel(issue.title || issue.path!)}：` : ""}${issue.message}` });
        }
      }
      const actions = page.createDiv({ cls: "knowledge-upgrade-actions" });
      if (upgrade?.status === "running") this.button(actions, this.t("停止", "Stop"), () => this.upgradeAction("stop"), "is-secondary").dataset.upgradeAction = "stop";
      if (upgrade?.status === "interrupted" || upgrade?.status === "failed" && upgrade.recordId) this.button(actions, this.t("继续升级", "Continue upgrade"), () => this.upgradeAction("resume"), "is-primary").dataset.upgradeAction = "resume";
    }
    const error = this.upgradeError || this.snapshot?.errors.upgrade;
    if (error) page.createDiv({ cls: "knowledge-error", attr: { role: "alert" }, text: error });
    for (const button of Array.from(page.querySelectorAll<HTMLButtonElement>("button"))) button.disabled ||= this.upgradeBusy;
    if (focused) page.querySelector<HTMLButtonElement>(`[data-upgrade-action="${focused}"]`)?.focus({ preventScroll: true });
  }
  private renderHeatmap(): void {
    const data = this.snapshot; if (!data) return;
    const host = this.field("activity");
    const signature = JSON.stringify([data.activityDays, data.errors.activity, data.weekly.unknownCreatedAtCount, this.plugin.settings.settingsLanguage]);
    if (signature === this.heatmapSignature) { this.heatmapPending = false; return; }
    const editor = host.querySelector<HTMLElement>(".activity-range-editor");
    if ((editor && !editor.hidden) || host.contains(host.ownerDocument.activeElement)) { this.heatmapPending = true; return; }
    this.heatmapPending = false; this.heatmapSignature = signature; this.reset(host);
    const heading = this.field("metrics");
    heading.querySelector(".activity-heatmap-controls")?.remove();
    heading.querySelector(".activity-heatmap-period")?.remove();
    const byDate = new Map(data.activityDays.map(day => [day.date, day]));
    const label = (date: string) => { const day = byDate.get(date); return this.t(`${date} · 新增${day?.added ?? 0}篇 · 整理${day?.organized ?? 0}次`, `${date} · ${day?.added ?? 0} added notes · ${day?.organized ?? 0} organized batches`); };
    if (!data.errors.activity) renderActivityHeatmap(host, heading, host, { days: data.activityDays.map(day => ({ date: day.date, count: day.total, label: label(day.date) })), title: this.t("新增与整理", "Additions and organization"), stateKey: "knowledgeActivity", zh: this.plugin.settings.settingsLanguage !== "en", app: this.app, label,
      summaryInFooter: true,
      summary: days => { const records = days.map(day => byDate.get(day.date)); const added = records.reduce((sum, day) => sum + (day?.added ?? 0), 0), organized = records.reduce((sum, day) => sum + (day?.organized ?? 0), 0); return this.t(`新增 ${added} 篇 · 整理 ${organized} 次`, `${added} added notes · ${organized} organized batches`); } });
    this.regionError(host, data.errors.activity);
    if (data.weekly.unknownCreatedAtCount) host.createDiv({ cls: "knowledge-note", text: this.t("部分文件创建时间未知", "Some file creation dates are unknown") });
    const footer = host.querySelector<HTMLElement>(".heatmap-footer");
    if (footer) {
      const info = this.button(footer, "", () => new Notice(this.t(
        "新增按知识笔记的创建时间；整理按已完成或核实无需改动的维护批次。复制或同步可能改变创建时间。",
        "Added notes use creation dates; organization counts completed maintenance batches. Copying can change dates.",
      )), "is-icon");
      info.setAttribute("aria-label", this.t("统计口径", "How counts work"));
      setIcon(info, "info");
    }
  }
  private roleLabel(role: string): string { const names: Record<string, [string, string]> = { raw: ["资料来源", "Sources"], wiki: ["知识成果", "Knowledge"], projects: ["项目", "Projects"], inbox: ["收件箱", "Inbox"] }; return this.t(...names[role]); }
  private directoryState(state: string): string {
    const labels: Record<string, [string, string]> = { disabled: ["未启用", "Disabled"], unbound: ["尚未设置知识库位置", "No location configured"], invalid: ["位置已失效", "Location is unavailable"], unavailable: ["位置暂时读不到", "Location cannot be read"], partial: ["部分位置尚未更新", "Some locations are not updated"] };
    return labels[state] ? this.t(...labels[state]) : "";
  }
  private renderLocations(): void {
    const host = this.field("locations");
    this.reset(host);
    const unavailable = this.snapshot!.directories.filter(directory =>
      ["unbound", "invalid", "unavailable", "partial"].includes(directory.state));
    if (!unavailable.length && this.snapshot!.bindings.roles.wiki.enabled) return;
    const row = host.createDiv({ cls: "knowledge-map-reminder" });
    row.createSpan({ cls: "knowledge-map-reminder-copy", text: unavailable.length
      ? unavailable.map(directory => `${this.roleLabel(directory.role)}${this.directoryState(directory.state)}`).join("；")
      : this.t("尚未设置知识库位置", "Choose knowledge locations") });
    this.button(row, this.t("去设置", "Settings"), () => this.plugin.openEchoInkKnowledgeSettings(), "is-secondary");
  }
  private async openInbox(): Promise<void> {
    const roots = this.snapshot?.directories.find(directory => directory.role === "inbox")?.roots
      .filter(root => root.state === "ready") ?? [];
    if (!roots.length) return this.plugin.openEchoInkKnowledgeSettings();
    await this.openFolder(this.snapshot!.bindings.roles.inbox.writePath ?? roots[0].path);
  }
  private async openFolder(path: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(path);
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    await leaf?.loadIfDeferred();
    const view = leaf?.view as { revealInFolder?: (folder: TFolder) => unknown } | undefined;
    if (!(folder instanceof TFolder) || !leaf || !view?.revealInFolder) throw new Error(this.t(`无法在文件列表中打开目录：${path}，请启用文件列表并核对位置。`, `Cannot reveal folder: ${path}. Enable the file explorer and check its location.`));
    await view.revealInFolder(folder); await this.app.workspace.revealLeaf(leaf);
  }
  private renderRecent(): void {
    const data = this.snapshot!, host = this.field("recent"); this.reset(host);
    const heading = this.heading(host, this.t("最近整理", "Recent organization"));
    this.button(heading, this.t("查看全部", "View all"), () => this.openPage("history"));
    this.regionError(host, data.errors.history);
    if (!data.maintenanceHistory.length && !data.errors.history) host.createDiv({ cls: "knowledge-empty", text: this.t("还没有整理记录", "No organization records yet") });
    for (const entry of data.maintenanceHistory.slice(0, 5)) {
      const record = data.maintenanceRecords.find(item => item.recordId === entry.recordId);
      const row = this.button(host, "", () => {
        if (record) { this.overviewScroll = this.contentEl.scrollTop; this.detail = record; this.detailBack = "overview"; this.showPage(); this.renderSecondary(); }
        else if (entry.reportPath) return this.openPath(entry.reportPath);
        else new Notice(this.t("维护记录尚未读取或已缺失", "Maintenance record is unavailable"));
      }, "is-tertiary knowledge-recent-row");
      this.renderIcon(row, "notebook-pen");
      const copy = row.createDiv({ cls: "knowledge-row-copy" }); copy.createEl("strong", { text: knowledgeMaintenanceHistoryTitle(entry, this.plugin.settings.settingsLanguage !== "en", record) });
      const added = record?.result.notes.filter(note => note.operation === "created").length ?? 0;
      const updated = record?.result.notes.filter(note => note.operation === "updated").length ?? 0;
      const summary = record?.upgrade ? knowledgeUpgradeHistorySummary(record, this.plugin.settings.settingsLanguage !== "en") : added || updated
        ? [added ? this.t(`新增 ${added} 篇`, `${added} created`) : "", updated ? this.t(`更新 ${updated} 篇`, `${updated} updated`) : ""].filter(Boolean).join(" · ")
        : record?.summary.split(/\r?\n/u)[0].replace(/Readback/giu, this.t("回读核对", "readback"));
      copy.createSpan({ cls: "knowledge-note", text: record ? `${knowledgeMaintenanceHistoryStatus(entry, this.plugin.settings.settingsLanguage !== "en", record)} · ${summary}` : knowledgeMaintenanceHistoryDescription(entry, this.plugin.settings.settingsLanguage !== "en") });
    }
  }
  private openPath(path: string): Promise<void> { return openKnowledgeMaintenancePath(this.app, path, this.plugin.settings.settingsLanguage !== "en"); }
  private showPage(): void {
    const wasHidden = this.field("overview").hidden;
    this.field("overview").hidden = this.page !== "overview" || !!this.detail;
    this.field("status").hidden = this.field("overview").hidden;
    const secondary = this.field("secondary");
    secondary.hidden = !this.field("overview").hidden;
    const legacy = (this.page === "history" || !!this.detail);
    secondary.toggleClass("echoink-settings-demo", legacy);
    secondary.toggleClass("knowledge-legacy", legacy);
    this.syncHeatmaps();
    if (wasHidden && !this.field("overview").hidden) this.contentEl.scrollTop = this.overviewScroll;
    if (!this.field("overview").hidden && this.heatmapPending) this.renderHeatmap();
  }
  private syncHeatmaps(): void {
    const overview = this.field("overview"), secondary = this.field("secondary");
    setActivityHeatmapsActive(overview, this.active() && !overview.hidden);
    setActivityHeatmapsActive(secondary, this.active() && !secondary.hidden);
  }
  private renderSecondary(): void {
    this.showPage();
    if (!this.field("overview").hidden) { this.checkupPanel?.dispose(); this.checkupPanel = null; this.secondaryCleanup?.(); this.secondaryCleanup = null; return; }
    const host = this.field("secondary"), data = this.snapshot;
    if (this.page === "health" && !this.detail) {
      if (!this.checkupPanel) {
        this.secondaryCleanup?.(); this.secondaryCleanup = null; this.reset(host);
        this.checkupPanel = new KnowledgeCheckupPanel(host, this.plugin,
          () => this.openPage("overview"), path => { void this.openUpgradePreview(path ? [path] : undefined); });
        void this.checkupPanel.refresh();
      }
      return;
    }
    this.checkupPanel?.dispose(); this.checkupPanel = null;

    if (this.page === "upgrade") { this.renderUpgradePage(host); return; }
    this.secondaryCleanup?.(); this.secondaryCleanup = null; this.reset(host);
    if (this.detail) {
      this.secondaryCleanup = renderKnowledgeMaintenanceRecordDetail(host, { zh: this.plugin.settings.settingsLanguage !== "en", record: this.detail, onBack: () => { this.detail = null; this.page = this.detailBack; this.renderSecondary(); }, onOpenPath: path => this.openPath(path) }); return;
    }
    if (this.page === "history" && data) {
      this.secondaryCleanup = renderKnowledgeMaintenanceHistoryList(host, { zh: this.plugin.settings.settingsLanguage !== "en", entries: data.maintenanceHistory, records: data.maintenanceRecords, state: this.historyState, error: data.errors.history, onBack: () => this.openPage("overview"), onChange: () => this.renderSecondary(), onSelectRecord: record => { this.detail = record; this.detailBack = "history"; this.renderSecondary(); }, onOpenPath: path => this.openPath(path), onUnavailable: () => { new Notice(this.t("维护记录尚未读取或已缺失", "Maintenance record is unavailable")); } }); return;
    }
    this.button(host, this.t("返回知识库", "Back to knowledge"), () => this.openPage("overview"));
    if (!data) { host.createDiv({ text: this.t("正在读取…", "Reading…") }); return; }

  }
}

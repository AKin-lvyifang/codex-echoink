import { setIcon } from "obsidian";
import { newId } from "../../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../../knowledge-base/dashboard";

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface KnowledgeDashboardRenderState {
  visible: boolean;
  snapshot: KnowledgeBaseDashboardSnapshot | null;
  expanded: boolean;
  loading: boolean;
  error: string;
}

export interface KnowledgeDashboardActions {
  onRefresh: () => void;
  onToggleExpanded: () => void;
  onOpenRulesFile: (snapshot: KnowledgeBaseDashboardSnapshot) => void;
}

export interface KnowledgeDashboardTooltipState {
  panels: HTMLElement[];
  tooltips: KnowledgeDashboardHealthTooltipEntry[];
  closeTimers: Set<number>;
  cleanups: Array<() => void>;
}

interface KnowledgeDashboardHealthTooltipEntry {
  wrapper: HTMLElement;
  button: HTMLButtonElement;
  panel: HTMLElement;
  bridge: HTMLElement;
  placement: "summary" | "meter";
  lastPointer: { x: number; y: number } | null;
  closeTimer?: number;
  closePanel: () => void;
  repositionOpenPanel: () => void;
  trackOpenTooltipPointer: (event: MouseEvent) => void;
  isTooltipTarget: (target: EventTarget | null) => boolean;
}

const KNOWLEDGE_DASHBOARD_HEALTH_TOOLTIP_HOVER_PADDING = 16;
const KNOWLEDGE_DASHBOARD_HEALTH_TOOLTIP_CLOSE_DELAY_MS = 360;
const KNOWLEDGE_DASHBOARD_ENERGY_CELL_COUNT = 24;
const HEATMAP_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function createKnowledgeDashboardTooltipState(): KnowledgeDashboardTooltipState {
  return {
    panels: [],
    tooltips: [],
    closeTimers: new Set<number>(),
    cleanups: []
  };
}

export function renderKnowledgeDashboardView(
  container: HTMLElement,
  state: KnowledgeDashboardRenderState,
  actions: KnowledgeDashboardActions,
  tooltipState: KnowledgeDashboardTooltipState
): void {
  clearKnowledgeDashboardHealthTooltips(tooltipState);
  container.empty();
  container.toggleClass("is-visible", state.visible);
  if (!state.visible) return;

  const snapshot = state.snapshot;
  const healthStatus = snapshot?.health.status ?? "unknown";
  const hasWarning = Boolean(state.error || healthStatus === "risk" || healthStatus === "bad" || snapshot?.warnings.length);
  container.toggleClass("has-warning", hasWarning);
  container.toggleClass("health-healthy", healthStatus === "healthy");
  container.toggleClass("health-risk", healthStatus === "risk");
  container.toggleClass("health-bad", healthStatus === "bad");
  container.toggleClass("is-loading", state.loading);

  const header = container.createDiv({ cls: "codex-kb-dashboard-header" });
  const title = header.createDiv({ cls: "codex-kb-dashboard-title" });
  const titleIcon = title.createSpan({ cls: "codex-kb-dashboard-icon" });
  setIcon(titleIcon, "database");
  title.createSpan({ text: "知识库状态" });

  const summary = header.createDiv({ cls: "codex-kb-dashboard-summary" });
  if (snapshot) {
    addKnowledgeDashboardRulesMetric(summary, snapshot, actions);
    addKnowledgeDashboardMetric(summary, "Raw", `${snapshot.raw.fileCount}`);
    addKnowledgeDashboardMetric(summary, "Wiki", `${snapshot.wiki.fileCount}`);
    addKnowledgeDashboardMetric(summary, "Inbox", `${snapshot.inbox.fileCount}`);
    addKnowledgeDashboardHealthMetric(summary, snapshot.health, tooltipState);
  } else {
    summary.createSpan({ cls: "codex-kb-dashboard-muted", text: state.error || "等待扫描" });
  }

  const dashboardActions = header.createDiv({ cls: "codex-kb-dashboard-actions" });
  const refresh = dashboardActions.createEl("button", { cls: "codex-icon-button codex-kb-dashboard-button", attr: { type: "button", title: "刷新状态", "aria-label": "刷新状态" } });
  setIcon(refresh, state.loading ? "loader-circle" : "refresh-cw");
  refresh.disabled = state.loading;
  refresh.onclick = actions.onRefresh;
  const toggleTitle = state.expanded ? "收起详情" : "展开详情";
  const toggle = dashboardActions.createEl("button", { cls: "codex-icon-button codex-kb-dashboard-button", attr: { type: "button", title: toggleTitle, "aria-label": toggleTitle } });
  setIcon(toggle, state.expanded ? "chevron-up" : "chevron-down");
  toggle.onclick = actions.onToggleExpanded;

  if (state.error) {
    container.createDiv({ cls: "codex-kb-dashboard-error", text: state.error });
  }
  if (!snapshot || !state.expanded) return;

  const details = container.createDiv({ cls: "codex-kb-dashboard-details" });
  renderKnowledgeDashboardHealth(details, snapshot, tooltipState);
  renderKnowledgeDashboardWiki(details, snapshot);
  renderKnowledgeDashboardQueues(details, snapshot);
  renderKnowledgeDashboardHeatmap(details, snapshot);
}

export function clearKnowledgeDashboardHealthTooltips(state: KnowledgeDashboardTooltipState): void {
  for (const timer of state.closeTimers) {
    window.clearTimeout(timer);
  }
  state.closeTimers.clear();
  state.tooltips = [];
  for (const panel of state.panels) {
    panel.remove();
  }
  state.panels = [];
}

export function disposeKnowledgeDashboardTooltipState(state: KnowledgeDashboardTooltipState): void {
  clearKnowledgeDashboardHealthTooltips(state);
  for (const cleanup of state.cleanups) {
    cleanup();
  }
  state.cleanups = [];
}

export function isKnowledgeDashboardHealthTooltipHoverPoint(
  triggerRect: RectLike,
  panelRect: RectLike,
  x: number,
  y: number,
  padding = KNOWLEDGE_DASHBOARD_HEALTH_TOOLTIP_HOVER_PADDING
): boolean {
  if (isPointInExpandedRect(triggerRect, x, y, padding) || isPointInExpandedRect(panelRect, x, y, padding)) return true;

  const bridgeLeft = Math.min(triggerRect.left, panelRect.left) - padding;
  const bridgeRight = Math.max(triggerRect.right, panelRect.right) + padding;
  let bridgeTop: number;
  let bridgeBottom: number;

  if (panelRect.top >= triggerRect.bottom) {
    bridgeTop = triggerRect.bottom - padding;
    bridgeBottom = panelRect.top + padding;
  } else if (triggerRect.top >= panelRect.bottom) {
    bridgeTop = panelRect.bottom - padding;
    bridgeBottom = triggerRect.top + padding;
  } else {
    bridgeTop = Math.min(triggerRect.top, panelRect.top) - padding;
    bridgeBottom = Math.max(triggerRect.bottom, panelRect.bottom) + padding;
  }

  return x >= bridgeLeft && x <= bridgeRight && y >= bridgeTop && y <= bridgeBottom;
}

function isPointInExpandedRect(rect: RectLike, x: number, y: number, padding: number): boolean {
  return x >= rect.left - padding && x <= rect.right + padding && y >= rect.top - padding && y <= rect.bottom + padding;
}

function addKnowledgeDashboardMetric(container: HTMLElement, label: string, value: string): void {
  const metric = container.createSpan({ cls: "codex-kb-dashboard-metric" });
  metric.createSpan({ cls: "codex-kb-dashboard-metric-label", text: label });
  metric.createSpan({ cls: "codex-kb-dashboard-metric-value", text: value });
}

function addKnowledgeDashboardRulesMetric(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot, actions: KnowledgeDashboardActions): void {
  const button = container.createEl("button", {
    cls: "codex-kb-dashboard-metric codex-kb-dashboard-rule",
    attr: {
      type: "button",
      title: snapshot.rulesFileExists ? `打开规则文件：${snapshot.rulesFilePath}` : "规则文件缺失，点击查看提示",
      "aria-label": snapshot.rulesFileExists ? `打开规则文件 ${snapshot.rulesFilePath}` : "规则文件缺失"
    }
  });
  button.toggleClass("is-missing", !snapshot.rulesFileExists);
  button.createSpan({ cls: "codex-kb-dashboard-metric-label", text: "规则" });
  button.createSpan({ cls: "codex-kb-dashboard-metric-value", text: snapshot.rulesFileExists ? snapshot.rulesFilePath : "缺失" });
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    actions.onOpenRulesFile(snapshot);
  };
}

function addKnowledgeDashboardHealthMetric(container: HTMLElement, health: KnowledgeBaseDashboardSnapshot["health"], tooltipState: KnowledgeDashboardTooltipState): void {
  const { status, label } = health;
  const metric = container.createSpan({ cls: `codex-kb-dashboard-metric codex-kb-dashboard-health codex-kb-health-${status}` });
  metric.createSpan({ cls: "codex-kb-status-dot" });
  metric.createSpan({ cls: "codex-kb-dashboard-metric-value", text: label });
  addKnowledgeDashboardHealthTooltip(metric, health, "summary", tooltipState);
}

function renderKnowledgeDashboardHealth(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot, tooltipState: KnowledgeDashboardTooltipState): void {
  const section = addKnowledgeDashboardSection(container, "健康概览");
  const overview = section.createDiv({ cls: "codex-kb-dashboard-health-overview" });
  addKnowledgeDashboardEnergyMeter(
    overview,
    "知识库健康",
    snapshot.health.score,
    `codex-kb-health-${snapshot.health.status}`,
    snapshot.health.label,
    tooltipState,
    snapshot.health
  );
  addKnowledgeDashboardEnergyMeter(
    overview,
    "体检新鲜度",
    snapshot.checkFreshness.score,
    `codex-kb-freshness-${snapshot.checkFreshness.status}`,
    snapshot.checkFreshness.label,
    tooltipState
  );

  const facts = section.createDiv({ cls: "codex-kb-dashboard-facts" });
  addKnowledgeDashboardFact(facts, "最近体检", snapshot.checkFreshness.lastCheckAt ? formatAbsoluteTime(snapshot.checkFreshness.lastCheckAt) : "无记录");
  addKnowledgeDashboardFact(facts, "新鲜度", snapshot.checkFreshness.daysSinceCheck >= 0 ? `${snapshot.checkFreshness.daysSinceCheck} 天前确认` : "无记录");
  addKnowledgeDashboardFact(facts, "连续体检", snapshot.health.streakDays ? `${snapshot.health.streakDays} 天` : "0 天");
  addKnowledgeDashboardFact(facts, "最近任务", knowledgeRunStatusLabel(snapshot.lastRun.status, snapshot.lastRun.at));
  addKnowledgeDashboardFact(facts, "Tracker", snapshot.tracker.exists ? `${snapshot.tracker.trackedCount} 条` : "缺失");

  const healthReasons = snapshot.health.status === "healthy" ? [] : snapshot.health.reasons;
  const freshnessReasons = snapshot.checkFreshness.status === "fresh" ? [] : snapshot.checkFreshness.reasons;
  if (!healthReasons.length && !freshnessReasons.length) return;
  const reasons = section.createDiv({ cls: "codex-kb-dashboard-reasons" });
  for (const reason of healthReasons) {
    reasons.createDiv({ cls: "codex-kb-dashboard-reason", text: reason });
  }
  for (const reason of freshnessReasons) {
    reasons.createDiv({ cls: "codex-kb-dashboard-reason codex-kb-dashboard-reason-muted", text: reason });
  }
}

function addKnowledgeDashboardEnergyMeter(
  container: HTMLElement,
  label: string,
  scoreValue: number,
  statusClass: string,
  statusLabel: string,
  tooltipState: KnowledgeDashboardTooltipState,
  healthTooltip?: KnowledgeBaseDashboardSnapshot["health"]
): void {
  const safeScore = Math.max(0, Math.min(100, Math.round(scoreValue)));
  const activeCellCount = Math.round((safeScore / 100) * KNOWLEDGE_DASHBOARD_ENERGY_CELL_COUNT);
  const row = container.createDiv({
    cls: `codex-kb-dashboard-energy-row ${statusClass}`,
    attr: { "aria-label": `${label} ${safeScore}% ${statusLabel}` }
  });
  row.createDiv({ cls: "codex-kb-dashboard-meter-label", text: label });
  const percent = row.createDiv({ cls: "codex-kb-dashboard-energy-percent" });
  const percentValue = percent.createSpan({ cls: "codex-kb-dashboard-energy-percent-value", text: `${safeScore}%` });
  if (healthTooltip) addKnowledgeDashboardHealthTooltip(percentValue, healthTooltip, "meter", tooltipState);
  const track = row.createDiv({ cls: "codex-kb-dashboard-energy-track", attr: { "aria-hidden": "true" } });
  for (let index = 0; index < KNOWLEDGE_DASHBOARD_ENERGY_CELL_COUNT; index++) {
    const cellClass = index < activeCellCount
      ? `codex-kb-dashboard-energy-cell is-on ${statusClass}`
      : "codex-kb-dashboard-energy-cell";
    track.createSpan({ cls: cellClass });
  }
  const status = row.createDiv({ cls: `codex-kb-dashboard-health-badge ${statusClass}` });
  status.createSpan({ cls: "codex-kb-status-dot" });
  status.createSpan({ text: statusLabel });
}

function addKnowledgeDashboardHealthTooltip(
  container: HTMLElement,
  health: KnowledgeBaseDashboardSnapshot["health"],
  placement: "summary" | "meter",
  state: KnowledgeDashboardTooltipState
): void {
  ensureKnowledgeDashboardHealthTooltipDelegates(state);
  const placementClass = placement === "summary" ? "codex-kb-health-tooltip-placement-summary" : "codex-kb-health-tooltip-placement-meter";
  const wrapper = container.createSpan({ cls: `codex-kb-health-tooltip ${placementClass}` });
  const tooltipId = newId("codex-kb-health-tooltip");
  const button = wrapper.createEl("button", {
    cls: "codex-kb-health-tooltip-trigger",
    text: "!",
    attr: {
      type: "button",
      tabindex: "0",
      title: "健康分解释",
      "aria-label": "解释知识库健康分",
      "aria-describedby": tooltipId,
      "aria-expanded": "false"
    }
  });
  const bridge = document.body.createDiv({ cls: "codex-kb-health-tooltip-bridge" });
  const panel = document.body.createDiv({ cls: "codex-kb-health-tooltip-panel", attr: { id: tooltipId, role: "tooltip" } });
  state.panels.push(bridge);
  state.panels.push(panel);
  panel.createDiv({ cls: "codex-kb-health-tooltip-title", text: "健康分解释" });
  panel.createDiv({ cls: "codex-kb-health-tooltip-summary", text: `当前 ${health.score} 分，状态：${health.label}。` });
  const reasons = panel.createDiv({ cls: "codex-kb-health-tooltip-reasons" });
  const scoreReasons = health.scoreReasons ?? [];
  if (scoreReasons.length) {
    for (const reason of scoreReasons) {
      reasons.createDiv({ cls: "codex-kb-health-tooltip-reason", text: knowledgeDashboardHealthReasonText(reason) });
    }
  } else {
    reasons.createDiv({ cls: "codex-kb-health-tooltip-reason codex-kb-health-tooltip-reason-muted", text: "暂无扣分项" });
  }
  const note = panel.createDiv({ cls: "codex-kb-health-tooltip-note" });
  note.createDiv({ text: health.scoreCheckNote || "体检成功只代表检查完成；健康分反映检查发现的结构问题。" });
  note.createDiv({ text: health.scoreThresholdText || "85+ 健康，60-84 风险，低于 60 异常。" });

  let tooltip: KnowledgeDashboardHealthTooltipEntry;
  const rememberTooltipPointer = (event: MouseEvent) => {
    tooltip.lastPointer = { x: event.clientX, y: event.clientY };
  };
  const hidePanelState = () => {
    button.setAttribute("aria-expanded", "false");
  };
  const showPanelState = () => {
    button.setAttribute("aria-expanded", "true");
  };
  hidePanelState();
  const clearCloseTimer = () => {
    if (!tooltip.closeTimer) return;
    window.clearTimeout(tooltip.closeTimer);
    state.closeTimers.delete(tooltip.closeTimer);
    tooltip.closeTimer = undefined;
  };
  const openPanel = () => {
    clearCloseTimer();
    positionKnowledgeDashboardHealthTooltip(button, panel, bridge, placement);
    wrapper.addClass("is-tooltip-open");
    bridge.addClass("is-visible");
    panel.addClass("is-visible");
    showPanelState();
  };
  const closePanel = () => {
    clearCloseTimer();
    wrapper.removeClass("is-tooltip-open");
    wrapper.removeClass("is-click-open");
    bridge.removeClass("is-visible");
    panel.removeClass("is-visible");
    hidePanelState();
  };
  const scheduleClose = (delayMs = 160) => {
    clearCloseTimer();
    tooltip.closeTimer = window.setTimeout(closePanelIfPointerOutside, delayMs);
    state.closeTimers.add(tooltip.closeTimer);
  };
  const isPointerInsideTooltip = (event: MouseEvent) => isKnowledgeDashboardHealthTooltipHoverPoint(
    button.getBoundingClientRect(),
    panel.getBoundingClientRect(),
    event.clientX,
    event.clientY
  );
  const isTooltipTarget = (target: EventTarget | null) => {
    if (!(target instanceof Node)) return false;
    return button.contains(target) || panel.contains(target) || bridge.contains(target);
  };
  const isPointerCurrentlyInsideTooltip = () => {
    if (!tooltip.lastPointer) return false;
    const elementAtPointer = document.elementFromPoint(tooltip.lastPointer.x, tooltip.lastPointer.y);
    if (isTooltipTarget(elementAtPointer)) return true;
    return isKnowledgeDashboardHealthTooltipHoverPoint(
      button.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      tooltip.lastPointer.x,
      tooltip.lastPointer.y
    );
  };
  const closePanelIfPointerOutside = () => {
    if (tooltip.closeTimer) state.closeTimers.delete(tooltip.closeTimer);
    tooltip.closeTimer = undefined;
    if (isPointerCurrentlyInsideTooltip()) return;
    closePanel();
  };
  const trackOpenTooltipPointer = (event: MouseEvent) => {
    if (!wrapper.hasClass("is-tooltip-open")) return;
    rememberTooltipPointer(event);
  };
  const scheduleCloseIfOutside = (event: MouseEvent, delayMs = KNOWLEDGE_DASHBOARD_HEALTH_TOOLTIP_CLOSE_DELAY_MS) => {
    rememberTooltipPointer(event);
    if (wrapper.hasClass("is-click-open")) {
      clearCloseTimer();
      return;
    }
    if (isTooltipTarget(event.relatedTarget) || isPointerInsideTooltip(event)) {
      clearCloseTimer();
      return;
    }
    scheduleClose(delayMs);
  };
  const repositionOpenPanel = () => {
    if (!wrapper.hasClass("is-tooltip-open")) return;
    positionKnowledgeDashboardHealthTooltip(button, panel, bridge, placement);
  };
  tooltip = {
    wrapper,
    button,
    panel,
    bridge,
    placement,
    lastPointer: null,
    closePanel,
    repositionOpenPanel,
    trackOpenTooltipPointer,
    isTooltipTarget
  };
  state.tooltips.push(tooltip);
  const openPanelFromPointer = (event: MouseEvent) => {
    rememberTooltipPointer(event);
    openPanel();
  };
  const openPanelFromClick = (event: MouseEvent) => {
    rememberTooltipPointer(event);
    openPanel();
    wrapper.addClass("is-click-open");
  };
  button.onpointerdown = openPanelFromClick;
  button.onmousedown = openPanelFromClick;
  button.onmouseenter = openPanelFromPointer;
  button.onpointerenter = openPanelFromPointer;
  button.onmouseover = openPanelFromPointer;
  button.onmouseleave = (event) => scheduleCloseIfOutside(event);
  button.onpointerleave = (event) => scheduleCloseIfOutside(event);
  button.onfocus = openPanel;
  button.onblur = (event) => {
    if (isTooltipTarget(event.relatedTarget)) return;
    if (wrapper.hasClass("is-click-open")) return;
    scheduleClose();
  };
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPanelFromClick(event);
  };
  panel.onmouseenter = openPanelFromPointer;
  panel.onpointerenter = openPanelFromPointer;
  panel.onmouseleave = (event) => scheduleCloseIfOutside(event);
  panel.onpointerleave = (event) => scheduleCloseIfOutside(event);
  bridge.onmouseenter = openPanelFromPointer;
  bridge.onpointerenter = openPanelFromPointer;
  bridge.onmouseleave = (event) => scheduleCloseIfOutside(event);
  bridge.onpointerleave = (event) => scheduleCloseIfOutside(event);
}

function ensureKnowledgeDashboardHealthTooltipDelegates(state: KnowledgeDashboardTooltipState): void {
  if (state.cleanups.length) return;
  const repositionOpenHealthTooltipPanels = () => {
    for (const tooltip of state.tooltips) {
      tooltip.repositionOpenPanel();
    }
  };
  const trackOpenHealthTooltipPointer = (event: MouseEvent) => {
    for (const tooltip of state.tooltips) {
      tooltip.trackOpenTooltipPointer(event);
    }
  };
  const closeOpenHealthTooltipOnOutsidePointer = (event: MouseEvent) => {
    for (const tooltip of state.tooltips) {
      if (!tooltip.wrapper.hasClass("is-tooltip-open")) continue;
      if (tooltip.isTooltipTarget(event.target)) continue;
      tooltip.closePanel();
    }
  };
  window.addEventListener("resize", repositionOpenHealthTooltipPanels);
  window.addEventListener("scroll", repositionOpenHealthTooltipPanels, true);
  window.addEventListener("pointermove", trackOpenHealthTooltipPointer, { passive: true });
  window.addEventListener("mousemove", trackOpenHealthTooltipPointer, { passive: true });
  document.addEventListener("pointerdown", closeOpenHealthTooltipOnOutsidePointer, true);
  document.addEventListener("mousedown", closeOpenHealthTooltipOnOutsidePointer, true);
  state.cleanups.push(() => window.removeEventListener("resize", repositionOpenHealthTooltipPanels));
  state.cleanups.push(() => window.removeEventListener("scroll", repositionOpenHealthTooltipPanels, true));
  state.cleanups.push(() => window.removeEventListener("pointermove", trackOpenHealthTooltipPointer));
  state.cleanups.push(() => window.removeEventListener("mousemove", trackOpenHealthTooltipPointer));
  state.cleanups.push(() => document.removeEventListener("pointerdown", closeOpenHealthTooltipOnOutsidePointer, true));
  state.cleanups.push(() => document.removeEventListener("mousedown", closeOpenHealthTooltipOnOutsidePointer, true));
}

function positionKnowledgeDashboardHealthTooltip(button: HTMLElement, panel: HTMLElement, bridge: HTMLElement, placement: "summary" | "meter"): void {
  const trigger = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = 12;
  const gap = 8;
  const width = Math.min(320, Math.max(220, viewportWidth - margin * 2));
  panel.setCssStyles({ width: `${width}px` });
  const panelHeight = panel.getBoundingClientRect().height || 220;
  const preferredLeft = placement === "meter" ? trigger.left : trigger.right - width;
  const left = Math.max(margin, Math.min(preferredLeft, viewportWidth - width - margin));
  const preferredTop = trigger.bottom + gap;
  const top = preferredTop + panelHeight > viewportHeight - margin
    ? Math.max(margin, trigger.top - panelHeight - gap)
    : preferredTop;
  panel.setCssStyles({
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`
  });
  const panelRect = panel.getBoundingClientRect();
  const bridgePadding = KNOWLEDGE_DASHBOARD_HEALTH_TOOLTIP_HOVER_PADDING;
  const bridgeLeft = Math.max(0, Math.min(trigger.left, panelRect.left) - bridgePadding);
  const bridgeRight = Math.min(viewportWidth, Math.max(trigger.right, panelRect.right) + bridgePadding);
  const panelBelowTrigger = panelRect.top >= trigger.bottom;
  const bridgeTop = panelBelowTrigger
    ? Math.max(0, trigger.bottom - bridgePadding)
    : Math.max(0, panelRect.bottom - bridgePadding);
  const bridgeBottom = panelBelowTrigger
    ? Math.min(viewportHeight, panelRect.top + bridgePadding)
    : Math.min(viewportHeight, trigger.top + bridgePadding);
  bridge.setCssStyles({
    left: `${Math.round(bridgeLeft)}px`,
    top: `${Math.round(Math.min(bridgeTop, bridgeBottom))}px`,
    width: `${Math.max(16, Math.round(bridgeRight - bridgeLeft))}px`,
    height: `${Math.max(10, Math.round(Math.abs(bridgeBottom - bridgeTop)))}px`
  });
}

function renderKnowledgeDashboardWiki(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
  const rows = snapshot.wiki.groups.length
    ? snapshot.wiki.groups.map((group) => [group.label, `${group.totalCount}`, `${group.sharePercent}%`, group.todayCount ? `+${group.todayCount}` : "-"])
    : [["无一级目录", "0", "-", "-"]];
  addKnowledgeDashboardTable(container, "Wiki 状态", ["一级目录", "总数量", "占比", "今日更新"], rows);
}

function renderKnowledgeDashboardQueues(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
  addKnowledgeDashboardTable(container, "Raw / Inbox 状态", ["区域", "总数量", "今日新增", "待处理", "待校准"], [
    ["Raw", `${snapshot.raw.fileCount}`, snapshot.raw.todayCount ? `+${snapshot.raw.todayCount}` : "-", `${snapshot.raw.digestStatus.pending + snapshot.raw.digestStatus.changed}`, `${snapshot.raw.digestStatus.calibration}`],
    ["Inbox", `${snapshot.inbox.fileCount}`, snapshot.inbox.todayCount ? `+${snapshot.inbox.todayCount}` : "-", `${snapshot.inbox.fileCount}`, "-"]
  ]);
}

function renderKnowledgeDashboardHeatmap(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
  const section = addKnowledgeDashboardSection(container, "体检热力图");
  const year = heatmapYear(snapshot);
  const completedChecks = snapshot.checkHeatmap.filter((day) => day.status === "success" || day.status === "failed").length;
  section.createDiv({ cls: "codex-kb-heatmap-summary", text: `${year} 年 ${completedChecks} 次体检` });
  const heatmap = section.createDiv({ cls: "codex-kb-dashboard-heatmap" });
  const grid = heatmap.createDiv({ cls: "codex-kb-heatmap-grid" });
  const yearStart = new Date(year, 0, 1, 12, 0, 0, 0);
  const weekCount = Math.max(1, ...snapshot.checkHeatmap.map((day) => heatmapWeekIndex(day.date, yearStart) + 1));
  grid.setCssProps({ "--codex-kb-heatmap-weeks": String(weekCount) });

  const monthStarts = new Set<string>();
  for (const day of snapshot.checkHeatmap) {
    if (day.date.endsWith("-01")) monthStarts.add(day.date);
  }
  for (const dateKey of monthStarts) {
    const date = parseHeatmapDateKey(dateKey);
    if (!date) continue;
    const label = grid.createDiv({ cls: "codex-kb-heatmap-month", text: HEATMAP_MONTH_LABELS[date.getMonth()] });
    label.setCssStyles({
      gridColumn: `${heatmapWeekIndex(dateKey, yearStart) + 2}`,
      gridRow: "1"
    });
  }
  for (const [weekday, label] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as Array<[number, string]>) {
    const dayLabel = grid.createDiv({ cls: "codex-kb-heatmap-weekday", text: label });
    dayLabel.setCssStyles({
      gridColumn: "1",
      gridRow: `${weekday + 2}`
    });
  }

  for (const day of snapshot.checkHeatmap) {
    const date = parseHeatmapDateKey(day.date);
    if (!date) continue;
    const cell = grid.createSpan({
      cls: `codex-kb-heatmap-cell is-${day.status}`,
      attr: { title: `${day.date} · ${knowledgeHeatmapStatusLabel(day.status)}`, "aria-label": `${day.date} ${knowledgeHeatmapStatusLabel(day.status)}` }
    });
    cell.setCssStyles({
      gridColumn: `${heatmapWeekIndex(day.date, yearStart) + 2}`,
      gridRow: `${date.getDay() + 2}`
    });
  }
  const legend = section.createDiv({ cls: "codex-kb-dashboard-legend" });
  legend.createSpan({ cls: "codex-kb-dashboard-legend-label", text: "Less" });
  legend.createSpan({ cls: "codex-kb-legend-dot is-none" });
  legend.createSpan({ cls: "codex-kb-legend-dot is-success is-low" });
  legend.createSpan({ cls: "codex-kb-legend-dot is-success" });
  legend.createSpan({ cls: "codex-kb-dashboard-legend-label", text: "More" });
  const failed = legend.createSpan({ cls: "codex-kb-dashboard-legend-item" });
  failed.createSpan({ cls: "codex-kb-legend-dot is-failed" });
  failed.createSpan({ text: "失败" });
}

function addKnowledgeDashboardSection(container: HTMLElement, title: string): HTMLElement {
  const section = container.createDiv({ cls: "codex-kb-dashboard-section" });
  section.createDiv({ cls: "codex-kb-dashboard-section-title", text: title });
  return section;
}

function addKnowledgeDashboardFact(container: HTMLElement, label: string, value: string): void {
  const fact = container.createDiv({ cls: "codex-kb-dashboard-fact" });
  fact.createSpan({ cls: "codex-kb-dashboard-fact-label", text: label });
  fact.createSpan({ cls: "codex-kb-dashboard-fact-value", text: value });
}

function addKnowledgeDashboardTable(container: HTMLElement, title: string, columns: string[], rows: string[][]): void {
  const section = addKnowledgeDashboardSection(container, title);
  const table = section.createEl("table", { cls: "codex-kb-dashboard-table" });
  const thead = table.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const column of columns) headRow.createEl("th", { text: column });
  const tbody = table.createEl("tbody");
  for (const row of rows) {
    const tr = tbody.createEl("tr");
    for (const cell of row) tr.createEl("td", { text: cell });
  }
}

function knowledgeRunStatusLabel(status: string, at: number): string {
  const labels: Record<string, string> = {
    idle: "未运行",
    running: "运行中",
    success: "成功",
    failed: "失败",
    canceled: "已取消"
  };
  const label = labels[status] ?? status;
  return at ? `${label} · ${formatRelativeTime(at)}` : label;
}

function knowledgeDashboardHealthReasonText(reason: KnowledgeBaseDashboardSnapshot["health"]["scoreReasons"][number]): string {
  return `${reason.label}${knowledgeDashboardHealthReasonCountText(reason)}：${reason.explanation}`;
}

function knowledgeDashboardHealthReasonCountText(reason: KnowledgeBaseDashboardSnapshot["health"]["scoreReasons"][number]): string {
  if (reason.count <= 0) return "";
  if (reason.label === "断链" || reason.label === "过时/草稿") return ` ${reason.count} 处`;
  if (reason.label === "Raw 待提炼" || reason.label === "Raw 状态待校准" || reason.label === "Inbox 积压" || reason.label === "孤儿页面" || reason.label === "警告") return ` ${reason.count} 个`;
  return "";
}

function heatmapYear(snapshot: KnowledgeBaseDashboardSnapshot): number {
  const firstDate = snapshot.checkHeatmap[0] ? parseHeatmapDateKey(snapshot.checkHeatmap[0].date) : null;
  return firstDate?.getFullYear() ?? new Date(snapshot.generatedAt).getFullYear();
}

function heatmapWeekIndex(dateKey: string, yearStart: Date): number {
  const date = parseHeatmapDateKey(dateKey);
  if (!date) return 0;
  const daysFromYearStart = Math.round((date.getTime() - yearStart.getTime()) / 86400000);
  return Math.floor((daysFromYearStart + yearStart.getDay()) / 7);
}

function parseHeatmapDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
}

function knowledgeHeatmapStatusLabel(status: string): string {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "无记录";
}

function formatAbsoluteTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRelativeTime(value: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

import { setIcon } from "obsidian";
import { newId, type SettingsLanguage } from "../../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../../knowledge-base/dashboard";
import { conversationUiLocale, conversationUiText } from "./ui-i18n";

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface KnowledgeDashboardRenderState {
  language?: SettingsLanguage;
  visible: boolean;
  snapshot: KnowledgeBaseDashboardSnapshot | null;
  expanded: boolean;
  loading: boolean;
  error: string;
  recovery: {
    state: "pending" | "ready" | "blocked";
    message: string;
  };
}

export interface KnowledgeDashboardActions {
  onRefresh: () => void;
  onToggleExpanded: () => void;
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
  const language = state.language ?? "zh-CN";
  clearKnowledgeDashboardHealthTooltips(tooltipState);
  container.empty();
  container.toggleClass("is-visible", state.visible);
  if (!state.visible) return;

  const snapshot = state.snapshot;
  const recoveryPending = state.recovery.state === "pending";
  const recoveryBlocked = state.recovery.state === "blocked";
  const healthStatus = snapshot?.health.status ?? "unknown";
  const hasWarning = Boolean(state.error || recoveryBlocked || healthStatus === "risk" || healthStatus === "bad" || snapshot?.warnings.length);
  container.toggleClass("has-warning", hasWarning);
  container.toggleClass("health-healthy", healthStatus === "healthy");
  container.toggleClass("health-risk", healthStatus === "risk");
  container.toggleClass("health-bad", healthStatus === "bad");
  container.toggleClass("is-loading", state.loading);
  container.toggleClass("is-recovery-pending", recoveryPending);
  container.toggleClass("is-recovery-blocked", recoveryBlocked);

  const header = container.createDiv({ cls: "codex-kb-dashboard-header" });
  const title = header.createDiv({ cls: "codex-kb-dashboard-title" });
  const titleIcon = title.createSpan({ cls: "codex-kb-dashboard-icon" });
  setIcon(titleIcon, "database");
  title.createSpan({ text: conversationUiText(language, "知识库状态", "Knowledge status") });

  const summary = header.createDiv({ cls: "codex-kb-dashboard-summary" });
  if (snapshot) {
    addKnowledgeDashboardMetric(summary, "Raw", `${snapshot.raw.fileCount}`);
    addKnowledgeDashboardMetric(summary, "Wiki", `${snapshot.wiki.fileCount}`);
    addKnowledgeDashboardMetric(summary, "Inbox", `${snapshot.inbox.fileCount}`);
    addKnowledgeDashboardHealthMetric(summary, snapshot.health, tooltipState, language);
  } else {
    summary.createSpan({
      cls: "codex-kb-dashboard-muted",
      text: state.error || conversationUiText(language, "等待扫描", "Waiting to scan")
    });
  }

  const dashboardActions = header.createDiv({ cls: "codex-kb-dashboard-actions" });
  const refreshLabel = conversationUiText(language, "刷新状态", "Refresh status");
  const refresh = dashboardActions.createEl("button", { cls: "codex-icon-button codex-kb-dashboard-button", attr: { type: "button", title: refreshLabel, "aria-label": refreshLabel } });
  setIcon(refresh, state.loading ? "loader-circle" : "refresh-cw");
  refresh.disabled = state.loading;
  refresh.onclick = actions.onRefresh;
  const toggleTitle = state.expanded
    ? conversationUiText(language, "收起详情", "Collapse details")
    : conversationUiText(language, "展开详情", "Expand details");
  const toggle = dashboardActions.createEl("button", { cls: "codex-icon-button codex-kb-dashboard-button", attr: { type: "button", title: toggleTitle, "aria-label": toggleTitle } });
  setIcon(toggle, state.expanded ? "chevron-up" : "chevron-down");
  toggle.onclick = actions.onToggleExpanded;

  if (recoveryPending || recoveryBlocked) {
    const recovery = container.createDiv({
      cls: `codex-kb-dashboard-recovery codex-kb-dashboard-recovery-${state.recovery.state}`
    });
    const recoveryIcon = recovery.createSpan({ cls: "codex-kb-dashboard-recovery-icon" });
    setIcon(recoveryIcon, recoveryBlocked ? "triangle-alert" : "rotate-cw");
    recovery.createSpan({
      cls: "codex-kb-dashboard-recovery-text",
      text: state.recovery.message
    });
  }
  if (state.error) {
    container.createDiv({ cls: "codex-kb-dashboard-error", text: state.error });
  }
  if (!snapshot || !state.expanded) return;

  const details = container.createDiv({ cls: "codex-kb-dashboard-details" });
  renderKnowledgeDashboardHealth(details, snapshot, tooltipState, language);
  renderKnowledgeDashboardWiki(details, snapshot, language);
  renderKnowledgeDashboardQueues(details, snapshot, language);
  renderKnowledgeDashboardHeatmap(details, snapshot, language);
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

function addKnowledgeDashboardHealthMetric(
  container: HTMLElement,
  health: KnowledgeBaseDashboardSnapshot["health"],
  tooltipState: KnowledgeDashboardTooltipState,
  language: SettingsLanguage
): void {
  const { status } = health;
  const metric = container.createSpan({ cls: `codex-kb-dashboard-metric codex-kb-dashboard-health codex-kb-health-${status}` });
  metric.createSpan({ cls: "codex-kb-status-dot" });
  metric.createSpan({ cls: "codex-kb-dashboard-metric-value", text: knowledgeHealthStatusLabel(status, health.label, language) });
  addKnowledgeDashboardHealthTooltip(metric, health, "summary", tooltipState, language);
}

function renderKnowledgeDashboardHealth(
  container: HTMLElement,
  snapshot: KnowledgeBaseDashboardSnapshot,
  tooltipState: KnowledgeDashboardTooltipState,
  language: SettingsLanguage
): void {
  const section = addKnowledgeDashboardSection(container, conversationUiText(language, "健康概览", "Health overview"));
  const overview = section.createDiv({ cls: "codex-kb-dashboard-health-overview" });
  addKnowledgeDashboardEnergyMeter(
    overview,
    conversationUiText(language, "知识库健康", "Knowledge health"),
    snapshot.health.status === "unknown" ? null : snapshot.health.score,
    `codex-kb-health-${snapshot.health.status}`,
    knowledgeHealthStatusLabel(snapshot.health.status, snapshot.health.label, language),
    tooltipState,
    snapshot.health,
    language
  );
  addKnowledgeDashboardEnergyMeter(
    overview,
    conversationUiText(language, "体检新鲜度", "Check freshness"),
    snapshot.checkFreshness.status === "missing" ? null : snapshot.checkFreshness.score,
    `codex-kb-freshness-${snapshot.checkFreshness.status}`,
    checkFreshnessStatusLabel(snapshot.checkFreshness.status, snapshot.checkFreshness.label, language),
    tooltipState,
    undefined,
    language
  );

  const facts = section.createDiv({ cls: "codex-kb-dashboard-facts" });
  const noRecord = conversationUiText(language, "无记录", "No record");
  addKnowledgeDashboardFact(facts, conversationUiText(language, "最近体检", "Latest check"), snapshot.checkFreshness.lastCheckAt ? formatAbsoluteTime(snapshot.checkFreshness.lastCheckAt, language) : noRecord);
  addKnowledgeDashboardFact(facts, conversationUiText(language, "新鲜度", "Freshness"), snapshot.checkFreshness.daysSinceCheck >= 0
    ? conversationUiText(language, `${snapshot.checkFreshness.daysSinceCheck} 天前确认`, `Confirmed ${snapshot.checkFreshness.daysSinceCheck} day${snapshot.checkFreshness.daysSinceCheck === 1 ? "" : "s"} ago`)
    : noRecord);
  addKnowledgeDashboardFact(facts, conversationUiText(language, "连续体检", "Check streak"), conversationUiText(language, snapshot.health.streakDays ? `${snapshot.health.streakDays} 天` : "0 天", `${snapshot.health.streakDays} day${snapshot.health.streakDays === 1 ? "" : "s"}`));
  addKnowledgeDashboardFact(
    facts,
    conversationUiText(language, "最近任务", "Latest task"),
    knowledgeRunStatusLabel(
      snapshot.lastRun.status,
      snapshot.lastRun.at,
      snapshot.lastRun.completion,
      snapshot.lastRun.pendingSourceCount,
      language
    )
  );
  addKnowledgeDashboardFact(facts, snapshot.tracker.path ? "Tracker" : conversationUiText(language, "来源处理记录", "Source records"), snapshot.tracker.exists
    ? conversationUiText(language, `${snapshot.tracker.trackedCount} 条`, `${snapshot.tracker.trackedCount} entries`)
    : conversationUiText(language, "缺失", "Missing"));

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
  scoreValue: number | null,
  statusClass: string,
  statusLabel: string,
  tooltipState: KnowledgeDashboardTooltipState,
  healthTooltip?: KnowledgeBaseDashboardSnapshot["health"],
  language: SettingsLanguage = "zh-CN"
): void {
  const safeScore = Math.max(0, Math.min(100, Math.round(scoreValue ?? 0)));
  const activeCellCount = Math.round((safeScore / 100) * KNOWLEDGE_DASHBOARD_ENERGY_CELL_COUNT);
  const row = container.createDiv({
    cls: `codex-kb-dashboard-energy-row ${statusClass}`,
    attr: { "aria-label": `${label} ${scoreValue === null ? "—" : `${safeScore}%`} ${statusLabel}` }
  });
  row.createDiv({ cls: "codex-kb-dashboard-meter-label", text: label });
  const percent = row.createDiv({ cls: "codex-kb-dashboard-energy-percent" });
  const percentValue = percent.createSpan({ cls: "codex-kb-dashboard-energy-percent-value", text: scoreValue === null ? "—" : `${safeScore}%` });
  if (healthTooltip) addKnowledgeDashboardHealthTooltip(percentValue, healthTooltip, "meter", tooltipState, language);
  if (scoreValue === null) { row.createDiv({ cls: "codex-kb-dashboard-health-badge", text: statusLabel }); return; }
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
  state: KnowledgeDashboardTooltipState,
  language: SettingsLanguage
): void {
  const document = container.ownerDocument;
  const window = document.defaultView!;
  ensureKnowledgeDashboardHealthTooltipDelegates(state, document);
  const placementClass = placement === "summary" ? "codex-kb-health-tooltip-placement-summary" : "codex-kb-health-tooltip-placement-meter";
  const wrapper = container.createSpan({ cls: `codex-kb-health-tooltip ${placementClass}` });
  const tooltipId = newId("codex-kb-health-tooltip");
  const button = wrapper.createEl("button", {
    cls: "codex-kb-health-tooltip-trigger",
    text: "!",
    attr: {
      type: "button",
      tabindex: "0",
      title: conversationUiText(language, "健康分解释", "Health score explanation"),
      "aria-label": conversationUiText(language, "解释知识库健康分", "Explain knowledge health score"),
      "aria-describedby": tooltipId,
      "aria-expanded": "false"
    }
  });
  const owner = button.ownerDocument;
  const bridge = owner.body.createDiv({ cls: "codex-kb-health-tooltip-bridge" });
  const panel = owner.body.createDiv({ cls: "codex-kb-health-tooltip-panel", attr: { id: tooltipId, role: "tooltip" } });
  state.panels.push(bridge);
  state.panels.push(panel);
  panel.createDiv({ cls: "codex-kb-health-tooltip-title", text: conversationUiText(language, "健康分解释", "Health score explanation") });
  panel.createDiv({
    cls: "codex-kb-health-tooltip-summary",
    text: health.status === "unknown" ? knowledgeHealthStatusLabel(health.status, health.label, language) : conversationUiText(language, `当前 ${health.score} 分，状态：${health.label}。`, `Current score: ${health.score}. Status: ${knowledgeHealthStatusLabel(health.status, health.label, language)}.`)
  });
  const reasons = panel.createDiv({ cls: "codex-kb-health-tooltip-reasons" });
  const scoreReasons = health.scoreReasons ?? [];
  if (scoreReasons.length) {
    for (const reason of scoreReasons) {
      reasons.createDiv({ cls: "codex-kb-health-tooltip-reason", text: knowledgeDashboardHealthReasonText(reason, language) });
    }
  } else {
    reasons.createDiv({ cls: "codex-kb-health-tooltip-reason codex-kb-health-tooltip-reason-muted", text: conversationUiText(language, "暂无扣分项", "No score deductions") });
  }
  const note = panel.createDiv({ cls: "codex-kb-health-tooltip-note" });
  note.createDiv({ text: language === "en" ? "Score = max(0, min(100, 100 − deductions)). Based on checked local structure and source status only. Maintenance is not a full knowledge check." : health.scoreCheckNote || "体检成功只代表检查完成；健康分反映检查发现的结构问题。" });
  note.createDiv({ text: language === "en" ? "85+ healthy, 60–84 at risk, below 60 unhealthy. Each missing core structure deducts 24 points and always shows unhealthy." : health.scoreThresholdText || "85+ 健康，60-84 风险，低于 60 异常。" });

  note.createDiv({ text: language === "en" ? "Unchecked: broken links, orphan pages, stale content and index link validity." : `未检查：${(health.unchecked ?? []).join("、")}` });
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
    if (!(target instanceof window.Node)) return false;
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

function ensureKnowledgeDashboardHealthTooltipDelegates(state: KnowledgeDashboardTooltipState, document: Document): void {
  const window = document.defaultView!;
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
  const window = button.ownerDocument.defaultView!;
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

function renderKnowledgeDashboardWiki(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot, language: SettingsLanguage): void {
  const rows = snapshot.wiki.groups.length
    ? snapshot.wiki.groups.map((group) => [group.label, `${group.totalCount}`, `${group.sharePercent}%`, group.todayCount ? `+${group.todayCount}` : "-"])
    : [[conversationUiText(language, "无一级目录", "No top-level folders"), "0", "-", "-"]];
  addKnowledgeDashboardTable(container, conversationUiText(language, "Wiki 状态", "Wiki status"), [
    conversationUiText(language, "一级目录", "Top-level folder"),
    conversationUiText(language, "总数量", "Total"),
    conversationUiText(language, "占比", "Share"),
    conversationUiText(language, "今日更新", "Updated today")
  ], rows);
}

function renderKnowledgeDashboardQueues(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot, language: SettingsLanguage): void {
  addKnowledgeDashboardTable(container, conversationUiText(language, "Raw / Inbox 状态", "Raw / Inbox status"), [
    conversationUiText(language, "区域", "Area"),
    conversationUiText(language, "总数量", "Total"),
    conversationUiText(language, "今日新增", "Added today"),
    conversationUiText(language, "待处理", "Pending"),
    conversationUiText(language, "待校准", "Needs calibration")
  ], [
    ["Raw", `${snapshot.raw.fileCount}`, snapshot.raw.todayCount ? `+${snapshot.raw.todayCount}` : "-", `${snapshot.raw.digestStatus.pending + snapshot.raw.digestStatus.changed}`, `${snapshot.raw.digestStatus.calibration}`],
    ["Inbox", `${snapshot.inbox.fileCount}`, snapshot.inbox.todayCount ? `+${snapshot.inbox.todayCount}` : "-", `${snapshot.inbox.fileCount}`, "-"]
  ]);
}

function renderKnowledgeDashboardHeatmap(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot, language: SettingsLanguage): void {
  const section = addKnowledgeDashboardSection(container, conversationUiText(language, "体检热力图", "Check heatmap"));
  const year = heatmapYear(snapshot);
  const completedChecks = snapshot.checkHeatmap.filter((day) => day.status === "success" || day.status === "failed").length;
  section.createDiv({
    cls: "codex-kb-heatmap-summary",
    text: conversationUiText(language, `${year} 年 ${completedChecks} 次体检`, `${completedChecks} checks in ${year}`)
  });
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
      attr: {
        title: `${day.date} · ${knowledgeHeatmapStatusLabel(day.status, language)}`,
        "aria-label": `${day.date} ${knowledgeHeatmapStatusLabel(day.status, language)}`
      }
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
  failed.createSpan({ text: conversationUiText(language, "失败", "Failed") });
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

export function knowledgeRunStatusLabel(
  status: string,
  at: number,
  completion = "",
  pendingSourceCount = 0,
  language: SettingsLanguage = "zh-CN"
): string {
  if (language === "en") {
    const labels: Record<string, string> = {
      idle: "Not run",
      running: "Running",
      success: "Successful",
      failed: "Failed",
      canceled: "Cancelled"
    };
    const completionLabels: Record<string, string> = {
      partial: pendingSourceCount ? `Partially complete (${pendingSourceCount} pending)` : "Partially complete",
      recovered: "Recovered",
      noop: "No changes needed",
      full: "Successful"
    };
    const label = (status === "success" || (status !== "canceled" && completion === "partial")) && completion
      ? completionLabels[completion] ?? labels[status]
      : labels[status] ?? status;
    return at ? `${label} · ${formatRelativeTime(at, language)}` : label;
  }
  const labels: Record<string, string> = {
    idle: "未运行",
    running: "运行中",
    success: "成功",
    failed: "失败",
    canceled: "已取消"
  };
  const completionLabels: Record<string, string> = {
    partial: pendingSourceCount ? `部分完成（${pendingSourceCount} 项待处理）` : "部分完成",
    recovered: "恢复后完成",
    noop: "无需更新",
    full: "成功"
  };
  const label = (status === "success" || (status !== "canceled" && completion === "partial")) && completion
    ? completionLabels[completion] ?? labels[status]
    : labels[status] ?? status;
  return at ? `${label} · ${formatRelativeTime(at, language)}` : label;
}

export function knowledgeDashboardHealthReasonText(
  reason: KnowledgeBaseDashboardSnapshot["health"]["scoreReasons"][number],
  language: SettingsLanguage = "zh-CN"
): string {
  if (language === "en") return `${knowledgeDashboardHealthReasonLabel(reason.label)}${reason.count > 0 ? ` (${reason.count})` : ""}: ${knowledgeDashboardHealthReasonExplanation(reason.explanation)}`;
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

function knowledgeHeatmapStatusLabel(status: string, language: SettingsLanguage = "zh-CN"): string {
  if (status === "success") return conversationUiText(language, "成功", "Successful");
  if (status === "failed") return conversationUiText(language, "失败", "Failed");
  return conversationUiText(language, "无记录", "No record");
}

function formatAbsoluteTime(value: number, language: SettingsLanguage = "zh-CN"): string {
  return new Date(value).toLocaleString(conversationUiLocale(language), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRelativeTime(value: number, language: SettingsLanguage = "zh-CN"): string {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (language === "en") {
    if (seconds < 60) return seconds ? `${seconds}s ago` : "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function knowledgeHealthStatusLabel(
  status: KnowledgeBaseDashboardSnapshot["health"]["status"],
  fallback: string,
  language: SettingsLanguage
): string {
  if (language !== "en") return fallback;
  if (status === "unknown") return fallback === "未初始化" ? "Not initialized" : "Unavailable";
  return status === "healthy" ? "Healthy" : status === "risk" ? "At risk" : "Unhealthy";
}

function checkFreshnessStatusLabel(
  status: KnowledgeBaseDashboardSnapshot["checkFreshness"]["status"],
  fallback: string,
  language: SettingsLanguage
): string {
  if (language !== "en") return fallback;
  if (status === "fresh") return "Fresh";
  if (status === "stale") return "Needs check";
  if (status === "bad") return "Overdue";
  return "No check";
}

function knowledgeDashboardHealthReasonLabel(value: string): string {
  return ({
    "raw 目录缺失": "Raw folder missing",
    "wiki 目录缺失": "Wiki folder missing",
    "tracker 缺失": "Tracker missing",
    "最近体检失败": "Latest check failed",
    "Raw 待提炼": "Raw items need refinement",
    "Raw 状态待校准": "Raw status needs calibration",
    "Inbox 积压": "Inbox backlog",
    "索引链接异常": "Index links invalid",
    "断链": "Broken links",
    "孤儿页面": "Orphan pages",
    "过时/草稿": "Stale or draft items",
    "警告": "Warnings"
  } as Record<string, string>)[value] ?? value;
}

function knowledgeDashboardHealthReasonExplanation(value: string): string {
  return ({
    "1–20 项合计扣 4 分，超过 20 项合计扣 10 分；历史记录显示可能已提炼，但缺少可信机器标记。": "1–20 items deduct 4 points total; over 20 deduct 10 total. History suggests refinement, but trusted markers are missing.",
    "说明原始来源区不可用。": "The source area is unavailable.",
    "说明沉淀后的知识区不可用。": "The refined knowledge area is unavailable.",
    "说明来源消化登记无法确认。": "Source processing records cannot be confirmed.",
    "说明最近一次维护或体检没有成功完成。": "The latest maintenance run or check did not finish successfully.",
    "来源还没有进入 Wiki / Projects 的结构化知识，或缺少可信来源证据。": "Sources have not reached structured Wiki / Projects knowledge, or lack trustworthy evidence.",
    "说明历史记录显示可能已提炼，但还缺少可信机器标记。": "History suggests refinement may be complete, but trustworthy machine markers are missing.",
    "说明临时输入区积压较多，尚未整理归位。": "The temporary input area has a backlog that has not been organized.",
    "说明核心索引中存在不可用链接。": "The core index contains unavailable links.",
    "说明 wiki 中有链接目标不存在。": "Some wiki link targets do not exist.",
    "说明页面缺少有效入口或引用。": "Some pages lack a valid entry point or reference.",
    "说明存在待补、TODO、draft 等内容。": "Some content is incomplete, TODO, or draft.",
    "说明存在需要人工确认的结构风险。": "There are structural risks that need manual confirmation."
  } as Record<string, string>)[value] ?? value;
}

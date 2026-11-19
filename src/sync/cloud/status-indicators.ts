import { MarkdownView, Notice, Platform, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { ownedSvg } from "../../ui/owned-dom";
import { cloudSyncStatusText } from "../../ui/mobile/cloud-sync-settings";
import type { CloudSyncController, CloudSyncView } from "./controller";
import type { CloudHistoryVersion } from "./history";

/** Icons: cloud-sync / cloud-upload / cloud-download paths and motion follow lucide-animated (MIT); check draws once. */
export type SyncIconKind = "cloud-check" | "cloud-pending" | "cloud-sync" | "cloud-upload" | "cloud-download" | "cloud-off" | "cloud-alert";
export interface SyncIndicator { readonly icon: SyncIconKind; readonly warn: boolean; readonly text: string; readonly tip: string }

const CLOUD = "M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2";
const SYNC_HOLD_MS = 700;
const fileName = (path: string) => path.split("/").pop() ?? path;
const stamp = (at: number) => { const d = new Date(at), p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const clock = (at: number | null) => { if (!at) return ""; const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Whole-vault state for the status bar; null hides it (sync not set up or turned off). */
export function vaultSyncIndicator(view: CloudSyncView, zh: boolean): SyncIndicator | null {
  if (!view.signedIn || !view.enabled) return null;
  const t = (cn: string, en: string) => zh ? cn : en, tip = cloudSyncStatusText(view, zh), status = view.status;
  if (!status) return { icon: "cloud-sync", warn: false, text: t("准备同步", "Preparing sync"), tip };
  const pending = status.pending;
  switch (status.phase) {
    case "syncing": return { icon: "cloud-sync", warn: false, tip, text: status.activePath ? t(`正在同步 · ${fileName(status.activePath)}`, `Syncing · ${fileName(status.activePath)}`) : t("正在同步", "Syncing") };
    case "rate-limited": return { icon: "cloud-pending", warn: false, tip, text: t("同步稍后继续", "Sync resumes shortly") };
    case "offline": return { icon: "cloud-off", warn: true, tip, text: pending ? t(`离线 · ${pending} 个改动待上传`, `Offline · ${pending} pending`) : t("离线", "Offline") };
    case "error": return { icon: "cloud-alert", warn: true, tip, text: t("同步已暂停", "Sync paused") };
    case "read-only": return { icon: "cloud-alert", warn: true, tip, text: t("同步只读", "Sync read-only") };
    case "stopped": return null;
    default: return { icon: "cloud-check", warn: false, tip, text: `${t("已同步", "Synced")} ${clock(status.lastSyncAt)}`.trim() };
  }
}

/** One note's state for its header icon; null when the note is outside the synced folders. */
export function noteSyncIndicator(view: CloudSyncView, path: string, ports: { tracks(path: string): boolean; pending(path: string): boolean }, zh: boolean): SyncIndicator | null {
  if (!view.signedIn || !view.enabled || !view.status || view.status.phase === "stopped" || !ports.tracks(path)) return null;
  const t = (cn: string, en: string) => zh ? cn : en, status = view.status, waiting = ports.pending(path);
  const base = { warn: false, text: "" };
  if (status.phase === "rate-limited") return { ...base, icon: waiting ? "cloud-pending" : "cloud-check", tip: cloudSyncStatusText(view, zh) };
  if (status.phase === "offline") return { ...base, icon: "cloud-off", warn: true, tip: waiting ? t("离线：改动已保存在本地，联网后自动上传", "Offline: changes are saved locally and upload when connected") : t("离线：联网后继续同步", "Offline: sync resumes when connected") };
  if (status.phase === "error" || status.phase === "read-only") return { ...base, icon: "cloud-alert", warn: true, tip: cloudSyncStatusText(view, zh) };
  if (status.phase === "syncing" && status.activePath === path) return status.activeDirection === "down"
    ? { ...base, icon: "cloud-download", tip: t("正在从云端更新", "Updating from the cloud") }
    : { ...base, icon: "cloud-upload", tip: t("正在上传", "Uploading") };
  if (waiting) return { ...base, icon: "cloud-pending", tip: t("有改动等待上传", "Changes waiting to upload") };
  return { ...base, icon: "cloud-check", tip: `${t("已同步到云端", "Synced to the cloud")}${status.lastSyncAt ? ` · ${clock(status.lastSyncAt)}` : ""}` };
}

/** Renders the icon only when its kind changes, so running animations are not restarted on every status tick. */
export function renderSyncIcon(host: HTMLElement, kind: SyncIconKind): void {
  const previous = host.dataset.syncIcon;
  if (previous === kind) return;
  host.dataset.syncIcon = kind; host.empty();
  if (kind === "cloud-off" || kind === "cloud-alert") { setIcon(host, kind); return; }
  const doc = host.ownerDocument, svg = ownedSvg(doc, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "svg-icon echoink-sync-icon" })) svg.setAttribute(name, value);
  const path = (parent: Element, d: string, cls?: string) => { const node = ownedSvg(doc, "path"); node.setAttribute("d", d); if (cls) node.setAttribute("class", cls); parent.append(node); };
  const group = (cls: string) => { const node = ownedSvg(doc, "g"); node.setAttribute("class", cls); svg.append(node); return node; };
  if (kind === "cloud-sync") {
    path(svg, "M20.996 15.251A4.5 4.5 0 0 0 17.495 8h-1.79a7 7 0 1 0-12.709 5.607");
    const g = group("echoink-sync-spin");
    for (const d of ["m17 18-1.535 1.605a5 5 0 0 1-8-1.5", "M17 22v-4h-4", "M7 10v4h4", "m7 14 1.535-1.605a5 5 0 0 1 8 1.5"]) path(g, d);
  } else {
    path(svg, CLOUD);
    if (kind === "cloud-upload") { const g = group("echoink-sync-up"); path(g, "M12 13v8"); path(g, "m8 17 4-4 4 4"); }
    if (kind === "cloud-download") { const g = group("echoink-sync-down"); path(g, "M12 13v8l-4-4"); path(g, "m12 21 4-4"); }
    if (kind === "cloud-check") path(svg, "m9 17 2 2 4-4", previous && previous !== "cloud-pending" ? "echoink-sync-draw" : undefined);
    if (kind === "cloud-pending") { const dot = ownedSvg(doc, "circle"); dot.setAttribute("cx", "12"); dot.setAttribute("cy", "17"); dot.setAttribute("r", "1.6"); dot.setAttribute("fill", "currentColor"); dot.setAttribute("stroke", "none"); svg.append(dot); }
  }
  host.append(svg);
}

/** Desktop status bar (whole vault) and a header icon on every Markdown note. Only reads the controller. */
export function mountCloudSyncIndicators(plugin: CodexForObsidianPlugin): void {
  const controller = plugin.cloudSync;
  if (!controller) return;
  const zh = () => plugin.settings.settingsLanguage !== "en";
  const openSettings = () => { void plugin.openEchoInkAccountSettings().catch(() => new Notice(zh() ? "设置未能打开，请重试。" : "Settings did not open. Try again.")); };

  const bar = Platform.isDesktopApp ? plugin.addStatusBarItem() : null;
  let barIcon: HTMLElement | null = null, barText: HTMLElement | null = null;
  if (bar) {
    bar.addClass("echoink-sync-status", "mod-clickable"); bar.setAttribute("role", "button"); bar.tabIndex = 0;
    barIcon = bar.createSpan({ cls: "echoink-sync-status-icon" }); barText = bar.createSpan({ cls: "echoink-sync-status-text" });
    plugin.registerDomEvent(bar, "click", openSettings);
    plugin.registerDomEvent(bar, "keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSettings(); } });
  }

  const actions = new Map<MarkdownView, HTMLElement>();
  const popover = noteSyncPopover(plugin, controller, zh);
  let syncingSince = 0, holdTimer: number | null = null;
  const render = () => {
    const view = controller.view(), status = view.status;
    // Keep a short sync visible long enough to read instead of flickering.
    if (status?.phase === "syncing") syncingSince ||= Date.now();
    else if (syncingSince) {
      const left = SYNC_HOLD_MS - (Date.now() - syncingSince);
      if (left > 0) { if (holdTimer === null) holdTimer = window.setTimeout(() => { holdTimer = null; render(); }, left); return; }
      syncingSince = 0;
    }
    if (bar && barIcon && barText) {
      const state = vaultSyncIndicator(view, zh());
      bar.toggleClass("is-hidden", !state);
      if (state) { renderSyncIcon(barIcon, state.icon); barText.setText(state.text); bar.setAttribute("aria-label", state.tip); bar.toggleClass("is-warn", state.warn); }
    }
    const live = new Set<MarkdownView>();
    plugin.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => { if (leaf.view instanceof MarkdownView) live.add(leaf.view); });
    for (const [mdView, action] of actions) if (!live.has(mdView)) { action.remove(); actions.delete(mdView); }
    for (const mdView of live) {
      const path = mdView.file?.path, state = path ? noteSyncIndicator(view, path, { tracks: p => controller.tracks(p), pending: p => controller.pathPending(p) }, zh()) : null;
      let action = actions.get(mdView);
      if (!state) { if (action) { action.remove(); actions.delete(mdView); } continue; }
      if (!action) {
        const owner = mdView, created = mdView.addAction("cloud", state.tip, () => { const file = owner.file; if (file) popover.toggle(created, file); });
        action = created; action.addClass("echoink-sync-note-action"); actions.set(mdView, action);
      }
      renderSyncIcon(action, state.icon);
      action.setAttribute("aria-label", state.tip); action.toggleClass("is-warn", state.warn);
      const marked = action;
      void controller.history?.hasUnseen(path!).then(unseen => marked.toggleClass("has-unseen", unseen));
    }
  };
  render();
  plugin.register(controller.subscribe(() => { render(); popover.refresh(); }));
  const history = controller.history; if (history) plugin.register(history.subscribe(render));
  plugin.registerEvent(plugin.app.workspace.on("layout-change", render));
  plugin.registerEvent(plugin.app.workspace.on("file-open", render));
  plugin.registerEvent(plugin.app.vault.on("rename", render));
  plugin.register(() => { if (holdTimer !== null) window.clearTimeout(holdTimer); popover.close(); for (const action of actions.values()) action.remove(); actions.clear(); bar?.remove(); });
}

/**
 * The note header popover: this note's sync state, its local and cloud times, and (when a conflict replaced one side)
 * up to 10 version records that can be restored. Restoring is an ordinary edit, so it syncs like any other change.
 */
function noteSyncPopover(plugin: CodexForObsidianPlugin, controller: CloudSyncController, zh: () => boolean) {
  let el: HTMLElement | null = null, anchor: HTMLElement | null = null, file: TFile | null = null, expanded = false, offDoc: (() => void) | null = null;
  const t = (cn: string, en: string) => zh() ? cn : en;
  const close = () => { offDoc?.(); offDoc = null; el?.remove(); el = null; anchor?.removeClass("is-active"); anchor = null; file = null; expanded = false; };
  const place = () => {
    if (!el || !anchor) return;
    const box = anchor.getBoundingClientRect(), win = anchor.ownerDocument.defaultView ?? window;
    const left = Math.max(8, Math.min(box.right - el.offsetWidth, win.innerWidth - el.offsetWidth - 8));
    const top = box.bottom + 6 + el.offsetHeight > win.innerHeight ? Math.max(8, box.top - 6 - el.offsetHeight) : box.bottom + 6;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  };
  const restore = async (target: TFile, version: CloudHistoryVersion) => {
    const history = controller.history; if (!history) return;
    try {
      const vault = plugin.app.vault, current = new Uint8Array(await vault.readBinary(target)), bytes = await history.read(version.id);
      await history.add(target.path, current, { editedAt: target.stat.mtime, deviceName: t("恢复前", "Before restore") });
      await vault.modifyBinary(target, new Uint8Array(bytes).buffer);
      new Notice(t("已恢复所选版本。", "The selected version was restored."));
    } catch { new Notice(t("版本未能恢复。请重试。", "The version could not be restored. Try again.")); }
  };
  const draw = async () => {
    if (!el || !file) return;
    const target = file, view = controller.view();
    const state = noteSyncIndicator(view, target.path, { tracks: p => controller.tracks(p), pending: p => controller.pathPending(p) }, zh());
    const versions = await controller.history?.list(target.path) ?? [];
    if (!el || file !== target) return;
    el.empty();
    const head = el.createDiv({ cls: "echoink-sync-pop-head" }); head.toggleClass("is-warn", !!state?.warn);
    renderSyncIcon(head.createSpan({ cls: "echoink-sync-pop-icon" }), state?.icon ?? "cloud-check"); head.createSpan({ text: target.name });
    if (state) el.createDiv({ cls: "echoink-sync-pop-sub", text: state.tip });
    const rows = el.createDiv({ cls: "echoink-sync-pop-rows" });
    const row = (name: string, value: string) => { const r = rows.createDiv({ cls: "echoink-sync-pop-row" }); r.createSpan({ cls: "echoink-sync-pop-name", text: name }); r.createSpan({ cls: "echoink-sync-pop-time", text: value }); return r; };
    const cloudAt = controller.cloudVersionAt(target.path);
    row(t("本机最后保存", "Last saved here"), clock(target.stat.mtime));
    row(t("云端版本", "Cloud version"), controller.pathPending(target.path) ? t("上一版", "Previous") : cloudAt ? clock(cloudAt) : "—");
    if (!versions.length) return;
    const toggle = rows.createEl("button", { cls: "echoink-sync-pop-row echoink-sync-pop-toggle" });
    toggle.createSpan({ cls: "echoink-sync-pop-name", text: t("版本记录", "Versions") }); toggle.createSpan({ cls: "echoink-sync-pop-time", text: String(versions.length) });
    setIcon(toggle.createSpan({ cls: "echoink-sync-pop-chevron" }), expanded ? "chevron-down" : "chevron-right");
    toggle.addEventListener("click", () => { expanded = !expanded; void draw(); });
    if (!expanded) return;
    const list = el.createDiv({ cls: "echoink-sync-pop-rows echoink-sync-pop-versions" });
    for (const version of versions) {
      const r = list.createDiv({ cls: "echoink-sync-pop-row" });
      r.createSpan({ cls: "echoink-sync-pop-time", text: stamp(version.editedAt) }); r.createSpan({ cls: "echoink-sync-pop-name", text: version.deviceName });
      const button = r.createEl("button", { cls: "echoink-sync-pop-restore", text: t("恢复", "Restore") });
      button.addEventListener("click", () => { button.disabled = true; void restore(target, version).then(() => draw()); });
    }
    place();
  };
  const open = (action: HTMLElement, target: TFile) => {
    close();
    const doc = action.ownerDocument; anchor = action; file = target; anchor.addClass("is-active");
    el = doc.body.createDiv({ cls: "echoink-sync-pop" }); el.setAttribute("role", "dialog");
    const onDown = (event: MouseEvent) => { const node = event.target as Node; if (el?.contains(node) || anchor?.contains(node)) return; close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    doc.addEventListener("mousedown", onDown, true); doc.addEventListener("keydown", onKey, true);
    offDoc = () => { doc.removeEventListener("mousedown", onDown, true); doc.removeEventListener("keydown", onKey, true); };
    void draw().then(place);
    void controller.history?.markSeen(target.path);
  };
  return {
    toggle: (action: HTMLElement, target: TFile) => { if (anchor === action) close(); else open(action, target); },
    refresh: () => { if (el) void draw(); },
    close
  };
}

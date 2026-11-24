import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { NEXT, failureText } from "../core/error-copy";
import { availableWorkbenchNavigation, WORKBENCH_OVERVIEW, type WorkbenchNavigationItem } from "../home/workbench-navigation";
import { createOriginButton, disposeOriginControls } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow, createSettingsGroup, createSettingsSection } from "./settings-v2";
import { defaultWorkbenchNavigation, isDefaultWorkbenchNavigation, type WorkbenchNavigationId, type WorkbenchNavigationSettings } from "./workbench-navigation-settings";

type NavigationChange = (settings: WorkbenchNavigationSettings) => WorkbenchNavigationSettings;
type NavigationFocus = { id: WorkbenchNavigationId; part: "handle" | "toggle" };
const navigationSaves = new WeakMap<CodexForObsidianPlugin, {
  tail: Promise<void>;
  committed: WorkbenchNavigationSettings;
  changes: Set<NavigationChange>;
  redraw(): void;
}>();

/** Desktop general settings: order and visibility of the workbench navigation. */
export function renderWorkbenchNavigationSettings(page: HTMLElement, plugin: CodexForObsidianPlugin, zh: boolean): void {
  const section = createSettingsSection(page, { title: zh ? "工作台导航" : "Workbench navigation", surface: "group" });
  section.addClass("echoink-workbench-nav-settings");
  section.setAttribute("data-echoink-focus-key", "general:workbench-navigation");
  const header = section.querySelector<HTMLElement>(".echoink-settings-section-header")!;
  const reset = createOriginButton(header, { cls: "is-tertiary echoink-workbench-nav-reset", text: zh ? "恢复默认" : "Restore default", attr: { type: "button" } });
  const group = createSettingsGroup(section);
  group.addClass("echoink-workbench-nav-list");
  let dragged: WorkbenchNavigationId | null = null;

  const label = (item: { zh: string; en: string }) => zh ? item.zh : item.en;
  const draft = () => {
    const saves = navigationSaves.get(plugin);
    return saves ? [...saves.changes].reduce((settings, change) => change(settings), saves.committed) : plugin.settings.workbenchNavigation;
  };
  const redraw = () => {
    if (!section.isConnected) return;
    const focused = section.ownerDocument.activeElement as HTMLElement | null;
    const id = focused?.dataset.workbenchNavHandle ?? focused?.dataset.workbenchNavToggle;
    render(id && section.contains(focused) ? { id: id as WorkbenchNavigationId, part: focused?.dataset.workbenchNavHandle ? "handle" : "toggle" } : undefined);
  };
  const commit = (change: NavigationChange, focus?: NavigationFocus) => {
    let saves = navigationSaves.get(plugin);
    if (!saves) {
      saves = { tail: Promise.resolve(), committed: plugin.settings.workbenchNavigation, changes: new Set(), redraw };
      navigationSaves.set(plugin, saves);
    }
    const queue = saves;
    queue.changes.add(change);
    render(focus);
    // Rebase each queued edit on the last saved value, so a later edit cannot
    // accidentally persist an unrelated change that already failed.
    queue.tail = queue.tail.then(async () => {
      const previous = plugin.settings.workbenchNavigation;
      const next = change(previous);
      plugin.settings.workbenchNavigation = next;
      try { await plugin.persistPiNativeSettings(); }
      catch (error) {
        if (plugin.settings.workbenchNavigation === next) plugin.settings.workbenchNavigation = previous;
        new Notice(failureText(error, ["工作台导航未能保存。", "Workbench navigation could not be saved."], NEXT.retry, plugin.settings.settingsLanguage));
      }
      const before = draft();
      queue.committed = plugin.settings.workbenchNavigation;
      queue.changes.delete(change);
      if (!queue.changes.size) navigationSaves.delete(plugin);
      const after = draft();
      if (JSON.stringify(before) !== JSON.stringify(after)) queue.redraw();
      plugin.refreshWorkbenchNavigation();
    });
  };
  const move = (id: WorkbenchNavigationId, target: WorkbenchNavigationId, after: boolean, focus?: "handle") => {
    if (id === target) return;
    commit(settings => {
      const order = settings.order.filter(item => item !== id);
      order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
      return { ...settings, order };
    }, focus ? { id, part: focus } : undefined);
  };
  const clearDropMarks = () => group.querySelectorAll(".is-drop-before, .is-drop-after").forEach(row => row.classList.remove("is-drop-before", "is-drop-after"));

  const row = (item: WorkbenchNavigationItem | typeof WORKBENCH_OVERVIEW, items: WorkbenchNavigationItem[], index: number, settings: WorkbenchNavigationSettings) => {
    const fixed = item.id === WORKBENCH_OVERVIEW.id;
    const setting = new OriginSetting(group).setName("");
    applySettingsRow(setting);
    const rowEl = setting.settingEl;
    rowEl.addClass("echoink-workbench-nav-row");
    rowEl.dataset.workbenchNav = item.id;
    const name = setting.nameEl;
    name.empty();
    if (fixed) name.createSpan({ cls: "echoink-workbench-nav-handle is-placeholder", attr: { "aria-hidden": "true" } });
    else {
      const id = item.id;
      const handle = createOriginButton(name, { cls: "is-icon echoink-workbench-nav-handle", attr: { type: "button", "aria-label": zh ? `调整「${item.zh}」的位置` : `Reorder ${item.en}`, "aria-keyshortcuts": "ArrowUp ArrowDown", "data-workbench-nav-handle": id } });
      setIcon(handle, "grip-vertical");
      // Only the handle starts a drag, so selecting text or using the switch never moves the row.
      handle.onpointerdown = () => { rowEl.draggable = true; };
      handle.onkeydown = event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const neighbour = items[index + (event.key === "ArrowUp" ? -1 : 1)];
        if (neighbour) move(id, neighbour.id, event.key === "ArrowDown", "handle");
      };
      rowEl.ondragstart = event => {
        dragged = id; rowEl.addClass("is-dragging");
        event.dataTransfer?.setData("text/plain", id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      };
      rowEl.ondragend = () => { dragged = null; rowEl.draggable = false; rowEl.removeClass("is-dragging"); clearDropMarks(); };
    }
    const icon = name.createSpan({ cls: "echoink-workbench-nav-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, item.icon);
    name.createSpan({ text: label(item) });
    if (fixed) return;
    const id = item.id;
    rowEl.ondragover = event => {
      if (!dragged || dragged === id) return;
      event.preventDefault();
      const box = rowEl.getBoundingClientRect(), after = event.clientY > box.top + box.height / 2;
      clearDropMarks(); rowEl.addClass(after ? "is-drop-after" : "is-drop-before");
    };
    rowEl.ondragleave = event => { if (!rowEl.contains(event.relatedTarget as Node | null)) rowEl.removeClass("is-drop-before", "is-drop-after"); };
    rowEl.ondrop = event => {
      if (!dragged || dragged === id) return;
      event.preventDefault();
      const after = rowEl.hasClass("is-drop-after");
      const source = dragged; dragged = null; clearDropMarks();
      move(source, id, after);
    };
    setting.addOriginToggle(toggle => {
      toggle.toggleEl.setAttribute("aria-label", zh ? `在导航栏显示「${item.zh}」` : `Show ${item.en} in navigation`);
      toggle.toggleEl.dataset.workbenchNavToggle = id;
      toggle.setValue(!settings.hidden.includes(id)).onChange(value => commit(current => {
        const hidden = current.hidden.filter(entry => entry !== id);
        if (!value) hidden.push(id);
        return { ...current, hidden };
      }, { id, part: "toggle" }));
    });
  };

  const render = (focus?: NavigationFocus) => {
    disposeOriginControls(group); group.empty();
    const settings = draft();
    const items = availableWorkbenchNavigation(plugin).sort((a, b) => settings.order.indexOf(a.id) - settings.order.indexOf(b.id));
    row(WORKBENCH_OVERVIEW, items, -1, settings);
    items.forEach((item, index) => row(item, items, index, settings));
    reset.hidden = isDefaultWorkbenchNavigation(settings);
    if (focus) group.querySelector<HTMLElement>(focus.part === "handle" ? `[data-workbench-nav-handle="${focus.id}"]` : `[data-workbench-nav-toggle="${focus.id}"]`)?.focus();
  };
  reset.onclick = () => { commit(() => defaultWorkbenchNavigation()); section.querySelector<HTMLElement>("[data-workbench-nav-handle]")?.focus(); };
  const activeSaves = navigationSaves.get(plugin);
  if (activeSaves) activeSaves.redraw = redraw;
  render();
}

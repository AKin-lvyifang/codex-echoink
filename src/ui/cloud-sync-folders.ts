import { setIcon } from "obsidian";
import type { CloudSyncController } from "../sync/cloud/controller";
import { cloudFolderState, toggleCloudFolder } from "../sync/cloud/scope";
import type { CloudSyncSettings } from "../sync/cloud/settings";

type Check = HTMLButtonElement & { checked: boolean; indeterminate?: boolean };
type Row = { row: HTMLElement; check: Check; twist: HTMLButtonElement; name: HTMLElement; where: HTMLElement; state: HTMLElement };
let labelSequence = 0;

export function cloudSyncScopeSummary(excludedFolders: readonly string[], zh: boolean): string {
  const count = excludedFolders.length;
  if (!count) return zh ? "整个仓库" : "Whole vault";
  return zh ? `整个仓库，除 ${count} 个文件夹` : `Whole vault, except ${count} folder${count === 1 ? "" : "s"}`;
}

/**
 * The sync scope as a folder tree, shared by all three settings surfaces; host controls keep their own appearance.
 * Everything syncs by default. Unchecking a folder excludes it and everything below it; new folders sync on their own.
 */
export function mountCloudSyncFolders(input: {
  parent: HTMLElement;
  controller: CloudSyncController;
  settings: () => CloudSyncSettings;
  save: () => Promise<void>;
  /** `labelledBy` is the id of the visible folder name. */
  createCheck: (parent: HTMLElement, labelledBy: string) => Check;
  disposeChecks: (parent: HTMLElement) => void;
  error: (error: unknown) => void;
  mobile?: boolean;
  zh?: boolean;
}): () => void {
  const zh = input.zh !== false, t = (cn: string, en: string) => zh ? cn : en;
  const list = input.parent.createDiv({ cls: "echoink-cloud-folder-list" });
  if (input.mobile) list.addClass("is-mobile-cloud-folders");
  const head = list.createDiv({ cls: "echoink-cloud-scope-head" });
  const summary = head.createSpan({ cls: "echoink-cloud-scope-summary", attr: { role: "status" } });
  const reset = head.createEl("button", { cls: "echoink-cloud-scope-reset", text: t("全部同步", "Sync everything"), attr: { type: "button" } });
  const search = list.createDiv({ cls: "echoink-cloud-scope-search" });
  setIcon(search.createSpan({ cls: "echoink-cloud-scope-search-icon", attr: { "aria-hidden": "true" } }), "search");
  const query = search.createEl("input", { cls: "echoink-cloud-scope-query", attr: { type: "search", placeholder: t("搜索文件夹", "Search folders"), spellcheck: "false", "data-echoink-transient": "" } });
  const tree = list.createDiv({ cls: "echoink-cloud-scope-tree" });
  const empty = tree.createDiv({ cls: "echoink-cloud-folder-empty" });
  empty.hidden = true;

  const rows = new Map<string, Row>();
  const children = new Map<string, string[]>(), loading = new Set<string>(), open = new Set<string>();
  let everything: string[] | null = null, searching = false;
  let disposed = false, saving = false, revision = -1;
  const excluded = () => input.settings().excludedFolders;
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const depthOf = (path: string) => path.split("/").length - 1;

  const load = (folder: string): void => {
    if (children.has(folder) || loading.has(folder)) return;
    loading.add(folder);
    void input.controller.folderChildren(folder).then(found => { if (!disposed) { children.set(folder, found); render(); } })
      .catch(error => { if (!disposed) { children.set(folder, []); input.error(error); } })
      .finally(() => { loading.delete(folder); });
  };
  const visible = (): string[] => {
    const needle = query.value.trim().toLowerCase();
    if (needle) return (everything ?? []).filter(path => nameOf(path).toLowerCase().includes(needle));
    const out: string[] = [];
    const walk = (folder: string): void => { for (const child of children.get(folder) ?? []) { out.push(child); if (open.has(child)) walk(child); } };
    walk("");
    return out;
  };
  const change = (next: string[] | Promise<string[]>): void => {
    if (saving) { render(); return; }
    const before = [...excluded()];
    saving = true; render();
    void Promise.resolve(next).then(async value => {
      input.settings().excludedFolders = value;
      render();
      await input.save(); input.controller.scopeChanged();
    }).catch(error => { input.settings().excludedFolders = before; if (!disposed) input.error(error); })
      .finally(() => { saving = false; if (!disposed) render(); });
  };
  const create = (path: string): Row => {
    const row = tree.createDiv({ cls: "echoink-cloud-folder-choice" }); row.dataset.path = path;
    const twist = row.createEl("button", { cls: "echoink-cloud-scope-twist", attr: { type: "button" } });
    setIcon(twist, "chevron-right");
    const labelId = `echoink-cloud-folder-${++labelSequence}`;
    const check = input.createCheck(row, labelId);
    const label = row.createEl("label", { cls: "echoink-cloud-scope-label" });
    const name = label.createSpan({ cls: "echoink-cloud-scope-name", attr: { id: labelId } });
    const where = label.createSpan({ cls: "echoink-cloud-scope-path" });
    const state = row.createSpan({ cls: "echoink-cloud-scope-state" });
    twist.addEventListener("click", () => { if (open.has(path)) open.delete(path); else { open.add(path); load(path); } render(); });
    label.addEventListener("click", event => { event.preventDefault(); if (!check.disabled) check.click(); });
    check.addEventListener("change", () => change(toggleCloudFolder(path, excluded(), folder => input.controller.folderChildren(folder))));
    return { row, check, twist, name, where, state };
  };
  const render = (): void => {
    if (disposed) return;
    const flat = !!query.value.trim(), paths = visible(), current = excluded();
    summary.setText(cloudSyncScopeSummary(current, zh));
    reset.hidden = !current.length; reset.disabled = saving;
    const shown = new Set(paths);
    for (const [path, entry] of rows) if (!shown.has(path)) { input.disposeChecks(entry.row); entry.row.remove(); rows.delete(path); }
    let previous: HTMLElement = empty;
    for (const path of paths) {
      let entry = rows.get(path);
      if (!entry) { entry = create(path); rows.set(path, entry); }
      if (previous.nextElementSibling !== entry.row) previous.after(entry.row);
      previous = entry.row;
      const value = cloudFolderState(path, current), below = current.filter(root => root !== path && root.startsWith(`${path}/`)).length;
      if (!flat) load(path);
      const expandable = !flat && (children.get(path)?.length ?? 0) > 0;
      entry.row.style.setProperty("--echoink-cloud-depth", String(flat ? 0 : depthOf(path)));
      entry.row.toggleClass("is-excluded", value === "false");
      entry.twist.toggleClass("is-blank", !expandable); entry.twist.disabled = !expandable; entry.twist.tabIndex = expandable ? 0 : -1;
      entry.twist.setAttribute("aria-expanded", String(open.has(path)));
      entry.twist.setAttribute("aria-labelledby", entry.name.id);
      if (entry.name.textContent !== nameOf(path)) entry.name.setText(nameOf(path));
      const location = flat ? parentOf(path).split("/").filter(Boolean).join(" / ") : "";
      if (entry.where.textContent !== location) entry.where.setText(location);
      const text = value === "false" ? t("不同步", "Not synced") : below ? t(`${below} 个不同步`, `${below} not synced`) : "";
      if (entry.state.textContent !== text) entry.state.setText(text);
      const checked = value !== "false", mixed = value === "mixed";
      if (entry.check.checked !== checked) entry.check.checked = checked;
      if ((entry.check.indeterminate ?? false) !== mixed) entry.check.indeterminate = mixed;
      if (entry.check.disabled !== saving) entry.check.disabled = saving;
    }
    const waiting = flat ? searching : !children.has("");
    empty.hidden = paths.length > 0 || waiting;
    empty.setText(flat ? t("没有这个名字的文件夹", "No folder with that name") : t("暂无文件夹", "No folders"));
  };
  const refresh = (): void => {
    // The controller also notifies on every sync status tick; folders are re-listed only when they may have changed.
    if (revision === input.controller.foldersRevision) { render(); return; }
    revision = input.controller.foldersRevision;
    everything = null;
    for (const folder of ["", ...open]) {
      void input.controller.folderChildren(folder).then(found => { if (!disposed) { children.set(folder, found); render(); } })
        .catch(error => { if (!disposed) input.error(error); });
    }
    if (query.value.trim()) find();
  };
  const find = (): void => {
    if (everything || searching) { render(); return; }
    searching = true; render();
    void input.controller.allFolders().then(found => { everything = found; }).catch(error => { if (!disposed) input.error(error); })
      .finally(() => { searching = false; render(); });
  };
  query.addEventListener("input", () => { if (query.value.trim()) find(); else render(); });
  reset.addEventListener("click", () => change([]));
  refresh();
  const unsubscribe = input.controller.subscribe(refresh);
  return () => { disposed = true; unsubscribe(); input.disposeChecks(list); list.remove(); };
}

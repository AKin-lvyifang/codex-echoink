import { setIcon } from "obsidian";
import { createOriginButton, createOriginInput, createOriginPagination, createOriginSelect } from "../settings/origin-controls";
import { createSettingsNavigationRow } from "../settings/settings-v2";
import { iphoneButton } from "../ui/iphone/workbench-elements";
import { JOURNAL_FORMAT_PRESETS, journalFormatError, journalPathForFormat, parseJournalDate } from "./journal-format";
import { journalFormatCopy } from "./journal-format-copy";
import type { JournalFormatService } from "./journal-format-service";

function el(parent: HTMLElement, tag: keyof HTMLElementTagNameMap, cls = "", text?: string): HTMLElement {
  return parent.createEl(tag, { cls, ...(text !== undefined ? { text } : {}) });
}
function icon(parent: HTMLElement, name: string) { const node = el(parent, "span", `journal-format-icon${name === "loader-circle" ? " is-spinning" : ""}`); node.setAttribute("aria-hidden", "true"); setIcon(node, name); return node; }
function actionContent(button: HTMLElement) { return button.querySelector<HTMLElement>(".ip-button-visible,.pd-settings-action-visible") ?? button; }
function action(parent: HTMLElement, text: string, run: () => void, primary = false, iconName?: string) {
  let button: HTMLButtonElement;
  if (parent.closest(".echoink-iphone,.ip-module-page")) { button = iphoneButton(parent.ownerDocument, text, run, primary ? "is-primary" : ""); parent.append(button); }
  else if (parent.closest(".echoink-ipad,.pd-module-page")) {
    button = el(parent, "button", `pd-settings-action${primary ? " is-primary" : ""}`) as HTMLButtonElement; button.type = "button";
    el(button, "span", "pd-settings-action-visible", text); button.onclick = () => { if (!button.disabled) run(); };
  } else { button = createOriginButton(parent, { text, cls: primary ? "button mod-cta" : "button" }); button.onclick = run; }
  if (iconName) { const content = actionContent(button); content.prepend(icon(content, iconName)); } return button;
}
export interface JournalSettingsViewOptions {
  language: string; mobile?: boolean; openOrganization(): void; templateCount?: number; openTemplates?(): void;
}
/** One business form, rendered using the platform's existing Origin adapters. */
export function mountJournalFormatSettings(parent: HTMLElement, service: JournalFormatService, options: JournalSettingsViewOptions): () => void {
  const root = el(parent, "div", `journal-format-settings${options.mobile ? " is-mobile" : ""}`), c = journalFormatCopy(options.language);
  let custom = !JOURNAL_FORMAT_PRESETS.includes(service.settings.format as typeof JOURNAL_FORMAT_PRESETS[number]);
  let draft = service.settings.format, error = "", disposed = false, previewTimer: number | undefined;
  const report = (failure: unknown) => { error = c.error(failure instanceof Error ? failure.message : String(failure)); render(); };
  const save = async (kind: "folder" | "format" | "template", value: string) => { try { await service.save(kind, value); await service.preview(); } catch (failure) { report(failure); } };
  const row = (name: string) => {
    const row = el(root, "div", "setting-item journal-format-row"); el(el(row, "div", "setting-item-info"), "div", "setting-item-name", name);
    return el(row, "div", "setting-item-control");
  };
  const select = (parent: HTMLElement, name: string, choices: { value: string; label: string }[], value: string, change: (value: string) => void) => {
    const field = createOriginSelect(parent, { attr: { "aria-label": name } }, choices, value, service.app).element;
    field.value = value; field.disabled = Boolean(service.busy);
    field.onchange = () => change(field.value); return field;
  };
  const render = () => {
    if (disposed) return;
    root.replaceChildren(); const settings = service.settings, plan = service.plan;
    let updatePeek = () => {};
    const folders = service.app.vault.getAllLoadedFiles().filter(file => "children" in file && file.path && !file.path.split("/").some(part => part.startsWith("."))).map(file => file.path);
    select(row(c.folder), c.folder, [...new Set([settings.folder, "", ...folders])].map(path => ({ value: path || "__root", label: path || c.root })), settings.folder || "__root", value => { void save("folder", value === "__root" ? "" : value); });
    const controls = row(c.format), line = el(controls, "div", "journal-format-controls");
    select(line, c.format, [...JOURNAL_FORMAT_PRESETS.map((value, index) => ({ value, label: journalPathForFormat(new Date(), "", value).slice(0, -3).replace(/\//gu, " / ") + (index === 0 ? c.t("（默认）", " (default)") : "") })), { value: "__custom", label: c.custom }], custom ? "__custom" : settings.format, value => {
      error = ""; if (value === "__custom") { custom = true; draft = settings.format; render(); root.querySelector<HTMLInputElement>("input")?.focus(); }
      else { custom = false; draft = value; void save("format", value); }
    });
    if (custom) {
      const input = createOriginInput(line, { value: draft, attr: { "aria-label": c.custom, spellcheck: "false" } }); input.disabled = Boolean(service.busy); input.dataset.journalFormat = "custom";
      const validation = el(controls, "div", "settings-error journal-format-error");
      const validate = () => { const invalid = journalFormatError(draft); validation.textContent = invalid ? c.invalid(invalid) : ""; input.setAttribute("aria-invalid", String(Boolean(invalid))); return !invalid; };
      validate(); input.oninput = () => {
        draft = input.value; validate();
        const win = root.ownerDocument.defaultView!;
        if (previewTimer !== undefined) win.clearTimeout(previewTimer);
        previewTimer = win.setTimeout(() => { previewTimer = undefined; updatePeek(); }, 120);
      };
      input.onblur = () => { if (validate() && draft.trim() !== service.settings.format) void save("format", draft.trim()); };
      input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); input.blur(); } };
    }
    const peek = el(root, "div", "journal-format-peek");
    updatePeek = () => {
      peek.replaceChildren();
      const previewFormat = custom && !journalFormatError(draft) ? draft.trim() : settings.format;
    const dir = el(peek, "div", "journal-format-tree-line is-directory"); icon(dir, "folder"); el(dir, "span", "", settings.folder || c.root);
    const journals = service.app.vault.getMarkdownFiles().flatMap(file => {
      const date = parseJournalDate(file.path, settings.folder, settings.format, settings.formatHistory); return date ? [{ path: file.path, date }] : [];
    }).sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
    let todayTarget = "";
    try { todayTarget = journalPathForFormat(new Date(), settings.folder, previewFormat); } catch { /* Show invalid native settings without creating a preview path. */ }
    const recent = journals.filter(entry => entry.path !== todayTarget).slice(0, 2);
    const existingToday = journals.some(entry => entry.path === todayTarget);
    const visibleFiles = new Set([...journals.map(entry => entry.path), ...(plan?.moves.map(file => file.from) ?? []), ...(plan?.unknown.map(file => file.path) ?? []), ...(plan?.keep.map(file => file.from) ?? [])].filter(path => service.app.vault.getAbstractFileByPath(path)));
    const remaining = visibleFiles.size - recent.length - (existingToday ? 1 : 0);
    if (remaining > 0) el(peek, "div", "journal-format-more", c.more(remaining));
    const seen = new Set<string>();
    const treePath = (path: string, today = false) => {
      const parts = path.slice(settings.folder ? settings.folder.length + 1 : 0).split("/");
      parts.forEach((part, index) => {
        const last = index === parts.length - 1, key = parts.slice(0, index + 1).join("/");
        if (!last && seen.has(key)) return; seen.add(key);
        const line = el(peek, "div", `journal-format-tree-line${last && today ? " is-today" : ""}`); line.style.paddingInlineStart = `${20 * (index + 1)}px`;
        icon(line, last ? today && !existingToday ? "file-plus" : "file-text" : "folder"); el(line, "span", "journal-format-path", part);
        if (today && last) el(line, "span", "journal-format-today", c.today);
      });
    };
    for (const entry of recent.reverse()) treePath(entry.path);
    if (todayTarget) treePath(todayTarget, true);
    const record = service.record && (service.record.status === "interrupted" || service.record.folder === settings.folder && service.record.format === settings.format) ? service.record : null, moved = record?.entries.filter(entry => entry.state === "moved" || entry.state === "restoring").length ?? 0;
    const off = plan ? plan.moves.length + plan.unknown.length + plan.keep.length : 0;
    if (moved || off || record?.status === "interrupted") {
      const bar = el(peek, "div", "journal-format-bar"); icon(bar, moved ? "check" : "folder-sync"); el(bar, "span", "", record?.status === "interrupted" ? c.interrupted : moved ? c.moved(moved) : c.off(off));
      action(bar, moved || record?.status === "interrupted" ? c.view : c.organize, () => options.openOrganization());
    }
    };
    updatePeek();
    const templateFiles = service.app.vault.getMarkdownFiles().filter(file => !settings.templatesFolder || file.path.startsWith(`${settings.templatesFolder}/`));
    const choices = [{ value: "__none", label: c.none }, { value: "__quick", label: c.t("此刻速记", "Quick journal") }, ...templateFiles.map(file => ({ value: file.path, label: file.basename }))];
    if (settings.template && !choices.some(item => item.value === settings.template)) choices.push({ value: settings.template, label: settings.template.split("/").at(-1)!.replace(/\.md$/iu, "") });
    select(row(c.template), c.template, choices, settings.template || "__none", value => { void save("template", value === "__none" ? "" : value); });
    if (options.openTemplates) createSettingsNavigationRow(root, { title: c.templates, focusKey: "journal:templates", value: c.count(options.templateCount ?? templateFiles.length), onActivate: () => options.openTemplates?.() });
    if (error || service.error) el(root, "div", "settings-error", error || c.error(service.error)).setAttribute("role", "alert");
  };
  const release = service.subscribe(() => { if (root.isConnected !== false) render(); }); render();
  void service.initialize().then(async () => { if (!service.busy && !service.plan) await service.preview(); else render(); }).catch(report);
  return () => { disposed = true; if (previewTimer !== undefined) root.ownerDocument.defaultView?.clearTimeout(previewTimer); release(); };
}

export function mountJournalOrganization(parent: HTMLElement, service: JournalFormatService, language: string, onFinish?: () => void): () => void {
  const root = el(parent, "div", "journal-organization"), c = journalFormatCopy(language);
  root.classList.toggle("is-mobile", Boolean(parent.closest(".echoink-iphone,.echoink-ipad,.echoink-mobile,.ip-module-page,.pd-module-page")));
  let all = false, page = 1, keepPage = 1, aiPage = 1, error = "", disposed = false, showUndoResult = false;
  const run = (operation: () => Promise<unknown>) => { error = ""; void operation().catch(failure => { error = c.error(failure instanceof Error ? failure.message : String(failure)); render(); }); };
  const section = (title: string, count: number) => { const section = el(root, "section", "journal-organization-section"), heading = el(section, "div", "journal-organization-heading"); el(heading, "h2", "", title); el(heading, "span", "journal-organization-count", String(count)); return { section, heading, list: el(section, "div", "journal-organization-list") }; };
  const moveRow = (parent: HTMLElement, from: string, to: string, why = false) => { const row = el(parent, "div", "journal-organization-move"); el(row, "span", "journal-format-path", relative(from)); icon(row, "arrow-right"); el(row, "span", why ? "journal-organization-reason" : "journal-format-path", to); };
  const relative = (path: string) => service.plan?.folder && path.startsWith(`${service.plan.folder}/`) ? path.slice(service.plan.folder.length + 1) : path;
  const render = () => {
    if (disposed) return; root.replaceChildren(); const plan = service.plan, record = service.record && (service.record.status === "interrupted" || service.record.folder === service.settings.folder && service.record.format === service.settings.format) && (service.record.status !== "undone" || showUndoResult) ? service.record : null;
    if (!plan && !record) { el(root, "div", "", c.loading); return; }
    const completed = record && record.status !== "running", locked = Boolean(service.busy) || Boolean(completed), regular = completed && record ? record.entries.filter(move => !move.ai && move.state !== "skipped") : plan?.moves.filter(move => !move.ai) ?? [];
    if (regular.length) {
      const group = section(c.move, regular.length), visible = all ? regular.slice((page - 1) * 20, page * 20) : regular.slice(0, 3);
      for (const move of visible) moveRow(group.list, move.from, relative(move.to));
      if (regular.length > 3 && !all) action(el(group.list, "div", "journal-organization-more"), c.all(regular.length), () => { all = true; render(); });
      if (all) createOriginPagination(group.section, page, Math.ceil(regular.length / 20), value => { page = value; render(); });
    }
    const unknown = completed ? [] : plan?.unknown ?? [];
    const identified = service.identified.length ? service.identified : completed && record ? [
      ...record.entries.filter(entry => entry.ai && entry.state !== "skipped").map(entry => ({ from: entry.from, to: entry.to, evidence: entry.evidence })),
      ...(record.entries.some(entry => entry.ai) ? record.keep.filter(entry => entry.reason === "unknown").map(entry => ({ from: entry.from, to: undefined, evidence: undefined })) : [])
    ] : [];
    if (unknown.length || identified.length) {
      const group = section(c.ai, unknown.length + identified.length);
      if ((!locked || service.busy === "ai") && unknown.length) {
        const button = action(group.heading, service.busy === "ai" ? c.identifying : c.identify, () => run(() => service.identify())); button.disabled = !service.model || Boolean(service.busy); if (service.busy === "ai") { const content = actionContent(button); content.prepend(icon(content, "loader-circle")); }
        const info = el(group.section, "div", "journal-organization-quota", service.model ? c.quota(unknown.length, service.model) : c.modelMissing); group.section.insertBefore(info, group.list);
      }
      for (const file of unknown.slice((aiPage - 1) * 20, aiPage * 20)) moveRow(group.list, file.path, service.busy === "ai" ? `${c.identifying}…` : c.waiting, true);
      if (unknown.length > 20) createOriginPagination(group.section, aiPage, Math.ceil(unknown.length / 20), value => { aiPage = value; render(); });
      for (const item of identified) moveRow(group.list, item.from, item.to ? `${relative(String(item.to))}${item.evidence ? ` · ${item.evidence}` : ""}` : c.reason("unknown"), !item.to);
    }
    const retained = record ? [...record.keep, ...record.entries.filter(entry => entry.reason && entry.state !== "skipped").map(entry => ({ from: entry.to, reason: entry.reason! }))] : plan?.keep ?? [];
    const keep = retained.filter(entry => !identified.some(item => item.from === entry.from && !item.to));
    if (keep.length) { const group = section(c.keep, keep.length); for (const item of keep.slice((keepPage - 1) * 20, keepPage * 20)) moveRow(group.list, item.from, `${c.reason(item.reason)}${"to" in item && typeof item.to === "string" && item.to ? `：${relative(item.to)}` : ""}`, true); if (keep.length > 20) createOriginPagination(group.section, keepPage, Math.ceil(keep.length / 20), value => { keepPage = value; render(); }); }
    const foot = el(root, "div", "journal-organization-footer"); foot.setAttribute("aria-live", "polite");
    if (service.busy === "move" || service.busy === "undo") {
      icon(foot, "loader-circle"); const progress = el(foot, "progress") as HTMLProgressElement; progress.max = service.total || 1; progress.value = service.progress; el(foot, "span", "", `${service.progress} / ${service.total}`); foot.setAttribute("aria-busy", "true");
    } else if (completed) {
      const restored = record.entries.filter(entry => entry.state === "restored").length, moved = record.entries.filter(entry => entry.state === "moved").length;
      icon(foot, record.status === "undone" ? "undo-2" : "check");
      el(foot, "span", "", record.status === "undone" ? c.undone(restored) : restored || record.entries.some(entry => entry.reason) ? c.partialUndo(restored, moved) : c.complete(moved, record.keep.length));
      if (record.status !== "undone" && (moved || record.entries.some(entry => entry.state === "prepared" || entry.state === "restoring"))) action(foot, c.undo, () => { showUndoResult = true; run(() => service.undo()); }, false, "undo-2");
      if (record.status === "undone" && onFinish) action(foot, c.finish, onFinish);
      if (record.status === "interrupted") el(root, "div", "settings-error", c.interrupted);
    } else {
      const total = plan?.moves.length ?? 0;
      el(foot, "span", "", total && !service.linkUpdatesEnabled ? c.error("journal_links_disabled") : !total ? unknown.length ? c.aiOnly : c.empty : unknown.length ? c.beforeAi : "");
      const button = action(foot, c.run(total), () => run(() => service.execute()), true); button.disabled = Boolean(service.busy) || !total || !service.linkUpdatesEnabled;
    }
    if (error || service.error) el(root, "div", "settings-error", error || c.error(service.error)).setAttribute("role", "alert");
  };
  const release = service.subscribe(() => { if (root.isConnected !== false) render(); }); render();
  void service.initialize().then(async () => { if (!service.plan) await service.preview(); else render(); }).catch(failure => { error = c.error(String(failure)); render(); });
  return () => { disposed = true; release(); };
}

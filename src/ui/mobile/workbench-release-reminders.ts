import { Component, MarkdownRenderer, type App } from "obsidian";
import type { ReleaseNotes, ReleaseUpdateController } from "../../settings/release-update";
import { releaseReminderRows } from "../release-reminders";
import { shellElement, shellIconButton } from "./shell-controls";
import type { MobileShellPage } from "./shell-types";

interface ReleaseReminderHost {
  app: App;
  version?: string;
  releaseUpdate?: ReleaseUpdateController;
  settings: () => { settingsLanguage: string };
}

export function mountMobileReleaseReminders(
  home: HTMLElement,
  container: HTMLElement,
  host: ReleaseReminderHost,
  platform: "ip" | "pd",
  controls: {
    icon: (document: Document, name: string) => HTMLElement;
    button: (document: Document, text: string, action: () => void) => HTMLButtonElement;
  },
  shell: { push(page: MobileShellPage): Promise<boolean> }
): { refresh(): void; dispose(): void } {
  const document = container.ownerDocument, win = document.defaultView;
  const controller = host.releaseUpdate, version = host.version;
  const { icon, button } = controls;
  let signature = "";
  let opening = false;

  async function openNotes(notes: ReleaseNotes): Promise<void> {
    if (opening) return;
    opening = true;
    const english = host.settings().settingsLanguage === "en";
    const content = shellElement(document, "article", "echoink-mobile-release-notes markdown-rendered");
    const component = new Component();
    component.load();
    let disposed = false;
    const dispose = () => { disposed = true; component.unload(); };
    try {
      if (!await shell.push({ id: "release-notes", title: notes.title, content, dispose })) {
        dispose();
        return;
      }
      await MarkdownRenderer.render(host.app, notes.markdown, content, "", component);
      if (!disposed && content.isConnected) controller?.markNotesSeen(notes.version);
    } catch {
      if (!disposed) content.textContent = english ? "Could not display release notes." : "暂时无法显示版本说明。";
    } finally { opening = false; }
  }

  function refresh(): void {
    if (!controller || !version) return;
    const language = host.settings().settingsLanguage;
    const entries = releaseReminderRows(controller, version, language, document, openNotes);
    const next = JSON.stringify([language, entries.map(entry => [entry.kind, entry.version])]);
    if (signature === next) return;
    signature = next;
    container.replaceChildren();
    container.hidden = !entries.length;
    for (const entry of entries) {
      const row = shellElement(document, "div", `${platform}-row echoink-mobile-release-row`);
      row.dataset.releaseReminder = entry.kind;
      const actions = shellElement(document, "div", "echoink-mobile-release-actions");
      actions.append(button(document, entry.action, () => { void entry.select(); }),
        shellIconButton(document, entry.close, "x", entry.dismiss));
      row.append(icon(document, entry.icon), shellElement(document, "span", `${platform}-grow`, entry.text), actions);
      container.append(row);
    }
  }

  container.hidden = true;
  if (!controller || !version || !win) return { refresh, dispose() {} };
  const unsubscribe = controller.subscribe(refresh);
  let visible = !win.IntersectionObserver;
  const check = () => { if (visible && !document.hidden) void controller.checkIfStale(version); };
  const observer = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    check();
  }) : undefined;
  observer?.observe(home);
  document.addEventListener("visibilitychange", check);
  win.addEventListener("focus", check);
  refresh();
  check();
  return { refresh, dispose() {
    unsubscribe();
    observer?.disconnect();
    document.removeEventListener("visibilitychange", check);
    win.removeEventListener("focus", check);
  } };
}

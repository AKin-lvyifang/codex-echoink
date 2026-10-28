import { apiVersion, Modal, Notice, Platform } from "obsidian";
import type { IPhonePageContext, IPhoneWorkbenchHost } from "../ui/iphone/workbench-contract";
import type { IPadPageContext } from "../ui/ipad/workbench-contract";
import type { MobileShellSheet } from "../ui/mobile/shell-types";
import { shellElement, shellIconButton } from "../ui/mobile/shell-controls";
import { collectMobileRunReport } from "./mobile-collector";
import { configuredReportSecrets, freezeReport, reportWithoutConversation, type ReportSnapshot } from "./report";
import { runErrors } from "./recent-errors";
import { saveRunReport } from "./vault-export";
import { createRunReportForm } from "./form";
import { uploadRunReport } from "./upload";

type MobileReportHost = Pick<IPhoneWorkbenchHost, "app" | "store" | "runtime" | "version" | "settings" | "accountService">;
type Surface = "iphone" | "ipad";
function capture(host: MobileReportHost, taskId: string | undefined, surface: Surface): ReportSnapshot {
  const environment = { pluginVersion: host.version ?? "unknown", obsidianVersion: apiVersion,
    platform: Platform.isIosApp ? "ios" : "android", surface, language: "zh" as const, membership: host.accountService?.read().membership.planId || "free" };
  const task = taskId ? host.store.getSession(taskId) : undefined;
  if (taskId && !task) throw new Error("会话已不存在。");
  const report = task ? collectMobileRunReport(task, environment, runErrors.snapshot(), host.runtime.stateFor(task.id).error)
    : reportWithoutConversation(environment, runErrors.snapshot());
  const adapter = host.app.vault.adapter as typeof host.app.vault.adapter & { getBasePath?: () => string };
  return freezeReport(report, { secrets: configuredReportSecrets(host.settings()), vaultPath: adapter.getBasePath?.() });
}
async function exportFile(host: MobileReportHost, snapshot: ReportSnapshot): Promise<void> {
  const path = await saveRunReport(host.app, snapshot); new Notice(`已导出到笔记库：${path}`, 10000);
}
function mobileButton(doc: Document, parent: HTMLElement, label: string, action: () => void, primary = false): HTMLButtonElement {
  const button = shellElement(doc, "button", `echoink-run-report-button${primary ? " is-primary" : ""}`, label);
  button.type = "button"; button.onclick = action; parent.append(button); return button;
}

/** Task entries stay in their pane; a global Notice can report without opening any conversation. */
export function openMobileRunReport(host: MobileReportHost, taskId: string | undefined, surface: Surface,
  sheet?: { document: Document; open(config: MobileShellSheet): void }): void {
  const snapshot = capture(host, taskId, surface);
  const doc = sheet?.document ?? host.app.workspace.containerEl.ownerDocument;
  const form = createRunReportForm({ document: doc, snapshot,
    button: (parent, label, action, primary) => mobileButton(doc, parent, label, action, primary),
    upload: snapshot => uploadRunReport(snapshot, host.accountService), export: snapshot => exportFile(host, snapshot) });
  if (sheet) { sheet.open({ title: "上报问题", content: form.content, footer: form.footer, onClose: form.dispose }); return; }
  const modal = new Modal(host.app);
  modal.onOpen = () => { modal.modalEl.addClass("echoink-run-report-modal", "echoink-run-report-mobile-modal", `is-${surface}`); modal.setTitle("上报问题"); modal.contentEl.append(form.content, form.footer); };
  modal.onClose = () => { form.dispose(); modal.contentEl.empty(); };
  modal.open();
}

export function mobileReportActions(ctx: IPhonePageContext | IPadPageContext, taskId: string, surface: Surface): HTMLElement {
  const { host, document: doc } = ctx;
  const actions = shellElement(doc, "div", "echoink-run-report-header-actions");
  let pending = false;
  actions.append(shellIconButton(doc, "会话运行记录", "ellipsis", () => {
    const menu = shellElement(doc, "div", "echoink-run-report-menu");
    const choose = (report: boolean) => {
      if (pending) return; pending = true;
      try {
        ctx.shell.closeSheet();
        if (report) openMobileRunReport(host, taskId, surface, { document: doc, open: config => ctx.shell.openSheet(config) });
        else void exportFile(host, capture(host, taskId, surface)).catch(ctx.error);
      } catch (error) { ctx.error(error); } finally { pending = false; }
    };
    mobileButton(doc, menu, "导出运行记录", () => choose(false)); mobileButton(doc, menu, "上报问题", () => choose(true));
    ctx.shell.openSheet({ title: "会话运行记录", content: menu });
  }));
  return actions;
}

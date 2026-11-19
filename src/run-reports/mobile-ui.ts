import { apiVersion, Modal, Notice, Platform, type WorkspaceLeaf } from "obsidian";
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
import { reportExportMessage, type RunReportLogin } from "./login";

type MobileReportHost = Pick<IPhoneWorkbenchHost, "app" | "store" | "runtime" | "version" | "settings" | "accountService"> & { reportLogin?: RunReportLogin; openLegacy?: IPhoneWorkbenchHost["openLegacy"] };
interface ReportSheet { document: Document; open(config: MobileShellSheet): void; close(): void; restore(): Promise<boolean>; }
type Surface = "iphone" | "ipad";
function capture(host: MobileReportHost, taskId: string | undefined, surface: Surface): ReportSnapshot {
  const environment = { pluginVersion: host.version ?? "unknown", obsidianVersion: apiVersion,
    platform: Platform.isIosApp ? "ios" : "android", surface, language: host.settings().settingsLanguage === "en" ? "en" as const : "zh" as const, membership: host.accountService?.read().membership.planId || "free" };
  const task = taskId ? host.store.getSession(taskId) : undefined;
  if (taskId && !task) throw new Error("会话已不存在。");
  const report = task ? collectMobileRunReport(task, environment, runErrors.snapshot(), host.runtime.stateFor(task.id).error)
    : reportWithoutConversation(environment, runErrors.snapshot());
  const adapter = host.app.vault.adapter as typeof host.app.vault.adapter & { getBasePath?: () => string };
  return freezeReport(report, { secrets: configuredReportSecrets(host.settings()), vaultPath: adapter.getBasePath?.() });
}
async function exportFile(host: MobileReportHost, snapshot: ReportSnapshot, support = false): Promise<void> {
  const path = await saveRunReport(host.app, snapshot); new Notice(reportExportMessage(path, host.settings().settingsLanguage === "en", support), 15000);
}
function mobileButton(doc: Document, parent: HTMLElement, label: string, action: () => void, primary = false): HTMLButtonElement {
  const button = shellElement(doc, "button", `echoink-run-report-button${primary ? " is-primary" : ""}`, label);
  button.type = "button"; button.onclick = action; parent.append(button); return button;
}

/** Task entries stay in their pane; a global Notice can report without opening any conversation. */
export function openMobileRunReport(host: MobileReportHost, taskId: string | undefined, surface: Surface, sheet?: ReportSheet): void {
  openSnapshot(host, capture(host, taskId, surface), surface, sheet);
}
function openSnapshot(host: MobileReportHost, snapshot: ReportSnapshot, surface: Surface, sheet?: ReportSheet): void {
  const doc = sheet?.document ?? host.app.workspace.containerEl.ownerDocument;
  const english = host.settings().settingsLanguage === "en", title = english ? "Report a problem" : "上报问题";
  let modal: Modal | undefined;
  const form = createRunReportForm({ document: doc, snapshot, english,
    signedIn: () => !!host.accountService?.read().identity,
    login: host.reportLogin && host.openLegacy ? async current => {
      let source: WorkspaceLeaf | undefined;
      host.app.workspace.iterateAllLeaves(leaf => { if (leaf.view.containerEl.contains(form.content)) source = leaf; });
      const cancel = host.reportLogin!.request(current, source ?? doc, async (restored, active) => {
        if (source?.view.containerEl.isConnected) await host.app.workspace.revealLeaf(source);
        if (!active()) return;
        const target = sheet && await sheet.restore() ? sheet : undefined;
        if (!active()) return;
        openSnapshot(host, restored, surface, target);
      });
      if (sheet) sheet.close(); else modal?.close();
      try { await host.openLegacy!("account"); }
      catch {
        cancel(); openSnapshot(host, current, surface, sheet);
        new Notice(english ? "Account settings did not open. Try again or export the file." : "账号页未打开，请重试或改为导出文件。");
      }
    } : undefined,
    button: (parent, label, action, primary) => mobileButton(doc, parent, label, action, primary),
    upload: snapshot => uploadRunReport(snapshot, host.accountService), export: (snapshot, support) => exportFile(host, snapshot, support) });
  if (sheet) { sheet.open({ title, content: form.content, footer: form.footer, onClose: form.dispose }); return; }
  const reportModal = modal = new Modal(host.app);
  reportModal.onOpen = () => { reportModal.modalEl.addClass("echoink-run-report-modal", "echoink-run-report-mobile-modal", `is-${surface}`); reportModal.setTitle(title); reportModal.contentEl.append(form.content, form.footer); };
  reportModal.onClose = () => { form.dispose(); reportModal.contentEl.empty(); };
  reportModal.open();
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
        if (report) openMobileRunReport(host, taskId, surface, { document: doc, open: config => ctx.shell.openSheet(config), close: () => { ctx.shell.closeSheet(); }, restore: () => ctx.shell.backTo(`task:${taskId}`) });
        else void exportFile(host, capture(host, taskId, surface)).catch(ctx.error);
      } catch (error) { ctx.error(error); } finally { pending = false; }
    };
    mobileButton(doc, menu, "导出运行记录", () => choose(false)); mobileButton(doc, menu, "上报问题", () => choose(true));
    ctx.shell.openSheet({ title: "会话运行记录", content: menu });
  }));
  return actions;
}

import { apiVersion, Notice, Platform } from "obsidian";
import type { IPhonePageContext } from "../ui/iphone/workbench-contract";
import type { IPadPageContext } from "../ui/ipad/workbench-contract";
import { shellElement, shellIconButton } from "../ui/mobile/shell-controls";
import { collectMobileRunReport } from "./mobile-collector";
import { configuredReportSecrets, freezeReport, type ReportSnapshot } from "./report";
import { runErrors } from "./recent-errors";
import { saveRunReport } from "./vault-export";
import { createRunReportForm } from "./form";
import { uploadRunReport } from "./upload";

export function mobileReportActions(ctx: IPhonePageContext | IPadPageContext, taskId: string, surface: "iphone" | "ipad"): HTMLElement {
  const { host, document: doc } = ctx;
  const actions = shellElement(doc, "div", "echoink-run-report-header-actions");
  const capture = (): ReportSnapshot => {
    const task = host.store.getSession(taskId); if (!task) throw new Error("会话已不存在。");
    const adapter = host.app.vault.adapter as typeof host.app.vault.adapter & { getBasePath?: () => string };
    return freezeReport(collectMobileRunReport(task, { pluginVersion: host.version ?? "unknown", obsidianVersion: apiVersion,
      platform: Platform.isIosApp ? "ios" : "android", surface, language: "zh", membership: host.accountService?.read().membership.planId || "free" }, runErrors.snapshot(), host.runtime.stateFor(taskId).error),
    { secrets: configuredReportSecrets(host.settings()), vaultPath: adapter.getBasePath?.() });
  };
  const exportFile = async (snapshot: ReportSnapshot) => { const path = await saveRunReport(host.app, snapshot); new Notice(`已导出到笔记库：${path}`, 10000); };
  const button = (parent: HTMLElement, label: string, action: () => void, primary = false) => {
    const button = shellElement(doc, "button", `echoink-run-report-button${primary ? " is-primary" : ""}`, label); button.type = "button"; button.onclick = action; parent.append(button); return button;
  };
  let pending = false;
  actions.append(shellIconButton(doc, "会话运行记录", "ellipsis", () => {
    const menu = shellElement(doc, "div", "echoink-run-report-menu");
    const choose = (report: boolean) => {
      if (pending) return; pending = true;
      try {
        const snapshot = capture(); ctx.shell.closeSheet();
        if (report) {
          const form = createRunReportForm({ document: doc, snapshot, button, upload: snapshot => uploadRunReport(snapshot, host.accountService), export: exportFile });
          ctx.shell.openSheet({ title: "上报问题", content: form.content, footer: form.footer, onClose: form.dispose });
        } else void exportFile(snapshot).catch(ctx.error);
      } catch (error) { ctx.error(error); } finally { pending = false; }
    };
    button(menu, "导出运行记录", () => choose(false)); button(menu, "上报问题", () => choose(true));
    ctx.shell.openSheet({ title: "会话运行记录", content: menu });
  }));
  return actions;
}

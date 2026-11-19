import { ownedFragment, ownedEl } from "../ui/owned-dom";
import { Modal, Notice, type App } from "obsidian";
import { getDesktopPath } from "../platform/desktop-paths";
import type { AccountService } from "../membership/account-service";
import { showItemInFinder } from "../core/electron";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { createRunReportForm } from "./form";
import type { ReportSnapshot } from "./report";
import { saveRunReport } from "./vault-export";
import { uploadRunReport } from "./upload";
import { reportExportMessage, type RunReportLogin } from "./login";

const path = getDesktopPath();

export async function exportDesktopRunReport(app: App, vaultPath: string, snapshot: ReportSnapshot, english = false, support = false): Promise<void> {
  const file = await saveRunReport(app, snapshot);
  const doc = app.workspace.containerEl.ownerDocument;
  const fragment = ownedFragment(doc); fragment.append(`${reportExportMessage(file, english, support)} `);
  const reveal = ownedEl(doc, "button"); reveal.type = "button"; reveal.textContent = english ? "Show in folder" : "在文件夹中显示";
  reveal.onclick = () => { if (!showItemInFinder(path.join(vaultPath, file))) new Notice(english ? "Cannot open the folder" : "无法打开文件夹"); }; fragment.append(reveal);
  new Notice(fragment, 15000);
}

export class RunReportModal extends Modal {
  private disposeForm?: () => void;
  constructor(app: App, private readonly snapshot: ReportSnapshot, private readonly vaultPath: string, private readonly account?: AccountService | null, private readonly english = false,
    private readonly login?: RunReportLogin, private readonly openAccount?: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("echoink-run-report-modal"); this.setTitle(this.english ? "Report a problem" : "上报问题");
    const form = createRunReportForm({ document: this.contentEl.ownerDocument, snapshot: this.snapshot, english: this.english,
      signedIn: () => !!this.account?.read().identity,
      login: this.login && this.openAccount ? async snapshot => {
        const cancel = this.login!.request(snapshot, this, restored => {
          (this.app as App & { setting?: { close(): void } }).setting?.close();
          new RunReportModal(this.app, restored, this.vaultPath, this.account, this.english, this.login, this.openAccount).open();
        });
        this.close();
        try { await this.openAccount!(); }
        catch {
          cancel(); new RunReportModal(this.app, snapshot, this.vaultPath, this.account, this.english, this.login, this.openAccount).open();
          new Notice(this.english ? "Account settings did not open. Try again or export the file." : "账号页未打开，请重试或改为导出文件。");
        }
      } : undefined,
      button: (parent, text, action, primary) => { const button = createOriginButton(parent, { text, cls: primary ? "mod-cta" : "", attr: { type: "button" } }); button.onclick = action; return button; },
      upload: snapshot => uploadRunReport(snapshot, this.account), export: (snapshot, support) => exportDesktopRunReport(this.app, this.vaultPath, snapshot, this.english, support) });
    this.disposeForm = form.dispose; this.contentEl.append(form.content, form.footer);
  }
  onClose(): void { this.disposeForm?.(); disposeOriginControls(this.contentEl); this.contentEl.empty(); }
}

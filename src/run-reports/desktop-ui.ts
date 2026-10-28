import { Modal, Notice, type App } from "obsidian";
import { getDesktopPath } from "../platform/desktop-paths";
import type { AccountService } from "../membership/account-service";
import { showItemInFinder } from "../core/electron";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { createRunReportForm } from "./form";
import type { ReportSnapshot } from "./report";
import { saveRunReport } from "./vault-export";
import { uploadRunReport } from "./upload";

const path = getDesktopPath();

export async function exportDesktopRunReport(app: App, vaultPath: string, snapshot: ReportSnapshot, english = false): Promise<void> {
  const file = await saveRunReport(app, snapshot);
  const doc = app.workspace.containerEl.ownerDocument;
  const fragment = doc.createDocumentFragment(); fragment.append(`${english ? "Exported to Vault" : "已导出到笔记库"}：${file} `);
  const reveal = doc.createElement("button"); reveal.type = "button"; reveal.textContent = english ? "Show in folder" : "在文件夹中显示";
  reveal.onclick = () => { if (!showItemInFinder(path.join(vaultPath, file))) new Notice(english ? "Cannot open the folder" : "无法打开文件夹"); }; fragment.append(reveal);
  new Notice(fragment, 15000);
}

export class RunReportModal extends Modal {
  private disposeForm?: () => void;
  constructor(app: App, private readonly snapshot: ReportSnapshot, private readonly vaultPath: string, private readonly account?: AccountService | null, private readonly english = false) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("echoink-run-report-modal"); this.setTitle(this.english ? "Report a problem" : "上报问题");
    const form = createRunReportForm({ document: this.contentEl.ownerDocument, snapshot: this.snapshot, english: this.english,
      button: (parent, text, action, primary) => { const button = createOriginButton(parent, { text, cls: primary ? "mod-cta" : "", attr: { type: "button" } }); button.onclick = action; return button; },
      upload: snapshot => uploadRunReport(snapshot, this.account), export: snapshot => exportDesktopRunReport(this.app, this.vaultPath, snapshot, this.english) });
    this.disposeForm = form.dispose; this.contentEl.append(form.content, form.footer);
  }
  onClose(): void { this.disposeForm?.(); disposeOriginControls(this.contentEl); this.contentEl.empty(); }
}

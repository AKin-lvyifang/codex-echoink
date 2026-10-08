import { ProPluginControls } from "../ui/pro-plugin-controls";
import { getProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import { App, Modal, Notice } from "obsidian";
import { createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { fingerprint, normalizePrivacy, splitDiaryBlocks } from "./model";
import type { DiaryPrivacy, ProcessingMode } from "./types";
import { diaryButton, diaryError } from "./ui";

export function reviewDiaryPrivacy(app: App, content: string, previous: DiaryPrivacy | null, save: (privacy: DiaryPrivacy) => Promise<void>, access: CapabilityAccess = unavailableCapabilityAccess): Promise<DiaryPrivacy | null> {
  return new Promise((resolve) => new DiaryPrivacyModal(app, content, previous, save, resolve, access).open());
}

class DiaryPrivacyModal extends Modal {
  private settled = false;
  private saving = false;
  private controls?: ProPluginControls;
  constructor(app: App, private readonly source: string, private readonly previous: DiaryPrivacy | null, private readonly save: (privacy: DiaryPrivacy) => Promise<void>, private readonly done: (privacy: DiaryPrivacy | null) => void, private readonly access: CapabilityAccess) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("echoink-diary-modal");
    this.contentEl.createEl("h2", { text: "内容发送范围" });
    this.contentEl.createEl("p", { cls: "echoink-diary-description", text: "“保留原样”仍会发送给当前模型；“不发送”只留在本地，解释追问也不会发送。" });
    const blocks = splitDiaryBlocks(this.source);
    let privacy: DiaryPrivacy;
    try { privacy = normalizePrivacy(blocks, fingerprint(this.source), this.previous); }
    catch {
      privacy = { sourceFingerprint: fingerprint(this.source), rules: blocks.map((block) => ({ blockId: block.id, mode: "exclude" })) };
      this.contentEl.createDiv({ cls: "echoink-diary-notice", text: "原稿已改变，旧的发送范围无法完整对应。已暂设为全部不发送，请逐段确认。" });
    }
    const modes = new Map(privacy.rules.map((rule) => [rule.blockId, rule.mode]));
    const list = this.contentEl.createDiv({ cls: "echoink-diary-privacy-list" });
    for (const [index, block] of blocks.entries()) {
      const row = list.createDiv({ cls: "echoink-diary-privacy-block" });
      const header = row.createDiv({ cls: "echoink-diary-row" });
      header.createSpan({ cls: "echoink-diary-label", text: `第 ${index + 1} 段${block.protected ? " · 代码、链接或笔记属性" : ""}` });
      const select = createOriginSelect(header, { attr: { "aria-label": `第 ${index + 1} 段发送范围` } }, [
        { value: "translate", label: "发送并翻译" },
        { value: "preserve", label: "发送，保留原样" },
        { value: "exclude", label: "不发送" }
      ], modes.get(block.id) ?? "exclude", this.app);
      select.element.addEventListener("change", () => modes.set(block.id, select.element.value as ProcessingMode));
      row.createDiv({ cls: "echoink-diary-privacy-text", text: block.text });
    }
    if (!blocks.length) list.createDiv({ cls: "echoink-diary-empty", text: "原稿还没有内容。" });
    const footer = this.contentEl.createDiv({ cls: "echoink-diary-actions" });
    diaryButton(footer, "取消", () => this.close());
    const confirm = diaryButton(footer, "保存发送范围", async () => {
      if (this.saving) return;
      this.saving = true;
      this.controls?.refresh();
      const next: DiaryPrivacy = { sourceFingerprint: fingerprint(this.source), rules: blocks.map((block) => ({ blockId: block.id, mode: modes.get(block.id) ?? "exclude" })) };
      try {
        await this.save(next);
        this.finish(next);
        this.close();
      } catch (error) { new Notice(diaryError(error)); }
      finally { this.saving = false; this.controls?.refresh(); }
    }, { primary: true });
    this.controls = new ProPluginControls(this.access, () => getProPluginAccess(this.access, true));
    this.controls.bind(confirm, { businessDisabled: () => this.saving });
  }

  onClose(): void { this.controls?.dispose(); this.finish(null); disposeOriginControls(this.contentEl); this.contentEl.empty(); }
  private finish(value: DiaryPrivacy | null): void { if (!this.settled) { this.settled = true; this.done(value); } }
}

import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginInput, createOriginSelect, createOriginSwitch, disposeOriginControls } from "../settings/origin-controls";
import { createPluginEditionBadge } from "../settings/plugin-edition-badge";
import { ProPluginControls } from "../ui/pro-plugin-controls";
import { requireProPluginAction } from "../membership/access";

export class PdfReadingSettingsPanel {
  private controls?: ProPluginControls;
  private page?: HTMLElement;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly back: () => void) {}
  dispose(): void { this.controls?.dispose(); if (this.page) disposeOriginControls(this.page); }
  render(container: HTMLElement): void {
    this.dispose();
    const host = this.plugin.pdfReading!;
    const page = this.page = container.createDiv({ cls: "echoink-life-settings-page echoink-pdf-settings" });
    const back = page.createEl("button", { cls: "echoink-life-settings-back", text: "‹ 返回插件列表" }); back.onclick = this.back;
    const heading = page.createDiv({ cls: "echoink-pdf-settings-heading" }); heading.createEl("h2", { text: "PDF 精读 · 提取" });
    createPluginEditionBadge(heading, "pro", this.plugin.settings.settingsLanguage);
    this.controls = new ProPluginControls(host.api.deps.access, () => host.policy());
    const row = (title: string, description?: string) => { const el = page.createDiv({ cls: "echoink-life-setting-row" }); const text = el.createDiv(); text.createEl("strong", { text: title }); if (description) text.createEl("small", { text: description }); return el; };
    const enabled = createOriginSwitch(row("启用插件"), { attr: { "aria-label": "启用 PDF 精读" } }); enabled.checked = this.plugin.settings.pdfReading.enabled;
    this.controls.bind(enabled); enabled.onchange = () => { void host.setEnabled(enabled.checked).catch(error => { enabled.checked = this.plugin.settings.pdfReading.enabled; new Notice(String(error)); }); };
    const form = page.createEl("form", { cls: "echoink-pdf-settings-form" });
    const method = form.createEl("label", { text: "解析方式" });
    const engine = createOriginSelect(method, {}, [{ value: "local", label: "本地文字提取" }, { value: "mineru", label: "MinerU 增强解析" }], this.plugin.settings.pdfReading.engine, this.plugin.app).element;
    const tokenLabel = form.createEl("label", { text: "MinerU 专用 Token" });
    const token = createOriginInput(tokenLabel, { type: "password", value: this.plugin.settings.pdfReading.mineruToken, attr: { autocomplete: "off", "aria-label": "MinerU 专用 Token" } });
    form.createEl("p", { text: "增强解析会将 PDF 发送至 MinerU，使用单独 Token 与第三方额度。第三方留存由 MinerU 决定。" });
    const directoryLabel = form.createEl("label", { text: "原 PDF 保存位置" });
    const directories = host.originalDirectories();
    const originalDirectory = createOriginSelect(directoryLabel, { attr: { "aria-label": "原 PDF 保存位置" } },
      directories.length ? directories.map(value => ({ value, label: value })) : [{ value: "", label: "请先设置资料来源位置" }],
      host.defaultOriginalDirectory(), this.plugin.app).element;
    if (!directories.length) {
      const configure = createOriginButton(directoryLabel, { text: "去设置资料来源", cls: "mod-muted", attr: { type: "button" } });
      configure.onclick = () => { void this.plugin.openEchoInkKnowledgeSettings(); };
    }
    const languageLabel = form.createEl("label", { text: "默认翻译语言" });
    const language = createOriginInput(languageLabel, { value: this.plugin.settings.pdfReading.translationLanguage, attr: { "aria-label": "默认翻译语言", placeholder: "中文、英文…" } });
    form.createEl("p", { text: "在聊天中上传 PDF 后说出提取、精读或翻译要求。仅在请求翻译时生成译文，聊天指定语言优先。" });
    const actions = form.createDiv({ cls: "echoink-pdf-settings-actions" });
    const save = createOriginButton(actions, { text: "保存设置", cls: "mod-cta", attr: { type: "submit" } }); let saving = false;
    for (const control of [engine, token, originalDirectory, language, save]) this.controls.bind(control, { businessDisabled: () => saving });
    form.onsubmit = event => { event.preventDefault(); if (saving) return; void (async () => {
      requireProPluginAction(host.api.deps.access, this.plugin.settings.pdfReading.enabled, "write");
      const previous = this.plugin.settings.pdfReading;
      if (!host.originalDirectories().includes(originalDirectory.value)) throw new Error("原 PDF 保存位置已失效，请重新选择资料来源位置。");
      if (!language.value.trim()) throw new Error("请填写默认翻译语言。");
      saving = true; this.controls?.refresh();
      this.plugin.settings.pdfReading = { ...previous, engine: engine.value as "local" | "mineru", originalDirectory: originalDirectory.value, mineruToken: token.value.trim(), translationLanguage: language.value.trim().slice(0, 40) };
      try { await this.plugin.saveSettings(true); new Notice("PDF 设置已保存。"); } catch (error) { this.plugin.settings.pdfReading = previous; throw error; }
      finally { saving = false; this.controls?.refresh(); }
    })().catch(error => new Notice(String(error))); };
  }
}

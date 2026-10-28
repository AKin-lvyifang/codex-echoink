import { galleryComparison } from "../gallery/comparison";
import type { App } from "obsidian";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";

export const ECHOINK_COLOR_THEMES = [
  { id: "minimal", zh: "极简黑白", en: "Minimal" },
  { id: "highlighter", zh: "荧光笔记", en: "Highlighter" },
  { id: "manifesto", zh: "黄白宣言", en: "Manifesto" }
] as const;
export type EchoInkColorTheme = typeof ECHOINK_COLOR_THEMES[number]["id"];
export const ECHOINK_THEME_ATTRIBUTE = "data-echoink-theme";
export const ECHOINK_APPEARANCE_REFRESH = "echoink-appearance-refresh";

export function effectiveEchoInkColorTheme(value: unknown, access: CapabilityAccess | null | undefined): EchoInkColorTheme {
  const theme = normalizeEchoInkColorTheme(value);
  return theme === "minimal" || hasProPluginAccess(access ?? unavailableCapabilityAccess) ? theme : "minimal";
}

export function normalizeEchoInkColorTheme(value: unknown): EchoInkColorTheme {
  return value === "highlighter" || value === "manifesto" ? value : "minimal";
}

export function readCompanionTheme(doc: Document): { active: boolean; gallery: boolean } {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  return { active: style?.getPropertyValue("--echoink-companion-theme").trim() === "1", gallery: style?.getPropertyValue("--echoink-gallery").trim() === "1" };
}

/** Read the companion stylesheet actually loaded in this document, without private APIs. */
export function refreshCompanionThemeRecommendations(doc: Document): void {
  const active = readCompanionTheme(doc).active;
  doc.querySelectorAll<HTMLElement>("[data-echoink-theme-recommendation]").forEach(node => { node.hidden = active; });
}

export function renderCompanionThemeRecommendation(container: HTMLElement, zh: boolean): void {
  const doc = container.ownerDocument;
  const note = doc.createElement("div");
  note.className = "echoink-theme-recommendation";
  note.dataset.echoinkThemeRecommendation = "";
  const title = note.createEl("a");
  title.href = "https://echoink.cn/theme"; title.target = "_blank"; title.rel = "noopener noreferrer";
  title.textContent = zh ? "下载配套主题 echoink-theme" : "Download the echoink-theme companion";
  const details = note.createEl("details");
  const summary = details.createEl("summary");
  summary.textContent = zh ? "安装说明" : "Installation";
  const text = details.createEl("p");
  text.textContent = zh
    ? "将 echoink-theme 文件夹放入当前库的 .obsidian/themes/，再到 Obsidian 设置 → 外观 → 主题中选择 echoink-theme。主题尚未上架。"
    : "Place the echoink-theme folder in this vault’s .obsidian/themes/, then select echoink-theme in Obsidian Settings → Appearance → Themes. It is not listed in the theme directory yet.";
  const comparison = details.createEl("img"); comparison.src = galleryComparison;
  comparison.alt = zh ? "前后对比：普通插图逐张显示，三张图片组排成一大两小" : "Before and after: separate images versus a three-image gallery";
  comparison.className = "echoink-gallery-comparison";
  const usage = details.createEl("p"); usage.textContent = zh ? "启用新版配套主题后，在笔记编辑器的命令面板中选择“插入图片组”，或选中连续的 2–3 张图片后选择“把选中的图片排成图片组”。手写时以 > [!gallery] 开头，推荐每行一张 > ![[图片.png]]；高度写在开头，如 [!gallery|row|300]。" : "With the current companion theme active, use Insert image gallery in the editor, or select 2–3 consecutive image embeds and run Group selected images. For handwriting, start with > [!gallery] and put each > ![[image.png]] on its own line. Set height in the header, e.g. [!gallery|row|300].";
  container.append(note);
  refreshCompanionThemeRecommendations(doc);
}

/** Theme metadata is window-wide; the companion theme also consumes this attribute. */
export class EchoInkAppearance {
  private readonly documents = new Set<Document>();

  constructor(private readonly app: App, private readonly theme: () => EchoInkColorTheme,
    private readonly access: () => CapabilityAccess | null | undefined = () => undefined) {}

  applyToDocument(doc: Document): void {
    this.documents.add(doc);
    refreshCompanionThemeRecommendations(doc);
    const effective = effectiveEchoInkColorTheme(this.theme(), this.access());
    if (doc.body.getAttribute(ECHOINK_THEME_ATTRIBUTE) !== effective) {
      doc.body.setAttribute(ECHOINK_THEME_ATTRIBUTE, effective);
    }
    doc.querySelectorAll("[data-echoink-appearance-picker]").forEach(picker => {
      const event = doc.createEvent("Event"); event.initEvent(ECHOINK_APPEARANCE_REFRESH, false, false); picker.dispatchEvent(event);
    });
  }

  refresh(): void {
    this.applyToDocument(this.app.workspace.containerEl.ownerDocument);
    this.app.workspace.iterateAllLeaves(leaf => this.applyToDocument(leaf.view.containerEl.ownerDocument));
    for (const doc of this.documents) this.applyToDocument(doc);
  }

  dispose(): void {
    for (const doc of this.documents) doc.body.removeAttribute(ECHOINK_THEME_ATTRIBUTE);
    this.documents.clear();
  }
}

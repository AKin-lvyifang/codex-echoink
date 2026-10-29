import { ownedDiv } from "./owned-dom";
import { bindCssParentStates } from "./css-parent-states";
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
export const ECHOINK_COMPANION_THEME_URL = "https://echoink.cn/theme";
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

export function documentEchoInkColorTheme(doc: Document, value: unknown, access: CapabilityAccess | null | undefined): EchoInkColorTheme | "host" {
  return readCompanionTheme(doc).active ? effectiveEchoInkColorTheme(value, access) : "host";
}

/** Read the companion stylesheet actually loaded in this document, without private APIs. */
export function refreshCompanionThemeRecommendations(doc: Document): void {
  const active = readCompanionTheme(doc).active;
  doc.querySelectorAll<HTMLElement>("[data-echoink-theme-recommendation]").forEach(node => { node.hidden = active; });
}

export function renderCompanionThemeRecommendation(container: HTMLElement, zh: boolean, configDir: string): void {
  const doc = container.ownerDocument;
  const note = ownedDiv(doc);
  note.className = "echoink-theme-recommendation";
  note.dataset.echoinkThemeRecommendation = "";
  // Settings pages can be built before their container is mounted.
  note.hidden = readCompanionTheme(doc).active;
  note.createSpan({ cls: "echoink-theme-required", text: zh ? "安装配套主题后生效" : "Install the companion theme to enable appearance choices" });
  const title = note.createEl("a");
  title.href = ECHOINK_COMPANION_THEME_URL; title.target = "_blank"; title.rel = "noopener noreferrer";
  title.textContent = zh ? "下载配套主题 echoink-theme" : "Download the echoink-theme companion";
  const details = note.createEl("details");
  const summary = details.createEl("summary");
  summary.textContent = zh ? "安装说明" : "Installation";
  const text = details.createEl("p");
  text.textContent = zh
    ? `将 echoink-theme 文件夹放入当前库的 ${configDir}/themes/，再到 Obsidian 设置 → 外观 → 主题中选择 echoink-theme。主题尚未上架。`
    : `Place the echoink-theme folder in this vault’s ${configDir}/themes/, then select echoink-theme in Obsidian Settings → Appearance → Themes. It is not listed in the theme directory yet.`;
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
  private readonly bindings = new Map<Document, { release(): void; schedule(): void }>();
  private disposed = false;

  constructor(private readonly app: App, private readonly theme: () => EchoInkColorTheme,
    private readonly access: () => CapabilityAccess | null | undefined = () => undefined) {}

  applyToDocument(doc: Document): void {
    if (this.disposed || doc.defaultView?.closed || !doc.body) return;
    this.documents.add(doc);
    if (!this.bindings.has(doc)) this.bindDocument(doc);
    refreshCompanionThemeRecommendations(doc);
    const effective = documentEchoInkColorTheme(doc, this.theme(), this.access());
    if (doc.body.getAttribute(ECHOINK_THEME_ATTRIBUTE) !== effective) doc.body.setAttribute(ECHOINK_THEME_ATTRIBUTE, effective);
    doc.querySelectorAll("[data-echoink-appearance-picker]").forEach(picker => {
      const EventConstructor = doc.defaultView?.Event ?? window.Event;
      picker.dispatchEvent(new EventConstructor(ECHOINK_APPEARANCE_REFRESH));
    });
  }

  private bindDocument(doc: Document): void {
    const win = doc.defaultView, stopStates = bindCssParentStates(doc);
    let timer: number | undefined;
    const schedule = () => {
      if (this.disposed || timer !== undefined || !win) return;
      // Recheck after CSS insertion/load has entered the document's cascade.
      timer = win.setTimeout(() => { timer = undefined; this.applyToDocument(doc); }, 0);
    };
    const visible = () => { if (doc.visibilityState !== "hidden") schedule(); };
    const loaded = (event: Event) => { if ((event.target as Element | null)?.tagName === "LINK") schedule(); };
    const observer = win ? new win.MutationObserver(schedule) : null;
    if (doc.head) observer?.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "media", "disabled"] });
    observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
    doc.addEventListener("load", loaded, true);
    doc.addEventListener("visibilitychange", visible);
    win?.addEventListener("pageshow", visible);
    const release = () => {
      observer?.disconnect(); stopStates();
      if (timer !== undefined) win?.clearTimeout(timer);
      doc.removeEventListener("load", loaded, true);
      doc.removeEventListener("visibilitychange", visible);
      win?.removeEventListener("pageshow", visible);
      win?.removeEventListener("pagehide", release);
      doc.body.removeAttribute(ECHOINK_THEME_ATTRIBUTE);
      this.bindings.delete(doc); this.documents.delete(doc);
    };
    this.bindings.set(doc, { release, schedule });
    win?.addEventListener("pagehide", release, { once: true });
    schedule();
  }

  refresh(): void {
    if (this.disposed) return;
    this.applyToDocument(this.app.workspace.containerEl.ownerDocument);
    this.app.workspace.iterateAllLeaves(leaf => this.applyToDocument(leaf.view.containerEl.ownerDocument));
    for (const doc of this.documents) { this.applyToDocument(doc); this.bindings.get(doc)?.schedule(); }
  }

  dispose(): void {
    this.disposed = true;
    this.bindings.forEach(binding => binding.release());
    this.bindings.clear(); this.documents.clear();
  }
}

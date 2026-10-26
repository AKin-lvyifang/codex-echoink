import type { App } from "obsidian";

export const ECHOINK_COLOR_THEMES = [
  { id: "minimal", zh: "极简黑白", en: "Minimal" },
  { id: "highlighter", zh: "荧光笔记", en: "Highlighter" },
  { id: "manifesto", zh: "黄白宣言", en: "Manifesto" }
] as const;
export type EchoInkColorTheme = "green" | "violet" | typeof ECHOINK_COLOR_THEMES[number]["id"];
export const ECHOINK_THEME_ATTRIBUTE = "data-echoink-theme";

export function normalizeEchoInkColorTheme(value: unknown): EchoInkColorTheme {
  return value === "minimal" || value === "highlighter" || value === "manifesto" || value === "violet" ? value : "green";
}
export function displayedEchoInkPalette(value: EchoInkColorTheme): typeof ECHOINK_COLOR_THEMES[number]["id"] {
  return value === "green" ? "highlighter" : value === "violet" ? "minimal" : value;
}

/** Theme metadata is window-wide; CSS only targets EchoInk surfaces. */
export class EchoInkAppearance {
  private readonly documents = new Set<Document>();

  constructor(private readonly app: App, private readonly theme: () => EchoInkColorTheme) {}

  applyToDocument(doc: Document): void {
    this.documents.add(doc);
    const palette = displayedEchoInkPalette(this.theme());
    if (doc.body.getAttribute(ECHOINK_THEME_ATTRIBUTE) !== palette) {
      doc.body.setAttribute(ECHOINK_THEME_ATTRIBUTE, palette);
    }
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

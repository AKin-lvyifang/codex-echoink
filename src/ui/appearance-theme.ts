import type { App } from "obsidian";

export type EchoInkColorTheme = "green" | "violet";
export const ECHOINK_THEME_ATTRIBUTE = "data-echoink-theme";

export function normalizeEchoInkColorTheme(value: unknown): EchoInkColorTheme {
  return value === "violet" ? "violet" : "green";
}

/** Theme metadata is window-wide; CSS only targets EchoInk surfaces. */
export class EchoInkAppearance {
  private readonly documents = new Set<Document>();

  constructor(private readonly app: App, private readonly theme: () => EchoInkColorTheme) {}

  applyToDocument(doc: Document): void {
    this.documents.add(doc);
    if (doc.body.getAttribute(ECHOINK_THEME_ATTRIBUTE) !== this.theme()) {
      doc.body.setAttribute(ECHOINK_THEME_ATTRIBUTE, this.theme());
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

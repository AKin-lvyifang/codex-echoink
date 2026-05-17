import * as fsp from "fs/promises";
import * as path from "path";
import { ItemView, Notice, WorkspaceLeaf, normalizePath } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { isReviewHtmlPath } from "./schedule";

export const VIEW_TYPE_REVIEW_PREVIEW = "codex-review-preview";

export class ReviewPreviewView extends ItemView {
  private htmlPath = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW_PREVIEW;
  }

  getDisplayText(): string {
    return "复盘 HTML 看板";
  }

  getIcon(): string {
    return "bar-chart-3";
  }

  async openHtml(relativePath: string): Promise<void> {
    const normalized = normalizePath(relativePath);
    if (!isReviewHtmlPath(normalized)) {
      new Notice("只能打开 EchoInk 生成的复盘 HTML");
      return;
    }
    this.htmlPath = normalized;
    await this.render();
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-review-preview");
    if (!this.htmlPath) {
      contentEl.createDiv({ cls: "codex-resource-empty", text: "还没有选择复盘 HTML。" });
      return;
    }
    const title = contentEl.createDiv({ cls: "codex-review-preview-title" });
    title.createSpan({ text: this.htmlPath });
    const frame = contentEl.createEl("iframe", {
      cls: "codex-review-preview-frame",
      attr: {
        title: this.htmlPath,
        sandbox: "allow-same-origin"
      }
    }) as HTMLIFrameElement;
    const absolute = path.join(this.plugin.getVaultPath(), this.htmlPath);
    const html = await fsp.readFile(absolute, "utf8").catch(() => "");
    if (!html) {
      frame.remove();
      contentEl.createDiv({ cls: "codex-resource-error", text: "HTML 文件不存在或无法读取。" });
      return;
    }
    frame.srcdoc = html;
  }
}

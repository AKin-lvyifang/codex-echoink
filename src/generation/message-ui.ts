import { Notice, setIcon, TFile, type App } from "obsidian";
import type { SettingsLanguage } from "../settings/settings";
import { conversationUiText } from "../ui/codex-view/ui-i18n";
import { generationRequestSummary } from "./request";
import type { GenerationRequest, GenerationResult } from "./types";

async function openGenerationFile(app: App, relativePath: string, language: SettingsLanguage): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(relativePath);
  if (!(file instanceof TFile)) {
    new Notice(conversationUiText(language, "文件已不存在或已移动", "The file no longer exists or has moved"));
    return false;
  }
  await app.workspace.getLeaf("tab").openFile(file, { active: true });
  return true;
}

export function renderGenerationRequestSummary(container: HTMLElement, options: {
  app: App; request: GenerationRequest; language: SettingsLanguage; open?: boolean; onToggle?(open: boolean): void;
}): HTMLDetailsElement {
  const details = container.createEl("details", { cls: "codex-generation-request" });
  details.open = options.open === true;
  const summary = details.createEl("summary", { text: generationRequestSummary(options.request) });
  summary.setAttribute("aria-expanded", String(details.open));
  const sources = details.createDiv({ cls: "codex-generation-request-sources" });
  sources.createDiv({ cls: "codex-generation-template-name", text: conversationUiText(options.language, `模板：${options.request.template.name}`, `Template: ${options.request.template.name}`) });
  for (const sourcePath of options.request.sourcePaths) {
    const button = sources.createEl("button", { cls: "codex-generation-source", text: sourcePath,
      attr: { type: "button", "aria-label": conversationUiText(options.language, `打开资料：${sourcePath}`, `Open source: ${sourcePath}`) } });
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); void openGenerationFile(options.app, sourcePath, options.language); };
  }
  details.ontoggle = () => { summary.setAttribute("aria-expanded", String(details.open)); options.onToggle?.(details.open); };
  return details;
}

/** Compact native-open result; the durable receipt decides whether it is a success. */
export function renderGenerationResultCard(container: HTMLElement, options: {
  app: App; result: GenerationResult; language: SettingsLanguage; onMeasure?(): void;
}): HTMLElement | null {
  const { result, app, language } = options;
  if (!result.path || result.writeState === "not_written") return null;
  const root = container.createDiv({ cls: "codex-generation-result" });
  root.dataset.generationRequestId = result.requestId;
  root.dataset.writeState = result.writeState;
  const icon = root.createSpan({ cls: "codex-generation-result-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, result.outputKind === "canvas" ? "layout-dashboard" : "file-text");
  const copy = root.createDiv({ cls: "codex-generation-result-copy" });
  copy.createDiv({ cls: "codex-generation-result-name", text: result.path.split("/").at(-1) ?? result.path });
  const counts = result.outputKind === "canvas" && result.branchCount !== undefined
    ? conversationUiText(language, `${result.branchCount} 个分支`, `${result.branchCount} branches`)
    : result.characterCount !== undefined ? conversationUiText(language, `${result.characterCount.toLocaleString()} 字`, `${result.characterCount.toLocaleString()} characters`) : "";
  copy.createDiv({ cls: "codex-generation-result-path", text: `${result.path}${counts ? ` · ${counts}` : ""}` });
  const missing = copy.createDiv({ cls: "codex-generation-result-missing", attr: { role: "status", "aria-live": "polite" } });
  const open = root.createEl("button", { cls: "codex-generation-open", text: result.writeState === "unconfirmed" ? conversationUiText(language, "核对文件", "Check file") : conversationUiText(language, "打开", "Open"), attr: { type: "button" } });
  const markMissing = () => {
    root.addClass("is-missing"); open.disabled = true;
    missing.setText(conversationUiText(language, "文件已不存在或已移动", "The file no longer exists or has moved"));
    options.onMeasure?.();
  };
  if (!(app.vault.getAbstractFileByPath(result.path) instanceof TFile)) markMissing();
  open.onclick = async event => {
    event.preventDefault(); event.stopPropagation();
    if (!await openGenerationFile(app, result.path!, language)) markMissing();
  };
  return root;
}

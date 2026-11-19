import { errorText, CAUSE } from "../core/error-copy";
import { Notice, type App } from "obsidian";
import { ownedEl, ownedFragment } from "./owned-dom";

/** The result stays outside chat; Open follows the actual saved file path. */
export function showKnowledgeCaptureSuccessNotice(document: Document, app: App, paths: readonly string[], language: string): Notice {
  const folders = [...new Set(paths.map(path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : language === "en" ? "Vault root" : "库根目录"))];
  const fragment = ownedFragment(document);
  fragment.append(language === "en" ? `Saved to ${folders.join(", ")} ` : `已收藏到 ${folders.join("、")} `);
  const open = ownedEl(document, "button");
  open.textContent = language === "en" ? "Open" : "打开";
  open.setAttribute("data-echoink-open-capture", "");
  open.onclick = () => { void app.workspace.openLinkText(paths[0], "").catch(error => new Notice(errorText(error, CAUSE.sourceMissing, language))); };
  fragment.append(open);
  return new Notice(fragment);
}

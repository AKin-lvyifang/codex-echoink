import { Notice } from "obsidian";
import { ownedEl, ownedFragment } from "./owned-dom";

/** A persistent, actionable native Notice shared by both manual chat save entries. */
export function showConversationContentLocationNotice(document: Document, language: string, openSettings: () => void | Promise<void>): void {
  const fragment = ownedFragment(document);
  fragment.append(language === "en" ? "The conversation content folder is missing. " : "对话栏内容的保存位置不存在，");
  const button = ownedEl(document, "button");
  button.textContent = language === "en" ? "Open settings" : "去设置";
  button.onclick = () => { void openSettings(); };
  fragment.append(button);
  new Notice(fragment, 0);
}

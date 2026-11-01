import { Notice } from "obsidian";
import { ownedEl, ownedFragment } from "./owned-dom";

/** A persistent native Notice that opens the missing output location directly. */
export function showConversationContentLocationNotice(document: Document, language: string, openSettings: () => void | Promise<void>, kind: "answer" | "generation" = "answer"): void {
  const fragment = ownedFragment(document);
  fragment.append(language === "en"
    ? kind === "generation" ? "The generation folder is missing. " : "The answer folder is missing. "
    : kind === "generation" ? "从资料生成的保存位置不存在，" : "存为笔记的回答的保存位置不存在，");
  const button = ownedEl(document, "button");
  button.textContent = language === "en" ? "Open settings" : "去设置";
  button.onclick = () => { void openSettings(); };
  fragment.append(button);
  new Notice(fragment, 0);
}

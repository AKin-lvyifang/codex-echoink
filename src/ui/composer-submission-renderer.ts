import { setIcon } from "obsidian";
import { ownedEl } from "./owned-dom";
import { preparationText, submissionFailureText, type ComposerSubmission } from "../types/composer-submission";

interface SubmissionDisplay {
  text: string;
  language: string;
  userClass: string;
  showProcess?: boolean;
  renderProcess?: (parent: HTMLElement) => void;
  retry: () => void | Promise<void>;
  edit: () => void | Promise<void>;
  button(parent: HTMLElement, label: string, action: () => void | Promise<void>): void;
}

/** All surfaces share status rendering; their established message/button classes stay local. */
export function renderComposerSubmission<T, D>(parent: HTMLElement, record: Readonly<ComposerSubmission<T, D>>, display: SubmissionDisplay): HTMLElement {
  const document = parent.ownerDocument;
  const element = (parent: HTMLElement, tag: keyof HTMLElementTagNameMap, className: string, text?: string) => {
    const node = ownedEl(document, tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.append(node); return node;
  };
  const root = element(parent, "section", "echoink-submission"); root.dataset.composerTransfer = record.id;
  if (display.renderProcess) root.classList.add("is-desktop-chain");
  if (record.cancelled) {
    element(root, "div", "echoink-submission-paused", display.language === "en" ? "Paused input" : "已暂停的输入");
    const actions = element(root, "div", "echoink-submission-actions");
    display.button(actions, display.language === "en" ? "Edit" : "编辑", display.edit);
    display.button(actions, display.language === "en" ? "Continue" : "继续发送", display.retry);
    return root;
  }
  const user = record.queued ? root : element(root, "article", display.userClass);
  if (!record.queued) {
    user.setAttribute("aria-label", display.language === "en" ? "Your message" : "你的消息");
    element(user, "div", "codex-message-content echoink-submission-text", display.text);
  }
  if (record.phase === "failed") {
    const error = element(user, "div", "echoink-submission-error", submissionFailureText(record.error, display.language)); error.setAttribute("role", "alert");
    const actions = element(user, "div", "echoink-submission-actions");
    display.button(actions, display.language === "en" ? "Edit" : "编辑", display.edit);
    display.button(actions, display.language === "en" ? "Retry" : "重试", display.retry);
    return root;
  }
  if (record.phase === "review" || display.showProcess === false) return root;
  if (display.renderProcess) { display.renderProcess(root); return root; }
  const process = element(root, "div", "echoink-submission-process");
  process.setAttribute("role", "status"); process.setAttribute("aria-live", "polite");
  const stages = record.stages.filter(stage => stage.status === "active" || stage.stage === "knowledge");
  if (!stages.some(stage => stage.status === "active")) stages.push({ stage: "thinking", status: "active" });
  for (const stage of stages) {
    const row = element(process, "div", `codex-assistant-turn-node echoink-submission-step is-${stage.status === "active" ? "running" : "completed"} is-retrieval`);
    row.dataset.preparationStage = stage.stage;
    const icon = element(row, "span", "codex-assistant-turn-node-icon"); icon.setAttribute("aria-hidden", "true");
    setIcon(icon, stage.status === "active" ? "loader-circle" : "search");
    element(row, "span", "codex-assistant-turn-node-title", preparationText(stage, display.language));
  }
  return root;
}

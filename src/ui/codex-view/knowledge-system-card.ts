import { Component, MarkdownRenderer, Notice } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { KnowledgeSystemTask } from "../../knowledge-base/knowledge-system-task";
import { renderKnowledgeFrameworkMap } from "../../knowledge-base/knowledge-system-analysis";
import { createSmoothAIApprovalCard } from "./smooth-chat-ui";
import {
  createOriginButton,
  createOriginCheck,
  disposeOriginControls,
} from "../../settings/origin-controls";
import { setAmicroButtonPending, applyAmicroButton } from "../../settings/amicro-buttons";
import { stopManagedTask } from "../../plugin/task-management";

/** A task-owned message projection inside the existing conversation's scroll area. */
export class KnowledgeSystemConversationCard {
  private root?: HTMLElement;
  private component?: Component;
  private readonly choices = new Map<string, { version: number; index: number; move?: boolean }>();
  private signature = "";
  constructor(private readonly plugin: CodexForObsidianPlugin) {}
  dispose(): void {
    this.component?.unload();
    if (this.root) disposeOriginControls(this.root);
    this.root?.remove();
    this.root = undefined;
    this.signature = "";
  }
  render(parent: HTMLElement, task: KnowledgeSystemTask | undefined): void {
    if (!task) {
      this.dispose();
      return;
    }
    const service = this.plugin.getKnowledgeSystemService();
    const state = this.choices.get(task.id),
      choice = state?.version === task.proposalVersion ? state.index : 0;
    const move = state?.version === task.proposalVersion ? state.move !== false : true;
    const movePlan = task.proposal?.choices[choice]?.move;
    const signature = JSON.stringify([task.id, task.updatedAt, task.phase, choice, move]);
    if (this.root?.parentElement === parent && this.signature === signature) return;
    this.dispose();
    this.signature = signature;
    this.component = new Component();
    this.component.load();
    const root = (this.root = parent.createDiv({
      cls: "codex-message assistant codex-knowledge-system-message",
      attr: { "data-knowledge-system-task": task.id, "data-message-tail": "true" },
    }));

    if (task.phase === "completed" || task.phase === "deferred") {
      const body = root.createDiv({ cls: "codex-message-content" });
      body.createEl("p", { text: task.receipt ?? "已暂缓梳理。" });
      if (task.phase === "completed") {
        const open = createOriginButton(body, {
          text: "打开地图",
          cls: "codex-smooth-ai-approval-button",
          attr: { type: "button" },
        });
        applyAmicroButton(open, { variant: "secondary" });
        open.onclick = () => {
          void this.plugin.app.workspace.openLinkText(task.mapPath, "");
        };
      }
      return;
    }
    const waiting = task.phase === "awaiting-confirmation" && !!task.proposal;
    const elements = createSmoothAIApprovalCard(root, {
      state: "waiting_approval",
      controlled: waiting,
      language: this.plugin.settings.settingsLanguage,
    });
    elements.root.setAttribute("aria-label", `梳理${task.domain}`);
    elements.root.querySelector(".codex-smooth-ai-approval-state")!.textContent =
      task.phase === "reading"
        ? `已读 ${service.readCount(task)} / ${task.documents.length} 篇`
        : task.phase === "waiting-maintain"
          ? "等待知识维护结束"
          : task.phase === "writing"
            ? "正在写入地图"
            : task.phase === "moving"
              ? `已搬 ${task.moveProgress?.moved.length ?? 0} / ${movePlan?.files.length ?? 0} 篇`
              : task.phase === "linking"
                ? `已同步 ${task.moveProgress?.linked.length ?? 0} / ${movePlan?.links.length ?? 0} 篇引用`
                : task.phase === "interrupted"
                  ? "梳理已停下"
                  : `梳理${task.domain}`;
    if (task.error)
      elements.root.createDiv({
        cls: "codex-interaction-error",
        text: task.error,
        attr: { role: "status" },
      });
    if (task.moveBlocker?.conversationId) {
      const open = createOriginButton(elements.root, {
        text: "查看维护任务",
        cls: "codex-smooth-ai-approval-button",
      });
      open.onclick = () => {
        void this.plugin.openTaskDetail(task.moveBlocker!.conversationId!);
      };
    }
    let review: HTMLElement | undefined;
    if (task.proposal) {
      const options = elements.root.createDiv({
        cls: "codex-interaction-options",
        attr: { role: "radiogroup", "aria-label": "选择框架方案" },
      });
      task.proposal.analysis.frameworks.forEach((framework, index) => {
        const label = options.createEl("label", {
          cls: `codex-interaction-option${choice === index ? " is-selected" : ""}`,
        });
        const control = label.createEl("input", {
          cls: "codex-interaction-option-control",
          attr: { type: "radio", name: `framework-${task.id}`, value: String(index) },
        });
        control.checked = choice === index;
        control.disabled = !waiting;
        label.createSpan({ cls: "codex-interaction-option-label", text: framework.title });
        control.onchange = () => {
          this.choices.set(task.id, { version: task.proposalVersion, index, move });
          this.signature = "";
          this.render(parent, task);
        };
      });
      review = elements.root.createDiv({ cls: "codex-knowledge-system-review" });
      const preview = review.createDiv({
        cls: "codex-smooth-ai-approval-section codex-message-content codex-knowledge-system-preview markdown-rendered",
      });
      // The radio labels already name the framework. The preview only shows the tree and short gaps.
      const markdown = renderKnowledgeFrameworkMap(
        task.domain,
        task.proposal.analysis.frameworks[choice],
      )
        .split("\n")
        .slice(2)
        .join("\n");
      void MarkdownRenderer.render(
        this.plugin.app,
        markdown,
        preview,
        task.mapPath,
        this.component,
      );
    }
    if (movePlan) {
      const label = elements.root.createEl("label", { cls: "codex-knowledge-system-move-option" });
      elements.root.insertBefore(label, review!);
      const checkbox = createOriginCheck(
        label,
        { attr: { "aria-label": "按知识树搬家" } },
        "checkbox",
      );
      checkbox.checked = move;
      checkbox.disabled = !waiting;
      label.createSpan({ text: "按知识树搬家" });
      checkbox.addEventListener("change", () => {
        this.choices.set(task.id, {
          version: task.proposalVersion,
          index: choice,
          move: checkbox.checked,
        });
        this.signature = "";
        this.render(parent, task);
      });
      if (move) {
        const section = review!.createDiv({ cls: "codex-smooth-ai-approval-section codex-knowledge-system-move" });
        section.createDiv({
          cls: "codex-knowledge-system-move-heading",
          text: `移动文件 ${movePlan.files.length}`,
        });
        const files = section.createDiv({ cls: "codex-knowledge-system-move-list" });
        for (const file of movePlan.files) {
          const row = files.createDiv({ cls: "codex-knowledge-system-move-row" });
          row.createDiv({ text: file.from });
          row.createDiv({ cls: "codex-knowledge-system-move-target", text: `→ ${file.to}` });
        }
        section.createDiv({
          cls: "codex-knowledge-system-move-heading",
          text: `同步引用 ${movePlan.links.length}`,
        });
        const links = section.createDiv({ cls: "codex-knowledge-system-move-list" });
        for (const patch of movePlan.links)
          links.createDiv({ cls: "codex-knowledge-system-move-row", text: patch.sourcePath });
      }
    }
    const actions =
      elements.root.querySelector<HTMLElement>(".codex-smooth-ai-approval-actions") ??
      elements.root.createDiv({ cls: "codex-smooth-ai-approval-actions" });
    // The original approval component puts its controls last; keep that order after adding the preview.
    elements.root.append(actions);
    const invoke = (button: HTMLButtonElement, action: () => Promise<void>) => {
      applyAmicroButton(button, {
        variant: button.classList.contains("mod-cta") ? "primary" : "secondary",
      });
      button.onclick = () => {
        if (button.disabled) return;
        button.disabled = true;
        setAmicroButtonPending(button, true);
        void action()
          .catch(
            (error) => new Notice(error instanceof Error ? error.message : "操作未完成，请重试。"),
          )
          .finally(() => {
            if (button.isConnected) {
              button.disabled = false;
              setAmicroButtonPending(button, false);
            }
          });
      };
    };
    if (waiting) {
      elements.approveButton!.textContent = "确认写入";
      elements.rejectButton!.textContent = "先不梳理";
      const binding = service.confirmation(task, choice, move && !!movePlan);
      invoke(elements.rejectButton!, () => service.defer(task.conversationId));
      invoke(elements.approveButton!, () => service.confirm(binding));
    }
    if (task.phase === "reading") {
      const stop = createOriginButton(actions, { text: "停止", attr: { type: "button" } });
      if (elements.approveButton) actions.insertBefore(stop, elements.approveButton);
      invoke(stop, () => stopManagedTask(this.plugin, task.conversationId));
    }
    if (task.phase === "interrupted") {
      const resume = createOriginButton(actions, {
        text: "继续",
        cls: "mod-cta",
        attr: { type: "button" },
      });
      invoke(resume, async () => {
        await this.plugin.resumeTask(task.conversationId);
      });
    }
  }
}

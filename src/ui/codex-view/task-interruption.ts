import type { TaskInterruptionInfo } from "../../agents/task-resume";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../../settings/amicro-buttons";

/** The interruption card is UI-only; it never becomes a session message. */
export function renderTaskInterruption(
  container: HTMLElement,
  input: { info?: TaskInterruptionInfo | null; error?: string; userCopy?: string; buttonLabel?: string; pending: boolean; language: string; onResume(): void; onReport?(): void | Promise<void> }
): void {
  disposeOriginControls(container);
  container.replaceChildren();
  const en = input.language === "en", info = input.info;
  const text = (tag: string, className: string, value: string) => {
    const node = container.ownerDocument.createElement(tag); node.className = className; node.textContent = value; container.append(node); return node;
  };
  if (input.userCopy) text("div", "echoink-task-interruption-copy", input.userCopy);
  else if (info) {
    const time = new Date(info.at).toLocaleString(en ? "en-US" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", ...(new Date(info.at).getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}) });
    const reasons: Record<TaskInterruptionInfo["reason"], [string, string]> = {
      app_closed: ["关闭 Obsidian 时中断", "interrupted when Obsidian closed"],
      user_stopped: ["被你停止", "stopped by you"],
      plugin_disabled: ["插件关闭时中断", "interrupted when the plugin stopped"],
      run_failed: ["执行失败后中断", "interrupted after an error"],
      process_unknown: ["意外中断", "unexpectedly interrupted"],
      watchdog: ["等待超时后中断", "interrupted after a timeout"]
    };
    const reason = reasons[info.reason][en ? 1 : 0];
    const cause = info.reason === "process_unknown" ? (en ? `Unexpected interruption; last recorded at ${time}` : `运行意外中断，最后记录于 ${time}`) : `${time} ${reason}`;
    text("div", "echoink-task-interruption-copy", en
      ? `${cause}. ${info.stage ? `Stopped at “${info.stage}”.` : "The last step was not recorded."} Everything already completed is preserved.`
      : `${cause}，${info.stage ? `停在「${info.stage}」。` : "没有保存具体步骤。"}已经完成的内容都保留着。`);
    if (info.detail) text("div", "echoink-task-interruption-detail", info.detail);
    if (info.uncertainOperations.length) {
      text("div", "echoink-task-interruption-warning", en ? "The result of this operation is uncertain. Check it before continuing." : "这个操作结果不确定，继续前请先核对");
      const list = container.ownerDocument.createElement("ul"); list.className = "echoink-task-interruption-operations";
      for (const operation of info.uncertainOperations) {
        const item = container.ownerDocument.createElement("li"); item.textContent = operation.label; list.append(item);
      }
      container.append(list);
    }
  } else if (!input.error) text("div", "echoink-task-interruption-copy", en ? "Reading interruption details…" : "正在读取中断记录…");
  if (input.error) text("div", "echoink-task-interruption-error", input.error).setAttribute("role", "alert");
  const actions = text("div", "echoink-task-interruption-actions", "");
  if (input.onReport) {
    const report = createOriginButton(actions, { text: en ? "Report a problem" : "上报问题", attr: { type: "button" } });
    applyAmicroButton(report, { variant: "secondary" }); report.dataset.action = "report-task";
    report.onclick = event => { event.stopPropagation(); if (report.disabled) return; report.disabled = true; void Promise.resolve().then(() => input.onReport?.()).finally(() => { report.disabled = false; }); };
  }
  const button = createOriginButton(actions, { text: input.pending ? (en ? "Checking…" : "正在核对…") : input.buttonLabel ?? (en ? "Continue" : "继续"), attr: { type: "button" } });
  applyAmicroButton(button, { variant: "primary" });
  const icon = button.querySelector(".echoink-amicro-button-icon");
  if (icon) button.prepend(icon);
  setAmicroButtonPending(button, input.pending);
  button.dataset.action = "resume-task";
  button.disabled = input.pending || !info && !input.error && !input.userCopy;
  button.onclick = event => { event.stopPropagation(); if (!button.disabled) input.onResume(); };
}

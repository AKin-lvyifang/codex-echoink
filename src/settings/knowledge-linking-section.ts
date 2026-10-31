import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import { createOriginButton, createOriginPagination, disposeOriginControls } from "./origin-controls";
import { attachSettingsHelpTooltip } from "./settings-v2";
import { OriginSetting } from "./origin-setting";
import { applyAmicroButton } from "./amicro-buttons";
import { knowledgeLinkingProgressText } from "../ui/codex-view/knowledge-linking-progress";

/** A preview quotes only the mention's body line, never adjacent metadata. */
function previewMentionLine(content: string, start: number, end: number): string {
  let lineStart = Math.max(content.lastIndexOf("\n", start - 1), content.lastIndexOf("\r", start - 1)) + 1;
  let lineEnd = content.length;
  for (const newline of ["\n", "\r"]) {
    const next = content.indexOf(newline, end);
    if (next >= 0) lineEnd = Math.min(lineEnd, next);
  }
  // A source marker can also share the body line. Keep the uninterrupted
  // original words around the mention, without exposing comment payloads.
  const previousComment = content.lastIndexOf("<!--", start);
  const previousCommentEnd = content.lastIndexOf("-->", start);
  if (previousComment >= 0 && previousCommentEnd > previousComment) lineStart = Math.max(lineStart, previousCommentEnd + 3);
  const nextComment = content.indexOf("<!--", end);
  if (nextComment >= 0) lineEnd = Math.min(lineEnd, nextComment);
  const before = Array.from(content.slice(lineStart, start));
  const after = Array.from(content.slice(end, lineEnd));
  return `${before.length > 70 ? "…" : ""}${before.slice(-70).join("")}${content.slice(start, end)}${after.slice(0, 70).join("")}${after.length > 70 ? "…" : ""}`;
}

/** Only the subscription belongs to settings; the plugin owns the background job. */
export function renderKnowledgeLinkingSection(container: HTMLElement, plugin: CodexForObsidianPlugin, taskId?: string, locate = false): () => void {
  const english = plugin.settings.settingsLanguage === "en";
  const service = plugin.getKnowledgeSurfaceService()?.linking;
  const block = container.createDiv({ cls: "echoink-knowledge-linking-inline" });
  const row = new OriginSetting(block).setName(english ? "Complete knowledge links" : "补全知识关联");
  // Focus the row's content, not Obsidian's navigable setting-item shell.
  const focusTarget = row.infoEl;
  focusTarget.setAttribute("data-echoink-focus-key", "knowledge:linking");
  let disposed = false, locateTimer: number | undefined, locateFrame: number | undefined;
  const win = row.settingEl.ownerDocument.defaultView;
  if (locate) queueMicrotask(() => {
    if (disposed || !row.settingEl.isConnected) return;
    focusTarget.tabIndex = -1;
    row.settingEl.scrollIntoView?.({ block: "center" });
    focusTarget.focus({ preventScroll: true });
    // Obsidian autofocuses the first control when opening its settings modal.
    // Reclaim the location after that host step, in the owning window.
    locateFrame = win?.requestAnimationFrame(() => {
      if (!disposed && row.settingEl.isConnected) focusTarget.focus({ preventScroll: true });
    });
    row.settingEl.classList.add("echoink-knowledge-linking-located");
    locateTimer = win?.setTimeout(() => row.settingEl.classList.remove("echoink-knowledge-linking-located"), 1800);
  });
  const releaseLocation = () => { disposed = true; if (locateTimer !== undefined) win?.clearTimeout(locateTimer); if (locateFrame !== undefined) win?.cancelAnimationFrame(locateFrame); };
  const hint = english
    ? "AI reads your knowledge notes, adds aliases and links mentions to other notes. This calls your model, uses quota per note and modifies notes."
    : "让 AI 读一遍知识库，给笔记补上别名，并把提到其他笔记的地方连成双链。会调用模型，按篇数消耗额度，并修改笔记。";
  const help = createOriginButton(row.nameEl, { cls: "is-icon echoink-settings-help-trigger echoink-knowledge-help-trigger", attr: { "aria-label": hint } });
  setIcon(help, "info"); attachSettingsHelpTooltip(help, hint);
  const status = row.descEl;
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const action = createOriginButton(row.controlEl, { text: english ? "Start" : "开始" });
  applyAmicroButton(action, { variant: "secondary" });
  const cancel = createOriginButton(row.controlEl, { text: english ? "Cancel" : "取消" });
  applyAmicroButton(cancel, { variant: "secondary" });
  const details = block.createEl("details", { cls: "echoink-knowledge-linking-inline-details" });
  details.open = Boolean(taskId);
  details.createEl("summary", { text: english ? "View details" : "查看明细" });
  const content = details.createDiv({ cls: "echoink-knowledge-linking-detail-content" });
  if (!service) {
    action.onclick = () => new Notice(english ? "Knowledge service is unavailable. Try again shortly." : "知识库服务尚未就绪，请稍后重试。");
    cancel.hidden = details.hidden = true;
    return () => { releaseLocation(); disposeOriginControls(block); };
  }
  let rendered = "", pagination = 0, closed = false, pending = false;
  let current: KnowledgeLinkingTask | null = null;
  const invoke = async (work: () => Promise<unknown>) => {
    if (pending || closed) return;
    pending = true; action.disabled = cancel.disabled = true;
    try { await work(); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); if (!closed) status.setText(message); new Notice(message); }
    finally { pending = false; if (!closed) render(current, true); }
  };
  const render = (task: KnowledgeLinkingTask | null, preserveError = false) => {
    current = task;
    const active = !!task && ["queued", "scanning", "judging", "writing"].includes(task.phase);
    const preview = task?.phase === "awaiting-confirmation", interrupted = task?.phase === "interrupted";
    if (!preserveError) {
      const written = task?.results.filter(result => result.status === "written") ?? [];
      const links = written.reduce((sum, result) => sum + result.links, 0), aliases = written.reduce((sum, result) => sum + result.aliases, 0);
      const failed = new Set(task?.results.filter(result => result.status === "failed").map(result => result.path)).size;
      status.setText(!task ? "" : active || preview || interrupted ? knowledgeLinkingProgressText(task, english)
        : english ? `${knowledgeLinkingProgressText(task, true)} · ${links} links · ${aliases} aliases · ${failed} notes failed`
          : `${knowledgeLinkingProgressText(task)} · 写入 ${links} 条链接 · ${aliases} 条别名 · 失败 ${failed} 篇`);
    }
    action.classList.toggle("mod-cta", preview);
    action.hidden = active;
    action.setText(preview ? (english ? "Confirm updates" : "确认写入") : interrupted ? (english ? "Continue" : "继续") : (english ? "Start" : "开始"));
    action.disabled = pending;
    cancel.hidden = !(active || preview || interrupted); cancel.disabled = pending;
    details.hidden = !task || !(task.results.length || task.patches.length || task.error);
    const key = task ? `${task.id}:${task.phase}:${task.patches.length}:${task.results.length}:${task.error ?? ""}` : "empty";
    if (key === rendered) return;
    if (rendered.split(":")[0] !== key.split(":")[0]) pagination = 0;
    rendered = key;
    disposeOriginControls(content); content.empty();
    if (task?.error) content.createEl("p", { cls: "echoink-knowledge-linking-error", text: task.error });
    if (preview) {
      for (const patch of task.patches.slice(pagination * 20, (pagination + 1) * 20)) {
        const item = content.createDiv({ cls: "echoink-knowledge-linking-preview-note" });
        noteLink(item, patch.path);
        for (const mention of patch.mentions) {
          item.createEl("p", { text: previewMentionLine(patch.before, mention.start, mention.end) });
          item.createDiv({ text: `${mention.text} → ${mention.targetPath}` });
        }
        if (patch.addedAliases.length) item.createDiv({ text: `${english ? "New aliases" : "新增别名"}：${patch.addedAliases.join("、")}` });
      }
    } else {
      for (const result of task?.results.slice(pagination * 20, (pagination + 1) * 20) ?? []) {
        const item = content.createDiv({ cls: "echoink-knowledge-linking-result-note" });
        noteLink(item, result.path);
        const text = result.status === "written" ? (english ? `${result.links} links · ${result.aliases} aliases` : `${result.links} 条链接 · ${result.aliases} 条别名`) : result.status === "failed" ? (english ? "Failed" : "失败") : (english ? "Skipped" : "跳过");
        item.createSpan({ text: ` · ${text}` });
        if (result.message) item.createDiv({ text: result.message });
      }
    }
    const count = preview ? task.patches.length : task?.results.length ?? 0;
    if (count > 20) createOriginPagination(content, pagination + 1, Math.ceil(count / 20), next => { pagination = next - 1; rendered = current?.id ?? ""; render(current); });
  };
  function noteLink(parent: HTMLElement, path: string) {
    const link = parent.createEl("a", { href: "#", text: path });
    link.onclick = event => { event.preventDefault(); void plugin.app.workspace.openLinkText(path, "", true); };
  }
  action.onclick = () => void invoke(async () => {
    if (current?.phase === "awaiting-confirmation") await service.confirm();
    else if (current?.phase === "interrupted") await service.resume();
    else { taskId = undefined; await service.startAndApply(); }
  });
  cancel.onclick = () => void invoke(() => service.cancel());
  const selected = (task: KnowledgeLinkingTask | null) => {
    if (closed) return;
    if (!taskId || task?.id === taskId) { render(task); return; }
    void service.readTask(taskId).then(saved => { if (!closed) render(saved ?? task); });
  };
  const unsubscribe = service.subscribe(selected);
  return () => { closed = true; releaseLocation(); unsubscribe(); disposeOriginControls(block); };
}

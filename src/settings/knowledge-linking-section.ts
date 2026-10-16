import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import { createOriginButton, createOriginPagination, disposeOriginControls } from "./origin-controls";
import { createSettingsPage } from "./settings-v2";
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

/** Closing this page only releases its subscription; the plugin owns the job. */
export function renderKnowledgeLinkingSection(container: HTMLElement, plugin: CodexForObsidianPlugin, onBack: () => void, taskId?: string): () => void {
  const english = plugin.settings.settingsLanguage === "en";
  const service = plugin.getKnowledgeSurfaceService()?.linking;
  const page = createSettingsPage(container, { title: english ? "Knowledge links" : "知识关联", detail: true, backLabel: english ? "Back to knowledge" : "返回知识库", onBack });
  page.addClass("echoink-knowledge-linking-detail");
  const status = page.createDiv({ cls: "echoink-knowledge-linking-detail-status", attr: { role: "status", "aria-live": "polite" } });
  const content = page.createDiv({ cls: "echoink-knowledge-linking-detail-content" });
  const actions = page.createDiv({ cls: "echoink-knowledge-init-actions" });
  if (!service) { status.setText(english ? "Knowledge service is unavailable." : "知识库服务尚未就绪。"); return () => undefined; }
  let rendered = "";
  let pagination = 0;
  const invoke = (action: () => Promise<unknown>) => void action().catch(error => { status.setText(error instanceof Error ? error.message : String(error)); new Notice(status.textContent ?? ""); });
  const render = (task: KnowledgeLinkingTask | null) => {
    status.setText(task ? knowledgeLinkingProgressText(task, english) : english ? "No previous task" : "暂无关联补全任务");
    const key = task ? `${task.id}:${task.phase}:${task.patches.length}:${task.results.length}` : "empty";
    if (key === rendered) return;
    if (rendered.split(":")[0] !== key.split(":")[0]) pagination = 0;
    rendered = key;
    disposeOriginControls(content); disposeOriginControls(actions); content.empty(); actions.empty();
    if (task?.error) content.createEl("p", { cls: "echoink-knowledge-linking-error", text: task.error });
    if (task?.phase === "awaiting-confirmation") {
      const patches = task.patches.slice(pagination * 20, (pagination + 1) * 20);
      for (const patch of patches) {
        const row = content.createDiv({ cls: "echoink-knowledge-linking-preview-note" });
        const title = row.createEl("a", { text: patch.path, href: "#" });
        title.onclick = event => { event.preventDefault(); void plugin.app.workspace.openLinkText(patch.path, "", true); };
        for (const mention of patch.mentions) {
          row.createEl("p", { text: previewMentionLine(patch.before, mention.start, mention.end) });
          row.createDiv({ text: `${mention.text} → ${mention.targetPath}` });
        }
        if (patch.addedAliases.length) row.createDiv({ text: `${english ? "New aliases" : "新增别名"}：${patch.addedAliases.join("、")}` });
      }
      paginationControls(task.patches.length, task);
      createOriginButton(actions, { text: english ? "Cancel task" : "取消任务" }).onclick = () => invoke(() => service.cancel());
      const confirm = createOriginButton(actions, { cls: "mod-cta", text: english ? "Confirm linking" : "确认补全" });
      confirm.disabled = plugin.settings.defaultPermission === "read-only";
      confirm.onclick = () => { confirm.disabled = true; invoke(() => service.confirm()); };
    } else if (task?.phase === "queued") {
      // This task will start after the current Vault linking task finishes.
    } else if (task && ["scanning", "judging", "writing"].includes(task.phase)) {
      createOriginButton(actions, { text: english ? "Cancel task" : "取消任务" }).onclick = () => invoke(() => service.cancel());
    } else if (task?.phase === "interrupted") {
      createOriginButton(actions, { text: english ? "Cancel task" : "取消任务" }).onclick = () => invoke(() => service.cancel());
      createOriginButton(actions, { cls: "mod-cta", text: english ? "Continue" : "继续" }).onclick = () => invoke(() => service.resume());
    } else {
      for (const result of task?.results.slice(pagination * 20, (pagination + 1) * 20) ?? []) {
        const row = content.createDiv({ cls: "echoink-knowledge-linking-result-note" });
        const link = row.createEl("a", { href: "#", text: result.path });
        link.onclick = event => { event.preventDefault(); void plugin.app.workspace.openLinkText(result.path, "", true); };
        const resultText = english ? result.status === "written" ? `${result.links} links · ${result.aliases} aliases` : result.status === "failed" ? "Failed" : "Skipped" : result.status === "written" ? `补全 ${result.links} 处关联 · ${result.aliases} 个别名` : result.status === "failed" ? "失败" : "跳过";
        row.createSpan({ text: ` · ${resultText}` });
        if (result.message) row.createDiv({ text: result.message });
      }
      if (task) paginationControls(task.results.length, task);
      if (task && ["partial", "failed"].includes(task.phase)) createOriginButton(actions, { text: english ? "Close result" : "关闭结果" }).onclick = () => invoke(async () => { if (!taskId || service.snapshot()?.id === taskId) await service.dismiss(); onBack(); });
      createOriginButton(actions, { cls: "mod-cta", text: english ? "Complete knowledge links" : "补全知识关联" }).onclick = () => invoke(async () => { const started = await service.start(); await plugin.openKnowledgeLinkingDetails(started.id); });
    }
  };
  function paginationControls(count: number, task: KnowledgeLinkingTask) {
    if (count <= 20) return;
    createOriginPagination(content, pagination + 1, Math.ceil(count / 20), next => { pagination = next - 1; rendered = task.id; render(task); });
  }
  let closed = false; let terminal = false;
  const selected = (task: KnowledgeLinkingTask | null) => {
    if (closed) return;
    if (!taskId || task?.id === taskId) { render(task); return; }
    if (terminal) return;
    void service.readTask(taskId).then(saved => {
      if (closed || !saved) return;
      terminal = ["completed", "partial", "failed", "cancelled"].includes(saved.phase);
      render(saved);
    });
  };
  const unsubscribe = service.subscribe(selected);
  return () => { closed = true; unsubscribe(); disposeOriginControls(page); };
}

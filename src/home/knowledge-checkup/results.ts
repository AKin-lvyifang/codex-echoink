import type {
  MaintenanceUpgradePreview,
  MaintenanceUpgradeSnapshot,
} from "../../knowledge-base/maintenance-upgrade-contract";
import { CHECKUP_GROUPS } from "./rows";
import { createOriginSelect } from "../../settings/origin-controls";
import { setIcon, type App } from "obsidian";

function label(kind: string) {
  return (
    CHECKUP_GROUPS.flatMap((group) => [...group.kinds]).find((pair) => pair[0] === kind)?.[1] ??
    "修复"
  );
}
function entry(parent: HTMLElement, title: string, action: string) {
  const row = parent.createDiv({ cls: "knowledge-checkup-preview-row" });
  row.createSpan({ text: title });
  row.createSpan({ text: action });
}
export function renderCheckupPreview(
  parent: HTMLElement,
  preview: MaintenanceUpgradePreview,
  choice?: { app: App; disabled?: boolean; change(id: string, value: string): Promise<void> },
) {
  if (preview.checkupActions?.length) {
    for (const kind of new Set(preview.checkupActions.map((row) => row.kind))) {
      const rows = preview.checkupActions.filter((row) => row.kind === kind);
      parent.createDiv({
        cls: "knowledge-checkup-result-label",
        text: `${label(kind)} ${rows.length}`,
      });
      for (const row of rows) {
        entry(parent, row.title, row.action);
        if (row.failure) parent.createDiv({ cls: "knowledge-error", text: row.failure });
        if (row.choice && choice && !row.failure) {
          const host = parent.createDiv({ cls: "knowledge-checkup-preview-choice" });
          host.createSpan({ text: row.choice.label });
          const select = createOriginSelect(host, { attr: { "aria-label": row.choice.label } },
            row.choice.options, row.choice.value, choice.app);
          select.element.disabled = choice.disabled ?? false;
          select.element.addEventListener("change", () => { void choice.change(row.id, select.element.value); });
        }
        if (row.merge) {
          if (row.merge.omittedParagraphs) entry(parent, "重复段落", `略去 ${row.merge.omittedParagraphs} 段`);
          entry(parent, "归档", `已合并/${row.merge.secondary.split("/").at(-1)}`);
          const same: string[] = [];
          const changed: string[] = [];
          for (const section of row.merge.sections) {
            if (section.sourceTitle === section.targetTitle) same.push(section.sourceTitle);
            else changed.push(`${section.sourceTitle} → ${section.targetTitle}`);
          }
          entry(parent, "小节去向", [
            ...(same.length ? [`同名并入：${same.join("、")}`] : []),
            ...changed,
          ].join("\n"));
          if (row.merge.properties?.length) entry(parent, "属性变化", row.merge.properties.join("；"));
          const additions = (row.merge.additions ?? []).map(section => ({
            ...section,
            body: section.body.replace(/<!--\s*echoink-source\s*:\s*\{[^\r\n]*\}\s*-->/gu, "").trim(),
          })).filter(section => section.body);
          if (additions.length) {
            const added = parent.createDiv({ cls: "knowledge-checkup-diff" });
            added.createDiv({ text: "新增正文" });
            for (const section of additions) {
              added.createEl("strong", { text: section.title });
              added.createEl("pre", { text: section.body });
            }
          }
          for (const anchor of row.merge.anchors) entry(parent, "引用", anchor);
        }
        for (const change of row.merge ? [] : row.changes ?? []) {
          const diff = parent.createDiv({ cls: "knowledge-checkup-diff" });
          diff.createDiv({ text: change.path.split("/").at(-1)!.replace(/\.md$/u, "") });
          diff.createDiv({ cls: "knowledge-note", text: "修改前" });
          diff.createEl("pre", { text: change.before });
          diff.createDiv({ cls: "knowledge-note", text: "修改后" });
          diff.createEl("pre", { text: change.after });
        }
        for (const skipped of row.skipped ?? []) entry(parent, skipped.path, skipped.message);
      }
    }
    return;
  }
  for (const row of preview.automatic) entry(parent, row.title, row.properties.join("、"));
}
export function renderCheckupReceipt(parent: HTMLElement, job: MaintenanceUpgradeSnapshot) {
  const results = job.checkupResults;
  if (!results) {
    for (const issue of job.preview?.issues.filter((issue) => issue.executionFailure) ?? [])
      entry(parent, issue.title ?? issue.path ?? "笔记", issue.message);
    return;
  }
  const failures = results.filter((row) => row.status === "failed");
  if (failures.length) {
    parent.createDiv({
      cls: "knowledge-checkup-result-label",
      text: `没修好 ${failures.length} 项`,
    });
    for (const row of failures) entry(parent, row.title, row.message ?? "未完成，原文保留");
  }
  for (const skipped of results.flatMap(row => row.skipped ?? []))
    entry(parent, skipped.path, skipped.message);
  const successes = results.filter((row) => row.status === "success");
  for (const kind of new Set(successes.map((row) => row.kind))) {
    const rows = successes.filter((row) => row.kind === kind);
    const group = parent.createEl("details", { cls: "knowledge-checkup-success" });
    const summary = group.createEl("summary");
    const icon = summary.createSpan({ cls: "knowledge-map-chevron", attr: { "aria-hidden": "true" } });
    setIcon(icon, "chevron-right");
    summary.createSpan({ text: `${label(kind)} ${rows.length} 项已修复` });
    for (const row of rows) entry(group, row.title, row.action);
  }
}

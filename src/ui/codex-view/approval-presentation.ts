import type { SettingsLanguage } from "../../settings/settings";

export interface ApprovalPresentationField {
  readonly label: string;
  readonly value: string;
}

export interface ApprovalPresentation {
  readonly action: string;
  readonly destination: readonly ApprovalPresentationField[];
  readonly changes: readonly ApprovalPresentationField[];
  readonly notices: readonly string[];
  readonly technicalDetails: readonly ApprovalPresentationField[];
  readonly english: boolean;
}

type JsonObject = Record<string, unknown>;

/** A display projection only. The original strings remain the approval binding's input. */
export function formatApprovalPresentation(input: Readonly<{
  target?: string;
  preview?: string;
  language?: SettingsLanguage;
}>): ApprovalPresentation {
  const english = input.language === "en";
  const text = (zh: string, en: string) => english ? en : zh;
  const target = parseDisplayValue(input.target);
  const preview = parseDisplayValue(input.preview);
  const targetObject = objectValue(target);
  const previewObject = objectValue(preview);
  const mcp = targetObject?.kind === "mcp_tool"
    || (typeof previewObject?.server === "string" && typeof previewObject?.tool === "string");
  const destination: ApprovalPresentationField[] = [];
  const changes: ApprovalPresentationField[] = [];
  const notices: string[] = [];
  const consumedTarget = new Set<string>();
  const consumedPreview = new Set<string>();
  let action = text("执行本次操作", "Perform this operation");
  const add = (list: ApprovalPresentationField[], label: string, value: unknown) => {
    list.push({ label, value: displayScalar(value, english) });
  };
  const targetPaths = pathFields(targetObject);
  const previewPaths = pathFields(previewObject);

  if (mcp) {
    action = text("调用服务操作", "Call a service operation");
    const server = previewObject?.server ?? targetObject?.resourceName;
    const tool = previewObject?.tool ?? targetObject?.toolName;
    if (server !== undefined) add(destination, text("服务", "Service"), server);
    if (tool !== undefined) add(destination, text("操作", "Operation"), tool);
    // Explicit path fields are evidence; a tool's name is never evidence of a path or effect.
    for (const field of pathFields(objectValue(previewObject?.arguments), true)) {
      add(destination, pathLabel(field.label.split(".").at(-1)!, english), field.value);
      consumedPreview.add(`arguments.${field.label}`);
    }
    if (previewObject?.destructive === true) {
      notices.push(text("该服务将本次操作标记为破坏性操作。", "The service marks this operation as destructive."));
    }
    // Keep conflicting descriptor/preview names visible instead of silently choosing one.
    if (targetObject?.resourceName === server) consumedTarget.add("resourceName");
    if (targetObject?.toolName === tool) consumedTarget.add("toolName");
    if (targetObject?.kind === "mcp_tool") consumedTarget.add("kind");
    if (typeof targetObject?.resourceId === "string") consumedTarget.add("resourceId");
    if (typeof previewObject?.server === "string") consumedPreview.add("server");
    if (typeof previewObject?.tool === "string") consumedPreview.add("tool");
    if (typeof previewObject?.destructive === "boolean") consumedPreview.add("destructive");
  } else {
    const operation = previewObject?.operation ?? previewObject?.command ?? targetObject?.command;
    const actions: Record<string, string> = {
      note_create: text("新建文件", "Create a file"),
      note_update: text("修改文件", "Update a file"),
      metadata_update: text("修改文件属性", "Update file properties"),
      note_move: text("移动文件", "Move a file"),
      note_delete: text("删除文件", "Delete a file"),
      create: text("新建文件", "Create a file"),
      append: text("追加内容", "Append content"),
      prepend: text("在开头添加内容", "Prepend content"),
      "daily:append": text("追加日记内容", "Append to a daily note"),
      "daily:prepend": text("在日记开头添加内容", "Prepend to a daily note"),
      move: text("移动文件", "Move a file"),
      delete: text("删除文件", "Delete a file")
    };
    if (typeof operation === "string") {
      action = Object.hasOwn(actions, operation) ? actions[operation]! : operation;
      if (previewObject?.operation === operation) consumedPreview.add("operation");
      if (previewObject?.command === operation) consumedPreview.add("command");
      if (targetObject?.command === operation) consumedTarget.add("command");
    }
    for (const field of targetPaths) {
      add(destination, pathLabel(field.label, english), field.value);
      consumedTarget.add(field.label);
    }
    for (const field of previewPaths) {
      const same = targetPaths.some((candidate) => candidate.label === field.label && candidate.value === field.value);
      if (!same) add(destination, targetPaths.length ? text(`预览位置 · ${pathLabel(field.label, false)}`, `Preview location · ${pathLabel(field.label, true)}`) : pathLabel(field.label, english), field.value);
      consumedPreview.add(field.label);
    }
    if (!targetObject && target !== undefined && !Array.isArray(target)) {
      add(destination, text("目标", "Target"), target);
    }
    if (operation === "note_delete" || operation === "delete") {
      notices.push(text("将删除以上文件。", "The file above will be deleted."));
    }
    renderContentFields(previewObject, changes, consumedPreview, english);
    const change = objectValue(previewObject?.change);
    if (change) {
      const consumedChange = new Set<string>();
      const diff = typeof change.diff === "string" ? splitUnifiedDiff(change.diff) : null;
      if (diff && !consumedPreview.has("content") && !consumedPreview.has("after")) {
        if (change.kind !== "add") add(changes, text("修改前（变更片段）", "Before (changed excerpt)"), diff.before);
        add(changes, change.kind === "add" ? text("新增内容", "New content") : text("修改后（变更片段）", "After (changed excerpt)"), diff.after);
        consumedChange.add("diff");
      }
      if (change.truncated === true) {
        notices.push(text("工具提供的预览已截断，当前仅展示部分内容", "The tool's preview is truncated; only part of the content is shown."));
      }
      for (const field of flattenFields(change, "change", consumedChange, english)) changes.push(field);
      consumedPreview.add("change");
    }
  }

  if (targetObject) changes.push(...flattenFields(targetObject, "", consumedTarget, english));
  if (Array.isArray(target)) changes.push(...flattenFields({ target }, "", new Set(), english));
  if (previewObject) changes.push(...flattenFields(previewObject, "", consumedPreview, english));
  else if (Array.isArray(preview)) changes.push(...flattenFields({ preview }, "", new Set(), english));
  else if (preview !== undefined) add(changes, text("内容预览", "Content preview"), preview);
  if (mcp && !targetObject && target !== undefined && !Array.isArray(target)) add(destination, text("目标", "Target"), target);

  return {
    action, destination, changes, notices, english,
    technicalDetails: [
      ...(input.target === undefined ? [] : [{ label: text("原始目标", "Original target"), value: input.target }]),
      ...(input.preview === undefined ? [] : [{ label: text("原始预览与参数", "Original preview and parameters"), value: input.preview }])
    ]
  };
}

/** Render all supplied text as text, including file content and tool-provided strings. */
export function renderApprovalPresentation(container: HTMLElement, presentation: ApprovalPresentation): HTMLElement {
  const text = (zh: string, en: string) => presentation.english ? en : zh;
  // Decision-relevant warnings remain beside the header, outside the scrolling details.
  if (presentation.notices.length) {
    const notices = container.createDiv({ cls: "codex-approval-notices", attr: { role: "note", "aria-label": text("操作提醒", "Operation warnings") } });
    for (const notice of presentation.notices) notices.createDiv({ cls: "codex-approval-notice", text: notice });
  }
  const body = container.createDiv({ cls: "codex-approval-presentation", attr: { tabindex: "0", "aria-label": text("操作详情", "Operation details") } });
  const section = (label: string) => {
    const root = body.createDiv({ cls: "codex-approval-presentation-section" });
    root.createDiv({ cls: "codex-smooth-ai-approval-label", text: label });
    return root;
  };
  section(text("将做什么", "What will happen")).createDiv({ cls: "codex-approval-action", text: presentation.action });
  const fields = (parent: HTMLElement, values: readonly ApprovalPresentationField[]) => {
    for (const field of values) {
      const row = parent.createDiv({ cls: "codex-approval-field" });
      row.createDiv({ cls: "codex-approval-field-label", text: field.label });
      row.createDiv({ cls: "codex-approval-field-value", text: field.value, attr: { tabindex: "0", "aria-label": field.label } });
    }
  };
  if (presentation.destination.length) fields(section(text("写到哪里 / 提交到哪里", "Where it goes")), presentation.destination);
  if (presentation.changes.length) fields(section(text("新增或改了什么", "What is added or changed")), presentation.changes);
  if (presentation.technicalDetails.length) {
    const details = body.createEl("details", { cls: "codex-approval-technical-details" });
    details.createEl("summary", { text: text("技术详情", "Technical details") });
    fields(details, presentation.technicalDetails);
  }
  return body;
}

function parseDisplayValue(value: string | undefined): unknown {
  if (value === undefined || !value.trim()) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function displayScalar(value: unknown, english: boolean): string {
  if (typeof value === "string") return value || (english ? "(empty text)" : "（空文本）");
  return JSON.stringify(value) ?? String(value);
}

function pathFields(value: JsonObject | undefined, nested = false): ApprovalPresentationField[] {
  if (!value) return [];
  const keys = new Set(["relativePath", "path", "filePath", "sourcePath", "targetPath", "destinationPath", "recordPath", "dailyPath"]);
  if (nested) {
    const fields: ApprovalPresentationField[] = [];
    const pending = [{ label: "", value }];
    while (pending.length) {
      const parent = pending.pop()!;
      for (const [key, entry] of Object.entries(parent.value)) {
        const label = parent.label ? Array.isArray(parent.value) ? `${parent.label}[${key}]` : `${parent.label}.${key}` : key;
        if (keys.has(key) && typeof entry === "string") fields.push({ label, value: entry });
        else if (entry !== null && typeof entry === "object") pending.push({ label, value: entry as JsonObject });
      }
    }
    return fields;
  }
  return Object.entries(value).filter(([key, entry]) => keys.has(key) && typeof entry === "string")
    .map(([label, entry]) => ({ label, value: entry as string }));
}

function pathLabel(key: string, english: boolean): string {
  if (key === "sourcePath") return english ? "From" : "原位置";
  if (key === "targetPath" || key === "destinationPath") return english ? "To" : "新位置";
  return english ? "File path" : "文件路径";
}

function renderContentFields(preview: JsonObject | undefined, fields: ApprovalPresentationField[], consumed: Set<string>, english: boolean): void {
  if (!preview) return;
  const labels: Record<string, string> = {
    content: english ? "Content to write" : "待写内容",
    before: english ? "Before" : "修改前",
    after: english ? "After" : "修改后"
  };
  for (const key of Object.keys(labels)) {
    if (typeof preview[key] !== "string") continue;
    fields.push({ label: labels[key]!, value: displayScalar(preview[key], english) });
    consumed.add(key);
  }
}

/** Iterative traversal keeps unknown nested fields and empty collections readable without truncation. */
function flattenFields(value: JsonObject, prefix: string, consumed: ReadonlySet<string>, english: boolean): ApprovalPresentationField[] {
  const fields: ApprovalPresentationField[] = [];
  const knownLabels: Record<string, string> = {
    "arguments.title": english ? "Title" : "标题",
    "arguments.content": english ? "Content" : "内容",
    "change.added": english ? "Added lines" : "新增行数",
    "change.removed": english ? "Removed lines" : "移除行数"
  };
  const pending = Object.entries(value).filter(([key]) => !consumed.has(key))
    .map(([key, entry]) => ({ label: prefix ? `${prefix}.${key}` : key, value: entry })).reverse();
  while (pending.length) {
    const field = pending.pop()!;
    if (consumed.has(field.label)) continue;
    const entries = Array.isArray(field.value)
      ? field.value.map((entry, index) => [`${field.label}[${index}]`, entry] as const)
      : objectValue(field.value) ? Object.entries(field.value as JsonObject).map(([key, entry]) => [`${field.label}.${key}`, entry] as const) : [];
    if (!entries.length) fields.push({ label: Object.hasOwn(knownLabels, field.label) ? knownLabels[field.label]! : field.label, value: displayScalar(field.value, english) });
    else for (let index = entries.length - 1; index >= 0; index--) pending.push({ label: entries[index]![0], value: entries[index]![1] });
  }
  return fields;
}

function splitUnifiedDiff(value: string): Readonly<{ before: string; after: string }> | null {
  const lines = value.split("\n");
  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line)) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
    else if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line !== "\\ No newline at end of file") return null;
  }
  return inHunk ? { before: before.join("\n"), after: after.join("\n") } : null;
}

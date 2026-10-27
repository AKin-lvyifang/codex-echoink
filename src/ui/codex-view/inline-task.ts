import { Notice, setIcon } from "obsidian";
import type { AgentDefinition } from "../../agents/types";
import type { TaskEntry } from "../../agents/task-presentation";
import type { ConversationTaskStatus } from "../../agents/task-metadata";
import type { InlineRequest, InlineThreadMessage, InlineVersion } from "../../inline-agent/types";
import type { SettingsLanguage } from "../../settings/settings";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { renderTaskAvatar } from "./agent-roster";
import { markAIElementsQuestion } from "./smooth-chat-ui";
import type { SelectionAnnotation } from "../../types/selection-annotations";
import type { InlineGenerationAccess } from "../../inline-agent/access";

export interface InlineTaskHost {
  generationAccess?(): InlineGenerationAccess;
  openProBenefits?(): Promise<void>;
  service: {
    list(): InlineRequest[];
    latestForTask(taskId: string): InlineRequest | undefined;
    get(id: string): InlineRequest | undefined;
    confirm(id: string, versionId: string): Promise<void>;
    revoke(id: string, versionId: string): Promise<void>;
    compare(id: string): void;
    comparingOriginal: Set<string>;
    canAutomaticallyRegenerate?(id: string): boolean;
  };
  runtime: { reply(taskId: string, text: string, annotations?: readonly SelectionAnnotation[]): Promise<void>; retry(taskId: string): Promise<void>; stop(taskId: string): Promise<void> };
  openSource(requestId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function renderInlineGenerationGate(root: HTMLElement, host: InlineTaskHost | undefined, language: SettingsLanguage): void {
  const policy = host?.generationAccess?.();
  if (!policy || policy.allowed) return;
  const hint = root.createDiv({ cls: "echoink-inline-generation-gate", attr: { role: "status" } });
  hint.createSpan({ text: policy.message });
  if (policy.requiresPro) {
    const upgrade = createOriginButton(hint, { cls: "echoink-inline-task-action", text: language === "en" ? "View PRO benefits" : "查看 PRO 权益" });
    upgrade.onclick = () => { void host?.openProBenefits?.().catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
  }
}

export function inlineTaskHost(plugin: object): InlineTaskHost | undefined {
  return (plugin as { inlineAgent?: InlineTaskHost | null }).inlineAgent ?? undefined;
}
const english = (language: SettingsLanguage) => language === "en";
export const inlineNoteName = (path: string): string => path.split("/").at(-1)?.replace(/\.md$/iu, "") ?? path;
export function inlineTaskState(request: InlineRequest): ConversationTaskStatus {
  if (["pending", "clarifying", "conflict", "save_failed"].includes(request.status)) return "waiting";
  if (["preparing", "thinking", "queued", "saving"].includes(request.status)) return "running";
  if (["interrupted", "failed", "missing"].includes(request.status)) return "interrupted";
  return "completed";
}
export function inlineTaskStatus(request: InlineRequest, language: SettingsLanguage = "zh-CN"): string {
  const labels = english(language)
    ? { preparing: "Preparing", thinking: "Thinking", clarifying: "Waiting for you", queued: "Queued", pending: "Awaiting confirmation", conflict: "Text changed", failed: "Failed · retry", interrupted: "Interrupted", missing: "Source position deleted", saving: "Saving", save_failed: "Save failed", confirmed: "Confirmed", revoked: "Suggestion revoked", withdrawn: "Reverted", modified: "Manually edited" }
    : { preparing: "正在准备", thinking: "思考中", clarifying: "等你回答", queued: "等待前一块处理", pending: "待确认", conflict: "目标已变动", failed: "失败·可重试", interrupted: "已中断", missing: "正文位置已删除", saving: "正在保存", save_failed: "保存失败", confirmed: "已确认", revoked: "已撤销建议", withdrawn: "已撤回", modified: "已手动修改" };
  return labels[request.status];
}

export function inlineOriginalRequirement(request: InlineRequest): string {
  const text = request.instruction.text.replace(request.instruction.marker, "").trimEnd();
  const prefix = `${request.instruction.trigger}${request.agentName}`;
  return text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text;
}

/** Display-only projection. A stale run's Catalog metadata cannot dismiss an unconfirmed block. */
export function projectInlineTaskEntries(entries: readonly TaskEntry[], requests: readonly InlineRequest[]): TaskEntry[] {
  const latest = new Map<string, InlineRequest>();
  for (const request of requests) if (!latest.has(request.taskId) || latest.get(request.taskId)!.createdAt <= request.createdAt) latest.set(request.taskId, request);
  const result = entries.map(entry => {
    const request = latest.get(entry.conversationId); latest.delete(entry.conversationId);
    return request && entry.status !== "deleted" ? project(entry, request) : entry;
  });
  for (const request of latest.values()) result.push(project({ conversationId: request.taskId, piSessionId: "", vaultId: request.vaultId,
    title: inlineOriginalRequirement(request), status: "active", defaultMemoryMode: "normal", createdAt: request.createdAt, updatedAt: request.updatedAt }, request));
  return result;
}
function project(entry: TaskEntry, request: InlineRequest): TaskEntry {
  const taskStatus = inlineTaskState(request);
  return { ...entry, agentId: request.agentId, taskStatus, pendingResponse: undefined, taskStage: inlineTaskStatus(request),
    updatedAt: Math.max(entry.updatedAt, request.updatedAt), taskCompletedAt: taskStatus === "completed" ? request.updatedAt : undefined,
    taskInterruptedAt: taskStatus === "interrupted" ? request.updatedAt : undefined };
}

export function inlineTaskSummary(request: InlineRequest): string {
  return `${inlineNoteName(request.path)} · ${inlineOriginalRequirement(request)}`;
}
export function inlineTaskUiSignature(requests: readonly InlineRequest[], comparing: boolean, language: SettingsLanguage): string {
  return JSON.stringify([language, comparing, requests.map(request => ({ id: request.id, path: request.path, section: request.section, status: request.status,
    agentId: request.agentId, agentName: request.agentName, currentVersionId: request.currentVersionId, error: request.error, question: request.question,
    instruction: request.instruction.text, marker: request.instruction.marker, thread: request.thread, followups: request.followups,
    context: request.readContext?.text ?? request.versions.find(version => version.id === request.currentVersionId)?.context.text,
    commit: request.commit && [request.commit.action, request.commit.versionId, request.commit.savedAt],
    versions: request.versions.map(version => [version.id, version.number, version.text, version.target.text]) }))]);
}

export function friendlyInlineMessage(text: string, language: SettingsLanguage = "zh-CN"): string {
  if (/^\s*[[{]/u.test(text)) {
    try { if (JSON.parse(text) && typeof JSON.parse(text) === "object") return english(language) ? "The result is ready to review." : "处理好了，可以看看这一版。"; } catch { /* Ordinary prose is shown as written. */ }
  }
  if (english(language)) return text;
  const version = /^已准备第\s*(\d+)\s*版/u.exec(text);
  if (version) return `第 ${version[1]} 版写好了，已经放在正文里等你确认。`;
  if (/^已确认本次修改/u.test(text)) return "已写入正文。";
  if (/^已撤销未确认建议/u.test(text)) return "已撤销，原文没动。想换个说法，可以编辑上面的要求再发。";
  if (/^重新读取最新正文/u.test(text)) return "我按最新正文再写一版。";
  return text;
}

type ThreadItem = { request: InlineRequest; message: InlineThreadMessage };
function threadItems(requests: readonly InlineRequest[]): ThreadItem[] {
  return requests.flatMap(request => {
    const messages: InlineThreadMessage[] = request.thread?.length ? [...request.thread] : [{ id: `${request.id}-original`, role: "user", text: inlineOriginalRequirement(request), at: request.createdAt }];
    for (const version of request.versions) if (!messages.some(message => message.versionId === version.id)) messages.push({ id: `${request.id}-${version.id}`, role: "assistant", text: `已准备第 ${version.number} 版`, at: version.createdAt, versionId: version.id });
    if (request.question && !messages.some(message => message.role === "assistant" && (message.question || message.text === request.question?.question))) messages.push({ id: `${request.id}-question`, role: "assistant", text: request.question.question, question: request.question, at: request.updatedAt });
    return messages.map(message => ({ request, message }));
  });
}

export class InlineTaskDetailView {
  private readonly source: HTMLElement;
  private readonly pin: HTMLElement;
  private readonly thread: HTMLElement;
  private signature = "";
  private taskId = "";
  private current?: { request: InlineRequest; requests: readonly InlineRequest[]; agent: AgentDefinition; language: SettingsLanguage };
  private readonly nodes = new Map<string, { signature: string; node: HTMLElement }>();
  private editing?: { key: string; text: string; element?: HTMLTextAreaElement; composing: boolean };
  private readonly busy = new Set<string>();
  private disposed = false;
  constructor(private readonly root: HTMLElement, private readonly host: () => InlineTaskHost | undefined) {
    root.classList.add("echoink-inline-task-body");
    this.source = root.createDiv({ cls: "echoink-inline-task-source" });
    this.pin = root.createDiv({ cls: "echoink-inline-task-pin", attr: { "aria-live": "polite" } });
    this.thread = root.createDiv({ cls: "echoink-inline-task-thread" });
  }
  render(request: InlineRequest, requests: readonly InlineRequest[], agent: AgentDefinition, language: SettingsLanguage): void {
    if (this.disposed) return;
    const sorted = requests.filter(item => item.taskId === request.taskId).sort((a, b) => a.createdAt - b.createdAt);
    if (!sorted.length) sorted.push(request);
    const comparing = this.host()?.service.comparingOriginal.has(request.id) ?? false;
    const signature = inlineTaskUiSignature(sorted, comparing, language) + JSON.stringify([agent.name, agent.avatar, this.host()?.generationAccess?.()]);
    if (this.taskId !== request.taskId) { this.editing = undefined; this.signature = ""; this.nodes.clear(); disposeOriginControls(this.thread); this.thread.empty(); }
    const changedTask = this.taskId !== request.taskId;
    this.taskId = request.taskId; this.current = { request, requests: sorted, agent, language };
    if (signature === this.signature) return;
    this.signature = signature;
    const follow = changedTask || this.root.scrollTop + this.root.clientHeight >= this.root.scrollHeight - 40;
    this.renderSource(request, language); this.renderPin(request, language, comparing); this.renderThread();
    if (follow && !this.editing) this.root.scrollTop = this.root.scrollHeight;
  }
  dispose(): void { this.disposed = true; disposeOriginControls(this.root); this.nodes.clear(); this.current = undefined; }

  private button(root: HTMLElement, text: string, operation: string, run: () => Promise<void> | void, primary = false): HTMLButtonElement {
    const button = createOriginButton(root, { cls: `echoink-inline-task-action${primary ? " is-primary" : ""}`, text, attr: { type: "button", "data-inline-action": operation } });
    button.disabled = this.busy.size > 0;
    button.onclick = () => { void this.perform(operation, run, button); };
    return button;
  }
  private async perform(key: string, run: () => Promise<void> | void, button?: HTMLButtonElement): Promise<void> {
    if (this.busy.size) return;
    this.busy.add(key); if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    try { await run(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally {
      this.busy.delete(key); if (button?.isConnected) { button.disabled = false; button.removeAttribute("aria-busy"); }
      this.signature = ""; this.refresh();
      this.refreshEditingButtons();
    }
  }
  private refresh(): void {
    const current = this.current; if (!current || this.disposed) return;
    const host = this.host(), request = host?.service.latestForTask(current.request.taskId) ?? current.request;
    this.render(request, host?.service.list() ?? current.requests, current.agent, current.language);
  }
  private renderSource(request: InlineRequest, language: SettingsLanguage): void {
    const open = this.source.querySelector("details")?.open ?? false;
    disposeOriginControls(this.source); this.source.empty();
    const source = this.button(this.source, `${inlineNoteName(request.path)}${request.section ? ` › ${request.section}` : ""}`, "source", () => this.host()?.openSource(request.id));
    source.classList.add("echoink-inline-task-source-link");
    const context = request.readContext?.text ?? request.versions.find(version => version.id === request.currentVersionId)?.context.text;
    if (context !== undefined) {
      const details = this.source.createEl("details", { cls: "echoink-inline-task-read" }); details.open = open;
      details.createEl("summary", { text: english(language) ? "Read the full note" : "读了全文" });
      details.createDiv({ cls: "echoink-inline-task-snapshot", text: context });
    }
  }
  private renderPin(request: InlineRequest, language: SettingsLanguage, comparing: boolean): void {
    disposeOriginControls(this.pin); this.pin.empty();
    const en = english(language), host = this.host(), version = request.versions.find(item => item.id === request.currentVersionId);
    this.pin.classList.toggle("is-attention", ["clarifying", "conflict", "interrupted", "failed", "missing", "save_failed"].includes(request.status));
    const lead = this.pin.createDiv({ cls: "echoink-inline-task-pin-lead" });
    const actions = this.pin.createDiv({ cls: "echoink-inline-task-pin-actions" });
    const revoke = (label = en ? "Revoke" : "撤销") => this.button(actions, label, "revoke", () => host?.service.revoke(request.id, request.currentVersionId));
    const retry = () => this.button(actions, en ? "Retry" : "重试", "retry", () => host?.runtime.retry(request.taskId), true);
    switch (request.status) {
      case "pending": {
        lead.textContent = `${request.section ? en ? `Edit “${request.section}”` : `改「${request.section}」` : en ? "Draft ready" : "新稿待确认"}${version && version.number > 1 ? en ? ` · Version ${version.number}` : ` · 第 ${version.number} 版` : ""}${comparing ? en ? " · Original text" : " · 正在看原文" : ""}`;
        this.button(actions, comparing ? en ? "Show draft" : "看新稿" : en ? "Compare" : "对比", "compare", () => host?.service.compare(request.id));
        revoke();
        const confirm = this.button(actions, en ? "Confirm" : "确认", "confirm", () => host?.service.confirm(request.id, request.currentVersionId), true);
        confirm.disabled ||= comparing || !version;
        if (comparing) confirm.title = en ? "Show the draft before confirming" : "先切回新稿，再确认";
        break;
      }
      case "preparing": case "thinking":
        setIcon(lead.createSpan({ cls: "echoink-inline-task-spinner", attr: { "aria-hidden": "true" } }), "loader-circle");
        lead.createSpan({ text: en ? "Writing · Your note is unchanged" : "正在写 · 正文还没改" });
        this.button(actions, en ? "Stop" : "停止", "stop", () => host?.runtime.stop(request.taskId)); break;
      case "clarifying": lead.textContent = en ? "Waiting for your answer" : "等你回答"; revoke(); break;
      case "queued":
        lead.textContent = en ? "Queued · Waiting for the preceding block" : "排队中 · 等前一块处理完";
        revoke();
        if (host?.service.canAutomaticallyRegenerate?.(request.id) === false && request.queue?.blockedBy.length === 0) retry();
        break;
      case "conflict": lead.textContent = en ? "Target text changed · Confirmation blocked" : "目标已变动，已阻止确认"; revoke(); retry(); break;
      case "failed": case "interrupted": lead.textContent = inlineTaskStatus(request, language); revoke(); retry(); break;
      case "missing": lead.textContent = en ? "The source position was deleted" : "正文位置已删除"; revoke(en ? "Discard" : "丢弃"); break;
      case "save_failed": lead.textContent = en ? "Save failed · Review the note before retrying" : "保存失败，请核对正文后重试";
        if (request.commit) {
          const commit = request.commit;
          this.button(actions, en ? "Retry saving" : "重试保存", "retry-save", () => host?.service[commit.action](request.id, commit.versionId), true);
        }
        break;
      default: lead.textContent = inlineTaskStatus(request, language);
    }
    if (!actions.childElementCount) actions.remove();
    if (["clarifying", "queued", "conflict", "failed", "interrupted"].includes(request.status)) renderInlineGenerationGate(this.pin, host, language);
    if (request.error && ["conflict", "failed", "interrupted", "missing", "save_failed"].includes(request.status)) this.pin.createDiv({ cls: "echoink-inline-task-error", text: request.error });
  }
  private renderThread(): void {
    const current = this.current!;
    const items = threadItems(current.requests), roles = items.map(item => item.message.role), lastUser = roles.lastIndexOf("user"), lastAssistant = roles.lastIndexOf("assistant");
    const wanted = new Set<string>();
    items.forEach((item, index) => {
      const key = `${item.request.id}:${item.message.id}`; wanted.add(key);
      const signature = this.editing?.key === key ? `editing:${this.busy.size}` : JSON.stringify([item.message, item.request.status, item.request.currentVersionId, item.request.commit && [item.request.commit.action, item.request.commit.versionId, item.request.commit.savedAt], item.request.versions.map(version => [version.id, version.number, version.text]), index === lastUser, index === lastAssistant, current.language]);
      let entry = this.nodes.get(key);
      if (!entry || entry.signature !== signature) {
        // Keep an active editing node intact even when unrelated request state changes.
        if (!(this.editing?.key === key && entry?.node.classList.contains("is-editing"))) {
          const node = this.messageNode(item, key, index === lastUser, index === lastAssistant);
          if (entry) { disposeOriginControls(entry.node); entry.node.replaceWith(node); }
          entry = { signature, node }; this.nodes.set(key, entry);
        }
      }
      if (entry && this.thread.children[index] !== entry.node) this.thread.insertBefore(entry.node, this.thread.children[index] ?? null);
    });
    for (const [key, entry] of this.nodes) if (!wanted.has(key)) { disposeOriginControls(entry.node); entry.node.remove(); this.nodes.delete(key); }
    this.refreshEditingButtons();
  }
  private refreshEditingButtons(): void {
    const resend = this.thread.querySelector<HTMLButtonElement>('[data-inline-action="resend"]');
    const cancel = this.thread.querySelector<HTMLButtonElement>('[data-inline-action="cancel-edit"]');
    if (resend) resend.disabled = this.busy.size > 0 || !this.editing?.text.trim() || !!this.editing?.composing;
    if (cancel) cancel.disabled = this.busy.size > 0;
  }
  private messageNode(item: ThreadItem, key: string, lastUser: boolean, lastAssistant: boolean): HTMLElement {
    const { request, message } = item, { agent, language } = this.current!, en = english(language);
    const row = this.root.ownerDocument.createElement("div"); row.className = `echoink-inline-task-message is-${message.role}`;
    if (message.role === "user") {
      if (this.editing?.key === key) {
        row.classList.add("is-editing");
        const editing = this.editing, input = row.createEl("textarea", { cls: "echoink-inline-task-edit", attr: { "aria-label": en ? "Edit requirement" : "编辑要求" } });
        input.value = editing.text; editing.element = input;
        input.oninput = () => { editing.text = input.value; this.refreshEditingButtons(); };
        input.addEventListener("compositionstart", () => { editing.composing = true; this.refreshEditingButtons(); });
        input.addEventListener("compositionend", () => { editing.composing = false; this.refreshEditingButtons(); });
        const actions = row.createDiv({ cls: "echoink-inline-task-edit-actions" });
        this.button(actions, en ? "Cancel" : "取消", "cancel-edit", () => { this.editing = undefined; this.signature = ""; this.refresh(); });
        this.button(actions, en ? "Resend" : "重发", "resend", async () => {
          if (editing.composing || !editing.text.trim()) return;
          await this.host()?.runtime.reply(request.taskId, editing.text, message.selectionAnnotations ?? []); this.editing = undefined;
        }, true);
        return row;
      }
      row.createDiv({ cls: "echoink-inline-task-bubble", text: message.text });
      if (lastUser) {
        const edit = this.button(row, "", "edit", () => {
          this.editing = { key, text: message.text, composing: false }; this.signature = ""; this.refresh();
          const input = this.editing?.element; input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
        });
        edit.classList.add("echoink-inline-task-edit-button"); edit.setAttribute("aria-label", en ? "Edit and resend" : "编辑后重发"); edit.title = en ? "Edit and resend" : "编辑后重发"; setIcon(edit, "pencil");
      }
      return row;
    }
    renderTaskAvatar(row, agent, 22);
    const body = row.createDiv({ cls: "echoink-inline-task-message-body" });
    body.createDiv({ cls: "echoink-inline-task-message-text", text: friendlyInlineMessage(message.text, language) });
    const version = request.versions.find(value => value.id === message.versionId);
    if (version) this.version(body, request, version, language);
    const question = lastAssistant && request.id === this.current!.request.id && request.status === "clarifying" ? request.question ?? message.question : undefined;
    if (question) {
      markAIElementsQuestion(body); body.setAttribute("role", "group"); body.setAttribute("aria-label", question.question);
      if (question.question !== message.text) body.createDiv({ cls: "echoink-inline-task-question", text: question.question });
      const choices = body.createDiv({ cls: "echoink-inline-task-choices" });
      for (const option of question.options) this.button(choices, option.label, `answer:${option.id}`, () => this.host()?.runtime.reply(request.taskId, option.label));
    }
    return row;
  }
  private version(root: HTMLElement, request: InlineRequest, version: InlineVersion, language: SettingsLanguage): void {
    const en = english(language), written = request.commit?.action === "confirm" && request.commit.versionId === version.id && (request.commit.savedAt !== undefined || request.status === "confirmed");
    const current = request.currentVersionId === version.id && ["pending", "conflict", "saving", "save_failed"].includes(request.status);
    const label = written ? en ? "Written to note" : "已写入" : current ? en ? "Current" : "当前" : en ? "Replaced by a newer version" : "已被新版替换";
    const details = root.createEl("details", { cls: "echoink-inline-task-version" });
    details.createEl("summary", { text: `${en ? "Version" : "第"} ${version.number}${en ? "" : " 版"} · ${label}` });
    details.createDiv({ cls: "echoink-inline-task-version-text", text: version.text });
  }
}

import { getDesktopPath } from "../platform/desktop-paths";
import { Annotation, StateEffect, StateField, Transaction, type EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import * as Obsidian from "obsidian";
import { Component, MarkdownRenderer, MarkdownView, Notice, Platform, TFile, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { readVaultIdentity } from "../plugin/vault-identity";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import { locateInstruction, locateTarget, markerPattern } from "./document";
import { inlineGenerationAccess, requireInlineGeneration } from "./access";
import { InlineMentionController } from "./mention";
import { InlineAgentRuntimeController } from "./orchestrator";
import { FileInlineRepository } from "./store";
import { InlineRequestService, type InlineEditorPort } from "./service";
import type { InlineProposalInput, InlineRequest, TextSpan } from "./types";

const path = getDesktopPath();

export const inlineSystemEdit = Annotation.define<string>();
const redraw = StateEffect.define<null>();
const statePath = (state: EditorState): string | undefined => state.field(Obsidian.editorInfoField, false)?.file?.path;

/** Consume a control/target's own line break only when that line has no other prose. */
export function inlineDisplayRange(state: EditorState, span: TextSpan): TextSpan {
  const first = state.doc.lineAt(span.from), last = state.doc.lineAt(span.to > span.from ? span.to - 1 : span.to);
  if (!/^[ \t]*$/u.test(state.sliceDoc(first.from, span.from)) || !/^[ \t]*$/u.test(state.sliceDoc(span.to, Math.max(span.to, last.to)))) return span;
  return { from: first.from, to: last.to < state.doc.length ? last.to + 1 : last.to };
}

function joinedDisplayRange(state: EditorState, a: TextSpan, b: TextSpan): TextSpan | null {
  const [first, last] = a.from <= b.from ? [a, b] : [b, a];
  return first.to >= last.from || !state.sliceDoc(first.to, last.from).trim() ? { from: first.from, to: Math.max(first.to, last.to) } : null;
}

/** Desktop live-preview adapter; all note changes still go through the request service. */
export class InlineAgentController {
  readonly service: InlineRequestService;
  readonly runtime: InlineAgentRuntimeController;
  private mention?: InlineMentionController;
  private listeners = new Set<() => void>();
  private editors = new Set<EditorView>();
  private redrawQueued = false;
  private disposed = false;
  private readonly field: StateField<DecorationSet>;
  private constructor(readonly plugin: CodexForObsidianPlugin, vaultId: string, file: string) {
    this.service = new InlineRequestService(vaultId, new FileInlineRepository(file, vaultId), {
      assertCanGenerate: () => requireInlineGeneration(plugin),
      editor: notePath => this.editor(notePath), changed: () => { this.refresh(); for (const listener of this.listeners) listener(); }, report: error => this.report(error)
    });
    this.runtime = new InlineAgentRuntimeController(plugin, this.service, { editor: notePath => this.editor(notePath), openTask: id => this.openTask(id) });
    this.field = StateField.define<DecorationSet>({
      create: state => { const filePath = statePath(state); if (filePath) this.service.reconcile(filePath, state.doc.toString()); return this.decorations(state); },
      update: (_value, tr) => {
        const filePath = statePath(tr.state);
        if (filePath && tr.docChanged) this.service.observe(filePath, tr.changes, tr.startState.doc.toString(), tr.state.doc.toString(), tr.annotation(inlineSystemEdit));
        return this.decorations(tr.state);
      },
      provide: field => EditorView.decorations.from(field)
    });
  }
  static async create(plugin: CodexForObsidianPlugin): Promise<InlineAgentController> {
    const dataRoot = pluginDataDir(plugin.getVaultPath(), plugin.getPluginDataDirName());
    const identity = await readVaultIdentity(dataRoot);
    if (!identity) throw new Error("正文块尚未取得仓库身份。");
    const controller = new InlineAgentController(plugin, identity.vaultId, path.join(dataRoot, "pi-agent-product-v1", "inline-requests.v1.json"));
    await controller.service.initialize();
    return controller;
  }
  register(): void {
    if (Platform.isMobile) return;
    const attach = (view: EditorView) => this.editors.add(view);
    const detach = (view: EditorView) => this.editors.delete(view);
    const views = ViewPlugin.fromClass(class {
      constructor(readonly view: EditorView) { attach(view); }
      destroy() { detach(this.view); }
    });
    this.plugin.registerEditorExtension([this.field, views]);
    this.mention = new InlineMentionController({ plugin: this.plugin, agents: () => this.plugin.settings.agentRegistry.agents,
      enabled: () => this.generationAccess().allowed,
      trigger: () => { this.checkDateConflict(); return this.plugin.settings.inlineAgent.trigger; }, send: input => this.runtime.sendDraft(input) });
    this.mention.register();
    this.plugin.register(this.plugin.accountService?.subscribe(() => this.refreshAccess()) ?? (() => {}));
    this.plugin.app.workspace.onLayoutReady(() => this.checkDateConflict());
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => this.service.rename(oldPath, file.path)));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", file => this.service.delete(file.path)));
    this.plugin.register(() => { this.disposed = true; this.mention?.dispose(); this.runtime.dispose(); this.listeners.clear(); this.editors.clear(); void this.service.dispose().catch(error => this.report(error)); });
  }
  generationAccess() { return inlineGenerationAccess(this.plugin); }
  openProBenefits(): Promise<void> { return this.plugin.openEchoInkAccountSettings("benefits"); }
  refreshAccess(): void { this.mention?.refreshAccess(); this.runtime.refreshAccess(); for (const listener of this.listeners) listener(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async openTask(taskId: string): Promise<void> {
    await this.plugin.activateView({ focusInput: false });
    const view = this.plugin.getCodexView();
    if (view && await view.waitForTaskUiReady()) await view.openTaskDetail(taskId);
  }
  async openSource(id: string): Promise<void> {
    const r = this.service.get(id); if (!r) throw new Error("来源请求已不存在。");
    const { leaf, markdown, cm } = await this.sourceEditor(r.path), document = cm.state.doc.toString();
    await this.plugin.app.workspace.revealLeaf(leaf);
    const target = r.commit?.result ?? (r.targetResolved === false ? r.instruction : r.target);
    const located = locateTarget(document, target, r.observedDocument === document);
    if (!located || r.status === "missing") { new Notice("已打开来源笔记，原位置已变化。"); return; }
    const pos = markdown.editor.offsetToPos(located.from);
    markdown.editor.setCursor(pos); markdown.editor.scrollIntoView({ from: pos, to: pos }, true); markdown.editor.focus();
  }
  checkDateConflict(): void {
    const settings = this.plugin.settings.inlineAgent;
    if (settings.trigger !== "@" || settings.nldConflictNoticeShown) return;
    const plugins = (this.plugin.app as typeof this.plugin.app & { plugins?: { plugins?: Record<string, { settings?: { autocompleteTriggerPhrase?: string; isAutosuggestEnabled?: boolean } }> } }).plugins;
    const nld = plugins?.plugins?.["nldates-obsidian"];
    if (!nld || nld.settings?.isAutosuggestEnabled === false || (nld.settings?.autocompleteTriggerPhrase ?? "@") !== "@") return;
    settings.nldConflictNoticeShown = true;
    new Notice("正文管家和 Natural Language Dates 都在使用 @，可能互相抢占。建议在任一个插件设置里改掉唤起符号。", 12000);
    void this.plugin.saveSettings(true).catch(error => console.error("Inline mention conflict preference could not save", error));
  }
  /** Future runtime output and fixed native fixtures use the same validated proposal entry. */
  async stageProposal(input: InlineProposalInput): Promise<InlineRequest> {
    const task = await this.plugin.readPiConversationCatalogEntry(input.taskId);
    if (!task || task.status === "deleted" || task.agentId !== input.agentId) throw new Error("来源任务或管家已变化。");
    return await this.service.stageProposal(input);
  }
  private decorations(state: EditorState): DecorationSet {
    const filePath = statePath(state);
    if (!filePath || state.field(Obsidian.editorLivePreviewField, false) !== true || state.facet(EditorView.editable) === false) return Decoration.none;
    const document = state.doc.toString(), ranges: ReturnType<Decoration["range"]>[] = [];
    const records = this.service.list(filePath), known = new Map(records.map(r => [r.id, r]));
    const markers = [...document.matchAll(markerPattern())], counts = new Map<string, number>();
    for (const match of markers) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    for (const r of records) {
      if ((counts.get(r.id) ?? 0) > 1) continue;
      if (!["thinking", "clarifying", "queued", "failed", "pending", "conflict", "interrupted", "save_failed", "saving"].includes(r.status)) continue;
      const control = locateInstruction(document, r);
      if (!control && !["saving", "save_failed"].includes(r.status)) continue;
      if (control && ["thinking", "clarifying", "queued", "interrupted", "failed"].includes(r.status)) {
        const display = inlineDisplayRange(state, control);
        ranges.push(Decoration.replace({ widget: new RequestStateWidget(this, r), block: true, inclusive: true }).range(display.from, display.to));
        continue;
      }
      const targetValid = r.target.to <= document.length && document.slice(r.target.from, r.target.to) === r.versions.find(v => v.id === r.currentVersionId)?.target.text;
      const applied = !control && r.commit && r.commit.result.to <= document.length && document.slice(r.commit.result.from, r.commit.result.to) === r.commit.originalResult.text ? r.commit.result : undefined;
      const from = applied?.from ?? (r.status === "pending" && targetValid ? r.target.from : control?.to ?? Math.min(r.commit?.result.from ?? 0, document.length));
      const to = applied?.to ?? (r.status === "pending" && targetValid ? r.target.to : from);
      const widget = new ProposalWidget(this, r, this.service.comparingOriginal.has(r.id), this.service.storageError);
      const targetDisplay = inlineDisplayRange(state, { from, to }), controlDisplay = control ? inlineDisplayRange(state, control) : undefined;
      const joined = controlDisplay ? joinedDisplayRange(state, targetDisplay, controlDisplay) : null;
      const display = joined ?? targetDisplay;
      if (controlDisplay && !joined) ranges.push(Decoration.replace({ block: true, inclusive: true }).range(controlDisplay.from, controlDisplay.to));
      ranges.push(display.from === display.to ? Decoration.widget({ widget, block: true, side: 1 }).range(display.from) : Decoration.replace({ widget, block: true, inclusive: true }).range(display.from, display.to));
    }
    for (const match of markers) {
      const request = known.get(match[1]), duplicate = (counts.get(match[1]) ?? 0) > 1;
      if (!request || duplicate || request.status === "missing" || !locateInstruction(document, request)) {
        const message = !request ? "任务记录未同步" : duplicate ? "正文编号重复，位置已失效" : request.error ?? "正文位置已失效";
        ranges.push(Decoration.replace({ widget: new MissingRecordWidget(message, request ? this : undefined, request?.taskId), inclusive: false }).range(match.index, match.index + match[0].length));
      }
    }
    return Decoration.set(ranges, true);
  }
  refresh(): void {
    if (this.disposed || this.redrawQueued) return;
    this.redrawQueued = true;
    queueMicrotask(() => {
      this.redrawQueued = false;
      for (const view of this.editors) {
        if (!view.dom.isConnected) continue;
        view.dispatch({ effects: redraw.of(null) });
      }
    });
  }
  private sourceEditors(notePath: string): { leaf: WorkspaceLeaf; markdown: MarkdownView; cm: EditorView }[] {
    return this.plugin.app.workspace.getLeavesOfType("markdown").flatMap(leaf => {
      const markdown = leaf.view;
      if (!(markdown instanceof MarkdownView) || markdown.file?.path !== notePath || markdown.getMode() !== "source") return [];
      const cm = (markdown.editor as typeof markdown.editor & { cm?: EditorView }).cm;
      return cm ? [{ leaf, markdown, cm }] : [];
    });
  }
  private assertConsistentEditors(notePath: string, cm: EditorView, unchangedSiblings?: ReadonlyMap<EditorView, string>): void {
    const current = cm.state.doc.toString();
    for (const sibling of this.sourceEditors(notePath)) {
      const text = sibling.cm.state.doc.toString();
      if (text !== current && text !== unchangedSiblings?.get(sibling.cm)) throw new Error("这篇笔记在不同分栏中的内容不一致，请先核对后重试；两边输入都已保留。");
    }
  }
  private async sourceEditor(notePath: string): Promise<{ leaf: WorkspaceLeaf; markdown: MarkdownView; cm: EditorView }> {
    const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error("来源笔记已删除。");
    const workspace = this.plugin.app.workspace, active = workspace.activeEditor?.editor;
    const leaves = workspace.getLeavesOfType("markdown").filter(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === notePath && leaf.view.getMode() === "source" && leaf.view.getState().source !== true);
    let leaf = leaves.find(leaf => (leaf.view as MarkdownView).editor === active) ?? leaves[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.openFile(file, { state: { mode: "source", source: false } });
    }
    const deadline = Date.now() + 1500;
    for (;;) {
      if (this.disposed || leaf.view instanceof MarkdownView && leaf.view.file?.path !== notePath) throw new Error("来源编辑器已变化。");
      // openFile can resolve before CM is mounted, and Obsidian may replace that CM next frame.
      const selected = this.sourceEditors(notePath).find(source => source.leaf === leaf && source.markdown.getState().source !== true);
      if (selected?.cm.dom.isConnected) {
        if (selected.cm.state.facet(EditorView.editable) === false) throw new Error("请在桌面实时编辑模式打开来源笔记。");
        this.assertConsistentEditors(notePath, selected.cm);
        return selected;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("来源编辑器仍在初始化，请稍后重试；正文未改动。");
      const document = selected?.cm.dom.ownerDocument ?? leaf.view.containerEl.ownerDocument ?? workspace.containerEl.ownerDocument;
      const window = document.defaultView;
      if (!window) throw new Error("来源编辑器窗口已关闭。");
      await new Promise<void>(resolve => {
        let frame = 0, finished = false;
        const complete = () => {
          if (finished) return;
          finished = true; window.clearTimeout(timer); window.cancelAnimationFrame(frame); resolve();
        };
        const timer = window.setTimeout(complete, Math.min(50, remaining));
        frame = window.requestAnimationFrame(complete);
      });
    }
  }
  private async editor(notePath: string): Promise<InlineEditorPort> {
    const { markdown, cm, leaf } = await this.sourceEditor(notePath);
    let unchangedSiblings: Map<EditorView, string> | undefined;
    const assertFile = () => {
      if (leaf.view !== markdown || markdown.file?.path !== notePath || markdown.getMode() !== "source" || markdown.getState().source === true || (markdown.editor as typeof markdown.editor & { cm?: EditorView }).cm !== cm || this.disposed || !cm.dom.isConnected) throw new Error("来源编辑器已变化。");
      this.assertConsistentEditors(notePath, cm, unchangedSiblings);
    };
    return {
      read: () => { assertFile(); return cm.state.doc.toString(); },
      apply: (changes, history, requestId) => {
        assertFile();
        unchangedSiblings = new Map(this.sourceEditors(notePath).map(source => [source.cm, source.cm.state.doc.toString()]));
        cm.dispatch({ changes, annotations: [inlineSystemEdit.of(requestId), ...(history === "system" ? [Transaction.addToHistory.of(false)] : [isolateHistory.of("full")])] });
      },
      save: async () => { assertFile(); await markdown.save(); assertFile(); }
    };
  }
  report(error: unknown): void { new Notice(error instanceof Error ? error.message : "正文块操作失败，当前文字已保留。"); }
}

class ProposalWidget extends WidgetType {
  private component?: Component;
  constructor(private readonly controller: InlineAgentController, private readonly request: InlineRequest, private readonly original: boolean, private readonly storageError?: string) { super(); }
  eq(other: ProposalWidget): boolean {
    const signature = (widget: ProposalWidget) => [widget.request.id, widget.request.status, widget.request.agentName, widget.request.agentId, widget.request.currentVersionId,
      widget.request.versions.find(version => version.id === widget.request.currentVersionId), widget.request.error, widget.request.commit, widget.original, widget.storageError];
    return JSON.stringify(signature(this)) === JSON.stringify(signature(other));
  }
  toDOM(view: EditorView): HTMLElement {
    const r = this.request, service = this.controller.service, document = view.dom.ownerDocument;
    const root = document.createElement("section");
    root.className = "echoink-inline-block"; root.dataset.requestId = r.id; root.setAttribute("aria-label", `${r.agentName}的待确认稿`);
    const header = root.createDiv({ cls: "echoink-inline-header" }), identity = header.createDiv({ cls: "echoink-inline-identity" });
    const agent = this.controller.plugin.settings.agentRegistry.agents.find(item => item.id === r.agentId);
    const avatar = agent && resolveAgentAvatarUrl(agent.avatar);
    if (avatar) identity.createEl("img", { cls: "echoink-inline-avatar", attr: { src: avatar, alt: "" } });
    identity.createSpan({ text: r.agentName });
    const actions = header.createDiv({ cls: "echoink-inline-actions" }), version = r.versions.find(v => v.id === r.currentVersionId);
    const compare = createOriginButton(actions, { text: this.original ? "看新稿" : "对比" });
    applyAmicroButton(compare, { variant: "tertiary" }); compare.onclick = () => service.compare(r.id); compare.disabled = !version;
    const revoke = createOriginButton(actions, { text: "撤销" }); applyAmicroButton(revoke, { variant: "secondary" });
    const confirm = createOriginButton(actions, { text: r.status === "save_failed" ? "重试保存" : r.status === "saving" ? "保存中…" : "确认", cls: "mod-cta" });
    applyAmicroButton(confirm, { variant: "primary" });
    const run = (action: "confirm" | "revoke") => {
      confirm.disabled = true; revoke.disabled = true; root.setAttribute("aria-busy", "true");
      void service[action](r.id, version?.id ?? "").catch(error => this.controller.report(error)).finally(() => { this.controller.refresh(); });
    };
    revoke.onclick = () => run("revoke"); confirm.onclick = () => run(r.status === "save_failed" ? r.commit?.action ?? "confirm" : "confirm");
    confirm.disabled = this.original || (!version && r.commit?.action !== "revoke") || (!!this.storageError && r.status !== "save_failed") || !["pending", "save_failed"].includes(r.status);
    revoke.disabled = r.status === "saving" || r.status === "save_failed";
    const error = this.storageError ?? r.error;
    if (error) root.createDiv({ cls: "echoink-inline-error", text: error, attr: { role: "status" } });
    const body = root.createDiv({ cls: "echoink-inline-body markdown-rendered" });
    this.component = new Component(); this.component.load();
    const text = r.commit && ["saving", "save_failed"].includes(r.status) ? r.commit.originalResult.text : this.original ? version?.target.text ?? "" : version?.text ?? "";
    void MarkdownRenderer.render(this.controller.plugin.app, text, body, r.path, this.component).catch(error => this.controller.report(error));
    return root;
  }
  destroy(dom: HTMLElement): void { this.component?.unload(); disposeOriginControls(dom); }
  ignoreEvent(): boolean { return true; }
}
class MissingRecordWidget extends WidgetType {
  constructor(private readonly message: string, private readonly controller?: InlineAgentController, private readonly taskId?: string) { super(); }
  eq(other: MissingRecordWidget): boolean { return this.message === other.message && this.taskId === other.taskId; }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement(this.taskId ? "button" : "span");
    el.className = "echoink-inline-missing"; el.textContent = this.message;
    if (this.taskId) {
      const taskId = this.taskId;
      (el as HTMLButtonElement).type = "button";
      el.onclick = () => { void this.controller?.openTask(taskId).catch(error => this.controller?.report(error)); };
    } else el.setAttribute("role", "status");
    return el;
  }
}
class RequestStateWidget extends WidgetType {
  constructor(private readonly controller: InlineAgentController, private readonly request: InlineRequest) { super(); }
  eq(other: RequestStateWidget): boolean { return this.request.id === other.request.id && this.request.status === other.request.status && this.request.error === other.request.error && this.request.instruction.text === other.request.instruction.text && this.request.agentName === other.request.agentName; }
  toDOM(view: EditorView): HTMLElement {
    const r = this.request, root = view.dom.ownerDocument.createElement("div"); root.className = "echoink-inline-request-state"; root.dataset.requestId = r.id;
    const labels: Record<string, string> = { thinking: "思考中", clarifying: "等你回答", queued: "等前一块处理", interrupted: "已中断 · 重试", failed: "没写成 · 重试" };
    const state = root.createEl("button", { cls: `echoink-inline-state-label${r.status === "clarifying" ? " is-waiting" : ""}`, text: `${r.agentName} · ${labels[r.status] ?? r.status}`, attr: { type: "button" } });
    state.onclick = () => { void this.controller.openTask(r.taskId).catch(error => this.controller.report(error)); };
    const command = root.createEl("button", { cls: "echoink-inline-sent-instruction", attr: { type: "button" } });
    const agent = this.controller.plugin.settings.agentRegistry.agents.find(item => item.id === r.agentId), avatarUrl = agent && resolveAgentAvatarUrl(agent.avatar);
    const avatar = command.createSpan({ cls: "echoink-inline-sent-avatar", attr: { "aria-hidden": "true" } });
    if (avatarUrl) avatar.createEl("img", { attr: { src: avatarUrl, alt: "" } });
    else Obsidian.setIcon(avatar, "bot");
    const text = command.createSpan({ cls: "echoink-inline-sent-text" }), prefix = `${r.instruction.trigger}${r.agentName}`;
    const instruction = r.instruction.text.replace(r.instruction.marker, "").trimEnd();
    if (instruction.startsWith(prefix)) {
      text.createSpan({ text: r.instruction.trigger }); text.createSpan({ cls: "echoink-inline-sent-name", text: r.agentName });
      text.append(view.dom.ownerDocument.createTextNode(instruction.slice(prefix.length)));
    } else text.textContent = instruction;
    command.onclick = () => { void this.controller.openTask(r.taskId).catch(error => this.controller.report(error)); };
    return root;
  }
  destroy(dom: HTMLElement): void { disposeOriginControls(dom); }
}

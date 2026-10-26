import * as path from "node:path";
import { Annotation, StateEffect, StateField, Transaction, type EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import * as Obsidian from "obsidian";
import { Component, MarkdownRenderer, MarkdownView, Notice, Platform, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { readVaultIdentity } from "../plugin/vault-identity";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import { locateInstruction, locateTarget, markerPattern } from "./document";
import { InlineMentionController } from "./mention";
import { InlineAgentRuntimeController } from "./orchestrator";
import { FileInlineRepository } from "./store";
import { InlineRequestService, type InlineEditorPort } from "./service";
import type { InlineProposalInput, InlineRequest } from "./types";

export const inlineSystemEdit = Annotation.define<string>();
const redraw = StateEffect.define<null>();
const statePath = (state: EditorState): string | undefined => state.field(Obsidian.editorInfoField, false)?.file?.path;

/** The first-round adapter has no model, mention picker, commands, or sidebar UI. */
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
      trigger: () => { this.checkDateConflict(); return this.plugin.settings.inlineAgent.trigger; }, send: input => this.runtime.sendDraft(input) });
    this.mention.register();
    this.plugin.app.workspace.onLayoutReady(() => this.checkDateConflict());
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => this.service.rename(oldPath, file.path)));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", file => this.service.delete(file.path)));
    this.plugin.register(() => { this.disposed = true; this.mention?.dispose(); this.runtime.dispose(); this.listeners.clear(); this.editors.clear(); void this.service.dispose().catch(error => this.report(error)); });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async openTask(taskId: string): Promise<void> {
    await this.plugin.activateView({ focusInput: false });
    const view = this.plugin.getCodexView();
    if (view && await view.waitForTaskUiReady()) await view.openTaskDetail(taskId);
  }
  async openSource(id: string): Promise<void> {
    const r = this.service.get(id); if (!r) throw new Error("来源请求已不存在。");
    const port = await this.editor(r.path), document = port.read();
    const leaf = this.plugin.app.workspace.getLeavesOfType("markdown").find(item => item.view instanceof MarkdownView && item.view.file?.path === r.path && item.view.getMode() === "source");
    if (!leaf || !(leaf.view instanceof MarkdownView)) return;
    await this.plugin.app.workspace.revealLeaf(leaf);
    const target = r.commit?.result ?? (r.targetResolved === false ? r.instruction : r.target);
    const located = locateTarget(document, target, r.observedDocument === document);
    if (!located || r.status === "missing") { new Notice("已打开来源笔记，原位置已变化。"); return; }
    const pos = leaf.view.editor.offsetToPos(located.from);
    leaf.view.editor.setCursor(pos); leaf.view.editor.scrollIntoView({ from: pos, to: pos }, true); leaf.view.editor.focus();
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
    const records = this.service.list(filePath), known = new Set(records.map(r => r.id));
    for (const r of records) {
      if (!["thinking", "clarifying", "queued", "failed", "pending", "conflict", "interrupted", "save_failed", "saving"].includes(r.status)) continue;
      const control = locateInstruction(document, r);
      if (!control && !["saving", "save_failed"].includes(r.status)) continue;
      if (control && ["thinking", "clarifying", "queued", "interrupted", "failed"].includes(r.status)) {
        ranges.push(Decoration.replace({ widget: new RequestStateWidget(this, r), block: true, inclusive: false }).range(control.from, control.to));
        continue;
      }
      if (control) ranges.push(Decoration.replace({ inclusive: false }).range(control.from, control.to));
      const targetValid = r.target.to <= document.length && document.slice(r.target.from, r.target.to) === r.versions.find(v => v.id === r.currentVersionId)?.target.text;
      const applied = !control && r.commit && r.commit.result.to <= document.length && document.slice(r.commit.result.from, r.commit.result.to) === r.commit.originalResult.text ? r.commit.result : undefined;
      const from = applied?.from ?? (r.status === "pending" && targetValid ? r.target.from : control?.to ?? Math.min(r.commit?.result.from ?? 0, document.length));
      const to = applied?.to ?? (r.status === "pending" && targetValid ? r.target.to : from);
      const widget = new ProposalWidget(this, r, this.service.comparingOriginal.has(r.id), this.service.storageError);
      ranges.push(from === to ? Decoration.widget({ widget, block: true, side: 1 }).range(from) : Decoration.replace({ widget, block: true, inclusive: false }).range(from, to));
    }
    for (const match of document.matchAll(markerPattern())) if (!known.has(match[1])) {
      ranges.push(Decoration.widget({ widget: new MissingRecordWidget(), block: true, side: 1 }).range(match.index + match[0].length));
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
  private async editor(notePath: string): Promise<InlineEditorPort> {
    const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error("来源笔记已删除。");
    let view = this.plugin.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).find((item): item is MarkdownView => item instanceof MarkdownView && item.file?.path === notePath && item.getMode() === "source");
    if (!view) {
      const leaf = this.plugin.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { state: { mode: "source", source: false } });
      if (!(leaf.view instanceof MarkdownView)) throw new Error("无法打开来源编辑器。");
      view = leaf.view;
    }
    const markdown = view;
    const cm = (markdown.editor as typeof markdown.editor & { cm?: EditorView }).cm;
    if (!cm || markdown.getMode() !== "source" || markdown.getState().source === true) throw new Error("请在桌面实时编辑模式打开来源笔记。");
    const assertFile = () => { if (markdown.file?.path !== notePath || this.disposed) throw new Error("来源编辑器已变化。"); };
    return {
      read: () => { assertFile(); return cm.state.doc.toString(); },
      apply: (changes, history, requestId) => {
        assertFile();
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
    return JSON.stringify([this.request, this.original, this.storageError]) === JSON.stringify([other.request, other.original, other.storageError]);
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
    const actions = header.createDiv({ cls: "echoink-inline-actions" }), version = r.versions.find(v => v.id === r.currentVersionId)!;
    const compare = createOriginButton(actions, { text: this.original ? "看新稿" : "对比" });
    applyAmicroButton(compare, { variant: "tertiary" }); compare.onclick = () => service.compare(r.id);
    const revoke = createOriginButton(actions, { text: "撤销" }); applyAmicroButton(revoke, { variant: "secondary" });
    const confirm = createOriginButton(actions, { text: r.status === "save_failed" ? "重试保存" : r.status === "saving" ? "保存中…" : "确认", cls: "mod-cta" });
    applyAmicroButton(confirm, { variant: "primary" });
    const run = (action: "confirm" | "revoke") => {
      confirm.disabled = true; revoke.disabled = true; root.setAttribute("aria-busy", "true");
      void service[action](r.id, version.id).catch(error => this.controller.report(error)).finally(() => { this.controller.refresh(); });
    };
    revoke.onclick = () => run("revoke"); confirm.onclick = () => run(r.status === "save_failed" ? r.commit?.action ?? "confirm" : "confirm");
    confirm.disabled = this.original || (!!this.storageError && r.status !== "save_failed") || !["pending", "save_failed"].includes(r.status);
    revoke.disabled = r.status === "saving" || r.status === "save_failed";
    const error = this.storageError ?? r.error;
    if (error) root.createDiv({ cls: "echoink-inline-error", text: error, attr: { role: "status" } });
    const body = root.createDiv({ cls: "echoink-inline-body markdown-rendered" });
    this.component = new Component(); this.component.load();
    const text = r.commit && ["saving", "save_failed"].includes(r.status) ? r.commit.originalResult.text : this.original ? version.target.text : version.text;
    void MarkdownRenderer.render(this.controller.plugin.app, text, body, r.path, this.component).catch(error => this.controller.report(error));
    return root;
  }
  destroy(dom: HTMLElement): void { this.component?.unload(); disposeOriginControls(dom); }
  ignoreEvent(): boolean { return true; }
}
class MissingRecordWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(view: EditorView): HTMLElement { const el = view.dom.ownerDocument.createElement("div"); el.className = "echoink-inline-missing"; el.textContent = "任务记录未同步"; return el; }
}
class RequestStateWidget extends WidgetType {
  constructor(private readonly controller: InlineAgentController, private readonly request: InlineRequest) { super(); }
  eq(other: RequestStateWidget): boolean { return this.request.id === other.request.id && this.request.status === other.request.status && this.request.error === other.request.error; }
  toDOM(view: EditorView): HTMLElement {
    const r = this.request, root = view.dom.ownerDocument.createElement("div"); root.className = "echoink-inline-request-state"; root.dataset.requestId = r.id;
    const labels: Record<string, string> = { thinking: "思考中", clarifying: "等你回答", queued: "等前一块处理", interrupted: "已中断 · 重试", failed: "没写成 · 重试" };
    const state = root.createEl("button", { cls: `echoink-inline-state-label${r.status === "clarifying" ? " is-waiting" : ""}`, text: `${r.agentName} · ${labels[r.status] ?? r.status}`, attr: { type: "button" } });
    state.onclick = () => { void this.controller.openTask(r.taskId).catch(error => this.controller.report(error)); };
    if (r.status !== "queued") root.createDiv({ cls: "echoink-inline-sent-instruction", text: r.instruction.text.slice(0, -r.instruction.marker.length).trimEnd() });
    return root;
  }
  destroy(dom: HTMLElement): void { disposeOriginControls(dom); }
}

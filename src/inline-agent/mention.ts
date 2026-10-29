import { ownedDiv, ownedSpan, ownedEl } from "../ui/owned-dom";
import { isImeKeyEvent } from "../ui/ime-composition";
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, Notice, Platform, setIcon, type App, type Plugin } from "obsidian";
import type { AgentDefinition } from "../agents/types";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";

export interface InlineDraftSubmission {
  path: string;
  agentId: string;
  from: number;
  to: number;
  document: string;
  text: string;
  trigger: string;
}

export interface InlineMentionHost {
  plugin: Plugin & { app: App };
  agents(): readonly AgentDefinition[];
  trigger(): string;
  enabled?(): boolean;
  send(input: InlineDraftSubmission): Promise<void>;
}

export interface InlineMentionMatch { from: number; to: number; query: string }
export interface InlineMentionDraft {
  id: number;
  from: number;
  to: number;
  agentId: string;
  agentName: string;
  trigger: string;
  pending: boolean;
}
interface Candidate extends InlineMentionMatch { agents: readonly AgentDefinition[]; index: number }
interface MentionState { drafts: readonly InlineMentionDraft[]; candidate: Candidate | null; composing: boolean; document: string; path: string | undefined }
type MentionAction = { kind: "select"; draft: InlineMentionDraft } | { kind: "close" } | { kind: "move"; delta: number }
  | { kind: "composition"; active: boolean } | { kind: "pending"; id: number; pending: boolean } | { kind: "remove"; id: number };
const action = StateEffect.define<MentionAction>();

const escaped = (text: string, at: number): boolean => {
  let count = 0;
  while (at > 0 && text[--at] === "\\") count++;
  return count % 2 === 1;
};

/** Conservative unfinished-Markdown checks also work before Obsidian's parser catches up. */
export function inlineMentionAllowed(document: string, at: number): boolean {
  if (at < 0 || at > document.length || escaped(document, at)) return false;
  const before = document.slice(0, at), lines = before.split("\n");
  let fence: { char: string; size: number } | null = null;
  let frontmatter = lines[0]?.replace(/^\uFEFF/u, "") === "---";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) {
      if (i && /^(?:---|\.\.\.)\s*$/u.test(line)) frontmatter = false;
      continue;
    }
    const match = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!match) continue;
    if (!fence) fence = { char: match[1][0], size: match[1].length };
    else if (match[1][0] === fence.char && match[1].length >= fence.size && !match[2].trim()) fence = null;
  }
  if (frontmatter || fence) return false;
  const line = lines[lines.length - 1];
  if (/^(?: {4}|\t)/u.test(line)) return false;
  // Bare URLs, autolinks and email local-parts must never turn into an invocation.
  const token = line.split(/\s/u).pop() ?? "";
  if (/(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.)/iu.test(token) || /[\w.+/:%@-]$/u.test(line)) return false;
  let ticks = 0, brackets = 0, destination = 0, angle = false;
  for (let i = 0; i < before.length; i++) {
    if (escaped(before, i)) continue;
    const char = before[i];
    if (char === "`") {
      let end = i + 1;
      while (before[end] === "`") end++;
      const size = end - i;
      if (!ticks) ticks = size;
      else if (ticks === size) ticks = 0;
      i = end - 1;
      continue;
    }
    if (ticks) continue;
    if (char === "\n") { brackets = 0; destination = 0; angle = false; }
    else if (char === "<") angle = true;
    else if (char === ">") angle = false;
    else if (char === "[") brackets++;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "(" && (destination || before[i - 1] === "]")) destination++;
    else if (char === ")" && destination) destination--;
  }
  return !ticks && !brackets && !destination && !angle;
}

export function findInlineMention(document: string, cursor: number, trigger: string): InlineMentionMatch | null {
  if (!trigger || /\s/u.test(trigger) || cursor < 0 || cursor > document.length) return null;
  const from = document.lastIndexOf(trigger, cursor - trigger.length);
  if (from < 0 || from + trigger.length > cursor || document.slice(from, cursor).includes("\n")) return null;
  if (!inlineMentionAllowed(document, from)) return null;
  return { from, to: cursor, query: document.slice(from + trigger.length, cursor) };
}

export function inlineDraftText(document: string, draft: InlineMentionDraft): string | null {
  const prefix = `${draft.trigger}${draft.agentName}`;
  if (draft.from < 0 || draft.to > document.length || draft.to < draft.from + prefix.length) return null;
  if (document.slice(draft.from, draft.from + prefix.length) !== prefix) return null;
  const body = document.slice(draft.from + prefix.length, draft.to);
  return body && !/^\s/u.test(body) ? null : body.replace(/^[ \t]/u, "");
}

/** End association grows only for native typing/paste/newline at this draft's own end. */
export function mapInlineDraft(draft: InlineMentionDraft, tr: Transaction): InlineMentionDraft | null {
  if (!tr.docChanged) return draft;
  const selection = tr.startState.selection.main;
  const grows = selection.empty && selection.head === draft.to && tr.isUserEvent("input");
  const mapped = { ...draft, from: tr.changes.mapPos(draft.from, 1), to: tr.changes.mapPos(draft.to, grows ? 1 : -1) };
  return inlineDraftText(tr.newDoc.toString(), mapped) === null ? null : mapped;
}

export function inlineMentionKeyAction(event: Pick<KeyboardEvent, "key" | "isComposing" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, composing: boolean): "previous" | "next" | "select" | "close" | null {
  if (composing || isImeKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  return event.key === "ArrowUp" ? "previous" : event.key === "ArrowDown" ? "next" : event.key === "Enter" ? "select" : event.key === "Escape" ? "close" : null;
}

function excludedSyntax(state: EditorState, position: number): boolean {
  for (let node = syntaxTree(state).resolveInner(position, 1); node; node = node.parent!) {
    if (/code|link|url|frontmatter|hashtag/iu.test(node.name)) return true;
  }
  return false;
}

export class InlineMentionController {
  private readonly views = new Set<EditorView>();
  private readonly field: StateField<MentionState>;
  private registered = false;
  private disposed = false;
  private sequence = 0;

  constructor(private readonly host: InlineMentionHost) {
    this.field = StateField.define<MentionState>({
      create: state => ({ drafts: [], candidate: null, composing: false, document: state.doc.toString(), path: state.field(editorInfoField, false)?.file?.path }),
      update: (previous, tr) => {
        const path = tr.state.field(editorInfoField, false)?.file?.path;
        if (this.disposed || !this.enabled(tr.state) || path !== previous.path) return { drafts: [], candidate: null, composing: false, document: tr.newDoc.toString(), path };
        let drafts = previous.drafts.map(draft => mapInlineDraft(draft, tr)).filter((draft): draft is InlineMentionDraft => draft !== null);
        let candidate = previous.candidate, composing = previous.composing;
        if (tr.docChanged || tr.selection) {
          const selection = tr.state.selection.main;
          const typing = tr.docChanged && tr.isUserEvent("input");
          const match = selection.empty && (candidate || typing) ? findInlineMention(tr.newDoc.toString(), selection.head, this.host.trigger()) : null;
          const agents = match ? this.host.agents().filter(agent => agent.name.toLocaleLowerCase().startsWith(match.query.toLocaleLowerCase())) : [];
          const occupied = match && drafts.some(draft => match.from >= draft.from && match.from < draft.to);
          candidate = match && agents.length && !occupied && !excludedSyntax(tr.state, match.from)
            ? { ...match, agents, index: candidate?.from === match.from ? Math.min(candidate.index, agents.length - 1) : 0 } : null;
        }
        for (const effect of tr.effects) {
          if (!effect.is(action)) continue;
          const value = effect.value;
          if (value.kind === "select") { drafts = [...drafts, value.draft]; candidate = null; }
          if (value.kind === "close") candidate = null;
          if (value.kind === "move" && candidate) candidate = { ...candidate, index: (candidate.index + value.delta + candidate.agents.length) % candidate.agents.length };
          if (value.kind === "composition") { composing = value.active; if (composing) candidate = null; }
          if (value.kind === "pending") drafts = drafts.map(draft => draft.id === value.id ? { ...draft, pending: value.pending } : draft);
          if (value.kind === "remove") drafts = drafts.filter(draft => draft.id !== value.id);
        }
        return { drafts, candidate: composing ? null : candidate, composing, document: tr.newDoc.toString(), path };
      },
      provide: field => [
        EditorView.decorations.from(field, value => this.decorations(value)),
        showTooltip.from(field, value => value.candidate ? this.tooltip(value.candidate) : null)
      ]
    });
  }

  register(): void {
    if (this.registered || this.disposed || Platform.isMobile) return;
    this.registered = true;
    const lifecycle = ViewPlugin.define(view => {
      this.views.add(view);
      return { destroy: () => { this.views.delete(view); } };
    });
    const events = Prec.highest(EditorView.domEventHandlers({
      keydown: (event, view) => {
        const state = view.state.field(this.field);
        if (!state.candidate) return false;
        const key = inlineMentionKeyAction(event, state.composing || view.composing || view.compositionStarted);
        if (!key) return false;
        if (key === "select") this.select(view, state.candidate.agents[state.candidate.index]);
        else view.dispatch({ effects: action.of(key === "close" ? { kind: "close" } : { kind: "move", delta: key === "next" ? 1 : -1 }) });
        return true;
      },
      compositionstart: (_event, view) => { view.dispatch({ effects: action.of({ kind: "composition", active: true }) }); return false; },
      compositionend: (_event, view) => { view.dispatch({ effects: action.of({ kind: "composition", active: false }) }); return false; },
      blur: (_event, view) => { if (view.state.field(this.field).candidate) view.dispatch({ effects: action.of({ kind: "close" }) }); return false; }
    }));
    this.host.plugin.registerEditorExtension([this.field, lifecycle, events] as Extension);
    this.host.plugin.register(() => this.dispose());
  }

  refreshAccess(): void {
    if (!this.disposed) for (const view of this.views) view.dispatch({ effects: action.of({ kind: "close" }) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const view of this.views) view.dispatch({ effects: action.of({ kind: "close" }) });
    this.views.clear();
  }

  private enabled(state: EditorState): boolean {
    return this.host.enabled?.() !== false && state.field(editorLivePreviewField, false) === true && !!state.field(editorInfoField, false)?.file?.path && state.facet(EditorView.editable);
  }

  private select(view: EditorView, agent: AgentDefinition): void {
    const state = view.state.field(this.field), match = state.candidate;
    if (!this.enabled(view.state) || !match || state.composing || view.composing || view.compositionStarted || this.disposed) return;
    const trigger = this.host.trigger(), insert = `${trigger}${agent.name} `;
    const draft: InlineMentionDraft = { id: ++this.sequence, from: match.from, to: match.from + insert.length, agentId: agent.id, agentName: agent.name, trigger, pending: false };
    view.dispatch({ changes: { from: match.from, to: match.to, insert }, selection: { anchor: draft.to }, effects: action.of({ kind: "select", draft }), userEvent: "input.complete" });
    view.focus();
  }

  private async send(view: EditorView, id: number): Promise<void> {
    const state = view.state.field(this.field), draft = state.drafts.find(item => item.id === id);
    if (!draft || draft.pending || state.composing || view.composing || view.compositionStarted || this.disposed || !this.enabled(view.state)) return;
    const document = view.state.doc.toString(), text = inlineDraftText(document, draft), path = view.state.field(editorInfoField).file?.path;
    if (text === null || !text.trim() || !path) return;
    view.dispatch({ effects: action.of({ kind: "pending", id, pending: true }) });
    try {
      await this.host.send({ path, agentId: draft.agentId, from: draft.from, to: draft.to, document, text, trigger: draft.trigger });
      if (!this.disposed && this.views.has(view)) view.dispatch({ effects: action.of({ kind: "remove", id }) });
    } catch (error) {
      if (!this.disposed && this.views.has(view)) {
        view.dispatch({ effects: action.of({ kind: "pending", id, pending: false }) });
        new Notice(error instanceof Error ? error.message : "发送失败，请重试。");
      }
    }
  }

  private decorations(value: MentionState): DecorationSet {
    const ranges: ReturnType<Decoration["range"]>[] = [];
    for (const draft of value.drafts) {
      const agent = this.host.agents().find(item => item.id === draft.agentId);
      ranges.push(Decoration.mark({ class: "echoink-inline-input" }).range(draft.from, draft.to));
      ranges.push(Decoration.mark({ class: "echoink-inline-input-name" }).range(draft.from + draft.trigger.length, draft.from + draft.trigger.length + draft.agentName.length));
      const lastLineStart = Math.max(draft.from + draft.trigger.length + draft.agentName.length, value.document.lastIndexOf("\n", draft.to - 1) + 1);
      const tail = /\S(?=[ \t]*$)/u.exec(value.document.slice(lastLineStart, draft.to));
      if (tail) ranges.push(Decoration.mark({ class: "echoink-inline-input-tail" }).range(lastLineStart + tail.index, draft.to));
      ranges.push(Decoration.widget({ widget: new MentionAvatar(agent), side: -1 }).range(draft.from));
      ranges.push(Decoration.widget({ widget: new MentionSend(draft.id, draft.pending || value.composing, !inlineDraftText(value.document, draft)?.trim(), (view, id) => { void this.send(view, id); }), side: 1 }).range(draft.to));
    }
    return Decoration.set(ranges, true);
  }

  private tooltip(candidate: Candidate): Tooltip {
    return { pos: candidate.from, end: candidate.to, above: false, create: view => {
      const document = view.dom.ownerDocument, dom = ownedDiv(document);
      dom.className = "echoink-inline-mention-list";
      dom.setAttribute("role", "listbox"); dom.setAttribute("aria-label", "选择管家");
      const render = () => {
        const active = view.state.field(this.field).candidate;
        dom.replaceChildren();
        if (!active) return;
        active.agents.forEach((agent, index) => {
          const row = ownedDiv(document);
          row.className = "echoink-inline-mention-option";
          row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === active.index));
          row.append(avatarElement(document, agent));
          const name = ownedSpan(document); name.textContent = agent.name; row.append(name);
          row.addEventListener("mousedown", event => event.preventDefault());
          row.addEventListener("click", event => { event.preventDefault(); this.select(view, agent); });
          dom.append(row);
        });
        dom.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
      };
      render();
      return { dom, update: render };
    } };
  }
}

function avatarElement(document: Document, agent: AgentDefinition | undefined): HTMLElement {
  const avatar = ownedSpan(document);
  avatar.className = "echoink-inline-input-avatar"; avatar.setAttribute("aria-hidden", "true");
  const url = agent && resolveAgentAvatarUrl(agent.avatar);
  if (url) { const image = ownedEl(document, "img"); image.src = url; image.alt = ""; avatar.append(image); }
  else { const fallback = ownedSpan(document); fallback.textContent = agent?.name.slice(0, 1) ?? ""; avatar.append(fallback); }
  return avatar;
}

class MentionAvatar extends WidgetType {
  private readonly url: string | null;
  constructor(private readonly agent: AgentDefinition | undefined) { super(); this.url = agent ? resolveAgentAvatarUrl(agent.avatar) : null; }
  eq(other: MentionAvatar): boolean { return this.agent?.id === other.agent?.id && this.agent?.name === other.agent?.name && this.url === other.url; }
  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument, wrapper = ownedSpan(document);
    wrapper.className = "echoink-inline-input-start";
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.append(avatarElement(document, this.agent));
    return wrapper;
  }
  ignoreEvent(): boolean { return true; }
}

class MentionSend extends WidgetType {
  constructor(private readonly id: number, private readonly pending: boolean, private readonly empty: boolean, private readonly send: (view: EditorView, id: number) => void) { super(); }
  eq(other: MentionSend): boolean { return this.id === other.id && this.pending === other.pending && this.empty === other.empty; }
  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument, wrapper = ownedSpan(document), button = ownedEl(document, "button");
    wrapper.className = "echoink-inline-input-end";
    // Pair with the tail mark's generated joiner on the other side of CM's widget buffer.
    wrapper.append(document.createTextNode("\u2060"));
    button.type = "button"; button.className = "echoink-inline-input-send"; button.disabled = this.pending || this.empty;
    button.setAttribute("aria-label", this.pending ? "正在发送" : "发送给管家");
    button.setAttribute("aria-busy", String(this.pending));
    setIcon(button, "arrow-up");
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.send(view, this.id); });
    wrapper.append(button);
    return wrapper;
  }
  ignoreEvent(): boolean { return true; }
}

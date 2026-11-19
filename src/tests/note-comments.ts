import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installObsidianDom } from "./obsidian-dom";
import { prepareDocument } from "./settings-search-dom";
import { DEFAULT_SETTINGS, normalizeSettingsData, getNoteCommentApiProviderModel } from "../settings/settings";
import { normalizeNoteCommentSettings, DEFAULT_NOTE_COMMENT_EXPLAIN_PROMPT } from "../note-comments/settings";
import { NoteCommentService, validateNoteCommentFile, type NoteCommentRepository } from "../note-comments/store";
import { layoutRail, connectorPath } from "../note-comments/layout";
import { NoteCommentAiRunner, buildNoteCommentPrompt, parseRelated, sectionContext, translationTarget, type NoteCommentAiPort, type NoteCommentRelatedCandidate } from "../note-comments/ai";
import { createSelectionAskPopover } from "../ui/selection-ask-popover";
import type { NoteCommentThread } from "../note-comments/types";
import { noteCommentAgentCandidates, resolveNoteCommentAgent } from "../note-comments/agent";
import type { AgentDefinition } from "../agents/types";
import type { SelectionAnchor } from "../types/selection-annotations";

class MemoryRepository implements NoteCommentRepository {
  saved: NoteCommentThread[][] = [];
  constructor(private initial: NoteCommentThread[] = []) {}
  async load() { return structuredClone(this.initial); }
  async save(threads: readonly NoteCommentThread[]) { this.saved.push(structuredClone([...threads])); }
}
const anchor = (text: string, from = 0): SelectionAnchor => ({ mode: "editor", from, to: from + text.length, before: "", after: "", source: { from, to: from + text.length, text, before: "", after: "" } });
const ids = () => { let next = 0; return () => `id-${++next}`; };

function settingsNormalization(): void {
  const defaults = normalizeNoteCommentSettings(undefined);
  assert.deepEqual(defaults, { enabled: true, agentId: "", providerSettingsId: "", modelId: "", translateTo: "auto", explainPrompt: DEFAULT_NOTE_COMMENT_EXPLAIN_PROMPT, toolbar: { explain: true, translate: true, related: true } });
  const odd = normalizeNoteCommentSettings({ enabled: false, providerSettingsId: "p", modelId: "", translateTo: "fr", explainPrompt: "  ", toolbar: { related: false } });
  assert.equal(odd.enabled, false); assert.equal(odd.providerSettingsId, "", "a half model pair falls back to the default model");
  assert.equal(odd.translateTo, "auto"); assert.equal(odd.explainPrompt, DEFAULT_NOTE_COMMENT_EXPLAIN_PROMPT); assert.deepEqual(odd.toolbar, { explain: true, translate: true, related: false });
  assert.deepEqual(DEFAULT_SETTINGS.noteComments, defaults, "plugin defaults carry note comment settings");
  const loaded = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), noteComments: { enabled: false } }).settings;
  assert.equal(loaded.noteComments.enabled, false, "stored settings survive normalization");
  assert.throws(() => getNoteCommentApiProviderModel({ ...DEFAULT_SETTINGS, noteComments: { ...defaults, providerSettingsId: "missing", modelId: "x" } }), /已删除/u);
}

function fileValidation(): void {
  const thread: NoteCommentThread = { id: "t1", path: "Notes/a.md", anchor: anchor("abc"), quote: "abc", createdAt: 1, updatedAt: 1, entries: [{ id: "e1", at: 1, author: "me", text: "hi" }] };
  assert.equal(validateNoteCommentFile({ schemaVersion: 1, vaultId: "v", threads: [thread] }, "v").threads.length, 1);
  assert.throws(() => validateNoteCommentFile({ schemaVersion: 1, vaultId: "other", threads: [] }, "v"), /不属于当前仓库/u, "a file from another vault is never written over");
  assert.throws(() => validateNoteCommentFile({ schemaVersion: 1, vaultId: "v", threads: [{ ...thread, path: "../escape.md" }] }, "v"));
  assert.throws(() => validateNoteCommentFile({ schemaVersion: 1, vaultId: "v", threads: [thread, thread] }, "v"), undefined, "duplicate thread ids are rejected");
  assert.throws(() => validateNoteCommentFile({ schemaVersion: 1, vaultId: "v", threads: [{ ...thread, entries: [{ id: "e", at: 1, author: "robot", text: "" }] }] }, "v"));
}

async function serviceLifecycle(): Promise<void> {
  const interrupted: NoteCommentThread = { id: "old", path: "A/x.md", anchor: anchor("x"), quote: "x", createdAt: 1, updatedAt: 1, entries: [{ id: "r", at: 1, author: "ai", action: "explain", text: "", status: "running" }] };
  const repository = new MemoryRepository([interrupted]);
  let clock = 10;
  const service = new NoteCommentService(repository, () => ++clock, ids());
  await service.initialize();
  assert.equal(service.get("old")!.entries[0].status, "failed", "a request cut off by a restart becomes retryable");
  let events = 0; service.subscribe(() => events++);
  const thread = await service.create({ path: "A/note.md", anchor: anchor("hello"), quote: "hello", entry: { author: "me", text: "first" } });
  assert.equal(thread.entries[0].text, "first"); assert.ok(events > 0);
  await service.addEntry(thread.id, { author: "me", text: "second" });
  await service.resolve(thread.id);
  assert.equal(service.threads("A/note.md").length, 0, "resolved threads are hidden"); assert.equal(service.threads("A/note.md", true).length, 1);
  await service.reopen(thread.id); assert.equal(service.threads("A/note.md").length, 1);
  await service.rename("A", "B");
  assert.deepEqual(service.threads(undefined, true).map(item => item.path).sort(), ["B/note.md", "B/x.md"], "renaming a folder moves its notes' comments");
  const removed = await service.remove(thread.id); assert.ok(removed); assert.equal(service.get(thread.id), undefined);
  await service.restore(removed!); assert.ok(service.get(thread.id), "delete can be undone");
  await assert.rejects(() => service.create({ path: "A/file.pdf", anchor: anchor("x"), quote: "x" }), /Markdown/u);
  service.anchorChanged(); await service.flush();
  assert.ok(repository.saved.length >= 6, "every change is persisted");
  assert.deepEqual(repository.saved.at(-1)!.map(item => item.id).sort(), ["id-1", "old"].sort());
}

function agentChoice(): void {
  const agent = (id: string, extra: Partial<AgentDefinition> = {}) => ({ id, name: id, ...extra }) as AgentDefinition;
  const agents = [agent("sol"), agent("generalist"), agent("researcher"), agent("expert-a", { kind: "expert", expert: { hired: false } as never }), agent("expert-b", { kind: "expert", expert: { hired: true } as never })];
  assert.deepEqual(noteCommentAgentCandidates(agents).map(item => item.id), ["generalist", "researcher", "expert-b"], "the general assistant and unhired experts never answer comments");
  assert.equal(resolveNoteCommentAgent(agents, "")?.id, "generalist", "the default worker answers by default");
  assert.equal(resolveNoteCommentAgent(agents, "sol")?.id, "generalist", "a stored general assistant falls back to the worker");
  assert.equal(resolveNoteCommentAgent(agents, "gone")?.id, "generalist");
  assert.equal(resolveNoteCommentAgent(agents, "researcher")?.id, "researcher");
}

function railLayout(): void {
  const items = [{ id: "a", desired: 100, height: 80 }, { id: "b", desired: 120, height: 60 }, { id: "c", desired: 400, height: 50 }, { id: "gone", desired: null, height: 40 }];
  const placed = layoutRail(items, { gap: 10, documentEnd: 900 });
  const top = (id: string) => placed.find(item => item.id === id)!.top;
  assert.equal(top("a"), 100); assert.equal(top("b"), 190, "cards never overlap"); assert.equal(top("c"), 400);
  assert.equal(top("gone"), 860, "comments whose text is gone sink below the note's end");
  const active = layoutRail(items, { gap: 10, activeId: "b" });
  assert.equal(active.find(item => item.id === "b")!.top, 120, "the selected card sits level with its text");
  assert.equal(active.find(item => item.id === "a")!.top, 30, "cards above make room");
  assert.match(connectorPath({ x: 10, y: 20 }, 300, { x: 340, y: 50 }), /^M10 20 H300 C314 20 326 50 340 50$/u);
}

async function aiBehaviour(): Promise<void> {
  const markdown = "# Plan\n\n## Why now\nPhones start 41% of chats.\n\n## Later\nNot in v1.";
  const at = markdown.indexOf("41%");
  assert.deepEqual(sectionContext(markdown, at, at + 3), { heading: "Why now", text: "## Why now\nPhones start 41% of chats." });
  assert.equal(translationTarget("这句话要翻译", "auto"), "English"); assert.equal(translationTarget("Translate this", "auto"), "Simplified Chinese"); assert.equal(translationTarget("x", "ja"), "Japanese");
  const candidates: NoteCommentRelatedCandidate[] = [{ path: "W/a.md", title: "A", excerpt: "a" }, { path: "W/b.md", title: "B", excerpt: "b" }];
  assert.deepEqual(parseRelated('Sure: [{"index":2,"reason":"同一指标"},{"index":9,"reason":"x"},{"index":2,"reason":"dup"}]', candidates), [{ path: "W/b.md", reason: "同一指标" }]);
  assert.deepEqual(parseRelated("no json", candidates), []);

  const service = new NoteCommentService(new MemoryRepository(), Date.now, ids());
  await service.initialize();
  const thread = await service.create({ path: "Notes/plan.md", anchor: anchor("41%", at), quote: "41%" });
  const prompts: string[] = [];
  let reply = "解释结果", fail = false, pro = true;
  const port: NoteCommentAiPort = {
    async generate(input) { prompts.push(input.systemPrompt + "\n---\n" + input.userPrompt); if (fail) throw new Error("模型超时"); return reply; },
    async searchRelated(query, exclude) { assert.equal(exclude, "Notes/plan.md"); assert.ok(query.length <= 200); return [...candidates, { path: "Notes/plan.md", title: "self", excerpt: "" }]; }
  };
  const runner = new NoteCommentAiRunner({ service, port, assertCanGenerate: () => { if (!pro) throw new Error("PRO"); },
    context: async () => ({ markdown, noteTitle: "plan", agent: { id: "sol", name: "总助", persona: "冷静" }, settings: { explainPrompt: "三句话", translateTo: "auto" } }) });
  await runner.run(thread.id, "explain");
  let entries = service.get(thread.id)!.entries;
  assert.deepEqual(entries.map(entry => [entry.author, entry.action, entry.text, entry.status, entry.agentName]), [["ai", "explain", "解释结果", undefined, "总助"]]);
  assert.match(prompts[0], /总助[\s\S]*三句话[\s\S]*Why now[\s\S]*41%/u, "explain sends persona, instruction, section and passage");
  fail = true; await runner.run(thread.id, "translate");
  entries = service.get(thread.id)!.entries;
  assert.equal(entries.at(-1)!.status, "failed"); assert.equal(entries.at(-1)!.text, "模型超时", "failures stay in the thread with a reason");
  fail = false; reply = "In the past 30 days"; await runner.run(thread.id, "translate", entries.at(-1)!.id);
  entries = service.get(thread.id)!.entries;
  assert.equal(entries.length, 2, "retry reuses the failed entry"); assert.equal(entries.at(-1)!.text, "In the past 30 days"); assert.equal(entries.at(-1)!.status, undefined);
  assert.match(prompts.at(-1)!, /^Translate the commented passage into natural Simplified Chinese/u);
  reply = '[{"index":1,"reason":"同一个计划"}]'; await runner.run(thread.id, "related");
  const related = service.get(thread.id)!.entries.at(-1)!;
  assert.deepEqual(related.related, [{ path: "W/a.md", reason: "同一个计划" }]); assert.match(related.text, /1 篇/u);
  assert.doesNotMatch(prompts.at(-1)!, /self/u, "the commented note is not offered as its own relation");
  reply = "笔记里没有说"; await runner.ask(thread.id, "@总助 这个数据可信吗");
  entries = service.get(thread.id)!.entries;
  assert.deepEqual(entries.slice(-2).map(entry => [entry.author, entry.text]), [["me", "@总助 这个数据可信吗"], ["ai", "笔记里没有说"]]);
  assert.match(prompts.at(-1)!, /Comment thread so far[\s\S]*Latest question: @总助 这个数据可信吗/u);
  pro = false;
  await assert.rejects(() => runner.run(thread.id, "explain"), /PRO/u, "free accounts cannot call the comment AI");
  assert.equal(service.get(thread.id)!.entries.length, entries.length, "a refused request adds nothing");
  const prompt = buildNoteCommentPrompt("explain", { ...thread, anchor: { ...thread.anchor, source: undefined } }, { markdown, noteTitle: "plan", agent: { id: "x", name: "研究员" }, settings: { explainPrompt: "p", translateTo: "auto" } });
  assert.doesNotMatch(prompt.userPrompt, /Surrounding section/u, "without a source span only the passage is sent");
}

function toolbar(doc: Document): void {
  const win = doc.defaultView!, rect = new win.DOMRect(20, 60, 30, 18);
  const chosen: string[] = []; let locked = 0;
  createSelectionAskPopover(doc, rect, [], () => undefined, () => undefined, { buttons: [{ id: "comment", name: "评论", icon: "message-square-plus" }, { id: "explain", name: "解释", icon: "sparkles" }], locked: false, language: "zh-CN", onChoose: id => chosen.push(id) });
  let menu = doc.querySelector<HTMLElement>(".echoink-selection-menu")!;
  assert.deepEqual(Array.from(menu.querySelectorAll("button")).map(button => button.textContent), ["评论", "解释"], "comment buttons show without Ask");
  menu.querySelector<HTMLButtonElement>('[data-toolbar-action="explain"]')!.click();
  assert.deepEqual(chosen, ["explain"]); assert.equal(menu.isConnected, false);
  createSelectionAskPopover(doc, rect, [{ id: "default", name: "提问", template: "" }], () => undefined, () => undefined, { buttons: [{ id: "comment", name: "评论", icon: "message-square-plus" }], locked: true, language: "zh-CN", onChoose: id => chosen.push(id), onLocked: () => locked++ });
  menu = doc.querySelector<HTMLElement>(".echoink-selection-menu")!;
  assert.deepEqual(Array.from(menu.querySelectorAll("button")).map(button => button.textContent), ["提问", "评论"], "Ask stays first");
  const comment = menu.querySelector<HTMLButtonElement>('[data-toolbar-action="comment"]')!;
  assert.equal(comment.getAttribute("aria-disabled"), "true"); assert.ok(menu.querySelector(".echoink-selection-pro-tag"), "locked buttons carry the PRO badge");
  comment.click();
  assert.equal(locked, 1); assert.equal(chosen.length, 1, "a locked button never runs"); assert.equal(menu.isConnected, true, "the toolbar stays open for the upgrade prompt");
  menu.remove();
}

export async function runNoteCommentTests(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
  installObsidianDom(dom.window);
  const win = dom.window as unknown as Window & typeof globalThis;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "document", "HTMLElement", "Element", "Node", "navigator", "getComputedStyle"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value: (win as any)[key] ?? win });
  }
  prepareDocument(win);
  try {
    settingsNormalization();
    fileValidation();
    await serviceLifecycle();
    agentChoice();
    railLayout();
    await aiBehaviour();
    toolbar(win.document);
    console.log("PASS note-comments: settings, file validation, lifecycle and undo, comment assistant choice, rail layout, AI actions and retry, PRO gate, toolbar extras");
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
}

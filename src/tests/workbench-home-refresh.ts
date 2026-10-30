import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { generateConversationTitle } from "../plugin/conversation-title";
import { workbenchResultType } from "../home/workbench-result";
import { WorkbenchStarters } from "../home/workbench-starters";
import type { ChatMessage } from "../settings/settings";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";

export async function runWorkbenchHomeRefreshTests(): Promise<void> {
  const blank = structuredClone(DEFAULT_SETTINGS);
  blank.sessions = [{ id: "empty", title: "空会话", createdAt: 1, updatedAt: 1, cwd: "/fixture", messages: [] }];
  assert.equal(normalizeSettingsData(blank).settings.workbenchOnboardingDismissed, false, "an empty conversation is not onboarding completion");
  blank.sessions[0].messages.push({ id: "user", role: "user", text: "你好", createdAt: 1 });
  assert.equal(normalizeSettingsData(blank).settings.workbenchOnboardingDismissed, true, "legacy user messages migrate to a permanent flag");
  blank.sessions = []; blank.workbenchOnboardingDismissed = true;
  assert.equal(normalizeSettingsData(blank).settings.workbenchOnboardingDismissed, true, "deleting all conversations does not restore onboarding");
  assert.equal(normalizeSettingsData({}).settings.knowledgeBase.initialized, false);
  blank.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  blank.knowledgeBase.folderBindings.roles.raw.readPaths = ["Sources"];
  assert.equal(normalizeSettingsData(blank).settings.knowledgeBase.initialized, false, "first-install scanned directories are not a saved initialization");
  delete blank.knowledgeBase.initialized;
  assert.equal(normalizeSettingsData(blank).settings.knowledgeBase.initialized, true, "bound legacy directories complete initialization");
  blank.knowledgeBase.folderBindings = null; blank.knowledgeBase.initialized = true;
  assert.equal(normalizeSettingsData(blank).settings.knowledgeBase.initialized, true, "a dismissed reminder stays dismissed without directory bindings");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "echoink-home-refresh-"));
  try {
    const catalog = new FileConversationCatalog({ storageRootPath: root, vaultId: "refresh-test" }); await catalog.initialize();
    const create = (id: string, pending = true) => catalog.upsert({ conversationId: id, piSessionId: `pi-${id}`, vaultId: "refresh-test", title: "原始请求", ...(pending ? { titleSource: "pending" as const } : {}), status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 2 });
    await create("once"); let calls = 0;
    const input = { catalog, conversationId: "once", requests: ["你好"], generate: async () => { calls++; return "整理收件箱"; }, changed() {} };
    await generateConversationTitle(input); assert.equal(calls, 0); assert.equal((await catalog.get("once"))?.titleSource, "pending");
    input.requests.push("把收件箱里的笔记整理一下");
    await Promise.all([generateConversationTitle(input), generateConversationTitle(input)]); assert.equal(calls, 1);
    assert.equal((await catalog.get("once"))?.title, "整理收件箱"); assert.equal((await catalog.get("once"))?.updatedAt, 2, "titles are not user conversation activity");
    await generateConversationTitle(input); assert.equal(calls, 1);
    await create("manual"); let release!: (text: string) => void; let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
    const flight = generateConversationTitle({ ...input, conversationId: "manual", generate: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    await waiting; await catalog.rename("manual", "用户自己的名字"); release("不能覆盖"); await flight;
    assert.equal((await catalog.get("manual"))?.title, "用户自己的名字"); assert.equal((await catalog.get("manual"))?.titleSource, "manual");
    await create("failed"); let failedCalls = 0;
    const failed = { ...input, conversationId: "failed", generate: async (): Promise<string> => { failedCalls++; throw Error("offline"); } };
    await generateConversationTitle(failed); await generateConversationTitle(failed); assert.equal(failedCalls, 1); assert.equal((await catalog.get("failed"))?.titleSource, "fallback");
    await create("legacy", false); await generateConversationTitle({ ...input, conversationId: "legacy" }); assert.equal(calls, 1);
    const stale = (await catalog.get("once"))!; await catalog.rename("once", "手动名称"); await catalog.upsert({ ...stale, updatedAt: Date.now() + 10 }); assert.equal((await catalog.get("once"))?.title, "手动名称");

    const message = (overrides: Partial<ChatMessage>): ChatMessage => ({ id: "message", role: "assistant", text: "结果", createdAt: 30, runId: "new", ...overrides });
    const plan = { schemaVersion: 1 as const, planId: "plan", title: "计划", status: "pending" as const, version: 1, source: "agent" as const, steps: [], createdAt: 1, updatedAt: 30, productRunId: "new" };
    const messages = [message({ role: "user", createdAt: 20 }), message({ taskPlan: plan, createdAt: 1 }), message({})];
    assert.equal(workbenchResultType(messages, 20), "plan");
    assert.equal(workbenchResultType([...messages, message({ savedNotePath: "outputs/result.md" })], 20), "note");
    assert.equal(workbenchResultType([...messages, message({ role: "user", runId: "later", createdAt: 40 }), message({ runId: "later", createdAt: 41 })], 40), "answer");

    const parent = document.body.createDiv(); let actions = 0, pro = false;
    const deck = new WorkbenchStarters(parent, { english: () => false, hasPro: () => pro, avatar: () => "sol", act: async () => { actions++; }, upgrade: async () => {}, error: error => { throw error; } });
    assert.equal(parent.querySelectorAll(".wb-starter-card").length, 5);
    assert.match(parent.querySelector(".wb-starter-card.is-current h3")!.textContent!, /知识库/);
    assert.match(parent.querySelector('[data-starter="1"] h3')!.textContent!, /头像/);
    const track = parent.querySelector<HTMLElement>(".wb-deck")!;
    let captures = 0;
    track.setPointerCapture = () => { captures++; };
    const pointer = (type: string, x: number) => Object.assign(new MouseEvent(type, { bubbles: true, button: 0, clientX: x }), { pointerId: 1 });
    const side = parent.querySelector<HTMLElement>('[data-starter="1"]')!;
    side.dispatchEvent(pointer("pointerdown", 10));
    assert.equal(captures, 0, "ordinary side-card clicks must not be retargeted to the deck by pointer capture");
    side.dispatchEvent(pointer("pointerup", 10)); side.querySelector<HTMLElement>("h3")!.click();
    assert.equal(parent.querySelector<HTMLElement>(".is-current[data-starter]")?.dataset.starter, "1");
    assert.equal(actions, 0);
    parent.querySelector<HTMLButtonElement>('[data-starter="2"] button')!.click(); await Promise.resolve();
    assert.equal(parent.querySelector<HTMLElement>(".is-current[data-starter]")?.dataset.starter, "2", "side actions only select their card");
    assert.equal(actions, 0);
    const select = parent.querySelectorAll<HTMLButtonElement>(".wb-deck-dots button"); select[0].click(); await Promise.resolve();
    track.dispatchEvent(pointer("pointerdown", 10)); track.dispatchEvent(pointer("pointermove", 80));
    assert.equal(captures, 1, "capture begins only after an actual drag");
    track.dispatchEvent(pointer("pointerup", 80));
    const afterDrag = parent.querySelector<HTMLButtonElement>('[data-starter="0"] button')!;
    afterDrag.dispatchEvent(pointer("pointerdown", 20)); afterDrag.click(); await Promise.resolve();
    assert.equal(parent.querySelector<HTMLElement>(".is-current[data-starter]")?.dataset.starter, "0", "the next deliberate side-button click survives a preceding drag");
    assert.equal(actions, 0);
    parent.querySelector<HTMLButtonElement>(".wb-deck-arrow")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    assert.equal(parent.querySelector<HTMLElement>(".is-current[data-starter]")?.dataset.starter, "1", "arrow-key navigation also works from the relocated controls");
    select[0].click(); await Promise.resolve();
    const current = parent.querySelector<HTMLElement>(".wb-starter-card.is-current")!; current.click(); assert.equal(actions, 0, "card body never executes");
    current.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); await Promise.resolve(); assert.equal(actions, 1);
    const dots = parent.querySelectorAll<HTMLButtonElement>(".wb-deck-dots button"); dots[5].click(); await Promise.resolve();
    parent.querySelector<HTMLButtonElement>(".wb-starter-card.is-current .wb-starter-actions button")!.click(); await Promise.resolve();
    assert.ok(parent.querySelector(".wb-starter-lock")); assert.equal(actions, 1, "locked card never starts a task");
    assert.equal(parent.querySelector<HTMLButtonElement>(".wb-starter-card.is-current > .wb-starter-actions button")!.disabled, true, "covered action cannot receive keyboard activation");
    parent.querySelector<HTMLElement>(".wb-deck")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(parent.querySelector(".wb-starter-lock"), null);
    assert.equal(parent.ownerDocument.activeElement, parent.querySelector(".wb-starter-card.is-current > .wb-starter-actions button"));
    pro = true; deck.update(); assert.equal(parent.querySelector(".wb-starter-pro"), null);
    const ids = Array.from(parent.querySelectorAll("[id]")).map(node => node.id); assert.equal(new Set(ids).size, ids.length, "nested SVG IDs are unique");
    deck.dispose();
    parent.remove();
    await assertStarterRotation();
    console.log("PASS workbench home: once-only titles, manual rename race, durable fallback, per-turn results, bounded carousel and PRO");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function assertStarterRotation(): Promise<void> {
  const win = document.defaultView!, originalSet = win.setTimeout, originalClear = win.clearTimeout;
  const timers = new Map<number, { action: () => void; at: number }>();
  let now = 0, sequence = 0;
  win.setTimeout = ((action: () => void, delay: number) => { const id = ++sequence; timers.set(id, { action, at: now + delay }); return id; }) as typeof win.setTimeout;
  win.clearTimeout = (id: number) => { timers.delete(id); };
  const advance = (duration: number) => {
    const end = now + duration;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].action();
    }
    now = end;
  };
  const parent = document.body.createDiv();
  let deck: WorkbenchStarters | undefined;
  try {
    deck = new WorkbenchStarters(parent, { english: () => false, hasPro: () => true, avatar: () => "sol", act: async () => {}, upgrade: async () => {}, error: error => { throw error; } });
    const current = () => parent.querySelector<HTMLElement>(".wb-starter-card.is-current")?.dataset.starter;
    advance(4_999); assert.equal(current(), "0"); advance(1); assert.equal(current(), "1");
    advance(30_000); assert.equal(current(), "0", "rotation wraps after the final card");
    deck.element.dispatchEvent(new MouseEvent("mouseenter")); advance(10_000); assert.equal(current(), "0", "hovering the whole carousel pauses rotation");
    parent.querySelector<HTMLButtonElement>(".wb-deck-arrow.is-next")!.click(); await Promise.resolve(); await Promise.resolve();
    assert.equal(current(), "1"); advance(10_000); assert.equal(current(), "1", "manual controls do not resume rotation while hovered");
    deck.element.dispatchEvent(new MouseEvent("mouseleave")); advance(4_000);
    parent.querySelectorAll<HTMLButtonElement>(".wb-deck-dots button")[3].click(); await Promise.resolve(); await Promise.resolve();
    advance(4_999); assert.equal(current(), "3"); advance(1); assert.equal(current(), "4", "manual dot selection starts a full new five-second interval");
    deck.setActive(false); advance(10_000); assert.equal(current(), "4");
    deck.setActive(true); advance(5_000); assert.equal(current(), "5");
    deck.dispose(); deck = undefined;
    assert.equal(timers.size, 0, "disposing the carousel releases its timer");
  } finally { deck?.dispose(); parent.remove(); win.setTimeout = originalSet; win.clearTimeout = originalClear; }
}

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { generateConversationTitle } from "../plugin/conversation-title";
import { workbenchResultType } from "../home/workbench-result";
import { WorkbenchStarters } from "../home/workbench-starters";
import type { ChatMessage } from "../settings/settings";

export async function runWorkbenchHomeRefreshTests(): Promise<void> {
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
    console.log("PASS workbench home: once-only titles, manual rename race, durable fallback, per-turn results, bounded carousel and PRO");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

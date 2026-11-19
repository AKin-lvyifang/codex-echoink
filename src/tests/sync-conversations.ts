import assert from "node:assert/strict";
import { SyncDeviceStore } from "../sync/device-store";
import { SyncConversationWriter, forkPrefillText, friendlyDeviceName, plainPreview, transcriptItems, neutralFromAgentMessages, neutralFromChatMessages, parseSyncForkSource, readSyncConversationMessages, readSyncConversations, syncForkSource, type SyncConversationMessage, type SyncConversationSource } from "../sync/conversations";
import { readSyncCompanyOverview } from "../sync/company-view";
import { SYNC_DEVICES_DIR } from "../sync/types";
import { FakeSyncVault } from "./sync-fake-vault";

const msg = (index: number, role: "user" | "assistant" = index % 2 ? "assistant" : "user", text = `第 ${index} 句`): SyncConversationMessage => ({ id: `m${index}`, role, text, at: 1000 + index });
const conversation = (count: number, extra: Partial<SyncConversationSource> = {}): SyncConversationSource => ({ id: "conv-1", title: "聊同步", agentId: "sol", status: "active", createdAt: 1000, updatedAt: 1000 + count,
  messages: Array.from({ length: count }, (_, i) => msg(i)), ...extra });
const names: Record<string, string> = { "mac-a": "电脑", "phone-b": "iPhone" };

export async function runSyncConversationTests(): Promise<void> {
  let passed = 0;
  const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };
  const device = async (fs: FakeSyncVault, id: string, now: () => number) => { const d = new SyncDeviceStore({ fs, deviceId: id, deviceName: names[id], deviceKind: id.startsWith("mac") ? "desktop" : "phone", now }); await d.open(); return d; };

  {
    const fs = new FakeSyncVault(); let clock = 1_000; const now = () => ++clock;
    const writer = new SyncConversationWriter({ fs, device: await device(fs, "mac-a", now), now });
    await writer.export(conversation(3));
    const part = `${SYNC_DEVICES_DIR}/mac-a/conversations/conv-1/part-0001.jsonl`;
    assert.equal(fs.files.get(part)!.trim().split("\n").length, 3);
    const writesBefore = fs.writes.filter(w => w === part).length;
    await writer.export(conversation(5));
    assert.equal(fs.files.get(part)!.trim().split("\n").length, 5);
    assert.equal(fs.writes.filter(w => w === part).length, writesBefore + 2, "two appends, no rewrite");
    await writer.export(conversation(5));
    assert.equal(fs.writes.filter(w => w === part).length, writesBefore + 2, "nothing new → nothing written");
    const reopened = new SyncConversationWriter({ fs, device: await device(fs, "mac-a", now), now });
    await reopened.export(conversation(6));
    assert.equal(fs.files.get(part)!.trim().split("\n").length, 6, "after restart the export continues from meta.json");
    const read = await readSyncConversationMessages(fs, "mac-a", "conv-1");
    assert.deepEqual(read.map(m => m.id), ["m0", "m1", "m2", "m3", "m4", "m5"]);
    const list = await readSyncConversations(fs, "phone-b", id => names[id] ?? id);
    assert.deepEqual(list.map(c => [c.id, c.deviceName, c.messageCount, c.preview]), [["conv-1", "电脑", 6, "第 5 句"]]);
    assert.deepEqual((await readSyncConversations(fs, "mac-a", id => names[id] ?? id)), [], "a device never lists its own conversations as remote");
    ok("a device appends new messages to its own part file; the other device reads them in order");
  }

  {
    const fs = new FakeSyncVault(); let clock = 1_000; const now = () => ++clock;
    const writer = new SyncConversationWriter({ fs, device: await device(fs, "mac-a", now), now, maxPartBytes: 400 });
    const long = (count: number) => conversation(count, { messages: Array.from({ length: count }, (_, i) => msg(i, i % 2 ? "assistant" : "user", `这是一句比较长的话，用来把分段撑过上限 ${i} `.repeat(2))) });
    await writer.export(long(12));
    const parts = [...fs.files.keys()].filter(key => key.includes("/conv-1/part-")).sort();
    assert.ok(parts.length > 2, `rolled over into ${parts.length} parts`);
    for (const name of parts) assert.ok(new TextEncoder().encode(fs.files.get(name)!).length <= 400, "every part stays under the limit");
    await writer.export(long(13));
    assert.deepEqual((await readSyncConversationMessages(fs, "mac-a", "conv-1")).map(m => m.id), Array.from({ length: 13 }, (_, i) => `m${i}`));
    const meta = fs.json(`${SYNC_DEVICES_DIR}/mac-a/conversations/conv-1/meta.json`) as { payload: { parts: { count: number }[]; messageCount: number } };
    assert.equal(meta.payload.parts.reduce((total, part) => total + part.count, 0), 13); assert.equal(meta.payload.messageCount, 13);
    ok("a long conversation is split into parts under the size limit and read back whole");
  }

  {
    const fs = new FakeSyncVault(); let clock = 1_000; const now = () => ++clock;
    const writer = new SyncConversationWriter({ fs, device: await device(fs, "mac-a", now), now });
    await writer.export(conversation(4));
    // History diverged (the local conversation was edited/branched): rewrite from scratch, no duplicate lines.
    await writer.export(conversation(3, { messages: [msg(0), msg(1), { id: "m2b", role: "user", text: "改了", at: 5 }] }));
    assert.deepEqual((await readSyncConversationMessages(fs, "mac-a", "conv-1")).map(m => m.id), ["m0", "m1", "m2b"]);
    // Half-synced trailing line and a conflict copy are ignored.
    const part = `${SYNC_DEVICES_DIR}/mac-a/conversations/conv-1/part-0001.jsonl`;
    const completePart = fs.files.get(part)!;
    fs.files.set(part, completePart + '{"id":"m3","role":"user","te');
    fs.files.set(`${SYNC_DEVICES_DIR}/mac-a/conversations/conv-1/part-0001 2.jsonl`, JSON.stringify(msg(99)) + "\n");
    assert.deepEqual((await readSyncConversationMessages(fs, "mac-a", "conv-1")).map(m => m.id), ["m0", "m1", "m2b"]);
    ok("diverged history is rewritten once; half lines and conflict copies are skipped");
    await assert.rejects(readSyncConversationMessages(fs, "mac-a", "conv-1", 4), /transcript is incomplete/u);
    fs.files.set(part, completePart + JSON.stringify(msg(3)) + "\n");
    assert.deepEqual((await readSyncConversationMessages(fs, "mac-a", "conv-1", 4)).map(m => m.id), ["m0", "m1", "m2b", "m3"]);
    ok("a strict transcript read can be retried after the remaining messages arrive");
  }

  {
    const fs = new FakeSyncVault(); let clock = 1_000; const now = () => ++clock;
    const a = new SyncConversationWriter({ fs, device: await device(fs, "mac-a", now), now });
    await a.export(conversation(4));
    const before = new Map([...fs.files].filter(([key]) => key.includes("/mac-a/conversations/")));
    // Device B continues A's conversation: a new conversation on B, with forkOf pointing at A's.
    const summary = (await readSyncConversations(fs, "phone-b", id => names[id] ?? id))[0];
    const messages = await readSyncConversationMessages(fs, "mac-a", "conv-1");
    const prefill = forkPrefillText(summary, messages);
    assert.match(prefill, /电脑上的对话《聊同步》/u); assert.match(prefill, /我：第 0 句/u); assert.match(prefill, /助手：第 3 句/u);
    assert.ok(forkPrefillText(summary, Array.from({ length: 400 }, (_, i) => msg(i, "user", "x".repeat(100))), 2000).length < 2600, "the background is bounded");
    const source = syncForkSource("mac-a", "conv-1");
    assert.deepEqual(parseSyncForkSource(source), { deviceId: "mac-a", conversationId: "conv-1" });
    assert.equal(parseSyncForkSource("sync-fork:bad id:x"), null); assert.equal(parseSyncForkSource("other"), null);
    const b = new SyncConversationWriter({ fs, device: await device(fs, "phone-b", now), now });
    await b.export({ id: "conv-b", title: "聊同步（接着）", agentId: "sol", status: "active", createdAt: 2000, updatedAt: 2001, forkOf: { deviceId: "mac-a", conversationId: "conv-1" },
      messages: [{ id: "n0", role: "user", text: prefill, at: 2000 }, { id: "n1", role: "assistant", text: "好的", at: 2001 }] });
    for (const [key, value] of before) assert.equal(fs.files.get(key), value, `the original on A is untouched: ${key}`);
    const fromB = await readSyncConversations(fs, "phone-b", id => names[id] ?? id);
    assert.deepEqual(fromB[0].continuedOn, [{ deviceId: "phone-b", deviceName: "iPhone", conversationId: "conv-b" }], "A's conversation shows where it was continued");
    const fromA = await readSyncConversations(fs, "mac-a", id => names[id] ?? id);
    assert.deepEqual(fromA.map(c => [c.id, c.forkOf]), [["conv-b", { deviceId: "mac-a", conversationId: "conv-1" }]]);
    const overview = await readSyncCompanyOverview(fs, "mac-a", clock);
    assert.equal(overview.conversations.length, 1); assert.equal(overview.conversations[0].deviceName, "iPhone");
    ok("continuing on another device forks a new conversation there; the original never changes");
  }

  {
    const chat = neutralFromChatMessages([
      { id: "u1", role: "user", text: "你好" }, { id: "a1", role: "assistant", text: "  " }, { id: "t1", role: "tool", text: "", title: "读取 笔记.md" }, { id: "a2", role: "assistant", text: "回答" }
    ] as never, 7);
    assert.deepEqual(chat.map(m => [m.id, m.role, m.text, m.at]), [["u1", "user", "你好", 7], ["t1", "tool", "读取 笔记.md", 7], ["a2", "assistant", "回答", 7]]);
    const agent = neutralFromAgentMessages([
      { role: "user", content: "问", timestamp: 1 }, { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "toolCall", name: "note_read", id: "c", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolName: "note_read", toolCallId: "c", content: [{ type: "text", text: "很长的内容" }], timestamp: 3 }, { role: "assistant", content: [{ type: "text", text: "答" }], timestamp: 4 }
    ], 0);
    assert.deepEqual(agent.map(m => [m.role, m.text, m.tools ?? null]), [["user", "问", null], ["assistant", "", ["note_read"]], ["tool", "note_read", ["note_read"]], ["assistant", "答", null]]);
    ok("both runtimes convert to the same neutral shape; tool bodies never leave the device");
    const withProcess = neutralFromChatMessages([
      { id: "u1", role: "user", text: "我最近在忙些啥？" },
      { id: "r1", role: "assistant", itemType: "reasoning", processKind: "reasoning", text: "检索知识库 · 读了 1 篇相关笔记\n读取笔记完成" },
      { id: "k1", role: "assistant", itemType: "thinking", text: "检索知识库 · 查找中…" },
      { id: "t1", role: "tool", text: "", title: "读取笔记" }, { id: "a1", role: "assistant", itemType: "assistant", text: "主要在忙三件事" }
    ] as never, 7);
    assert.deepEqual(withProcess.map(m => m.id), ["u1", "t1", "a1"], "thinking summaries are process cards, not answers");
    ok("process summaries never sync as assistant text");
    assert.equal(plainPreview("做好了。 **预览**：`EchoInk/工作区/guide.html`\n- [链接](https://x.y) 和 [[笔记|别名]]"), "做好了。 预览：EchoInk/工作区/guide.html 链接 和 别名");
    assert.equal(friendlyDeviceName("MacBook-Pro.local"), "MacBook Pro"); assert.equal(friendlyDeviceName("iPhone"), "iPhone"); assert.equal(friendlyDeviceName(".local"), ".local");
    const items = transcriptItems([
      { id: "1", role: "user", text: "问", at: 1 }, { id: "2", role: "assistant", text: "", at: 2, tools: ["note_read"] },
      { id: "3", role: "tool", text: "检索知识库", at: 3 }, { id: "4", role: "tool", text: "读取笔记", at: 4 }, { id: "5", role: "assistant", text: "答", at: 5 }
    ]);
    assert.deepEqual(items.map(i => i.kind === "steps" ? i.names : i.message.id), ["1", ["检索知识库", "读取笔记"], "5"]);
    ok("lists read as plain words; device names read like names; tool rows fold into one step group");
  }
}

import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const built = await esbuild.build(mobileBuildOptions("src/ui/iphone/agent-settings-pages.ts"));
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://iphone-memory.invalid" });
const { document, Event } = dom.window; dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const notices = [], compiled = { exports: {} }, icon = (parent, name) => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("data-icon", name); parent.replaceChildren(svg); };
vm.runInNewContext(built.outputFiles[0].text, {
  module: compiled, exports: compiled.exports, document, window: dom.window, console, structuredClone, AbortController, setTimeout, clearTimeout, atob, btoa, TextEncoder, TextDecoder,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
  require: name => { assert.equal(name, "obsidian"); return { Notice: class { constructor(message) { notices.push(message); } }, setIcon: icon, getIcon: name => { const parent = document.createElement("span"); icon(parent, name); return parent.firstChild; } }; }
});
const { IPhoneAgentSettingsPages } = compiled.exports;
const clone = value => structuredClone(value), tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const agents = [{ id: "sol", name: "总助", avatar: { kind: "preset", presetId: "nova" }, position: "统筹" }, { id: "journal", name: "日记助手", avatar: { kind: "preset", presetId: "nova" }, position: "记录" }];
let registry = { agents, moduleOwners: Object.fromEntries(["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "review"].map(key => [key, "sol"])) }, registryVersion = "registry-v1";
let prefs = { memoryEnabled: false, dreamEnabled: false, dreamRunsPerDay: 1, autoArchive: false, version: "settings-v1" }, settingsRevision = 1;
const slots = [
  ...Array.from({ length: 6 }, (_, i) => ({ section: "identity", profileKey: i ? `identity.${i}` : "identity.name", labelZh: i ? `身份${i}` : "姓名与称呼", importance: 100 - i })),
  ...Array.from({ length: 12 }, (_, i) => ({ section: "preference", profileKey: `preference.${i}`, labelZh: `偏好${i}`, importance: 80 - i })),
  ...Array.from({ length: 6 }, (_, i) => ({ section: "collaboration", profileKey: `collaboration.${i}`, labelZh: `协作${i}`, importance: 50 - i }))
];
let canonicalRevision = 7, profile = { revision: canonicalRevision, slots, items: [{ id: "profile-name", section: "identity", profileKey: "identity.name", text: "叫我小明", basis: "observed_memory", status: "current", sourceMemoryIds: ["memory-a"], revision: 7 }], sources: [{ profileKey: "identity.name", id: "memory-a", title: "称呼", content: "用户说叫我小明", basis: "explicit", available: true }] };
let records = [{ schema: "echoink.memory.v1", id: "memory-a", kind: "fact", status: "current", date: "2026-10-19", source: "会话中的明确表达", basis: "explicit", title: "称呼", recallWhen: "称呼用户时", content: "叫我小明", revision: 7, file: ".echoink/shared-user/memory/facts/memory-a.md" }], forgotten = [], archives = [{ id: "archive-a", agentId: "journal", title: "过去的日记", updatedAt: 1000, archivedAt: 2000, messageCount: 2 }];
const listeners = new Set(), emit = () => { for (const listener of listeners) listener(); };
const calls = { settings: [], owner: [], edit: [], saveProfile: [], confirmProfile: [], deleteProfile: [], preview: [], apply: [], forget: [], restore: [], export: 0, openNote: [], runDream: 0, cancelDream: 0, restoreArchive: [] };
let profileConflict = false, correctionConflict = false, settingsFailure = false, dream = { phase: "idle", attemptsToday: 0, dailyLimit: 1, dayKey: "2026-10-19", startedAt: null, finishedAt: null, error: "" }, dreamResolve;
function checkRevision(revision) { if (revision !== canonicalRevision) throw new Error("内容已变化，请重新读取"); }
const service = {
  readSettings() { return clone(prefs); },
  async saveSettings(draft) { calls.settings.push(clone(draft)); if (settingsFailure) throw new Error("设置保存失败"); if (draft.version !== prefs.version) throw new Error("内容已变化，请重新读取"); prefs = { ...draft, version: `settings-v${++settingsRevision}` }; dream.dailyLimit = prefs.dreamRunsPerDay; emit(); return clone(prefs); },
  async list(query = "") { return { revision: canonicalRevision, records: clone(records.filter(record => `${record.title}${record.content}`.includes(query))), forgotten: clone(forgotten) }; },
  async read(id) { const record = records.find(record => record.id === id); if (!record) throw new Error("记忆不存在"); return { revision: canonicalRevision, record: clone(record) }; },
  async previewCorrection(id, draft, revision) { calls.preview.push({ id, draft: clone(draft), revision }); checkRevision(revision); return { ...draft, id, revision, original: clone(records.find(record => record.id === id)) }; },
  async applyCorrection(preview) { calls.apply.push(clone(preview)); checkRevision(preview.revision); if (correctionConflict) throw new Error("内容已变化，请重新读取"); canonicalRevision++; records[0] = { ...records[0], title: preview.title, content: preview.content, recallWhen: preview.recallWhen, revision: canonicalRevision }; return { revision: canonicalRevision, record: clone(records[0]) }; },
  async forget(id, reason, revision) { calls.forget.push({ id, reason, revision }); checkRevision(revision); canonicalRevision++; const record = records.find(record => record.id === id); forgotten.push({ id, title: record.title, forgottenAt: 3000, reason }); records = records.filter(record => record.id !== id); return this.list(); },
  async restore(id, revision) { calls.restore.push({ id, revision }); checkRevision(revision); canonicalRevision++; const old = forgotten.find(item => item.id === id); records.push({ schema: "echoink.memory.v1", id, kind: "fact", status: "current", date: "2026-10-19", source: "原来的来源", basis: "explicit", title: old.title, content: "恢复的原内容", recallWhen: "称呼时", revision: canonicalRevision, file: "memory/facts/memory-a.md" }); forgotten = forgotten.filter(item => item.id !== id); return { revision: canonicalRevision, record: clone(records[0]) }; },
  async export() { calls.export++; return { path: "Exports/真实记忆导出.md", revision: canonicalRevision }; },
  async readProfile() { return clone({ ...profile, revision: canonicalRevision }); },
  async saveProfile(key, text, revision) { calls.saveProfile.push({ key, text, revision }); checkRevision(revision); if (profileConflict) throw new Error("内容已变化，请重新读取"); canonicalRevision++; const slot = slots.find(slot => slot.profileKey === key); profile.items = profile.items.filter(item => item.profileKey !== key); profile.items.push({ id: `profile-${key}`, section: slot.section, profileKey: key, text, basis: "explicit_memory", status: "current", sourceMemoryIds: ["memory-a"], revision: canonicalRevision }); return this.readProfile(); },
  async confirmProfile(key, revision) { calls.confirmProfile.push({ key, revision }); checkRevision(revision); canonicalRevision++; profile.items = profile.items.map(item => item.profileKey === key ? { ...item, basis: "explicit_memory", revision: canonicalRevision } : item); return this.readProfile(); },
  async deleteProfile(key, revision) { calls.deleteProfile.push({ key, revision }); checkRevision(revision); canonicalRevision++; profile.items = profile.items.filter(item => item.profileKey !== key); return this.readProfile(); },
  dreamStatus() { return clone(dream); },
  async runDream(signal) { calls.runDream++; dream = { ...dream, phase: "running", attemptsToday: dream.attemptsToday + 1, startedAt: 4000 }; emit(); return new Promise(resolve => { dreamResolve = () => { if (!signal.aborted) dream = { ...dream, phase: "completed", finishedAt: 5000 }; emit(); resolve(clone(dream)); }; }); },
  async cancelDream() { calls.cancelDream++; dream = { ...dream, phase: "interrupted", finishedAt: 4500 }; emit(); dreamResolve?.(); },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async listArchives() { return clone(archives); },
  async readArchive(id) { return { ...clone(archives.find(task => task.id === id)), draft: "", notePath: "", tools: {}, messages: [{ role: "user", content: "记下过去的经历" }, { role: "assistant", content: [{ type: "text", text: "已记录的历史回答" }] }] }; },
  async restoreArchive(id) { calls.restoreArchive.push(id); archives = archives.filter(task => task.id !== id); }
};
const pages = [{ id: "base", content: document.createElement("div") }];
const shell = {
  hasPage: id => pages.some(page => page.id === id), get activePageId() { return pages.at(-1).id; },
  async push(page) { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.push(page); document.body.replaceChildren(page.content); return true; },
  async back() { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.pop().dispose?.(); document.body.replaceChildren(pages.at(-1).content); return true; },
  async backTo(id) { while (pages.at(-1).id !== id) if (!await this.back()) return false; return true; }
};
const ctx = { document, shell, host: { services: { memory: service }, settings: () => ({ settingsLanguage: "zh-CN" }), agents: { async snapshot() { return { registry: clone(registry), version: registryVersion }; }, async setOwner(module, agentId, version) { calls.owner.push({ module, agentId, version }); assert.equal(version, registryVersion); registry.moduleOwners[module] = agentId; registryVersion = "registry-v2"; return this.snapshot(); } }, renderMarkdown: (text, parent) => { parent.textContent = text; }, openNote: async path => { calls.openNote.push(path); } }, error: error => { throw error; } };
const ui = new IPhoneAgentSettingsPages(ctx, async id => { calls.edit.push(id); await shell.push({ id: "agent-edit", content: document.createElement("div"), dispose: () => ui.refresh() }); });
const body = () => pages.at(-1).content;
const buttons = text => [...body().querySelectorAll("button")].filter(button => button.textContent.trim() === text);
const click = async (text, index = 0) => { const button = buttons(text)[index]; assert.ok(button, `Button ${text} exists`); assert.equal(button.disabled, false, `Button ${text} is enabled`); button.click(); await tick(); };
const input = (label, value) => { const node = body().querySelector(`[aria-label="${label}"]`); assert.ok(node, `Input ${label} exists`); node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); return node; };
const toggle = async label => { const node = body().querySelector(`input[aria-label="${label}"]`); assert.ok(node, `Switch ${label} exists`); node.checked = !node.checked; node.dispatchEvent(new Event("change", { bubbles: true })); await tick(); };
const slotRow = key => body().querySelector(`[data-profile-key="${key}"]`);
const clickIn = async (parent, text) => { const node = [...parent.querySelectorAll("button")].find(button => button.textContent === text); assert.ok(node, `${text} exists in row`); node.click(); await tick(); };
try {
  await ui.open(); assert.deepEqual([...body().querySelectorAll(":scope > h2")].map(node => node.textContent), ["我的 Agent", "模块负责人", "记忆", "会话"]); assert.match(body().textContent, /你的画像1 项/); assert.match(body().textContent, /已归档会话1/); assert.match(body().textContent, /每天最多 1 次|完成 7 天后/); assert.equal(body().querySelectorAll(".ip-agent-owner-avatar").length, 6);
  await click("总助统筹"); assert.equal(calls.edit[0], "sol"); await shell.back(); await tick();
  await click("新建 Agent"); assert.equal(calls.edit[1], undefined); await shell.back(); await tick();
  const ownerLink = [...body().querySelectorAll("button")].find(button => button.querySelector(".ip-settings-name")?.textContent === "日记" && button.querySelector(".ip-agent-owner-avatar")); ownerLink.click(); await tick(); await click("日记助手"); assert.equal(calls.owner[0].agentId, "journal"); assert.equal(shell.activePageId, "iphone-settings-agent");
  await click("你的画像1 项"); assert.equal(body().querySelectorAll("[data-profile-key]").length, 24); assert.deepEqual([...body().querySelectorAll(":scope > h2")].map(node => node.textContent), ["身份", "偏好", "协作"]); assert.equal(body().querySelectorAll("details.ip-agent-missing").length, 3); assert.match(slotRow("identity.name").textContent, /系统观察 · 仅供参考/);
  await clickIn(slotRow("identity.name"), "确认"); assert.equal(calls.confirmProfile.length, 1); assert.match(slotRow("identity.name").textContent, /你确认的/); assert.equal(prefs.memoryEnabled, false, "Local profile management works with Memory disabled and no Provider");
  await clickIn(slotRow("identity.name"), "编辑"); input("姓名与称呼", "保留的画像草稿"); profileConflict = true; await click("保存"); assert.equal(body().querySelector("textarea").value, "保留的画像草稿"); assert.match(body().textContent, /内容已变化/);
  const pending = shell.back(); await tick(); await click("继续编辑"); assert.equal(await pending, false); assert.equal(body().querySelector("textarea").value, "保留的画像草稿");
  canonicalRevision++; await click("重新读取"); assert.equal(body().querySelector("textarea").value, "保留的画像草稿"); profileConflict = false; await click("保存"); assert.equal(calls.saveProfile.at(-1).revision, canonicalRevision - 1); assert.match(slotRow("identity.name").textContent, /保留的画像草稿/);
  await clickIn(slotRow("identity.name"), "删除"); assert.equal(calls.deleteProfile.length, 0); assert.match(body().textContent, /来源记忆会保留/); await clickIn(slotRow("identity.name").querySelector(".ip-settings-confirm"), "删除"); assert.equal(calls.deleteProfile.length, 1); assert.equal(records.length, 1, "Deleting a profile slot does not forget its Memory");
  const missingGroup = body().querySelector("details.ip-agent-missing"); missingGroup.open = true; missingGroup.dispatchEvent(new Event("toggle")); await clickIn(slotRow("identity.name"), "补写"); input("姓名与称呼", "新称呼"); await click("取消"); assert.equal(calls.saveProfile.length, 2, "Canceling a slot edit does not write");
  await shell.back(); await tick(); await click("记忆修正"); await click("导出记忆"); assert.equal(calls.export, 1); await click("打开导出文件Exports/真实记忆导出.md"); assert.deepEqual(calls.openNote, ["Exports/真实记忆导出.md"]);
  await click("称呼事实 · 你确认的 · 2026-10-19"); await click("修正"); input("记忆内容", "修正后的真实文字"); await click("预览修正"); assert.equal(calls.apply.length, 0); assert.match(body().textContent, /当前内容/); assert.match(body().textContent, /修改后/); assert.match(body().textContent, /修正后的真实文字/);
  await click("返回修改"); assert.equal(body().querySelector("textarea").value, "修正后的真实文字"); await click("预览修正"); correctionConflict = true; await click("确认修正"); assert.match(body().textContent, /内容已变化/); assert.match(body().textContent, /修正后的真实文字/);
  await click("返回修改"); canonicalRevision++; await click("重新读取"); assert.equal(body().querySelector("textarea").value, "修正后的真实文字"); await click("预览修正"); correctionConflict = false; await click("确认修正"); assert.match(body().textContent, /修正后的真实文字/); assert.equal(body().querySelector("textarea"), null);
  await click("忘记"); assert.equal(calls.forget.length, 0); await clickIn(body().querySelector(".ip-settings-confirm"), "忘记"); assert.equal(calls.forget.length, 1); assert.equal(shell.activePageId, "iphone-settings-memories"); await tick(); assert.match(body().textContent, /还没有记忆/);
  body().querySelector("details.ip-agent-forgotten").open = true; await click("恢复"); assert.equal(calls.restore.length, 0); await clickIn(body().querySelector(".ip-settings-confirm"), "恢复"); assert.equal(calls.restore.length, 1); assert.equal(records[0].source, "原来的来源");
  await shell.back(); await tick(); await click("已归档会话1"); body().querySelector("button.ip-settings-row").click(); await tick();
  assert.match(body().textContent, /已记录的历史回答/); assert.equal(body().querySelector("textarea,input"), null, "Archived history has no composer"); await click("恢复会话"); await clickIn(body().querySelector(".ip-settings-confirm"), "恢复"); assert.deepEqual(calls.restoreArchive, ["archive-a"]); assert.equal(shell.activePageId, "iphone-settings-archives"); await shell.back(); await tick();
  settingsFailure = true; await toggle("长期记忆"); assert.equal(prefs.memoryEnabled, false); assert.equal(body().querySelector('[aria-label="长期记忆"]').checked, false); assert.match(body().textContent, /设置保存失败/);
  settingsFailure = false; await toggle("长期记忆"); assert.equal(prefs.memoryEnabled, true); await toggle("启用做梦"); assert.equal(prefs.dreamEnabled, true); assert.equal(body().querySelector(".ip-agent-dream").hidden, false);
  input("每天最多整理次数", "3"); prefs = { ...prefs, version: "external-settings" }; emit(); await tick(); await click("保存"); assert.match(body().textContent, /内容已变化/); assert.equal(body().querySelector('[aria-label="每天最多整理次数"]').value, "3"); await click("重新读取"); await click("保存"); assert.equal(prefs.dreamRunsPerDay, 3);
  await click("立即整理"); assert.equal(calls.runDream, 1); assert.match(body().textContent, /正在整理/); await click("停止"); assert.equal(dream.phase, "interrupted"); assert.ok(calls.cancelDream > 0);
  await click("立即整理"); await shell.back(); await tick(); assert.equal(dream.phase, "interrupted"); assert.equal(listeners.size, 0, "Closing the Agent settings releases subscriptions");
  assert.equal(document.querySelector(".modal-container"), null);
  console.log("PASS iPhone Agent/Memory UI: four groups, owner avatars, 24 slots, source confirmation/deletion, conflicts retain drafts, local correction preview, forget/restore/export, read-only archives, Dream cancellation and settings versions");
} finally { for (const page of pages) page.dispose?.(); dom.window.close(); }

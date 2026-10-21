import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build(mobileBuildOptions("src/ui/ipad/agent-settings-pages.ts"));
const dom = new JSDOM("<!doctype html><body><aside><textarea>right task draft</textarea></aside><main></main></body>", { pretendToBeVisual: true, url: "https://ipad-memory.invalid" });
const notices = [], module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, document: dom.window.document, window: dom.window,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, AbortController, structuredClone, URL, setTimeout, clearTimeout, console, atob, btoa, TextEncoder, TextDecoder,
  require(id) { assert.equal(id, "obsidian"); return { setIcon: (node, icon) => { node.dataset.icon = icon; }, Notice: class { constructor(value) { notices.push(value); } } }; } });
const tick = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0)); };
const root = dom.window.document.querySelector("main"), right = dom.window.document.querySelector("aside textarea"), listeners = new Set();
const settings = { settingsLanguage: "zh-CN", agentRegistry: { agents: [
  { id: "general", name: "总助", position: "处理日常事项", avatar: { kind: "default" } },
  { id: "research", name: "研究员", position: "资料核验", avatar: { kind: "default" } }
], moduleOwners: { journal: "general", todos: "general", review: "general", finance: "general", "knowledge-base": "general", "english-diary": "general", "pdf-reading": "general" } } };
let prefs = { memoryEnabled: false, dreamEnabled: false, dreamRunsPerDay: 1, autoArchive: false, version: "s1" }, settingsRevision = 1, revision = 1, profileReads = 0;
let failSetting = false, failProfile = false, failCorrection = false;
const slots = [
  ...["identity.name", "identity.pronouns", "identity.role", "identity.organization", "identity.location_timezone", "identity.background"].map((profileKey, index) => ({ section: "identity", profileKey, labelZh: index ? `身份${index}` : "姓名与称呼", importance: 100 - index })),
  ...["language", "tone", "detail", "format", "examples", "tools", "workflow", "design", "technology", "interests", "avoidances", "accessibility"].map((key, index) => ({ section: "preference", profileKey: `preference.${key}`, labelZh: index ? `偏好${index}` : "语言", importance: 78 - index })),
  ...["decision_style", "autonomy", "confirmation", "feedback", "quality_bar", "pace"].map((key, index) => ({ section: "collaboration", profileKey: `collaboration.${key}`, labelZh: `协作${index}`, importance: 54 - index }))
];
let items = [{ id: "p1", section: "identity", profileKey: "identity.name", text: "原称呼", basis: "explicit_memory", status: "current", sourceMemoryIds: ["m1"], revision: 1 },
  { id: "p2", section: "preference", profileKey: "preference.language", text: "可能偏好中文", basis: "observed_memory", status: "current", sourceMemoryIds: ["m1"], revision: 1 }];
const originalRecord = { schema: "echoink.memory.v1", id: "m1", kind: "fact", status: "current", date: "2026-10-19", source: "用户原始陈述", basis: "explicit", title: "原记忆", content: "原始内容", recallWhen: "相关时", revision: 1, file: ".echoink/shared-user/memory/facts/m1.md" };
let records = [{ ...originalRecord }], forgotten = [];
let archives = [{ id: "a1", title: "历史任务", agentId: "research", updatedAt: 1, archivedAt: 2, messageCount: 2 }];
let dream = { phase: "idle", attemptsToday: 0, dailyLimit: 1, dayKey: "2026-10-19", startedAt: null, finishedAt: null, error: "" }, dreamResolve;
const writes = { profile: [], deletion: [], correction: [], forgetting: [], restoring: [], archived: [], dream: 0, cancelDream: 0, export: 0, owners: [] };
const notify = () => [...listeners].forEach(listener => listener());
const profileSnapshot = () => structuredClone({ revision, slots, items, sources: items.map(item => ({ profileKey: item.profileKey, id: "m1", title: "原记忆", content: "用户原始陈述", basis: "explicit", available: true })) });
const checkRevision = expected => { if (revision !== expected) throw new Error("内容已变化，请重新读取"); };
const listSnapshot = () => structuredClone({ revision, records, forgotten });
const api = {
  readSettings: () => ({ ...prefs }), saveSettings: async draft => { if (failSetting) throw new Error("settings save failed"); assert.equal(draft.version, prefs.version); prefs = { ...draft, version: `s${++settingsRevision}` }; dream.dailyLimit = prefs.dreamRunsPerDay; notify(); return { ...prefs }; },
  list: async query => { const snapshot = listSnapshot(); if (query) snapshot.records = snapshot.records.filter(record => (record.title + record.content).includes(query)); return snapshot; },
  read: async id => structuredClone({ revision, record: records.find(record => record.id === id) }),
  previewCorrection: async (id, draft, expected) => { checkRevision(expected); return structuredClone({ ...draft, id, revision, original: records.find(record => record.id === id) }); },
  applyCorrection: async preview => { if (failCorrection) throw new Error("修正冲突，输入已保留"); checkRevision(preview.revision); writes.correction.push(preview); records = records.map(record => record.id === preview.id ? { ...record, title: preview.title, content: preview.content, recallWhen: preview.recallWhen, revision: ++revision } : record); notify(); return { revision, record: structuredClone(records[0]) }; },
  forget: async (id, reason, expected) => { checkRevision(expected); writes.forgetting.push({ id, reason }); forgotten.push({ id, title: records.find(record => record.id === id).title, forgottenAt: 1, reason }); records = records.filter(record => record.id !== id); revision++; notify(); return listSnapshot(); },
  restore: async (id, expected) => { checkRevision(expected); writes.restoring.push(id); records.push({ ...originalRecord }); forgotten = forgotten.filter(record => record.id !== id); revision++; notify(); return { revision, record: structuredClone(records[0]) }; },
  export: async () => { writes.export++; return { path: "Exports/memory.md", revision }; },
  readProfile: async () => { profileReads++; return profileSnapshot(); },
  saveProfile: async (key, text, expected) => { writes.profile.push({ key, text, expected }); if (failProfile) throw new Error("画像保存失败，输入已保留"); checkRevision(expected); const old = items.find(item => item.profileKey === key); items = items.filter(item => item.profileKey !== key); items.push({ ...(old ?? { id: key, section: slots.find(slot => slot.profileKey === key).section, profileKey: key, sourceMemoryIds: ["m1"] }), text, status: "current", basis: "explicit_memory", revision: ++revision }); notify(); return profileSnapshot(); },
  confirmProfile: async (key, expected) => { checkRevision(expected); items = items.map(item => item.profileKey === key ? { ...item, basis: "explicit_memory", revision: ++revision } : item); notify(); return profileSnapshot(); },
  deleteProfile: async (key, expected) => { checkRevision(expected); writes.deletion.push(key); items = items.filter(item => item.profileKey !== key); revision++; notify(); return profileSnapshot(); },
  dreamStatus: () => ({ ...dream }),
  runDream: async signal => { writes.dream++; dream = { ...dream, phase: "running", attemptsToday: dream.attemptsToday + 1, startedAt: 1 }; notify(); return new Promise(resolve => { dreamResolve = resolve; signal.addEventListener("abort", () => { dream = { ...dream, phase: "interrupted", finishedAt: 2 }; notify(); resolve({ ...dream }); }, { once: true }); }); },
  cancelDream: async () => { writes.cancelDream++; dream = { ...dream, phase: "interrupted", finishedAt: 2 }; dreamResolve?.({ ...dream }); notify(); },
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  listArchives: async () => structuredClone(archives), readArchive: async id => ({ id, title: "历史任务", agentId: "research", notePath: "", draft: "", updatedAt: 1, messages: [{ role: "user", content: "历史问题", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "历史回答" }], timestamp: 2 }] }),
  restoreArchive: async id => { writes.archived.push(id); archives = archives.filter(record => record.id !== id); notify(); }
};
const stack = [], openedNotes = [], edited = [];
const mount = page => { const panel = dom.window.document.createElement("section"); panel.className = "echoink-ipad-page"; panel.append(page.content); if (page.footer) panel.append(page.footer); root.append(panel); page.panel = panel; stack.push(page); };
const ctx = { root, document: dom.window.document, host: { services: { memory: api, refreshAgentIdentity: async () => {} }, settings: () => settings, openNote: async path => openedNotes.push(path),
  agents: { snapshot: async () => structuredClone({ registry: settings.agentRegistry, version: "registry1" }), setOwner: async (moduleId, agentId, version) => { writes.owners.push({ moduleId, agentId, version }); settings.agentRegistry.moduleOwners[moduleId] = agentId; } },
  renderMarkdown: (text, element) => { element.textContent = text; } }, error: error => notices.push(String(error)), shell: {},
  refresh: () => root.dispatchEvent(new dom.window.Event("pd-settings-refresh")),
  async push(page) { const previous = stack.at(-1); if (previous?.canLeave && !await previous.canLeave()) { page.dispose?.(); return false; } if (previous) previous.panel.hidden = true; mount(page); return true; },
  async back() { const page = stack.at(-1); if (page?.canLeave && !await page.canLeave()) return false; stack.pop(); page.dispose?.(); page.panel.remove(); if (stack.at(-1)) stack.at(-1).panel.hidden = false; return true; } };
const current = () => stack.at(-1), buttons = scope => [...(scope ?? current().panel).querySelectorAll("button")];
const click = async (label, scope) => { const button = buttons(scope).find(node => node.textContent.trim() === label); assert.ok(button, `button exists: ${label}`); button.click(); await tick(); };
const fill = (label, value, scope = current().content) => { const node = scope.querySelector(`[aria-label="${label}"]`); assert.ok(node, `input exists: ${label}`); node.value = value; node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); return node; };
const toggle = async (label, enabled) => { const input = current().content.querySelector(`[aria-label="${label}"]`); assert.ok(input); input.checked = enabled; input.dispatchEvent(new dom.window.Event("change")); await tick(); return input; };
const profileRow = key => current().content.querySelector(`[data-profile-key="${key}"]`);
const unhandled = [], collect = error => unhandled.push(error); process.on("unhandledRejection", collect);
try {
  mount(module.exports.createAgentSettingsPage(ctx, async id => { edited.push(id); await ctx.push({ id: "agent-form", title: "Agent", content: dom.window.document.createElement("div") }); })); await tick();
  const rootPage = current(); assert.deepEqual([...rootPage.content.querySelectorAll("h2")].map(node => node.textContent), ["我的 Agent", "模块负责人", "记忆", "会话"]);
  const initialReads = profileReads; for (let index = 0; index < 5; index++) ctx.refresh(); await tick(); assert.equal(profileReads, initialReads, "unrelated workbench updates must not rescan profile files");
  assert.match(rootPage.content.textContent, /你的画像2 项/); assert.match(rootPage.content.textContent, /已归档会话1/); assert.match(rootPage.content.textContent, /每天最多 1 次/); assert.match(rootPage.content.textContent, /完成 7 天后/);
  assert.equal(rootPage.content.querySelectorAll(".pd-agent-owner-avatar").length, 6);
  await click("新建 Agent"); assert.equal(current().id, "agent-form"); assert.deepEqual(edited, [undefined]); await ctx.back();
  const owner = buttons().find(node => node.textContent.trim() === "日记总助"); owner.click(); await tick(); await click("研究员"); assert.equal(writes.owners[0].agentId, "research"); assert.equal(writes.owners[0].version, "registry1");
  failSetting = true; const failedToggle = await toggle("长期记忆", true); assert.equal(failedToggle.checked, false); assert.equal(prefs.memoryEnabled, false); failSetting = false;
  await click("你的画像2 项"); assert.equal(current().content.querySelectorAll("[data-profile-key]").length, 24); assert.equal(current().content.querySelectorAll(".pd-agent-unfilled").length, 3);
  assert.match(profileRow("preference.language").textContent, /系统观察 · 仅供参考/); await click("确认", profileRow("preference.language")); assert.match(profileRow("preference.language").textContent, /你确认的/);
  await click("修改", profileRow("identity.name")); fill("姓名与称呼", "本地新称呼", profileRow("identity.name")); failProfile = true; await click("保存", profileRow("identity.name"));
  assert.equal(profileRow("identity.name").querySelector("textarea").value, "本地新称呼"); assert.match(current().content.textContent, /画像保存失败/); failProfile = false;
  revision++; notify(); await tick(); await click("保存", profileRow("identity.name")); assert.match(current().content.textContent, /内容已变化/); assert.equal(profileRow("identity.name").querySelector("textarea").value, "本地新称呼");
  await click("重新核对", profileRow("identity.name")); await click("保存", profileRow("identity.name")); assert.match(profileRow("identity.name").textContent, /本地新称呼/);
  const countBeforeDelete = records.length; await click("删除", profileRow("identity.name")); await click("删除", profileRow("identity.name").querySelector(".pd-agent-inline-confirm")); assert.equal(records.length, countBeforeDelete); assert.deepEqual(writes.deletion, ["identity.name"]);
  const unfilled = profileRow("identity.name").closest("details"); unfilled.open = true; await click("补写", profileRow("identity.name")); fill("姓名与称呼", "leave draft", profileRow("identity.name"));
  const leave = ctx.back(); await tick(); await click("继续编辑"); assert.equal(await leave, false); assert.equal(profileRow("identity.name").querySelector("textarea").value, "leave draft");
  await click("取消", profileRow("identity.name")); await ctx.back(); await tick(); assert.match(current().content.textContent, /你的画像1 项/);
  await click("记忆修正"); await click("导出"); assert.equal(writes.export, 1); await click("已导出Exports/memory.md"); assert.deepEqual(openedNotes, ["Exports/memory.md"]);
  const recordButton = buttons().find(node => node.textContent.includes("原记忆")); recordButton.click(); await tick(); assert.match(current().content.textContent, /用户原始陈述/);
  await click("修正"); fill("记忆内容", "本地修正草稿"); await click("预览修改"); assert.match(current().content.textContent, /修改前/); assert.match(current().content.textContent, /修改后/); assert.equal(writes.correction.length, 0);
  failCorrection = true; await click("确认修正"); assert.match(current().content.textContent, /本地修正草稿/); assert.match(current().content.textContent, /修正冲突/); failCorrection = false;
  await click("继续修改"); assert.equal(current().content.querySelector("textarea").value, "本地修正草稿"); await click("预览修改"); await click("确认修正"); assert.equal(writes.correction.length, 1); assert.equal(records[0].content, "本地修正草稿");
  await click("忘记"); assert.equal(writes.forgetting.length, 0); await click("确认忘记"); assert.equal(writes.forgetting.length, 1); assert.equal(current().id, "ipad-memory-list");
  current().content.querySelector(".pd-agent-forgotten").open = true; await click("恢复"); const confirmation = current().content.querySelector(".pd-agent-inline-confirm"); await click("恢复", confirmation); assert.deepEqual(writes.restoring, ["m1"]); assert.equal(records[0].source, originalRecord.source);
  await ctx.back(); await tick(); await click("已归档会话1"); await click("历史任务2 条消息"); assert.match(current().content.textContent, /历史问题/); assert.match(current().content.textContent, /历史回答/); assert.equal(current().content.querySelector("textarea,input"), null);
  await click("恢复会话"); await click("恢复", current().content.querySelector(".pd-agent-inline-confirm")); assert.deepEqual(writes.archived, ["a1"]); await ctx.back(); await tick();
  await toggle("做梦", true); assert.ok(current().content.querySelector('[aria-label="每日最多次数"]')); await click("立即整理"); assert.equal(writes.dream, 1); assert.match(current().content.textContent, /正在整理/);
  await click("停止"); assert.ok(writes.cancelDream > 0); assert.match(current().content.textContent, /整理已中断/); assert.equal(buttons().find(node => node.textContent.trim() === "立即整理").disabled, true, "daily limit disables another attempt");
  dream.attemptsToday = 0; notify(); await tick(); await click("立即整理"); assert.equal(writes.dream, 2); await toggle("做梦", false); assert.equal(dream.phase, "interrupted"); assert.equal(prefs.dreamEnabled, false); await toggle("做梦", true);
  fill("每日最多次数", "3"); const discard = ctx.back(); await tick(); await click("放弃修改"); assert.equal(await discard, true); assert.equal(prefs.dreamRunsPerDay, 1);
  assert.equal(right, dom.window.document.querySelector("aside textarea")); assert.equal(right.value, "right task draft");
  assert.equal(unhandled.length, 0, `Unhandled errors: ${unhandled.join("; ")}`);
  console.log("iPad M9 UI: four groups/real counts/owner avatars, registry owner save, switch rollback, 24 profile slots/source confirmation/conflict retained/delete keeps Memory, local correction preview/apply/forget/restore/export with Memory off, readonly archive restore, Dream task/stop/daily limit/discard, central right draft preserved passed.");
} finally { while (stack.length) { const page = stack.pop(); page.dispose?.(); } assert.equal(listeners.size, 0, "disposed pages release memory subscriptions"); process.off("unhandledRejection", collect); dom.window.close(); }

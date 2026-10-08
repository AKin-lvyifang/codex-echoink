import { MobileUI } from "../../src/ui/mobile/mobile-ui";
import { MobileStore } from "../../src/mobile/store";
import { MobileRuntime } from "../../src/mobile/runtime";
import { loadMobileSettings } from "../../src/mobile/settings";
import { createHost, answer } from "./host.mjs";

const host = createHost();
const params = new URLSearchParams(location.search);
const fixturePrefix = params.has("seed") ? "echoink-ipad-workspace-v1-fixture" : "echoink-mobile-fixture";
const persisted = localStorage.getItem(`${fixturePrefix}-files`);
if (persisted) { host.files.clear(); for (const [key, value] of JSON.parse(persisted)) host.files.set(key, value); }
const persist = () => localStorage.setItem(`${fixturePrefix}-files`, JSON.stringify([...host.files]));
const write = host.adapter.write.bind(host.adapter);
host.adapter.write = async (path, text) => { await write(path, text); persist(); };
const create = host.app.vault.create.bind(host.app.vault);
host.app.vault.create = async (path, text) => { const file = await create(path, text); persist(); return file; };
let slowRead = false;
const read = host.app.vault.read.bind(host.app.vault);
host.app.vault.read = async file => { if (slowRead) await new Promise(resolve => setTimeout(resolve, 1600)); return read(file); };
const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load();
const settings = loadMobileSettings(params.has("offline") ? null : JSON.parse(localStorage.getItem(`${fixturePrefix}-settings`) ?? "null"));
if (params.has("seed") && !persisted) {
  const first = store.session; first.title = "iPad 上的工作记录"; first.notePath = "笔记/来源.md";
  first.messages = [{ role: "user", content: "把今天的记录整理成可读的笔记。", timestamp: Date.now() }, {
    role: "assistant", content: [{ type: "text", text: "先整理目标，再记录决定和行动。\n\n下面保留完整的表格和代码，长内容在各自区域滚动。\n\n```ts\nconst decisions = [\"保留原生笔记与对话\", \"按内容宽度调整布局\", \"保存尚未提交的编辑内容\"];\n```\n\n| 工作项 | 当前决定 | 下一步 | 验证边界 |\n| --- | --- | --- | --- |\n| 平板布局 | 使用内容容器宽度 | 检查宽窄往返 | 浏览器替身与真实设备分开记录 |" }], api: "openai-completions", provider: "openai", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now()
  }];
  for (let index = 0; index < 25; index++) { await store.createSession(); store.session.title = `历史记录 ${index + 1}`; }
  store.state.activeSessionId = first.id;
  for (let index = 0; index < 25; index++) store.state.memories.push({ id: `fixture-memory-${index}`, kind: "view", title: ["解释与沟通偏好", "每周复盘", "工作中的决定", "值得继续探索的问题"][index] ?? `记忆 ${index + 1}`, content: ("先给结论，再给证据。每次记录只保留真正影响下一步的决定。\n\n").repeat(index === 0 ? 25 : 2), recallWhen: "解释问题", basis: "explicit", date: new Date().toISOString(), revision: 1, contentOrigin: "user_edit" });
  await store.save();
}
const requests: unknown[] = [];
let renders = 0;
const runtime = new MobileRuntime(host.app as any, store, () => settings, async request => {
  const body = JSON.parse(request.body as string); requests.push(body);
  document.querySelector<HTMLElement>("#app")!.dataset.requests = String(requests.length);
  const messages = body.messages ?? body.input;
  const userIndex = messages.findLastIndex((m: any) => m.role === "user");
  const prompt = messages[userIndex]?.content ?? "";
  const after = messages.slice(userIndex + 1);
  const protocol = body.input ? "openai-responses" : "openai-completions";
  await new Promise(resolve => setTimeout(resolve, prompt.includes("停止") ? 2000 : 250));
  if (prompt.includes("失败")) return { status: 401, json: { error: { message: "测试配置返回 401" } } };
  if (!after.length && prompt.includes("保存")) return answer(protocol, "", [
    ["save-" + requests.length, "note_create", { path: "输出/手机记录.md", content: "# 手机记录\n\n这是工具实际保存的 Markdown。" }],
    ["memory-" + requests.length, "memory_write", { kind: "view", title: prompt.includes("第二条") ? "第二条短记忆" : "先说结论", content: prompt.includes("第二条") ? "这是一条独立的短记忆。" : "解释技术问题时先说结论。", recallWhen: "解释技术问题", basis: "explicit" }]
  ]);
  if (!after.length && prompt.includes("读取")) { slowRead = true; return answer(protocol, "", [["read-" + requests.length, "note_read", { path: "笔记/来源.md" }]]); }
  return answer(protocol, "已完成。这是测试提供商返回的完整回答，正式组件使用真实 Agent 和工具回执。");
});
const root = document.querySelector<HTMLElement>("#app")!;
const ui = new MobileUI(root, { app: host.app as any, isTablet: params.has("tablet"), store, runtime, settings: () => settings, saveSettings: async () => { localStorage.setItem(`${fixturePrefix}-settings`, JSON.stringify(settings)); }, openNote: async path => { await host.app.workspace.getLeaf().openFile({ path }); document.querySelector("#opened")!.textContent = `已通过打开接口进入：${path}\n${host.files.get(path)}`; }, beginRender() { root.dataset.renders = String(++renders); }, renderMarkdown(text, element) {
  // A synthetic renderer for layout only; real MarkdownRenderer is host-owned.
  for (const part of text.split(/(```[\s\S]*?```)/u)) {
    if (part.startsWith("```")) { const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = part.replace(/^```[^\n]*\n|```$/gu, ""); pre.append(code); element.append(pre); }
    else if (part.includes("| 工作项 |")) {
      const start = part.indexOf("| 工作项 |"); const paragraph = document.createElement("p"); paragraph.textContent = part.slice(0, start); element.append(paragraph);
      const table = document.createElement("table");
      for (const line of part.slice(start).trim().split("\n").filter(line => !line.includes("---"))) { const row = document.createElement("tr"); for (const cell of line.split("|").slice(1, -1)) { const td = document.createElement("td"); td.textContent = cell; td.style.whiteSpace = "nowrap"; td.style.padding = "10px"; row.append(td); } table.append(row); }
      element.append(table);
    } else { const paragraph = document.createElement("p"); paragraph.textContent = part; paragraph.style.whiteSpace = "pre-wrap"; element.append(paragraph); }
  }
} });
ui.mount();
Object.assign(window, { mobileFixture: { store, settings, runtime, host, requests, ui } });

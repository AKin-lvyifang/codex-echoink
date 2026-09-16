import { MobileUI } from "../../src/ui/mobile/mobile-ui";
import { MobileStore } from "../../src/mobile/store";
import { MobileRuntime } from "../../src/mobile/runtime";
import { loadMobileSettings } from "../../src/mobile/settings";
import { createHost, answer } from "./host.mjs";

const host = createHost();
const persisted = localStorage.getItem("echoink-mobile-fixture-files");
if (persisted) { host.files.clear(); for (const [key, value] of JSON.parse(persisted)) host.files.set(key, value); }
const persist = () => localStorage.setItem("echoink-mobile-fixture-files", JSON.stringify([...host.files]));
const write = host.adapter.write.bind(host.adapter);
host.adapter.write = async (path, text) => { await write(path, text); persist(); };
const create = host.app.vault.create.bind(host.app.vault);
host.app.vault.create = async (path, text) => { const file = await create(path, text); persist(); return file; };
let slowRead = false;
const read = host.app.vault.read.bind(host.app.vault);
host.app.vault.read = async file => { if (slowRead) await new Promise(resolve => setTimeout(resolve, 1600)); return read(file); };
const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load();
const settings = loadMobileSettings(JSON.parse(localStorage.getItem("echoink-mobile-fixture-settings") ?? "null"));
const requests: unknown[] = [];
const runtime = new MobileRuntime(host.app as any, store, () => settings, async request => {
  const body = JSON.parse(request.body as string); requests.push(body);
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
const ui = new MobileUI(root, { app: host.app as any, store, runtime, settings: () => settings, saveSettings: async () => { localStorage.setItem("echoink-mobile-fixture-settings", JSON.stringify(settings)); }, openNote: async path => { await host.app.workspace.getLeaf().openFile({ path }); document.querySelector("#opened")!.textContent = `已通过打开接口进入：${path}\n${host.files.get(path)}`; }, beginRender() {}, renderMarkdown(text, element) { element.textContent = text; element.style.whiteSpace = "pre-wrap"; } });
ui.mount();
Object.assign(window, { mobileFixture: { store, settings, runtime, host, requests, ui } });

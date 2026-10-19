import { MarkdownRenderer, Platform } from "./browser-obsidian";
import { LifestyleView } from "../../src/lifestyle/view";
import { MobileViewport } from "../../src/ui/mobile/viewport";
import { createMobileAccountService } from "../../src/mobile/account";
import EchoInkMobilePlugin from "../../src/mobile/plugin";
import { mobileWorkspaceFixture } from "./workspace-fixture";
import { EchoInkHomeView } from "../../src/home/home-view";
import { mountAccountMembership } from "../../src/settings/account-membership";
import { MobileServices } from "../../src/mobile/services";
import { MobileStore } from "../../src/mobile/store";
import { MobileRuntime } from "../../src/mobile/runtime";
import { loadMobileSettings } from "../../src/mobile/settings";
import { AgentIdentityModal } from "../../src/ui/agent-identity-modal";
import { createHost, answer } from "./host.mjs";

const host = createHost({ "笔记/来源.md": "项目决定：先完成手机本地问答。", "Wiki/项目/产品草稿.md": "# 产品草稿\n\n本周聚焦真实场景。", "Wiki/项目/工作复盘.md": "# 工作复盘\n\n记录决定、证据与行动。", "Wiki/项目/手机验收.md": "# 知识", "Raw/资料.md": "# 原始资料", "Inbox/记录.md": "# Inbox" });
host.app.workspace.containerEl = document.body;
const params = new URLSearchParams(location.search);
const keyboard = Number(params.get("keyboard") ?? 0);
if (keyboard > 0) {
  const viewport = Object.assign(new EventTarget(), { scale: 1, height: innerHeight - keyboard, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  if (params.has("shrink")) document.querySelector<HTMLElement>("#fixture-workspace")!.style.height = `calc(100dvh - 48px - ${keyboard}px - var(--fixture-safe,0px))`;
  document.querySelector<HTMLElement>(".fixture-navbar")!.style.bottom = `${keyboard}px`;
}
Platform.isMobileApp = Platform.isMobile = !params.has("desktop"); Platform.isTablet = params.has("tablet") && Platform.isMobile;
const fixturePrefix = params.has("review") ? `echoink-pre-main-profile-${params.get("review") || "initial"}-v1` : params.has("host") ? "echoink-ipad-beta7-host-fixture" : params.has("finance") ? "echoink-mobile-account-finance-beta4-fixture" : params.has("seed") ? "echoink-ipad-workspace-v1-fixture" : "echoink-mobile-ui-rework-v2-fixture";
const persisted = localStorage.getItem(`${fixturePrefix}-files`);
if (persisted) { host.files.clear(); for (const [key, value] of JSON.parse(persisted)) host.files.set(key, value); }
if (params.has("profile-error")) host.files.set(".echoink/agents/echoink/AGENT.md", "用户既有资料，缺少有效控制区域。\n");
const persist = () => localStorage.setItem(`${fixturePrefix}-files`, JSON.stringify([...host.files]));
const write = host.adapter.write.bind(host.adapter);
host.adapter.write = async (path, text) => { await write(path, text); persist(); };
for (const method of ["rename", "remove", "rmdir"] as const) { const original = host.adapter[method].bind(host.adapter); host.adapter[method] = async (...args: any[]) => { await (original as any)(...args); persist(); }; }
const create = host.app.vault.create.bind(host.app.vault);
host.app.vault.create = async (path, text) => { const file = await create(path, text); persist(); return file; };
let slowRead = false;
const read = host.app.vault.read.bind(host.app.vault);
host.app.vault.read = async file => { if (slowRead) await new Promise(resolve => setTimeout(resolve, 1600)); return read(file); };
const store = new MobileStore(host.adapter, "plugin/mobile", "fixture-instance"); await store.load();
if (params.has("identity")) {
  let avatar: Record<string, unknown> = { kind: "preset", presetId: params.get("identity") };
  if (params.get("identity") === "custom") {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d")!; context.fillStyle = "#2e7569"; context.fillRect(0,0,256,256); context.fillStyle = "#fff"; context.font = "100px sans-serif"; context.textAlign = "center"; context.fillText("FI",128,164);
    avatar = { kind: "custom", mimeType: "image/png", dataUrl: canvas.toDataURL("image/png"), width:256, height:256 };
  }
  host.files.set(".echoink/agents/echoink/agent-identity.json", JSON.stringify({ schema:"echoink.agent-identity.v1",revision:1,displayName:"墨墨",avatar,updatedAt:42 }));
}
const settings = loadMobileSettings(params.has("offline") ? null : JSON.parse(localStorage.getItem(`${fixturePrefix}-settings`) ?? "null"));
settings.mobileUi.knowledgePaths = { wiki: "Wiki", raw: "Raw", inbox: "Inbox" };
if (params.has("history")) {
  settings.knowledgeBase.healthHistory = [
    { date: "2026-10-05", at: Date.parse("2026-10-05T10:00:00+08:00"), status: "success" }, { date: "2026-10-09", at: Date.parse("2026-10-09T10:00:00+08:00"), status: "success" }, { date: "2026-10-11", at: Date.parse("2026-10-11T10:00:00+08:00"), status: "failed" }
  ] as typeof settings.knowledgeBase.healthHistory;
  settings.knowledgeBase.maintenanceHistory = [{ date: "2026-10-05", at: Date.parse("2026-10-05T10:00:00+08:00"), status: "success", summary: "旧维护" }, { date: "2026-10-10", at: Date.parse("2026-10-10T10:00:00+08:00"), status: "failed", summary: "最近维护" }] as typeof settings.knowledgeBase.maintenanceHistory;
}
if (params.has("seed") && !persisted) {
  const first = store.session;
  await store.patchSession(first.id, { title: "iPad 上的工作记录", notePath: "笔记/来源.md", messages: [{ role: "user", content: "把今天的记录整理成可读的笔记。", timestamp: Date.now() }, {
    role: "assistant", content: [{ type: "text", text: "先整理目标，再记录决定和行动。\n\n下面保留完整的表格和代码，长内容在各自区域滚动。\n\n```ts\nconst decisions = [\"保留原生笔记与对话\", \"按内容宽度调整布局\", \"保存尚未提交的编辑内容\"];\n```\n\n| 工作项 | 当前决定 | 下一步 | 验证边界 |\n| --- | --- | --- | --- |\n| 平板布局 | 使用内容容器宽度 | 检查宽窄往返 | 浏览器替身与真实设备分开记录 |" }], api: "openai-completions", provider: "openai", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now()
  }] });
  for (let index = 0; index < 25; index++) { const session = await store.createSession(); await store.patchSession(session.id, { title: `历史记录 ${index + 1}` }); }
  await store.selectSession(first.id);
  await store.update(state => {
  for (let index = 0; index < 25; index++) state.memories.push({ schema: "echoink.memory.v1", status: "current", source: first.id, file: store.statePath, id: `fixture-memory-${index}`, kind: "view", title: ["解释与沟通偏好", "每周复盘", "工作中的决定", "值得继续探索的问题"][index] ?? `记忆 ${index + 1}`, content: ("先给结论，再给证据。每次记录只保留真正影响下一步的决定。\n\n").repeat(index === 0 ? 25 : 2), recallWhen: "解释问题", basis: "explicit", date: new Date().toISOString(), revision: 1, contentOrigin: "user_edit" });
  });
}
if (params.has("large")) settings.mobileUi.largeText = true;
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
}, (id, turn) => services.context(id, turn));
const accountService = await createMobileAccountService(host.app as any, () => settings);
const financeAccess = { checkCapability: () => !params.has("expired"), requireCapability: () => { if (params.has("expired")) throw new Error("替身：授权已失效"); }, subscribe: () => () => {} };
const plugin = new EchoInkMobilePlugin(host.app as any, { id: "codex-echoink", version: "2.6.3-beta.7 fixture" } as any);
const services = new MobileServices({ accountService: financeAccess, app: host.app as any, settings, store, runtime, navigation: { open: () => plugin.navigation.open(), openNote: file => plugin.navigation.openNote(file) } as any, registerEvent() {}, showPage: page => plugin.showPage(page), saveSettings: registry => plugin.saveSettings(registry) }, "plugin/mobile");
Object.assign(plugin, { app: host.app, settings, store, runtime, services, accountService });
plugin.saveData = async data => { localStorage.setItem(`${fixturePrefix}-settings`, JSON.stringify(data)); };
await services.initialize();
await runtime.initialize();
plugin.registerTaskLifecycle();
await services.initializeFinance();
const root = document.querySelector<HTMLElement>("#app")!;
MarkdownRenderer.render = async (_app, text, element) => {
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
};
const workspaceFixture = mobileWorkspaceFixture(plugin, { chat: root, home: document.querySelector<HTMLElement>("#home")!, settings: document.querySelector<HTMLElement>("#settings")! }, params.has("tablet"));
let desktopDispose: (() => void | Promise<void>) | undefined;
if (params.has("desktop") && params.has("account")) {
  const account = mountAccountMembership(root, { app: host.app as any, viewModel: accountService.read(), actions: accountService.actions, read: () => accountService.read(), language: "zh-CN", openProviders() {} });
  root.style.overflow = "auto"; desktopDispose = () => account.dispose();
} else if (params.has("desktop") && params.has("home")) {
  const element = document.querySelector<HTMLElement>("#home")!; const view = new EchoInkHomeView({ app: host.app, contentEl: element, containerEl: element } as any, services);
  element.hidden = false; root.hidden = true; await view.onOpen(); desktopDispose = () => view.onClose();
} else {
  await plugin.navigation.open();
  if (params.has("home")) await plugin.navigation.openHome();
}
if (params.get("page") === "account") await plugin.showPage("account");
if (params.has("long")) {
  const action = document.querySelector<HTMLElement>(".start-actions button.quiet");
  if (action) action.append("：记录今天的重要决定与下一步行动");
}
document.querySelector("#fixture-home-tab")!.addEventListener("click", () => { void plugin.navigation.openHome(); });
document.querySelector("#fixture-close-settings")!.addEventListener("click", () => { void workspaceFixture.closeSettings(); });
window.addEventListener("pagehide", () => { void desktopDispose?.(); void workspaceFixture.dispose(); }, { once: true });
Object.assign(window, { mobileFixture: { store, settings, runtime, host, requests, plugin, services, workspaceFixture } });
if (params.has("desktop") && params.has("identity-modal")) {
  new AgentIdentityModal(host.app as any, { initialName: "桌面墨墨", initialAvatar: { kind: "preset", presetId: "lin" }, language: "zh", mode: "edit", onConfirm: async () => {} }).open();
}

if (params.has("finance")) {
  settings.lifestyle.finance.enabled = true;
  const finance = services.lifestyle.finance;
  await finance.initialize();
  if (!finance.entries().length && !params.has("expired")) {
    const month = new Date().toISOString().slice(0, 7);
    await finance.saveBudgetChanges({ defaultBudget: { totalCents: 500000, allocations: { "餐饮": 80000, "购物": 100000 } }, overrides: [], removedMonths: [] });
    await finance.saveBillPlan({ id: "fixture-plan", name: "设备添置", budgetCents: 800000 });
    for (let i = 0; i < 25; i++) await finance.addManual({ date: `${month}-${String(i % 10 + 1).padStart(2,"0")} 10:00:00`, merchant: i % 2 ? "合成餐饮" : "合成购物", category: i % 2 ? "餐饮" : "购物", kind: "expense", amountCents: 1000 + i * 123, status: "completed", account: "替身账户", description: "内部验收合成记录", currency: "CNY", note: "", ...(i < 3 ? { billPlanId: "fixture-plan" } : {}) });
  }
  const element = params.has("tablet") ? document.querySelector<HTMLElement>("#home")! : root;
  if (!params.has("tablet")) { await workspaceFixture.dispose(); root.classList.remove("echoink-mobile", "em-tablet"); }
  element.hidden = false; element.classList.add("echoink-mobile-finance");
  element.style.setProperty("--view-bottom-spacing", params.has("host") ? "var(--fixture-required)" : params.has("tablet") ? "0px" : "68px");
  const viewport = new MobileViewport(element);
  const view = new LifestyleView({ app: host.app, containerEl: element, contentEl: element } as any, services.lifestyle, "finance");
  await view.onOpen(); Object.assign(window, { financeView: view, financeViewport: viewport });
}

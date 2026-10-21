import { setIcon } from "obsidian";
import { IPhoneShell } from "../../src/ui/iphone/shell";
import { IPadShell } from "../../src/ui/ipad/shell";
import { IPadSettingsShell } from "../../src/ui/ipad/settings-shell";
import type { MobileShellCategory, MobileShellPage } from "../../src/ui/mobile/shell-types";
import { renderProviderBrandIcon } from "../../src/settings/provider-brand-icons";

// All content below is synthetic test data. Only the imported shells are product
// code; no runtime, Provider, account, Vault, task store or production entry runs.
type Shell = IPhoneShell | IPadShell | IPadSettingsShell;
type Palette = "green" | "violet";
const query = new URLSearchParams(location.search);
const scenes = ["V-PH1", "V-PH2", "V-PH3", "V-PD1", "V-PD2", "V-PD3", "V-PD4"] as const;
const scene = scenes.find(value => value === query.get("scene")) ?? "V-PH1";
const phone = scene.startsWith("V-PH");
let palette: Palette = query.get("palette") === "violet" ? "violet" : "green";
let mode = query.get("mode") === "dark" ? "dark" : "light";
let sequence = 0;
const errors: string[] = [];
const allShells: Shell[] = [];
const roles = [
  ["sol", "总助", "什么都能接，专门的活转给同事"],
  ["nova", "整理员", "整理 Inbox、写 Wiki、补双链"],
  ["rio", "记账员", "记账、导入账单、看预算"],
  ["lin", "研究员", "联网查资料、做对比"],
  ["aya", "日记陪伴", "陪你聊今天，整理成日记"],
  ["han", "复盘", "按周回看，提炼结论和待办"]
] as const;
const categories = [
  ["general", "通用", "settings"], ["model", "模型", "key-round"],
  ["agent", "Agent", "bot"], ["caps", "能力", "layout-list"],
  ["mods", "模块", "blocks"], ["account", "账号与会员", "feather"]
] as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name: string): HTMLElement { const node = el("span", "fx-icon"); setIcon(node, name); return node; }
function action(label: string, callback: () => void, id?: string, primary = false): HTMLButtonElement {
  const node = el("button", `echoink-shell-button${primary ? " echoink-shell-button-primary" : ""}`);
  node.type = "button"; node.append(el("span", "echoink-shell-button-label", label));
  if (id) node.dataset.test = id;
  node.onclick = callback; return node;
}
function iconAction(name: string, label: string, callback: () => void, id?: string): HTMLButtonElement {
  const node = el("button", "echoink-shell-icon"); node.type = "button";
  node.setAttribute("aria-label", label); setIcon(node, name);
  if (id) node.dataset.test = id;
  node.onclick = callback; return node;
}
function row(label: string, value = "", callback?: () => void, name?: string, id?: string): HTMLElement {
  const node = el(callback ? "button" : "div", "fx-row");
  if (node instanceof HTMLButtonElement) { node.type = "button"; node.onclick = callback!; }
  if (id) node.dataset.test = id;
  if (name) node.append(icon(name));
  node.append(el("span", "fx-grow", label));
  if (value) node.append(el("span", "fx-value", value));
  if (callback) node.append(icon("chevron-right"));
  return node;
}
function group(parent: HTMLElement, title: string, ...rows: HTMLElement[]): void {
  if (title) parent.append(el("div", "fx-group-label", title));
  const body = el("div", "fx-group"); body.append(...rows); parent.append(body);
}
function avatar(id: string, size = ""): HTMLImageElement {
  const image = el("img", `fx-avatar ${size}`); image.src = `/assets/avatars/monochrome-round-set-01/${id}.svg`; image.alt = ""; return image;
}
function page(title: string, content: HTMLElement, footer?: HTMLElement, actions?: HTMLElement): MobileShellPage {
  return { id: `fixture-${++sequence}`, title, content, footer, actions };
}
function onError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error); errors.push(message);
  status.textContent = `夹具错误：${message}`; status.dataset.error = "true";
}
function setTheme(): void {
  document.documentElement.dataset.palette = palette; document.documentElement.dataset.mode = mode;
  document.body.classList.toggle("theme-dark", mode === "dark"); document.body.classList.toggle("theme-light", mode === "light");
  document.body.dataset.echoinkTheme = palette === "green" ? "light-green" : "fog-purple";
  fixture.dataset.palette = palette; fixture.dataset.mode = mode;
}

document.body.classList.add("fixture-host", "is-mobile", "is-ios");
document.body.classList.toggle("is-tablet", !phone);
document.body.classList.toggle("is-phone", phone);
const caption = el("header", "fixture-caption");
caption.append(el("strong", "", `${scene} · 正式 M1 shell / synthetic 内容`));
caption.append(el("span", "", "仅测试壳与导航；外框为模拟宿主，不是 Obsidian 真机。工作台、任务、设置业务仍属后续 M 步。"));
const controls = el("div", "fixture-controls");
const sceneSelect = el("select"); sceneSelect.setAttribute("aria-label", "测试场景");
for (const id of scenes) { const option = el("option", "", id); option.value = id; option.selected = id === scene; sceneSelect.append(option); }
sceneSelect.onchange = () => { const next = new URL(location.href); next.searchParams.set("scene", sceneSelect.value); location.assign(next); };
controls.append(sceneSelect);
for (const value of ["green", "violet"] as const) {
  const button = el("button", "", value === "green" ? "暖白翠绿" : "雾紫石墨"); button.type = "button";
  button.dataset.test = `palette-${value}`; button.onclick = () => { palette = value; setTheme(); }; controls.append(button);
}
const modeButton = el("button", "", "切换明暗"); modeButton.type = "button"; modeButton.dataset.test = "toggle-mode";
modeButton.onclick = () => { mode = mode === "light" ? "dark" : "light"; setTheme(); }; controls.append(modeButton);
const keyboardButton = el("button", "", "模拟短键盘视口"); keyboardButton.type = "button"; keyboardButton.dataset.test = "toggle-keyboard";
keyboardButton.onclick = () => { const short = fixture.classList.toggle("fixture-short"); keyboardButton.setAttribute("aria-pressed", String(short)); }; controls.append(keyboardButton);
const failLabel = el("label", "fixture-error-control"); const failSave = el("input"); failSave.type = "checkbox"; failSave.dataset.test = "fail-save";
failLabel.append(failSave, document.createTextNode("模拟保存失败")); controls.append(failLabel);
const status = el("div", "fixture-status", "合成夹具就绪；未连接 Vault / Provider。"); status.setAttribute("role", "status"); status.dataset.test = "fixture-status";
const fixture = el("main", `fixture ${phone ? "fixture-phone" : "fixture-ipad"}`); fixture.id = "fixture";
fixture.dataset.scene = scene; fixture.setAttribute("aria-label", `${scene} 合成浏览器夹具`);
document.body.replaceChildren(caption, controls, status, fixture); setTheme();

// Test host frame sits outside all tested shell roots. It owns available size,
// tabs and drawer simulation; its CSS never changes a shell header/footer.
const hostStatus = el("div", "fixture-host-status", phone ? "9:41" : "9:41  10月17日 周五");
const indicators = el("span", "fixture-host-indicators"); indicators.append(icon("wifi"), icon("battery-full")); hostStatus.append(indicators);
const hostTop = el("div", "fixture-host-top"); hostTop.dataset.test = "host-tabs";
const work = el("div", "fixture-work");
fixture.append(hostStatus, hostTop, work);
let phoneShell: IPhoneShell | undefined;
let centralShell: IPadShell | undefined;
let sideShell: IPadShell | undefined;
let settingsShell: IPadSettingsShell | undefined;
let openSettings: () => void;
let openAgent: (index?: number, draft?: string) => void;

function modelSheet(shell: Shell, select: (brand: "deepseek" | "qwen", model: string) => void, onClose?: () => void): void {
  const content = el("div", "fx-model-list");
  for (const [brand, name, models] of [["deepseek", "DeepSeek", ["DeepSeek V3.2", "DeepSeek V3.2 思考"]], ["qwen", "通义千问", ["Qwen3 Max", "Qwen Plus"]]] as const) {
    const heading = el("div", "fx-model-heading"); const brandNode = el("span", "fx-brand"); renderProviderBrandIcon(brandNode, brand); heading.append(brandNode, document.createTextNode(name)); content.append(heading);
    const rows = el("div", "fx-group");
    for (const model of models) {
      const button = row(model, model === selectedModel ? "已选" : "", () => { selectedModel = model; select(brand, model); shell.closeSheet(); }, undefined, `model-${model}`);
      button.setAttribute("aria-pressed", String(model === selectedModel)); rows.append(button);
    }
    content.append(rows);
  }
  const footer = el("div", "fx-sheet-actions"); footer.append(action("管理模型服务", () => { shell.closeSheet(); openSettings(); }, "manage-models"));
  shell.openSheet({ title: "选择模型", content, footer, onClose });
}
let selectedModel = "DeepSeek V3.2";
function composer(shell: Shell, messages: HTMLElement, draft: string, placeholder = "交代给总助一件新事…"): HTMLElement {
  const root = el("div", "fx-composer"); const input = el("textarea"); input.value = draft;
  input.placeholder = placeholder; input.setAttribute("aria-label", "任务草稿（仅夹具）"); input.dataset.test = "composer-input";
  const bar = el("div", "fx-composer-bar");
  const simpleSheet = (title: string, text: string): void => { shell.openSheet({ title, content: el("p", "fx-sheet-copy", text) }); };
  bar.append(iconAction("plus", "添加附件", () => simpleSheet("测试附件", "本场景只测试短任务层承载，未连接文件服务。"), "attachments"));
  bar.append(iconAction("at-sign", "引用笔记", () => simpleSheet("引用笔记", "选择后只添加合成引用，不读取 Vault。"), "references"));
  const model = el("button", "fx-model-button"); model.type = "button"; model.dataset.test = "open-model-sheet";
  const brand = el("span", "fx-brand"); renderProviderBrandIcon(brand, "deepseek"); const modelLabel = el("span", "fx-model-label", selectedModel);
  model.append(brand, modelLabel); model.setAttribute("aria-label", `选择模型：${selectedModel}`);
  model.onclick = () => {
    const start = input.selectionStart, end = input.selectionEnd;
    modelSheet(shell, (provider, value) => { renderProviderBrandIcon(brand, provider); modelLabel.textContent = value; model.setAttribute("aria-label", `选择模型：${value}`); },
      () => { input.focus({ preventScroll: true }); input.setSelectionRange(start, end); });
  };
  bar.append(model, iconAction("shield-check", "权限：工作区可写", () => simpleSheet("权限", "这是合成状态，夹具没有文件写入权限。"), "permissions"));
  const send = el("button", "fx-send"); send.type = "button"; send.setAttribute("aria-label", "发送（仅夹具）"); send.dataset.test = "send";
  const visible = el("span"); visible.append(icon("arrow-up")); send.append(visible); send.disabled = !input.value.trim();
  input.oninput = () => { send.disabled = !input.value.trim(); };
  send.onclick = () => { if (!input.value.trim()) return; messages.append(el("div", "fx-user-message", input.value)); input.value = ""; send.disabled = true; status.textContent = "合成消息已加入当前 DOM；没有发起推理或创建正式任务。"; };
  bar.append(send); root.append(input, bar); return root;
}
function agentPage(shell: Shell, roleIndex = 0, draft = ""): MobileShellPage {
  const role = roles[roleIndex]; const content = el("div", "fx-agent-content");
  if (phone) {
    const strip = el("div", "fx-avatar-strip");
    roles.forEach((entry, index) => { const button = el("button", "fx-avatar-button"); button.type = "button"; button.setAttribute("aria-label", entry[1]); button.append(avatar(entry[0], "strip")); button.onclick = () => { void shell.replace(agentPage(shell, index)); }; strip.append(button); }); content.append(strip);
  }
  content.append(el("div", "fx-task-group", "进行中"));
  for (const [title, summary] of [["整理本周 Inbox 的 5 条想法", "3 条可以并入已有 Wiki"], ["给新写的 2 篇 Wiki 补链", "判断 7 处候选链接"]]) {
    const task = el("button", "fx-task-card"); task.type = "button"; task.append(el("strong", "", title), el("div", "fx-sub", summary));
    task.onclick = () => { const messages = el("div", "fx-stream"); messages.append(el("div", "fx-user-message", "把这周 Inbox 的想法整理一下"), el("div", "fx-answer", "5 条看完了。3 条和已有主题重合，建议并入已有 Wiki。")); void shell.push(page(title, messages, composer(shell, messages, ""))); };
    content.append(task);
  }
  content.append(el("div", "fx-task-group", "今天"));
  const done = el("button", "fx-task-card"); done.type = "button"; done.append(el("strong", "", "第 41 周复盘"), el("div", "fx-sub", "3 个结论 · 2 条新待办"));
  done.onclick = () => { void shell.push(page("第 41 周复盘", el("div", "fx-answer", "这是只读合成记录，用于核对详情推进与返回。"))); }; content.append(done);
  const actions = el("div"); actions.append(iconAction("settings", "EchoInk 设置", () => openSettings(), "open-settings"));
  const result = page(role[1], content, composer(shell, content, draft, `交代给${role[1]}一件新事…`), actions); result.subtitle = role[2]; return result;
}

function settingsContent(shell: Shell, id: string): MobileShellPage {
  const content = el("div", "fx-settings-content");
  if (id === "general") {
    const paletteRow = row("配色"); const segments = el("div", "fx-segments");
    for (const value of ["green", "violet"] as const) {
      const button = el("button", "", value === "green" ? "暖白翠绿" : "雾紫石墨"); button.type = "button"; button.setAttribute("aria-pressed", String(palette === value));
      button.onclick = () => { palette = value; setTheme(); for (const item of segments.querySelectorAll("button")) item.setAttribute("aria-pressed", String(item === button)); }; segments.append(button);
    }
    paletteRow.append(segments);
    group(content, "外观", paletteRow, row("界面语言", "简体中文", () => { void shell.push(formPage(shell, "界面语言")); }, undefined, "open-form"));
    const startup = row("启动时打开工作台"); const toggle = el("input"); toggle.type = "checkbox"; toggle.checked = true; toggle.setAttribute("aria-label", "启动时打开工作台（仅夹具）"); toggle.dataset.test = "startup-toggle"; startup.append(toggle);
    group(content, "启动", startup);
    group(content, "关于", row("EchoInk Agent", "2.7.0", () => { void shell.push(page("关于 EchoInk", el("div", "fx-answer", "M1 浏览器测试内容，仅用于验收容器。"))); }));
  } else if (id === "model") {
    const brand = el("span", "fx-brand"); renderProviderBrandIcon(brand, "deepseek");
    const item = row(selectedModel, "DeepSeek", () => modelSheet(shell, (provider, model) => {
      renderProviderBrandIcon(brand, provider); item.querySelector(".fx-grow")!.textContent = model;
      item.querySelector(".fx-value")!.textContent = provider === "deepseek" ? "DeepSeek" : "通义千问";
    }), undefined, "settings-model-sheet"); item.prepend(brand);
    group(content, "默认模型", item);
    group(content, "模型服务", row("DeepSeek", "2 个模型", () => { void shell.push(formPage(shell, "填写模型服务")); }, undefined, "provider-form"));
  } else if (id === "agent") {
    group(content, "我的 Agent", ...roles.map((role, index) => { const item = row(role[1], "", () => { void shell.push(agentPage(shell, index)); }); item.prepend(avatar(role[0])); return item; }));
  } else {
    const title = categories.find(category => category[0] === id)?.[1] ?? "设置";
    group(content, title, row(`${title}承载测试`, "", () => { void shell.push(formPage(shell, `${title}填写页`)); }, undefined, `category-form-${id}`));
  }
  return page(categories.find(category => category[0] === id)?.[1] ?? "设置", content);
}
function formPage(shell: Shell, title = "填写页"): MobileShellPage {
  const content = el("div", "fx-form");
  const fields = title === "界面语言" ? [["显示语言", "简体中文"], ["地区", "中国大陆"], ["备注", "合成草稿，返回与改变宽度后应保留"]] : [["连接名称", "DeepSeek"], ["接口地址", "https://api.example.test"], ["备注", "合成草稿，返回与改变宽度后应保留"]];
  for (const [index, [label, value]] of fields.entries()) {
    const field = el("label", "fx-field"); field.append(el("span", "", label)); const input = el("input"); input.value = value; input.dataset.test = index === 0 ? "form-input" : "form-field"; field.append(input); content.append(field);
  }
  const notes = el("label", "fx-field"); notes.append(el("span", "", "长文本")); const textarea = el("textarea"); textarea.value = "用于核对内部滚动与保存区域的位置。\n".repeat(7); textarea.dataset.test = "form-textarea"; notes.append(textarea); content.append(notes);
  const next = action("进入下一层", () => { void shell.push(page("下一层", el("div", "fx-answer", "返回会保留上一层的输入节点与草稿。"))); }, "form-next"); content.append(next);
  const feedback = el("div", "fx-feedback"); feedback.setAttribute("role", "status"); content.append(feedback);
  let saving = false;
  const footer = el("div", "fx-form-actions");
  const cancel = action("取消", () => { void shell.back(); }, "form-cancel");
  const save = action("保存", () => {
    if (saving) return; saving = true; cancel.disabled = true; save.disabled = true; save.firstElementChild!.textContent = "保存中…";
    window.setTimeout(() => { saving = false; cancel.disabled = false; save.disabled = false; save.firstElementChild!.textContent = "保存"; feedback.textContent = failSave.checked ? "测试保存失败，草稿已保留。" : "测试保存完成，仅保存在本页内存。"; feedback.dataset.error = String(failSave.checked); }, 700);
  }, "form-save", true);
  footer.append(cancel, save); const result = page(title, content, footer); result.canLeave = () => !saving; return result;
}
function phoneSettings(): void {
  const content = el("div", "fx-settings-root");
  group(content, "", ...categories.map(([id, label, name]) => row(label, "", () => { void phoneShell!.push(settingsContent(phoneShell!, id)); }, name, `category-${id}`)));
  void phoneShell!.push(page("设置", content));
}
function workbench(shell: IPhoneShell | IPadShell): MobileShellPage {
  const content = el("div", phone ? "fx-board fx-phone-board" : "fx-board fx-ipad-board");
  const head = el("div", "fx-board-head"); const headings = el("div", "fx-grow"); headings.append(el("h1", "", "工作台"), el("div", "fx-date", "10 月 17 日 星期五"));
  head.append(headings, iconAction("settings", "EchoInk 设置", () => openSettings(), "open-settings"), action("＋ 新任务", () => openAgent(), "new-task", true)); content.append(head);
  if (phone) {
    const strip = el("div", "fx-avatar-strip"); roles.forEach((role, index) => { const button = el("button", "fx-avatar-button"); button.type = "button"; button.setAttribute("aria-label", role[1]); button.append(avatar(role[0], "strip")); button.onclick = () => openAgent(index); strip.append(button); }); content.append(strip);
  }
  const nav = el("div", "fx-module-nav");
  for (const [name, title] of [["book-open", "日记"], ["list-todo", "待办"], ["wallet", "财务"], ["library", "知识库"], ["languages", "英文日记"]]) {
    const button = el("button"); button.type = "button"; button.append(icon(name), document.createTextNode(title)); button.onclick = () => { void shell.push(page(title, el("div", "fx-answer", `${title}合成内容；本场景只核对下一层与返回。`))); }; nav.append(button);
  }
  content.append(nav);
  for (const [heading, title, summary, person, state] of [
    ["上次中断", "对比三家笔记 AI 的定价", "停在：联网搜索 · 第 4 / 6 个来源", "研究员", "已中断"],
    ["等你回应", "整理本周 Inbox 的 5 条想法", "3 条可以并入已有 Wiki", "整理员", "等你回应"],
    ["正在进行", "给新写的 2 篇 Wiki 补链", "判断 7 处候选链接", "整理员", "40 秒"]
  ]) {
    const section = el("section", "fx-section"); const sectionHead = el("div", "fx-section-head"); sectionHead.append(el("h2", "", heading), el("span", "fx-count", "1")); section.append(sectionHead);
    const cards = el("div", "fx-card-grid"); const card = el("button", "fx-work-card"); card.type = "button";
    const who = el("div", "fx-who"); who.append(avatar(person === "研究员" ? "lin" : "nova"), el("span", "fx-sub", person), el("span", "fx-card-status", state));
    card.append(who, el("strong", "", title), el("span", "fx-step", summary)); card.onclick = () => openAgent(person === "研究员" ? 3 : 1); cards.append(card);
    if (heading === "等你回应") {
      sectionHead.querySelector(".fx-count")!.textContent = "2";
      const second = el("button", "fx-work-card"); second.type = "button";
      const whoSecond = el("div", "fx-who"); whoSecond.append(avatar("rio"), el("span", "fx-sub", "记账员"), el("span", "fx-card-status", "等你回应"));
      second.append(whoSecond, el("strong", "", phone ? "记一笔：午饭 ¥38" : "导入 10 月微信账单"), el("span", "fx-step", phone ? "分类拿不准" : "86 笔已入账，1 笔分类不确定")); second.onclick = () => openAgent(2); cards.append(second);
    }
    section.append(cards); content.append(section);
  }
  const signals = el("section", "fx-section"); const signalHead = el("div", "fx-section-head"); signalHead.append(el("h2", "", "可以交给 Agent"), el("span", "fx-count", "3")); signals.append(signalHead);
  group(signals, "", ...[["list-todo", "2 件待办今天到期，其中 1 件已逾期"], ["wallet", "餐饮本月已用预算 84%"], ["inbox", "Inbox 新增 3 条想法"]].map(([name, text]) => {
    const item = row(text, "", undefined, name); item.append(action("交给总助", () => openAgent(0, text))); return item;
  })); content.append(signals);
  const completed = el("section", "fx-section"); const completeHead = el("div", "fx-section-head"); completeHead.append(el("h2", "", "今天完成"), el("span", "fx-count", "2")); completed.append(completeHead);
  group(completed, "", row("第 41 周复盘", "09:12", () => openAgent(5)), row("把明天的两个会加进待办", "08:40", () => openAgent())); content.append(completed);
  const todos = el("section", "fx-section"); const todoHead = el("div", "fx-section-head"); todoHead.append(el("h2", "", "今日待办"), el("span", "fx-count", "2")); todos.append(todoHead);
  group(todos, "", ...["回复合作邮件", "跑知识库检索正式基线"].map(title => {
    const item = row(title, "今天"); const check = el("input"); check.type = "checkbox"; check.setAttribute("aria-label", `完成 ${title}（合成）`);
    check.onchange = () => { item.classList.toggle("fx-todo-done", check.checked); status.textContent = "只改变合成待办的 DOM 状态，未写入 Vault。"; }; item.prepend(check); return item;
  })); content.append(todos);
  const result = page("工作台", content); result.header = "content"; return result;
}

function numberParam(name: string, fallback: number): number { const value = Number(query.get(name)); return Number.isFinite(value) && value >= 240 && value <= 2400 ? value : fallback; }
function setSize(width: number, height: number): void { fixture.style.setProperty("--fixture-width", `${width}px`); fixture.style.setProperty("--fixture-height", `${height}px`); }

if (phone) {
  setSize(numberParam("width", 368), numberParam("height", 822));
  hostTop.append(icon("panel-left"), el("span", "", "EchoInk"), icon("ellipsis"));
  const root = el("div", "fixture-shell-root"); root.dataset.test = "phone-root"; work.append(root);
  const hostBottom = el("div", "fixture-host-bottom"); hostBottom.append(icon("arrow-left"), icon("arrow-right"), icon("plus"), icon("copy"), icon("menu")); fixture.append(hostBottom);
  phoneShell = new IPhoneShell(root, { onError }); allShells.push(phoneShell);
  openSettings = phoneSettings;
  openAgent = (index = 0, draft = "") => { void phoneShell!.push(agentPage(phoneShell!, index, draft)); };
  phoneShell.mount(workbench(phoneShell));
  if (scene === "V-PH2") phoneSettings();
  if (scene === "V-PH3") openAgent();
} else {
  const portrait = scene === "V-PD2";
  setSize(numberParam("width", portrait ? 820 : 1180), numberParam("height", portrait ? 1180 : 820));
  fixture.classList.toggle("fixture-portrait", portrait);
  const center = el("div", "fixture-center"); center.dataset.test = "central-root";
  const settings = el("div", "fixture-settings-root"); settings.dataset.test = "settings-root"; settings.hidden = true;
  const side = el("aside", "fixture-side"); side.dataset.test = "side-host";
  const sideTabs = el("div", "fixture-side-tabs"); const sideRoot = el("div", "fixture-side-root"); sideRoot.dataset.test = "side-root";
  const backdrop = el("button", "fixture-drawer-backdrop"); backdrop.type = "button"; backdrop.setAttribute("aria-label", "收回模拟抽屉"); backdrop.dataset.test = "close-drawer"; backdrop.hidden = true;
  side.append(sideTabs, sideRoot); work.append(center, settings, backdrop, side);
  centralShell = new IPadShell(center, { onError }); sideShell = new IPadShell(sideRoot, { onError }); allShells.push(centralShell, sideShell);
  let sideVisible = true; let settingsVisible = false;
  const tab = (label: string, callback: () => void, id: string): HTMLButtonElement => { const button = el("button", "fixture-host-tab", label); button.type = "button"; button.onclick = callback; button.dataset.test = id; return button; };
  const boardTab = tab("工作台", () => { center.hidden = false; settings.hidden = true; settingsVisible = false; syncTabs(); }, "host-workbench");
  const noteTab = tab("旅行预算", () => {
    center.hidden = false; settings.hidden = true; settingsVisible = false;
    const text = el("article", "fx-note"); text.append(el("h1", "", "旅行预算"), el("p", "", "周末出走的预算按三档来定：近郊一日不超过 300，两天一夜控制在 900，小长假按人均 2,500 准备。"), el("p", "", "交通优先高铁，住宿看 [[住宿清单]]。上次去莫干山实际花了 1,060，超出的部分主要在餐饮。")); centralShell!.mount(page("旅行预算", text)); syncTabs();
  }, "host-note");
  const settingsTab = tab("EchoInk 设置", () => openSettings(), "host-settings"); settingsTab.hidden = true;
  const closeSettings = tab("关闭设置", () => { settings.hidden = true; center.hidden = false; settingsVisible = false; settingsTab.hidden = true; closeSettings.hidden = true; syncTabs(); }, "host-close-settings"); closeSettings.hidden = true;
  const syncTabs = (): void => { settingsTab.setAttribute("aria-selected", String(settingsVisible)); boardTab.setAttribute("aria-selected", String(!settingsVisible)); };
  const toggleSide = tab("Agent 侧栏", () => setSideVisible(!sideVisible), "host-toggle-side");
  function setSideVisible(visible: boolean): void {
    sideVisible = visible; side.hidden = !visible; side.inert = !visible; backdrop.hidden = !portrait || !visible;
    fixture.classList.toggle("fixture-drawer-open", portrait && visible); toggleSide.setAttribute("aria-expanded", String(visible));
  }
  backdrop.onclick = () => setSideVisible(false);
  hostTop.append(icon("panel-left"), boardTab, noteTab, settingsTab, closeSettings, el("span", "fx-grow"), toggleSide);
  sideTabs.append(iconAction("bot", "EchoInk", () => { sideRoot.hidden = false; status.textContent = "已显示正式 iPad Agent 壳。"; }, "side-echoink"));
  sideTabs.append(iconAction("list", "大纲（模拟切换）", () => { sideRoot.hidden = true; status.textContent = "模拟宿主已切到大纲；Agent 壳节点与草稿保留。"; }, "side-outline"));
  const strip = el("div", "fixture-side-avatar-strip"); roles.forEach((role, index) => { const button = el("button", "fx-avatar-button"); button.type = "button"; button.setAttribute("aria-label", role[1]); button.append(avatar(role[0])); button.onclick = () => openAgent(index); strip.append(button); }); sideTabs.append(strip);
  openSettings = () => {
    const firstOpen = !settingsShell;
    if (!settingsShell) {
      const definitions: MobileShellCategory[] = categories.map(([id, label, name]) => ({ id, label, icon: name, createPage: () => settingsContent(settingsShell!, id) }));
      settingsShell = new IPadSettingsShell(settings, definitions, { onError }); allShells.push(settingsShell);
    }
    center.hidden = true; settings.hidden = false; settingsVisible = true; settingsTab.hidden = false; closeSettings.hidden = false;
    syncTabs(); if (firstOpen) void settingsShell.mount("general");
  };
  openAgent = (index = 0, draft = "") => { sideRoot.hidden = false; sideShell!.mount(agentPage(sideShell!, index, draft)); setSideVisible(true); };
  centralShell.mount(workbench(centralShell)); openAgent(1);
  if (scene === "V-PD3") openSettings();
  if (scene === "V-PD4") openAgent();
  const sizeLabel = el("label", "fixture-size-control", "宿主宽度 "); const size = el("input"); size.type = "range"; size.min = "520"; size.max = "1540"; size.value = String(portrait ? 820 : 1180); size.dataset.test = "host-width"; size.setAttribute("aria-label", "模拟宿主内容宽度");
  size.oninput = () => { fixture.style.setProperty("--fixture-width", `${size.value}px`); }; sizeLabel.append(size); controls.append(sizeLabel);
}

const fixtureApi = { scene, errors, get phone() { return phoneShell; }, get central() { return centralShell; }, get side() { return sideShell; }, get settings() { return settingsShell; }, setSize, openSettings: () => openSettings(), openAgent: (index = 0, draft = "") => openAgent(index, draft), dispose: () => { for (const shell of allShells) shell.dispose(); } };
Object.assign(window, { __mobileShellFixture: fixtureApi });
fixture.dataset.ready = "true";

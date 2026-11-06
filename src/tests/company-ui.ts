import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { installObsidianDom } from "./obsidian-dom";
import { openTestNoticeMessages } from "obsidian";
import { CompanyStore } from "../company/store";
import { CompanyService, type CompanyHost } from "../company/service";
import { ProjectPageView } from "../home/project-page";
import { workbenchProjectCard } from "../home/workbench-projects";
import { agentLookup } from "../home/project-parts";
import { normalizeAgentRegistry } from "../agents/registry";

const AGENTS = [{ id: "sol", name: "总助" }, { id: "lin", name: "研究员" }, { id: "june", name: "文案" }].map(a => ({ ...a, avatar: { kind: "default" }, position: "", styleId: "execution" }));

/** Renders the real project page and workbench card against a real CompanyService through each project stage. */
export function installCompanyTestDom(document: Document): void {
  Object.assign(globalThis, { window: document.defaultView, document, HTMLElement: document.defaultView!.HTMLElement, Element: document.defaultView!.Element, Node: document.defaultView!.Node });
  installObsidianDom(document.defaultView);
  // Obsidian's element helpers, as other DOM tests in this repo patch them in.
  type Info = { text?: string; cls?: string | string[]; attr?: Record<string, string | number | boolean | null>; type?: string; title?: string; placeholder?: string; value?: string; href?: string };
  const make = (owner: HTMLElement, tag: string, options: Info | string = {}): HTMLElement => {
    const info = typeof options === "string" ? { cls: options } : options;
    const el = document.createElement(tag);
    if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
    if (info.text !== undefined) el.textContent = info.text;
    for (const [name, value] of Object.entries(info.attr ?? {})) if (value !== null && value !== false) el.setAttribute(name, String(value));
    for (const name of ["type", "title", "placeholder", "value", "href"] as const) if (info[name] !== undefined) el.setAttribute(name, info[name]!);
    owner.append(el); return el;
  };
  Object.assign(document.defaultView!.HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; },
    setAttr(this: HTMLElement, name: string, value: string | number | boolean | null) { if (value === null || value === false) this.removeAttribute(name); else this.setAttribute(name, String(value)); },
    appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); },
    setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); }, removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: HTMLElement, name: string, on: boolean) { this.classList.toggle(name, on); }, hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    createEl(this: HTMLElement, tag: string, options?: Info | string) { return make(this, tag, options); },
    createDiv(this: HTMLElement, options?: Info | string) { return make(this, "div", options); },
    createSpan(this: HTMLElement, options?: Info | string) { return make(this, "span", options); }
  });
  const win = document.defaultView as unknown as Record<string, unknown>;
  win.ResizeObserver ??= class { observe() {} disconnect() {} };
  win.CSS ??= { escape: (value: string) => value };
}

export async function runCompanyUiTests(document: Document): Promise<void> {
  installCompanyTestDom(document);
  const dir = await mkdtemp(path.join(tmpdir(), "echoink-company-ui-"));
  let passed = 0; const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };
  try {
    let clock = 1_730_000_000_000, seq = 0; const running = new Set<string>(); const opened: string[] = [];
    const host: CompanyHost = { now: () => (clock += 60_000), newId: p => `${p}-${++seq}`,
      agents: () => [...AGENTS.map(a => ({ id: a.id, name: a.name, position: "", hired: true })), { id: "generalist", name: "通才", position: "", hired: true }],
      routerPermission: () => "workspace-write", createWorker: () => Promise.resolve(), startTurn: id => { running.add(id); return Promise.resolve(); },
      isRunning: id => running.has(id), steer: () => Promise.resolve(false), stop: id => { running.delete(id); return Promise.resolve(); },
      lastAssistantText: () => Promise.resolve(undefined), setRouterMetadata: () => Promise.resolve(), ensureFolder: n => Promise.resolve(`项目/${n}`), latestUserText: () => Promise.resolve("做一期视频") };
    const service = new CompanyService(new CompanyStore(path.join(dir, "c.json")), host); await service.initialize();
    const plugin = { companyService: service, settings: { agentRegistry: normalizeAgentRegistry({ schemaVersion: 1, agents: AGENTS, moduleOwners: {} }), settingsLanguage: "zh-CN", sessions: [] },
      getConversationRunService: () => ({ pendingInteractions: new Map(), subscribe: () => () => {}, refreshTask() {} }), notifyHomeSurfacesChanged() {}, piAgentApprovalBinding: () => null,
      openTaskDetail: (id: string) => { opened.push(id); return Promise.resolve(); } };
    const plan = [{ id: "t1", agentId: "lin", label: "查资料", brief: "整理原文", dependsOn: [], milestone: "资料" },
      { id: "t2", agentId: "june", label: "写稿", brief: "写口播稿", dependsOn: ["t1"] }];
    const pid = /项目编号 (\S+)）/u.exec(await service.propose("card", { name: "视频", background: "转来一篇文章", goal: "讲清双层架构", criteria: ["5 分钟左右"], roles: { lin: "资料", june: "口播稿" }, plan }))![1];
    await service.start("card", pid);

    // The test shim's View lacks Obsidian's setState; the base implementation only resolves.
    const base = Object.getPrototypeOf(ProjectPageView.prototype) as { setState?: unknown };
    if (typeof base.setState !== "function") base.setState = () => Promise.resolve();
    const leaf = { view: null } as never;
    const view = new ProjectPageView(leaf, plugin as never);
    const content = document.createElement("div"); document.body.appendChild(content);
    Object.assign(view, { contentEl: content, app: { workspace: { on: () => ({}) }, vault: { getAbstractFileByPath: () => null } } });
    await view.setState({ projectId: pid }, {} as never); await view.onOpen();
    const text = () => content.textContent ?? "";
    for (const part of ["视频", "项目成员", "研究员", "概况", "背景", "目标", "讲清双层架构", "验收标准", "里程碑", "任务", "记录", "产出"]) assert.ok(text().includes(part), `项目页缺少「${part}」`);
    assert.ok(text().includes("@研究员"), "记录里有派活");
    const labels = [...content.querySelectorAll("h2, h3, dt")].map(el => el.textContent?.trim()).filter(Boolean);
    assert.ok(labels.indexOf("背景") < labels.indexOf("目标"), "概况先背景后目标");
    ok("开工后：成员、概况（背景→目标）、记录里的派活都渲染出来");

    const t1 = service.doc.dispatches.find(d => d.planTaskId === "t1")!.id;
    await service.report(t1, { outcome: "need_decision", summary: "实验两组", outputs: [], question: "讲两组还是一组？", options: ["两组", "一组"] });
    running.delete(t1); await service.onWorkerSettled(t1, "completed", 0);
    running.delete("card");
    assert.ok(text().includes("等你定"), "等你定出现");
    const answer = content.querySelector<HTMLButtonElement>('.echoink-company-compact-choice[data-option-id="1"]');
    assert.ok(answer, "等你定复用 Question 选项");
    answer.click();
    // The click handler awaits atomic file writes; wait for them instead of a fixed delay.
    for (let i = 0; i < 100 && service.decisions(pid).length; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(service.decisions(pid).length, 0, `点按钮后答案送回员工 ${JSON.stringify(openTestNoticeMessages)}`);
    ok("等你定：出现选项，点一下送回员工");

    for (const tab of ["任务", "里程碑", "产出"]) {
      const button = [...content.querySelectorAll("button, [role=tab]")].find(b => b.textContent?.trim().startsWith(tab));
      assert.ok(button, `缺少「${tab}」标签`); (button as HTMLElement).click();
    }
    ok("四个标签都能切换并渲染");

    await service.report(t1, { outcome: "done", summary: "资料好了", outputs: ["项目/视频/资料摘要.md"] });
    running.delete(t1); await service.onWorkerSettled(t1, "completed", 0);
    const t2 = service.doc.dispatches.find(d => d.planTaskId === "t2")!.id;
    await service.report(t2, { outcome: "done", summary: "稿子好了", outputs: ["项目/视频/口播稿.md"] });
    running.delete(t2); await service.onWorkerSettled(t2, "completed", 0);
    await service.accept("card", pid, [{ criterion: "5 分钟左右", passed: true, evidence: "5 分 10 秒" }], "做完了");
    for (let i = 0; i < 100 && !text().includes("目标已达成"); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(text().includes("目标已达成"), "结项后显示目标已达成");
    ok("结项：顶部出现目标已达成");

    const card = workbenchProjectCard(document, service.doc, service.projectOf(pid)!, agentLookup(plugin.settings.agentRegistry.agents), () => opened.push("page"));
    assert.ok((card.textContent ?? "").includes("视频") && (card.textContent ?? "").includes("里程碑"), "工作台项目卡有名称和里程碑");
    card.click(); assert.equal(opened.at(-1), "page");
    ok("工作台项目卡：名称、里程碑、点击进入");
    await view.onClose();
    console.log(`company ui tests: ${passed} passed`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

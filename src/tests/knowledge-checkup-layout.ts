import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installObsidianDom } from "./obsidian-dom";
import { KnowledgeCheckupPanel } from "../home/knowledge-checkup/panel";
import { renderCheckupPreview } from "../home/knowledge-checkup/results";
import { KnowledgeDeepCheckupTaskService } from "../knowledge-base/knowledge-deep-checkup-task";
import { sha256Hex } from "../utils/sha256";

export async function runKnowledgeCheckupLayoutTests() {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  installObsidianDom(dom.window);
  const win = dom.window;
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  const proto = win.HTMLElement.prototype as any;
  proto.empty = function () {
    this.replaceChildren();
  };
  proto.addClass = function (...names: string[]) {
    this.classList.add(...names);
  };
  proto.toggleClass = function (name: string, value: boolean) {
    this.classList.toggle(name, value);
  };
  proto.removeClass = function (...names: string[]) {
    this.classList.remove(...names);
  };
  proto.setAttr = function (name: string, value: string) {
    this.setAttribute(name, value);
  };
  proto.setText = function (text: string) {
    this.textContent = text;
  };
  proto.createEl = function (tag: string, options: any = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.value !== undefined) element.value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {}))
      element.setAttribute(name, String(value));
    this.append(element);
    return element;
  };
  proto.createDiv = function (options: any) {
    return this.createEl("div", options);
  };
  proto.createSpan = function (options: any) {
    return this.createEl("span", options);
  };
  const host = win.document.querySelector("main")!;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const issue = (id: string, candidates: string[]) => ({
    id,
    kind: "broken",
    title: id,
    path: `Wiki/${id}.md`,
    target: "旧目录/目标",
    candidates,
    ignoreKey: "死链：旧目录/目标",
  });
  const quick = {
    issues: [
      issue("唯一", ["Wiki/目标.md"]),
      issue("多选", ["A/目标.md", "B/目标.md"]),
      issue("无候选", []),
      { id: "待归位", kind: "unplaced", title: "待归位", path: "Wiki/待归位.md", ignoreKey: "待归位" },
    ],
    candidates: ["Wiki/a.md", "Wiki/b.md"],
    linkTargets: [],
    loading: false,
  };
  const deep = {
    status: "completed",
    completedDomains: 2,
    totalDomains: 2,
    findings: [
      {
        id: "duplicate",
        kind: "duplicate",
        confidence: "high",
        paths: ["Wiki/a.md", "Wiki/b.md"],
        reason: "相同研究对象",
        evidence: [{ path: "Wiki/a.md", quote: "双方可核对的完整原句" }],
      },
      {
        id: "outdated",
        kind: "outdated",
        paths: ["Wiki/旧说明.md"],
        reason: "时间限定",
        evidence: [{ path: "Wiki/旧说明.md", quote: "旧的有效时间已经结束" }],
      },
    ],
  };
  let selected: any[] = [],
    confirms = 0,
    preview: any;
  const empty = { status: "ready", counts: { wikiCount: 0 } };
  const upgrade = {
    getUpgradeSnapshot: async () => empty,
    confirmUpgrade: async () => {
      confirms++;
      return {
        purpose: "checkup",
        status: "completed",
        counts: { wikiCount: 2 },
        preview,
        checkupResults: preview.checkupActions.map((row: any, index: number) => ({
          ...row,
          status: index ? "failed" : "success",
          message: index ? "笔记刚被改过" : undefined,
        })),
      };
    },
  };
  const service = {
    getHealthSnapshot: () => ({ status: "healthy", score: 87 }),
    upgrade,
    checkup: {
      quick: async () => quick,
      deep: { subscribe: () => () => {}, snapshot: async () => deep },
      prepare: async (selections: any[]) => {
        selected = selections;
        return (preview = {
          id: "exact-preview",
          automatic: [],
          checkupActions: selections.map((row) => ({
            ...row,
            kind: row.id === "outdated" ? "outdated" : "broken",
            title: row.id,
            path: "Wiki/a.md",
            action: row.action,
            affectedPaths: ["Wiki/a.md"],
          })),
        });
      },
    },
  };
  const plugin: any = {
    app: { workspace: { openLinkText: async () => {} } },
    getKnowledgeActivitySource: () => undefined,
    getKnowledgeSurfaceService: () => service,
  };
  const panel = new KnowledgeCheckupPanel(
    host as HTMLElement,
    plugin,
    () => {},
    () => {},
  );
  try {
    await panel.refresh();
    assert.equal(
      host.querySelector('[data-checkup-category="broken"]')?.getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      host.querySelectorAll('.knowledge-checkup-row input[type="checkbox"]').length,
      1,
      "A unique candidate is selected; multiple and absent targets cannot silently repair",
    );
    (host.querySelector('[data-checkup-category="unplaced"]') as HTMLButtonElement).click();
    await tick();
    const unplaced = host.querySelector('[data-checkup-id="待归位"] input') as HTMLInputElement;
    assert.equal(unplaced.checked, false, "Placement requires an explicit selection");
    assert.ok(host.textContent!.includes("判断并归位"), "The recommended action remains available");
    unplaced.click();
    assert.equal((panel as any).selections.get("待归位").action, "place");
    (host.querySelector('[data-checkup-id="待归位"] input') as HTMLInputElement).click();
    assert.equal((panel as any).selections.get("待归位").action, "later");
    (host.querySelector('[data-checkup-category="broken"]') as HTMLButtonElement).click();
    await tick();
    const target = host.querySelector("select") as HTMLSelectElement;
    target.value = "B/目标.md";
    target.dispatchEvent(new win.Event("change", { bubbles: true }));
    const unique = host.querySelector('[data-checkup-id="唯一"] input') as HTMLInputElement;
    unique.click();
    assert.equal(
      (host.querySelector('[aria-label="全选当前类"]') as HTMLInputElement).indeterminate,
      true,
    );
    (host.querySelector('[data-checkup-category="duplicate"]') as HTMLButtonElement).click();
    await tick();
    assert.equal(
      host.querySelectorAll(".knowledge-checkup-row input").length,
      1,
      "Duplicate findings now offer a real, default-selected merge action",
    );
    assert.equal((host.querySelector("select") as HTMLSelectElement).value, "merge");
    (host.querySelector(".knowledge-checkup-note") as HTMLButtonElement).click();
    await tick();
    assert.ok(!host.querySelector<HTMLElement>(".knowledge-checkup-evidence")!.hidden);
    assert.ok(host.textContent!.includes("双方可核对的完整原句"));
    (host.querySelector('.knowledge-checkup-row input[type="checkbox"]') as HTMLInputElement).click();
    (host.querySelector('[data-checkup-action="preview"]') as HTMLButtonElement).click();
    await tick();
    assert.deepEqual(
      selected.map((row) => [row.id, row.action, row.target]),
      [
        ["多选", "repair", "B/目标.md"],
        ["outdated", "verify", undefined],
      ],
      "Cross-category selection and exact candidate survive navigation",
    );
    assert.equal(confirms, 0, "Preview has not confirmed a write");
    const mergePreview = win.document.createElement("div");
    renderCheckupPreview(mergePreview, {
      ...preview,
      checkupActions: [{
        ...preview.checkupActions[0],
        merge: {
          primary: "Wiki/a.md", secondary: "Wiki/b.md", choices: [], anchors: [], omittedParagraphs: 2,
          sections: [
            { sourceTitle: "导语", targetTitle: "导语" },
            { sourceTitle: "方法", targetTitle: "方法" },
            { sourceTitle: "输入 → 输出", targetTitle: "输入 → 输出" },
            { sourceTitle: "执行过程", targetTitle: "操作步骤" },
          ],
          additions: [{ title: "来源", body: '[[Raw/source]]\n<!-- echoink-source: {"path":"Raw/source.md","revision":"internal"} -->' }],
        },
      }],
    });
    assert.ok(mergePreview.textContent!.includes("同名并入：导语、方法、输入 → 输出"));
    assert.ok(mergePreview.textContent!.includes("略去 2 段"));
    assert.ok(!mergePreview.textContent!.includes("导语 → 导语"));
    assert.ok(mergePreview.textContent!.includes("执行过程 → 操作步骤"));
    assert.ok(mergePreview.textContent!.includes("[[Raw/source]]"));
    assert.ok(!mergePreview.textContent!.includes("echoink-source"));
    (host.querySelector('[data-checkup-action="confirm"]') as HTMLButtonElement).click();
    await tick();
    assert.equal(confirms, 1);
    assert.ok(host.textContent!.includes("笔记刚被改过"));
    assert.equal(host.querySelectorAll(".knowledge-checkup-success").length, 1);
    assert.equal(
      (host.querySelector(".knowledge-checkup-success") as HTMLDetailsElement).open,
      false,
    );
    quick.issues = [];
    deep.findings = [];
    deep.status = "interrupted";
    const incompleteHost = win.document.createElement("main");
    const incompletePanel = new KnowledgeCheckupPanel(incompleteHost, plugin, () => {}, () => {});
    await incompletePanel.refresh();
    assert.ok(incompleteHost.textContent!.includes("深查尚未完成"));
    assert.ok(!incompleteHost.textContent!.includes("知识库很健康"), "Failed checks are never a healthy empty result");
    incompletePanel.dispose();
    const content = "本页仍建议使用已经超过截止日期的旧版研究申请表。";
    const document = { path: "Wiki/旧说明.md", domain: "研究", content,
      revision: sha256Hex(content), notDuplicates: [], outdatedHandled: false };
    const retained = { kind: "outdated", paths: [document.path], reason: "需要核对旧版申请表",
      evidence: [{ path: document.path, quote: content }] };
    let calls = 0;
    const partialDeep = new KnowledgeDeepCheckupTaskService({
      assertModel: () => {}, documents: async () => [document], read: async () => document,
      load: async () => null, save: async () => {}, generate: async () => {
        calls++;
        return JSON.stringify([retained, { ...retained, evidence: [] }]);
      },
    });
    await partialDeep.start();
    while ((await partialDeep.snapshot()).status === "running") await tick();
    assert.equal(calls, 2, "The mixed response exhausts its one automatic retry");
    assert.equal((await partialDeep.snapshot()).status, "interrupted");
    const partialHost = win.document.createElement("main");
    const partialPanel = new KnowledgeCheckupPanel(partialHost, {
      ...plugin,
      getKnowledgeSurfaceService: () => ({ ...service,
        checkup: { ...service.checkup, deep: partialDeep } }),
    }, () => {}, () => {});
    await partialPanel.refresh();
    assert.equal(partialHost.querySelectorAll(".knowledge-checkup-row").length, 1,
      "The same interrupted page displays its valid retained finding, rather than an empty page");
    assert.ok(partialHost.textContent!.includes("旧说明"));
    const repair = partialHost.querySelector('[data-checkup-action="preview"]') as HTMLButtonElement;
    assert.equal(repair.disabled, false);
    repair.click();
    await tick();
    assert.equal(selected[0].action, "verify", "The retained finding still reaches the existing repair preview");
    const priorConfirms = confirms;
    (partialHost.querySelector('[data-checkup-action="confirm"]') as HTMLButtonElement).click();
    await tick();
    assert.equal(confirms, priorConfirms + 1);
    assert.ok(partialHost.querySelector(".knowledge-checkup-success"));
    partialPanel.dispose();
    await partialDeep.dispose();
    console.log(
      "PASS checkup layout: defaults, multi-target selection, partial select, cross-category retention, read-only quotes, preview/confirm and honest grouped receipt.",
    );
  } finally {
    panel.dispose();
    dom.window.close();
  }
}

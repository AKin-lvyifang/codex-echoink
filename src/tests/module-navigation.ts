import assert from "node:assert/strict";
import { Platform, WorkspaceLeaf, openTestNoticeMessages } from "./obsidian-shim";
import { defaultAgentRegistry } from "../agents/registry";
import { defaultTaskWorkspace } from "../agents/task-workspace";
import { TaskNavigationState } from "../ui/codex-view/task-navigation-state";
import { openWorkbenchModule, prefillWorkbenchModule, workbenchModuleOwner } from "../home/module-navigation";
import { EchoInkViewService } from "../plugin/view-service";
import { EchoInkJournalView, VIEW_TYPE_ECHOINK_JOURNAL } from "../home/journal-page";
import { LifestyleView } from "../lifestyle/view";
import { FinanceWorkspace } from "../lifestyle/finance-view";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { EMPTY_LIFESTYLE_DATA } from "../lifestyle/store-core";
import { paidTestAccess } from "./membership-access";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const button = (root: HTMLElement, selector: string): HTMLButtonElement => {
  const value = root.querySelector<HTMLButtonElement>(selector); assert.ok(value, selector); return value;
};

function handoffHost() {
  const registry = defaultAgentRegistry();
  registry.agents.push({ ...structuredClone(registry.agents[0]), id: "finance-owner", name: "财务同事" });
  const workspace = defaultTaskWorkspace();
  const navigation = new TaskNavigationState(() => workspace);
  const calls: unknown[][] = [];
  const forbidden = (name: string) => () => { throw new Error(`navigation invoked ${name}`); };
  const plugin: any = {
    settings: { agentRegistry: registry, taskWorkspace: workspace },
    async openAgentTaskList(agentId: string, text?: string) {
      calls.push([agentId, text]); navigation.navigate({ kind: "list", agentId });
      return text === undefined || navigation.prefill(agentId, text);
    },
    createPiConversation: forbidden("create"), submitPiTurn: forbidden("send"),
    ensurePiRuntimeBundle: forbidden("Provider"), resumeTaskAndOpenDetail: forbidden("run")
  };
  plugin.getWorkbenchModuleOwner = (id: any) => workbenchModuleOwner(plugin, id);
  plugin.prefillWorkbenchModule = (id: any, text: string) => prefillWorkbenchModule(plugin, id, text);
  return { plugin, registry, workspace, navigation, calls };
}

async function ownerAndDraftBoundary() {
  const f = handoffHost();
  f.registry.moduleOwners.finance = "finance-owner";
  assert.equal(await prefillWorkbenchModule(f.plugin, "finance", "核对本月"), true);
  assert.deepEqual(f.workspace.page, { kind: "list", agentId: "finance-owner" });
  assert.equal(f.navigation.draft().text, "核对本月", "real task workspace receives the prefill");
  // P3 owns the full text/attachment/mention/Skill matrix. This tests the new
  // module entry against that real draft boundary, rather than a list-call spy.
  f.navigation.save({ text: "尚未发送的原内容", attachments: [{ type: "file", name: "合成.md", path: "合成.md" }],
    noteMentions: [{ vaultRelativePath: "引用.md", fileName: "引用.md" }] });
  const before = structuredClone(f.navigation.draft());
  assert.equal(await prefillWorkbenchModule(f.plugin, "finance", "新的财务问题"), false);
  assert.deepEqual(f.navigation.draft(), before);
  f.registry.moduleOwners.finance = "sol";
  assert.equal(await prefillWorkbenchModule(f.plugin, "finance", "新负责人"), true);
  assert.equal(f.calls.at(-1)?.[0], "sol");
  f.registry.moduleOwners.finance = "finance-owner";
  f.registry.agents = f.registry.agents.filter(agent => agent.id !== "finance-owner");
  assert.equal(workbenchModuleOwner(f.plugin, "finance").id, "sol");
  await prefillWorkbenchModule(f.plugin, "finance", "失效负责人");
  assert.equal(f.calls.at(-1)?.[0], "sol");
  assert.equal(f.workspace.replyDrafts && Object.keys(f.workspace.replyDrafts).length, 0);
  console.log("PASS module handoff: latest registry, deleted-owner Sol fallback, real draft preservation, no execution");
}

async function financeHeader() {
  const f = handoffHost();
  f.registry.moduleOwners.finance = "finance-owner";
  const lifestyle = structuredClone(DEFAULT_LIFESTYLE_SETTINGS);
  lifestyle.finance.enabled = true; lifestyle.finance.aiEnabled = false;
  f.plugin.settings.lifestyle = lifestyle;
  let settingsOpens = 0, backs = 0, registered = 0, subscriptions = 0;
  const subscribe = () => { subscriptions++; return () => { subscriptions--; }; };
  f.plugin.openLifestyleSettings = async (kind: string) => { assert.equal(kind, "finance"); settingsOpens++; };
  f.plugin.activateHomeView = async (options: unknown) => { assert.deepEqual(options, { keepRightSidebar: true }); backs++; };
  const service: any = {
    plugin: f.plugin, store: { snapshot: () => structuredClone(EMPTY_LIFESTYLE_DATA), subscribe },
    finance: { subscribe, subscribeEntries: subscribe, access: { ...paidTestAccess, subscribe },
      entries: () => [], issues: () => [], goals: () => [],
      monthlyPlan: (month: string) => ({ month, dailyLimitCents: null, goals: [] }),
      accessState: () => ({ canEnter: true, canToggle: true, canWrite: true, reason: null }) },
    registerView() { registered++; }, unregisterView() { registered--; }
  };
  const view = new LifestyleView(new WorkspaceLeaf(), service, "finance");
  const content = document.body.createDiv(); Object.assign(view, { contentEl: content });
  const finance = (view as unknown as { financeWorkspace: FinanceWorkspace }).financeWorkspace;
  await view.onOpen();
  try {
    assert.equal(registered, 1);
    const header = content.querySelector<HTMLElement>(".echoink-life-header")!;
    button(header, '[aria-label="返回工作台"]').click();
    [...header.querySelectorAll("button")].find(item => item.textContent === "设置")!.click();
    await tick(); assert.deepEqual([backs, settingsOpens], [1, 1]);
    assert.deepEqual([...content.querySelectorAll('[role="tab"]')].map(item => item.children[1]?.textContent),
      ["财务总览", "收支明细", "月度预算", "账单计划"]);
    // Change the actual workspace through its rendered month controls. Do not
    // stub getSelectedMonth or supply a made-up header month.
    const initial = finance.getSelectedMonth();
    const [year, month] = initial.split("-").map(Number);
    const delta = (2025 - year) * 12 + 2 - month;
    for (let i = 0; i < Math.abs(delta); i++) button(content, `[aria-label="${delta < 0 ? "上一个月" : "下一个月"}"]`).click();
    assert.equal(finance.getSelectedMonth(), "2025-02");
    f.registry.moduleOwners.finance = "sol"; f.registry.agents[0].name = "最新总助";
    let reject!: (error: Error) => void, attempts = 0;
    const actualPrefill = f.plugin.prefillWorkbenchModule;
    f.plugin.prefillWorkbenchModule = async (id: string, text: string) => {
      attempts++; await new Promise<void>((_resolve, fail) => { reject = fail; });
      return actualPrefill(id, text);
    };
    const action = button(content, ".echoink-module-handoff");
    action.click();
    assert.equal(action.textContent, "交给 最新总助");
    assert.equal(action.getAttribute("aria-busy"), "true");
    action.click(); assert.equal(attempts, 1, "pending navigation cannot be opened twice");
    reject(new Error("合成打开失败")); await tick();
    assert.equal(action.getAttribute("aria-busy"), "false"); assert.equal(action.disabled, false);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /合成打开失败/u);
    f.plugin.prefillWorkbenchModule = actualPrefill;
    action.click(); await tick();
    assert.deepEqual(f.calls.at(-1), ["sol", "帮我看看 2025-02 的收支和预算"]);
    assert.equal(f.navigation.draft().text, "帮我看看 2025-02 的收支和预算");
    f.registry.moduleOwners.finance = "deleted-owner";
    action.click(); await tick(); assert.equal(f.calls.at(-1)?.[0], "sol");
    (Platform as any).isDesktopApp = false;
    view.render();
    assert.equal(content.querySelector(".echoink-module-handoff"), null);
    assert.equal(content.querySelector(".echoink-module-back"), null);
    assert.ok([...content.querySelectorAll(".echoink-life-header button")].some(item => item.textContent === "设置"));
    assert.equal(content.querySelectorAll('[role="tab"]').length, 4);
  } finally { await view.onClose(); content.remove(); (Platform as any).isDesktopApp = true; }
  assert.equal(registered, 0); assert.equal(subscriptions, 0, "all real finance/view subscriptions release");
  console.log("PASS finance: actual LifestyleView header + FinanceWorkspace month, latest owner, pending/failure/retry, mobile header, four tabs, cleanup");
}

async function journalRouteAndReturn() {
  const f = handoffHost();
  const leaves: any[] = [], activated: any[] = [];
  let created = 0, refreshed = 0, sidebarCollapses = 0;
  const workbench = document.body.createDiv(); workbench.textContent = "existing workbench"; workbench.scrollTop = 243;
  const homeLeaf = { type: "echoink-home", view: { contentEl: workbench } }; leaves.push(homeLeaf);
  const plugin = f.plugin;
  plugin.app = { workspace: {
    getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.type === type),
    getLeaf: (kind: string) => {
      assert.equal(kind, "tab"); created++;
      const leaf: any = { async setViewState(state: any) {
        this.type = state.type; assert.equal(state.active, true);
        this.view = Object.create(EchoInkJournalView.prototype);
        Object.assign(this.view, { plugin, contentEl: document.body.createDiv(), refreshIfSettingsChanged: () => { refreshed++; } });
      } };
      leaves.push(leaf); return leaf;
    },
    setActiveLeaf: (leaf: any, options: unknown) => { assert.deepEqual(options, { focus: true }); activated.push(leaf); },
    leftSplit: { collapsed: true, collapse() { throw new Error("already collapsed"); } },
    rightSplit: { collapsed: false, collapse() { sidebarCollapses++; } }
  } };
  const service = new EchoInkViewService(plugin);
  plugin.activateJournalView = () => service.activateJournalView();
  plugin.activateHomeView = (options: any) => service.activateHomeView(options);
  await openWorkbenchModule(plugin, "journal");
  assert.equal(created, 1); assert.equal(activated.at(-1).type, VIEW_TYPE_ECHOINK_JOURNAL);
  const journal = activated.at(-1).view as EchoInkJournalView;
  const content = journal.contentEl;
  content.createDiv({ attr: { "data-journal": "header" } });
  (journal as any).renderHeader();
  button(content, '[aria-label="返回工作台"]').click(); await tick();
  assert.equal(activated.at(-1), homeLeaf); assert.equal(workbench.scrollTop, 243);
  assert.equal(sidebarCollapses, 0, "desktop page return preserves the task sidebar");
  await openWorkbenchModule(plugin, "journal");
  assert.equal(created, 1, "production route must reuse the existing journal leaf");
  assert.equal(activated.at(-1).view, journal); assert.equal(refreshed, 2);
  (Platform as any).isDesktopApp = false;
  await service.activateJournalView(); assert.equal(activated.at(-1), homeLeaf);
  (Platform as any).isDesktopApp = true;
  content.remove(); workbench.remove();
  console.log("PASS journal: production workbench route + ViewService, real page back button, leaf reuse, home position, mobile fallback");
}

export async function runModuleNavigationTests(): Promise<void> {
  const desktop = Platform.isDesktopApp; (Platform as any).isDesktopApp = true;
  try { await ownerAndDraftBoundary(); await financeHeader(); await journalRouteAndReturn(); }
  finally { (Platform as any).isDesktopApp = desktop; }
}

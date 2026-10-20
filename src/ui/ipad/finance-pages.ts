import { FinanceWorkspace } from "../../lifestyle/finance-view";
import type { LifestyleViewPort } from "../../lifestyle/host";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadPageContext } from "./workbench-contract";
import { createFinanceSettingsPage } from "./finance-forms";
import { el, moduleButton, moduleEmpty, moduleView, moduleText as t } from "./module-elements";

/** iPad owns the pane/header; the original financial UI owns the complete body. */
export function createFinancePage(ctx: IPadPageContext): MobileShellPage {
  const lifestyle = ctx.host.services.lifestyle, finance = lifestyle.finance;
  const view = moduleView(ctx, "module:finance", t(ctx, "财务", "Finance"), "finance"), workspace = new FinanceWorkspace(lifestyle);
  view.content.classList.add("pd-finance-page");
  const shell = el(ctx.document, "div", "echoink-life-shell echoink-life-finance pd-finance-workspace-shell"), body = el(ctx.document, "div", "echoink-life-body"); shell.append(body); view.body.append(shell);
  const settings = moduleButton(ctx, t(ctx, "设置", "Settings"), () => view.push(createFinanceSettingsPage(ctx)));
  const header = view.content.querySelector(".pd-module-header")!, handoff = header.querySelector(".is-primary");
  if (handoff) handoff.before(settings); else header.append(settings);
  let initialized = false, initializing = false, scheduled = false, released = false, waitingForAccess = false;
  const viewportClasses = new Map<HTMLElement, string[]>();
  const viewport = () => view.content.closest<HTMLElement>(".echoink-ipad-content") ?? view.content;
  const render = () => {
    if (!view.alive || released) return;
    const scroll = viewport();
    if (scroll !== view.content) view.content.classList.remove("echoink-lifestyle-view", "echoink-mobile-finance", "pd-finance-viewport");
    if (!viewportClasses.has(scroll)) viewportClasses.set(scroll, ["echoink-lifestyle-view", "echoink-mobile-finance", "pd-finance-viewport"].filter(name => !scroll.classList.contains(name)));
    scroll.classList.add("echoink-lifestyle-view", "echoink-mobile-finance", "pd-finance-viewport");
    const top = scroll.scrollTop, policy = finance.accessState();
    workspace.detach(); body.replaceChildren(); view.status("");
    if (!lifestyle.plugin.settings.lifestyle.finance.enabled) moduleEmpty(ctx, body, t(ctx, "财务插件已关闭", "Finance is disabled"));
    else if (!policy.canEnter) view.report(policy.reason ?? t(ctx, "需要有效 PRO", "An active PRO membership is required"));
    else if (!initialized) moduleEmpty(ctx, body, t(ctx, "正在加载…", "Loading…"));
    else { if (policy.reason) view.status(policy.reason); workspace.render(body); }
    scroll.scrollTop = top;
  };
  const schedule = () => {
    if (scheduled || !view.alive || released) return;
    if (waitingForAccess && lifestyle.plugin.settings.lifestyle.finance.enabled && finance.accessState().canEnter) { waitingForAccess = false; void initialize(); }
    scheduled = true;
    void Promise.resolve().then(() => { scheduled = false; render(); }).catch(ctx.error);
  };
  const release = () => {
    if (released) return;
    released = true; workspace.close(viewport().scrollTop); lifestyle.unregisterView(port);
    for (const [node, classes] of viewportClasses) node.classList.remove(...classes);
    viewportClasses.clear(); view.page.dispose?.();
  };
  const port: LifestyleViewPort = { get contentEl() { return viewport(); }, render: schedule, releaseResources: release };
  lifestyle.registerView(port);
  view.cleanup(release);
  view.cleanup(lifestyle.store.subscribe(schedule)); view.cleanup(finance.subscribeEntries(schedule)); view.cleanup(finance.access.subscribe(schedule));
  async function initialize(): Promise<void> {
    if (!view.alive || released || initialized || initializing) return;
    if (!lifestyle.plugin.settings.lifestyle.finance.enabled || !finance.accessState().canEnter) { waitingForAccess = true; render(); return; }
    initializing = true;
    try { await lifestyle.initialize(); await finance.initialize(); initialized = true; render(); }
    catch (error) { if (view.alive && !released) { workspace.detach(); body.replaceChildren(); view.report(error); body.append(moduleButton(ctx, t(ctx, "重试", "Retry"), initialize)); } }
    finally { initializing = false; }
  }
  render(); void Promise.resolve().then(initialize); return view.finish();
}

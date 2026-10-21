import { FinanceWorkspace } from "../../lifestyle/finance-view";
import type { LifestyleViewPort } from "../../lifestyle/host";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneAvatar, iphoneElement as el } from "./workbench-elements";
import { IPhoneModulePage, moduleText } from "./module-elements";
import { openIPhoneFinanceSettings } from "./finance-settings-pages";

/** The original finance workspace in a retained, iPhone-owned navigation page. */
export async function openIPhoneFinance(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-module-finance";
  if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const lifestyle = ctx.host.services.lifestyle, finance = lifestyle.finance;
  const view = new IPhoneModulePage(ctx, id, "财务"), workspace = new FinanceWorkspace(lifestyle);
  view.content.classList.add("ip-finance-page");
  const shell = el(ctx.document, "div", "echoink-life-shell echoink-life-finance ip-finance-workspace-shell");
  const body = el(ctx.document, "div", "echoink-life-body"); shell.append(body); view.body.append(shell);
  const actions = el(ctx.document, "div", "ip-module-header-actions ip-finance-header-actions"); view.page.actions = actions;
  view.button(actions, moduleText(ctx, "设置", "Settings"), () => view.child(() => openIPhoneFinanceSettings(ctx)));
  const handoff = view.button(actions, "", () => send(false), true);
  const ownerLabel = () => {
    if (!view.alive) return;
    const owner = ctx.host.services.modules.owner("finance");
    handoff.querySelector(".ip-button-visible")?.replaceChildren(iphoneAvatar(ctx.document, owner), el(ctx.document, "span", "", moduleText(ctx, `交给${owner.name.trim()}`, `Ask ${owner.name}`)));
  };
  ownerLabel(); view.cleanup(ctx.host.workbench.subscribe(ownerLabel));
  async function send(replaceDraft: boolean): Promise<void> {
    await view.run(async () => {
      const result = await ctx.host.services.modules.handoff("finance", `帮我看看 ${workspace.getSelectedMonth()} 的收支和预算`, replaceDraft);
      if (!view.alive) return;
      if (result.conflict) view.confirm(view.content, "已有未发送的内容，是否替换？", "替换草稿", () => send(true));
      else { view.allow(); view.busy = false; await ctx.navigate({ kind: "agent", agentId: result.agentId }); }
    });
  }

  let initialized = false, initializing = false, scheduled = false, released = false, waitingForAccess = false;
  const viewportClasses = new Map<HTMLElement, string[]>();
  const viewport = () => view.content.closest<HTMLElement>(".eis-scroll") ?? view.content;
  const render = () => {
    if (!view.alive || released) return;
    const scroll = viewport();
    if (scroll !== view.content) view.content.classList.remove("echoink-lifestyle-view", "echoink-mobile-finance", "ip-finance-viewport");
    if (!viewportClasses.has(scroll)) viewportClasses.set(scroll, ["echoink-lifestyle-view", "echoink-mobile-finance", "ip-finance-viewport"].filter(name => !scroll.classList.contains(name)));
    scroll.classList.add("echoink-lifestyle-view", "echoink-mobile-finance", "ip-finance-viewport");
    const top = scroll.scrollTop, policy = finance.accessState();
    workspace.detach(); body.replaceChildren(); view.error.show();
    if (!lifestyle.plugin.settings.lifestyle.finance.enabled) view.empty(body, "财务插件已关闭");
    else if (!policy.canEnter) view.error.show(policy.reason ?? "需要有效 PRO");
    else if (!initialized) view.empty(body, "正在加载…");
    else { if (policy.reason) view.error.show(policy.reason); workspace.render(body); }
    scroll.scrollTop = top;
  };
  // Notifications from initialization and saves only redraw; they never initialize again.
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
    try { await lifestyle.initialize(); await finance.initialize(); initialized = true; if (view.alive) render(); }
    catch (error) { if (view.alive && !released) { workspace.detach(); body.replaceChildren(); view.error.show(error); view.button(body, "重试", initialize); } }
    finally { initializing = false; }
  }
  render(); await view.push(); if (view.alive) await initialize();
}

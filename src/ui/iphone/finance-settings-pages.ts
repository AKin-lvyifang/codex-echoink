import type { FinanceMerchantSetting, FinanceAccountSetting, FinanceCategorySetting } from "../../lifestyle/settings";
import { DEFAULT_FINANCE_CATEGORIES } from "../../lifestyle/settings";
import { setMobileModuleEnabled } from "../../mobile/module-settings";
import { settingsCheck, settingsRow, settingsSwitch } from "./settings-elements";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneElement as el } from "./workbench-elements";
import { IPhoneModulePage, moduleText } from "./module-elements";
import { financeIconField } from "./finance-forms";
type Catalog = "merchants" | "accounts" | "categories";
const labels: Record<Catalog, string> = { merchants: "商户管理", accounts: "账户管理", categories: "分类管理" };

export async function openIPhoneFinanceSettings(ctx: IPhonePageContext, catalog?: Catalog): Promise<void> {
  if (catalog) return openCatalog(ctx, catalog);
  const id = "iphone-settings-finance"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, "财务设置"), service = ctx.host.services.modules.finance.service;
  const saveOption = async (key: "aiEnabled" | "importAiEnabled" | "showOnHome", value: boolean) => { await view.run(async () => { await service.saveOption(key, value); }); render(); };
  const render = () => {
    if (!view.alive) return; view.body.replaceChildren(); const settings = ctx.host.settings().lifestyle.finance, group = view.group();
    settingsSwitch(ctx, group, "启用财务", () => ctx.host.settings().lifestyle.finance.enabled, async value => { await setMobileModuleEnabled(ctx.host, "finance", value); render(); });
    if (settings.enabled) {
      settingsCheck(ctx, group, "AI 分析", settings.aiEnabled, value => { void saveOption("aiEnabled", value); });
      settingsCheck(ctx, group, "导入时智能整理", settings.importAiEnabled, value => { void saveOption("importAiEnabled", value); });
      settingsCheck(ctx, group, "在首页显示", ctx.host.settings().homeModules.finance !== false, value => { void saveOption("showOnHome", value); });
    }
    settingsRow(ctx, group, "分析保存位置", { value: settings.analysisDirectory || "未设置", literalValue: !!settings.analysisDirectory, action: () => openAnalysisLocation() });
    const directory = view.group("目录"); for (const key of ["merchants", "accounts", "categories"] as const) settingsRow(ctx, directory, labels[key], { action: () => openCatalog(ctx, key) });
  };
  const openAnalysisLocation = async () => {
    const form = new IPhoneModulePage(ctx, "iphone-finance-analysis-location", "分析保存位置");
    let path = ctx.host.settings().lifestyle.finance.analysisDirectory ?? "", original = path;
    form.dirty = () => path !== original; form.field(form.group(), "文件夹", path, value => { path = value; });
    form.button(form.footer, "取消", () => ctx.shell.back().then(() => {}));
    form.button(form.footer, "保存", async () => { if (await form.run(async () => { await service.saveAnalysisDirectory(path); original = path; render(); })) { form.allow(); await ctx.shell.back(); } }, true);
    await form.push();
  }; render(); await view.push();
}
async function openCatalog(ctx: IPhonePageContext, kind: Catalog): Promise<void> {
  const id = `iphone-finance-catalog-${kind}`; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, labels[kind]), service = ctx.host.services.modules.finance.service;
  const render = () => { if (!view.alive) return; view.body.replaceChildren(); const group = view.group(), items = ctx.host.settings().lifestyle.finance[kind];
    for (const item of items) {
      const row = el(ctx.document, "div", "ip-module-catalog-row"); group.append(row);
      settingsRow(ctx, row, item.name, { literal: true, action: () => editCatalog(ctx, kind, item.name, render) }).classList.add("ip-module-catalog-main");
      settingsCheck(ctx, row, "启用", item.active, checked => { void view.run(async () => { await persistCatalog(ctx, kind, item.name, { ...item, active: checked }); }).then(render); });
      const remove = view.button(row, "删除", () => view.confirm(view.content, "删除这个目录项？已有账目和预算会保留。", "删除", async () => { await view.run(async () => { await persistCatalog(ctx, kind, item.name, null); render(); }); }, true)); remove.classList.add("is-danger");
    }
    if (!items.length) view.empty(group, "还没有目录项"); settingsRow(ctx, group, "添加", { action: () => editCatalog(ctx, kind, undefined, render) });
  }; view.cleanup(service.subscribe(() => { if (!view.busy) render(); })); render(); await view.push();
}
async function persistCatalog(ctx: IPhonePageContext, kind: Catalog, original: string | undefined, next: FinanceMerchantSetting | FinanceAccountSetting | FinanceCategorySetting | null): Promise<void> {
  const service = ctx.host.services.modules.finance.service, settings = ctx.host.settings().lifestyle.finance;
  if (kind === "merchants") { const current = settings.merchants; const values = current.filter(item => item.name !== original); if (next) values.push({ ...(current.find(item => item.name === original) ?? {}), ...next } as FinanceMerchantSetting); await service.saveCatalog("merchants", values); }
  else if (kind === "accounts") { const current = settings.accounts; const values = current.filter(item => item.name !== original); if (next) values.push({ ...(current.find(item => item.name === original) ?? {}), ...next } as FinanceAccountSetting); await service.saveCatalog("accounts", values); }
  else { const current = settings.categories; const values = current.filter(item => item.name !== original); if (next) values.push({ ...(current.find(item => item.name === original) ?? {}), ...next } as FinanceCategorySetting); await service.saveCatalog("categories", values); }
}
async function editCatalog(ctx: IPhonePageContext, kind: Catalog, name: string | undefined, saved: () => void): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-catalog-form-${kind}-${name ?? "new"}`, name ? "编辑目录项" : "新增目录项"), existing = ctx.host.settings().lifestyle.finance[kind].find(item => item.name === name);
  const draft = { name: existing?.name ?? "", active: existing?.active ?? true, aliases: existing && "aliases" in existing ? existing.aliases.join("，") : "", icon: existing && "iconId" in existing ? existing.iconId : existing && "icon" in existing ? existing.icon : kind === "categories" ? "package" : "auto", category: existing && "defaultCategory" in existing ? existing.defaultCategory : "", color: existing && "color" in existing ? existing.color : DEFAULT_FINANCE_CATEGORIES[0].color }, baseline = JSON.stringify(draft); view.dirty = () => JSON.stringify(draft) !== baseline;
  view.field(view.body, "名称", draft.name, value => { draft.name = value; }).maxLength = 60; settingsCheck(ctx, view.body, "启用", draft.active, value => { draft.active = value; view.changed(); });
  if (kind !== "categories") view.field(view.body, "别名（用逗号分隔）", draft.aliases, value => { draft.aliases = value; });
  if (kind !== "accounts") financeIconField(view, view.body, kind === "merchants" ? "merchant" : "category", draft.icon, value => { draft.icon = value; });
  if (kind === "merchants") view.select(view.body, "默认分类", [["", moduleText(ctx, "不预设")], ...ctx.host.settings().lifestyle.finance.categories.filter(item => item.active).map(item => [item.name, item.name] as const)], draft.category, value => { draft.category = value; });
  if (kind === "categories") view.field(view.body, "分类颜色", draft.color, value => { draft.color = value; }, "color");
  view.button(view.footer, "取消", async () => { view.allow(); await ctx.shell.back(); }); view.button(view.footer, "保存", async () => { const success = await view.run(async () => {
    const current: readonly (FinanceMerchantSetting | FinanceAccountSetting | FinanceCategorySetting)[] = ctx.host.settings().lifestyle.finance[kind];
    if (!draft.name.trim()) throw new Error(moduleText(ctx, "请填写名称。")); if (current.some(item => item.name !== name && item.name.toLowerCase() === draft.name.trim().toLowerCase())) throw new Error(moduleText(ctx, "名称已经存在。"));
    const shared = { name: draft.name.trim(), active: draft.active }, aliases = [...new Set(draft.aliases.split(/[,，、\n]/u).map(value => value.trim()).filter(Boolean))];
    const next = kind === "merchants" ? { ...shared, aliases, iconId: draft.icon, defaultCategory: draft.category } : kind === "accounts" ? { ...shared, aliases } : { ...shared, icon: draft.icon, color: draft.color };
    await persistCatalog(ctx, kind, name, next); saved();
  }); if (success) { view.allow(); await ctx.shell.back(); } }, true); await view.push();
}

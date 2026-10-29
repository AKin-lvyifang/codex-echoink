import type { FinanceImportRow, FinanceImportSource } from "../../lifestyle/finance-domain";
import type { FinanceImportResult } from "../../lifestyle/finance-ledger";
import type { FinanceOrganizationResult } from "../../lifestyle/finance-import";
import { formatMobileDateTime } from "../../mobile/date-display";
import type { IPadPageContext } from "./workbench-contract";
import type { MobileShellPage } from "../mobile/shell-types";
import { el, moduleActions, moduleButton, moduleEmpty, moduleField, moduleSelect, moduleView, moduleText as t } from "./module-elements";

export function createFinanceImportPage(ctx: IPadPageContext): MobileShellPage {
  const port = ctx.host.services.modules.finance, service = port.service, v = moduleView(ctx, "ipad-finance-import", t(ctx, "导入账单", "Import bills"));
  let source: FinanceImportSource = "wechat", rows: FinanceImportRow[] = [], result: FinanceImportResult | undefined, organized: FinanceOrganizationResult | undefined, controller: AbortController | undefined, generation = 0;
  const selection = moduleSelect(ctx, v.body, t(ctx, "账单来源", "Bill source"), [["wechat", t(ctx, "微信", "WeChat")], ["alipay", t(ctx, "支付宝", "Alipay")]], source, value => { source = value as FinanceImportSource; rows = []; result = undefined; organized = undefined; generation++; preview.replaceChildren(); update(); });
  const fileArea = el(ctx.document, "label", "pd-module-field"), file = el(ctx.document, "input", "pd-module-input"); file.type = "file"; file.accept = ".csv,.xlsx"; file.setAttribute("aria-label", t(ctx, "选择账单文件", "Choose a bill file")); fileArea.append(el(ctx.document, "span", "", t(ctx, "选择账单文件", "Choose a bill file")), file); v.body.append(fileArea);
  const preview = el(ctx.document, "div", "pd-finance-import-preview"), actions = moduleActions(ctx, v.body), progress = el(ctx.document, "div", "pd-module-secondary"); progress.setAttribute("role", "status"); v.body.append(progress, preview);
  const read = async () => {
    const selected = file.files?.[0]; if (!selected || v.busy) return; const ticket = ++generation, chosenSource = source;
    await v.run(async () => { const parsed = await port.readBill(new Uint8Array(await selected.arrayBuffer()), selected.name, chosenSource); if (!v.alive || ticket !== generation) return; rows = parsed; result = undefined; organized = undefined; render(); }); update();
  };
  file.addEventListener("change", () => { void read(); });
  const importButton = moduleButton(ctx, t(ctx, "确认导入", "Confirm import"), async () => {
    if (!rows.length || result) return; controller = new AbortController(); const signal = controller.signal;
    await v.run(async () => {
      result = await service.confirmImport(rows, { signal, onSaved: () => { if (v.alive) progress.textContent = t(ctx, "基础账目正在保存…", "Saving transactions…"); } });
      if (!v.alive) return; render(); if (signal.aborted) throw new Error(t(ctx, "导入已取消，已保存的记录保留。", "Import cancelled. Saved transactions remain."));
      if (result.writeError) throw new Error(result.writeError);
      if (!result.created.length) { const completed = await service.completeImport(result, { signal }); progress.textContent = completed ? t(ctx, "导入完成", "Import complete") : t(ctx, "导入未完整完成，请核对结果。", "Import is incomplete. Review the result."); return; }
      organized = await service.prepareImport(result.created, signal, (done, total) => { if (v.alive) progress.textContent = `${done}/${total}`; });
      if (!v.alive || signal.aborted) return; render(); progress.textContent = organized.warnings.join("\n");
    }); update();
  }, true);
  const apply = moduleButton(ctx, t(ctx, "应用整理并完成", "Apply suggestions and finish"), async () => {
    if (!result || !organized || !controller || controller.signal.aborted) return; const signal = controller.signal;
    await v.run(async () => {
      const suggestions = await service.applyImportSuggestions(result!.created, organized!.rows, signal);
      await service.finalizeImportedAccounts(new Set(result!.created.map(item => item.entry.id)));
      const completed = await service.completeImport(result!, { signal, organization: organized!, suggestions });
      if (v.alive) { progress.textContent = completed ? t(ctx, "导入完成", "Import complete") : t(ctx, "基础账目已保存，部分整理未完成。", "Transactions saved; some suggestions remain incomplete."); organized = undefined; render(); }
    }); update();
  }, true); actions.append(importButton, apply);
  const footer = el(ctx.document, "div", "pd-module-actions"), stop = moduleButton(ctx, t(ctx, "停止导入", "Stop import"), () => { controller?.abort(); }); footer.append(stop); v.page.footer = footer;
  v.onBusy = () => update();
  function update(): void { if (!v.alive) return; importButton.disabled = v.busy || !rows.some(row => row.entry) || !!result || service.previewImport(rows).pending.length > 0; importButton.hidden = !!result; apply.hidden = !organized; apply.disabled = v.busy || controller?.signal.aborted === true; stop.hidden = !v.busy || !controller; file.disabled = selection.disabled = v.busy || !!result; }
  function render(): void {
    preview.replaceChildren();
    if (result) preview.append(el(ctx.document, "div", "pd-module-import-result", t(ctx, `新增 ${result.added} · 更新 ${result.updated} · 重复 ${result.duplicates} · 保留关联 ${result.linked ?? 0} · 无效 ${result.invalid}`, `Added ${result.added} · Updated ${result.updated} · Duplicates ${result.duplicates} · Linked ${result.linked ?? 0} · Invalid ${result.invalid}`)));
    const classification = !result ? service.previewImport(rows) : undefined;
    if (classification?.linked.length) preview.append(el(ctx.document, "div", "pd-module-secondary", t(ctx, `${classification.linked.length} 笔与日记账目一致，将保留关联`, `${classification.linked.length} transactions match diary records and will be linked`)));
    const showing = organized?.rows ?? rows;
    if (!showing.length) moduleEmpty(ctx, preview, t(ctx, "请选择实际账单文件", "Choose a bill file"));
    for (const row of showing) {
      const item = el(ctx.document, "div", "pd-finance-import-row");
      if (!row.entry) item.append(el(ctx.document, "div", "pd-module-error", row.error));
      else {
        item.append(el(ctx.document, "div", "", `${formatMobileDateTime(row.entry.date, Date.now(), ctx.host.settings().settingsLanguage)} · ${row.entry.merchant} · ${(row.entry.amountCents / 100).toFixed(2)}`));
        const pending = classification?.pending.find(pending => pending.row.entry?.source === row.entry?.source && pending.row.entry?.sourceId === row.entry?.sourceId);
        if (pending) moduleSelect(ctx, item, t(ctx, "可能已从日记记过", "Possible diary duplicate"), [["", t(ctx, "待确认，暂不导入", "Review before importing")], ...pending.candidates.map(candidate => [candidate.id,
          t(ctx, "同一笔：", "Same transaction: ") + `${candidate.date.slice(0, 10)} · ${candidate.merchant} · ${candidate.description || candidate.note || candidate.category} · ${(candidate.amountCents / 100).toFixed(2)}`] as const), ["__separate__", t(ctx, "另一笔，新增账目", "Separate transaction, add entry")]], "", value => {
          row.duplicateDecision = value === "__separate__" ? { action: "separate", candidateIds: pending.candidates.map(candidate => candidate.id) } : value ? { action: "same", id: value } : undefined;
          render();
        });
        if (organized) {
          moduleField(ctx, item, t(ctx, "商户", "Merchant"), row.entry.merchant, value => { row.entry!.merchant = value; });
          moduleField(ctx, item, t(ctx, "账户", "Account"), row.entry.account, value => { row.entry!.account = value; });
          moduleSelect(ctx, item, t(ctx, "分类", "Category"), ctx.host.settings().lifestyle.finance.categories.filter(category => category.active).map(category => [category.name, category.name] as const), row.entry.category, value => { row.entry!.category = value; });
        }
        if (row.review || row.reason) item.append(el(ctx.document, "div", "pd-module-secondary", [row.review, row.reason].filter(Boolean).join(" · ")));
      } preview.append(item);
    } update();
  }
  v.cleanup(() => { generation++; controller?.abort(); }); render(); return v.finish();
}

import type { MobileServices } from "../../src/mobile/services";

/** Browser-only synthetic ledger. It never reads a device or filesystem Vault. */
export async function seedFinancePreview(services: MobileServices): Promise<void> {
  const service = services.lifestyle.finance;
  await service.initialize();
  const now = new Date(), month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  await service.saveBudgetChanges({ defaultBudget: { totalCents: 500000, allocations: { "餐饮": 80000, "购物": 100000, "交通": 30000 } }, overrides: [], removedMonths: [] });
  await service.saveBillPlan({ id: "finance-preview-plan", name: "测试：设备添置", budgetCents: 800000 });
  for (let index = 0; index < 24; index++) {
    const category = ["餐饮", "购物", "交通"][index % 3];
    await service.addManual({ date: `${month}-${String(index % Math.max(1, now.getDate()) + 1).padStart(2, "0")} 10:00:00`, merchant: `测试${category}${index + 1}`, category, kind: "expense", amountCents: 1000 + index * 123, status: "completed", account: "测试账户", description: "财务预览合成账目", currency: "CNY", note: "仅浏览器测试数据", ...(index < 3 ? { billPlanId: "finance-preview-plan" } : {}) });
  }
  const snapshot = await services.agents.snapshot();
  await services.agents.update(registry => { if (registry.agents.some(agent => agent.id === "finance")) registry.moduleOwners.finance = "finance"; }, snapshot.version);
}

import { defaultJournalTemplateChoice } from "../../src/home/home-workbench-data";
import { QUICK_JOURNAL_TEMPLATE, readNativeJournalSettings } from "../../src/home/native-journal";
import type { MobileServices } from "../../src/mobile/services";
import type { MobileSettings } from "../../src/mobile/settings";

/** Explicit synthetic browser fixtures, produced through the real domain writes. */
export async function seedMobileModuleFixture(host: { app: any }, settings: MobileSettings, services: MobileServices): Promise<void> {
  host.app.internalPlugins = { plugins: {
    "daily-notes": { enabled: true, instance: { options: { folder: "journal", format: "YYYY-MM-DD" } } },
    templates: { enabled: true, instance: { options: { folder: "templates" } } }
  } };
  settings.journalDirectory = "journal";
  settings.lifestyle.finance.enabled = true;
  const journal = readNativeJournalSettings(host.app, settings.journalDirectory, settings.knowledgeBase.folderBindings);
  if (journal.template) {
    const parent = journal.template.slice(0, journal.template.lastIndexOf("/"));
    if (parent) await host.app.vault.createFolder(parent);
    await host.app.vault.create(journal.template, QUICK_JOURNAL_TEMPLATE);
  }
  for (const days of [0, 1, 3, 30, 400]) {
    const day = new Date(); day.setDate(day.getDate() - days);
    await services.modules.journal.create(day, defaultJournalTemplateChoice());
  }
  for (const [index, title] of ["测试：核对移动设置", "测试：整理资料", "测试：回读已完成事项"].entries()) {
    const snapshot = await services.modules.todos.read();
    const due = new Date(); due.setDate(due.getDate() + index);
    const date = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
    await services.modules.todos.add({ title, categoryName: index ? "测试工作" : "测试生活", dueDate: date, dueTime: "09:00" }, snapshot.contentVersion);
  }
  const todos = await services.modules.todos.read();
  await services.modules.todos.toggle(todos.records.at(-1)!, true, todos.contentVersion);
  const finance = services.modules.finance.service;
  const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  for (const entry of [
    { kind: "expense" as const, amountCents: 2350, merchant: "测试餐馆", category: "餐饮", account: "测试账户", description: "合成测试午餐" },
    { kind: "income" as const, amountCents: 50000, merchant: "测试收入", category: "其他收入", account: "测试账户", description: "合成测试收入" }
  ]) await finance.addManual({ ...entry, date, status: "completed", currency: "CNY", note: "仅浏览器合成测试" });
}

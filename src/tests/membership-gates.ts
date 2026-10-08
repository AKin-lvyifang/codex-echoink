import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LifestyleFinanceService } from "../lifestyle/finance-service";
import { LifestyleService } from "../lifestyle/service";
import { EnglishDiaryController } from "../english-diary/controller";
import { TFile } from "obsidian";
import { LifestyleStore } from "../lifestyle/store";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { FakeVault } from "./lifestyle-finance-ledger";
import { EnglishDiaryRepository } from "../english-diary/repository";
import { EnglishDiaryService } from "../english-diary/service";
import { fingerprint } from "../english-diary/model";
import type { DiaryFilePort, DiarySource } from "../english-diary/types";
import type { CapabilityAccess } from "../membership/types";
import { getProPluginAccess } from "../membership/access";
import { runMembershipAccountServiceTests } from "./membership-account-service";

export async function runMembershipGateTests() {
  await runMembershipAccountServiceTests();
  let paid = false,
    modelCalls = 0;
  let deniedCapability = "";
  const access: CapabilityAccess = {
    checkCapability: capability => paid && capability !== deniedCapability,
    requireCapability: capability => {
      if (!paid || capability === deniedCapability) throw new Error("PRO_REQUIRED");
    },
    subscribe: () => () => {},
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "echoink-gates-"));
  try {
    const store = new LifestyleStore(path.join(directory, "store.json"));
    await store.initialize();
    const vault = new FakeVault();
    const plugin = {
      app: {
        vault,
        fileManager: {
          processFrontMatter: vault.processFrontMatter.bind(vault),
          renameFile: vault.rename.bind(vault),
        },
      },
      settings: { lifestyle: structuredClone(DEFAULT_LIFESTYLE_SETTINGS) },
      saveSettings: async (_immediate?: boolean) => { if (saveFailure) throw new Error("SAVE_FAILED"); saves++; },
      registerEvent() {},
      generateLifestyleText: async () => {
        modelCalls++;
        return "";
      },
    };
    let saves = 0, saveFailure = false;
    plugin.settings.lifestyle.finance.enabled = true;
    plugin.settings.lifestyle.finance.aiEnabled = true;
    const finance = new LifestyleFinanceService(
      { store, plugin, refresh() {} } as unknown as LifestyleService,
      access,
    );
    await finance.initialize();
    const lifestyle = Object.assign(Object.create(LifestyleService.prototype), { plugin, finance });
    await assert.rejects(lifestyle.setEnabled("finance", false), /PRO_REQUIRED/);
    assert.equal(plugin.settings.lifestyle.finance.enabled, true, "no PRO cannot switch an enabled plugin off");
    const diarySettings = { enabled: true };
    let sourceWrites = 0, libraryOpens = 0, diaryOpens = 0;
    let existingDiary: TFile | null = null;
    const controller = Object.assign(Object.create(EnglishDiaryController.prototype), {
      api: { access }, plugin: { settings: { englishDiary: diarySettings }, app: { vault: {
        getAllLoadedFiles: () => [], getAbstractFileByPath: () => existingDiary, getMarkdownFiles: () => [],
        create: () => { sourceWrites++; }
      } } }, openLibrary: async () => { libraryOpens++; }, openDiary: async () => { diaryOpens++; }
    });
    await assert.rejects(controller.setEnabled(false), /PRO_REQUIRED/);
    assert.equal(diarySettings.enabled, true);
    await controller.openToday(); assert.equal(libraryOpens, 1); assert.equal(sourceWrites, 0);
    existingDiary = new TFile("Daily/existing.md");
    await controller.openToday(); assert.equal(diaryOpens, 1); assert.equal(sourceWrites, 0);
    assert.equal(getProPluginAccess(access, false).canEnter, false);
    assert.equal(getProPluginAccess(access, true).canEnter, true);
    const catalogBefore = structuredClone(plugin.settings.lifestyle.finance.accounts);
    await assert.rejects(finance.saveCatalog("accounts", [{ name: "New", aliases: [], active: true }]), /PRO_REQUIRED/);
    await assert.rejects(finance.saveOption("aiEnabled", false), /PRO_REQUIRED/);
    assert.deepEqual(plugin.settings.lifestyle.finance.accounts, catalogBefore);
    assert.equal(plugin.settings.lifestyle.finance.aiEnabled, true); assert.equal(saves, 0);
    paid = true;
    const catalog = [{ name: "New", aliases: [], active: true }];
    await finance.saveCatalog("accounts", catalog); catalog[0].name = "Outside mutation";
    assert.equal(plugin.settings.lifestyle.finance.accounts[0].name, "New");
    saveFailure = true;
    await assert.rejects(finance.saveCatalog("accounts", [{ name: "Lost", aliases: [], active: true }]), /SAVE_FAILED/);
    await assert.rejects(finance.saveOption("aiEnabled", false), /SAVE_FAILED/);
    assert.equal(plugin.settings.lifestyle.finance.accounts[0].name, "New");
    assert.equal(plugin.settings.lifestyle.finance.aiEnabled, true);
    saveFailure = false; paid = false;
    await assert.rejects(finance.saveBudgetChanges({ defaultBudget: { totalCents: 10000, allocations: {} }, overrides: [], removedMonths: [] }), /PRO_REQUIRED/);
    const before = JSON.stringify(store.snapshot());
    await assert.rejects(
      finance.saveBudgetChanges({
        defaultBudget: { totalCents: 20000, allocations: { 餐饮: 0 } },
        overrides: [],
        removedMonths: [],
      }),
      /PRO_REQUIRED/,
    );
    assert.equal(
      JSON.stringify(store.snapshot()),
      before,
      "denied category mutation is atomic",
    );
    await assert.rejects(
      finance.saveDailyLimit("2026-10", 100),
      /PRO_REQUIRED/,
    );
    await assert.rejects(
      finance.saveBillPlan({ id: "trip", name: "旅行", budgetCents: 10000 }),
      /PRO_REQUIRED/,
    );
    assert.throws(() => finance.exportCsv([]), /PRO_REQUIRED/);
    const manual = {
      date: "2026-10-07",
      merchant: "测试",
      amountCents: 100,
      sourceId: "x",
      category: "餐饮",
      account: "现金",
      kind: "expense",
      status: "completed",
      currency: "CNY",
      description: "",
      note: "",
    } as any;
    await assert.rejects(finance.addManual(manual), /PRO_REQUIRED/);
    paid = true;
    const entry = await finance.addManual(manual);
    await finance.updateDetails(
      entry.id,
      "授权修改",
      "说明",
      "",
      undefined,
      undefined,
    );
    paid = false;
    await assert.rejects(
      finance.updateDetails(entry.id, "x", "x", "", undefined, undefined, null),
      /PRO_REQUIRED/,
    );
    await assert.rejects(
      finance.addManual({ ...entry, billPlanId: "trip" }),
      /PRO_REQUIRED/,
    );
    await assert.rejects(
      finance.associateBillPlan([entry.id], "trip"),
      /PRO_REQUIRED/,
    );
    await assert.rejects(finance.analyze("2026-10", true), /PRO_REQUIRED/);
    assert.equal(modelCalls, 0);
    paid = true;
    await finance.saveBudgetChanges({
      defaultBudget: { totalCents: 20000, allocations: { 餐饮: 100 } },
      overrides: [
        { month: "2026-10", totalCents: 20000, allocations: { 餐饮: 200 } },
      ],
      removedMonths: [],
    });
    await finance.saveBillPlan({
      id: "trip",
      name: "旅行",
      budgetCents: 10000,
    });
    await finance.associateBillPlan([entry.id], "trip");
    assert.match(finance.exportCsv(finance.entries()), /授权修改/);
    deniedCapability = "finance.bill_plan.write";
    await assert.rejects(finance.saveBillPlan({ id: "trip", name: "越权修改", budgetCents: 999 }), /PRO_REQUIRED/);
    assert.match(finance.exportCsv(finance.entries()), /授权修改/, "export checks its own capability");
    deniedCapability = "finance.export";
    assert.throws(() => finance.exportCsv([]), /PRO_REQUIRED/);
    deniedCapability = "";
    paid = false;
    await assert.rejects(
      finance.saveBudgetChanges({ overrides: [], removedMonths: ["2026-10"] }),
      /PRO_REQUIRED/,
    );
    const expiredStore = JSON.stringify(store.snapshot());
    const expiredFiles = [...vault.files].map(([path, file]) => [path, file.content]);
    await assert.rejects(finance.saveBudgetChanges({ overrides: [{ month: "2026-10", totalCents: 30000, allocations: { 餐饮: 200 } }], removedMonths: [] }), /PRO_REQUIRED/);
    await assert.rejects(finance.addManual(manual), /PRO_REQUIRED/);
    await assert.rejects(finance.updateDetails(entry.id, "到期修改", "", ""), /PRO_REQUIRED/);
    await assert.rejects(finance.confirmImport([]), /PRO_REQUIRED/);
    await assert.rejects(finance.prepareImport([], new AbortController().signal), /PRO_REQUIRED/);
    assert.throws(() => finance.applyImportSuggestions([], [], new AbortController().signal), /PRO_REQUIRED/);
    assert.equal(JSON.stringify(store.snapshot()), expiredStore);
    assert.deepEqual([...vault.files].map(([path, file]) => [path, file.content]), expiredFiles, "denied operations do not write notes");
    assert.equal(plugin.settings.lifestyle.finance.enabled, true, "expiry preserves enabled");
    assert.equal(finance.billPlans().length, 1, "old plans remain readable");
    paid = true;
    plugin.settings.lifestyle.finance.importAiEnabled = true;
    Object.assign(plugin, {
      getSkillRuntimeCoordinator: () => ({ resolveById: async () => {}, recordUse: async () => {} }),
      requireAvailableEchoInkSkill: async () => {}, readEchoInkBuiltinSkill: async () => ({ fileStatus: "ready", content: "fixture skill" }),
      generateLifestyleText: async () => { modelCalls++; paid = false; return JSON.stringify({ rows: [{ ref: 0, merchant: "Earned", account: "Earned account", category: "餐饮" }] }); }
    });
    const imported = await finance.confirmImport([{ entry: { ...manual, id: "earned-import", source: "wechat", sourceId: "earned-import", account: "Unknown" }, sourceFields: { counterparty: "Synthetic merchant", product: "Synthetic product", transactionType: "消费", paymentMethod: "Unknown", direction: "支出", state: "支付成功", merchantOrderId: "SYNTHETIC", note: "" }, error: "", raw: [] }]);
    const organized = await finance.prepareImport(imported.created, new AbortController().signal);
    assert.equal(paid, false, "fixture expires during authorized import generation");
    assert.throws(() => finance.applyImportSuggestions([...imported.created], organized.rows, new AbortController().signal), /PRO_REQUIRED/, "earned permit is bound to this import");
    const applied = await finance.applyImportSuggestions(imported.created, organized.rows, new AbortController().signal);
    assert.equal(applied.applied, 1, "earned import suggestions save after expiry");
    assert.equal(finance.entries().find(row => row.id === "earned-import")?.merchant, "Earned");
    saveFailure = true;
    await assert.rejects(finance.finalizeImportedAccounts(new Set(["earned-import"])), /SAVE_FAILED/);
    saveFailure = false;
    assert.equal(await finance.finalizeImportedAccounts(new Set(["earned-import"])), 1, "failed catalog completion retains its import permit for retry");
    assert.ok(plugin.settings.lifestyle.finance.accounts.some(account => account.name === "Earned account"));
    assert.throws(() => finance.applyImportSuggestions(imported.created, organized.rows, new AbortController().signal), /PRO_REQUIRED/, "completed permit does not authorize a second operation");
    await assert.rejects(finance.confirmImport([]), /PRO_REQUIRED/);
    const files = new Map<string, string>();
    const port: DiaryFilePort = {
      read: async (p) => files.get(p) ?? null,
      list: async (d) => [...files.keys()].filter((p) => p.startsWith(d + "/")),
      write: async (p, c, e) => {
        assert.equal(files.get(p) ?? null, e);
        files.set(p, c);
      },
      remove: async (p, e) => {
        assert.equal(files.get(p), e);
        files.delete(p);
      },
      move: async (f, t) => {
        files.set(t, files.get(f)!);
        files.delete(f);
      },
    };
    const options = {
      stateDirectory: ".test",
      englishDirectory: "English",
      expressionDirectory: "Expressions",
    };
    const repository = new EnglishDiaryRepository(port, options, access);
    let source: DiarySource = {
      path: "Daily/test.md",
      title: "test",
      date: "2026-10-07",
      content: "今天开会。",
    };
    let lastPrompt = "";
    const generator = {
      skill: async () => "PRO_SKILL_GENERATE_EXPRESSIONS",
      providerLabel: () => "test",
      generate: async ({ systemPrompt, userPrompt }: any) => {
        lastPrompt = systemPrompt;
        modelCalls++;
        const block = JSON.parse(userPrompt).blocks[0];
        const result = JSON.stringify({
          blocks: [{ id: block.id, english: "We met today.", alignments: [] }],
          expressions: [
            {
              blockId: block.id,
              term: "meet",
              type: "phrase",
              meaning: "开会",
              category: "工作",
              scene: "开会",
              example: "We meet today.",
              reason: "开会",
              usage: "开会",
              sourceExcerpt: source.content,
              targetExcerpt: "We met today.",
            },
          ],
        });
        paid = false;
        return result;
      },
    };
    const diary = new EnglishDiaryService(
      repository,
      generator,
      async () => source,
      access,
    );
    await diary.load(source.path);
    assert.equal(files.size, 0, "read-only load does not create an English record");
    const callsBefore = modelCalls;
    await assert.rejects(diary.generate(source.path), /PRO_REQUIRED/);
    await assert.rejects(diary.savePrivacy(source.path, { sourceFingerprint: fingerprint(source.content), rules: [] }), /PRO_REQUIRED/);
    assert.equal(files.size, 0);
    assert.equal(modelCalls, callsBefore);
    paid = true;
    deniedCapability = "diary.explanation.generate";
    await assert.rejects(diary.generate(source.path), /PRO_REQUIRED/);
    assert.equal(modelCalls, callsBefore, "product eligibility does not bypass explanation capability");
    deniedCapability = "diary.expression.write";
    await assert.rejects(diary.generate(source.path), /PRO_REQUIRED/);
    assert.equal(modelCalls, callsBefore, "product eligibility does not bypass expression capability");
    deniedCapability = "";
    source = { ...source, content: "今天再次开会。" };
    const earned = await diary.generate(source.path);
    assert.equal(paid, false);
    assert.match(lastPrompt, /PRO_SKILL/);
    assert.equal(
      earned.result?.expressions.length,
      1,
      "earned generation saves even after entitlement ends",
    );
    const entries = await repository.listExpressions();
    assert.equal(entries.length, 1);
    await assert.rejects(
      repository.updateExpression(entries[0].id, {
        category: "其它",
        note: "",
      }),
      /PRO_REQUIRED/,
    );
    await assert.rejects(
      repository.removeOccurrence(entries[0].id, entries[0].occurrences[0].id),
      /PRO_REQUIRED/,
    );
    await assert.rejects(
      repository.markExpression(
        earned,
        earned.result!.expressions[0].id,
        "needs-review",
      ),
      /PRO_REQUIRED/,
    );
    await assert.rejects(
      repository.publish(
        earned,
        {
          ...earned.result!,
          operationId: "forged",
          sourceFingerprint: fingerprint("new"),
        },
        { sourceUnchanged: async () => true, expressionPermit: {} },
      ),
      /PRO_REQUIRED/,
    );
    const closed = new EnglishDiaryRepository(port, options);
    await assert.rejects(
      closed.updateExpression(entries[0].id, { category: "x", note: "" }),
      /PRO/,
    );
    assert.equal(
      (await repository.restore(earned)).result?.operationId,
      earned.result?.operationId,
    );
    console.log(
      "PASS membership execution gates: whole-plugin write denial, enabled/data retention, read-only load, signed capability boundaries, earned diary save and direct repository denial",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type CodexForObsidianPlugin from "../main";
import { LifestyleService } from "../lifestyle/service";
import { LifestyleStore } from "../lifestyle/store";
import { DEFAULT_LIFESTYLE_SETTINGS, normalizeLifestyleSettings } from "../lifestyle/settings";
import { openTestNoticeMessages } from "./obsidian-shim";
import { paidTestAccess } from "./membership-access";

function fixture(root: string) {
  const registeredViews: string[] = [];
  const commands: { id: string; callback: () => void }[] = [];
  const layoutCallbacks: (() => void)[] = [];
  const vaultEvents: string[] = [];
  let ledgerStarts = 0;
  const workspace = {
    layoutReady: false,
    onLayoutReady(callback: () => void) { layoutCallbacks.push(callback); }
  };
  const plugin = {
    accountService: paidTestAccess,
    app: { workspace, vault: { on: (event: string) => { vaultEvents.push(event); return {}; } } },
    settings: { lifestyle: normalizeLifestyleSettings({ finance: { enabled: true }, map: { enabled: true }, health: { enabled: true } }) },
    getVaultPath: () => root,
    getPluginDataDirName: () => "codex-echoink",
    registerView: (type: string) => { registeredViews.push(type); },
    addCommand: (command: { id: string; callback: () => void }) => { commands.push(command); },
    registerEvent: () => undefined,
    saveSettings: async () => undefined,
    notifyHomeSurfacesChanged: () => undefined
  } as unknown as CodexForObsidianPlugin;
  const service = new LifestyleService(plugin);
  service.finance.ledger.initialize = async () => { ledgerStarts++; };
  return {
    service, plugin, registeredViews, commands, vaultEvents, layoutCallbacks,
    ledgerStarts: () => ledgerStarts,
    ready: () => { workspace.layoutReady = true; for (const callback of layoutCallbacks.splice(0)) callback(); }
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function runLifestyleFinanceIntegrationTests(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-finance-integration-"));
  try {
    assert.deepEqual(Object.keys(DEFAULT_LIFESTYLE_SETTINGS), ["finance"], "默认设置只注册财务插件");
    const unknownSettings = {
      map: { enabled: true, nested: { retained: [1, "two"] } },
      health: { enabled: true },
      futurePlugin: { version: 3 },
      finance: { enabled: true, futureOption: { retained: true }, merchants: [{ name: "测试商户", futureField: "keep" }] }
    };
    const normalized = normalizeLifestyleSettings(unknownSettings);
    normalized.finance.aiEnabled = true;
    const savedSettings = JSON.parse(JSON.stringify(normalized));
    assert.deepEqual(savedSettings.map, unknownSettings.map);
    assert.deepEqual(savedSettings.health, unknownSettings.health);
    assert.deepEqual(savedSettings.futurePlugin, unknownSettings.futurePlugin);
    assert.deepEqual(savedSettings.finance.futureOption, unknownSettings.finance.futureOption);
    assert.equal(savedSettings.finance.merchants[0].futureField, "keep");

    const unknownData = {
      version: 1, financeEntries: [],
      places: [{ id: "unowned-place", opaque: { value: "keep" } }],
      healthRecords: [{ id: "unowned-record", value: 1 }],
      futurePlugin: { entries: [null, "keep"] },
      reports: [{ kind: "unowned-report", opaque: { value: "keep" } }]
    };
    const file = path.join(root, "lifestyle.json");
    await writeFile(file, JSON.stringify(unknownData), "utf8");
    const store = new LifestyleStore(file);
    await store.initialize();
    assert.equal(store.hasLegacyFinanceField(), true);
    await store.update((draft) => { draft.budgets.push({ month: "2026-10", totalCents: 10000, allocations: {} }); });
    const saved = JSON.parse(await readFile(file, "utf8"));
    for (const key of ["places", "healthRecords", "futurePlugin", "reports"] as const) assert.deepEqual(saved[key], unknownData[key], `${key} 必须原样保留`);
    assert.equal(Object.hasOwn(saved, "financeEntries"), false, "沿用迁移完成后移除空旧账目字段的行为");
    const reopened = new LifestyleStore(file);
    await reopened.initialize();
    assert.deepEqual(reopened.snapshot().futurePlugin, unknownData.futurePlugin);
    assert.equal(reopened.snapshot().budgets[0].totalCents, 10000);

    const active = fixture(path.join(root, "active"));
    await active.service.initialize();
    assert.deepEqual(active.registeredViews, ["echoink-lifestyle-finance"]);
    assert.deepEqual(active.commands.map(({ id }) => id), ["open-lifestyle-finance"]);
    for (const name of ["map", "health", "routes", "openWordSea", "openMapReview"]) assert.equal(name in active.service, false, `${name} 不能随财务启动`);
    assert.equal(active.ledgerStarts(), 0, "initialize 返回时尚未触碰账本");
    assert.deepEqual(active.vaultEvents, [], "布局就绪前不注册账本文件监听");
    await active.service.open("finance");
    await active.service.setEnabled("finance", true);
    assert.equal(active.ledgerStarts(), 0, "布局前的打开和启用也不能提前触碰账本");
    active.ready();
    await settle();
    assert.equal(active.ledgerStarts(), 1);
    assert.deepEqual(active.vaultEvents, ["create", "modify", "delete", "rename"]);
    active.service.dispose();

    const dormant = fixture(path.join(root, "dormant"));
    dormant.plugin.settings.lifestyle.finance.enabled = false;
    await dormant.service.initialize();
    dormant.ready();
    await settle();
    assert.equal(dormant.ledgerStarts(), 0, "其他版本的插件开关不能触发财务初始化");
    assert.deepEqual(dormant.vaultEvents, []);
    dormant.service.dispose();

    const cancelled = fixture(path.join(root, "cancelled"));
    await cancelled.service.initialize();
    cancelled.service.dispose();
    cancelled.ready();
    await settle();
    assert.equal(cancelled.ledgerStarts(), 0, "卸载后布局回调不能启动账本");
    assert.deepEqual(cancelled.vaultEvents, []);

    const interrupted = fixture(path.join(root, "interrupted"));
    let finishRead!: () => void;
    interrupted.service.store.initialize = () => new Promise<void>((resolve) => { finishRead = resolve; });
    const pending = interrupted.service.initialize();
    interrupted.service.dispose();
    finishRead();
    await pending;
    assert.deepEqual(interrupted.registeredViews, [], "读取设置途中卸载后不能继续注册入口");
    assert.deepEqual(interrupted.layoutCallbacks, []);

    const failed = fixture(path.join(root, "failed"));
    failed.service.finance.ledger.initialize = async () => { throw new Error("synthetic startup failure"); };
    await failed.service.initialize();
    const noticeCount = openTestNoticeMessages.length;
    failed.ready();
    await settle();
    assert.equal(openTestNoticeMessages.length, noticeCount + 1);
    assert.match(openTestNoticeMessages.at(-1)!, /财务账本初始化未完成.*synthetic startup failure/u);
    failed.service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

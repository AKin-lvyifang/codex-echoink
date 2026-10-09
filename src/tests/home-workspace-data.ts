import { TFile, WorkspaceLeaf } from "obsidian";
import { EchoInkHomeView } from "../home/home-view";
import { EchoInkViewService } from "../plugin/view-service";
import { homeWorkspaceMarkup } from "../home/home-workspace-template";
import { HomeSearchService } from "../home/home-search";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { isHomeNotePath } from "../home/home-note-visibility";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HomeActivityService } from "../home/home-activity-service";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { recordProductionMaintenanceTerminal } from "../plugin/knowledge-maintenance-history";
import { ProductionPiKnowledgeMaintenanceToolPort, type KnowledgeMaintenanceTerminalEvent } from "../plugin/pi-knowledge-maintenance-production";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";
import type { HomeVaultFileRecord } from "../home/home-workbench-model";

export async function runHomeWorkspaceDataTests(): Promise<void> {
  assert.match(homeWorkspaceMarkup("en"), /What stayed with you this week/);
  assert.match(homeWorkspaceMarkup("en"), /About activity/);
  assert.doesNotMatch(homeWorkspaceMarkup("en"), /这一周，留下的足迹|了解足迹记录/);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-home-data-"));
  try {
    let now = new Date(2026, 8, 6, 10).getTime();
    const file = path.join(root, "plugin", "home-activity.json");
    const activity = new HomeActivityService(file, () => now);
    await activity.initialize();
    activity.record("inbox/a.md", "created");
    activity.open("inbox/a.md");
    activity.open("inbox/a.md");
    assert.equal(activity.snapshot().events.filter((e) => e.kind === "reopened").length, 0);
    activity.open(null);
    activity.open("inbox/a.md");
    activity.record("inbox/a.md", "modified");
    now += 1000;
    activity.record("inbox/a.md", "modified");
    let refreshes = 0;
    const stop1 = activity.subscribe(() => refreshes++);
    const stop2 = activity.subscribe(() => refreshes++);
    await activity.flush();
    assert.equal(activity.snapshot().events.length, 3);
    assert.equal(refreshes, 2);
    stop1(); stop2();
    await activity.dispose();
    const restored = new HomeActivityService(file, () => now);
    await restored.initialize();
    const before = restored.snapshot().events.map((e) => ({ ...e }));
    restored.restoreOpen("inbox/a.md");
    restored.open("inbox/a.md");
    assert.deepEqual(restored.snapshot().events, before, "reload is not a reopen");
    now += 86_400_000;
    restored.open(null); restored.open("inbox/a.md");
    assert.equal(restored.snapshot().events.filter((e) => e.kind === "reopened").length, 2);
    restored.rename("inbox", "notes");
    assert(restored.snapshot().events.every((e) => e.path === "notes/a.md"));
    restored.delete("notes/a.md");
    assert.equal(restored.snapshot().events.length, 0);
    await restored.dispose();

    const settings = structuredClone(DEFAULT_SETTINGS.knowledgeBase);
    let snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.assessment, "uninitialized");
    assert.equal(snapshot.checkFreshness.status, "missing");
    for (const folder of ["raw", "wiki", "outputs", "inbox"]) await fsp.mkdir(path.join(root, folder));
    await fsp.writeFile(path.join(root, "wiki/index.md"), "# Index");
    await fsp.writeFile(path.join(root, "outputs/.ingest-tracker.md"), "# Tracker\n- raw/a.md");
    await fsp.writeFile(path.join(root, "raw/a.md"), "# Source");
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.assessment, "local-structure", "real structure is assessable without a historical initialization flag");
    assert.equal(snapshot.health.score, 96);
    assert.equal(settings.initialization.status, "not-started", "assessment does not write an initialization receipt");
    settings.initialization.status = "initialized";
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.score, 96);
    assert.equal(snapshot.health.scoreReasons[0]?.count, 1);
    assert.equal(snapshot.health.scoreReasons[0]?.penalty, 4);
    for (let i = 0; i < 35; i++) await fsp.writeFile(path.join(root, `inbox/${i}.md`), "input");
    settings.lastRunStatus = "failed"; settings.lastError = "failed run";
    await fsp.writeFile(path.join(root, "outputs/kb-check-untrusted.md"), "# Agent says verified\n断链：99\n孤儿页面：42\nwiki/index.md 无效\n");
    settings.lastReportPath = "outputs/kb-check-untrusted.md";
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.score, 96, "queue size, execution failure and model report are not structural deductions");
    assert.equal(snapshot.checkFreshness.status, "missing");
    assert(snapshot.checkHeatmap.every((d) => d.status === "none"));
    const yesterday = Date.now() - 86_400_000;
    settings.healthHistory = [{ date: new Date(yesterday).toLocaleDateString("en-CA"), status: "success", at: yesterday }, { date: new Date().toLocaleDateString("en-CA"), status: "failed", at: Date.now() }];
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.checkFreshness.lastCheckAt, yesterday, "failed checks do not refresh last successful confirmation");
    assert.equal(snapshot.health.lastCheckAt, yesterday);
    await assertKnowledgeCheckHistoryAcrossYears(root);
    settings.healthHistory = [];
    const limited = await buildKnowledgeBaseDashboardSnapshot(root, settings, { maxTotalRawFingerprintBytes: 1 });
    assert.equal(limited.health.assessment, "limited");
    await fsp.writeFile(path.join(root, "outputs/.raw-digest-registry.json"), "invalid json");
    assert.equal((await buildKnowledgeBaseDashboardSnapshot(root, settings)).health.assessment, "unavailable");
    await fsp.unlink(path.join(root, "outputs/.raw-digest-registry.json"));
    await fsp.unlink(path.join(root, "wiki/index.md"));
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.score, 72);
    assert.equal(snapshot.health.status, "bad", "missing core entry overrides score threshold");

    const terminalSettings = structuredClone(DEFAULT_SETTINGS.knowledgeBase);
    for (const terminal of ["completed", "partial", "noop", "failed", "write_uncertain", "cancelled"] as const) {
      const event: KnowledgeMaintenanceTerminalEvent = {
        at: now++,
        input: { vaultId: "vault", conversationId: "conversation", piSessionId: "session", productRunId: "run", toolCallId: terminal, request: "/maintain", mode: "maintain" },
        result: {
          status: terminal === "cancelled" ? "cancelled" : terminal === "completed" || terminal === "noop" ? "completed" : "failed",
          message: terminal,
          ...(terminal === "cancelled" ? {} : { maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: terminal,
            notes: terminal === "completed" || terminal === "partial" ? [{ operation: "created", path: "wiki/test.md", title: "Test", summary: "Readback" }] : [] }) })
        }
      };
      assert(recordProductionMaintenanceTerminal(terminalSettings, event));
      assert(!recordProductionMaintenanceTerminal(terminalSettings, event));
      assert.equal(terminalSettings.maintenanceHistory.at(-1)?.resultStatus, terminal);
    }
    assert.equal(terminalSettings.maintenanceHistory.length, 6);
    assert.equal(terminalSettings.healthHistory.length, 0);
    const withMaintenance = await buildKnowledgeBaseDashboardSnapshot(root, terminalSettings);
    assert(withMaintenance.checkHeatmap.every((day) => day.status === "none"));
    assert.deepEqual(withMaintenance.checkActivity, [], "ordinary maintenance does not create historical check records");
    assert.equal(withMaintenance.activity.days.reduce((sum, day) => sum + (day.maintenance ?? 0), 0), 5, "maintenance activity stays separate from checks and excludes cancellation");
    assert.equal(normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), knowledgeBase: terminalSettings }).settings.knowledgeBase.maintenanceHistory.length, 6);

    const received: KnowledgeMaintenanceTerminalEvent[] = [];
    const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: root, privateKnowledgeRootPath: path.join(root, "private"), vaultId: "vault", userId: "user", deviceId: "device", domainService: {} as never, onTerminal: (event) => { received.push(event); } });
    const aborted = new AbortController(); aborted.abort();
    const input = { vaultId: "vault", conversationId: "conversation", piSessionId: "session", productRunId: "run", toolCallId: "cancel", request: "/maintain", mode: "maintain" as const, signal: aborted.signal };
    assert.equal((await port.execute(input)).status, "cancelled");
    assert.equal(received[0]?.result.status, "cancelled");
    await port.execute({ ...input, signal: undefined, toolCallId: "invalid" });
    assert.equal(received[1]?.result.maintenanceResult?.status, "failed");
    await assertInboxAndSearch();
    await assertDerivedDiaryNotesStayOutOfHome();
    await assertHomeCaptureAndPendingSearch();
    await assertHomeRecentNotesPreserveFullData();
    await assertHomeProgressiveLoading();
    console.log("Home activity, health evidence, search, empty Inbox and maintenance terminal: PASS");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}

async function assertHomeProgressiveLoading(): Promise<void> {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const create = () => {
    const timers = new Map<number, () => void>();
    const listeners = new Map<string, () => void>();
    const fields = new Map<string, { text: string; setText(value: string): void; removeAttribute(): void; querySelector(): HTMLElement | null }>();
    const dataLoads: ReturnType<typeof deferred<any>>[] = [];
    const healthLoads: ReturnType<typeof deferred<any>>[] = [];
    const renders: string[] = [];
    let nextTimer = 0;
    let active = false;
    const leaf = new WorkspaceLeaf();
    const daily = { folder: "journal", format: "YYYY-MM-DD" };
    const app = {
      internalPlugins: { plugins: { "daily-notes": { instance: { options: daily } } } },
      vault: {
        getRoot: () => ({ children: [{ path: "journal" }, { path: "templates" }] }),
        on: (event: string, callback: () => void) => { listeners.set(event, callback); return {}; }
      },
      workspace: {
        rightSplit: { collapsed: true },
        getLeavesOfType: () => active ? [leaf] : [],
        getLeaf: () => leaf,
        setActiveLeaf: () => undefined
      }
    };
    const plugin = {
      app, settings: structuredClone(DEFAULT_SETTINGS),
      homeActivity: { subscribe: () => () => undefined },
      getTodoStore: () => ({ subscribe: () => () => undefined }),
      getKnowledgeSurfaceService: () => ({ getDashboardSnapshot: () => {
        const load = deferred<any>(); healthLoads.push(load); return load.promise;
      } })
    };
    const view = new EchoInkHomeView(leaf, plugin as never) as any;
    view.app = app;
    view.contentEl = {
      addClass: () => undefined, removeClass: () => undefined, empty: () => undefined,
      ownerDocument: { defaultView: {
        setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout: (id: number) => timers.delete(id)
      } }
    };
    view.field = (name: string) => {
      if (!fields.has(name)) fields.set(name, { text: "", setText(value) { this.text = value; }, removeAttribute() {}, querySelector: () => null });
      return fields.get(name)!;
    };
    for (const method of ["renderShell", "renderRecent", "renderActivity", "renderCalendar", "renderEntries", "renderTodos", "renderHealth", "renderDataPlaceholders", "applyModuleVisibility"]) {
      view[method] = () => renders.push(method);
    }
    view.dataService = { build: () => {
      const load = deferred<any>(); dataLoads.push(load); return load.promise;
    } };
    let flight!: Promise<void>;
    const refresh = view.refresh.bind(view);
    view.refresh = () => flight = refresh();
    leaf.setViewState = async () => { active = true; leaf.view = view; await view.onOpen(); };
    const runScheduled = () => {
      assert.equal(timers.size, 1, "one data load is scheduled even when opening/revealing twice");
      const [id, callback] = timers.entries().next().value!;
      timers.delete(id); callback(); return flight;
    };
    return { view, service: new EchoInkViewService(plugin as never), timers, listeners, fields, dataLoads, healthLoads, renders, daily, runScheduled };
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const fixture = create();
  // Navigation resolves with only the shell present; no data/health work has
  // started in the workspace restoration task itself.
  await fixture.service.activateHomeView();
  await fixture.service.activateHomeView();
  assert.equal(fixture.dataLoads.length, 0);
  assert.equal(fixture.renders.filter((name) => name === "renderShell").length, 1);
  const first = fixture.runScheduled();
  const firstData = { records: [{ path: "wiki/first.md" }] };
  fixture.dataLoads[0].resolve(firstData);
  await settle();
  assert.equal(fixture.view.data, firstData);
  assert(fixture.renders.includes("renderRecent"));
  assert(fixture.renders.includes("renderCalendar"));
  assert.equal(fixture.view.healthLoading, true, "notes and calendar render while health is still pending");
  await fixture.service.activateHomeView();
  assert.equal(fixture.timers.size, 0, "revealing unchanged content does not restart the scan");

  fixture.daily.folder = "Daily";
  await fixture.service.activateHomeView();
  const second = fixture.runScheduled();
  const secondData = { records: [{ path: "Daily/today.md" }] };
  fixture.dataLoads[1].resolve(secondData);
  fixture.healthLoads[1].resolve({ health: { score: 88 } });
  await second;
  const recentRenders = fixture.renders.filter((name) => name === "renderRecent").length;
  fixture.healthLoads[0].resolve({ health: { score: 12 } });
  await first;
  assert.equal(fixture.view.snapshot.health.score, 88, "late health data cannot replace a newer refresh");
  assert.equal(fixture.view.data, secondData, "native journal changes are reflected on return");
  assert.equal(fixture.renders.filter((name) => name === "renderRecent").length, recentRenders,
    "health updates leave the current note/calendar DOM alone");

  fixture.listeners.get("modify")!(); fixture.listeners.get("modify")!();
  const third = fixture.runScheduled();
  await fixture.view.onClose();
  const renderedBeforeClose = fixture.renders.length;
  fixture.dataLoads[2].resolve(firstData);
  fixture.healthLoads[2].resolve({ health: { score: 99 } });
  await third;
  assert.equal(fixture.renders.length, renderedBeforeClose, "pending work never renders into a closed home");

  const failure = create();
  await failure.service.activateHomeView();
  const failedLoad = failure.runScheduled();
  failure.dataLoads[0].resolve(firstData);
  failure.healthLoads[0].reject(new Error("health unavailable"));
  await failedLoad;
  assert.equal(failure.view.data, firstData, "a health failure does not discard usable notes");
  assert.equal(failure.view.healthLoading, false);
  assert.equal(failure.view.snapshot, null);
  const failedNotes = failure.view.refresh();
  failure.dataLoads[1].reject(new Error("notes unavailable"));
  failure.healthLoads[1].resolve(null);
  await failedNotes;
  assert.match(failure.fields.get("recent-subtitle")!.text, /笔记读取失败/u);
  assert(!failure.renders.includes("renderDataPlaceholders"), "refresh failure preserves already rendered notes");
  failure.fields.get("recent-notes")!.querySelector = () => ({}) as HTMLElement;
  const failedLanguage = failure.view.refreshLanguage();
  failure.dataLoads[2].reject(new Error("notes unavailable after rebuilding the shell"));
  failure.healthLoads[2].resolve(null);
  await failedLanguage;
  assert(failure.renders.includes("renderDataPlaceholders"), "a rebuilt shell exits loading even if earlier data is cached");
  await failure.view.onClose();

  const invalidSettings = create();
  invalidSettings.daily.folder = "../outside";
  await invalidSettings.service.activateHomeView();
  const invalidLoad = invalidSettings.runScheduled();
  invalidSettings.healthLoads[0].resolve(null);
  await invalidLoad;
  assert.equal(invalidSettings.dataLoads.length, 0);
  assert.match(invalidSettings.fields.get("recent-subtitle")!.text, /笔记读取失败/u);
  assert(invalidSettings.renders.includes("renderDataPlaceholders"), "invalid native settings exit the initial loading state");
  invalidSettings.daily.folder = "journal";
  await invalidSettings.service.activateHomeView();
  const recoveredLoad = invalidSettings.runScheduled();
  invalidSettings.dataLoads[0].resolve(firstData);
  invalidSettings.healthLoads[1].resolve(null);
  await recoveredLoad;
  assert.equal(invalidSettings.view.data, firstData);
  invalidSettings.daily.folder = "../outside";
  await invalidSettings.service.activateHomeView();
  const invalidReturn = invalidSettings.runScheduled();
  invalidSettings.healthLoads[2].resolve(null);
  await invalidReturn;
  assert.equal(invalidSettings.view.data, firstData, "invalid settings on return preserve the last usable notes and do not block navigation");
  await invalidSettings.view.onClose();

  const closed = create();
  await closed.service.activateHomeView();
  await closed.view.onClose();
  assert.equal(closed.timers.size, 0, "closing before first paint cancels the scheduled data work");
  assert.equal(closed.dataLoads.length, 0);
}

async function assertKnowledgeCheckHistoryAcrossYears(root: string): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS.knowledgeBase);
  const year = new Date().getFullYear();
  const currentDate = `${year}-01-01`;
  const previousDates = [`${year - 1}-12-30`, `${year - 1}-12-31`];
  settings.healthHistory = [
    { date: currentDate, status: "success", at: new Date(`${currentDate}T12:00:00`).getTime() },
    { date: previousDates[1], status: "success", at: new Date(`${previousDates[1]}T10:00:00`).getTime() },
    { date: previousDates[0], status: "success", at: new Date(`${previousDates[0]}T12:00:00`).getTime() },
    { date: previousDates[1], status: "failed", at: new Date(`${previousDates[1]}T14:00:00`).getTime() }
  ];
  const snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
  assert.deepEqual(snapshot.checkActivity, [
    { date: previousDates[0], status: "success" },
    { date: previousDates[1], status: "failed" },
    { date: currentDate, status: "success" }
  ], "all historical check dates remain available, with the existing per-day status resolution");
  assert.equal(snapshot.checkHeatmap.length, new Date(year, 1, 29).getMonth() === 1 ? 366 : 365);
  assert.equal(snapshot.checkHeatmap[0].date, currentDate);
  assert.equal(snapshot.checkHeatmap.at(-1)?.date, `${year}-12-31`);
  assert.deepEqual(snapshot.checkHeatmap.filter((day) => day.status !== "none"), [{ date: currentDate, status: "success" }], "Home and chat retain the current-year heatmap");
}

async function assertDerivedDiaryNotesStayOutOfHome(): Promise<void> {
  const settings = {
    settingsLanguage: "zh-CN",
    journalDirectory: "Daily",
    englishDiary: { ...DEFAULT_SETTINGS.englishDiary, enabled: false, englishDirectory: "资料/英文稿", expressionDirectory: "资料/表达",
      legacyEnglishDirectories: ["以前/英文"], legacyExpressionDirectories: ["以前/表达"] }
  };
  const originalPath = "Daily/2026-10/2026-10-06.md";
  const derivedPaths = ["资料/英文稿/2026-10-06.md", "资料/英文稿/嵌套/另一篇.md", "资料/表达/情绪/take-a-breath.md",
    "outputs/.english-diary/diaries/a.md", "输出（outputs）/.english-diary/expressions/a.md", "以前/英文/a.md", "以前/表达/a.md"];
  const visiblePaths = [originalPath, "EchoInk/普通笔记.md", "资料/英文稿备份/记录.md", "资料/表达方式/记录.md", "其他/资料/英文稿/记录.md", "资料/英文稿.md",
    "outputs/普通总结.md", "输出（outputs）/普通总结.md", "outputs/.english-diary-backup/a.md", "以前/英文备份/a.md"];
  const paths = [...visiblePaths, ...derivedPaths];
  const files = paths.map((path, index) => Object.assign(new TFile(path), {
    basename: path.split("/").at(-1)!.replace(/\.md$/u, ""),
    parent: { path: path.slice(0, path.lastIndexOf("/")) },
    stat: { mtime: index + 1, ctime: index + 1, size: 20 }
  }));
  const events = paths.map((path, index) => ({ path, kind: "created" as const, at: index + 1, date: "2026-10-06" }));
  const storedEvents = structuredClone(events);
  const activity = { snapshot: () => ({ startedAt: 1, events, error: null }) };
  const readPaths: string[] = [];
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => { readPaths.push(file.path); return file.path === originalPath || derivedPaths.includes(file.path) ? "每日原稿与系统资料" : "普通笔记"; }
    },
    metadataCache: { getFileCache: () => null }
  };
  const visible = (path: string) => isHomeNotePath(path, settings.englishDiary);
  const data = await new HomeWorkbenchDataService(app as never, () => settings.journalDirectory, activity as never, visible).build(new Date(2026, 9, 6));
  assert.deepEqual(data.records.map((record) => record.path), visiblePaths, "configured generated directories are excluded while source, sibling prefixes and other EchoInk notes remain");
  assert.equal(data.activity.find((day) => day.date === "2026-10-06")?.count, visiblePaths.length, "generated writes do not increase daily activity");
  assert.equal(data.journalDays.find((day) => day.date === "2026-10-06")?.path, originalPath, "the canonical journal still appears in the calendar");
  assert.equal(data.entries.find((entry) => entry.id === "journal")?.count, 1);

  const home = new EchoInkHomeView(new WorkspaceLeaf(), { app, settings, homeActivity: activity } as never) as any;
  home.data = data;
  assert.deepEqual(new Set(home.events.map((event: { path: string }) => event.path)), new Set(visiblePaths), "historical event display uses the same filter even while English Diary is disabled");
  assert(home.records().every((record: { path: string }) => !derivedPaths.includes(record.path)), "newest generated files cannot enter the recent list");
  home.selectedDate = "2026-10-06";
  assert(home.records().some((record: { path: string }) => record.path === originalPath), "day-selected recent notes keep the original journal");
  assert.deepEqual(events, storedEvents, "filtering does not delete or rewrite stored history");

  const search = new HomeSearchService(app as never, visible);
  const result = await search.search("每日", new AbortController().signal);
  assert.deepEqual(result.matches.map((match) => match.path), [originalPath], "home search keeps the journal but excludes generated resources");
  assert(readPaths.every((path) => !derivedPaths.includes(path)), "excluded resources are filtered before body reads");
  assert.equal(await search.excerpt(derivedPaths[0]), "");
  assert.equal(isHomeNotePath("EchoInk/英文日记/a.md"), false);
  assert.equal(isHomeNotePath("EchoInk/表达库/日常/a.md"), false);
  assert.equal(isHomeNotePath(".echoink/english-diary/expressions/a.md"), false);
  assert.equal(isHomeNotePath("EchoInk/英文日记备份/a.md"), true);
  assert.equal(isHomeNotePath("EchoInk/说明.md"), true);
  assert.equal(isHomeNotePath("资料\\英文稿\\a.md", settings.englishDiary), false, "directory boundaries normalize Windows separators");
}

async function assertHomeRecentNotesPreserveFullData(): Promise<void> {
  const files = [
    ["finance/latest.md", 100, 100], ["health/latest.md", 99, 99], ["wiki-backup/latest.md", 98, 98],
    ["wiki/knowledge.md", 10, 1], ["raw/material.md", 7, 25], ["outputs/result.md", 9, 1],
    ["Notes/Daily/archive/journal.md", 8, 1], ["legacy-journal/old.md", 97, 97]
  ].map(([path, mtime, ctime]) => {
    const file = new TFile(String(path));
    Object.assign(file, { basename: String(path).split("/").at(-1)!.replace(/\.md$/, ""), stat: { mtime, ctime, size: 50 } });
    return file;
  });
  const selectedDate = "2026-09-06";
  const events = ["finance/latest.md", "raw/material.md", "wiki/knowledge.md", "raw/material.md", "health/latest.md"]
    .map((path, index) => ({ path, date: selectedDate, kind: "modified" as const, at: index }));
  events.push({ path: "finance/latest.md", date: "2026-09-07", kind: "modified", at: 6 });
  const app = {
    internalPlugins: { plugins: { "daily-notes": { instance: { options: { folder: "Notes/Daily" } } } } },
    vault: { getAllLoadedFiles: () => files, getMarkdownFiles: () => files,
      cachedRead: async (file: TFile) => file.path === "finance/latest.md" ? "searchable finance marker" : "ordinary note" },
    metadataCache: { getFileCache: () => null }
  };
  const plugin = { app, settings: { settingsLanguage: "zh-CN", journalDirectory: "legacy-journal" },
    homeActivity: { snapshot: () => ({ events }) } };
  const service = new HomeWorkbenchDataService(app as never, () => plugin.settings.journalDirectory, plugin.homeActivity as never);
  assert.equal(service.getJournalDirectory(), "Notes/Daily", "native journal configuration wins over the old EchoInk folder");
  const data = await service.build(new Date(2026, 8, 6));
  const view = new EchoInkHomeView(new WorkspaceLeaf(), plugin as never);
  const mutable = view as unknown as { data: typeof data; selectedDate: string | null; records(): HomeVaultFileRecord[] };
  mutable.data = data;
  const originalPaths = data.records.map((record) => record.path);
  const activityBefore = JSON.stringify(data.activity);
  const recent = mutable.records();
  assert.deepEqual(recent.map((record) => record.path), ["raw/material.md", "wiki/knowledge.md", "outputs/result.md", "Notes/Daily/archive/journal.md"]);
  assert.deepEqual(recent.slice(0, 3).map((record) => record.path), ["raw/material.md", "wiki/knowledge.md", "outputs/result.md"],
    "new finance/health notes cannot displace eligible notes; creation/modification ordering stays intact");
  mutable.selectedDate = selectedDate;
  assert.deepEqual(mutable.records().map((record) => record.path), ["raw/material.md", "wiki/knowledge.md"],
    "date mode applies the same scope while preserving activity order and path deduplication");
  mutable.selectedDate = "2026-09-07";
  assert.deepEqual(mutable.records(), [], "a day containing only finance notes has no recent-note candidates for the existing empty state");
  assert.deepEqual(data.records.map((record) => record.path), originalPaths, "the full dataset is not filtered or reordered");
  assert.equal(data.records.length, files.length);
  assert.equal(JSON.stringify(data.activity), activityBefore, "activity counts retain all recorded events");
  assert.equal(data.activity.reduce((sum, day) => sum + day.count, 0), events.length);
  const result = await new HomeSearchService(app as never).search("finance marker", new AbortController().signal);
  assert.equal(result.matches[0]?.path, "finance/latest.md", "full-Vault search still finds excluded recent-note directories");
}

async function assertHomeCaptureAndPendingSearch(): Promise<void> {
  const calls: unknown[] = [];
  const file = new TFile("inbox/未命名.md");
  let finishCreate!: (file: TFile) => void;
  const leaf = { openFile: async (...args: unknown[]) => { calls.push(["open", ...args]); } };
  const workspace = {
    getLeaf: (kind: string) => { calls.push(["leaf", kind]); return leaf; },
    setActiveLeaf: (...args: unknown[]) => { calls.push(["active", ...args]); }
  };
  const home = new EchoInkHomeView(new WorkspaceLeaf(), { app: {}, settings: { settingsLanguage: "zh-CN" } } as never);
  const mutable = home as any;
  mutable.app = { workspace };
  mutable.dataService = { createBlankInboxNote: () => { calls.push(["create"]); return new Promise<TFile>((resolve) => { finishCreate = resolve; }); } };
  mutable.refresh = async () => { calls.push(["refresh"]); };
  const first = mutable.capture();
  await mutable.capture();
  assert.deepEqual(calls, [["create"]], "a second click cannot create another note while capture is pending");
  finishCreate(file); await first;
  assert.deepEqual(calls, [["create"], ["leaf", "tab"], ["open", file, { active: true }], ["active", leaf, { focus: true }], ["refresh"]]);

  const input = { value: "new query", dataset: { home: "search-input" }, removeAttribute: () => undefined };
  const fields: Record<string, unknown> = {
    "search-input": input,
    "search-results": { empty: () => undefined },
    "search-empty": { hidden: false },
    "search-results-heading": { setText: () => undefined }
  };
  let scheduled = false;
  mutable.contentEl = { ownerDocument: { defaultView: { setTimeout: () => { scheduled = true; return 1; }, clearTimeout: () => undefined } } };
  mutable.field = (name: string) => fields[name];
  mutable.searchOpen = true;
  mutable.searchResolvedQuery = "old query";
  mutable.searchMatches = [{ path: "old.md" }];
  const opened: string[] = [];
  mutable.openNote = async (path: string) => { opened.push(path); };
  mutable.closeSearch = () => undefined;
  const enter = { key: "Enter", target: input, preventDefault: () => undefined };
  mutable.handleKeys(enter);
  assert.deepEqual(opened, [], "Enter cannot open a result for a different input query");
  mutable.scheduleSearch();
  mutable.handleKeys(enter);
  assert.equal(scheduled, true);
  assert.deepEqual(opened, [], "Enter remains inert while the new query is pending");
  mutable.searchResolvedQuery = input.value;
  mutable.searchMatches = [{ path: "new.md" }];
  mutable.handleKeys(enter);
  assert.deepEqual(opened, ["new.md"], "Enter opens the matching completed query");
  const options = [0, 1, 2].map((i) => ({ id: `option-${i}`, setAttribute: () => undefined, scrollIntoView: () => undefined }));
  Object.assign(input, { setAttribute: () => undefined });
  Object.assign(fields["search-results"] as object, { querySelectorAll: () => options });
  mutable.searchMatches = options.map((option) => ({ path: option.id }));
  mutable.searchIndex = -1;
  mutable.handleKeys({ key: "ArrowUp", target: input, preventDefault: () => undefined });
  assert.equal(mutable.searchIndex, 2, "first ArrowUp selects the last result");
  let preventedCaret = false;
  mutable.handleKeys({ key: "Home", target: input, preventDefault: () => { preventedCaret = true; } });
  assert.equal(preventedCaret, false, "Home remains native text-caret navigation in the search input");
  assert.equal(mutable.searchIndex, 2);
  mutable.selectSearchIndex(1, false);
  mutable.handleKeys(enter);
  assert.equal(opened.at(-1), "option-1", "Enter follows the pointer-selected result");
}

async function assertInboxAndSearch(): Promise<void> {
  const files = new Map<string, TFile>();
  const bodies = new Map<string, string>();
  const make = (path: string, text: string) => {
    const file = new TFile(path);
    Object.assign(file, { basename: path.split("/").at(-1)!.replace(/\.md$/, ""), stat: { mtime: 1, ctime: 1, size: text.length } });
    files.set(path, file); bodies.set(path, text); return file;
  };
  make("inbox/未命名.md", "preserve existing content");
  let race = true;
  let reads = 0;
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.get(path) ?? (path === "inbox" ? { path } : null),
    getMarkdownFiles: () => [...files.values()],
    create: async (path: string, content: string) => {
      if (race) { race = false; make(path, "another creator"); throw new Error("already exists"); }
      return make(path, content);
    },
    cachedRead: async (file: TFile) => { reads++; return bodies.get(file.path)!; }
  }, metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ["fixture-alias"] } }) } };
  const service = new HomeWorkbenchDataService(app as never);
  const created = await service.createBlankInboxNote();
  assert.equal(created.path, "inbox/未命名 2.md");
  assert.equal(bodies.get(created.path), "");
  assert.equal(bodies.get("inbox/未命名.md"), "preserve existing content");
  assert.equal(bodies.get("inbox/未命名 1.md"), "another creator");
  const target = make("notes/meaning.md", `${"Unrelated introduction. ".repeat(15)}This phrase exists only in body content.`);
  const search = new HomeSearchService(app as never);
  const controller = new AbortController();
  const found = (await search.search("only in body", controller.signal)).matches[0];
  assert.equal(found?.path, target.path);
  assert.match(found?.snippet ?? "", /This phrase exists only in body content/u);
  assert.ok(found?.snippet.startsWith("…"), "the snippet is taken around the body match, not the note opening");
  const firstReads = reads;
  await search.search("body content", controller.signal);
  assert.equal(reads, firstReads, "unchanged note bodies are cached across input");
  bodies.set(target.path, "changed source"); target.stat.mtime = 2;
  assert.equal((await search.search("changed source", controller.signal)).matches[0]?.path, target.path);
  assert.equal(reads, firstReads + 1, "only a changed file invalidates its content cache");
  controller.abort();
  assert.deepEqual((await search.search("changed source", controller.signal)).matches, []);
  let finish!: (body: string) => void;
  const delayed = new HomeSearchService({ ...app, vault: { ...app.vault, getMarkdownFiles: () => [target], cachedRead: () => new Promise<string>((resolve) => { finish = resolve; }) } } as never);
  const aborted = new AbortController(); const running = delayed.search("source", aborted.signal);
  aborted.abort(); finish("source");
  assert.deepEqual((await running).matches, [], "cancel during final file read does not return stale matches");
}

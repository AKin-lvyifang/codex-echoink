import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { TFile, TFolder, WorkspaceLeaf, type App } from "obsidian";
import { KNOWLEDGE_ROOT_NAMES } from "../knowledge-base/root-paths";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  DEFAULT_JOURNAL_TEMPLATE_ID,
  HOME_CONTRIBUTION_DAYS,
  HOME_CONTRIBUTION_WEEKS,
  HOME_ENTRY_IDS,
  applyJournalTemplate,
  buildHomeActivityDays,
  buildHomeContributionGrid,
  buildHomeJournalDays,
  decodeImportedMarkdown,
  extractFirstLocalImageTarget,
  homeContributionLevel,
  importedTemplatePath,
  isKnowledgeBaseReviewPath,
  journalDateFromPath,
  journalPathForDate,
  mergeHomeActivityDays,
  nextAvailableImportedTemplatePath,
  parseImportedJournalTemplate,
  type HomeVaultFileRecord
} from "../home/home-workbench-model";
import {
  HOME_ENTRY_INDEX_PATHS,
  HomeWorkbenchDataService,
  defaultJournalTemplateChoice,
  homeEntryIndexPath
} from "../home/home-workbench-data";
import {
  DEFAULT_JOURNAL_DIRECTORY,
  normalizeJournalDirectory
} from "../home/journal-directory";
import {
  openObsidianGraphLeaf,
  openObsidianLocalGraphLeaf
} from "../home/open-native-graph";
import {
  HOME_DAILY_MESSAGE,
  HOME_DAILY_MESSAGE_EN,
  HOME_DAILY_TITLES,
  HOME_REVISIT_MESSAGE,
  HOME_REVISIT_MESSAGE_EN,
  HOME_REVIEW_PROMPT,
  HOME_REVIEW_PROMPT_EN,
  HOME_DAILY_TITLES_EN,
  HOME_REVISIT_TITLES,
  HOME_REVISIT_TITLES_EN,
  homeConversationMessage,
  homeConversationTitle,
  homeReviewPrompt
} from "../home/home-conversation-actions";
import {
  formatHomeFullDate,
  formatHomeMonth,
  formatHomeRelativeTime,
  homeCopy
} from "../home/home-i18n";
import { openTestNoticeMessages } from "./obsidian-shim";
import { EchoInkHomeView } from "../home/home-view";

export async function runHomeWorkbenchTests(): Promise<void> {
  assertFixedEntryAndTemplateContracts();
  assertActivityAndJournalCalendar();
  assertSmoothUiContributionGrid();
  assertImageExtraction();
  assertTemplateImportAndPlaceholderPreservation();
  assertReviewRecognitionAndUtf8Import();
  assertHomeConversationActions();
  assertHomeEnglishLocalization();
  assertHomeUiAttribution();
  await assertHomeConversationLaunchFlow();
  await assertCustomJournalDirectoryBehavior();
  await assertNativeGraphBehavior();
}

async function assertHomeConversationLaunchFlow(): Promise<void> {
  const calls: string[] = [];
  const starts: unknown[] = [];
  const view = {
    startHomeConversation: async (input: unknown) => {
      calls.push("start");
      starts.push(input);
    }
  };
  const plugin = {
    app: {},
    settings: {
      journalDirectory: "notes/daily",
      settingsLanguage: "zh-CN" as "zh-CN" | "en"
    },
    requireAvailableEchoInkSkill: async (skillId: string) => {
      calls.push(`skill:${skillId}`);
    },
    openEchoInkSkillSettings: async (skillId: string) => {
      calls.push(`settings:${skillId}`);
    },
    activateView: async () => {
      calls.push("open-sidebar");
    },
    getCodexView: () => {
      calls.push("get-view");
      return view;
    }
  };
  const home = new EchoInkHomeView(
    new WorkspaceLeaf(),
    plugin as never
  );
  (home as unknown as { dataService: { ensureJournalDirectory(): Promise<string> } })
    .dataService = {
      ensureJournalDirectory: async () => {
        calls.push("ensure-directory");
        return "notes/daily";
      }
    };
  await (home as unknown as {
    openConversationAction(action: "daily" | "revisit"): Promise<void>;
  }).openConversationAction("daily");
  assert.deepEqual(calls, [
    "skill:daily-journal",
    "open-sidebar",
    "get-view",
    "start"
  ]);
  const dailyStart = starts[0] as Readonly<Record<string, unknown>>;
  assert.match(String(dailyStart.title), /^写日记 · \d{4}-\d{2}-\d{2}$/u);
  assert.equal(dailyStart.message, HOME_DAILY_MESSAGE);
  assert.equal(dailyStart.defaultSkillId, "daily-journal");
  assert.equal(dailyStart.journalDirectory, undefined);

  calls.length = 0;
  starts.length = 0;
  await (home as unknown as {
    openConversationAction(action: "daily" | "revisit"): Promise<void>;
  }).openConversationAction("revisit");
  assert.deepEqual(calls, ["open-sidebar", "get-view", "start"]);
  const revisitStart = starts[0] as Readonly<Record<string, unknown>>;
  assert.match(String(revisitStart.title), /^未完想法 · \d{4}-\d{2}-\d{2}$/u);
  assert.deepEqual(revisitStart, {
    title: revisitStart.title,
    message: HOME_REVISIT_MESSAGE
  });

  calls.length = 0;
  starts.length = 0;
  plugin.settings.settingsLanguage = "en";
  await (home as unknown as {
    openConversationAction(action: "daily" | "revisit"): Promise<void>;
  }).openConversationAction("daily");
  assert.deepEqual(calls, [
    "skill:daily-journal",
    "open-sidebar",
    "get-view",
    "start"
  ]);
  const englishDailyStart = starts[0] as Readonly<Record<string, unknown>>;
  assert.match(String(englishDailyStart.title), /^Journal · \d{4}-\d{2}-\d{2}$/u);
  assert.equal(englishDailyStart.message, HOME_DAILY_MESSAGE_EN);
  assert.equal(englishDailyStart.defaultSkillId, "daily-journal");
  assert.equal(englishDailyStart.journalDirectory, undefined);

  calls.length = 0;
  openTestNoticeMessages.length = 0;
  plugin.settings.settingsLanguage = "zh-CN";
  plugin.requireAvailableEchoInkSkill = async (skillId: string) => {
    calls.push(`skill:${skillId}`);
    throw new Error("Skill daily-journal 已停用。");
  };
  await (home as unknown as {
    openConversationAction(action: "daily" | "revisit"): Promise<void>;
  }).openConversationAction("daily");
  assert.deepEqual(calls, ["skill:daily-journal", "settings:daily-journal"]);
  assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法新建会话：Skill daily-journal 已停用/u);

  calls.length = 0;
  openTestNoticeMessages.length = 0;
  plugin.settings.settingsLanguage = "en";
  await (home as unknown as {
    openConversationAction(action: "daily" | "revisit"): Promise<void>;
  }).openConversationAction("daily");
  assert.deepEqual(calls, ["skill:daily-journal", "settings:daily-journal"]);
  assert.equal(
    openTestNoticeMessages.at(-1),
    "Could not create a new conversation: The daily-journal Skill is disabled, missing, or could not be loaded."
  );
}

function assertHomeConversationActions(): void {
  const now = new Date(2026, 8, 2, 9, 7);

  assert.equal(HOME_DAILY_TITLES.length, 6);
  assert.equal(HOME_REVISIT_TITLES.length, 6);
  assert.equal(
    homeConversationTitle("daily", "EchoInk 测试库", now),
    homeConversationTitle("daily", "EchoInk 测试库", new Date(2026, 8, 2, 22, 30))
  );
  assert.ok(HOME_DAILY_TITLES.includes(
    homeConversationTitle("daily", "EchoInk 测试库", now) as (typeof HOME_DAILY_TITLES)[number]
  ));
  assert.ok(HOME_REVISIT_TITLES.includes(
    homeConversationTitle("revisit", "EchoInk 测试库", now) as (typeof HOME_REVISIT_TITLES)[number]
  ));

  assert.equal(HOME_DAILY_MESSAGE, "想把今天发生的事记下来。");
  assert.equal(
    HOME_REVISIT_MESSAGE,
    "从我的长期记忆里，找一件没说完的事，我们接着聊。"
  );
  assert.equal(
    HOME_REVIEW_PROMPT,
    "请从我最近积累和修改的知识中，找出 3 个值得重新思考的主题。先说明它们为什么值得回看，等我选择后再带我逐步复盘；未经我确认，不要写入笔记。"
  );
  assert.doesNotMatch(HOME_REVIEW_PROMPT, /\/review/u);
  assert.equal(homeConversationMessage("daily"), HOME_DAILY_MESSAGE);
  assert.equal(homeConversationMessage("revisit"), HOME_REVISIT_MESSAGE);
  assert.equal(homeReviewPrompt(), HOME_REVIEW_PROMPT);
}

function assertHomeEnglishLocalization(): void {
  const now = new Date(2026, 8, 2, 9, 7);
  const copy = homeCopy("en");

  assert.equal(HOME_DAILY_TITLES_EN.length, 6);
  assert.equal(HOME_REVISIT_TITLES_EN.length, 6);
  assert.ok(HOME_DAILY_TITLES_EN.includes(
    homeConversationTitle("daily", "EchoInk test vault", now, "en") as (typeof HOME_DAILY_TITLES_EN)[number]
  ));
  assert.ok(HOME_REVISIT_TITLES_EN.includes(
    homeConversationTitle("revisit", "EchoInk test vault", now, "en") as (typeof HOME_REVISIT_TITLES_EN)[number]
  ));
  assert.equal(homeConversationMessage("daily", "en"), HOME_DAILY_MESSAGE_EN);
  assert.equal(homeConversationMessage("revisit", "en"), HOME_REVISIT_MESSAGE_EN);
  assert.equal(homeReviewPrompt("en"), HOME_REVIEW_PROMPT_EN);
  assert.match(HOME_DAILY_MESSAGE_EN, /write down what happened today/u);
  assert.match(HOME_REVISIT_MESSAGE_EN, /unfinished thought in my long-term memory/u);
  assert.match(HOME_REVIEW_PROMPT_EN, /3 topics worth reconsidering/u);
  assert.doesNotMatch(
    [HOME_DAILY_MESSAGE_EN, HOME_REVISIT_MESSAGE_EN, HOME_REVIEW_PROMPT_EN].join("\n"),
    /\/daily|\/revisit|Default template preview/u
  );
  assert.equal(copy.viewTitle, "EchoInk Home");
  assert.equal(copy.entry.description("journal"), "Journal, review, and time-based records");
  assert.equal(copy.calendar.summary(1), "1 day with a journal");
  assert.equal(copy.template.display("quick").name, "Quick note");
  assert.match(formatHomeFullDate(now, "en"), /Sep/u);
  assert.match(formatHomeMonth(now, "en"), /September/u);
  assert.equal(formatHomeRelativeTime(now.getTime() - 60_000, "en", now.getTime()), "1 min ago");
  assert.equal(formatHomeRelativeTime(now.getTime() - 60_000, "zh-CN", now.getTime()), "1 分钟前");
}

function assertHomeUiAttribution(): void {
  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  for (const library of ["magic-ui", "amicro"]) {
    const root = `src/home/${library}`;
    const source = JSON.parse(readFileSync(`${root}/SOURCE.json`, "utf8")) as {
      commit: string;
      files: Array<{ upstreamPath: string; localPath: string }>;
    };
    assert.ok(source.commit);
    assert.ok(source.files.length > 0);
    assert.match(readFileSync(`${root}/LICENSE.md`, "utf8"), /permission|license/iu);
    for (const file of source.files) {
      assert.ok(existsSync(`${root}/${file.localPath}`));
      assert.ok(notices.includes(file.upstreamPath));
    }
  }
}

function assertSmoothUiContributionGrid(): void {
  const day = (date: string, count: number) => ({
    date,
    count,
    fileCount: count,
    checkCount: 0,
    level: count > 0 ? "low" as const : "none" as const
  });
  const grid = buildHomeContributionGrid([
    day("2026-01-02", 1),
    day("2026-07-01", 2),
    day("2026-12-31", 6)
  ], 2026);
  const cells = grid.weeks.flat();
  assert.equal(grid.weeks.length, HOME_CONTRIBUTION_WEEKS);
  assert.ok(grid.weeks.every((week) => week.length === HOME_CONTRIBUTION_DAYS));
  assert.equal(cells.length, 371);
  assert.equal(cells.filter((cell) => cell.count > 0).length, 3);
  assert.equal(grid.months[0]?.label, "1月");
  assert.equal(grid.months[0]?.startWeek, 1);
  assert.equal(grid.months.some((month) => month.label === "12月" && month.startWeek === 0), false);
  assert.equal(grid.months.reduce((total, month) => total + month.colSpan, 0), 52);
  assert.deepEqual([0, 1, 2, 3, 6].map(homeContributionLevel), [0, 1, 2, 3, 4]);
}

async function assertNativeGraphBehavior(): Promise<void> {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    openTestNoticeMessages.length = 0;
    const reusedLeaf = createGraphLeaf("graph");
    const reused = createGraphApp([reusedLeaf], createGraphLeaf("empty"));
    assert.equal(await openObsidianGraphLeaf(reused.app), true);
    assert.equal(reused.getLeafCalls(), 0);
    assert.deepEqual(reused.revealed, [reusedLeaf]);
    assert.deepEqual(openTestNoticeMessages, []);

    openTestNoticeMessages.length = 0;
    const createdLeaf = createGraphLeaf("empty");
    const created = createGraphApp([], createdLeaf);
    assert.equal(await openObsidianGraphLeaf(created.app), true);
    assert.equal(created.getLeafCalls(), 1);
    assert.deepEqual(createdLeaf.setViewStates, ["graph"]);
    assert.deepEqual(created.revealed, [createdLeaf]);
    assert.deepEqual(openTestNoticeMessages, []);

    openTestNoticeMessages.length = 0;
    const rejectedLeaf = createGraphLeaf("empty", "reject");
    const rejected = createGraphApp([], rejectedLeaf);
    assert.equal(await openObsidianGraphLeaf(rejected.app), false);
    assert.equal(rejected.revealed.length, 0);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生图谱/u);

    openTestNoticeMessages.length = 0;
    const revealRejected = createGraphApp([createGraphLeaf("graph")], createGraphLeaf("empty"), true);
    assert.equal(await openObsidianGraphLeaf(revealRejected.app), false);
    assert.equal(revealRejected.getLeafCalls(), 0);
    assert.equal(revealRejected.revealed.length, 0);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生图谱/u);

    openTestNoticeMessages.length = 0;
    const wrongTypeLeaf = createGraphLeaf("empty", "ignore");
    const wrongType = createGraphApp([], wrongTypeLeaf);
    assert.equal(await openObsidianGraphLeaf(wrongType.app), false);
    assert.deepEqual(wrongType.revealed, [wrongTypeLeaf]);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生图谱/u);

    openTestNoticeMessages.length = 0;
    const localLeaf = createGraphLeaf("empty");
    const local = createLocalGraphApp(localLeaf);
    assert.equal(await openObsidianLocalGraphLeaf(local.app, "wiki/index.md"), true);
    assert.equal(local.getLeafCalls(), 1);
    assert.deepEqual(localLeaf.setViewStates, ["localgraph"]);
    assert.deepEqual(localLeaf.viewStates, [{
      type: "localgraph",
      active: true,
      state: { file: "wiki/index.md" }
    }]);
    assert.deepEqual(local.revealed, [localLeaf]);
    assert.deepEqual(openTestNoticeMessages, []);

    openTestNoticeMessages.length = 0;
    const missingLeaf = createGraphLeaf("empty");
    const missing = createLocalGraphApp(missingLeaf, { indexExists: false });
    assert.equal(await openObsidianLocalGraphLeaf(missing.app, "outputs/index.md"), false);
    assert.equal(missing.getLeafCalls(), 0);
    assert.deepEqual(missingLeaf.setViewStates, []);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /没有在当前 Vault 找到：outputs\/index\.md/u);

    openTestNoticeMessages.length = 0;
    const localRejectedLeaf = createGraphLeaf("empty", "reject");
    const localRejected = createLocalGraphApp(localRejectedLeaf);
    assert.equal(await openObsidianLocalGraphLeaf(localRejected.app, "projects/index.md"), false);
    assert.deepEqual(localRejected.revealed, []);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生局部图谱/u);

    openTestNoticeMessages.length = 0;
    const wrongFileLeaf = createGraphLeaf("empty", "wrong-file");
    const wrongFile = createLocalGraphApp(wrongFileLeaf);
    assert.equal(await openObsidianLocalGraphLeaf(wrongFile.app, "inbox/index.md"), false);
    assert.deepEqual(wrongFile.revealed, []);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生局部图谱/u);

    openTestNoticeMessages.length = 0;
    const localRevealLeaf = createGraphLeaf("empty");
    const localRevealRejected = createLocalGraphApp(localRevealLeaf, { rejectReveal: true });
    assert.equal(await openObsidianLocalGraphLeaf(localRevealRejected.app, "wiki/index.md"), false);
    assert.deepEqual(localRevealRejected.revealed, []);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生局部图谱/u);
  } finally {
    console.warn = originalWarn;
    openTestNoticeMessages.length = 0;
  }
}

interface GraphLeafMock {
  setViewStates: string[];
  viewStates: Array<{ type: string; active?: boolean; state?: Record<string, unknown> }>;
  setViewState(state: { type: string; active?: boolean; state?: Record<string, unknown> }): Promise<void>;
  getViewState(): { type: string; state: Record<string, unknown> };
}

function createGraphLeaf(
  initialType: string,
  behavior: "accept" | "reject" | "ignore" | "wrong-file" = "accept"
): GraphLeafMock {
  let currentType = initialType;
  let currentState: Record<string, unknown> = {};
  const setViewStates: string[] = [];
  const viewStates: Array<{ type: string; active?: boolean; state?: Record<string, unknown> }> = [];
  return {
    setViewStates,
    viewStates,
    async setViewState(state): Promise<void> {
      setViewStates.push(state.type);
      viewStates.push(state);
      if (behavior === "reject") throw new Error("setViewState rejected");
      if (behavior === "accept" || behavior === "wrong-file") {
        currentType = state.type;
        currentState = behavior === "wrong-file" ? { file: "wrong/index.md" } : { ...(state.state ?? {}) };
      }
    },
    getViewState: () => ({ type: currentType, state: currentState })
  };
}

function createGraphApp(existing: GraphLeafMock[], created: GraphLeafMock, rejectReveal = false): {
  app: App;
  revealed: GraphLeafMock[];
  getLeafCalls: () => number;
} {
  const revealed: GraphLeafMock[] = [];
  let getLeafCallCount = 0;
  return {
    app: {
      workspace: {
        getLeavesOfType: (type: string) => {
          assert.equal(type, "graph");
          return existing;
        },
        getLeaf: (mode: string) => {
          assert.equal(mode, "tab");
          getLeafCallCount += 1;
          return created;
        },
        revealLeaf: async (leaf: GraphLeafMock) => {
          if (rejectReveal) throw new Error("revealLeaf rejected");
          revealed.push(leaf);
        }
      }
    } as unknown as App,
    revealed,
    getLeafCalls: () => getLeafCallCount
  };
}

function createLocalGraphApp(
  created: GraphLeafMock,
  options: { indexExists?: boolean; rejectReveal?: boolean } = {}
): {
  app: App;
  revealed: GraphLeafMock[];
  getLeafCalls: () => number;
} {
  const revealed: GraphLeafMock[] = [];
  let getLeafCallCount = 0;
  return {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => options.indexExists === false ? null : new TFile(path)
      },
      workspace: {
        getLeaf: (mode: string) => {
          assert.equal(mode, "tab");
          getLeafCallCount += 1;
          return created;
        },
        revealLeaf: async (leaf: GraphLeafMock) => {
          if (options.rejectReveal) throw new Error("revealLeaf rejected");
          revealed.push(leaf);
        }
      }
    } as unknown as App,
    revealed,
    getLeafCalls: () => getLeafCallCount
  };
}

function assertFixedEntryAndTemplateContracts(): void {
  assert.deepEqual(HOME_ENTRY_IDS, ["wiki", "outputs", "projects", "inbox", "journal", "review"]);
  assert.equal(HOME_ENTRY_IDS.includes("raw" as never), false);
  assert.deepEqual(HOME_ENTRY_INDEX_PATHS, {
    wiki: "wiki/index.md",
    outputs: "outputs/index.md",
    projects: "projects/index.md",
    inbox: "inbox/index.md"
  });
  assert.equal(homeEntryIndexPath("wiki"), "wiki/index.md");
  assert.equal(homeEntryIndexPath("journal"), null);
  assert.equal(homeEntryIndexPath("review"), null);
  assert.equal(DEFAULT_JOURNAL_TEMPLATE_ID, "quick");
  assert.deepEqual(BUILT_IN_JOURNAL_TEMPLATES.map((template) => template.id), ["quick", "morning", "evening", "blank"]);
  assert.equal(BUILT_IN_JOURNAL_TEMPLATES[0]?.name, "此刻速记");
}

function assertActivityAndJournalCalendar(): void {
  const records = fixtureRecords();
  const now = new Date(2026, 7, 31, 12, 0, 0);
  const activity = buildHomeActivityDays(records, { now, days: 3 });
  assert.deepEqual(activity.map((day) => day.date), ["2026-08-29", "2026-08-30", "2026-08-31"]);
  assert.equal(activity.at(-1)?.count, 2);
  const journalRecords: HomeVaultFileRecord[] = [{
    path: "journal/2026-08-31.md",
    title: "2026-08-31",
    folder: "journal",
    mtime: now.getTime(),
    firstImagePath: "assets/today.png",
    firstImageUrl: "app://local/assets/today.png"
  }, {
    path: "journal/2026-09-01.md",
    title: "2026-09-01",
    folder: "journal",
    mtime: now.getTime()
  }];
  const days = buildHomeJournalDays(journalRecords, activity, now);
  assert.equal(days.length, 42);
  assert.deepEqual(days.find((day) => day.date === "2026-08-31"), {
    date: "2026-08-31",
    path: "journal/2026-08-31.md",
    exists: true,
    activityCount: 2,
    firstImagePath: "assets/today.png",
    firstImageUrl: "app://local/assets/today.png"
  });
  assert.equal(days.find((day) => day.date === "2026-09-01")?.exists, true);
  const merged = mergeHomeActivityDays(activity, [{ date: "2026-08-31", checks: 2 }]);
  assert.deepEqual(
    merged.find((day) => day.date === "2026-08-31"),
    { date: "2026-08-31", count: 4, fileCount: 2, checkCount: 2, level: "mid" }
  );
  assert.equal(journalPathForDate(now), "journal/2026-08/2026-08-31.md");
  assert.equal(journalPathForDate(now, "Notes/Daily"), "Notes/Daily/2026-08/2026-08-31.md");
  assert.equal(journalDateFromPath("Notes/Daily/2026-08-31.md", "Notes/Daily"), "2026-08-31");
  assert.equal(journalDateFromPath("Notes/Daily/archive/2026-08-31.md", "Notes/Daily"), null);

  const customDays = buildHomeJournalDays([{
    ...journalRecords[0]!,
    path: "Notes/Daily/2026-08-31.md",
    folder: "Notes/Daily"
  }], activity, now, "Notes/Daily");
  assert.equal(customDays.find((day) => day.date === "2026-08-31")?.path, "Notes/Daily/2026-08-31.md");
}

async function assertCustomJournalDirectoryBehavior(): Promise<void> {
  assert.equal(DEFAULT_JOURNAL_DIRECTORY, "journal");
  for (const invalid of [undefined, null, "", "   ", ".", "..", "../outside", "daily/../outside", "/journal", "C:/journal", "C:journal", "\\\\server\\journal"]) {
    assert.equal(normalizeJournalDirectory(invalid), "journal", String(invalid));
  }
  assert.equal(normalizeJournalDirectory(" Notes\\Daily// "), "Notes/Daily");

  const folders = new Set<string>();
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const createdFolders: string[] = [];
  const makeFile = (path: string): TFile => Object.assign(new TFile(path), {
    basename: path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path,
    parent: { path: path.slice(0, path.lastIndexOf("/")) },
    stat: { mtime: new Date(2026, 8, 4, 10, 0).getTime() }
  });
  const app = {
    vault: {
      getMarkdownFiles: () => Array.from(files.values()),
      getAllLoadedFiles: () => [
        ...Array.from(folders, (path) => Object.assign(new TFolder(), { path })),
        ...files.values()
      ],
      getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
      createFolder: async (path: string) => {
        createdFolders.push(path);
        folders.add(path);
      },
      create: async (path: string, content: string) => {
        const file = makeFile(path);
        files.set(path, file);
        contents.set(path, content);
        return file;
      },
      read: async (file: TFile) => contents.get(file.path) ?? "",
      getResourcePath: (file: TFile) => `app://local/${file.path}`
    },
    metadataCache: {
      getFileCache: () => null,
      getFirstLinkpathDest: () => null
    }
  } as unknown as App;
  const service = new HomeWorkbenchDataService(app, () => " Notes\\Daily// ");

  assert.equal(service.getJournalDirectory(), "Notes/Daily");
  assert.equal(await service.ensureJournalDirectory(), "Notes/Daily");
  assert.deepEqual(createdFolders, ["Notes", "Notes/Daily"]);

  const date = new Date(2026, 8, 4, 10, 0);
  const created = await service.createOrOpenJournal(defaultJournalTemplateChoice(), date);
  assert.equal(created.created, true);
  assert.equal(created.file.path, "Notes/Daily/2026-09/2026-09-04.md");
  assert.match(contents.get(created.file.path) ?? "", /2026-09-04/u);
  const reopened = await service.createOrOpenJournal(defaultJournalTemplateChoice(), date);
  assert.equal(reopened.created, false);
  assert.equal(reopened.file, created.file);

  const data = await service.build(date);
  assert.equal(data.entries.find((entry) => entry.id === "journal")?.count, 1);
  assert.equal(data.entries.find((entry) => entry.id === "journal")?.targetPath, created.file.path);
  assert.equal(data.journalDays.find((day) => day.date === "2026-09-04")?.exists, true);

  const fallback = new HomeWorkbenchDataService(app, () => "../outside");
  assert.equal(fallback.getJournalDirectory(), KNOWLEDGE_ROOT_NAMES.journal);
  assert.equal(fallback.journalPathForDate(date), `${KNOWLEDGE_ROOT_NAMES.journal}/2026-09/2026-09-04.md`);
  folders.add("journal");
  assert.equal(fallback.getJournalDirectory(), "journal");
  assert.equal(fallback.journalPathForDate(date), "journal/2026-09/2026-09-04.md");
}

function assertImageExtraction(): void {
  assert.equal(extractFirstLocalImageTarget("![[assets/first.webp|300]]"), "assets/first.webp");
  assert.equal(extractFirstLocalImageTarget("![封面](assets/cover.png \"标题\")"), "assets/cover.png");
  assert.equal(extractFirstLocalImageTarget("![远程](https://example.com/image.png)"), null);
  assert.equal(extractFirstLocalImageTarget("普通文本"), null);
}

function assertTemplateImportAndPlaceholderPreservation(): void {
  const source = [
    "---",
    "mood: calm",
    "custom-field: keep",
    "---",
    "# {{date}}",
    "",
    "```ts",
    "const token = '{{unknown}}';",
    "```",
    "{{time}} / {{custom-placeholder}}"
  ].join("\n");
  const parsed = parseImportedJournalTemplate("我的/模板.md", source);
  assert.equal(parsed.name, "我的-模板");
  assert.deepEqual(parsed.frontmatterKeys, ["mood", "custom-field"]);
  assert.equal(importedTemplatePath(parsed.name), "templates/journal/我的-模板.md");
  assert.throws(() => parseImportedJournalTemplate("template.txt", source), /只支持本地 \.md/u);
  assert.throws(() => parseImportedJournalTemplate("template.md", "bad\0value"), /空字符/u);

  const applied = applyJournalTemplate(source, new Date(2026, 7, 31, 9, 7, 0));
  assert.match(applied, /# 2026-08-31/u);
  assert.match(applied, /09:07 \/ \{\{custom-placeholder\}\}/u);
  assert.match(applied, /const token = '\{\{unknown\}\}'/u);
  assert.match(applied, /custom-field: keep/u);

  const existing = new Set(["templates/journal/我的-模板.md", "templates/journal/我的-模板-副本-2.md"]);
  assert.equal(nextAvailableImportedTemplatePath(parsed.name, existing), "templates/journal/我的-模板-副本-3.md");
}

function assertReviewRecognitionAndUtf8Import(): void {
  assert.equal(isKnowledgeBaseReviewPath("outputs/knowledge-base-review-2026-08-31.md"), true);
  assert.equal(isKnowledgeBaseReviewPath("outputs/reviews/knowledge-base-review-2026-08-24.md"), true);
  assert.equal(isKnowledgeBaseReviewPath("outputs/agent-chat-review-2026-08-31.md"), false);
  const crlf = "---\r\ntitle: test\r\n---\r\n\r\n# {{date}}\r\n";
  const encoded = new TextEncoder().encode(crlf);
  assert.equal(decodeImportedMarkdown(encoded.buffer), crlf);
  assert.equal(parseImportedJournalTemplate("blank.md", "").content, "");
  assert.throws(
    () => decodeImportedMarkdown(new Uint8Array([0xc3, 0x28]).buffer),
    /UTF-8/u
  );
}

function fixtureRecords(): HomeVaultFileRecord[] {
  const day = (date: string) => new Date(`${date}T12:00:00`).getTime();
  return [
    {
      path: "projects/a.md",
      title: "Knowledge Map",
      folder: "projects",
      mtime: day("2026-08-31")
    },
    {
      path: "projects/b.md",
      title: "Workbench",
      folder: "projects",
      mtime: day("2026-08-31")
    },
    {
      path: "wiki/c.md",
      title: "Reference",
      folder: "wiki",
      mtime: day("2026-08-30")
    },
    {
      path: "inbox/d.md",
      title: "Unsorted",
      folder: "inbox",
      mtime: day("2026-08-29")
    }
  ];
}

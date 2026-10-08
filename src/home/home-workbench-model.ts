import type { SettingsLanguage } from "../settings/settings";
import { moment } from "obsidian";
import { DEFAULT_JOURNAL_DATE_FORMAT, QUICK_JOURNAL_TEMPLATE, renderNativeJournalTemplate } from "./native-journal";
import { homeContributionMonthLabel, homeCopy } from "./home-i18n";
import { knowledgeRootRole } from "../knowledge-base/root-paths";
import {
  DEFAULT_JOURNAL_DIRECTORY,
  normalizeJournalDirectory
} from "./journal-directory";

export const HOME_ENTRY_IDS = ["wiki", "outputs", "projects", "inbox", "journal", "review"] as const;
export type HomeEntryId = (typeof HOME_ENTRY_IDS)[number];

export interface HomeVaultFileRecord {
  path: string;
  title: string;
  folder: string;
  mtime: number;
  ctime?: number;
  firstImagePath?: string;
  firstImageUrl?: string;
}

/** Recent notes use core knowledge roots and the actual configured journal folder. */
export function isHomeRecentNotePath(path: string, journalDirectory: string): boolean {
  const relativePath = path.replace(/\\/gu, "/");
  const role = knowledgeRootRole(relativePath);
  return role === "wiki" || role === "raw" || role === "outputs"
    || relativePath.startsWith(`${normalizeJournalDirectory(journalDirectory)}/`);
}

export interface HomeActivityDay {
  date: string;
  count: number;
  fileCount: number;
  checkCount: number;
  level: "none" | "low" | "mid" | "high";
}

export type HomeContributionLevel = 0 | 1 | 2 | 3 | 4;

export interface HomeContributionCell {
  date: string;
  count: number;
  fileCount: number;
  checkCount: number;
  level: HomeContributionLevel;
}

export interface HomeContributionMonthHeader {
  label: string;
  colSpan: number;
  startWeek: number;
}

export interface HomeContributionGrid {
  year: number;
  weeks: HomeContributionCell[][];
  months: HomeContributionMonthHeader[];
}

export const HOME_CONTRIBUTION_WEEKS = 53;
export const HOME_CONTRIBUTION_DAYS = 7;

export interface HomeJournalDay {
  date: string;
  path?: string;
  exists: boolean;
  activityCount: number;
  firstImagePath?: string;
  firstImageUrl?: string;
}

export interface JournalTemplateDefinition {
  id: "quick" | "morning" | "evening" | "blank";
  name: string;
  description: string;
  content: string;
}

export interface ImportedJournalTemplate {
  name: string;
  sourceFileName: string;
  content: string;
  frontmatterKeys: string[];
  lineCount: number;
}

export const DEFAULT_JOURNAL_TEMPLATE_ID = "quick" as const;
export const JOURNAL_DIRECTORY = DEFAULT_JOURNAL_DIRECTORY;
export const JOURNAL_TEMPLATE_DIRECTORY = "templates/journal";

export const BUILT_IN_JOURNAL_TEMPLATES: readonly JournalTemplateDefinition[] = Object.freeze([
  {
    id: "quick",
    name: "此刻速记",
    description: "一句话也可以，系统始终默认",
    content: QUICK_JOURNAL_TEMPLATE
  },
  {
    id: "morning",
    name: "晨间定向",
    description: "能量、脑内清空、今天最重要的一件事",
    content: [
      "---",
      "date: {{date}}",
      "template: 晨间定向",
      "tags:",
      "  - journal",
      "---",
      "",
      "# {{date}} 晨间定向",
      "",
      "## 此刻的能量与心情",
      "",
      "## 脑内清空",
      "",
      "## 今天真正重要的一件事",
      "",
      "## 现在能开始的第一步",
      "",
      ""
    ].join("\n")
  },
  {
    id: "evening",
    name: "晚间收束",
    description: "重要片段、完成事项和明早第一步",
    content: [
      "---",
      "date: {{date}}",
      "template: 晚间收束",
      "tags:",
      "  - journal",
      "---",
      "",
      "# {{date}} 晚间收束",
      "",
      "## 用一句话概括今天",
      "",
      "## 想留下的重要片段",
      "",
      "## 今天做成了什么",
      "",
      "## 明早的第一步",
      "",
      ""
    ].join("\n")
  },
  {
    id: "blank",
    name: "空白",
    description: "只创建日期标题",
    content: "# {{date}}\n"
  }
]);

export function buildHomeActivityDays(
  records: readonly Pick<HomeVaultFileRecord, "mtime">[],
  options: { now?: Date; days?: number } = {}
): HomeActivityDay[] {
  const now = options.now ? new Date(options.now) : new Date();
  const days = Math.max(1, options.days ?? 365);
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = dateKey(new Date(record.mtime));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const key = dateKey(date);
    const count = counts.get(key) ?? 0;
    return { date: key, count, fileCount: count, checkCount: 0, level: activityLevel(count) };
  });
}

export function mergeHomeActivityDays(
  fileDays: readonly HomeActivityDay[],
  maintenanceDays: readonly { date: string; checks: number }[]
): HomeActivityDay[] {
  const checksByDate = new Map(maintenanceDays.map((day) => [day.date, Math.max(0, day.checks)]));
  return fileDays.map((day) => {
    const fileCount = day.fileCount;
    const checkCount = checksByDate.get(day.date) ?? 0;
    const count = fileCount + checkCount;
    return { ...day, count, fileCount, checkCount, level: activityLevel(count) };
  });
}

/**
 * Native DOM data adapter for SmoothUI Contribution Graph.
 * Upstream: https://github.com/educlopez/smoothui/blob/1143ba66738566e8acb9a3f8a7db9eab3f10f2d4/packages/smoothui/components/contribution-graph/index.tsx
 * Mapping: 53 Sunday-based weeks, seven weekday rows, grouped month headers
 * and the upstream five contribution levels. Rendering remains Obsidian-native.
 */
export function buildHomeContributionGrid(
  activity: readonly HomeActivityDay[],
  year: number,
  language: SettingsLanguage = "zh-CN"
): HomeContributionGrid {
  const byDate = new Map(activity.map((day) => [day.date, day]));
  const firstDay = new Date(year, 0, 1);
  const firstSunday = new Date(year, 0, 1 - firstDay.getDay());
  const weeks = Array.from({ length: HOME_CONTRIBUTION_WEEKS }, (_, weekIndex) =>
    Array.from({ length: HOME_CONTRIBUTION_DAYS }, (_, dayIndex) => {
      const date = new Date(
        firstSunday.getFullYear(),
        firstSunday.getMonth(),
        firstSunday.getDate() + weekIndex * HOME_CONTRIBUTION_DAYS + dayIndex
      );
      const key = dateKey(date);
      const day = byDate.get(key);
      const count = day?.count ?? 0;
      return {
        date: key,
        count,
        fileCount: day?.fileCount ?? 0,
        checkCount: day?.checkCount ?? 0,
        level: homeContributionLevel(count)
      };
    })
  );

  const months: HomeContributionMonthHeader[] = [];
  let currentMonth = -1;
  let currentYear = -1;
  let monthStartWeek = 0;
  let weekCount = 0;
  for (let weekIndex = 0; weekIndex < HOME_CONTRIBUTION_WEEKS; weekIndex += 1) {
    const start = weeks[weekIndex][0];
    const date = new Date(`${start.date}T12:00:00`);
    const month = date.getMonth();
    const weekYear = date.getFullYear();
    if (month !== currentMonth || weekYear !== currentYear) {
      if (currentMonth !== -1 && shouldShowHomeContributionMonthHeader({
        currentMonth,
        currentYear,
        startDateDay: firstDay.getDay(),
        targetYear: year,
        weekCount
      })) {
        months.push({
          label: homeContributionMonthLabel(currentMonth, language),
          colSpan: weekCount,
          startWeek: monthStartWeek
        });
      }
      currentMonth = month;
      currentYear = weekYear;
      monthStartWeek = weekIndex;
      weekCount = 1;
    } else {
      weekCount += 1;
    }
  }
  if (currentMonth !== -1 && shouldShowHomeContributionMonthHeader({
    currentMonth,
    currentYear,
    startDateDay: firstDay.getDay(),
    targetYear: year,
    weekCount
  })) {
    months.push({
      label: homeContributionMonthLabel(currentMonth, language),
      colSpan: weekCount,
      startWeek: monthStartWeek
    });
  }
  return { year, weeks, months };
}

function shouldShowHomeContributionMonthHeader(options: {
  currentMonth: number;
  currentYear: number;
  startDateDay: number;
  targetYear: number;
  weekCount: number;
}): boolean {
  return options.currentYear === options.targetYear
    || (options.currentYear === options.targetYear - 1
      && options.currentMonth === 11
      && options.startDateDay !== 0
      && options.weekCount >= 2);
}

export function homeContributionLevel(count: number): HomeContributionLevel {
  if (count >= 6) return 4;
  if (count >= 3) return 3;
  if (count >= 2) return 2;
  if (count >= 1) return 1;
  return 0;
}

export function buildHomeJournalDays(
  records: readonly HomeVaultFileRecord[],
  activity: readonly HomeActivityDay[],
  visibleMonth: Date,
  journalDirectory = DEFAULT_JOURNAL_DIRECTORY,
  journalFormat = DEFAULT_JOURNAL_DATE_FORMAT
): HomeJournalDay[] {
  const activityByDate = new Map(activity.map((day) => [day.date, day.count]));
  const journalByDate = new Map<string, HomeVaultFileRecord>();
  for (const record of records) {
    const date = journalDateFromPath(record.path, journalDirectory, journalFormat);
    if (date) journalByDate.set(date, record);
  }
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = dateKey(new Date(year, month, index - offset + 1));
    const journal = journalByDate.get(date);
    return {
      date,
      path: journal?.path,
      exists: Boolean(journal),
      activityCount: activityByDate.get(date) ?? 0,
      firstImagePath: journal?.firstImagePath,
      firstImageUrl: journal?.firstImageUrl
    };
  });
}

export function journalDateFromPath(
  path: string,
  journalDirectory = DEFAULT_JOURNAL_DIRECTORY,
  journalFormat = DEFAULT_JOURNAL_DATE_FORMAT
): string | null {
  const normalizedPath = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  const directory = normalizeJournalDirectory(journalDirectory);
  const prefix = `${directory}/`;
  if (!normalizedPath.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return null;
  if (!normalizedPath.endsWith(".md")) return null;
  const name = normalizedPath.slice(prefix.length, -3);
  for (const format of [journalFormat, DEFAULT_JOURNAL_DATE_FORMAT, "YYYY-MM-DD"]) {
    const parsed = moment(name, format, true);
    if (parsed.isValid() && parsed.format(format) === name) return parsed.format("YYYY-MM-DD");
  }
  return null;
}

export function journalPathForDate(
  date: Date,
  journalDirectory = DEFAULT_JOURNAL_DIRECTORY
): string {
  return `${normalizeJournalDirectory(journalDirectory)}/${moment(date).format(DEFAULT_JOURNAL_DATE_FORMAT)}.md`;
}

export function extractFirstLocalImageTarget(markdown: string): string | null {
  const wiki = markdown.match(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/u)?.[1]?.trim();
  if (wiki && isLocalImageTarget(wiki)) return wiki;
  const standard = markdown.match(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/u)?.[1]?.trim();
  if (standard && isLocalImageTarget(standard)) return standard;
  return null;
}

export function parseImportedJournalTemplate(
  fileName: string,
  content: string,
  language: SettingsLanguage = "zh-CN"
): ImportedJournalTemplate {
  const copy = homeCopy(language);
  if (!/\.md$/iu.test(fileName)) throw new Error(copy.template.unsupportedMarkdown);
  if (content.includes("\0")) throw new Error(copy.template.containsNullCharacter);
  const name = sanitizeTemplateName(fileName.replace(/\.md$/iu, ""));
  return {
    name,
    sourceFileName: fileName,
    content,
    frontmatterKeys: extractFrontmatterKeys(content),
    lineCount: content ? content.split(/\r?\n/u).length : 0
  };
}

export function decodeImportedMarkdown(bytes: ArrayBuffer, language: SettingsLanguage = "zh-CN"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(homeCopy(language).template.invalidUtf8);
  }
}

export function isKnowledgeBaseReviewPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? "";
  return /^knowledge-base-review-.+\.md$/iu.test(basename);
}

export function importedTemplatePath(name: string): string {
  return `${JOURNAL_TEMPLATE_DIRECTORY}/${sanitizeTemplateName(name)}.md`;
}

export function nextAvailableImportedTemplatePath(
  name: string,
  existingPaths: ReadonlySet<string>,
  language: SettingsLanguage = "zh-CN"
): string {
  const base = sanitizeTemplateName(name);
  const first = importedTemplatePath(base);
  if (!existingPaths.has(first)) return first;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = importedTemplatePath(`${base}-副本-${index}`);
    if (!existingPaths.has(candidate)) return candidate;
  }
  throw new Error(homeCopy(language).template.safeCopyUnavailable);
}

export function applyJournalTemplate(content: string, date: Date): string {
  const values: Record<string, string> = {
    date: dateKey(date),
    time: timeKey(date),
    datetime: `${dateKey(date)} ${timeKey(date)}`,
    title: dateKey(date)
  };
  return renderNativeJournalTemplate(content, date, dateKey(date))
    .replace(/\{\{(date|time|datetime|title)\}\}/gu, (_, key: keyof typeof values) => values[key]);
}

export function mostRecentRecordInFolder(records: readonly HomeVaultFileRecord[], folder: string): HomeVaultFileRecord | null {
  const normalized = normalizeText(folder);
  return records
    .filter((record) => normalizeText(record.folder) === normalized || normalizeText(record.folder).startsWith(`${normalized}/`))
    .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path))[0] ?? null;
}

export function countRecordsInFolder(records: readonly HomeVaultFileRecord[], folder: string): number {
  const normalized = normalizeText(folder);
  return records.filter((record) => {
    const current = normalizeText(record.folder);
    return current === normalized || current.startsWith(`${normalized}/`);
  }).length;
}

export function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeText(value: string): string {
  return value.trim().replace(/^#/u, "").toLocaleLowerCase();
}

function sanitizeTemplateName(value: string): string {
  const safe = value.trim().replace(/[\\/:*?"<>|]/gu, "-").replace(/\s+/gu, " ").replace(/^\.+|\.+$/gu, "");
  return safe || "导入模板";
}

function extractFrontmatterKeys(content: string): string[] {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return [];
  return [...new Set(
    match[1]
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Za-z0-9_-]+)\s*:/u)?.[1] ?? "")
      .filter(Boolean)
  )];
}

function isLocalImageTarget(target: string): boolean {
  if (/^(?:https?:|data:|file:|obsidian:)/iu.test(target)) return false;
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(target.split(/[?#]/u)[0] ?? "");
}

function activityLevel(count: number): HomeActivityDay["level"] {
  if (count >= 6) return "high";
  if (count >= 3) return "mid";
  if (count >= 1) return "low";
  return "none";
}

function timeKey(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

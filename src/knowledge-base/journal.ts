import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface JournalDailyTarget {
  targetDate: Date;
  dateKey: string;
  monthKey: string;
  yearKey: string;
  weekday: string;
  rootPath: string;
  dailyRootPath: string;
  relativePath: string;
  absolutePath: string;
  templateDirectories: string[];
  samplePaths: string[];
  codexSessionsPath: string;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DEFAULT_JOURNAL_ROOT = "journal";
const DEFAULT_DAILY_ROOT = "journal/daily";

export function stripJournalPrefix(value: string): string {
  return value.replace(/^(\/journal|\/daily|\/diary|\/日记|写日记|记日记|日报|journal)[:：\s]*/i, "").trim();
}

export async function resolveJournalDailyTarget(vaultPath: string, userRequest: string, now = new Date()): Promise<JournalDailyTarget> {
  const targetDate = parseJournalTargetDate(userRequest, now);
  const dateKey = formatDate(targetDate);
  const monthKey = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}`;
  const yearKey = String(targetDate.getFullYear());
  const weekday = WEEKDAYS[targetDate.getDay()];
  const layout = await detectJournalLayout(vaultPath);
  const dailyDir = layout.useMonthFolders ? `${layout.dailyRootPath}/${monthKey}` : layout.dailyRootPath;
  const relativePath = normalizeSlashes(`${dailyDir}/${dateKey}-${weekday}.md`);
  return {
    targetDate,
    dateKey,
    monthKey,
    yearKey,
    weekday,
    rootPath: layout.rootPath,
    dailyRootPath: layout.dailyRootPath,
    relativePath,
    absolutePath: path.join(vaultPath, relativePath),
    templateDirectories: buildJournalTemplateDirectories(layout.rootPath, layout.dailyRootPath, monthKey, yearKey),
    samplePaths: await collectRecentJournalSamples(vaultPath, layout.dailyRootPath, relativePath),
    codexSessionsPath: path.join(os.homedir(), ".codex", "sessions")
  };
}

export async function ensureJournalTargetFolders(vaultPath: string, target: Pick<JournalDailyTarget, "templateDirectories" | "absolutePath">): Promise<void> {
  for (const dir of target.templateDirectories) {
    await fsp.mkdir(path.join(vaultPath, dir), { recursive: true });
  }
  await fsp.mkdir(path.dirname(target.absolutePath), { recursive: true });
}

export function buildKnowledgeBaseJournalPrompt(input: {
  vaultPath: string;
  userRequest: string;
  target: JournalDailyTarget;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  return [
    "你正在执行 Codex Obsidian Daily Journal。",
    "",
    "这个任务默认不是生活散文，而是把方哥当天在 Codex 里实际推进的工作写进 Obsidian 日记。",
    "必须使用中文，先给结论，再给关键依据；不要写空话，不要把命令流水账原样塞进去。",
    "",
    "## 用户原始指令",
    input.userRequest.trim() || "写日记",
    "",
    "## 目标 Vault",
    input.vaultPath,
    "",
    "## 目标日记文件",
    `- 日期：${input.target.dateKey} ${input.target.weekday}`,
    `- 文件：${input.target.relativePath}`,
    `- 日记根目录：${input.target.rootPath}`,
    `- Daily 根目录：${input.target.dailyRootPath}`,
    "",
    "## 当前 journal 目录模板",
    ...input.target.templateDirectories.map((dir) => `- ${dir}`),
    "",
    "## 最近日记样本",
    ...(input.target.samplePaths.length
      ? input.target.samplePaths.map((sample) => `- ${sample}`)
      : ["- 未找到历史样本；使用下面的兜底格式。"]),
    "",
    "## 执行步骤",
    `1. 先读取最近日记样本，沿用它们的 YAML、标题、分节和语气。`,
    `2. 读取 Codex 会话记录：${input.target.codexSessionsPath}/${input.target.dateKey.replace(/-/g, "/")}/*.jsonl。`,
    "3. 如果目标日凌晨 00:00-02:30 仍是前一段连续工作，可合并进前一天；否则严格按目标日期写。",
    "4. 补看当天 Obsidian Vault、当前工作目录和相关 outputs 里真实新增或更新的关键文件，避免只看聊天。",
    "5. 如果目标日记已存在，只做增量更新；保留用户原文，不要删旧内容，不要重复写同一件事。",
    "6. 如果目标日记不存在，创建父目录并写入目标文件；不要写到扁平路径 journal/daily/YYYY-MM-DD.md。",
    "",
    "## 新文件兜底格式",
    "---",
    "banner: \"\"",
    `created: ${input.target.dateKey}`,
    `updated: ${formatDateTimeLocal(generatedAt)}`,
    "tags:",
    "  - 日记",
    "---",
    "",
    `# ${input.target.dateKey} ${input.target.weekday}`,
    "",
    "---",
    "",
    "## 🚶 行动轨迹",
    "",
    "### 今天主要做的事",
    "",
    "## ⭐ 今日重大事件",
    "",
    "## ✅ 今日待办",
    "",
    "## 💭 今日思考",
    "",
    "## 📖 读书心得（无则删）",
    "",
    "## 写作要求",
    "- 重点写今天真实做成了什么、做出什么决定、产出哪些文件或资源。",
    "- 内容不够就短一点；证据不足就明确少写，不要编造。",
    "- 如果用户只是说“写日记”，也要自动执行，不要反问。",
    "- 最终必须把日记写入目标文件。",
    "",
    "## 完成后回复",
    `只简短说明已写入：${input.target.relativePath}`,
    "",
    "开始执行。"
  ].join("\n");
}

function parseJournalTargetDate(userRequest: string, now: Date): Date {
  const normalized = userRequest.trim();
  const explicit = normalized.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (explicit) return localDate(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]), now);
  const monthDay = normalized.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日?/);
  if (monthDay) return localDate(now.getFullYear(), Number(monthDay[1]), Number(monthDay[2]), now);
  if (/前天/.test(normalized)) return addDays(now, -2);
  if (/昨天/.test(normalized)) return addDays(now, -1);
  if (/明天/.test(normalized)) return addDays(now, 1);
  return localDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), now);
}

function localDate(year: number, month: number, day: number, sourceTime: Date): Date {
  return new Date(year, month - 1, day, sourceTime.getHours(), sourceTime.getMinutes(), sourceTime.getSeconds(), sourceTime.getMilliseconds());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

async function detectJournalLayout(vaultPath: string): Promise<{ rootPath: string; dailyRootPath: string; useMonthFolders: boolean }> {
  const candidates = [
    { rootPath: DEFAULT_JOURNAL_ROOT, dailyRootPath: DEFAULT_DAILY_ROOT },
    { rootPath: "01-日记", dailyRootPath: "01-日记" }
  ];
  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const root = path.join(vaultPath, candidate.rootPath);
    const dailyRoot = path.join(vaultPath, candidate.dailyRootPath);
    const score = Number(await exists(root)) * 10
      + Number(await exists(dailyRoot)) * 20
      + await countMonthDirs(dailyRoot) * 5
      + await countMarkdownFiles(dailyRoot, 20);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const dailyRootAbsolute = path.join(vaultPath, best.dailyRootPath);
  const monthDirCount = await countMonthDirs(dailyRootAbsolute);
  const flatFileCount = await countFlatDailyFiles(dailyRootAbsolute);
  return {
    ...best,
    useMonthFolders: monthDirCount > 0 || flatFileCount === 0
  };
}

function buildJournalTemplateDirectories(rootPath: string, dailyRootPath: string, monthKey: string, yearKey: string): string[] {
  if (rootPath === "01-日记") {
    return [rootPath, `${dailyRootPath}/${monthKey}`].map(normalizeSlashes);
  }
  return [
    rootPath,
    dailyRootPath,
    `${dailyRootPath}/${monthKey}`,
    `${rootPath}/weekly`,
    `${rootPath}/monthly`,
    `${rootPath}/monthly/${yearKey}`,
    `${rootPath}/quarterly`,
    `${rootPath}/yearly`
  ].map(normalizeSlashes);
}

async function collectRecentJournalSamples(vaultPath: string, dailyRootPath: string, targetRelativePath: string): Promise<string[]> {
  const root = path.join(vaultPath, dailyRootPath);
  const files = await walkMarkdownFiles(root).catch(() => []);
  const stats = await Promise.all(files.map(async (file) => ({
    file,
    mtime: await fsp.stat(file).then((item) => item.mtimeMs, () => 0)
  })));
  return stats
    .map((item) => ({ ...item, relativePath: normalizeSlashes(path.relative(vaultPath, item.file)) }))
    .filter((item) => item.relativePath !== targetRelativePath && /\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-周[一二三四五六日]\.md$/.test(`/${item.relativePath}`))
    .sort((left, right) => right.mtime - left.mtime || right.relativePath.localeCompare(left.relativePath))
    .slice(0, 3)
    .map((item) => item.relativePath);
}

async function countMonthDirs(dir: string): Promise<number> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)).length;
}

async function countFlatDailyFiles(dir: string): Promise<number> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}(?:-周[一二三四五六日])?\.md$/.test(entry.name)).length;
}

async function countMarkdownFiles(dir: string, limit: number): Promise<number> {
  const files = await walkMarkdownFiles(dir, limit).catch(() => []);
  return files.length;
}

async function walkMarkdownFiles(dir: string, limit = 200): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    if (result.length >= limit) return;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(full);
    }
  }
  await walk(dir);
  return result;
}

async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeLocal(date: Date): string {
  return `${formatDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

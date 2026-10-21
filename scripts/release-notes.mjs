import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const releaseTypes = {
  feat: { zh: "新功能", en: "New" },
  improve: { zh: "体验改进", en: "Improved" },
  fix: { zh: "修复", en: "Fixes" }
};

export function extractChangelogSection(source, version) {
  requireContract(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version), "Release version must use x.y.z SemVer.");
  const normalized = source.replace(/\r\n?/gu, "\n");
  const headings = [...normalized.matchAll(new RegExp(`^## v?${escapeRegExp(version)}(?: - [^\\n]+)?$`, "gmu"))];
  requireContract(headings.length <= 1, `CHANGELOG.md must contain only one section for ${version}.`);
  if (!headings.length) return null;
  const heading = headings[0];
  const rest = normalized.slice(heading.index + heading[0].length);
  const nextHeading = /^## /mu.exec(rest);
  return { heading: heading[0], body: rest.slice(0, nextHeading?.index ?? rest.length).trim() };
}

export function compileReleaseNotes(source, { version, repository, isTrackedFile, historical = false }) {
  const section = extractChangelogSection(source, version);
  if (!section) {
    requireContract(historical, `CHANGELOG.md must contain a section for ${version}.`);
    return null;
  }
  const lines = section.body.split("\n");
  const located = lines.map((line, index) => ({ line, index }));
  const zh = located.filter(({ line }) => line === "### 中文");
  const en = located.filter(({ line }) => line === "### English");
  requireContract(zh.length === 1 && en.length === 1 && zh[0].index < en[0].index,
    "Release notes must contain exactly one Chinese section before exactly one English section.");
  const zhIndex = zh[0].index;
  const enIndex = en[0].index;
  const images = located.filter(({ line, index }) => index < zhIndex && /^!\[/u.test(line));
  // Fix releases may ship without a hero; feat/improve (and historical) still require exactly one.
  const heroOptional = !historical && /^<!-- release-type: fix -->$/mu.test(section.body);
  requireContract(images.length === 1 || (heroOptional && images.length === 0),
    "Release notes must contain one hero image before the Chinese section.");
  const heroPath = images.length ? validateHero(images[0].line, repository, isTrackedFile) : "";

  // Historical dispatch only rebuilds and attests existing assets. Its older
  // CHANGELOG format must not acquire new title/type requirements or edits.
  if (historical) return { title: "", englishTitle: "", type: "", heroPath, body: `${section.heading}\n\n${section.body}\n` };

  requireContract(new RegExp(`^## ${escapeRegExp(version)} - \\d{4}-\\d{2}-\\d{2}$`, "u").test(section.heading),
    "New CHANGELOG sections must use ## <version> - YYYY-MM-DD.");
  const markers = [...section.body.matchAll(/<!--\s*release-type\b/giu)];
  requireContract(markers.length === 1, "Release notes must contain exactly one release-type marker.");
  const marker = located.find(({ line }) => /^<!-- release-type: (feat|improve|fix) -->$/u.test(line));
  requireContract(marker, "Release type marker must be a standalone <!-- release-type: feat|improve|fix --> line.");
  const type = /^<!-- release-type: (feat|improve|fix) -->$/u.exec(marker.line)[1];
  const labels = releaseTypes[type];
  const themes = located.filter(({ line, index }) => index < zhIndex && /^### /u.test(line));
  requireContract(themes.length === 1, "Release notes must contain one ### <version> · <Chinese theme> heading.");
  const theme = themes[0];
  validateTitle(theme.line.slice(4), version, true);
  const title = theme.line.slice(4);
  const firstVisible = located.find(({ line, index }) => line.trim() && index !== marker.index);
  requireContract(firstVisible.index === theme.index && (!images.length || theme.index < images[0].index),
    "The release theme must be the first visible heading, followed by the hero image.");

  const chineseTypes = located.filter(({ line }) => /^类型\s*[:：]/u.test(line));
  const englishTypes = located.filter(({ line }) => /^Type\s*:/u.test(line));
  requireContract(chineseTypes.length === 1 && englishTypes.length === 1,
    "Release notes must contain exactly one Chinese type line and one English type line.");
  const chineseType = nextContent(lines, zhIndex);
  requireContract(chineseType.index < enIndex && chineseType.line === `类型：${labels.zh}`,
    `Chinese type must be 类型：${labels.zh} immediately below the Chinese heading.`);
  const englishTitle = nextContent(lines, enIndex);
  requireContract(/^\*\*[^*]+\*\*$/u.test(englishTitle.line), "English must begin with a bold translated release title.");
  validateTitle(englishTitle.line.slice(2, -2), version, false);
  const englishType = nextContent(lines, englishTitle.index);
  requireContract(englishType.line === `Type: ${labels.en}`,
    `English type must be Type: ${labels.en} immediately below its translated title.`);

  const bodyLines = lines.filter((_, index) => index !== marker.index)
    .map((line) => line === theme.line ? `# ${title}` : line);
  return {
    title, englishTitle: englishTitle.line.slice(2, -2), type, heroPath,
    body: `<!-- release-type: ${type} -->\n${bodyLines.join("\n").trim()}\n`
  };
}

export function isTrackedReleaseHero(relativePath, directory = rootDir) {
  const filename = path.join(directory, relativePath);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function validateHero(line, repository, isTrackedFile) {
  requireContract(typeof repository === "string" && /^[\w.-]+\/[\w.-]+$/u.test(repository), "A valid GitHub repository is required for the release hero.");
  const image = /^!\[[^\]\n]*\]\((https:\/\/raw\.githubusercontent\.com\/[^\s)]+)\)$/u.exec(line);
  requireContract(image, "Release hero must use a raw.githubusercontent.com image URL.");
  const prefix = `https://raw.githubusercontent.com/${repository}/`;
  requireContract(image[1].startsWith(prefix), "Release hero must belong to the release repository.");
  const refAndPath = image[1].slice(prefix.length);
  const separator = refAndPath.indexOf("/");
  requireContract(separator > 0, "Release hero URL must contain a repository ref.");
  let heroPath;
  try { heroPath = decodeURIComponent(refAndPath.slice(separator + 1)); }
  catch { throw new Error("Release hero URL contains invalid encoding."); }
  requireContract(heroPath.startsWith("assets/releases/") && !/[?#\\\s]/u.test(heroPath)
    && heroPath.split("/").every((part) => part && part !== "." && part !== ".."),
  "Release hero must be a file under assets/releases/.");
  requireContract(typeof isTrackedFile === "function" && isTrackedFile(heroPath),
    `Release hero must exist and be tracked by Git: ${heroPath}.`);
  return heroPath;
}

function validateTitle(title, version, chinese) {
  const match = new RegExp(`^${escapeRegExp(version)} · (.+)$`, "u").exec(title);
  requireContract(match && match[1] === match[1].trim() && !/[#*<>]/u.test(match[1]),
    `Release title must use ${version} · <theme> as plain text.`);
  if (chinese) requireContract(/\p{Script=Han}/u.test(match[1]) && [...match[1]].length <= 20,
    "Chinese release theme must contain Chinese and be at most 20 characters.");
  else requireContract(/[A-Za-z]/u.test(match[1]) && !/\p{Script=Han}/u.test(match[1]),
    "English release title must contain an English translation.");
}

function nextContent(lines, after) {
  for (let index = after + 1; index < lines.length; index += 1) if (lines[index].trim()) return { index, line: lines[index] };
  return { index: lines.length, line: "" };
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function requireContract(condition, message) { if (!condition) throw new Error(message); }

function main(values) {
  const args = { repository: process.env.GITHUB_REPOSITORY || "AKin-lvyifang/codex-echoink", historical: false };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--historical") args.historical = true;
    else {
      const key = { "--version": "version", "--output": "output", "--github-env": "githubEnv", "--repository": "repository" }[flag];
      requireContract(key && values[index + 1] && !values[index + 1].startsWith("--"), `Unknown or missing release-notes argument: ${flag}.`);
      args[key] = values[++index];
    }
  }
  requireContract(args.version && args.output && !/[\r\n]/u.test(args.output), "Use --version <x.y.z> --output <notes.md>.");
  const notes = compileReleaseNotes(fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"), {
    ...args, isTrackedFile: isTrackedReleaseHero
  });
  if (notes) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, notes.body);
  }
  if (args.githubEnv) fs.appendFileSync(args.githubEnv,
    `RELEASE_NOTES_FILE=${notes ? args.output : ""}\nRELEASE_TITLE=${notes?.title ?? ""}\nRELEASE_TYPE=${notes?.type ?? ""}\n`);
  console.log(notes ? `Release notes validated for ${args.version}${notes.type ? ` (${notes.type}): ${notes.title}` : " (historical rebuild)"}.`
    : `Historical rebuild: no CHANGELOG section found for ${args.version}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Release notes failed: ${error.message}`); process.exitCode = 1; }
}

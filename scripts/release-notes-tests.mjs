import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileReleaseNotes } from "./release-notes.mjs";

export function runReleaseNotesTests() {
  const version = "9.12.3";
  const title = `${version} · 全新工作台与多 Agent 任务`;
  const englishTitle = `${version} · A new workbench and multi-agent tasks`;
  const hero = `![EchoInk ${version}](https://raw.githubusercontent.com/example/plugin/${version}/assets/releases/hero.png)`;
  const options = { version, repository: "example/plugin", isTrackedFile: (file) => file === "assets/releases/hero.png" };
  const fixture = (type = "feat", zh = "新功能", en = "New") => `# Changelog

## ${version} - 2026-10-19

### ${title}

${hero}

<!-- release-type: ${type} -->

### 中文

类型：${zh}

工作台可以启动新的任务。

### English

**${englishTitle}**

Type: ${en}

Start new tasks from the workbench.

## 9.12.2 - 2026-10-18

OLDER RELEASE CONTENT
<!-- release-type: fix -->
`;
  let probes = 0;
  const accept = (label, source = fixture(), overrides = {}) => {
    const result = compileReleaseNotes(source, { ...options, ...overrides });
    assert.ok(result, label);
    probes++;
    return result;
  };
  const reject = (label, source, pattern, overrides = {}) => {
    assert.throws(() => compileReleaseNotes(source, { ...options, ...overrides }), pattern, label);
    probes++;
  };

  for (const [type, zh, en] of [["feat", "新功能", "New"], ["improve", "体验改进", "Improved"], ["fix", "修复", "Fixes"]]) {
    const notes = accept(`${type} release`, fixture(type, zh, en));
    assert.equal(notes.title, title);
    assert.equal(notes.englishTitle, englishTitle);
    assert.equal(notes.type, type);
    assert.equal(notes.heroPath, "assets/releases/hero.png");
    assert.ok(notes.body.startsWith(`<!-- release-type: ${type} -->\n# ${title}\n`));
    assert.equal(notes.body.match(/<!-- release-type:/gu).length, 1);
    assert.ok(!notes.body.includes("OLDER RELEASE CONTENT"));
    assert.ok(!notes.body.includes(`## ${version} -`));
  }
  accept("CRLF changelog", fixture().replace(/\n/gu, "\r\n"));
  accept("marker starts the changelog section", fixture().replace(`### ${title}`, `<!-- release-type: feat -->\n\n### ${title}`).replace(`\n<!-- release-type: feat -->\n\n### 中文`, "\n### 中文"));
  accept("hero from main ref", fixture().replace(`/plugin/${version}/assets`, "/plugin/main/assets"));
  reject("missing section", "# Changelog\n", /must contain a section/u);
  reject("duplicate section", fixture() + `\n## ${version} - 2026-10-20\n`, /only one section/u);
  reject("version dots are literal", fixture().replace(`## ${version}`, "## 9x12x3"), /must contain a section/u);
  reject("new tag must not use v prefix", fixture().replace(`## ${version}`, `## v${version}`), /New CHANGELOG/u);
  reject("missing date", fixture().replace(` - 2026-10-19`, ""), /YYYY-MM-DD/u);
  reject("missing marker", fixture().replace("<!-- release-type: feat -->", ""), /exactly one release-type/u);
  reject("duplicate marker", fixture().replace("<!-- release-type: feat -->", "<!-- release-type: feat -->\n<!-- release-type: feat -->"), /exactly one release-type/u);
  reject("duplicate marker on same line", fixture().replace("<!-- release-type: feat -->", "<!-- release-type: feat --><!-- release-type: fix -->"), /exactly one release-type/u);
  reject("invalid type", fixture("maintenance"), /standalone/u);
  reject("marker must be standalone", fixture().replace("<!-- release-type: feat -->", "Text <!-- release-type: feat -->"), /standalone/u);
  reject("Chinese type mismatch", fixture("feat", "修复"), /Chinese type must/u);
  reject("English type mismatch", fixture("feat", "新功能", "Improved"), /English type must/u);
  reject("missing Chinese type", fixture().replace("类型：新功能", ""), /one Chinese type/u);
  reject("missing English type", fixture().replace("Type: New", ""), /one English type/u);
  reject("duplicate Chinese type", fixture().replace("类型：新功能", "类型：新功能\n类型：新功能"), /one Chinese type/u);
  reject("duplicate English type", fixture().replace("Type: New", "Type: New\nType: New"), /one English type/u);
  reject("type must immediately follow Chinese heading", fixture().replace("类型：新功能", "Other text\n\n类型：新功能"), /Chinese type must/u);
  reject("type must follow English title", fixture().replace("Type: New", "Other text\n\nType: New"), /English type must/u);
  reject("Chinese type punctuation is exact", fixture().replace("类型：新功能", "类型: 新功能"), /Chinese type must/u);
  reject("English type case is exact", fixture().replace("Type: New", "Type: new"), /English type must/u);
  reject("missing Chinese section", fixture().replace("### 中文", "### Chinese"), /Chinese section before/u);
  reject("missing English section", fixture().replace("### English", "### 英文"), /Chinese section before/u);
  reject("duplicate language heading", fixture().replace("### 中文", "### 中文\n### 中文"), /Chinese section before/u);
  reject("English before Chinese", fixture().replace("### 中文", "### SWITCH").replace("### English", "### 中文").replace("### SWITCH", "### English"), /Chinese section before/u);
  reject("missing Chinese release theme", fixture().replace(`### ${title}`, ""), /one ###/u);
  reject("duplicate theme heading", fixture().replace(`### ${title}`, `### ${title}\n### ${title}`), /one ###/u);
  reject("wrong theme version", fixture().replace(`### ${title}`, "### 9.12.2 · 新工作台"), /Release title must/u);
  reject("Chinese theme length", fixture().replace(`### ${title}`, `### ${version} · ${"新".repeat(21)}`), /20 characters/u);
  reject("theme must be Chinese", fixture().replace(`### ${title}`, `### ${version} · New workbench`), /contain Chinese/u);
  reject("hero before release theme", fixture().replace(`### ${title}\n\n${hero}`, `${hero}\n\n### ${title}`), /first visible heading/u);
  reject("English title missing bold", fixture().replace(`**${englishTitle}**`, englishTitle), /bold translated/u);
  reject("English title missing version", fixture().replace(englishTitle, "A new workbench"), /Release title must/u);
  reject("English title wrong version", fixture().replace(englishTitle, "9.12.2 · A new workbench"), /Release title must/u);
  reject("English title must be translated", fixture().replace(englishTitle, title), /English translation/u);
  reject("missing hero", fixture().replace(hero, ""), /one hero image/u);
  reject("improve release still needs hero", fixture("improve", "体验改进", "Improved").replace(hero, ""), /one hero image/u);
  const fixWithoutHero = accept("fix release without hero", fixture("fix", "修复", "Fixes").replace(`${hero}\n`, ""));
  assert.equal(fixWithoutHero.heroPath, "");
  assert.ok(!fixWithoutHero.body.includes("!["));
  reject("fix release with duplicate hero", fixture("fix", "修复", "Fixes").replace(hero, `${hero}\n${hero}`), /one hero image/u);
  reject("duplicate hero", fixture().replace(hero, `${hero}\n${hero}`), /one hero image/u);
  reject("hero after language heading", fixture().replace(hero, "").replace("工作台可以", `${hero}\n\n工作台可以`), /one hero image/u);
  reject("hero from another repository", fixture().replace("example/plugin/", "other/plugin/"), /release repository/u);
  reject("hero from a non-raw URL", fixture().replace("raw.githubusercontent.com", "github.com"), /raw.githubusercontent/u);
  reject("hero outside release assets", fixture().replace("assets/releases/hero.png", "assets/hero.png"), /under assets\/releases/u);
  reject("hero traversal", fixture().replace("assets/releases/hero.png", "assets/releases/%2e%2e/hero.png"), /under assets\/releases/u);
  reject("hero missing or untracked", fixture(), /exist and be tracked/u, { isTrackedFile: () => false });

  const legacy = fixture().replace("<!-- release-type: feat -->", "").replace(`### ${title}\n`, "").replace("类型：新功能", "").replace("Type: New", "");
  const historical = accept("historical notes without new title/types", legacy, { historical: true });
  assert.equal(historical.title, "");
  assert.ok(historical.body.startsWith(`## ${version} -`));
  accept("historical v heading", legacy.replace(`## ${version}`, `## v${version}`), { historical: true });
  assert.equal(compileReleaseNotes("# Changelog\n", { ...options, historical: true }), null);
  probes++;
  reject("historical format still needs bilingual order", legacy.replace("### 中文", "### Chinese"), /Chinese section before/u, { historical: true });
  reject("historical format still needs tracked hero", legacy, /exist and be tracked/u, { historical: true, isTrackedFile: () => false });
  return probes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Release notes probes passed (${runReleaseNotesTests()} cases).`);
}

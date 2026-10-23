import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = disposableTestOutputRoot(path.join(rootDir, ".tmp"));
const outputFile = path.join(outputDir, "personal-memory-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import assert from "node:assert/strict";',
      'import { withPersonalMemoryFixture } from "./src/tests/personal-memory-fixture";',
      'import { runMemoryRecallHarnessContractScenarios } from "./src/tests/memory-recall-harness";',
      'import { runPersonalMemoryToolContractScenarios } from "./src/tests/personal-memory-tools";',
      'import { runPersonalMemoryCorrectionTests } from "./src/tests/personal-memory-correction";',
      'import { runCognitiveSystemScenarios } from "./src/tests/cognitive-system";',
      'import { buildEchoInkSystemConstitutionPrompt, buildPersonalMemorySystemPrompt } from "./src/harness/memory/personal-memory-contracts";',
      "await runMemoryRecallHarnessContractScenarios();",
      "await runPersonalMemoryToolContractScenarios();",
      "await runPersonalMemoryCorrectionTests();",
      "await runCognitiveSystemScenarios();",
      "await withPersonalMemoryFixture(async (fixture) => {",
      "  const fixed = await fixture.repository.loadFixedContext({ memoryMode: 'normal' });",
      "  assert.ok(fixed.agent && fixed.user && fixed.memory);",
      "  assert.match(fixture.repository.layout.agent, /AGENT\\.md$/u);",
      "  assert.match(fixture.repository.layout.user, /USER\\.md$/u);",
      "  assert.match(fixture.repository.layout.memory, /MEMORY\\.md$/u);",
      "  const files = await fixture.repository.listManagedFiles();",
      "  for (const kind of ['facts', 'views', 'decisions', 'active', 'episodes']) {",
      "    assert.ok(files.some((file) => file.includes('/' + kind + '/')) || files.every((file) => !file.includes('/records/')));",
      "  }",
      "});",
      "const constitutionPrompt = buildEchoInkSystemConstitutionPrompt();",
      "assert.match(constitutionPrompt, /真实高于迎合/u);",
      "assert.match(constitutionPrompt, /所有用户可见文本.*公开推理.*最终回答.*大白话.*内部实现细节.*内部 ID.*revision.*文件名或路径.*来源 URI.*明确要求技术排查/u);",
      "const memoryPrompt = buildPersonalMemorySystemPrompt();",
      "assert.match(memoryPrompt, /长期 Memory 开启时.*持续授权 Agent.*判断当前用户内容是否值得跨轮保留.*再选择七类/u);",
      "assert.match(memoryPrompt, /普通保存不以用户额外说「记住」为前提/u);",
      "assert.match(memoryPrompt, /值得保存且对象清楚时.*本轮必须完成 memory_search 到 memory_write/u);",
      "assert.match(memoryPrompt, /明确要求记住且对象清楚时必须执行/u);",
      "assert.match(memoryPrompt, /拿不准长期价值时安静跳过/u);",
      "assert.match(memoryPrompt, /不为是否保存、分类选择或归纳措辞追问/u);",
      "assert.match(memoryPrompt, /能够归入七类本身不等于具有跨轮价值/u);",
      "assert.match(memoryPrompt, /fact.*view.*decision.*goal.*task.*open_loop.*episode/u);",
      "assert.match(memoryPrompt, /默认不保存寒暄、感谢、填充闲聊/u);",
      "assert.doesNotMatch(memoryPrompt, /能够忠实归入 fact、view、decision、goal、task、open_loop、episode 任一类.*默认具有跨轮价值/u);",
      "assert.match(memoryPrompt, /本轮第一次调用 memory_write 前.*当前用户消息.*一次完整 memory_search.*exhausted=false.*nextCursor.*exhausted=true/u);",
      "assert.match(memoryPrompt, /完整搜索可供本轮连续写入多条 Memory.*不要一搜一写/u);",
      "assert.match(memoryPrompt, /只有写入失败、出现 revision 冲突.*确实需要补充检索时，才再次搜索/u);",
      "assert.match(memoryPrompt, /System 已判断用户内容值得跨轮保存、对象清楚时.*完成本轮首次写入前的完整 memory_search 后必须实际调用 memory_write.*普通文字不会落盘/u);",
      "assert.match(memoryPrompt, /create、update 和 profile_update 不需要 evidenceQuote/u);",
      "assert.match(memoryPrompt, /forget 的 evidenceQuote 必须逐字引用当前用户 Entry/u);",
      "assert.match(memoryPrompt, /possible_duplicate.*本次零写入/u);",
      "assert.match(memoryPrompt, /outcome.*英文类型.*内部 ID.*revision.*路径.*来源 URI.*只供内部判断.*向用户确认时只用大白话.*不得照搬内部回执/u);",
      'console.log("Current file-based Personal Memory acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "personal-memory-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  loader: {
    ".md": "text",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  plugins: [{
    name: "personal-memory-obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: obsidianShimPath
      }));
    }
  }],
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: {
    ...process.env,
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);

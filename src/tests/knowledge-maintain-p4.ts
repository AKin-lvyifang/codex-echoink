import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { appendMaintenanceAliases, appendMaintenancePageType } from "../knowledge-base/maintenance-page-metadata";
import { patchMaintenanceUpgradeSourceFrontmatter, readMaintenanceFrontmatterProperty } from "../knowledge-base/maintenance-source-frontmatter";
import { planMaintenanceSourceMigration, resolveMaintenanceSourceState } from "../knowledge-base/maintenance-source-state";
import { buildMaintenanceUpgradePlan, previewMaintenanceUpgradePlan } from "../knowledge-base/maintenance-upgrade-plan";
import type { MaintenanceUpgradeFile } from "../knowledge-base/maintenance-upgrade-contract";
import { buildRawDigestRegistryContent, rawDigestRecordFromText, readRawDigestRegistry, readRawDigestRegistrySources, type RawDigestRegistryEntry } from "../knowledge-base/raw-digest";
import { emptyKnowledgeFolderBindings, KNOWLEDGE_ROOT_NAMES, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";

const fingerprint = "sha256:5:" + "a".repeat(64);
const entry = (rawPath: string, extra: Partial<RawDigestRegistryEntry> = {}): RawDigestRegistryEntry => ({ rawPath, fingerprint, size: 5, mtime: 1, digestedAt: 1, runId: "synthetic", reportPath: "", evidencePaths: [], confidence: "verified", ...extra });
const file = (p: string, role: MaintenanceUpgradeFile["role"], content: string): MaintenanceUpgradeFile => ({ path: p, role, content, revision: `sha256:${"b".repeat(64)}`, fingerprint });

export async function runKnowledgeMaintainP4Tests(root: string): Promise<void> {
  const configuredRoot = process.env.ECHOINK_KNOWLEDGE_TEST_ROOT;
  assert.ok(configuredRoot?.trim(), "P4 fixtures require the explicitly assigned test root");
  const allowed = path.resolve(configuredRoot!);
  const disposable = path.join(homedir(), "EchoInk-TestVaults/90-任务临时");
  assert.ok(allowed.startsWith(disposable + path.sep), "P4 assigned root stays inside the disposable test tree");
  assert.ok(path.resolve(root).startsWith(allowed + path.sep), "P4 fixtures stay inside the assigned automatic root");
  await fs.mkdir(root, { recursive: true });
  testPriority();
  testBytePatches();
  testMalformedPreviewMessages();
  testSourceScanLineEndings();
  const completedSourceReview = testCompletedSourceReview();
  const summary = testPlan();
  await testRegistryReaders(root);
  await fs.writeFile(path.join(root, "p4-core-result.json"), JSON.stringify({ passed: true, ...summary, completedSourceReview }, null, 2));
  console.log("Knowledge maintenance P4 core: PASS (priority, all registries, unique source relationships, byte patches, classification scope, idempotence)");
}

function testSourceScanLineEndings(): void {
  for (const eol of ["\n", "\r\n"]) for (const finalNewline of [false, true]) {
    const content = ["---", "类型: 概念", "---", "# 换行兼容", "", "```md",
      "[[Raw/代码.md]]", '<!-- echoink-source: {"path":"Raw/代码.md"} -->', "```", "",
      ...Array.from({ length: 40 }, () => "前面的文字和空行不改变后面的来源位置。"), "", "## 来源", "",
      "![图片](../Raw/图片.md)", "![图 [内链](../Raw/嵌套.md))", "[[失踪资料]]",
      "[正常来源](../Raw/正常.md)", "[末行来源](../Raw/末行.md)"
    ].join(eol) + (finalNewline ? eol : "");
    const wiki = file("Wiki/换行兼容.md", "wiki", content);
    const names = ["代码", "图片", "嵌套", "正常", "末行"];
    const sources = names.map(name => file(`Raw/${name}.md`, "raw", `# ${name}`));
    const plan = buildMaintenanceUpgradePlan({ files: [wiki, ...sources], bindingRevision: 1, now: 1 });
    for (const name of ["代码", "图片"]) assert.equal(plan.sourceItems.find(item => item.path === `Raw/${name}.md`)?.addTargetPaths, undefined);
    for (const name of ["嵌套", "正常", "末行"]) assert.deepEqual(plan.sourceItems.find(item => item.path === `Raw/${name}.md`)?.addTargetPaths, [wiki.path]);
    assert.deepEqual(plan.issues.map(issue => issue.message), ["没有找到来源“失踪资料”对应的资料，原链接先保留，请你核对。"], "source-section offsets survive code masking, blank lines, CRLF and an unterminated final line");
    assert.equal(wiki.content, content);
  }
}

function testCompletedSourceReview() {
  const missingMessage = "看不出这篇资料整理到了哪页 Wiki，先不补链接，仍算已提炼。";
  const completed = (p: string, properties = "") => file(p, "raw", `---\n提炼状态: 已提炼\n${properties}---\n# 已完成来源\n`);
  const changed = completed("Raw/只有标准状态和旧指纹.md", "提炼指纹: old\n");
  const noFingerprint = completed("Raw/没有旧指纹.md");
  const emptyFingerprint = completed("Raw/空旧指纹.md", "提炼指纹: '   '\n提炼到: []\n");
  const existing = completed("Raw/已有成果.md", "提炼到: ['[[Wiki/已有成果.md]]']\n");
  const missingLinked = completed("Raw/旧链缺页.md", "提炼到: ['[[Wiki/已删除.md]]'] # 原样保留\n");
  const missingLinkedOriginal = missingLinked.content;
  const sameName = [completed("Raw/甲/同名.md"), completed("Raw/乙/同名.md")];
  const pending = file("Raw/尚未处理.md", "raw", "---\n提炼状态: 未提炼\n提炼指纹: old\n---\n# 尚未处理\n");
  const files = [changed, noFingerprint, emptyFingerprint, existing, missingLinked, ...sameName, pending,
    file("Wiki/歧义来源.md", "wiki", "---\n类型: 概念\n---\n# 歧义来源\n## 来源\n[[同名]]\n"),
    file("Wiki/已有成果.md", "wiki", "---\n类型: 概念\n---\n# 已有成果\n")];
  const original = JSON.stringify(files);
  const plan = buildMaintenanceUpgradePlan({ files, bindingRevision: 1, now: 1 });
  const missingResultPaths = plan.issues.filter(issue => issue.kind === "review" && issue.message === missingMessage).map(issue => issue.path).sort();
  assert.deepEqual(missingResultPaths, [changed.path, noFingerprint.path, emptyFingerprint.path, missingLinked.path, ...sameName.map(source => source.path)].sort(), "missing outcomes are reported for each completed source, including both ambiguous candidates and a stale target link");
  assert.equal(plan.issues.find(issue => issue.path === missingLinked.path && issue.kind === "review" && issue.message.includes("已删除.md"))?.message, "“提炼到”里的 Wiki 页面“Wiki/已删除.md”找不到了，原链接先保留，请你核对。", "a syntactically valid link to an absent scanned Wiki page requires review");
  assert.equal(missingLinked.content, missingLinkedOriginal);
  assert.deepEqual(readMaintenanceFrontmatterProperty(missingLinked.content, "提炼到").value, ["[[Wiki/已删除.md]]"], "the old missing-page target remains byte-for-byte in place");
  assert.equal(plan.issues.find(issue => issue.path === "Wiki/歧义来源.md")?.message, "来源“同名”有 2 篇同名资料，分不清是哪一篇，原链接先保留。");
  const optionalReingestPaths = plan.issues.filter(issue => issue.kind === "optional-reingest").map(issue => issue.path);
  assert.deepEqual(optionalReingestPaths, [changed.path], "canonical completion plus a real old fingerprint is sufficient; absent or blank fingerprints create no optional issue");
  for (const source of [changed, noFingerprint, emptyFingerprint, existing, missingLinked, ...sameName]) assert.equal(resolveMaintenanceSourceState(source.content).state, "digested");
  assert.equal(resolveMaintenanceSourceState(pending.content).state, "pending");
  assert.equal(plan.issues.some(issue => issue.path === pending.path && issue.message === missingMessage), false);
  assert.deepEqual(plan.sourceItems, [], "uncertain or absent outcomes never invent target links or rewrite completed sources");
  assert.equal(JSON.stringify(files), original);
  return { missingResultPaths, optionalReingestPaths, pendingMissingResultIssues: 0, proposedSourceWrites: plan.sourceItems.length,
    missingPageReviewPaths: plan.issues.filter(issue => /找不到了/u.test(issue.message)).map(issue => issue.path),
    missingLinkedTargetsPreserved: readMaintenanceFrontmatterProperty(missingLinked.content, "提炼到").value };
}

function testMalformedPreviewMessages(): void {
  const files = [
    file("Wiki/损坏属性.md", "wiki", "---\na: 1\na: 2\n---\n# 损坏属性"),
    file("Wiki/复杂属性.md", "wiki", "---\n{ user: 1 }\n---\n# 复杂属性"),
    file("Raw/损坏属性.md", "raw", "---\na: 1\na: 2\n---\n# 损坏属性"),
    file("Raw/复杂属性.md", "raw", "---\n{ user: 1 }\n---\n# 复杂属性")
  ];
  const preview = previewMaintenanceUpgradePlan(buildMaintenanceUpgradePlan({ files, bindingRevision: 1, now: 1 }));
  assert.equal(preview.issues.length, files.length);
  for (const issue of preview.issues) {
    assert.equal(issue.kind, "unavailable");
    assert.equal(issue.message, "这页的属性没法明确识别，原文件会保留，请核对后再试。");
    assert.doesNotMatch(issue.message, /[A-Za-z]|Source frontmatter/u, "damaged YAML never exposes parser diagnostics in the preview");
  }
  assert.deepEqual(preview.automatic, []);
}

function testPriority(): void {
  const registry = entry("Raw/a.md");
  const states = { 已提炼: "digested", 未提炼: "pending", 待重新提炼: "changed", 提炼失败: "failed", 待校准: "calibration" } as const;
  for (const [status, state] of Object.entries(states)) {
    const content = `---\n提炼状态: ${status}\n已处理: true\n---\nbody`;
    const resolution = resolveMaintenanceSourceState(content, { fingerprint: () => { throw new Error("standard states do not hash"); }, registry, maintenance: { fingerprint: "old", status: "failed" } });
    assert.equal(resolution.state, state); assert.equal(resolution.origin, "new");
    assert.equal(planMaintenanceSourceMigration({ status, privateProcessed: true }).status, status);
    assert.equal(planMaintenanceSourceMigration({ status, privateProcessed: true }).shouldWrite, false);
  }
  assert.equal(resolveMaintenanceSourceState("---\n已处理: true # old\n---\nbody").state, "digested", "old completion requires no fingerprint");
  assert.equal(resolveMaintenanceSourceState('---\n"已处理": true # quoted key\n---\nbody').state, "digested");
  assert.equal(rawDigestRecordFromText("---\n已处理: true\n---\nbody")?.processed, true);
  for (const evidence of [{ previous: { fingerprint } }, { hasTrackerHint: true }, {}]) assert.equal(resolveMaintenanceSourceState("body", evidence).state, "pending");
  assert.equal(resolveMaintenanceSourceState(`---\n提炼指纹: ${fingerprint}\n---\nbody`).state, "pending");
  assert.equal(resolveMaintenanceSourceState("---\n已处理: true\n---\nbody", { maintenance: { fingerprint, status: "unread" }, registry }).state, "pending");
  assert.equal(resolveMaintenanceSourceState("body", { maintenance: { fingerprint: "old", status: "failed" }, registry }).state, "failed");
  const old = resolveMaintenanceSourceState("body", { fingerprint: () => "new", maintenance: { fingerprint, status: "processed" }, registry });
  assert.equal(old.state, "digested");
  assert.equal(resolveMaintenanceSourceState("body", { fingerprint: () => { throw new Error("daily legacy state must not hash"); }, registry }).state, "digested");
  assert.equal(resolveMaintenanceSourceState("body", { fingerprint: () => "new", registry }).state, "digested");
  assert.equal(planMaintenanceSourceMigration({ privateProcessed: true, registryProcessed: false, legacyProcessed: false }).status, "已提炼");
  assert.equal(planMaintenanceSourceMigration({ privateProcessed: false, registryProcessed: true, legacyProcessed: true }).status, "未提炼");
  assert.equal(planMaintenanceSourceMigration({ registryProcessed: false, legacyProcessed: true }).status, "未提炼");
  assert.deepEqual(planMaintenanceSourceMigration({ status: "手动保留" }), { status: "未提炼", targetPaths: [], needsReview: true, shouldWrite: false });
  assert.deepEqual(planMaintenanceSourceMigration({ status: "手动保留", privateProcessed: true }), { status: "已提炼", targetPaths: [], needsReview: true, shouldWrite: false }, "nonstandard properties are preserved while effective state consumes old outcomes");
  assert.equal(resolveMaintenanceSourceState("---\n提炼状态: 人工保留\n---\nbody", { registry }).state, "digested");
  const canonicalOld = file("Raw/canonical-old.md", "raw", "---\n提炼状态: 已提炼\n已处理: true\n提炼指纹: old\n---\n# 已完成旧来源");
  const optional = buildMaintenanceUpgradePlan({ files: [canonicalOld], bindingRevision: 1, now: 1 });
  assert.equal(resolveMaintenanceSourceState(canonicalOld.content).state, "digested");
  assert.deepEqual(optional.sourceItems, []);
  assert.equal(optional.issues.find(item => item.path === canonicalOld.path && item.kind === "optional-reingest")?.message, "可选：重新提炼。这页在上次整理后改过，看不出改的是排版还是内容。原文不动；想更新的话，可以让 Agent 重新整理这页。", "canonical completion still receives the preview-only stale fingerprint option");
}

function testBytePatches(): void {
  const specimens = [
    "# 无头\n正文 [[Wiki/手写旧链]]，不修改。  \n",
    "\uFEFF# 无头\r\n正文\r\n",
    "\uFEFF--- \r\n# Notion原注释\r\nnotion-id: 'abc' # 保留\r\ncubox: {url: 'https://example.invalid', title: 收藏}\r\naliases: [A, '别名']\r\nnested:\r\n  提炼状态: 私有字段\r\n摘要: |- # 原摘要\r\n  不重新生成\r\n... \r\n# 正文\r\n\r\n手写 [[不存在/旧链接]]  \r\n最后没有换行",
    "---\n# 只有注释\n---\n# empty\n"
  ];
  for (const original of specimens) {
    const upgraded = patchMaintenanceUpgradeSourceFrontmatter(original, { status: "已提炼", targetPaths: ["Wiki/甲.md", "Wiki/乙.md", "Wiki/甲.md"] });
    assert.equal(patchMaintenanceUpgradeSourceFrontmatter(upgraded, { status: "未提炼", targetPaths: ["Wiki/别的.md"] }), upgraded, "new state and targets cannot be overwritten");
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    let restored = upgraded.replace(`提炼状态: "已提炼"${eol}`, "").replace(`提炼到: ["[[Wiki/甲.md]]","[[Wiki/乙.md]]"]${eol}`, "");
    if (!/^\uFEFF?---/u.test(original)) restored = restored.replace(`---${eol}---${eol}`, "");
    assert.equal(restored, original, "removing only added bytes reproduces the original exactly");
    const typed = appendMaintenancePageType(original, { type: "趋势 / 主题", uncertain: true });
    assert.deepEqual(readMaintenanceFrontmatterProperty(typed, "类型").value, "趋势 / 主题");
    assert.equal(readMaintenanceFrontmatterProperty(typed, "类型待确认").value, true);
    assert.equal(appendMaintenancePageType(typed, { type: "概念", uncertain: false }), typed);
    let withoutType = typed.replace(`类型: "趋势 / 主题"${eol}`, "").replace(`类型待确认: true${eol}`, "");
    if (!/^\uFEFF?---/u.test(original)) withoutType = withoutType.replace(`---${eol}---${eol}`, "");
    assert.equal(withoutType, original);
  }
  const handWritten = "---\n提炼状态: 由我决定 # 不碰\n提炼到: '[[手写]]' # 不转换\n类型: [自定义]\n类型待确认: false\n---\n正文";
  assert.equal(patchMaintenanceUpgradeSourceFrontmatter(handWritten, { status: "已提炼", targetPaths: ["wiki/a.md"] }), handWritten);
  assert.equal(appendMaintenancePageType(handWritten, { type: "概念", uncertain: true }), handWritten);
  const existingFlag = "---\n类型待确认: false # 手写决定\n---\nbody";
  const classified = appendMaintenancePageType(existingFlag, { type: "概念", uncertain: true });
  assert.equal(classified, "---\n类型待确认: false # 手写决定\n类型: \"概念\"\n---\nbody");
  for (const malformed of ["---\nunclosed: true", "---\na: 1\na: 2\n---\nbody", "---\n{ a: 1 }\n---\nbody"]) assert.throws(() => patchMaintenanceUpgradeSourceFrontmatter(malformed, { status: "未提炼" }));
  const aliases = "---\naliases: ['旧名'] # 保留\n---\n# 标题\n";
  assert.equal(appendMaintenanceAliases(aliases, ["新名"]), "---\naliases: ['旧名', '新名'] # 保留\n---\n# 标题\n", "P2 alias insertion retains its exact style");
}

function testPlan() {
  const sources = [
    file("Raw/甲.md", "raw", "---\n已处理: true\n提炼指纹: old\n---\n# 原始甲\n手写 [[Wiki/旧链]]\n"),
    file("收件箱（inbox）/乙.md", "inbox", "---\naliases: [独特别名]\n---\n# 原始乙\n正文"),
    file("Raw/一/同名.md", "raw", "# 重名一"), file("Raw/二/同名.md", "raw", "# 重名二"),
    file("Raw/无记录.md", "raw", "# 新资料"),
    file("Raw/自定.md", "raw", "---\n提炼状态: 人工保留\n提炼到: 原样\n---\n# 自定"),
    file("Raw/已齐.md", "raw", "---\n提炼状态: 已提炼\n提炼到: ['[[Wiki/原有.md]]']\n---\n# 已齐")
  ];
  const wikis = [
    file("Wiki/一.md", "wiki", '# 一\n## 来源\n[[Raw/甲.md|误导标签]]\n[[独特别名]]\n<!-- echoink-source: {"path":"Raw/甲.md","revision":"old"} -->\n'),
    file("Wiki/二.md", "wiki", "# 二\n来源视频：[[旧路径/旧名字|原始乙]]\n[[甲]]\n[甲](../Raw/%E7%94%B2.md)\n"),
    file("Wiki/三.md", "wiki", '<!-- echoink-source: {"path":"收件箱（inbox）/乙.md"} -->\n# 三\n'),
    file("Wiki/歧义.md", "wiki", "# 歧义\n## 来源\n[[同名|原始甲]]\n[[失踪资料]]\n<!-- echoink-source: broken -->\n"),
    file("Wiki/索引/index.md", "wiki", "# 索引\n[[Wiki/一.md]]\n"),
    file("Wiki/地图.md", "wiki", "# 地图\n[[Wiki/二.md]]\n"),
    file("Wiki/标准.md", "wiki", "---\n类型: 概念\n---\n# 标准"),
    file("Wiki/自定.md", "wiki", "---\n类型: 用户自定\n---\n# 自定"),
    file("Wiki/代码.md", "wiki", '# 代码\n```md\n[[Raw/无记录.md]]\n<!-- echoink-source: {"path":"Raw/无记录.md"} -->\n```\n'),
    file("Wiki/坏头.md", "wiki", "---\na: 1\na: 2\n---\n# 坏头")
  ];
  const files = [...sources, ...wikis], before = JSON.stringify(files);
  const plan = buildMaintenanceUpgradePlan({ files, bindingRevision: 4, now: 1, id: "fixture-preview", rootAdditions: [{ role: "raw", path: "Raw" }] });
  assert.equal(JSON.stringify(files), before, "preview inputs are immutable");
  assert.deepEqual(plan.sourceItems.find(item => item.path === "Raw/甲.md")?.addTargetPaths, ["Wiki/一.md", "Wiki/二.md"]);
  assert.deepEqual(plan.sourceItems.find(item => item.path.includes("/乙.md"))?.addTargetPaths, ["Wiki/一.md", "Wiki/三.md", "Wiki/二.md"].sort((a, b) => a.localeCompare(b, "en")));
  assert.equal(plan.sourceItems.find(item => item.path === "Raw/甲.md")?.addStatus, "已提炼");
  assert.equal(plan.sourceItems.find(item => item.path === "Raw/无记录.md")?.addStatus, "未提炼");
  assert.ok(plan.sourceItems.filter(item => item.path.includes("同名")).every(item => !item.addTargetPaths));
  assert.equal(plan.sourceItems.some(item => item.path === "Raw/已齐.md" || item.path === "Raw/自定.md"), false);
  assert.ok(plan.wikiItems.some(item => item.path.endsWith("index.md")) && plan.wikiItems.some(item => item.path === "Wiki/地图.md"));
  assert.equal(plan.wikiItems.some(item => ["Wiki/标准.md", "Wiki/自定.md", "Wiki/坏头.md"].includes(item.path)), false);
  assert.deepEqual(plan.counts, { sourceCount: 7, sourceStatusCount: 5, sourceLinkCount: 2, backlinkCount: 5, wikiCount: 7 });
  assert.equal(plan.issues.find(item => item.path === "Wiki/歧义.md" && item.message.includes("同名"))?.message, "来源“同名”有 2 篇同名资料，分不清是哪一篇，原链接先保留。");
  assert.equal(plan.issues.find(item => item.message.includes("失踪资料"))?.message, "没有找到来源“失踪资料”对应的资料，原链接先保留，请你核对。");
  assert.equal(plan.issues.find(item => item.path === "Wiki/歧义.md" && item.message.includes("不完整"))?.message, "这页有一处旧来源信息不完整，原文先保留，请你核对。");
  assert.equal(plan.issues.find(item => item.path === "Wiki/自定.md")?.message, "这页的“类型”不在七种知识类型里，先保留，请你核对。");
  assert.deepEqual(plan.issues.filter(item => item.path === "Raw/自定.md").map(item => item.message), ["这篇资料的“提炼状态”看不明白，先保留，请你核对。", "这篇资料的“提炼到”没写成 Wiki 链接列表，先保留，请你核对。"]);
  for (const item of plan.issues) assert.doesNotMatch(item.message, /指纹|记录|正文|唯一定位|旧机器|非标准|原值|revision|fingerprint/u);
  assert.ok(plan.issues.some(item => item.kind === "optional-reingest"));
  assert.ok(plan.issues.some(item => item.path === "Wiki/坏头.md" && item.kind === "unavailable"));
  const preview = previewMaintenanceUpgradePlan(plan);
  assert.equal(preview.automatic.length, plan.sourceItems.length + plan.wikiItems.length);
  assert.equal(preview.rootAdditions[0].path, "Raw");
  assert.equal(preview.automatic.find(item => item.path === "Wiki/地图.md")?.description, "确认后让 Agent 从七种知识类型中选择；拿不准时标上“类型待确认”。");
  const upgraded = files.map(source => {
    const sourceItem = plan.sourceItems.find(item => item.path === source.path), wikiItem = plan.wikiItems.find(item => item.path === source.path);
    const content = sourceItem ? patchMaintenanceUpgradeSourceFrontmatter(source.content, { status: sourceItem.addStatus, targetPaths: sourceItem.addTargetPaths })
      : wikiItem ? appendMaintenancePageType(source.content, { type: "趋势 / 主题", uncertain: false }) : source.content;
    return { ...source, content };
  });
  const repeat = buildMaintenanceUpgradePlan({ files: upgraded, bindingRevision: 4, now: 2 });
  assert.deepEqual(repeat.sourceItems, []); assert.deepEqual(repeat.wikiItems, []);
  assert.equal(repeat.counts.sourceStatusCount + repeat.counts.backlinkCount + repeat.counts.wikiCount, 0);
  return { initialCounts: plan.counts, issueCount: plan.issues.length, repeatedWrites: 0 };
}

async function testRegistryReaders(root: string): Promise<void> {
  const vault = await fs.mkdtemp(path.join(root, "registry-"));
  const bindings = emptyKnowledgeFolderBindings(); bindings.configured = true;
  bindings.roles.outputs = { enabled: true, readPaths: [KNOWLEDGE_ROOT_NAMES.outputs, "历史输出"], writePath: KNOWLEDGE_ROOT_NAMES.outputs, allowedSubdirectories: [] };
  const unbind = registerKnowledgeFolderBindings(vault, () => bindings);
  const privateRoot = path.join(vault, ".obsidian/plugins/fixture/private/knowledge");
  registerKnowledgePrivateRoot(vault, privateRoot);
  const write = async (target: string, entries: RawDigestRegistryEntry[], updatedAt = "2026-10-22T00:00:00.000Z") => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buildRawDigestRegistryContent({ schemaVersion: 1, updatedAt, entries: Object.fromEntries(entries.map(value => [value.rawPath, value])) }));
  };
  try {
    await write(path.join(privateRoot, "processed-sources.json"), [entry("Raw/private.md"), entry("Raw/shared.md", { runId: "private-old", digestedAt: 1 })]);
    await write(path.join(vault, KNOWLEDGE_ROOT_NAMES.outputs, ".raw-digest-registry.json"), [entry("Raw/new.md"), entry("Raw/shared.md", { runId: "legacy-newer", digestedAt: 999 }), entry("Raw/tie.md", { runId: "new-root", digestedAt: 5 }), entry("Raw/store.md"), entry("Raw/stable.md", { runId: "first-root" })]);
    await write(path.join(vault, "Outputs", ".raw-digest-registry.json"), [entry("Raw/old.md"), entry("Raw/tie.md", { runId: "old-but-later-receipt", digestedAt: 6 }), entry("Raw/store.md", { runId: "later-store" })], "2026-10-23T00:00:00.000Z");
    await write(path.join(vault, "历史输出", ".raw-digest-registry.json"), [entry("Raw/custom.md"), entry("Raw/stable.md", { runId: "later-root" })]);
    const stores = await readRawDigestRegistrySources(vault, true), registry = await readRawDigestRegistry(vault, true);
    assert.ok(stores.some(store => store.path.includes("Outputs")) && stores.some(store => store.path.includes(KNOWLEDGE_ROOT_NAMES.outputs)));
    assert.deepEqual(Object.keys(registry.entries).sort(), ["Raw/custom.md", "Raw/new.md", "Raw/old.md", "Raw/private.md", "Raw/shared.md", "Raw/stable.md", "Raw/store.md", "Raw/tie.md"]);
    assert.equal(registry.entries["Raw/shared.md"].runId, "private-old");
    assert.equal(registry.entries["Raw/tie.md"].runId, "old-but-later-receipt");
    assert.equal(registry.entries["Raw/store.md"].runId, "later-store");
    assert.equal(registry.entries["Raw/stable.md"].runId, "first-root");
    const damaged = path.join(vault, "Outputs", ".raw-digest-registry.json");
    for (const content of ["{broken", "", '{"schemaVersion":1,"entries":{"Raw/invalid.md":{"fingerprint":""}}}', '{"schemaVersion":1,"entries":[]}']) {
      await fs.writeFile(damaged, content);
      await assert.rejects(readRawDigestRegistry(vault, true), /Cannot read Raw registry/u, "a damaged legacy store is visible even while the private store is valid");
    }
    await fs.writeFile(damaged, '{"schemaVersion":1,"entries":{}}');
    assert.ok((await readRawDigestRegistry(vault, true)).entries["Raw/private.md"]);
    await write(path.join(privateRoot, "processed-sources.json"), []);
    assert.ok((await readRawDigestRegistry(vault, true)).entries["Raw/new.md"], "an empty private store does not shadow legacy stores");
  } finally { unbind(); }
}

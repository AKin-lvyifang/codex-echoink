import assert from "node:assert/strict";
import { maintenanceReceiptForRecord } from "../knowledge-base/maintenance-activity";
import path from "node:path";
import { planMaintenanceDomainMaps } from "../knowledge-base/maintenance-domain-map";
import {
  applyDomainMapBlockPatches,
  applyTreePlacement,
  domainMapBlock,
  treeMapPendingCount,
  appendTreeMapSources,
  rejectTreeMapGap,
  acceptTreeMapSuggestion,
  treeMapSuggestedBranch,
} from "../knowledge-base/maintenance-tree-map";
import {
  collectKnowledgeSystemReminders,
  deferKnowledgeSystemReminder,
  knowledgeSystemReminder,
  reminderProperties,
} from "../knowledge-base/knowledge-system-reminders";
import {
  readMaintenanceFrontmatterProperty,
  patchKnowledgeProperties,
} from "../knowledge-base/maintenance-source-frontmatter";
import {
  applyMaintenanceRelatedEntries,
  maintenancePlanRelations,
  MAINTENANCE_RELATION_TYPES,
  MAINTENANCE_REVERSE_RELATION,
} from "../knowledge-base/maintenance-p2-planning";
import {
  validateKnowledgeDomainAnalysis,
  renderKnowledgeFrameworkMap,
} from "../knowledge-base/knowledge-system-analysis";
import { readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { fixture } from "./knowledge-maintain-p2";
import { releaseMaintenancePages } from "../knowledge-base/maintenance-page-lock";
import type {
  MaintenanceDomainMapEntry,
  MaintenanceTreeJob,
  MaintenanceTreePlan,
} from "../knowledge-base/maintenance-p2-contract";
const block = (domain: string, body: string, mode = "tree") =>
  `<!-- echoink-domain-map:BEGIN ${encodeURIComponent(domain)} -->\n<!-- echoink-domain-map:MODE ${mode} -->\n## ${domain}\n\n${body}\n<!-- echoink-domain-map:END ${encodeURIComponent(domain)} -->`;
const document = (p: string, content: string) => ({
  path: p,
  title: p,
  aliases: [],
  contentRevision: "v1",
  content,
});
const page = (title: string, domain: string) =>
  `---\n类型: 概念\n领域: ${domain}\naliases: []\n---\n# ${title}\n${title}的具体定义，解释本主题的适用边界。\n\n## 知识正文\n新的可复用方法与条件。\n`;
export async function runKnowledgeSystemP2Tests(root: string): Promise<void> {
  const a = block(
      "AI工程",
      "### 先取证\n- [[wiki/检索候选.md]]\n\n### 执行\n- [[wiki/上下文工程.md]]\n\n### 缺口\n- 缺少实践验证\n",
    ),
    b = block("研究", "### 研究\n- [[wiki/研究问题.md]]\n"),
    outside = "---\ncustom: 0021 # 原样保留\n---\n# 共享导航\n用户手写开头。\n\n",
    full = outside + a + "\n\n用户手写分隔。\n\n" + b + "\n用户尾部。\n";
  const entries: MaintenanceDomainMapEntry[] = [
    { path: "wiki/新版/实践.md", title: "实践", domain: "AI工程", type: "概念" },
    { path: "wiki/上下文工程.md", title: "上下文工程", domain: "AI工程", type: "概念" },
    { path: "wiki/检索候选.md", title: "检索候选", domain: "AI工程", type: "概念" },
  ];
  const drafts = planMaintenanceDomainMaps({
    wikiRoot: "wiki",
    entries: [entries[0]],
    existing: [
      document("wiki/旧位置/共享导航.md", full),
      document("wiki/AI工程索引.md", "# 空的同名索引\n"),
    ],
  });
  assert.equal(
    drafts[0].targetPath,
    "wiki/旧位置/共享导航.md",
    "domain block wins after files move",
  );
  assert.equal(drafts[0].content, full);
  assert.deepEqual(drafts[0].treeDomains, ["AI工程"]);
  const job: MaintenanceTreeJob = {
    targetPath: drafts[0].targetPath,
    domain: "AI工程",
    block: a,
    entries: [entries[0]],
    sourcePaths: ["raw/实践.md"],
  };
  const proposal: MaintenanceTreePlan = {
    placements: [
      {
        path: entries[0].path,
        branch: "执行",
        parentPath: "wiki/上下文工程.md",
        reason: "实践是上下文工程的具体做法",
      },
    ],
    gaps: [],
    resolvedGaps: [
      { title: "缺少实践验证", reason: "新文补充实践方法", evidencePaths: [entries[0].path] },
    ],
  };
  const after = applyTreePlacement(job, proposal, entries);
  assert.ok(after.includes("- [[wiki/上下文工程.md]]\n  - [[wiki/新版/实践.md|实践]]"));
  assert.ok(!after.includes("缺少实践验证"));
  assert.ok(!after.includes("具体做法"));
  const merged = applyDomainMapBlockPatches(full + "稍后追加的手写内容。\n", [
    { domain: "AI工程", before: a, after },
  ]);
  assert.equal(domainMapBlock(merged, "研究"), b);
  assert.ok(merged.startsWith(outside));
  assert.ok(merged.endsWith("稍后追加的手写内容。\n"));
  assert.throws(
    () =>
      applyDomainMapBlockPatches(full.replace("先取证", "用户改了分支"), [
        { domain: "AI工程", before: a, after },
      ]),
    /并发冲突/u,
  );
  assert.throws(() => applyTreePlacement(job, { ...proposal, resolvedGaps: [] }, entries), /删除/u);
  const waiting = applyTreePlacement(
    { ...job, block: block("AI工程", "### 执行\n") },
    { placements: [{ path: entries[0].path, branch: "待归位", reason: "资料不足" }], gaps: [] },
    entries,
  );
  assert.equal(treeMapPendingCount(waiting), 1);
  const suggested = applyTreePlacement(
    { ...job, block: block("AI工程", "### 执行\n用户手写。  \n") },
    { placements: [{ path: entries[0].path, branch: "待归位", suggestedBranch: "执行", reason: "建议先由用户确认" }], gaps: [] },
    entries,
  );
  assert.equal(treeMapSuggestedBranch(suggested), "执行");
  const sharedSuggestion = outside + suggested + "\n" + b;
  const accepted = acceptTreeMapSuggestion(sharedSuggestion, "AI工程", job.targetPath, entries[0].path, "执行", entries);
  const oldLine = sharedSuggestion.split("\n").find((line) => line.includes("echoink-placement:"))!;
  const newLine = oldLine.replace(/ <!-- echoink-placement: .* -->/u, "");
  assert.equal(sharedSuggestion.replace(oldLine + "\n", ""), accepted.replace(newLine + "\n", ""), "Accept moves only the recommended entry line");
  assert.equal(domainMapBlock(accepted, "研究"), b);
  assert.equal(treeMapPendingCount(domainMapBlock(accepted, "AI工程")!), 0);
  assert.throws(() => acceptTreeMapSuggestion(sharedSuggestion, "AI工程", job.targetPath, entries[0].path, "其他", entries), /建议已变化/u);
  const rejected = rejectTreeMapGap(full, "AI工程", "缺少实践验证");
  assert.deepEqual(readMaintenanceFrontmatterProperty(rejected, "不算缺口").value, ["缺少实践验证"]);
  assert.equal(domainMapBlock(rejected, "研究"), b);
  assert.ok(rejected.includes("custom: 0021 # 原样保留"));
  const ignored = applyTreePlacement(
    { ...job, block: domainMapBlock(rejected, "AI工程")! },
    { placements: [{ path: entries[0].path, branch: "待归位", reason: "待判断" }],
      gaps: [{ title: "缺少实践验证", reason: "旧判断", evidencePaths: [entries[0].path] }] },
    entries, ["缺少实践验证"],
  );
  assert.ok(!ignored.includes("- 缺少实践验证"), "Maintain respects the persisted rejection");
  const withSources = appendTreeMapSources(waiting, "[[raw/来源.md]]\n<!-- echoink-source: {} -->");
  assert.equal(
    treeMapPendingCount(withSources),
    1,
    "source links never count as unplaced knowledge",
  );
  assert.ok(withSources.includes("### 来源\n[[raw/来源.md]]"));
  assert.ok(!after.includes("### 缺口"), "filled empty gap section disappears");
  const reminder = knowledgeSystemReminder(full, "AI工程", job.targetPath, "list", 15)!;
  assert.ok(reminder);
  const delayed = deferKnowledgeSystemReminder(full, reminder);
  assert.equal(knowledgeSystemReminder(delayed, "AI工程", job.targetPath, "list", 24), null);
  assert.ok(knowledgeSystemReminder(delayed, "AI工程", job.targetPath, "list", 25));
  const recorded = patchKnowledgeProperties(full, reminderProperties(reminder));
  assert.equal(readMaintenanceFrontmatterProperty(recorded, "上次体系提醒-AI工程-清单").value, 15);
  assert.ok(recorded.includes("custom: 0021 # 原样保留"));
  assert.equal(knowledgeSystemReminder(full, "AI工程", job.targetPath, "tree", 9), null);
  assert.ok(knowledgeSystemReminder(full, "AI工程", job.targetPath, "tree", 10));
  const noMapDocs = Array.from({ length: 15 }, (_, i) => ({
    path: `wiki/${i}.md`,
    content: `---\n领域: AI工程\n类型: 概念\n---\n# ${i}`,
  }));
  assert.equal(collectKnowledgeSystemReminders(noMapDocs, "wiki")[0].count, 15);
  for (const type of MAINTENANCE_RELATION_TYPES) {
    const related = maintenancePlanRelations([
      {
        id: "p",
        targetPath: "wiki/甲.md",
        sourcePaths: [],
        expectedTarget: { kind: "missing" },
        knowledge: {
          unitIds: [],
          decision: { kind: "new", reason: "独立" },
          related: [
            { targetPath: "wiki/乙.md", type, reason: "正向理由", reverseReason: "反向理由" },
          ],
        },
      },
    ]);
    assert.equal(related.get("wiki/乙.md")![0].type, MAINTENANCE_REVERSE_RELATION[type]);
  }
  const explicit = (from: string, to: string, type: "上位" | "对比") => ({
    id: from,
    targetPath: from,
    sourcePaths: [],
    expectedTarget: { kind: "missing" as const },
    knowledge: {
      unitIds: [],
      decision: { kind: "new" as const, reason: "独立" },
      related: [{ targetPath: to, type, reason: "正向理由", reverseReason: "反向理由" }],
    },
  });
  assert.throws(
    () =>
      maintenancePlanRelations([
        explicit("wiki/甲.md", "wiki/乙.md", "上位"),
        explicit("wiki/乙.md", "wiki/甲.md", "对比"),
      ]),
    /互相矛盾/u,
    "contradictory explicit directions never silently keep the first type",
  );
  const old =
    "# 甲\n\n## 相关条目\n\n<!-- echoink-related:BEGIN -->\n- [[wiki/旧.md|旧]] — 历史自由文本理由\n<!-- echoink-related:END -->\n";
  const typed = applyMaintenanceRelatedEntries(
    old,
    [{ targetPath: "wiki/新.md", type: "上位", reason: "具体方法属于该概念" }],
    old,
  );
  assert.ok(typed.includes("- [[wiki/旧.md|旧]] — 历史自由文本理由"));
  assert.ok(typed.includes("- 上位：[[wiki/新.md|新]]"));
  const framework = {
    title: "时序",
    rationale: "先检索再执行",
    order: "sequence" as const,
    branches: [
      {
        title: "执行",
        rationale: "真实上下位",
        entries: [
          {
            path: "wiki/上下文工程.md",
            why: "上位",
            children: [{ path: "wiki/新版/实践.md", why: "下位" }],
          },
        ],
      },
    ],
    unplaced: [],
    gaps: [{ title: "缺少案例验证", reason: "依据只留提案", evidencePaths: [entries[0].path] }],
  };
  const rendered = renderKnowledgeFrameworkMap("AI工程", framework);
  assert.ok(rendered.includes("  - [[wiki/新版/实践.md"));
  assert.ok(!rendered.includes("依据只留提案"));
  assert.throws(
    () =>
      validateKnowledgeDomainAnalysis(
        { domain: "AI工程", frameworks: [framework, framework] },
        entries.slice(0, 2).map((e) => ({ path: e.path, content: "", revision: "" })),
        "AI工程",
      ),
    /全部相同/u,
  );
  let calls = 0;
  const f = await fixture(path.join(root, "durable-tree"), {
    treePlacement: async (request) => {
      calls++;
      return {
        placements: request.job.entries.map((entry) => ({
          path: entry.path,
          branch: entry.domain === "AI工程" ? "执行" : "研究",
          reason: "本篇全文支持本分支",
        })),
        gaps: [],
      };
    },
  });
  try {
    const mapPath = "wiki/导航/index.md",
      shared = outside + block("AI工程", "### 执行\n\n用户手写树内说明。\n") + "\n\n" + b + "\n";
    await f.write(mapPath, shared);
    await f.write("wiki/研究问题.md", page("研究问题", "研究"));
    await f.write("raw/树.md", "# 来源\n批量插入两领域条目且保留用户手写。\n");
    const u = await f.unit("tree-a", "raw/树.md", "新执行"),
      v = await f.unit("tree-b", "raw/树.md", "新研究");
    u.domain = "AI工程";
    v.domain = "研究";
    f.ok(await f.decompose(["raw/树.md"], [u, v]));
    const invalidDirectory = await f.call({ stage: "plan", writingPlan: [
      f.item("a", "wiki/AI工程/凭空新分支/新执行.md", ["raw/树.md"], [u.id]),
      f.item("b", "wiki/新研究.md", ["raw/树.md"], [v.id]),
    ] }, ["raw/树.md"]);
    assert.equal(invalidDirectory.status, "failed");
    assert.match(invalidDirectory.message, /目标目录必须已存在.*归不进去的条目保存到 wiki/u);
    assert.equal((await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.phase, "plan",
      "Rejected paths must not freeze the writing plan; the same task can correct its directory");
    f.ok(
      await f.call(
        {
          stage: "plan",
          writingPlan: [
            f.item("a", "wiki/新执行.md", ["raw/树.md"], [u.id]),
            f.item("b", "wiki/新研究.md", ["raw/树.md"], [v.id]),
          ],
        },
        ["raw/树.md"],
      ),
    );
    f.ok(
      await f.call(
        {
          stage: "write",
          pageId: "a",
          content: page("新执行", "AI工程").replace("领域: AI工程\n", ""),
        },
        ["raw/树.md"],
      ),
    );
    f.fail(mapPath);
    const failure = await f.call({ stage: "write", pageId: "b", content: page("新研究", "研究") }, [
      "raw/树.md",
    ]);
    assert.equal(failure.status, "failed");
    assert.equal(calls, 2);
    const record = (await readPrivateMaintenanceRecords(f.privateRoot))[0];
    assert.ok(record.p1!.p2!.treeJobs!.every((job) => job.plan && job.coverage?.length));
    const primaryWrites = f.writes.filter(
      (p) => p === "wiki/新执行.md" || p === "wiki/新研究.md",
    ).length;
    f.fail(null);
    await f.restart();
    const resumed = await f.call({ stage: "resume" }, ["raw/树.md"]);
    f.ok(resumed);
    assert.match(resumed.userReceipt!.text, /2 篇放进分支/u);
    assert.match(resumed.userReceipt!.text, /）\uFF0C2 篇放进分支。/u);
    const completedRecord = (await readPrivateMaintenanceRecords(f.privateRoot))[0];
    const placements = completedRecord.p1!.p2!.treeJobs!.flatMap(job => job.plan!.placements);
    placements[0].branch = "待归位";
    assert.match(maintenanceReceiptForRecord(completedRecord).text, /）\uFF0C1 篇放进分支，1 篇待归位。/u);
    placements[1].branch = "待归位";
    assert.match(maintenanceReceiptForRecord(completedRecord).text, /）\uFF0C2 篇待归位。/u);
    assert.doesNotMatch(resumed.userReceipt!.text, /0 篇/u);
    assert.equal(
      calls,
      2,
      "accepted batch placement proposals survive cold restart; model not repeated",
    );
    assert.ok(
      record
        .p1!.p2!.treeJobs!.find((job) => job.domain === "AI工程")!
        .coverage!.some((doc) => doc.path === "wiki/新执行.md"),
      "a Wiki missing visible domain is still fully read using its existing validated classification checkpoint",
    );
    assert.equal(
      f.writes.filter((p) => p === "wiki/新执行.md" || p === "wiki/新研究.md").length,
      primaryWrites,
    );
    const map = await f.read(mapPath);
    assert.ok(map.includes("用户手写树内说明。"));
    assert.ok(map.startsWith(outside));
    assert.ok(domainMapBlock(map, "AI工程")!.includes("新执行"));
    assert.ok(domainMapBlock(map, "研究")!.includes("新研究"));
  } finally {
    for (const record of await readPrivateMaintenanceRecords(f.privateRoot))
      releaseMaintenancePages(record.recordId);
    f.release();
  }
  console.log(
    "PASS knowledge system P2: block-first discovery, user tree preservation, shared indexes, local " +
      "conflict refusal, second level, short gaps, deferred thresholds, typed inverse/legacy text and " +
      "durable batch recovery without repeated model calls.",
  );
}

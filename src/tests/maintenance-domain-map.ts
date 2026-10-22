import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER,
  MAINTENANCE_DOMAIN_MAP_TYPES,
  planMaintenanceDomainMaps
} from "../knowledge-base/maintenance-domain-map";
import type { MaintenanceDomainMapEntry, MaintenanceWikiDocument } from "../knowledge-base/maintenance-p2-contract";

const root = "个人知识/知识条目";
const entry = (path: string, title = path, domain = "计算机", type = MAINTENANCE_DOMAIN_MAP_TYPES[0]): MaintenanceDomainMapEntry => ({ path, title, domain, type });
const document = (path: string, content: string): MaintenanceWikiDocument => ({
  path, content, title: path, aliases: [], contentRevision: `sha256:${"0".repeat(64)}`
});
const begin = (domain: string): string => `<!-- echoink-domain-map:BEGIN ${encodeURIComponent(domain)} -->`;
const end = (domain: string): string => `<!-- echoink-domain-map:END ${encodeURIComponent(domain)} -->`;

export async function runMaintenanceDomainMapTests(): Promise<void> {
  const entries = MAINTENANCE_DOMAIN_MAP_TYPES.map((type, index) => entry(`${root}/领域/条目${index}.md`, `标题${index}`, "计算机", type));
  const fresh = planMaintenanceDomainMaps({ wikiRoot: root, entries: [...entries, entries[0]], existing: [] });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].targetPath, `${root}/计算机索引.md`);
  assert.deepEqual(fresh[0].expectedTarget, { kind: "missing" });
  assert.equal(fresh[0].content.split(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER).length, 2);
  for (const type of MAINTENANCE_DOMAIN_MAP_TYPES) assert.ok(fresh[0].content.includes(`### ${type}\n`));
  assert.equal((fresh[0].content.match(/^- \[/gmu) ?? []).length, 7, "duplicate paths appear only once");
  assert.ok(fresh[0].content.includes("[标题0](<%E9%A2%86%E5%9F%9F/%E6%9D%A1%E7%9B%AE0.md>)"));
  assert.deepEqual(planMaintenanceDomainMaps({ wikiRoot: root, entries: [...entries].reverse(), existing: [] }), fresh);

  const prefix = "\uFEFF---\r\ntitle: 原属性\r\nunknown: |\r\n  不得改动\r\n---\r\n手写段落😀  \r\n\r\n";
  const suffix = "\r\n \r\n## 手写尾部\r\n空白与结尾都保留  ";
  const oldBlock = [begin("计算机"), "旧受管内容", end("计算机")].join("\r\n");
  const existing = document(`${root}/另一个目录/计算机索引.md`, prefix + oldBlock + suffix);
  const update = planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [existing] })[0];
  assert.equal(update.targetPath, existing.path);
  assert.equal(update.content.slice(0, prefix.length), prefix);
  assert.equal(update.content.slice(-suffix.length), suffix);
  assert.ok(!update.content.includes("旧受管内容"));
  assert.deepEqual(update.expectedTarget, { kind: "file", contentRevision: `sha256:${createHash("sha256").update(existing.content).digest("hex")}` });
  assert.equal(planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [document(update.targetPath, update.content)] })[0].content, update.content, "replanning is idempotent");
  const otherBlock = `\n${begin("其他")}\n其他受管块也不是本次修改对象  \n${end("其他")}\n`;
  const shared = document(existing.path, otherBlock + existing.content);
  assert.ok(planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [shared] })[0].content.startsWith(otherBlock + prefix), "unselected managed blocks also remain byte-for-byte identical");

  const unmarked = document(`${root}/计算机索引.md`, "---\ntitle: 原属性\n---\n手写正文  ");
  const append = planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [unmarked] })[0];
  assert.ok(append.content.startsWith(unmarked.content + "\n\n"), "append retains every original byte");
  const normalCode = document(unmarked.path, "# 手写说明\n\n```html\n<!-- 未闭合注释只是代码 -->\n```\n\n正文\n");
  assert.ok(planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [normalCode] })[0].content.startsWith(normalCode.content));
  const dirIndex = document(`${root}/领域/index.md`, "# 已有目录索引\n");
  const rootIndex = document(`${root}/index.md`, "# 总索引\n");
  assert.equal(planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [rootIndex, dirIndex] })[0].targetPath, dirIndex.path);
  assert.equal(planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [dirIndex, unmarked] })[0].targetPath, unmarked.path, "named index has priority over a directory index");
  const mixedEntries = [entries[0], entry(`${root}/领域/其他.md`, "艺术条目", "艺术", "观点 / 论断")];
  const aggregated = planMaintenanceDomainMaps({ wikiRoot: root, entries: mixedEntries, existing: [rootIndex] });
  assert.equal(aggregated.length, 1, "a shared root index produces one page draft");
  assert.equal(aggregated[0].targetPath, rootIndex.path);
  assert.equal(aggregated[0].domain, "艺术");
  assert.deepEqual(aggregated[0].domains, ["艺术", "计算机"]);
  assert.ok(aggregated[0].content.startsWith(rootIndex.content));
  assert.ok(aggregated[0].content.includes(begin("艺术")) && aggregated[0].content.includes(begin("计算机")));
  assert.equal(aggregated[0].content.split(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER).length, 2);
  assert.deepEqual(planMaintenanceDomainMaps({ wikiRoot: root, entries: [...mixedEntries].reverse(), existing: [rootIndex] }), aggregated);
  assert.equal(planMaintenanceDomainMaps({ wikiRoot: root, entries: mixedEntries, existing: [document(rootIndex.path, aggregated[0].content)] })[0].content, aggregated[0].content);
  const untouched = `${begin("历史")}\r\n旧历史块与来源 [[旧资料]]  \r\n${end("历史")}`;
  const middle = "\r\n\r\n## 手写分隔内容  \r\n😀\r\n";
  const oldArt = `${begin("艺术")}\r\n旧艺术来源 [[待替换]]\r\n${end("艺术")}`;
  const mixedBefore = prefix + oldBlock + middle + untouched + middle + oldArt + suffix;
  const mixedUpdate = planMaintenanceDomainMaps({ wikiRoot: root, entries: mixedEntries, existing: [document(rootIndex.path, mixedBefore)] })[0];
  assert.ok(mixedUpdate.content.startsWith(prefix));
  assert.ok(mixedUpdate.content.endsWith(suffix));
  assert.ok(mixedUpdate.content.includes(middle + untouched + middle), "unselected blocks and handwritten interleaving stay identical");
  assert.ok(!mixedUpdate.content.includes("旧受管内容") && !mixedUpdate.content.includes("旧艺术来源"));
  assert.equal(mixedUpdate.content.split(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER).length, 2);
  assert.ok(mixedUpdate.content.indexOf(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER) > mixedUpdate.content.indexOf(begin("艺术")), "sources belong to the last updated block in document order");
  const finalized = aggregated[0].content.replace(MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER, "[[既有来源]]\n<!-- echoink-source: existing -->");
  const addDomain = planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/新条目.md`, "科学条目", "科学")], existing: [document(rootIndex.path, finalized)] })[0];
  assert.ok(addDomain.content.startsWith(finalized), "adding a new domain cannot erase earlier domains or provenance");
  const foreignOnly = document(unmarked.path, `${begin("其他")}\n手写保留于旧地图\n${end("其他")}\n`);
  assert.ok(planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [foreignOnly] })[0].content.startsWith(foreignOnly.content));

  const safe = planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/a [x]#?.md`, "[危险](链接)\n<!--标记-->", "AI/工具")], existing: [] })[0];
  assert.equal(safe.targetPath, `${root}/AI_工具索引.md`);
  assert.ok(safe.content.includes("[\\[危险\\]\\(链接\\) &lt;\\!\u002d\u002d标记\u002d\u002d&gt;]"));
  assert.ok(safe.content.includes("a%20%5Bx%5D%23%3F.md"), "special path characters remain in the clickable destination");
  const self = planMaintenanceDomainMaps({ wikiRoot: root, entries: [...entries, entry(`${root}/计算机索引.md`, "地图自己")], existing: [] })[0];
  assert.ok(!self.content.includes("地图自己"));
  const otherMap = document(`${root}/other-map.md`, [begin("其他"), "已生成地图", end("其他")].join("\n"));
  const noCycle = planMaintenanceDomainMaps({ wikiRoot: root, entries: [...entries, entry(otherMap.path, "其他地图")], existing: [otherMap] })[0];
  assert.ok(!noCycle.content.includes("[其他地图]"));

  const refuse = (content: string): void => {
    assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [document(`${root}/计算机索引.md`, content)] }), /领域地图|未闭合/u);
  };
  for (const content of [
    begin("计算机"), end("计算机"), `${begin("计算机")}\n${end("其他")}`,
    `${oldBlock}\n${oldBlock}`, `${begin("计算机")}\n${begin("其他")}\n${end("其他")}\n${end("计算机")}`,
    `手写文字 ${begin("计算机")}\n${end("计算机")}`, "<!-- echoink-domain-map:BEGIN %ZZ -->",
    `${begin("计算机")}\n${MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER}\n${MAINTENANCE_DOMAIN_MAP_SOURCES_PLACEHOLDER}\n${end("计算机")}`,
    `\u0060\u0060\u0060md\n${oldBlock}\n\u0060\u0060\u0060`, `---\n${oldBlock}\n---`, `<!--\n${oldBlock}\n-->`,
    `<pre>\n${oldBlock}\n</pre>`, "```未闭合"
  ]) refuse(content);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries, existing: [unmarked, document(`${root}/领域/计算机索引.md`, "")] }), /多个同名索引/u);
  assert.equal(planMaintenanceDomainMaps({ wikiRoot: root, entries: mixedEntries, existing: [dirIndex] }).length, 1, "a nested shared directory index also produces one draft");
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/a.md`, "A", "A/B"), entry(`${root}/b.md`, "B", "A:B")], existing: [] }), /多个领域选中同一地图路径/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entries[0], { ...entries[0], type: "工具 / 产品" }], existing: [] }), /属性冲突/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/../越界.md`)], existing: [] }), /路径无效/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry("其他/越界.md")], existing: [] }), /不在绑定 Wiki 内/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: "/", entries: [], existing: [] }), /路径无效/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/a.md`, "A", "领域".repeat(50))], existing: [] }), /安全的索引文件名/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/a.md`), entry(`${root}/A.md`)], existing: [] }), /路径大小写/u);
  assert.throws(() => planMaintenanceDomainMaps({ wikiRoot: root, entries: [entry(`${root}/a.md`, "A", "AI"), entry(`${root}/b.md`, "B", "ai")], existing: [] }), /领域名称存在/u);
  assert.deepEqual(planMaintenanceDomainMaps({ wikiRoot: root, entries: [], existing: [] }), []);
  console.log("Maintenance domain maps: PASS (seven types, bound paths, deterministic planning, exact outside bytes, CAS hash, reuse, escaping, cycles, malformed/conflicting refusal)");
}

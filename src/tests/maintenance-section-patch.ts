import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyMaintenanceSectionPatches,
  createMaintenanceSectionSnapshot,
  MaintenanceSectionPatchError
} from "../knowledge-base/maintenance-section-patch";
import type { MaintenanceSectionPatchErrorCode } from "../knowledge-base/maintenance-section-patch";
import type { MaintenanceSectionRegion, MaintenanceSectionSnapshot } from "../knowledge-base/maintenance-p1-contract";

export async function runMaintenanceSectionPatchTests(): Promise<void> {
  const markdown = [
    "---", "title: 分区测试", "nested: |", "  # 属性中的假标题", "---",
    "前言原文😀", "", "# 页面标题", "", "导语原文😀", "",
    "## 同名", "第一处原文", "", "### 子区域", "子区域原文", "",
    "## 同名", "第二处原文", "", "## 来源", "- [[来源甲]]", "",
    "## 相关条目", "- [[条目乙]]", ""
  ].join("\r\n");
  const snapshot = createMaintenanceSectionSnapshot(markdown);
  assert.equal(snapshot.revision, `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`);
  assert.deepEqual(snapshot.regions.map(region => [region.title, region.kind]), [
    ["前言", "introduction"], ["导语", "introduction"], ["同名", "section"],
    ["子区域", "section"], ["同名", "section"], ["来源", "sources"], ["相关条目", "related"]
  ]);
  assert.equal(new Set(snapshot.regions.map(region => region.id)).size, snapshot.regions.length);
  assert.deepEqual(createMaintenanceSectionSnapshot(markdown), snapshot, "the same text produces stable IDs");
  snapshot.regions.forEach((region, index) => {
    assert.equal(region.end, snapshot.regions[index + 1]?.start ?? markdown.length);
    assert.ok(region.start <= region.contentStart && region.contentStart <= region.end);
    assert.ok(region.id.endsWith(`:${index + 1}`), "IDs contain their snapshot-bound ordinal");
  });
  assert.equal(snapshot.regions[0].start, markdown.indexOf("前言原文"));

  const duplicateHeadings = snapshot.regions.filter(region => region.title === "同名");
  const updated = applyMaintenanceSectionPatches(markdown, snapshot, [
    { regionId: duplicateHeadings[1].id, operation: "replace", content: "仅替换第二处😀" },
    { regionId: snapshot.regions[1].id, operation: "append", content: "导语新增段落" }
  ]);
  const updatedSnapshot = createMaintenanceSectionSnapshot(updated);
  assert.equal(contentOf(updated, updatedSnapshot.regions[4]), "仅替换第二处😀\r\n");
  assert.equal(contentOf(updated, updatedSnapshot.regions[1]), "\r\n导语原文😀\r\n\r\n导语新增段落\r\n");
  assertUntouched(markdown, snapshot, updated, updatedSnapshot, [1, 4]);
  assert.equal(updated.slice(0, updatedSnapshot.regions[0].start), markdown.slice(0, snapshot.regions[0].start), "frontmatter stays byte-for-byte identical");
  assert.equal(contentOf(updated, updatedSnapshot.regions[2]), contentOf(markdown, duplicateHeadings[0]), "same-name headings are never guessed");

  const nested = applyMaintenanceSectionPatches(markdown, snapshot, [
    { regionId: snapshot.regions[2].id, operation: "replace", content: "父标题自己的正文" }
  ]);
  const nestedSnapshot = createMaintenanceSectionSnapshot(nested);
  assertUntouched(markdown, snapshot, nested, nestedSnapshot, [2]);
  assert.equal(contentOf(nested, nestedSnapshot.regions[3]), contentOf(markdown, snapshot.regions[3]), "parent edits cannot consume nested regions");

  const intro = applyMaintenanceSectionPatches(markdown, snapshot, [
    { regionId: snapshot.regions[1].id, operation: "replace", content: "新的独立导语" },
    { regionId: snapshot.regions[0].id, operation: "replace", content: "新的独立前言" }
  ]);
  const introSnapshot = createMaintenanceSectionSnapshot(intro);
  assert.equal(intro.slice(introSnapshot.regions[1].start, introSnapshot.regions[1].contentStart), "# 页面标题\r\n");
  assertUntouched(markdown, snapshot, intro, introSnapshot, [0, 1]);
  for (const kind of ["sources", "related"] as const) {
    const region = snapshot.regions.find(candidate => candidate.kind === kind)!;
    const result = applyMaintenanceSectionPatches(markdown, snapshot, [{ regionId: region.id, operation: "append", content: "- [[新增引用]]" }]);
    const resultSnapshot = createMaintenanceSectionSnapshot(result);
    assertUntouched(markdown, snapshot, result, resultSnapshot, [snapshot.regions.indexOf(region)]);
    assert.ok(contentOf(result, resultSnapshot.regions[snapshot.regions.indexOf(region)]).includes("- [[新增引用]]"));
  }

  const fenced = [
    "# 页面标题", "", "```markdown", "## 反引号假标题", "```", "",
    "~~~~ js", "## 波浪假标题", "~~~", "# 短围栏未关闭", "~~~~", "",
    "    # 缩进代码假标题", "    缩进标题", "    ---", "", "\t## Tab代码假标题", "",
    "<!--", "## 注释假标题", "-->", "", "<pre>", "## HTML假标题", "</pre>", "",
    "## 真实标题", "正文", ""
  ].join("\n");
  assert.deepEqual(createMaintenanceSectionSnapshot(fenced).regions.map(region => region.title), ["前言", "导语", "真实标题"]);
  assert.deepEqual(createMaintenanceSectionSnapshot("# 页面\n\n- ```md\n  ## 列表围栏假标题\n  ```\n\n> ~~~\n> ## 引用围栏假标题\n> ~~~\n\n## 真实\n").regions.map(region => region.title), ["前言", "导语", "真实"]);
  assert.deepEqual(createMaintenanceSectionSnapshot("# 页面\n\n```\n## 未闭合围栏假标题\n").regions.map(region => region.title), ["前言", "导语"]);
  assert.deepEqual(createMaintenanceSectionSnapshot("    代码\n---\n\n## 真标题\n").regions.map(region => region.title), ["导语", "真标题"], "a thematic break after indented code is not a heading");
  assert.deepEqual(createMaintenanceSectionSnapshot("- ## 列表标题\n  正文\n\n> ### 引用标题\n> 正文\n\n## 普通标题\n").regions.map(region => region.title), ["导语", "列表标题", "引用标题", "普通标题"]);
  assert.deepEqual(createMaintenanceSectionSnapshot("- # 列表H1\n  正文\n").regions.map(region => region.title), ["导语", "列表H1"], "a heading in a list is not the page title");

  const setext = "\uFEFF---\r\ntitle: 保留\r\n...\r\n前言\r\n\r\n页面标题\r\n=====\r\n\r\n导语\r\n\r\n两行\r\n标题\r\n---\r\n正文\r\n\r\n## 末尾 ###\r\n结束";
  const setextSnapshot = createMaintenanceSectionSnapshot(setext);
  assert.deepEqual(setextSnapshot.regions.map(region => region.title), ["前言", "导语", "两行 标题", "末尾"]);
  assert.equal(setext.slice(setextSnapshot.regions[2].start, setextSnapshot.regions[2].contentStart), "两行\r\n标题\r\n---\r\n");
  const setextUpdated = applyMaintenanceSectionPatches(setext, setextSnapshot, [{ regionId: setextSnapshot.regions[1].id, operation: "replace", content: "新导语" }]);
  const setextAfter = createMaintenanceSectionSnapshot(setextUpdated);
  assert.equal(contentOf(setextUpdated, setextAfter.regions[1]), "新导语\r\n\r\n", "Setext boundaries retain a paragraph break");
  assertUntouched(setext, setextSnapshot, setextUpdated, setextAfter, [1]);

  const endHeading = "# 页面标题";
  const endSnapshot = createMaintenanceSectionSnapshot(endHeading);
  assert.equal(applyMaintenanceSectionPatches(endHeading, endSnapshot, [{ regionId: endSnapshot.regions[1].id, operation: "replace", content: "新增导语" }]), "# 页面标题\n新增导语");
  const emptyIntro = createMaintenanceSectionSnapshot("## 正文\n原文");
  assert.equal(applyMaintenanceSectionPatches("## 正文\n原文", emptyIntro, [{ regionId: emptyIntro.regions[0].id, operation: "replace", content: "首段" }]), "首段\n## 正文\n原文");
  const bomIntro = createMaintenanceSectionSnapshot("\uFEFF## 正文\n原文");
  assert.equal(applyMaintenanceSectionPatches("\uFEFF## 正文\n原文", bomIntro, [{ regionId: bomIntro.regions[0].id, operation: "replace", content: "首段" }]), "\uFEFF首段\n## 正文\n原文");
  assert.equal(applyMaintenanceSectionPatches(markdown, snapshot, []), markdown);
  assert.equal(applyMaintenanceSectionPatches(markdown, snapshot, [{ regionId: duplicateHeadings[0].id, operation: "append", content: "" }]), markdown);

  expectError(() => applyMaintenanceSectionPatches(markdown, snapshot, [{ regionId: "section:999", operation: "replace", content: "无效" }]), "UNKNOWN_REGION", snapshot);
  expectError(() => applyMaintenanceSectionPatches(markdown + "并发修改", snapshot, [{ regionId: duplicateHeadings[0].id, operation: "replace", content: "无效" }]), "STALE_SNAPSHOT", createMaintenanceSectionSnapshot(markdown + "并发修改"));
  const another = createMaintenanceSectionSnapshot(markdown + "另一版本");
  expectError(() => applyMaintenanceSectionPatches(markdown, snapshot, [{ regionId: another.regions[2].id, operation: "replace", content: "无效" }]), "UNKNOWN_REGION", snapshot);
  expectError(() => applyMaintenanceSectionPatches(markdown, { ...snapshot, regions: snapshot.regions.map((region, index) => index === 2 ? { ...region, end: markdown.length } : region) }, []), "INVALID_SNAPSHOT", snapshot);
  expectError(() => applyMaintenanceSectionPatches(markdown, snapshot, [
    { regionId: duplicateHeadings[0].id, operation: "append", content: "第一次" },
    { regionId: duplicateHeadings[0].id, operation: "replace", content: "第二次" }
  ]), "DUPLICATE_REGION_PATCH", snapshot);
  for (const content of ["## 新标题", "正文\n新标题\n---", "正文\n=", "```\n代码\n```", "~~~", "    ### 保守拒绝缩进标题", "> ```\n> 代码\n> ```", "- ~~~\n  代码\n  ~~~", "1. # 列表标题", "<!--"]) {
    expectError(() => applyMaintenanceSectionPatches(markdown, snapshot, [{ regionId: duplicateHeadings[0].id, operation: "replace", content }]), "BOUNDARY_CHANGE", snapshot);
  }
  const unheaded = "---\ntitle: 属性\n---\n整页正文";
  const unheadedSnapshot = createMaintenanceSectionSnapshot(unheaded);
  expectError(() => applyMaintenanceSectionPatches(unheaded, unheadedSnapshot, [{ regionId: unheadedSnapshot.regions[0].id, operation: "replace", content: "整页替换" }]), "WHOLE_PAGE_REPLACE", unheadedSnapshot);
  assert.equal(applyMaintenanceSectionPatches(unheaded, unheadedSnapshot, [{ regionId: unheadedSnapshot.regions[0].id, operation: "append", content: "补充" }]), unheaded + "\n\n补充");
  assert.equal(applyMaintenanceSectionPatches("", createMaintenanceSectionSnapshot(""), []), "");
  console.log("Maintenance section patches: PASS (snapshot IDs, disjoint regions, introductions, fenced/indented code, Setext, byte preservation, stale/invalid IDs, boundary rejection)");
}

function contentOf(markdown: string, region: MaintenanceSectionRegion): string {
  return markdown.slice(region.contentStart, region.end);
}

function assertUntouched(before: string, beforeSnapshot: MaintenanceSectionSnapshot, after: string, afterSnapshot: MaintenanceSectionSnapshot, changed: number[]): void {
  assert.equal(afterSnapshot.regions.length, beforeSnapshot.regions.length);
  assert.equal(after.slice(0, afterSnapshot.regions[0].start), before.slice(0, beforeSnapshot.regions[0].start));
  beforeSnapshot.regions.forEach((region, index) => {
    const updated = afterSnapshot.regions[index];
    assert.equal(after.slice(updated.start, updated.contentStart), before.slice(region.start, region.contentStart), `heading ${index} stays identical`);
    if (!changed.includes(index)) assert.equal(contentOf(after, updated), contentOf(before, region), `unselected content ${index} stays identical`);
  });
}

function expectError(action: () => unknown, code: MaintenanceSectionPatchErrorCode, current: MaintenanceSectionSnapshot): void {
  assert.throws(action, error => {
    assert.ok(error instanceof MaintenanceSectionPatchError);
    assert.equal(error.code, code);
    assert.deepEqual(error.currentSnapshot, current);
    for (const region of current.regions) assert.ok(error.message.includes(region.id), "error carries the current re-listable directory");
    return true;
  });
}

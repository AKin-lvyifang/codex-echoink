import assert from "node:assert/strict";
import { TFile, type App } from "obsidian";
import { openTestNoticeMessages } from "./obsidian-shim";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { KnowledgeBaseMaintenanceHistoryEntry } from "../settings/settings";
import {
  mergeKnowledgeMaintenanceHistory,
  knowledgeMaintenanceHistoryStatus,
  renderKnowledgeMaintenanceHistoryList,
  renderKnowledgeMaintenanceRecordDetail,
  openKnowledgeMaintenancePath,
  type KnowledgeMaintenanceHistoryState
} from "../settings/knowledge-maintenance-history";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";

const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const record = (index: number, status: KnowledgeMaintenanceRecord["result"]["status"] = "completed"): KnowledgeMaintenanceRecord => ({
  schemaVersion: 1, recordId: `record-${index}`, runId: `run-${index}`, date: index < 21 ? "2026-10-17" : "2026-10-18", at: Date.UTC(2026, 9, 18, 0, index),
  summary: `保留原语言的摘要 ${index}`,
  sources: [{ path: `资料/来源-${index}.md`, fingerprint: "synthetic", status: "unread", evidencePaths: [] }],
  result: { schema: "echoink.knowledge-maintenance-result.v1", status, systemPaths: [],
    notes: [{ operation: "created", path: `Wiki/成果-${index}.md`, title: "原始成果标题", summary: "原始成果摘要" }],
    assessments: [{ claim: "原始判断", status: "needs_supplement", asOf: "2026-10-18", verification: "unverified", evidence: ["原始证据"] }],
    issues: [{ code: "unread", path: "资料/未读.md", message: "原始未完成原因" }] }
});
const legacy = (path: string): KnowledgeBaseMaintenanceHistoryEntry => ({ date: "2026-10-16", at: 1, mode: "maintain", status: "success", reportPath: path });

export async function runKnowledgeMaintenanceHistoryTests(): Promise<void> {
  const records = Array.from({ length: 43 }, (_, index) => record(index));
  const settings = [legacy("reports/legacy.md"), { ...legacy("reports/duplicate.md"), runId: records[0].runId, status: "failed" as const }];
  const before = JSON.stringify({ settings, records });
  const entries = mergeKnowledgeMaintenanceHistory(settings, records);
  assert.equal(entries.length, 44);
  assert.equal(entries[0].recordId, "record-42");
  assert.equal(entries.find(entry => entry.runId === "run-0")!.resultStatus, "completed", "private record takes priority over settings copy");
  assert.equal(JSON.stringify({ settings, records }), before, "merge is read-only");
  const sameRun = mergeKnowledgeMaintenanceHistory([{ ...legacy("a"), runId: "old" }, { ...legacy("b"), runId: "old" }], []);
  assert.equal(sameRun.length, 1, "legacy run duplicates do not inflate history or recent five");
  assert.equal(mergeKnowledgeMaintenanceHistory([legacy("a"), legacy("b")], []).length, 2, "unidentified legacy reports stay distinct");
  const states = ["completed", "noop", "partial", "failed", "write_uncertain"] as const;
  const allStates = mergeKnowledgeMaintenanceHistory([], [...states.map((status, index) => record(index, status)), { ...record(7), cancelled: true }]);
  assert.deepEqual(new Set(allStates.map(entry => entry.resultStatus)), new Set([...states, "cancelled"]));
  for (const entry of allStates) assert.ok(knowledgeMaintenanceHistoryStatus(entry, true));

  const host = document.body.createDiv();
  const sibling = document.body.createDiv();
  let siblingClicks = 0;
  createOriginButton(sibling, { text: "旁边的真实Origin控件" }).onclick = () => { siblingClicks++; };
  const files = new Map(["reports/legacy.md", "Wiki/成果-0.md"].map(path => [path, Object.assign(new TFile(), { path })]));
  const opened: string[] = [];
  const app = { vault: { getAbstractFileByPath: (path: string) => files.get(path) }, workspace: { getLeaf: () => ({ async openFile(file: TFile) { opened.push(file.path); } }) } } as unknown as App;
  const state: KnowledgeMaintenanceHistoryState = { date: "", page: 1, listScroll: 0 };
  let cleanup = () => {}, selected: KnowledgeMaintenanceRecord | undefined;
  let unavailable = 0, back = 0, clearFocus = 0;
  const open = (path: string) => openKnowledgeMaintenancePath(app, path, true);
  const list = () => {
    cleanup(); host.empty();
    cleanup = renderKnowledgeMaintenanceHistoryList(host, {
      zh: true, entries, records, state, onChange: list, onBack: () => { back++; }, onOpenPath: open,
      onUnavailable: () => { unavailable++; }, onClearFocus: () => { clearFocus++; },
      onSelectRecord: value => { selected = value; detail(); }
    });
  };
  const detail = () => {
    cleanup(); host.empty();
    cleanup = renderKnowledgeMaintenanceRecordDetail(host, { zh: true, record: selected!, onOpenPath: open, onBack: list });
  };
  const click = (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); button.click(); };
  const rows = () => host.querySelectorAll(".echoink-maintenance-record-list > .setting-item");
  list(); await tick();
  assert.equal(rows().length, 20, "real Origin renderer limits a page to twenty");
  assert.equal(host.querySelector('[aria-current="page"]')?.textContent, "1");
  assert.ok(host.querySelector<HTMLButtonElement>('[aria-label="上一页"]')!.disabled);
  const filter = host.querySelector(".history-filter")!, scrolling = host.querySelector(".echoink-maintenance-record-list")!, footer = host.querySelector(".echoink-maintenance-pagination")!;
  assert.ok(!scrolling.contains(filter) && !scrolling.contains(footer), "filter and pagination remain outside the scrolling list");
  click('[aria-label="第 3 页"]'); await tick();
  assert.equal(rows().length, 4);
  assert.ok(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.disabled);
  const date = host.querySelector<HTMLInputElement>('input[type="date"]')!;
  date.value = "2026-10-17"; date.dispatchEvent(new Event("change")); await tick();
  assert.equal(state.page, 1, "date change resets page before rendering");
  assert.equal(rows().length, 20);
  assert.equal(host.querySelector(".history-count")!.textContent, "21 条记录", "filter applies to the complete history before slicing");
  click('[aria-label="第 2 页"]'); await tick();
  assert.equal(rows().length, 1);
  const listElement = host.querySelector<HTMLElement>(".echoink-maintenance-record-list")!;
  listElement.scrollTop = 87; listElement.dispatchEvent(new Event("scroll"));
  click('.echoink-maintenance-record-list button');
  for (const text of ["来源", "资料/来源-0.md", "知识成果", "原始成果标题", "知识判断", "原始判断", "原始证据", "问题与未完成项", "原始未完成原因"]) assert.ok(host.textContent!.includes(text), text);
  click('button.echoink-settings-back'); await tick();
  assert.deepEqual(state, { date: "2026-10-17", page: 2, listScroll: 87 }, "return keeps list date, page and scroll");
  assert.equal(host.querySelector<HTMLElement>(".echoink-maintenance-record-list")!.scrollTop, 87);
  click('.echoink-maintenance-record-list button');
  click('.echoink-settings-section button'); await tick();
  assert.deepEqual(opened, ["Wiki/成果-0.md"], "detail opens the original note");
  click('button.echoink-settings-back'); await tick();
  const emptyDate = host.querySelector<HTMLInputElement>('input[type="date"]')!;
  emptyDate.value = "2026-01-01"; emptyDate.dispatchEvent(new Event("change")); await tick();
  assert.ok(host.textContent!.includes("所选日期没有维护记录"));
  assert.equal(host.querySelector(".history-count")!.textContent, "0 条记录");
  assert.equal(host.querySelector(".echoink-maintenance-pagination"), null);
  click('[aria-label="清除日期筛选"]'); await tick();
  assert.equal(clearFocus, 1); assert.equal(state.page, 1); assert.equal(state.listScroll, 0);
  click('button.echoink-settings-back'); assert.equal(back, 1);

  cleanup(); host.empty();
  cleanup = renderKnowledgeMaintenanceHistoryList(host, { zh: true, entries: [legacy("reports/legacy.md"), { ...legacy("missing.md"), recordId: "absent" }], records: [], state,
    onBack() {}, onChange() {}, onSelectRecord() { assert.fail("old reports must not invent private detail"); }, onOpenPath: open, onUnavailable() { unavailable++; } });
  host.querySelectorAll<HTMLButtonElement>(".echoink-maintenance-record-list button")[0].click(); await tick();
  assert.equal(opened.at(-1), "reports/legacy.md");
  const noticeCount = openTestNoticeMessages.length;
  host.querySelectorAll<HTMLButtonElement>(".echoink-maintenance-record-list button")[1].click(); await tick();
  assert.equal(openTestNoticeMessages.length, noticeCount + 1);
  assert.match(openTestNoticeMessages.at(-1)!, /当前 Vault 中没有找到维护报告：missing.md/u, "missing report is an explicit failure, not an empty successful detail");
  assert.equal(unavailable, 0, "recordId with legacy reportPath falls back to the report");
  cleanup(); host.empty();
  cleanup = renderKnowledgeMaintenanceHistoryList(host, { zh: true, entries: [{ ...legacy(""), recordId: "absent" }], records: [], state,
    onBack() {}, onChange() {}, onSelectRecord() { assert.fail("missing record must not show details"); }, onOpenPath: open, onUnavailable() { unavailable++; } });
  click('.echoink-maintenance-record-list button'); assert.equal(unavailable, 1);
  for (const options of [{ loading: true, error: "" }, { loading: false, error: "维护记录暂时读不到" }, { loading: false, error: "" }]) {
    cleanup(); host.empty();
    cleanup = renderKnowledgeMaintenanceHistoryList(host, { zh: true, entries: [], records: [], state, ...options, onBack() {}, onChange() {}, onSelectRecord() {}, onOpenPath: open, onUnavailable() {} });
    assert.ok(host.textContent!.includes(options.loading ? "正在读取维护记录" : options.error || "还没有知识库维护记录"));
    if (options.error) assert.ok(!host.textContent!.includes("还没有知识库维护记录"), "read failure is not a successful empty history");
  }
  cleanup(); host.empty();
  cleanup = renderKnowledgeMaintenanceRecordDetail(host, { zh: false, record: records[0], onBack() {}, onOpenPath: open });
  assert.ok(host.textContent!.includes("Sources") && host.textContent!.includes("原始成果摘要"), "UI language never rewrites recorded content");
  cleanup(); host.remove();
  sibling.querySelector<HTMLButtonElement>("button")!.click(); assert.equal(siblingClicks, 1, "history disposer preserves unrelated Origin controls");
  disposeOriginControls(sibling); sibling.remove();
  console.log("Maintenance history: merge states, real Origin filter/20-page/navigation/scroll, legacy reports, missing failures and language passed.");
}

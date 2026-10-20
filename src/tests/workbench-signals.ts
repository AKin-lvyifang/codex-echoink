import assert from "node:assert/strict";
import { calculateWorkbenchSignals, latestFailedPdfRequests, nextWorkbenchRefreshAt, workbenchCalendarOrdinal, type WorkbenchFacts } from "../home/workbench-signals";
import { EMPTY_LIFESTYLE_DATA, type FinanceEntry, type LifestyleData } from "../lifestyle/store-core";
import { AGENT_MODULE_IDS } from "../agents/types";
import type { ParsedTodoRecord } from "../home/todo-markdown";
import type { PdfJob } from "../pdf-reading/types";

const financeData = (value: Partial<LifestyleData>): LifestyleData => ({ ...structuredClone(EMPTY_LIFESTYLE_DATA), ...value });
const todo = (dueDate: string): ParsedTodoRecord => ({ id: dueDate, dueDate, title: "合成待办", done: false, people: "", categoryName: "", lineStart: 1, lineEnd: 1, extraMetaLines: [] });
const entry = (amountCents: number, kind: FinanceEntry["kind"] = "expense"): FinanceEntry => ({ id: String(amountCents), source: "manual", sourceId: "", date: "2026-10-16", merchant: "合成商户", kind, amountCents, category: "餐饮", status: "completed", currency: "CNY", account: "合成账户", description: "", note: "" });
const pdf = (id: string, state: PdfJob["state"], createdAt: number, overrides: Partial<PdfJob> = {}): PdfJob => ({ version: 1, id, name: "synthetic.pdf", state, createdAt,
  sourceFingerprint: "source", options: { engine: "local", reading: true, translation: false, wiki: false }, rawDirectory: "raw", stage: "", artifacts: [], pages: [], chunks: [], warnings: [], published: {}, ...overrides });

export async function runWorkbenchSignalsTests(): Promise<void> {
  const now = new Date(2026, 9, 16, 18).getTime();
  const base = (): WorkbenchFacts => ({ now, modules: [...AGENT_MODULE_IDS], tasks: [], todos: [], journals: [], englishMissing: null, inbox: [], inboxScope: "inbox",
    raw: [], rawScope: "raw", pdfJobs: [], reviewComplete: true, isolated: null, knowledgeScope: "wiki" });
  const ids = (facts: WorkbenchFacts) => calculateWorkbenchSignals(facts).map(signal => signal.id);
  const facts = base();
  facts.todos = [todo("2026-10-16"), todo("2026-10-13"), todo("2026-10-12"), todo("2026-02-30"), todo("2026-10-17")];
  assert.deepEqual(ids(facts), [1, 2]);
  assert.match(calculateWorkbenchSignals(facts)[0].description, /3 项.*2 项/u);
  facts.todos = [todo("2026-10-13")]; assert.deepEqual(ids(facts), [1], "exactly 3 calendar days is not long overdue");
  facts.todos = [{ ...todo("2026-10-12"), done: true }]; assert.deepEqual(ids(facts), []);
  assert.equal(workbenchCalendarOrdinal("2026-03-09")! - workbenchCalendarOrdinal("2026-03-05")!, 4, "DST does not alter calendar days");
  facts.finance = { data: financeData({ budgets: [{ month: "2026-10", totalCents: 10000, allocations: { 餐饮: 10000 } }] }), entries: [entry(7999)] };
  assert.deepEqual(ids(facts), [], "unrounded 79.99 percent must not trigger");
  facts.finance.entries = [entry(8000)]; assert.deepEqual(ids(facts), [3]);
  facts.finance.entries = [entry(9000), entry(1001, "refund"), entry(100000, "income"), { ...entry(100000), date: "2026-10-17" }];
  assert.deepEqual(ids(facts), [], "refunds, future trades, income and transfers obey the real net-expense rules");
  facts.finance.data = financeData({ financeDefaultBudget: { totalCents: 10000, allocations: { 餐饮: 5000 } }, budgets: [{ month: "2026-10", totalCents: 20000, allocations: { 餐饮: 15000 } }] });
  facts.finance.entries = [entry(8000)]; assert.deepEqual(ids(facts), [], "month override wins over defaults");
  facts.finance.data = financeData({ financeDefaultBudget: { totalCents: 10000, allocations: { 餐饮: 0 } } }); assert.deepEqual(ids(facts), []);
  facts.finance = undefined;
  const empty = { state: "empty" as const, path: "journal/today.md", text: "" };
  facts.journals = [empty]; assert.deepEqual(ids(facts), [4]);
  facts.now = new Date(2026, 9, 16, 17, 59, 59).getTime(); assert.deepEqual(ids(facts), []);
  facts.now = now; facts.journals = [empty, empty, empty]; assert.deepEqual(ids(facts), [10], "#10 suppresses #4");
  facts.journals = [empty, { ...empty, state: "unknown" }, empty]; assert.deepEqual(ids(facts), [4], "unknown prevents a three-day claim");
  facts.journals = [{ ...empty, state: "body", text: "今天写了正文" }]; facts.englishMissing = true; assert.deepEqual(ids(facts), [5]);
  facts.englishMissing = false; assert.deepEqual(ids(facts), []);
  facts.englishMissing = true; facts.journals = [{ ...empty, state: "body", text: "English only" }]; assert.deepEqual(ids(facts), []);
  facts.journals = [];
  facts.inbox = [{ path: "inbox/a.md", fingerprint: "a", enteredAt: now - 72 * 3600000 }]; assert.deepEqual(ids(facts), []);
  assert.equal(nextWorkbenchRefreshAt(facts), now + 1);
  facts.now++; assert.deepEqual(ids(facts), [6]); facts.now = now;
  facts.inbox = [1, 2, 3].map(index => ({ path: `inbox/${index}.md`, fingerprint: String(index), enteredAt: now })); assert.deepEqual(ids(facts), [6]);
  facts.inbox = []; facts.raw = [1, 2, 3].map(index => ({ path: `raw/${index}.md`, fingerprint: String(index) })); assert.deepEqual(ids(facts), [7]);
  facts.raw = facts.raw.slice(1); assert.deepEqual(ids(facts), []); facts.raw = [];
  facts.pdfJobs = [pdf("failed", "failed", 1)]; assert.deepEqual(ids(facts), [8]);
  facts.pdfJobs.push(pdf("success", "completed", 2)); assert.deepEqual(ids(facts), []);
  facts.pdfJobs.push(pdf("translation", "partial", 3, { options: { engine: "local", reading: true, translation: true, translationLanguage: "中文", wiki: false } }));
  assert.deepEqual(latestFailedPdfRequests(facts.pdfJobs).map(job => job.id), ["translation"]);
  facts.pdfJobs.push(pdf("running", "running", 4), pdf("cancelled", "cancelled", 5)); assert.deepEqual(ids(facts), [8]);
  facts.pdfJobs = [pdf("unknown-a", "failed", 1, { sourceFingerprint: undefined }), pdf("unknown-b", "completed", 2, { sourceFingerprint: undefined })];
  assert.deepEqual(ids(facts), [8], "unknown sources do not merge by their filename"); facts.pdfJobs = [];
  facts.reviewComplete = false; assert.deepEqual(ids(facts), [9]);
  facts.now = new Date(2026, 9, 17, 12).getTime(); assert.deepEqual(ids(facts), [9]);
  facts.now = new Date(2026, 9, 19, 12).getTime(); assert.deepEqual(ids(facts), []);
  facts.now = now; facts.reviewComplete = null; assert.deepEqual(ids(facts), []); facts.reviewComplete = true;
  facts.finance = { data: financeData({}), entries: [{ ...entry(1000), category: "其他" }] }; assert.deepEqual(ids(facts), []);
  facts.finance.entries = [{ ...entry(1000), classificationPending: true }]; assert.deepEqual(ids(facts), [11]);
  facts.finance.entries = [{ ...entry(1000), classificationPending: true, date: "2026-09-30" }]; assert.deepEqual(ids(facts), []);
  facts.finance.data = financeData({ lastSuccessfulImportAt: now - 720 * 3600000 }); assert.deepEqual(ids(facts), []);
  facts.now++; assert.deepEqual(ids(facts), [13]); facts.now = now;
  facts.finance.data = financeData({ lastSuccessfulImportAt: now + 1 }); assert.deepEqual(ids(facts), []); facts.finance = undefined;
  facts.isolated = ["1", "2", "3", "4", "5"]; assert.deepEqual(ids(facts), [14]);
  const signal = calculateWorkbenchSignals(facts)[0];
  facts.tasks = [{ taskStatus: "running", businessKey: signal.key }]; assert.deepEqual(ids(facts), []);
  facts.tasks = [{ taskStatus: "waiting", businessKey: signal.key }]; assert.deepEqual(ids(facts), []);
  for (const taskStatus of ["interrupted", "completed", "failed", undefined]) { facts.tasks = [{ taskStatus, businessKey: signal.key }]; assert.deepEqual(ids(facts), [14]); }
  facts.tasks = []; facts.modules = []; assert.deepEqual(ids(facts), [], "eligibility is applied before signals and counts");
  console.log("Workbench signal rules: 13 signals, transitions, strict thresholds, local dates, PRO/module eligibility and task suppression passed");
}

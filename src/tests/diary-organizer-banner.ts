import assert from "node:assert/strict";
import { TestDocument } from "./lifestyle-finance-ui";
import { renderDiaryOrganizerBanner } from "../home/diary-organizer-banner";
import type CodexForObsidianPlugin from "../main";
import type { DiaryActionOptions, DiaryFinanceCandidate, DiaryItem } from "../diary-organizer/types";
import { DIARY_HOME_RECENT_MS } from "../home/diary-organizer-summary";
import { diaryReviewFinanceAmount, diaryReviewFinanceTitle, diaryReviewReason } from "../home/diary-review-presentation";

export async function runDiaryOrganizerBannerTests(): Promise<void> {
  const previous = globalThis.document;
  const document = new TestDocument(); globalThis.document = document as unknown as Document;
  try {
    const now = Date.now();
    const item: DiaryItem = { id: "recent", documentId: "journal", candidate: { type: "todo", quote: "真实待办", text: "真实待办", confidence: "high", occurred: true, ownership: "self" },
      status: "written", reasons: [], revision: 1, createdAt: now, updatedAt: now, writtenAt: now, sourceFingerprint: "test" };
    let items = [item];
    let confirmed: { id: string; options: DiaryActionOptions } | undefined, ignored = "", opened = "";
    const plugin = { settings: { diaryOrganizerEnabled: true, diaryOrganizerPromptDismissed: true, settingsLanguage: "zh-CN", lifestyle: { finance: { categories: [] } } },
      app: { workspace: { openLinkText: async (path: string) => { opened = path; } } },
      diaryOrganizer: { hasJournals: true, engine: { getState: () => ({ items, documents: [{ id: "journal", path: "journal/2026-10-29.md" }] }),
        confirm: async (id: string, options: DiaryActionOptions) => { confirmed = { id, options: structuredClone(options) }; return { status: "blocked", reason: "fixture keeps the draft" }; },
        ignore: async (id: string) => { ignored = id; return { status: "blocked", reason: "fixture keeps the item" }; }
      } } } as unknown as CodexForObsidianPlugin;
    const host = document.createElement("div"); document.body.appendChild(host);
    renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    const toggle = host.querySelector("button")!, list = host.querySelector(".diary-organizer-list")!;
    assert.equal(host.querySelector("details"), null, "workbench uses an explicit disclosure button, no native marker");
    assert.ok(host.querySelector(".wb-section-heading")); assert.ok(host.querySelector(".wb-rows")); assert.ok(host.querySelector(".wb-row"));
    assert.equal(toggle.getAttribute("aria-expanded"), "false"); assert.equal(list.hidden, true);
    toggle.onclick!(); assert.equal(toggle.getAttribute("aria-expanded"), "true"); assert.equal(list.hidden, false);
    assert.equal(toggle.getAttribute("aria-controls"), list.getAttribute("id"));
    items = [{ ...item, revision: 2 }]; renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    assert.equal(host.querySelector("button")!.getAttribute("aria-expanded"), "true", "a data refresh preserves the expansion state");
    host.querySelector("button")!.onclick!(); assert.equal(host.querySelector(".diary-organizer-list")!.hidden, true);
    items = [{ ...item, writtenAt: now - DIARY_HOME_RECENT_MS - 1000 }]; renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    assert.equal(host.children.length, 0, "no recent writes and no reviews means no banner");
    items = [{ ...item, status: "review", writtenAt: now - DIARY_HOME_RECENT_MS - 1000 }]; renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    assert.ok(host.textContent.includes("1 条待你看一眼")); assert.ok(!host.textContent.includes("近7天"), "old reviews remain visible without a zero write label");

    const reasons = ["上下文提到他人付款或请客，请核对这笔是否由你支付", "上下文含购买计划，请核对这笔是否已经发生", "金额与原文不一致", "转账、退款或分摊需核对", "分类未对应到已启用分类", "交易对象不明确"];
    const expected = ["可能是别人付的，确认一下", "可能还没发生，确认一下", "金额、币种或垫付关系还不清楚", "转账、退款或分摊，确认一下", "分类还没对上，选一下", "交易对象还不清楚，改一下"];
    for (let index = 0; index < reasons.length; index++) {
      const remaining = reasons.slice(index).reverse();
      assert.equal(diaryReviewReason(remaining, true), expected[index], "priority is independent of stored order");
      assert.deepEqual(remaining, reasons.slice(index).reverse(), "presentation does not rewrite reasons");
    }
    assert.equal(diaryReviewReason(["未知模型原因一；未知模型原因二"], true), "这条还需要你确认");
    assert.equal(diaryReviewReason([reasons[0]], false), "Someone else may have paid. Please check.");
    const finance: DiaryFinanceCandidate = { type: "finance", merchant: "", description: "停车费", quote: "朋友请客，我付了停车费 20 元。", kind: "expense", amountCents: 2000, currency: "CNY", date: "2026-10-29", category: "交通", ownership: "self", occurred: true, confidence: "high" };
    assert.equal(diaryReviewFinanceTitle(finance), "停车费");
    assert.equal(diaryReviewFinanceTitle({ ...finance, description: undefined }), "停车费");
    assert.equal(diaryReviewFinanceTitle({ ...finance, merchant: "停车场" }), "停车场");
    assert.equal(diaryReviewFinanceTitle({ ...finance, description: "与对方吃饭，本人付款120元", quote: "我和她吃饭，我付了120元。" }), "与对方吃饭");
    assert.equal(diaryReviewFinanceTitle({ ...finance, description: "", quote: "我付了20元。" }), "");
    assert.equal(diaryReviewFinanceAmount(finance), "¥20.00");
    assert.equal(diaryReviewFinanceAmount({ ...finance, amountCents: 123456, currency: "USD" }), "USD 1,234.56");

    items = [{ ...item, id: "parking", status: "review", reasons, candidate: finance, revision: 4 }];
    const original = JSON.stringify(items);
    renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    host.querySelector("button")!.onclick!();
    let row = host.querySelector(".diary-organizer-review")!;
    assert.equal(row.querySelector(".diary-organizer-title")!.textContent, "停车费");
    assert.equal(row.querySelector(".diary-organizer-amount")!.textContent, "¥20.00");
    assert.equal(row.querySelector(".diary-organizer-reason")!.textContent, expected[0]);
    assert.equal(row.querySelectorAll(".diary-organizer-reason").length, 1);
    assert.ok(!row.textContent.includes("AI 从日记记的") && !row.textContent.includes("CNY"));
    assert.equal(row.querySelectorAll("input").length, 0, "edit fields are not mounted by default");
    const quote = row.querySelector(".diary-organizer-quote")!;
    assert.equal(quote.textContent, finance.quote); quote.click(); assert.equal(opened, "journal/2026-10-29.md");
    let edit = row.querySelectorAll("button").find(button => button.textContent === "改一下")!;
    assert.equal(edit.getAttribute("aria-expanded"), "false"); edit.click();
    assert.equal(edit.getAttribute("aria-expanded"), "true");
    assert.equal(row.querySelectorAll("input").length, 4); assert.equal(row.querySelectorAll("select").length, 2);
    assert.equal(row.querySelector(".diary-organizer-editor")!.hidden, false);
    const amount = row.querySelectorAll("input").find(input => input.getAttribute("aria-label") === "金额")!;
    amount.value = "21.50"; amount.dispatchEvent({ type: "input" }); edit.click(); edit.click();
    assert.equal(amount.value, "21.50", "collapse retains the edited draft");
    items = [...items, { ...item, id: "another" }]; renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    row = host.querySelector(".diary-organizer-review")!;
    assert.equal(row.querySelector(".diary-organizer-editor")!.hidden, false, "unrelated refresh preserves editing");
    assert.equal(row.querySelectorAll("input").find(input => input.getAttribute("aria-label") === "金额")!.value, "21.50");
    row.querySelectorAll("button").find(button => button.textContent === "确认")!.click(); await Promise.resolve();
    assert.deepEqual(confirmed, { id: "parking", options: { expectedRevision: 4, candidate: { ...finance, amountCents: 2150 } } });
    assert.equal(JSON.stringify(items.slice(0, 1)), original, "editing and rendering never mutate organizer data");
    row.querySelectorAll("button").find(button => button.textContent === "忽略")!.click(); await Promise.resolve();
    assert.equal(ignored, "parking");
    items = [{ ...items[0], revision: 5 }]; renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    assert.equal(host.querySelector(".diary-organizer-editor")!.hidden, true, "a new revision uses a fresh draft");
    items = [{ ...item, id: "todo-review", status: "review" }]; renderDiaryOrganizerBanner(host as unknown as HTMLElement, plugin);
    row = host.querySelector(".diary-organizer-review")!;
    row.querySelectorAll("button").find(button => button.textContent === "改一下")!.click();
    assert.deepEqual(row.querySelectorAll("input").map(input => input.getAttribute("aria-label")), ["待办", "截止日期"]);
    console.log("Diary home UI: PASS (14 existing disclosure assertions + reason priority, title/amount, compact defaults, source link, lazy finance/todo editors, retained drafts, confirm/ignore forwarding and immutable data)");
  } finally { globalThis.document = previous; }
}

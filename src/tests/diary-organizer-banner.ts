import assert from "node:assert/strict";
import { TestDocument } from "./lifestyle-finance-ui";
import { renderDiaryOrganizerBanner } from "../home/diary-organizer-banner";
import type CodexForObsidianPlugin from "../main";
import type { DiaryItem } from "../diary-organizer/types";
import { DIARY_HOME_RECENT_MS } from "../home/diary-organizer-summary";

export function runDiaryOrganizerBannerTests(): void {
  const previous = globalThis.document;
  const document = new TestDocument(); globalThis.document = document as unknown as Document;
  try {
    const now = Date.now();
    const item: DiaryItem = { id: "recent", documentId: "journal", candidate: { type: "todo", quote: "真实待办", text: "真实待办", confidence: "high", occurred: true, ownership: "self" },
      status: "written", reasons: [], revision: 1, createdAt: now, updatedAt: now, writtenAt: now, sourceFingerprint: "test" };
    let items = [item];
    const plugin = { settings: { diaryOrganizerEnabled: true, diaryOrganizerPromptDismissed: true, settingsLanguage: "zh-CN" },
      diaryOrganizer: { hasJournals: true, engine: { getState: () => ({ items, documents: [] }) } } } as unknown as CodexForObsidianPlugin;
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
    console.log("Diary home UI: PASS (14 disclosure, refresh, hidden-state and workbench structure assertions)");
  } finally { globalThis.document = previous; }
}

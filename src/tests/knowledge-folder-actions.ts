import assert from "node:assert/strict";
import { Platform } from "obsidian";
import type { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { renderKnowledgeFolderActions } from "../settings/knowledge-folder-actions";
import { createSettingsNavigationRow } from "../settings/settings-v2";
import { disposeOriginControls } from "../settings/origin-controls";
import { displayedTooltipsForTests, openTestModals, openTestNoticeMessages } from "./obsidian-shim";

/** Run under the folder-settings DOM so this suite is included in its existing entry. */
export async function runKnowledgeFolderActionsTests(host: HTMLElement, win: { Event: typeof Event }): Promise<void> {
  const previousDesktop = Platform.isDesktopApp;
  const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
  const button = (text: string, root: ParentNode = host) => {
    const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === text || el.querySelector(".echoink-settings-navigation-title")?.textContent === text);
    assert(result, `Expected action: ${text}`); return result;
  };
  let record: { createdAt: number; files: number } | null = { createdAt: 1_700_000_000_000, files: 4 };
  let restoreCalls = 0;
  let renameCalls = 0;
  let previewCalls = 0;
  let refreshCalls = 0;
  let recordFails = false;
  let restoreFailure = "";
  let settleRestore: (() => void) | undefined;
  const service = {
    app: {}, directoryWritable: true, folderOperationBusy: false,
    folderNameScopes: () => ["阅读/资料", "知识/卡片"],
    async getOriginalDirectoryStatus() { if (recordFails) throw new Error("record unavailable"); return record; },
    async restoreOriginalDirectories() { restoreCalls++; if (restoreFailure) throw new Error(restoreFailure); await new Promise<void>(resolve => { settleRestore = resolve; }); return { restored: 4, skipped: [] }; },
    async previewFolderNames(scopes: string[]) { previewCalls++; assert.deepEqual(scopes, ["阅读/资料"]); return { result: { renamed: [{ from: "阅读/资料/old", to: "阅读/资料/new" }], skipped: [] } }; },
    async applyFolderNamePreview() { renameCalls++; return { renamed: [{ from: "阅读/资料/old", to: "阅读/资料/new" }], skipped: [] }; }
  } as unknown as EchoInkKnowledgeSurfaceService;
  const draw = () => {
    disposeOriginControls(host); host.empty();
    renderKnowledgeFolderActions(host, service, "zh-CN", async () => { refreshCalls++; }, group => {
      createSettingsNavigationRow(group, { title: "目录方案", description: "来源 1 个 · 成果 1 个 · 收件箱未启用", onActivate() {} });
    });
  };
  try {
    Platform.isDesktopApp = true;
    draw();
    assert(button("复原仓库").querySelector(".echoink-settings-navigation-description")?.textContent?.includes("正在读取复原记录"));
    assert.equal(button("复原仓库").querySelector(".echoink-settings-navigation-value"), null, "loading text remains a complete description");
    await flush();
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".echoink-settings-navigation-row")];
    assert.deepEqual(rows.map(row => row.querySelector(".echoink-settings-navigation-title")?.textContent), ["文件夹名称优化", "复原仓库", "目录方案"]);
    assert.equal(new Set(rows.map(row => row.parentElement)).size, 1, "all directory entries share a single peer group");
    assert.equal(host.querySelectorAll(".echoink-knowledge-folder-actions button").length, 3, "navigation does not repeat action buttons");
    assert.equal(button("文件夹名称优化").querySelector(".echoink-settings-navigation-description")?.textContent, "改成「中文（english）」的可读名称");
    assert.equal(button("文件夹名称优化").querySelector(".echoink-settings-navigation-value")?.textContent, "2 个目录可优化");
    assert(button("复原仓库").querySelector(".echoink-settings-navigation-value")?.textContent?.includes("4 个文件"));
    assert.equal(button("复原仓库").querySelector(".echoink-settings-navigation-description"), null, "normal restore record is a trailing value");
    button("复原仓库").click();
    let modal = openTestModals.at(-1)!;
    assert(modal.modalEl.classList.contains("echoink-settings-modal") && modal.modalEl.classList.contains("echoink-theme-boundary"));
    assert.equal(restoreCalls, 0, "navigation only opens the original-layout record");
    assert(modal.contentEl.textContent?.includes("4 个文件"));
    button("复原目录", modal.contentEl).click();
    assert.equal(restoreCalls, 0, "requesting confirmation still does not move files");
    button("取消", modal.contentEl).click();
    assert.equal(restoreCalls, 0);
    button("复原目录", modal.contentEl).click();
    const confirm = button("确认复原", modal.contentEl);
    confirm.click(); confirm.click(); await flush();
    assert.equal(restoreCalls, 1, "confirmation cannot submit restoration twice");
    draw(); await flush();
    assert.equal(button("复原仓库").disabled, true, "rerender keeps the shared running state");
    assert.equal(button("复原仓库").querySelector(".echoink-settings-navigation-description")?.textContent, "正在复原目录…");
    assert.equal(button("复原仓库").querySelector(".echoink-settings-navigation-value"), null);
    settleRestore!(); await flush();
    assert.equal(refreshCalls, 1);
    assert(openTestNoticeMessages.at(-1)?.includes("已恢复 4 个文件"));
    draw(); await flush();
    button("文件夹名称优化").click();
    modal = openTestModals.at(-1)!;
    assert(modal.modalEl.classList.contains("echoink-settings-modal"));
    assert.equal(renameCalls, 0);
    const check = modal.contentEl.querySelector<HTMLInputElement>('[aria-label="阅读/资料"]')!;
    check.checked = true; check.dispatchEvent(new win.Event("change", { bubbles: true }));
    button("预览改名", modal.contentEl).click(); await flush();
    assert.equal(previewCalls, 1); assert.equal(renameCalls, 0, "preview performs no rename");
    button("应用改名", modal.contentEl).click(); await flush();
    assert.equal(renameCalls, 1); assert.equal(refreshCalls, 2);
    record = null; draw(); await flush();
    assert(button("复原仓库").textContent?.includes("暂无可复原记录"));
    button("复原仓库").click();
    modal = openTestModals.at(-1)!;
    assert(modal.contentEl.textContent?.includes("暂无可复原记录"));
    assert(!modal.contentEl.textContent?.includes("复原目录"));
    assert.equal(restoreCalls, 1, "a missing record never exposes an executable restore");
    record = { createdAt: 1_800_000_000_000, files: 9 }; draw(); await flush();
    const updated = button("复原仓库"), updatedValue = updated.querySelector<HTMLElement>(".echoink-settings-navigation-value")!;
    const accessibleValue = updated.getAttribute("aria-labelledby")?.split(/\s+/u).map(id => updated.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") ?? updated.getAttribute("aria-label");
    assert(accessibleValue?.includes("9 个文件"), "asynchronous metadata refreshes the accessible value");
    Object.defineProperties(updatedValue, { scrollWidth: { configurable: true, value: 400 }, clientWidth: { configurable: true, value: 100 } });
    updated.focus();
    assert.equal(displayedTooltipsForTests.get(updated), updatedValue.textContent, "the native tooltip uses the latest restore record");
    updated.blur();
    recordFails = true; draw(); await flush();
    assert(button("复原仓库").querySelector(".echoink-settings-navigation-description")?.textContent?.includes("复原记录读取失败"));
    assert.equal(button("复原仓库").querySelector(".echoink-settings-navigation-value"), null, "read failures never enter the ellipsis field");
    recordFails = false; restoreFailure = "需要完整展示的复原失败原因".repeat(20); draw(); await flush();
    button("复原仓库").click(); modal = openTestModals.at(-1)!;
    button("复原目录", modal.contentEl).click(); button("确认复原", modal.contentEl).click(); await flush();
    draw(); await flush();
    assert(button("复原仓库").querySelector(".echoink-settings-navigation-description")?.textContent?.includes(restoreFailure), "operation failure stays complete across rerender");
    assert(openTestNoticeMessages.at(-1)?.includes(restoreFailure), "the result notice does not shorten an error");
  } finally {
    Platform.isDesktopApp = previousDesktop;
    for (const modal of [...openTestModals]) modal.close();
    disposeOriginControls(host); host.empty();
  }
  console.log("Knowledge folder actions: PASS (navigation, preview, confirmation, and operation state)");
}

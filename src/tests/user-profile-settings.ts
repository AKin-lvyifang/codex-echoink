import assert from "node:assert/strict";
import { App, openTestModals, Platform } from "./obsidian-shim";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";
import { MemoryCorrectionModal } from "../ui/modals";

export async function runUserProfileSettingsTests(_root: string): Promise<void> {
  installProviderBrowserHost();
  const priorDesktop = Platform.isDesktopApp;
  Platform.isDesktopApp = false;
  try {
    const legacy = new MemoryCorrectionModal(new App() as never, { memoryType: "事实", title: "旧", content: "旧", recallWhen: "旧" }, "zh-CN", { generate: async () => { throw new Error("unused"); }, save: async () => {} }, () => {});
    legacy.open(); assert.equal(openTestModals.length, 1);
    assert(legacy.contentEl.querySelector("h2"));
    assert(legacy.contentEl.querySelector(".echoink-memory-correction-intro"));
    assert(legacy.contentEl.querySelector(".echoink-memory-correction-current"), "legacy mobile Modal keeps the original memory");
    legacy.close(); assert.equal(openTestModals.length, 0, "legacy mobile Modal path is preserved");
  } finally { Platform.isDesktopApp = priorDesktop; }
  console.log("Legacy mobile memory correction Modal: PASS");
}

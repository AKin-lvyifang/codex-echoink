import { Notice } from "obsidian";
import type { CognitiveSystem } from "../harness/memory/cognitive-system";
import type { DreamRunResult } from "../harness/memory/dream-engine";
import { createOriginButton } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow } from "./settings-v2";

export interface ManualDreamActionHost {
  readonly settings: { readonly memory: { readonly useLongTermMemory: boolean; readonly dreamEnabled: boolean } };
  getCognitiveSystem(): Promise<Pick<CognitiveSystem, "forceDreamRun">>;
}

// The plugin remains the same host when settings are redrawn or reopened.
const runningHosts = new WeakSet<ManualDreamActionHost>();

export function manualDreamResultMessage(result: DreamRunResult | null, language: string): string {
  const zh = language !== "en";
  if (!result) return zh ? "当前有任务正在运行，请稍后再试。" : "Another task is running. Try again shortly.";
  if (result.providerUnavailable) return zh
    ? "请先配置可用模型，再整理记忆。"
    : "Configure an available model before consolidating memory.";
  if (result.failedMemoryIds.length) return result.committed
    ? (zh ? `已整理 ${result.processedMemoryIds.length} 条记忆，${result.failedMemoryIds.length} 条未完成。`
      : `Consolidated ${result.processedMemoryIds.length} memories; ${result.failedMemoryIds.length} need another attempt.`)
    : (zh ? `记忆整理未完成，${result.failedMemoryIds.length} 条记忆待重试。`
      : `Memory consolidation did not complete; ${result.failedMemoryIds.length} memories need another attempt.`);
  if (result.error) return result.committed
    ? (zh ? "记忆整理部分完成，请稍后重试未完成内容。" : "Memory consolidation partially completed. Retry the remaining work shortly.")
    : (zh ? "记忆整理未完成，请稍后重试。" : "Memory consolidation did not complete. Try again shortly.");
  if (!result.committed) return zh ? "暂无待整理的记忆。" : "No memories need consolidation.";
  return result.processedMemoryIds.length
    ? (zh ? `记忆整理完成，已处理 ${result.processedMemoryIds.length} 条记忆。`
      : `Memory consolidation complete; ${result.processedMemoryIds.length} memories processed.`)
    : (zh ? "记忆整理完成。" : "Memory consolidation complete.");
}

export function renderManualDreamAction(
  container: HTMLElement,
  host: ManualDreamActionHost,
  language: string,
  refresh: () => void
): void {
  const enabled = () => host.settings.memory.useLongTermMemory && host.settings.memory.dreamEnabled;
  if (!enabled()) return;
  const zh = language !== "en";
  const row = applySettingsRow(new OriginSetting(container)
    .setName(zh ? "立即做梦" : "Dream now"));
  const button = createOriginButton(row.controlEl, {
    text: zh ? "立即做梦" : "Dream now",
    attr: { "data-echoink-focus-key": "general:memory:dream-now" }
  });
  const syncButton = () => {
    const running = runningHosts.has(host);
    button.disabled = running;
    button.setAttr("aria-busy", String(running));
    button.setText(running ? (zh ? "整理中…" : "Consolidating…") : (zh ? "立即做梦" : "Dream now"));
  };
  syncButton();
  button.onclick = () => {
    if (runningHosts.has(host) || !enabled()) return;
    runningHosts.add(host);
    syncButton();
    void (async () => {
      try {
        const system = await host.getCognitiveSystem();
        if (!enabled()) return;
        const result = await system.forceDreamRun();
        new Notice(manualDreamResultMessage(result, language));
      } catch (error) {
        new Notice(error instanceof Error && error.message === "developer_memory_changing"
          ? manualDreamResultMessage(null, language)
          : (zh ? "记忆整理未完成，请稍后重试。" : "Memory consolidation did not complete. Try again shortly."));
      } finally {
        runningHosts.delete(host);
        syncButton();
        refresh();
      }
    })();
  };
}

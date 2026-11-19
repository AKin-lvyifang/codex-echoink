import type { SettingsLanguage } from "../../settings/settings";
import { conversationUiText } from "./ui-i18n";
import { errorText, NEXT } from "../../core/error-copy";

export interface McpPanelResourceState {
  total: number;
  enabled: number;
}

export async function loadMcpPanelView(input: {
  readonly container: HTMLElement;
  readonly loadResources: () => Readonly<McpPanelResourceState>;
  readonly language?: SettingsLanguage;
}): Promise<void> {
  const render = (error: string | null, resources: Readonly<McpPanelResourceState>) => {
    renderMcpPanelView(input.container, error, resources, {
      onRetry: () => { void loadMcpPanelView(input); }
    }, input.language);
  };
  try {
    render(null, input.loadResources());
  } catch (error) {
    render(
      errorText(error, NEXT.retry, input.language),
      { total: 0, enabled: 0 }
    );
  }
}

export function renderMcpPanelView(
  container: HTMLElement,
  error: string | null,
  resources: Readonly<McpPanelResourceState>,
  callbacks: { onRetry: () => void },
  language: SettingsLanguage = "zh-CN"
): void {
  container.empty();
  const titleId = "echoink-mcp-panel-title";
  container.setAttribute("role", "region");
  container.setAttribute("aria-labelledby", titleId);
  container.createDiv({
    cls: "codex-mcp-title",
    text: conversationUiText(language, "MCP 状态", "MCP status"),
    attr: { id: titleId }
  });
  if (error) {
    container.createDiv({
      cls: "codex-mcp-error",
      text: conversationUiText(language, `读取失败：${error}`, `Could not load: ${error}`),
      attr: { role: "alert" }
    });
    const retry = container.createEl("button", {
      cls: "codex-mcp-retry",
      text: conversationUiText(language, "重新读取 MCP", "Reload MCP"),
      attr: {
        type: "button",
        "aria-label": conversationUiText(language, "重新读取 MCP", "Reload MCP")
      }
    });
    retry.onclick = callbacks.onRetry;
    return;
  }
  if (resources.total > 0) {
    container.createDiv({
      cls: "codex-mcp-empty",
      text: resources.enabled > 0
        ? conversationUiText(
          language,
          `当前已启用 ${resources.enabled} / ${resources.total} 个 MCP 资源；下一轮对话仍按 Server 与 Tool 信任策略加载。`,
          `${resources.enabled} of ${resources.total} MCP resources are enabled. The next conversation still follows Server and Tool trust policies.`
        )
        : conversationUiText(
          language,
          `当前 ${resources.total} 个 MCP 资源均已关闭；下一轮对话不加载 MCP。`,
          `All ${resources.total} MCP resources are off. The next conversation will not load MCP.`
        ),
      attr: { role: "status", "aria-live": "polite" }
    });
  }
  if (resources.total === 0) {
    container.createDiv({
      cls: "codex-mcp-empty",
      text: conversationUiText(language, "当前没有 MCP 资源。", "There are no MCP resources."),
      attr: { role: "status", "aria-live": "polite" }
    });
  }
}

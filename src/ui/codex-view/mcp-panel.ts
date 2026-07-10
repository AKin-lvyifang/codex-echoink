import { Notice } from "obsidian";
import type { McpServerStatus } from "../../types/app-server";

export function renderMcpPanelView(
  container: HTMLElement,
  servers: McpServerStatus[],
  error: string | null,
  mcpEnabled: boolean,
  callbacks: { onRetry: () => void; onLogin: (serverName: string) => Promise<string | null | undefined> }
): void {
  container.empty();
  container.createDiv({ cls: "codex-mcp-title", text: "MCP 状态" });
  if (error) {
    container.createDiv({ cls: "codex-mcp-error", text: `读取失败：${error}` });
    const retry = container.createEl("button", { cls: "codex-mcp-retry", text: "重新读取 MCP", attr: { type: "button" } });
    retry.onclick = callbacks.onRetry;
  }
  if (!mcpEnabled && servers.length) {
    container.createDiv({ cls: "codex-mcp-empty", text: "已读取到 MCP 服务。聊天 MCP 总开关关闭，下一轮对话暂不调用 MCP。" });
  }
  if (!servers.length) {
    if (!error) container.createDiv({ cls: "codex-mcp-empty", text: "没有读取到 MCP 服务器。" });
    return;
  }
  for (const server of servers) renderMcpServer(container, server, callbacks);
}

function renderMcpServer(container: HTMLElement, server: McpServerStatus, callbacks: { onLogin: (serverName: string) => Promise<string | null | undefined> }): void {
  const row = container.createDiv({ cls: "codex-mcp-row" });
  row.createDiv({ cls: "codex-mcp-name", text: server.name });
  row.createDiv({ cls: "codex-mcp-meta", text: `${Object.keys(server.tools ?? {}).length} 个工具 · ${server.authStatus ?? "unknown"}` });
  if (server.authStatus !== "notLoggedIn") return;
  const login = row.createEl("button", { cls: "codex-toolbar-button", text: "登录", attr: { type: "button" } });
  login.onclick = async () => {
    try {
      const url = await callbacks.onLogin(server.name);
      if (url) window.open(url);
      else new Notice("没有拿到 MCP 登录链接");
    } catch (error) {
      new Notice(`MCP 登录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

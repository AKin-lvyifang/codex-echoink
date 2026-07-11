import type { CodexServerRequest } from "../types/app-server";

export interface CodexServerRequestRouterActions {
  confirm(title: string, body: string, acceptText?: string, declineText?: string): Promise<boolean>;
  requestUserInput(questions: unknown[]): Promise<Record<string, { answers: string[] }>>;
  openUrl(url: string): void;
}

type ServerRequestHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class CodexServerRequestRouter {
  private readonly handlers: Record<string, ServerRequestHandler>;

  constructor(private readonly actions: CodexServerRequestRouterActions) {
    this.handlers = {
      "item/commandExecution/requestApproval": (params) => this.handleCommandExecutionApproval(params),
      "item/fileChange/requestApproval": (params) => this.handleFileChangeApproval(params),
      "item/permissions/requestApproval": (params) => this.handlePermissionApproval(params),
      "item/tool/requestUserInput": (params) => this.handleRequestUserInput(params),
      "mcpServer/elicitation/request": (params) => this.handleMcpElicitation(params)
    };
  }

  async handle(request: CodexServerRequest): Promise<unknown> {
    const handler = this.handlers[request.method];
    if (!handler) return {};
    return handler(asRecord(request.params) ?? {});
  }

  private async handleCommandExecutionApproval(params: Record<string, unknown>): Promise<{ decision: "accept" | "decline" }> {
    const command = stringParam(params.command) || "未知命令";
    const accepted = await this.actions.confirm("Codex 请求执行命令", `${command}\n\n${stringParam(params.reason)}`);
    return { decision: accepted ? "accept" : "decline" };
  }

  private async handleFileChangeApproval(params: Record<string, unknown>): Promise<{ decision: "accept" | "decline" }> {
    const accepted = await this.actions.confirm("Codex 请求修改文件", stringParam(params.reason) || "是否允许本次文件修改？");
    return { decision: accepted ? "accept" : "decline" };
  }

  private async handlePermissionApproval(params: Record<string, unknown>): Promise<{ permissions: Record<string, unknown>; scope: "turn" }> {
    const accepted = await this.actions.confirm("Codex 请求额外权限", stringParam(params.reason) || "是否允许本次额外权限？");
    return accepted
      ? {
          permissions: asRecord(params.permissions) ?? {},
          scope: "turn"
        }
      : { permissions: {}, scope: "turn" };
  }

  private async handleRequestUserInput(params: Record<string, unknown>): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const answers = await this.actions.requestUserInput(Array.isArray(params.questions) ? params.questions : []);
    return { answers };
  }

  private async handleMcpElicitation(params: Record<string, unknown>): Promise<{ action: "accept" | "cancel" | "decline"; content: unknown; _meta: null }> {
    if (params.mode === "url") {
      const url = stringParam(params.url);
      const accepted = await this.actions.confirm("MCP 需要网页登录", `${stringParam(params.message)}\n\n${url}`, "打开", "取消");
      if (accepted && url) this.actions.openUrl(url);
      return { action: accepted ? "accept" : "cancel", content: null, _meta: null };
    }
    const accepted = await this.actions.confirm(`MCP：${stringParam(params.serverName)}`, stringParam(params.message) || "是否继续？");
    return { action: accepted ? "accept" : "decline", content: {}, _meta: null };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

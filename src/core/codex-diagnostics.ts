export type CodexErrorDiagnosticKind = "websocket" | "proxy" | "timeout" | "missing-cli" | "app-server" | "generic";
export type CodexErrorDiagnosticLanguage = "zh-CN" | "en";

export interface CodexErrorDiagnosticContext {
  model?: string | null;
  providerLabel?: string | null;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  language?: CodexErrorDiagnosticLanguage;
}

export interface CodexErrorDiagnostic {
  kind: CodexErrorDiagnosticKind;
  title: string;
  cause: string;
  action: string;
  original: string;
  context: string;
  text: string;
}

export function diagnoseCodexError(error: unknown, context: CodexErrorDiagnosticContext = {}): CodexErrorDiagnostic {
  const language = normalizeDiagnosticLanguage(context.language);
  const input = errorMessage(error);
  const formatted = parseFormattedCodexDiagnostic(input);
  const original = formatted?.original ?? input;
  const normalized = original.toLowerCase();
  const kind = classifyCodexError(normalized, context);
  const base = baseDiagnostic(kind, language);
  const contextText = formatDiagnosticContext(context, language);
  if (formatted && formatted.language === language) return { ...base, original, context: contextText, text: input };
  const labels = diagnosticLabels(language);
  const separator = language === "en" ? ": " : "：";
  const originalText = localizeOriginalError(original, kind, language) || labels.unknownError;
  const text = [
    base.title,
    "",
    `${labels.cause}${separator}${base.cause}`,
    `${labels.action}${separator}${base.action}`,
    contextText ? `${labels.context}${separator}${contextText}` : "",
    `${labels.original}${separator}${originalText}`
  ].filter(Boolean).join("\n");
  return { ...base, original, context: contextText, text };
}

function classifyCodexError(value: string, context: CodexErrorDiagnosticContext): CodexErrorDiagnosticKind {
  if (isLikelyProxyError(value, context)) return "proxy";
  if (
    /responses_websocket/.test(value) ||
    /backend-api\/codex\/responses/.test(value) ||
    /wss:\/\/chatgpt\.com\/backend-api\/codex\/responses/.test(value) ||
    /os error 10061/.test(value) ||
    /actively refused/.test(value) ||
    /econnrefused/.test(value)
  ) {
    return "websocket";
  }
  if (/请求超时|timeout|timed out/.test(value)) return "timeout";
  if (/找不到 codex cli|enoent/.test(value)) return "missing-cli";
  if (/app-server.*(已退出|已关闭|未连接|exit|exited|closed|disconnect|disconnected)|codex app-server/.test(value)) return "app-server";
  return "generic";
}

function baseDiagnostic(kind: CodexErrorDiagnosticKind, language: CodexErrorDiagnosticLanguage): Pick<CodexErrorDiagnostic, "kind" | "title" | "cause" | "action"> {
  if (language === "en") return baseDiagnosticEn(kind);
  return baseDiagnosticZh(kind);
}

function baseDiagnosticZh(kind: CodexErrorDiagnosticKind): Pick<CodexErrorDiagnostic, "kind" | "title" | "cause" | "action"> {
  if (kind === "websocket") {
    return {
      kind,
      title: "Codex WebSocket 连接失败",
      cause: "Codex CLI 正在通过 ChatGPT 登录态连接 responses WebSocket，但连接被系统、代理或网络拒绝。",
      action: "把默认模型设为自动，或切换到非 gpt-5.5；如果当前网络需要代理，请启用本地代理并重连 Codex。"
    };
  }
  if (kind === "timeout") {
    return {
      kind,
      title: "Codex 请求超时",
      cause: "Codex CLI 没有在限定时间内返回结果，可能是模型响应慢、网络不稳定或本地 app-server 卡住。",
      action: "稍后重试；如果持续发生，请降低思考强度、切换模型，或在设置里重连 Codex。"
    };
  }
  if (kind === "proxy") {
    return {
      kind,
      title: "Codex 代理连接失败",
      cause: "插件已启用本地代理，但 Codex CLI 无法连接到这个代理地址，常见原因是代理软件未启动或端口不一致。",
      action: "确认代理软件正在运行，并核对插件里的代理 URL；如果当前网络不需要代理，请关闭插件代理后重连 Codex。"
    };
  }
  if (kind === "missing-cli") {
    return {
      kind,
      title: "找不到 Codex CLI",
      cause: "插件启动本机 Codex CLI 失败，当前路径不存在或 Codex CLI 未安装。",
      action: "确认 Codex CLI 已安装并可运行，或在插件设置里填写正确的 Codex CLI 路径。"
    };
  }
  if (kind === "app-server") {
    return {
      kind,
      title: "Codex app-server 连接中断",
      cause: "插件和 Codex CLI app-server 的本地连接不可用，可能是进程退出、启动失败或被系统拦截。",
      action: "在插件设置里重连 Codex；如果仍失败，请检查 Codex CLI 是否能在终端正常启动。"
    };
  }
  return {
    kind,
    title: "Codex 出错了",
    cause: "Codex CLI 返回了未分类错误。",
    action: "保留下面的原始错误信息，并结合 Codex CLI 日志继续排查。"
  };
}

function baseDiagnosticEn(kind: CodexErrorDiagnosticKind): Pick<CodexErrorDiagnostic, "kind" | "title" | "cause" | "action"> {
  if (kind === "websocket") {
    return {
      kind,
      title: "Codex WebSocket connection failed",
      cause: "Codex CLI is connecting to the responses WebSocket through the ChatGPT login session, but the connection was refused by the system, proxy, or network.",
      action: "Set the default model to Auto, or switch away from gpt-5.5. If this network needs a proxy, enable the local proxy and reconnect Codex."
    };
  }
  if (kind === "timeout") {
    return {
      kind,
      title: "Codex request timed out",
      cause: "Codex CLI did not return in time. The model may be slow, the network may be unstable, or the local app-server may be stuck.",
      action: "Retry later. If it keeps happening, lower reasoning, switch model, or reconnect Codex in settings."
    };
  }
  if (kind === "proxy") {
    return {
      kind,
      title: "Codex proxy connection failed",
      cause: "The plugin proxy is enabled, but Codex CLI cannot connect to that proxy URL. The proxy app may be stopped or the port may differ.",
      action: "Confirm the proxy app is running and the proxy URL is correct. If this network does not need a proxy, turn plugin proxy off and reconnect Codex."
    };
  }
  if (kind === "missing-cli") {
    return {
      kind,
      title: "Codex CLI not found",
      cause: "The plugin could not start the local Codex CLI because the configured path does not exist or Codex CLI is not installed.",
      action: "Install Codex CLI and sign in, or set the correct Codex CLI path in settings."
    };
  }
  if (kind === "app-server") {
    return {
      kind,
      title: "Codex app-server disconnected",
      cause: "The local connection between the plugin and Codex CLI app-server is unavailable. The process may have exited, failed to start, or been blocked by the system.",
      action: "Reconnect Codex in settings. If it still fails, check whether Codex CLI can start from Terminal."
    };
  }
  return {
    kind,
    title: "Codex error",
    cause: "Codex CLI returned an uncategorized error.",
    action: "Keep the original error below and continue with Codex CLI logs."
  };
}

function isLikelyProxyError(value: string, context: CodexErrorDiagnosticContext): boolean {
  if (!context.proxyEnabled) return false;
  const proxyUrl = context.proxyUrl?.trim().toLowerCase() ?? "";
  const proxyHostPort = proxyUrl.match(/\/\/([^/]+)/)?.[1] ?? "";
  return (
    /proxy/.test(value) ||
    (Boolean(proxyHostPort) && value.includes(proxyHostPort)) ||
    /\b127\.0\.0\.1:\d+\b/.test(value) ||
    /\blocalhost:\d+\b/.test(value)
  ) && (/econnrefused|actively refused|connection refused|os error 10061/.test(value));
}

function parseFormattedCodexDiagnostic(value: string): { language: CodexErrorDiagnosticLanguage; original: string } | null {
  if (/可能原因[:：]/.test(value) && /建议处理[:：]/.test(value) && /原始错误[:：]/.test(value)) {
    return { language: "zh-CN", original: value.match(/原始错误[:：]([\s\S]*)$/)?.[1]?.trim() ?? value };
  }
  if (/Possible cause:/.test(value) && /Suggested fix:/.test(value) && /Original error:/.test(value)) {
    return { language: "en", original: value.match(/Original error:([\s\S]*)$/)?.[1]?.trim() ?? value };
  }
  return null;
}

function diagnosticLabels(language: CodexErrorDiagnosticLanguage): { cause: string; action: string; context: string; original: string; unknownError: string } {
  return language === "en"
    ? { cause: "Possible cause", action: "Suggested fix", context: "Current context", original: "Original error", unknownError: "Unknown error" }
    : { cause: "可能原因", action: "建议处理", context: "当前上下文", original: "原始错误", unknownError: "未知错误" };
}

function formatDiagnosticContext(context: CodexErrorDiagnosticContext, language: CodexErrorDiagnosticLanguage): string {
  if (language === "en") {
    return [
      `Model ${context.model?.trim() || "Auto"}`,
      context.providerLabel ? `Connection ${context.providerLabel}` : "",
      context.proxyEnabled ? `Proxy ${context.proxyUrl || "enabled"}` : "Proxy off"
    ].filter(Boolean).join("; ");
  }
  return [
    `模型 ${context.model?.trim() || "自动"}`,
    context.providerLabel ? `连接 ${context.providerLabel}` : "",
    context.proxyEnabled ? `代理 ${context.proxyUrl || "已启用"}` : "代理关闭"
  ].filter(Boolean).join("；");
}

function localizeOriginalError(value: string, kind: CodexErrorDiagnosticKind, language: CodexErrorDiagnosticLanguage): string {
  if (language !== "en") return value;
  if (kind === "missing-cli") {
    const withPath = value.match(/找不到 Codex CLI：([^。]+)。/);
    if (withPath) return `Codex CLI not found: ${withPath[1]}. Install Codex CLI or set the correct path in settings.`;
    if (/找不到 Codex CLI/.test(value)) return "Codex CLI not found. Install Codex CLI, sign in, or set the correct path in settings.";
  }
  if (/未知错误/.test(value)) return "Unknown error";
  return value;
}

function normalizeDiagnosticLanguage(value: any): CodexErrorDiagnosticLanguage {
  return value === "en" ? "en" : "zh-CN";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

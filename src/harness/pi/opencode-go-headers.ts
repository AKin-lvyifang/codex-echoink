import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * OpenCode Go 要求每段对话带固定的 x-opencode-session，缺失时直接返回 400；
 * 同时要求客户端用自己的名字标识自己，不能伪装成通用 SDK。
 * https://opencode.ai/docs/console/go/#where-can-i-use-it
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";
export const OPENCODE_CLIENT_NAME = "echoink";

const OPENCODE_HOST = "opencode.ai";

export function isOpenCodeModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
  if (model.provider === "opencode-go" || model.provider === "opencode") return true;
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() === OPENCODE_HOST;
  } catch {
    return false;
  }
}

/** 对话级会话头；非 OpenCode 模型返回 undefined，不影响其他服务商。 */
export function openCodeSessionHeaders(
  model: Pick<Model<Api>, "provider" | "baseUrl">,
  sessionKey: string
): Record<string, string> | undefined {
  return isOpenCodeModel(model) && sessionKey
    ? { [OPENCODE_SESSION_HEADER]: sessionKey }
    : undefined;
}

/**
 * 发请求前统一补齐 OpenCode 所需请求头。调用方已给出的会话头优先；
 * 连接测试、后台单次生成等没有对话的请求，按单次请求生成会话号。
 */
export function withOpenCodeRequestHeaders<T extends { headers?: ProviderHeaders; sessionId?: string }>(
  model: Pick<Model<Api>, "provider" | "baseUrl">,
  options: T
): T {
  if (!isOpenCodeModel(model)) return options;
  const headers = { ...options.headers };
  const hasSession = Object.keys(headers).some(name => name.toLowerCase() === OPENCODE_SESSION_HEADER);
  return {
    ...options,
    headers: {
      ...headers,
      ...(hasSession ? {} : { [OPENCODE_SESSION_HEADER]: options.sessionId || crypto.randomUUID() }),
      [OPENCODE_CLIENT_HEADER]: OPENCODE_CLIENT_NAME
    }
  };
}

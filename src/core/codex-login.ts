export interface CodexLoginStartResponse {
  loginId?: string;
  authUrl?: string;
  authorizationUrl?: string;
  type?: string;
}

export interface CodexLoginCompletedNotification {
  loginId?: string;
  success?: boolean;
  error?: unknown;
}

export interface CodexLoginRpc {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export type CodexLoginErrorKind = "failed" | "timeout" | "cancelled" | "invalid-response";

export class CodexLoginError extends Error {
  constructor(readonly kind: CodexLoginErrorKind, message: string) {
    super(message);
    this.name = "CodexLoginError";
  }
}

export interface CodexLoginResult {
  loginId: string;
  authUrl: string;
}

export interface CodexLoginOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  openUrl?: (url: string) => void;
}

export async function startCodexLogin(rpc: CodexLoginRpc, options: CodexLoginOptions = {}): Promise<CodexLoginResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  let expectedLoginId = "";
  let settled = false;
  let resolveCompletion: (() => void) | null = null;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const buffered: CodexLoginCompletedNotification[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);

  const settleNotification = (notification: CodexLoginCompletedNotification): void => {
    if (settled || !expectedLoginId || notification.loginId !== expectedLoginId) return;
    settled = true;
    if (notification.success === false || notification.error) {
      rejectCompletion?.(new CodexLoginError("failed", loginFailureMessage(notification.error)));
      return;
    }
    resolveCompletion?.();
  };

  const unsubscribe = rpc.onNotification("account/login/completed", (params) => {
    const notification = asLoginCompletedNotification(params);
    if (!expectedLoginId) buffered.push(notification);
    else settleNotification(notification);
  });

  const abort = (): void => {
    if (settled) return;
    settled = true;
    rejectCompletion?.(new CodexLoginError("cancelled", "Codex 登录已取消"));
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (options.signal?.aborted) throw new CodexLoginError("cancelled", "Codex 登录已取消");
    const response = await rpc.request<CodexLoginStartResponse>("account/login/start", { authMode: "chatgpt" }, 15_000);
    expectedLoginId = String(response?.loginId ?? "").trim();
    const authUrl = String(response?.authUrl ?? response?.authorizationUrl ?? "").trim();
    if (!expectedLoginId || !authUrl) throw new CodexLoginError("invalid-response", "Codex 登录没有返回有效的授权链接");
    options.openUrl?.(authUrl);
    for (const notification of buffered) settleNotification(notification);
    if (!settled) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectCompletion?.(new CodexLoginError("timeout", "Codex 登录等待超时，请重试"));
      }, timeoutMs);
    }
    await completion;
    return { loginId: expectedLoginId, authUrl };
  } catch (error) {
    if (error instanceof CodexLoginError) throw error;
    throw new CodexLoginError("failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    options.signal?.removeEventListener("abort", abort);
  }
}

function asLoginCompletedNotification(value: unknown): CodexLoginCompletedNotification {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    loginId: typeof record.loginId === "string" ? record.loginId : "",
    success: typeof record.success === "boolean" ? record.success : undefined,
    error: record.error
  };
}

function loginFailureMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return `Codex 登录失败：${error.trim()}`;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return `Codex 登录失败：${(error as { message: string }).message}`;
  }
  return "Codex 登录失败，请重试";
}

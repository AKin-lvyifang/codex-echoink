import { requestUrl } from "obsidian";
import { MembershipApiError, type MembershipTransport } from "./account-service";

declare const __ECHOINK_MEMBERSHIP_API_URL__: string;
export const membershipApiUrl = typeof __ECHOINK_MEMBERSHIP_API_URL__ === "undefined"
  ? "https://echoink.cn" : __ECHOINK_MEMBERSHIP_API_URL__;

/** Shared HTTPS transport; no desktop credential or Electron dependencies. */
export function createMembershipTransport(apiUrl: string, request = requestUrl): MembershipTransport {
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
      throw new Error("会员服务仅支持HTTPS或本机测试地址。");
  }
  return async (endpoint, method, body, token) => {
    let payload: string | ArrayBuffer | undefined, contentType = "application/json";
    if (body instanceof FormData) {
      const multipart = new Response(body);
      payload = await multipart.arrayBuffer(); contentType = multipart.headers.get("content-type")!;
    } else if (body !== undefined) payload = JSON.stringify(body);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        request({ url: new URL(endpoint, apiUrl).href, method, headers: {
          "Content-Type": contentType, "X-EchoInk-Client": "plugin",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }, body: payload, throw: false }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("会员服务连接超时，请重试。")), 15000); })
      ]);
      const result: unknown = response.json;
      if (response.status >= 400) {
        const error = result as { error?: string; retryAfter?: unknown } | null;
        const header = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1]?.trim();
        const seconds = typeof error?.retryAfter === "number" && Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0
          ? error.retryAfter : /^\d+$/u.test(header ?? "") ? Number(header) : undefined;
        throw new MembershipApiError(error?.error || "REQUEST_FAILED", seconds);
      }
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
}

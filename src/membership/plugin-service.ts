import { Platform, requestUrl } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import {
  getActiveApiProvider,
  apiProviderHasUsableCredential,
} from "../settings/settings";
import { AccountService, MembershipApiError } from "./account-service";
import { createMembershipStorage, type DeviceEncryptionPort } from "./storage";
import { getElectronRemote } from "../core/quick-window-bridge";
import { membershipWebsiteUrl } from "./website-links";
declare const __ECHOINK_MEMBERSHIP_API_URL__: string;
export async function createPluginAccountService(
  plugin: CodexForObsidianPlugin,
): Promise<AccountService> {
  const apiUrl =
    typeof __ECHOINK_MEMBERSHIP_API_URL__ === "undefined"
      ? "https://echoink.cn"
      : __ECHOINK_MEMBERSHIP_API_URL__;
  const website = membershipWebsiteUrl;
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )
    )
      throw new Error("会员服务仅支持HTTPS或本机测试地址。");
  }
  const storage = await createMembershipStorage(
    plugin.app.secretStorage,
    Platform.isDesktopApp,
    apiUrl || "disabled",
    { encryption: getMembershipDeviceEncryption() },
  );
  const service = new AccountService(
    storage,
    async (endpoint, method, body, token) => {
      let payload: string | ArrayBuffer | undefined,
        contentType = "application/json";
      if (body instanceof FormData) {
        const multipart = new Response(body);
        payload = await multipart.arrayBuffer();
        contentType = multipart.headers.get("content-type")!;
      } else if (body !== undefined) payload = JSON.stringify(body);
      const response = await Promise.race([
        requestUrl({
          url: new URL(endpoint, apiUrl).href,
          method,
          headers: {
            "Content-Type": contentType,
            "X-EchoInk-Client": "plugin",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: payload,
          throw: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("会员服务连接超时，请重试。")),
            15000,
          ),
        ),
      ]);
      const result: unknown = response.json;
      if (response.status >= 400) {
        const failure = result as { error?: string } | null;
        throw new MembershipApiError(failure?.error || "REQUEST_FAILED");
      }
      return result;
    },
    apiUrl,
    (url) => window.open(url, "_blank", "noopener,noreferrer"),
    website,
    () => {
      const provider = getActiveApiProvider(plugin.settings);
      return provider &&
        apiProviderHasUsableCredential(
          provider,
          plugin.settings.openAICodexCredential,
        )
        ? "configured"
        : "missing";
    },
  );
  void service.initialize();
  const refresh = () => {
    void service.refresh();
  };
  plugin.registerDomEvent(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  plugin.registerDomEvent(window, "focus", refresh);
  plugin.registerInterval(window.setInterval(refresh, 300000));
  return service;
}

function getMembershipDeviceEncryption(): DeviceEncryptionPort | undefined {
  if (!Platform.isDesktopApp) return undefined;
  const remote = getElectronRemote() as { safeStorage?: DeviceEncryptionPort } | null;
  return remote?.safeStorage;
}

import { Platform, requestUrl } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import {
  getActiveApiProvider,
  apiProviderHasUsableCredential,
} from "../settings/settings";
import { AccountService } from "./account-service";
import { createMembershipTransport, membershipApiUrl } from "./transport";
import { createMembershipStorage, type DeviceEncryptionPort } from "./storage";
import { getElectronRemote } from "../core/quick-window-bridge";
import { membershipWebsiteUrl } from "./website-links";
export async function createPluginAccountService(
  plugin: CodexForObsidianPlugin,
): Promise<AccountService> {
  const apiUrl = membershipApiUrl;
  const website = membershipWebsiteUrl;
  const storage = await createMembershipStorage(
    plugin.app.secretStorage,
    Platform.isDesktopApp,
    apiUrl || "disabled",
    { encryption: getMembershipDeviceEncryption() },
  );
  const service = new AccountService(
    storage,
    createMembershipTransport(apiUrl, requestUrl),
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
  const usageStore = plugin.usageStore;
  if (usageStore) service.setStatisticsSource({
    read: () => usageStore.readStatistics(),
    subscribe: listener => usageStore.subscribe(listener),
  });
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

import type { App } from "obsidian";
import { AccountService } from "../membership/account-service";
import { createMobileMembershipStorage } from "../membership/mobile-storage";
import { createMembershipTransport, membershipApiUrl } from "../membership/transport";
import { membershipWebsiteUrl } from "../membership/website-links";
import { selectedModel, type MobileSettings } from "./settings";

export async function createMobileAccountService(app: App, settings: () => MobileSettings): Promise<AccountService> {
  let secretStorage: App["secretStorage"] | undefined;
  try { secretStorage = app.secretStorage; } catch { /* Keep membership session-only if the host port is unavailable. */ }
  const storage = await createMobileMembershipStorage(secretStorage, membershipApiUrl || "disabled");
  const account = new AccountService(storage, createMembershipTransport(membershipApiUrl), membershipApiUrl,
    url => { window.open(url, "_blank", "noopener,noreferrer"); }, membershipWebsiteUrl,
    () => selectedModel(settings())?.provider.apiKey ? "configured" : "missing");
  void account.initialize().catch(() => { /* Storage notice is exposed by the adapter. */ });
  return account;
}

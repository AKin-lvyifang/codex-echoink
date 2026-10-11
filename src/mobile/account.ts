import type { App } from "obsidian";
import { AccountService } from "../membership/account-service";
import { createMobileMembershipStorage } from "../membership/mobile-storage";
import { createMembershipTransport, membershipApiUrl } from "../membership/transport";
import { membershipWebsiteUrl } from "../membership/website-links";
import { selectedModel, type MobileSettings } from "./settings";

export async function createMobileAccountService(app: App, settings: () => MobileSettings): Promise<AccountService> {
  const storage = await createMobileMembershipStorage(app.secretStorage, membershipApiUrl || "disabled");
  const account = new AccountService(storage, createMembershipTransport(membershipApiUrl), membershipApiUrl,
    url => { window.open(url, "_blank", "noopener,noreferrer"); }, membershipWebsiteUrl,
    () => selectedModel(settings())?.provider.apiKey ? "configured" : "missing");
  void account.initialize().catch(() => { /* Storage notice is exposed by the adapter. */ });
  return account;
}

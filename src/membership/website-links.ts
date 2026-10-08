import type { MembershipPlanId } from "../settings/account-membership-pricing";
declare const __ECHOINK_MEMBERSHIP_WEBSITE_URL__: string;
export const membershipWebsiteUrl = typeof __ECHOINK_MEMBERSHIP_WEBSITE_URL__ === "undefined"
  ? "https://echoink.cn" : __ECHOINK_MEMBERSHIP_WEBSITE_URL__;
export function membershipWebsiteLink(
  entry: "plugin.about" | `plugin.plan.${MembershipPlanId}`,
  options: { baseURL?: string; planId?: MembershipPlanId; currency?: "CNY" | "USD" } = {},
) {
  const base = new URL(options.baseURL || membershipWebsiteUrl);
  if (base.username || base.password || !(base.protocol === "https:" ||
    base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))
    throw new Error("Invalid membership website address");
  const plan = options.planId;
  if (entry !== "plugin.about" && (!plan || !["early", "month", "quarter", "year"].includes(plan) || entry !== `plugin.plan.${plan}`))
    throw new Error("Invalid membership website entry");
  const url = new URL(entry === "plugin.about" ? "/" : "/plans", base.origin);
  if (entry !== "plugin.about") {
    if (!["CNY", "USD"].includes(options.currency || "")) throw new Error("Invalid membership currency");
    url.searchParams.set("plan", plan!);
    url.searchParams.set("currency", options.currency!);
  }
  url.searchParams.set("entry", entry);
  return url.href;
}

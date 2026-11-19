import * as assert from "node:assert/strict";
import { membershipWebsiteLink, tagMembershipWebsiteLink } from "../membership/website-links";
import { getApiProviderPreset, XIAOECHO_API_BASE_URL } from "../settings/provider-presets";
import { safeSkillCompareUrl } from "../membership/skill-delivery";
export function runMembershipWebsiteLinksTests() {
  assert.equal(membershipWebsiteLink("plugin.about"), "https://echoink.cn/?entry=plugin.about");
  for (const [entry, path] of [["plugin.about", "/"], ["plugin.theme", "/theme"], ["plugin.settings.provider", "/plans"]] as const) {
    const url = new URL(membershipWebsiteLink(entry, { baseURL: "https://website.example/prefix?email=private&account=private&version=private&device=private#private" }));
    assert.equal(url.origin, "https://website.example");
    assert.equal(url.pathname, path);
    assert.deepEqual([...url.searchParams], [["entry", entry]]);
    assert.equal(url.hash, "");
    assert.match(entry, /^plugin\.[a-z0-9.-]+$/u);
  }
  assert.equal(getApiProviderPreset("xiaoecho").docsUrl, "https://echoink.cn/plans?entry=plugin.settings.provider");
  assert.equal(XIAOECHO_API_BASE_URL, "https://echoink.cn/api/xiaoecho");
  const orders = new URL(membershipWebsiteLink("plugin.account.orders", { baseURL: "https://echoink.cn/?email=private#secret" }));
  assert.equal(orders.pathname, "/account");
  assert.equal(orders.searchParams.get("tab"), "orders");
  assert.equal(orders.searchParams.get("entry"), "plugin.account.orders");
  assert.deepEqual([...orders.searchParams.keys()].sort(), ["entry", "tab"]);
  assert.equal(orders.hash, "");
  assert.equal(new URL(membershipWebsiteLink("plugin.account.orders", { baseURL: "http://127.0.0.1:5173" })).origin, "http://127.0.0.1:5173");
  for (const planId of ["early", "month", "quarter", "year"] as const) {
    const url = new URL(membershipWebsiteLink(`plugin.plan.${planId}`, { baseURL: "https://echoink.cn/?email=private#secret", planId, currency: "CNY" }));
    assert.equal(url.pathname, planId === "early" ? "/checkout" : "/plans");
    assert.equal(url.searchParams.get("entry"), `plugin.plan.${planId}`);
    assert.equal(url.searchParams.get("plan"), planId);
    assert.deepEqual([...url.searchParams.keys()].sort(), planId === "early" ? ["entry", "plan"] : ["currency", "entry", "plan"]);
    assert.equal(url.hash, "");
  }
  assert.equal(membershipWebsiteLink("plugin.plan.early", { planId: "early", currency: "CNY" }), "https://echoink.cn/checkout?plan=early&entry=plugin.plan.early");
  // Max plans open the website checkout for the signed-in account; the plugin never prices or orders them itself.
  for (const planId of ["max-month", "max-quarter", "max-year"] as const) {
    const url = new URL(membershipWebsiteLink(`plugin.plan.${planId}`, { baseURL: "https://echoink.cn/?email=private#secret", planId, currency: "CNY" }));
    assert.equal(url.pathname, "/checkout"); assert.equal(url.searchParams.get("plan"), planId); assert.equal(url.searchParams.get("entry"), `plugin.plan.${planId}`);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["entry", "plan"]);
  }
  assert.throws(() => membershipWebsiteLink("plugin.plan.max-year" as never, { planId: "max-month" as never, currency: "CNY" }));
  assert.throws(() => membershipWebsiteLink("plugin.about", { baseURL: "javascript:alert(1)" }));
  assert.throws(() => membershipWebsiteLink("plugin.about", { baseURL: "https://user:secret@example.com" }));
  assert.throws(() => membershipWebsiteLink("plugin.login" as never));
  assert.throws(() => membershipWebsiteLink("plugin.plan.month", { planId: "month" }));
  for (const entry of ["plugin.news", "plugin.skills.comparison"] as const) {
    const value = "https://echoink.cn/support?email=private&account=private&version=private&device=private&entry=web#private";
    assert.equal(tagMembershipWebsiteLink(value, entry), `https://echoink.cn/support?entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink(tagMembershipWebsiteLink(value, entry), entry), `https://echoink.cn/support?entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink("https://echoink.cn/checkout?plan=max-year&currency=USD&tab=orders&email=private", entry), `https://echoink.cn/checkout?plan=max-year&currency=USD&tab=orders&entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink("https://echoink.cn/plans?plan=private&currency=private&tab=private", entry), `https://echoink.cn/plans?entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink("https://www.echoink.cn/theme", entry), `https://www.echoink.cn/theme?entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink("https://echoink.cn//elsewhere.example/path", entry), `https://echoink.cn//elsewhere.example/path?entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink("http://localhost:5173/support", entry, "http://localhost:5173/?device=private"), `http://localhost:5173/support?entry=${entry}`);
    assert.equal(tagMembershipWebsiteLink("https://website.example/support", entry, "https://website.example"), `https://website.example/support?entry=${entry}`);
    for (const untouched of ["https://example.com/?q=1#section", "https://echoink.cn.example.com/", "https://echoink.cn@elsewhere.example/", "https://echoink.cn/api", "https://echoink.cn/api/news/feed", "https://echoink.cn/skills/echoink/SKILL.md", "javascript:alert(1)", "not a URL"])
      assert.equal(tagMembershipWebsiteLink(untouched, entry), untouched);
  }
  assert.equal(safeSkillCompareUrl("https://echoink.cn/skills/compare"), "https://echoink.cn/skills/compare?entry=plugin.skills.comparison");
  assert.equal(safeSkillCompareUrl("https://example.test/compare?demo=1#section"), "https://example.test/compare?demo=1#section");
  assert.equal(safeSkillCompareUrl("javascript:alert(1)"), null);
  assert.throws(() => tagMembershipWebsiteLink("https://echoink.cn", "plugin.email.private" as never));
}

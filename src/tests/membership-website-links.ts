import * as assert from "node:assert/strict";
import { membershipWebsiteLink } from "../membership/website-links";
export function runMembershipWebsiteLinksTests() {
  assert.equal(membershipWebsiteLink("plugin.about"), "https://echoink.cn/?entry=plugin.about");
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
  assert.throws(() => membershipWebsiteLink("plugin.about", { baseURL: "javascript:alert(1)" }));
  assert.throws(() => membershipWebsiteLink("plugin.about", { baseURL: "https://user:secret@example.com" }));
}

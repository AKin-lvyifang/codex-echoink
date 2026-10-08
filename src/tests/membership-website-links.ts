import * as assert from "node:assert/strict";
import { membershipWebsiteLink } from "../membership/website-links";
export function runMembershipWebsiteLinksTests() {
  assert.equal(membershipWebsiteLink("plugin.about"), "https://echoink.cn/?entry=plugin.about");
  for (const planId of ["early", "month", "quarter", "year"] as const) {
    const url = new URL(membershipWebsiteLink(`plugin.plan.${planId}`, { baseURL: "https://echoink.cn/?email=private#secret", planId, currency: "CNY" }));
    assert.equal(url.pathname, "/plans");
    assert.equal(url.searchParams.get("entry"), `plugin.plan.${planId}`);
    assert.equal(url.searchParams.get("plan"), planId);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["currency", "entry", "plan"]);
    assert.equal(url.hash, "");
  }
  assert.throws(() => membershipWebsiteLink("plugin.about", { baseURL: "javascript:alert(1)" }));
  assert.throws(() => membershipWebsiteLink("plugin.about", { baseURL: "https://user:secret@example.com" }));
}

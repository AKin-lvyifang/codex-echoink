import * as assert from "node:assert/strict";
import { formatEarlyOfferEndDate, getMembershipPlanPricing, type MembershipProductPricing } from "../settings/account-membership-pricing";
import { createUnavailableAccountAdapter, membershipPlanAction } from "../settings/account-membership-model";

export const pricingProducts: readonly MembershipProductPricing[] = [
  { id: "early", prices: { CNY: 2990, USD: 999 }, days: null },
  { id: "month", prices: { CNY: 900, USD: 299 }, days: 30 },
  { id: "quarter", prices: { CNY: 1900, USD: 699 }, days: 90 },
  { id: "year", prices: { CNY: 4900, USD: 1999 }, days: 365 }
].map(product => ({ ...product, available: true, availability: "available", currencies: ["CNY"] })) as MembershipProductPricing[];

export function runAccountMembershipPricingTests(): void {
  assert.deepEqual(getMembershipPlanPricing("CNY"), []);
  assert.deepEqual(getMembershipPlanPricing("USD", null), []);
  assert.deepEqual(getMembershipPlanPricing("CNY", []), []);
  const plans = getMembershipPlanPricing("USD", pricingProducts);
  assert.deepEqual(plans.map(plan => [plan.id, plan.currency, plan.amountMinor]), [["early", "CNY", 2990], ["month", "CNY", 900], ["quarter", "CNY", 1900], ["year", "CNY", 4900]]);
  assert.deepEqual(plans.map(plan => [plan.comparisonAmountMinor, plan.savingsAmountMinor, plan.savingsPercent]), [[null, null, null], [null, null, null], [2700, 800, 30], [10800, 5900, 55]]);
  const base = createUnavailableAccountAdapter().read();
  for (const product of pricingProducts) {
    const vm = { ...base, salesOpen: true, products: [product] };
    assert.equal(membershipPlanAction(vm, product.id, "CNY", false, true).purchasable, true);
    for (const amount of [0, -1, NaN, Infinity, 1.5]) {
      const products = [{ ...product, prices: { ...product.prices, CNY: amount } }];
      assert.deepEqual(getMembershipPlanPricing("USD", products), []);
      assert.equal(membershipPlanAction({ ...vm, products }, product.id, "CNY", false, true).purchasable, false);
    }
    for (const availability of ["owned", "paused", "sold_out", "unavailable"] as const) {
      assert.equal(membershipPlanAction({ ...vm, products: [{ ...product, availability }] }, product.id, "CNY", false, true).purchasable, false);
    }
    for (const candidate of [{ ...vm, products: [] }, { ...vm, salesOpen: false }, { ...vm, products: [{ ...product, available: false }] }, { ...vm, products: [{ ...product, currencies: ["USD" as const] }] }]) {
      assert.equal(membershipPlanAction(candidate, product.id, "CNY", false, true).purchasable, false);
    }
  }
  assert.deepEqual(formatEarlyOfferEndDate("2026-12-31", Date.parse("2026-11-01T16:00:00Z")), { zh: "活动截止 2026年12月31日", en: "Offer ends Dec 31, 2026" });
  assert.equal(formatEarlyOfferEndDate("2026-12-31", Date.parse("2026-12-31T15:59:59Z"))?.en, "Offer ends Dec 31, 2026", "the server date remains visible through the last Beijing day");
  assert.equal(formatEarlyOfferEndDate("2026-12-31", Date.parse("2026-12-31T16:00:00Z")), null);
  for (const value of [null, undefined, "", "2026-02-30", "2026-2-03", "2026-13-01", "2026-12-31T00:00:00Z", "invalid"]) assert.equal(formatEarlyOfferEndDate(value), null);
  assert.equal(formatEarlyOfferEndDate("2028-02-29", Date.parse("2028-02-28T16:00:00Z"))?.en, "Offer ends Feb 29, 2028", "valid leap dates come from the server");
  console.log("PASS membership pricing: server-only CNY, fail-closed purchases, subscription savings and Beijing offer end dates");
}

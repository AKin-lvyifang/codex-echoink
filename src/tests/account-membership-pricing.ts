import * as assert from "node:assert/strict";
import { formatEarlyOfferEndDate, getMaxPlanPricing, getMembershipPlanPricing, type MembershipProductPricing } from "../settings/account-membership-pricing";
import { createUnavailableAccountAdapter, membershipPlanAction, membershipPrimaryAction } from "../settings/account-membership-model";

export const pricingProducts: readonly MembershipProductPricing[] = [
  { id: "early", prices: { CNY: 2990, USD: 999 }, days: null },
  { id: "month", prices: { CNY: 900, USD: 299 }, days: 30 },
  { id: "quarter", prices: { CNY: 1900, USD: 699 }, days: 90 },
  { id: "year", prices: { CNY: 4900, USD: 1999 }, days: 365 },
  { id: "max-month", prices: { CNY: 3900, USD: 599 }, days: 30, kind: "max", months: 1 },
  { id: "max-quarter", prices: { CNY: 10900, USD: 1699 }, days: 90, kind: "max", months: 3 },
  { id: "max-year", prices: { CNY: 39900, USD: 5999 }, days: 365, kind: "max", months: 12 }
].map(product => ({ ...product, available: true, availability: "available", currencies: ["CNY"] })) as MembershipProductPricing[];
/** The server quote a lifetime owner sees on Max: first-time coupon, list price struck through. */
export const lifetimeMaxQuote = (product: MembershipProductPricing): MembershipProductPricing => {
  const rate = { "max-month": 0.7, "max-quarter": 0.6, "max-year": 0.5 }[product.id] ?? 1;
  const amountMinor = Math.round(product.prices.CNY * rate / 10) * 10;
  return { ...product, quote: { listMinor: product.prices.CNY, amountMinor, coupon: { rate, discountMinor: product.prices.CNY - amountMinor }, proCredit: null, endsAt: Date.UTC(2027, 10, 30) } };
};

export function runAccountMembershipPricingTests(): void {
  assert.deepEqual(getMembershipPlanPricing("CNY"), []);
  assert.deepEqual(getMembershipPlanPricing("USD", null), []);
  assert.deepEqual(getMembershipPlanPricing("CNY", []), []);
  const plans = getMembershipPlanPricing("USD", pricingProducts);
  assert.deepEqual(plans.map(plan => [plan.id, plan.currency, plan.amountMinor]), [["early", "CNY", 2990], ["month", "CNY", 900], ["quarter", "CNY", 1900], ["year", "CNY", 4900]]);
  assert.deepEqual(plans.map(plan => [plan.comparisonAmountMinor, plan.savingsAmountMinor, plan.savingsPercent]), [[null, null, null], [null, null, null], [2700, 800, 30], [10950, 6050, 55]]);
  const base = createUnavailableAccountAdapter().read();
  for (const product of pricingProducts) {
    const vm = { ...base, salesOpen: true, maxSalesOpen: true, products: [product] };
    assert.equal(membershipPlanAction(vm, product.id, "CNY", false, true).purchasable, true);
    for (const amount of [0, -1, NaN, Infinity, 1.5]) {
      const products = [{ ...product, prices: { ...product.prices, CNY: amount } }];
      assert.deepEqual(getMembershipPlanPricing("USD", products), []);
      assert.equal(membershipPlanAction({ ...vm, products }, product.id, "CNY", false, true).purchasable, false);
    }
    for (const availability of ["owned", "paused", "sold_out", "unavailable"] as const) {
      assert.equal(membershipPlanAction({ ...vm, products: [{ ...product, availability }] }, product.id, "CNY", false, true).purchasable, false);
    }
    for (const candidate of [{ ...vm, products: [] }, { ...vm, salesOpen: false, maxSalesOpen: false }, { ...vm, products: [{ ...product, available: false }] }, { ...vm, products: [{ ...product, currencies: ["USD" as const] }] }]) {
      assert.equal(membershipPlanAction(candidate, product.id, "CNY", false, true).purchasable, false);
    }
  }
  // The two switches are independent; a missing Max flag fails closed.
  for (const salesOpen of [false, true]) for (const maxSalesOpen of [false, true]) {
    const vm = { ...base, salesOpen, maxSalesOpen, products: pricingProducts };
    for (const product of pricingProducts) {
      const max = product.id.startsWith("max-");
      for (const current of [false, true]) {
        const action = membershipPlanAction(vm, product.id, "CNY", current, true);
        assert.equal(action.purchasable, max ? maxSalesOpen : salesOpen);
        if (max && !maxSalesOpen) assert.deepEqual(action, { purchasable: false, zh: "即将开放", en: "Coming soon" });
      }
      assert.equal(membershipPlanAction(vm, product.id, "CNY", false, false).purchasable, false);
    }
  }
  assert.equal(membershipPlanAction({ ...base, salesOpen: true, products: pricingProducts }, "max-year", "CNY", false, true).en, "Coming soon");
  // Max rows: list price by default, the signed-in quote when present (coupon → "用首次优惠", current → "续费").
  assert.deepEqual(getMaxPlanPricing(pricingProducts).map(row => [row.id, row.days, row.listMinor, row.amountMinor, row.coupon]), [["max-month", 30, 3900, 3900, null], ["max-quarter", 90, 10900, 10900, null], ["max-year", 365, 39900, 39900, null]]);
  // Legacy months is deliberately inconsistent: every price and comparison uses catalogue days.
  const dayBased = pricingProducts.map(product => ({ ...product, months: 99, days: product.id === "max-quarter" ? 60 : product.days }));
  const byDays = getMaxPlanPricing(dayBased);
  assert.equal(byDays[1].days, 60);
  assert.equal(byDays[1].dailyAmountMinor, 10900 / 60);
  assert.equal(byDays[1].savingsAmountMinor, 3900 * 60 / 30 - 10900);
  assert.equal(byDays[2].savingsAmountMinor, 7550);
  assert.equal(byDays[2].savingsPercent, 16);
  assert.equal(getMaxPlanPricing(pricingProducts.filter(product => product.id !== "max-month"))[0].savingsPercent, null);
  const quoted = pricingProducts.map(product => product.kind === "max" ? lifetimeMaxQuote(product) : product);
  assert.deepEqual(getMaxPlanPricing(quoted).map(row => [row.id, row.amountMinor, row.coupon?.rate]), [["max-month", 2730, 0.7], ["max-quarter", 6540, 0.6], ["max-year", 19950, 0.5]]);
  assert.deepEqual(getMaxPlanPricing([]), []);
  assert.equal(membershipPlanAction({ ...base, salesOpen: true, maxSalesOpen: true, products: quoted }, "max-year", "CNY", false, true).zh, "用首次优惠");
  assert.equal(membershipPlanAction({ ...base, salesOpen: true, maxSalesOpen: true, products: pricingProducts }, "max-year", "CNY", false, true).zh, "立即订阅");
  assert.equal(membershipPlanAction({ ...base, salesOpen: true, maxSalesOpen: true, products: quoted }, "max-year", "CNY", true, true).zh, "续费");
  // The one primary button is an action: renew / upgrade / get PRO; lifetime owners get none.
  assert.equal(membershipPrimaryAction({ state: "lifetime", planId: "early", signedIn: true }), null);
  assert.equal(membershipPrimaryAction({ state: "active", planId: "beta", signedIn: true })?.zh, "升级 PRO");
  assert.equal(membershipPrimaryAction({ state: "active", planId: "year", signedIn: true })?.zh, "续费");
  assert.equal(membershipPrimaryAction({ state: "offline-valid", planId: "max-year", signedIn: true })?.kind, "renew");
  assert.equal(membershipPrimaryAction({ state: "free", planId: null, signedIn: true })?.zh, "开通 PRO");
  assert.equal(membershipPrimaryAction({ state: "expired", planId: "year", signedIn: true })?.zh, "开通 PRO");
  assert.equal(membershipPrimaryAction({ state: "anonymous", planId: null, signedIn: false }), null);
  assert.equal(membershipPrimaryAction({ state: "revoked", planId: "year", signedIn: true }), null);
  assert.deepEqual(formatEarlyOfferEndDate("2026-12-31", Date.parse("2026-11-01T16:00:00Z")), { zh: "活动截止 2026年12月31日", en: "Offer ends Dec 31, 2026" });
  assert.equal(formatEarlyOfferEndDate("2026-12-31", Date.parse("2026-12-31T15:59:59Z"))?.en, "Offer ends Dec 31, 2026", "the server date remains visible through the last Beijing day");
  assert.equal(formatEarlyOfferEndDate("2026-12-31", Date.parse("2026-12-31T16:00:00Z")), null);
  for (const value of [null, undefined, "", "2026-02-30", "2026-2-03", "2026-13-01", "2026-12-31T00:00:00Z", "invalid"]) assert.equal(formatEarlyOfferEndDate(value), null);
  assert.equal(formatEarlyOfferEndDate("2028-02-29", Date.parse("2028-02-28T16:00:00Z"))?.en, "Offer ends Feb 29, 2028", "valid leap dates come from the server");
  console.log("PASS membership pricing: server-only CNY, fail-closed purchases, subscription savings and Beijing offer end dates");
}

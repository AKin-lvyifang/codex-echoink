import * as assert from "node:assert/strict";
import { getMaxPlanPricing, getMembershipPlanPricing } from "../settings/account-membership-pricing";
import { pricingProducts, runAccountMembershipPricingTests } from "./account-membership-pricing";

export function runAccountDesktopPricingTests(): void {
  runAccountMembershipPricingTests();
  // PRO rows only: the shared fixture also carries the three Max products (their rows come from getMaxPlanPricing).
  const products = pricingProducts.filter(product => product.kind !== "max").map(product => ({ ...product, prices: { CNY: product.prices.CNY + 1000, USD: 499 }, days: product.id === "early" ? null : product.id === "month" ? 40 : product.id === "quarter" ? 100 : 400 }));
  const original = structuredClone(products);
  for (const currency of ["CNY", "USD"] as const) {
    const plans = getMembershipPlanPricing(currency, products);
    assert.deepEqual(plans.map(plan => plan.amountMinor), products.map(product => product.prices.CNY));
    assert.deepEqual(plans.map(plan => plan.days), [null, 40, 100, 400]);
    assert.equal(plans[0].comparisonAmountMinor, null);
    assert.equal(plans[2].dailyAmountMinor, products[2].prices.CNY / 100);
    assert.equal(plans[2].comparisonAmountMinor, products[1].prices.CNY * 100 / 40);
    assert.equal(plans[3].comparisonAmountMinor, products[1].prices.CNY * 400 / 40);
    const partial = getMembershipPlanPricing(currency, [products[2]]);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].comparisonAmountMinor, null, "missing monthly baseline cannot invent savings");
  }
  assert.deepEqual(getMembershipPlanPricing("CNY", products.map(product => ({ ...product, days: product.id === "early" ? null : 100 }))).map(row => row.comparisonAmountMinor), [null, null, null, null], "equal-duration products have no longer-term comparison regardless of their IDs");
  const maxProducts = pricingProducts.filter(product => product.kind === "max");
  const max = getMaxPlanPricing(maxProducts);
  assert.deepEqual(max.map(row => [row.days, row.savingsAmountMinor, row.savingsPercent]), [[30, null, null], [90, 800, 7], [365, 7550, 16]]);
  const quoted = maxProducts.map(product => ({ ...product, quote: { listMinor: product.prices.CNY, amountMinor: 1000, coupon: null, proCredit: { minor: product.prices.CNY - 1000 }, endsAt: 0 } }));
  assert.deepEqual(getMaxPlanPricing(quoted).map(row => row.dailyAmountMinor), [1000 / 30, 1000 / 90, 1000 / 365], "daily price uses actual payment and catalogue days");
  assert.deepEqual(getMaxPlanPricing(quoted).map(row => row.savingsAmountMinor), max.map(row => row.savingsAmountMinor), "quotes do not change list-price comparisons");
  assert.deepEqual(getMaxPlanPricing(quoted.map(product => ({ ...product, days: 100 }))).map(row => [row.dailyAmountMinor, row.savingsAmountMinor]), [[10, null], [10, null], [10, null]], "catalogue days change both daily rates and comparable periods, ignoring legacy months");
  assert.equal(getMaxPlanPricing([maxProducts[2]])[0].savingsAmountMinor, null, "missing Max monthly price cannot invent savings");
  assert.deepEqual(products, original);
  for (const days of [0, -1, NaN, Infinity, 1.5, null]) assert.deepEqual(getMembershipPlanPricing("CNY", [{ ...products[1], days }]), []);
  for (const days of [0, -1, NaN, Infinity, 1.5, null]) assert.deepEqual(getMaxPlanPricing([{ ...maxProducts[0], days }]), [], "legacy months cannot replace an invalid or absent day period");
  const { days: _days, ...legacyWithoutDays } = maxProducts[0];
  assert.deepEqual(getMaxPlanPricing([legacyWithoutDays as typeof maxProducts[number]]), [], "a legacy product must include valid days before it can be displayed");
  assert.deepEqual(getMembershipPlanPricing("CNY", [{ ...products[0], days: 365 }]), []);
  console.log("PASS desktop pricing: live amounts and periods, partial catalogue without invented comparisons");
}

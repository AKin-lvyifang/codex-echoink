import * as assert from "node:assert/strict";
import { getMembershipPlanPricing } from "../settings/account-membership-pricing";
import { pricingProducts, runAccountMembershipPricingTests } from "./account-membership-pricing";

export function runAccountDesktopPricingTests(): void {
  runAccountMembershipPricingTests();
  const products = pricingProducts.map(product => ({ ...product, prices: { CNY: product.prices.CNY + 1000, USD: 499 }, days: product.id === "early" ? null : 100 }));
  const original = structuredClone(products);
  for (const currency of ["CNY", "USD"] as const) {
    const plans = getMembershipPlanPricing(currency, products);
    assert.deepEqual(plans.map(plan => plan.amountMinor), products.map(product => product.prices.CNY));
    assert.deepEqual(plans.map(plan => plan.days), [null, 100, 100, 100]);
    assert.equal(plans[0].comparisonAmountMinor, null);
    assert.equal(plans[2].dailyAmountMinor, products[2].prices.CNY / 100);
    assert.equal(plans[2].comparisonAmountMinor, products[1].prices.CNY * 3);
    assert.equal(plans[3].comparisonAmountMinor, products[1].prices.CNY * 12);
    const partial = getMembershipPlanPricing(currency, [products[2]]);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].comparisonAmountMinor, null, "missing monthly baseline cannot invent savings");
  }
  assert.deepEqual(products, original);
  for (const days of [0, -1, NaN, Infinity, 1.5, null]) assert.deepEqual(getMembershipPlanPricing("CNY", [{ ...products[1], days }]), []);
  assert.deepEqual(getMembershipPlanPricing("CNY", [{ ...products[0], days: 365 }]), []);
  console.log("PASS desktop pricing: live amounts and periods, partial catalogue without invented comparisons");
}

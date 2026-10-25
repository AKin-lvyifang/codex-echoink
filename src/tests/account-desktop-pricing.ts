import * as assert from "node:assert/strict";
import { getMembershipPlanPricing, type MembershipCurrency, type MembershipProductPricing } from "../settings/account-membership-pricing";
import { runAccountMembershipPricingTests } from "./account-membership-pricing";

export function runAccountDesktopPricingTests(): void {
  runAccountMembershipPricingTests();
  const products: readonly MembershipProductPricing[] = [
    { id: "early", prices: { CNY: 3900, USD: 1999 }, days: null },
    { id: "month", prices: { CNY: 1500, USD: 499 }, days: 30 },
    { id: "quarter", prices: { CNY: 3000, USD: 1199 }, days: 100 },
    { id: "year", prices: { CNY: 12000, USD: 3999 }, days: 400 }
  ];
  const earlyCny = getMembershipPlanPricing("USD", [{ ...products[0], prices: { CNY: 2370, USD: 999 }, currencies: ["CNY"] }, ...products.slice(1)]);
  assert.equal(earlyCny[0].currency, "CNY"); assert.equal(earlyCny[0].amountMinor, 2370);
  assert.equal(earlyCny[0].comparisonAmountMinor, products[3].prices.CNY);
  assert.equal(earlyCny[1].currency, "USD"); assert.equal(earlyCny[1].amountMinor, products[1].prices.USD);
  const original = structuredClone(products);
  for (const currency of ["CNY", "USD"] as const) {
    const plans = getMembershipPlanPricing(currency, products);
    assert.deepEqual(plans.map(plan => plan.amountMinor), products.map(product => product.prices[currency]), `${currency}: valid service prices take precedence`);
    assert.deepEqual(plans.map(plan => plan.days), [null, 30, 100, 400], "daily pricing uses the actual service period");
    assert.equal(plans[0].dailyAmountMinor, null, "buyout does not invent a daily cost");
    assert.equal(plans[2].dailyAmountMinor, products[2].prices[currency] / 100);
    assert.equal(plans[3].dailyAmountMinor, products[3].prices[currency] / 400);
    assert.equal(plans[2].comparisonAmountMinor, products[1].prices[currency] * 3);
    assert.equal(plans[3].comparisonAmountMinor, products[1].prices[currency] * 12);
    assert.equal(plans[0].comparisonAmountMinor, products[3].prices[currency]);
    for (const plan of plans) {
      if (plan.comparisonAmountMinor !== null) assert.equal(plan.savingsPercent, Math.round((plan.comparisonAmountMinor - plan.amountMinor) / plan.comparisonAmountMinor * 100));
    }
    const fallback = getMembershipPlanPricing(currency);
    assert.deepEqual(getMembershipPlanPricing(currency, []), fallback);
    assert.deepEqual(getMembershipPlanPricing(currency, null), fallback);
    const partial = getMembershipPlanPricing(currency, [products[2]]);
    assert.equal(partial[2].amountMinor, products[2].prices[currency]);
    assert.equal(partial[2].comparisonAmountMinor, fallback[1].amountMinor * 3, "a partial catalogue uses the original monthly price when absent");
    assert.equal(partial[0].comparisonAmountMinor, fallback[3].amountMinor, "missing annual comparison remains usable");
    const monthOnly = getMembershipPlanPricing(currency, [products[1]]);
    assert.equal(monthOnly[3].comparisonAmountMinor, products[1].prices[currency] * 12, "fallback annual amount compares with the actual monthly product");
  }
  assert.deepEqual(products, original, "price calculations cannot mutate the service catalogue");
  for (const amount of [-1, NaN, Infinity, 1.5]) {
    const invalid: MembershipProductPricing[] = [{ ...products[1], prices: { CNY: amount, USD: 499 } }];
    assert.equal(getMembershipPlanPricing("CNY", invalid)[1].amountMinor, 900, `invalid CNY amount ${amount} falls back`);
    assert.equal(getMembershipPlanPricing("USD", invalid)[1].amountMinor, 499, "a valid price in the selected currency remains authoritative");
  }
  for (const days of [0, -1, NaN, Infinity, 1.5, null]) {
    const invalid = [{ ...products[1], days }];
    assert.equal(getMembershipPlanPricing("CNY", invalid)[1].amountMinor, 900, `invalid monthly period ${days} falls back`);
  }
  assert.equal(getMembershipPlanPricing("CNY", [{ ...products[0], days: 365 }])[0].amountMinor, 1990, "buyout must retain a non-expiring term");
  const invalidThenValid = [{ ...products[1], days: 0 }, products[1]];
  assert.equal(getMembershipPlanPricing("CNY", invalidThenValid)[1].amountMinor, 1500, "an invalid catalogue row cannot mask a valid product");
  const zeroMonthly = getMembershipPlanPricing("CNY", [{ ...products[1], prices: { CNY: 0, USD: 0 } }]);
  assert.equal(zeroMonthly[1].amountMinor, 0, "an explicit zero service price is not replaced with the fallback");
  assert.equal(zeroMonthly[2].savingsPercent, null, "a zero comparison does not divide by zero");
  for (const currency of ["CNY", "USD"] satisfies MembershipCurrency[]) {
    assert.ok(getMembershipPlanPricing(currency, products).every(plan => plan.dailyAmountMinor === null || Number.isFinite(plan.dailyAmountMinor)));
  }
  console.log("PASS desktop account pricing: CNY/USD service precedence, partial/invalid catalogue fallback, actual periods, computed savings and immutable data");
}

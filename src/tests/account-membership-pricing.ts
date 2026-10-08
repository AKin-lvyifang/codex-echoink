import * as assert from "node:assert/strict";
import { getMembershipPlanPricing, resolveMembershipCurrency } from "../settings/account-membership-pricing";

export function runAccountMembershipPricingTests(): void {
  for (const timeZone of ["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "PRC"]) {
    assert.equal(resolveMembershipCurrency(timeZone), "CNY", timeZone);
  }
  for (const timeZone of ["Asia/Singapore", "Asia/Taipei", "Asia/Hong_Kong", "Asia/Macau", "Asia/Tokyo", "America/New_York", "Europe/London", "Etc/GMT-8", "UTC", "Asia/Beijing", "", null, undefined]) {
    assert.equal(resolveMembershipCurrency(timeZone), "USD", String(timeZone));
  }

  const cny = getMembershipPlanPricing("CNY");
  const usd = getMembershipPlanPricing("USD");
  assert.deepEqual(cny.map(plan => [plan.id, plan.amountMinor]), [["early", 1990], ["month", 900], ["quarter", 1900], ["year", 4900]]);
  assert.deepEqual(usd.map(plan => [plan.id, plan.amountMinor]), [["early", 999], ["month", 299], ["quarter", 699], ["year", 1999]]);
  assert.deepEqual(cny.map(plan => [plan.comparisonAmountMinor, plan.savingsAmountMinor, plan.savingsPercent]), [
    [4900, 2910, 59], [null, null, null], [2700, 800, 30], [10800, 5900, 55]
  ]);
  assert.deepEqual(usd.map(plan => [plan.comparisonAmountMinor, plan.savingsAmountMinor, plan.savingsPercent]), [
    [1999, 1000, 50], [null, null, null], [897, 198, 22], [3588, 1589, 44]
  ]);

  for (const plans of [cny, usd]) {
    assert.deepEqual(plans.map(plan => plan.days), [null, 30, 90, 365]);
    assert.equal(plans[0].dailyAmountMinor, null, "lifetime has no invented daily cost");
    for (const plan of plans) {
      assert.ok(Number.isInteger(plan.amountMinor));
      if (plan.comparisonAmountMinor != null) {
        assert.ok(Number.isInteger(plan.savingsAmountMinor));
        assert.equal(plan.amountMinor + plan.savingsAmountMinor!, plan.comparisonAmountMinor);
      }
    }
  }
  assert.equal(cny[1].dailyAmountMinor, 30);
  assert.equal((cny[2].dailyAmountMinor! / 100).toFixed(2), "0.21");
  assert.equal((cny[3].dailyAmountMinor! / 100).toFixed(2), "0.13");
  assert.equal(usd[1].dailyAmountMinor!.toFixed(1), "10.0");
  assert.equal(usd[2].dailyAmountMinor!.toFixed(1), "7.8");
  assert.equal(usd[3].dailyAmountMinor!.toFixed(1), "5.5", "retain sub-cent precision until display formatting");
  console.log("PASS membership pricing: time-zone defaults, separate price lists, integer savings and daily display precision");
}

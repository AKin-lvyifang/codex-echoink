export type MembershipCurrency = "CNY" | "USD";
export type MembershipPlanId = "early" | "month" | "quarter" | "year";

export interface MembershipPlanPricing {
  readonly id: MembershipPlanId;
  readonly amountMinor: number;
  readonly days: number | null;
  /** Unrounded minor units per day; the view chooses its display precision. */
  readonly dailyAmountMinor: number | null;
  readonly comparisonAmountMinor: number | null;
  readonly savingsAmountMinor: number | null;
  readonly savingsPercent: number | null;
}

const mainlandTimeZones = new Set([
  "Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "PRC"
]);

/** A display default based on the current device time zone, not a location check. */
export function resolveMembershipCurrency(timeZone?: string | null): MembershipCurrency {
  return mainlandTimeZones.has(timeZone ?? "") ? "CNY" : "USD";
}

const prices: Record<MembershipCurrency, Record<MembershipPlanId, number>> = {
  CNY: { early: 1990, month: 900, quarter: 1900, year: 4900 },
  USD: { early: 999, month: 299, quarter: 699, year: 1999 }
};
const periods: readonly { readonly id: MembershipPlanId; readonly days: number | null }[] = [
  { id: "early", days: null },
  { id: "month", days: 30 },
  { id: "quarter", days: 90 },
  { id: "year", days: 365 }
];

export function getMembershipPlanPricing(currency: MembershipCurrency): readonly MembershipPlanPricing[] {
  const amounts = prices[currency];
  return periods.map(({ id, days }) => {
    const amountMinor = amounts[id];
    const comparisonAmountMinor = id === "early" ? amounts.year
      : id === "quarter" ? amounts.month * 3
      : id === "year" ? amounts.month * 12 : null;
    const savingsAmountMinor = comparisonAmountMinor == null ? null : comparisonAmountMinor - amountMinor;
    return {
      id, amountMinor, days,
      dailyAmountMinor: days == null ? null : amountMinor / days,
      comparisonAmountMinor,
      savingsAmountMinor,
      savingsPercent: comparisonAmountMinor == null ? null : Math.round(savingsAmountMinor! / comparisonAmountMinor * 100)
    };
  });
}

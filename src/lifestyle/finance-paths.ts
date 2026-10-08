export const FINANCE_DEFAULT_ROOT = "finance";
export const FINANCE_BILINGUAL_ROOT = "财务（finance）";
export const FINANCE_LEGACY_ROOT = "EchoInk/财务";
export const FINANCE_DEFAULT_TRANSACTIONS = "transactions";
export const FINANCE_BILINGUAL_TRANSACTIONS = "账目（transactions）";

export function isFinanceRootName(name: string): boolean {
  return name === FINANCE_DEFAULT_ROOT || name === FINANCE_BILINGUAL_ROOT;
}

export function isFinanceTransactionsName(name: string): boolean {
  return name === FINANCE_DEFAULT_TRANSACTIONS || name === FINANCE_BILINGUAL_TRANSACTIONS;
}

export function isLegacyFinancePath(path: string): boolean {
  return path === FINANCE_LEGACY_ROOT || path.startsWith(`${FINANCE_LEGACY_ROOT}/`);
}

export function isEchoInkFinanceBase(text: string): boolean {
  try {
    const value: unknown = parse(text);
    return !!value && typeof value === "object" && !Array.isArray(value)
      && !!(value as Record<string, unknown>).properties
      && Object.hasOwn((value as Record<string, unknown>).properties as object, "note.echoink_id");
  } catch { return false; }
}
import { parse } from "yaml";

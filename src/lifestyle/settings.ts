export type LifestyleKind = "finance";

export interface FinanceMerchantSetting {
  name: string; aliases: string[]; iconId: string; defaultCategory: string; active: boolean;
}
export interface FinanceAccountSetting { name: string; aliases: string[]; active: boolean }
export interface FinanceCategorySetting { name: string; icon: string; color: string; active: boolean }
export interface FinanceSettings {
  enabled: boolean; aiEnabled: boolean; importAiEnabled: boolean;
  merchants: FinanceMerchantSetting[]; accounts: FinanceAccountSetting[]; categories: FinanceCategorySetting[];
}

export const DEFAULT_FINANCE_CATEGORIES: readonly FinanceCategorySetting[] = [
  { name: "居住", icon: "house", color: "#9bb994", active: true },
  { name: "餐饮", icon: "coffee", color: "#d2bf84", active: true },
  { name: "购物", icon: "shopping-bag", color: "#b9a0ca", active: true },
  { name: "交通", icon: "car-front", color: "#8eafc7", active: true },
  { name: "订阅", icon: "repeat-2", color: "#a5bba0", active: true },
  { name: "其他", icon: "package", color: "#c8a587", active: true }
];

export interface LifestyleSettings {
  finance: FinanceSettings;
  /** Preserve settings owned by other versions without enabling their features. */
  [key: string]: unknown;
}

export const DEFAULT_LIFESTYLE_SETTINGS: LifestyleSettings = {
  finance: { enabled: false, aiEnabled: false, importAiEnabled: true, merchants: [], accounts: [], categories: DEFAULT_FINANCE_CATEGORIES.map((category) => ({ ...category })) }
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback: string): string => typeof value === "string" ? value.trim() : fallback;
const aliases = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 20) : [];
const entries = <T>(value: unknown, parse: (item: Record<string, unknown>) => T | null): T[] => Array.isArray(value)
  ? value.map((item) => parse(object(item))).filter((item): item is T => item !== null).slice(0, 500) : [];

export function normalizeLifestyleSettings(input: unknown): LifestyleSettings {
  const root = object(input), finance = object(root.finance);
  return {
    ...root,
    finance: {
      ...finance,
      enabled: finance.enabled === true,
      aiEnabled: finance.aiEnabled === true,
      importAiEnabled: finance.importAiEnabled !== false,
      merchants: entries(finance.merchants, (item): FinanceMerchantSetting | null => {
        const name = string(item.name, "");
        return name ? { ...item, name, aliases: aliases(item.aliases), iconId: string(item.iconId, "auto"), defaultCategory: string(item.defaultCategory, ""), active: item.active !== false } : null;
      }),
      accounts: entries(finance.accounts, (item): FinanceAccountSetting | null => {
        const name = string(item.name, "");
        return name ? { ...item, name, aliases: aliases(item.aliases), active: item.active !== false } : null;
      }),
      categories: Array.isArray(finance.categories) ? entries(finance.categories, (item): FinanceCategorySetting | null => {
        const name = string(item.name, "");
        return name ? { ...item, name, icon: string(item.icon, "package"), color: /^#[0-9a-fA-F]{6}$/u.test(String(item.color)) ? String(item.color) : "#c8a587", active: item.active !== false } : null;
      }) : DEFAULT_LIFESTYLE_SETTINGS.finance.categories.map((category) => ({ ...category }))
    }
  };
}

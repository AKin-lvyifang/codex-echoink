import { FINANCE_BRAND_ASSETS, FINANCE_BRAND_ASSETS_BY_ID } from "./finance-brand-assets";
import type { FinanceBudget, FinanceEntry } from "./store";
import { DEFAULT_FINANCE_CATEGORIES, type FinanceSettings } from "./settings";

/** Built-in Lucide ids accepted by Obsidian setIcon; the original twelve remain stable. */
export const FINANCE_CATEGORY_ICON_GROUPS: readonly [string, readonly [string, string][]][] = [
  ["餐饮", [["coffee", "咖啡"], ["utensils", "用餐"], ["cup-soda", "饮料"], ["soup", "汤食"], ["pizza", "披萨"], ["sandwich", "简餐"], ["cake-slice", "甜点"], ["ice-cream-cone", "冰淇淋"], ["wine", "葡萄酒"], ["beer", "啤酒"], ["cooking-pot", "做饭"], ["salad", "沙拉"], ["cherry", "水果"], ["fish", "海鲜"]]],
  ["购物", [["shopping-bag", "购物袋"], ["shopping-cart", "购物车"], ["shirt", "服饰"], ["watch", "腕表"], ["gem", "珠宝"], ["smartphone", "手机"], ["laptop", "电脑"], ["baby", "母婴"], ["store", "商店"], ["tags", "商品标签"], ["gift", "礼物"]]],
  ["居家", [["house", "居住"], ["bed", "卧室"], ["sofa", "家居"], ["lamp", "灯具"], ["bath", "卫浴"], ["key-round", "钥匙"], ["wrench", "维修"], ["hammer", "工具"], ["lightbulb", "照明"], ["plug-zap", "水电"]]],
  ["出行", [["car-front", "汽车"], ["bus-front", "公交"], ["train-front", "火车"], ["bike", "骑行"], ["plane", "飞机"], ["ship", "轮船"], ["fuel", "加油"], ["map-pin", "地点"], ["luggage", "行李"], ["ticket", "票务"], ["hotel", "住宿"], ["compass", "探索"]]],
  ["健康", [["heart", "健康"], ["pill", "药品"], ["stethoscope", "医疗"], ["dumbbell", "健身"], ["activity", "运动记录"], ["glasses", "眼镜"], ["smile", "护理"], ["bone", "骨科"]]],
  ["学习与工作", [["book-open", "学习"], ["graduation-cap", "教育"], ["pencil", "文具"], ["notebook-pen", "笔记"], ["library", "图书馆"], ["file-text", "文档"], ["presentation", "演示"], ["monitor", "显示器"], ["printer", "打印"], ["briefcase-business", "工作"]]],
  ["影音娱乐", [["music-2", "音乐"], ["film", "电影"], ["gamepad-2", "游戏"], ["camera", "摄影"], ["palette", "艺术"], ["headphones", "耳机"], ["clapperboard", "影视制作"]]],
  ["财务与生活", [["repeat-2", "订阅"], ["package", "其他"], ["wallet", "钱包"], ["credit-card", "银行卡"], ["banknote", "现金"], ["landmark", "银行"], ["receipt", "收据"], ["piggy-bank", "储蓄"], ["chart-bar", "统计"], ["circle-dollar-sign", "财务"], ["calendar-days", "日程"], ["shield-check", "保障"]]]
];
export const FINANCE_CATEGORY_ICON_CHOICES: readonly [string, string, string][] =
  FINANCE_CATEGORY_ICON_GROUPS.flatMap(([group, icons]) => icons.map(([id, name]): [string, string, string] => [id, name, group]));
export const FINANCE_CATEGORY_ICONS: readonly string[] = FINANCE_CATEGORY_ICON_CHOICES.map(([id]) => id);
export const FINANCE_BRAND_CHOICES: readonly [string, string][] = [
  ["auto", "自动匹配"], ["none", "无品牌图标"],
  ...FINANCE_BRAND_ASSETS.map((asset): [string, string] => [asset.id, asset.displayName])
];

const normal = (value: string): string => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();

export function matchConfigured<T extends { name: string; aliases: string[]; active: boolean }>(raw: string, items: readonly T[]): T | null {
  const value = normal(raw);
  if (!value) return null;
  const candidates = items.filter((item) => item.active).flatMap((item) => [item.name, ...item.aliases]
    .map((alias) => ({ item, alias: normal(alias) })).filter(({ alias }) => {
      if (alias.length < 2) return false;
      if (value === alias) return true;
      if (/^[a-z]{2,3}$/u.test(alias)) return new RegExp(`(?:^|[^a-z])${alias}(?:$|[^a-z])`, "u").test(value);
      return value.includes(alias);
    }));
  candidates.sort((a, b) => Number(value === b.alias) - Number(value === a.alias) || b.alias.length - a.alias.length);
  return candidates[0]?.item ?? null;
}

/** Only confirmed counterparty aliases are eligible for automatic brand artwork. */
const AUTO_BRANDS: readonly { id: string; names: readonly string[] }[] = [
  { id: "meituan-takeout", names: ["美团外卖", "美团外卖平台"] },
  { id: "meituan", names: ["美团", "美团网"] },
  { id: "eleme", names: ["饿了么", "饿了么外卖"] },
  { id: "taobao", names: ["淘宝", "淘宝闪购"] },
  { id: "douyin", names: ["抖音", "抖音电商"] },
  { id: "xiaohongshu", names: ["小红书"] },
  { id: "bilibili", names: ["哔哩哔哩", "bilibili"] },
  { id: "netease-cloud-music", names: ["网易云音乐"] },
  { id: "youku", names: ["优酷", "优酷视频"] },
  { id: "apple", names: ["Apple.com/bill"] }
];

export function automaticFinanceBrand(rawCounterparty: string): string {
  const value = normal(rawCounterparty);
  const matches = AUTO_BRANDS.flatMap(({ id, names }) => names.map((name) => ({ id, name: normal(name) })))
    .filter(({ id, name }) => FINANCE_BRAND_ASSETS_BY_ID.has(id) && value === name)
    .sort((a, b) => Number(value === b.name) - Number(value === a.name) || b.name.length - a.name.length);
  return matches[0]?.id ?? "";
}

export function resolveFinanceMerchant(rawCounterparty: string, settings: FinanceSettings): { name: string; iconId: string; defaultCategory: string } {
  const configured = matchConfigured(rawCounterparty, settings.merchants);
  if (configured) return {
    name: configured.name,
    iconId: configured.iconId === "auto" ? automaticFinanceBrand(configured.name) || automaticFinanceBrand(rawCounterparty) : configured.iconId,
    defaultCategory: settings.categories.some((category) => category.active && category.name === configured.defaultCategory) ? configured.defaultCategory : ""
  };
  return { name: rawCounterparty.trim() || "未命名商户", iconId: automaticFinanceBrand(rawCounterparty), defaultCategory: "" };
}

export function resolveFinanceAccount(rawPaymentMethod: string, settings: FinanceSettings): string {
  return matchConfigured(rawPaymentMethod, settings.accounts)?.name ?? rawPaymentMethod.trim();
}

export function financeCategoryNames(settings: FinanceSettings, entries: readonly FinanceEntry[] = [], budgets: readonly FinanceBudget[] = [], month?: string): string[] {
  const names = new Set(settings.categories.filter((category) => category.active).map((category) => category.name));
  for (const entry of entries) if (!month || entry.date.startsWith(month)) names.add(entry.category);
  for (const budget of budgets) if (!month || budget.month === month) for (const category of Object.keys(budget.allocations)) names.add(category);
  return names.size ? [...names] : ["其他"];
}

export function financeSelectableCategoryNames(settings: FinanceSettings): string[] {
  const names = [...new Set(settings.categories.filter((category) => category.active).map((category) => category.name))];
  return names.length ? names : ["其他"];
}

export function financeCategoryVisual(category: string, settings: FinanceSettings): { icon: string; color: string } {
  const selected = settings.categories.find((item) => item.name === category)
    ?? DEFAULT_FINANCE_CATEGORIES.find((item) => item.name === category);
  return { icon: selected && FINANCE_CATEGORY_ICONS.includes(selected.icon) ? selected.icon : "package", color: selected?.color ?? "#c8a587" };
}

export function financeBrandDataUri(id: string): string {
  return FINANCE_BRAND_ASSETS_BY_ID.get(id)?.dataUri ?? "";
}

export function financeBrandLightBackdrop(id: string): boolean {
  return !!FINANCE_BRAND_ASSETS_BY_ID.get(id)?.lightBackdrop;
}

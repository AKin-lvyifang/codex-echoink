import type { FinanceEntry } from "./store";
import type { FinanceImportRow } from "./finance-domain";
import { FINANCE_BRAND_CHOICES, financeSelectableCategoryNames, matchConfigured, resolveFinanceMerchant } from "./finance-catalog";
import type { FinanceSettings } from "./settings";

const BATCH_SIZE = 8;
const text = (value: unknown, max: number): string | null => typeof value === "string" && value.trim().length <= max ? value.trim() : null;
const abort = (): never => { throw new DOMException("已取消智能整理", "AbortError"); };

/** Retrieval only: narrow context by literal overlap, without deciding the semantic match. */
function shortlist<T>(source: string, items: readonly T[], labels: (item: T) => readonly string[], limit: number): T[] {
  const clean = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const query = clean(source);
  if (!query) return [];
  const pairs = (value: string): Set<string> => new Set([...value].slice(0, -1).map((char, index) => char + [...value][index + 1]));
  const queryPairs = pairs(query);
  return items.map((item) => {
    const score = Math.max(0, ...labels(item).map((label) => {
      const value = clean(label);
      if (value.length < 2) return 0;
      if (query === value) return 100;
      if (query.includes(value) || value.includes(query) && query.length >= 3) return 60 + Math.min(value.length, 20);
      const overlap = [...pairs(value)].filter((pair) => queryPairs.has(pair)).length;
      return overlap ? overlap / Math.max(1, Math.min(queryPairs.size, pairs(value).size)) * 20 : 0;
    }));
    return { item, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ item }) => item);
}

export interface FinanceOrganizationOptions {
  generate?: (systemPrompt: string, userPrompt: string, signal: AbortSignal) => Promise<string>;
  skillContent?: string;
  signal: AbortSignal;
  onProgress?: (done: number, total: number, rows: readonly FinanceImportRow[]) => void;
}
export interface FinanceOrganizationResult { rows: FinanceImportRow[]; warnings: string[]; aiCandidates: number }

interface Candidate {
  ref: number; rowIndexes: number[]; fixed: { merchant: boolean; category: boolean; account: boolean; icon: boolean };
  source: NonNullable<FinanceImportRow["sourceFields"]>; entry: FinanceEntry;
  choices?: { merchant: Map<string, { name: string; defaultCategory: string; iconId: string }>; account: Map<string, string>; icon: Map<string, string> };
}

function candidateKey(candidate: Candidate): string {
  const { merchantOrderId: _merchantOrderId, ...semanticSource } = candidate.source;
  return JSON.stringify([semanticSource, candidate.entry.source, candidate.entry.kind, candidate.entry.status,
    candidate.entry.merchant, candidate.entry.category, candidate.entry.account, candidate.fixed]);
}

function parseSuggestions(response: string): unknown[] {
  const trimmed = response.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型未返回 JSON 对象");
  const rows = (parsed as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) throw new Error("模型未返回 rows 数组");
  return rows;
}

/** Apply only bounded semantic suggestions; source facts and identity never enter this function. */
export function applyFinanceSuggestion(candidate: Candidate, suggestion: unknown, categories: readonly string[], iconIds: ReadonlySet<string>): FinanceEntry | null {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return null;
  const value = suggestion as Record<string, unknown>;
  if (value.ref !== candidate.ref) return null;
  const entry = { ...candidate.entry };
  const merchantChoice = candidate.choices?.merchant.get(String(value.merchantChoice));
  const merchant = merchantChoice?.name || text(value.merchant, 60);
  const description = text(value.description, 200);
  const category = text(value.category, 60);
  const account = candidate.choices?.account.get(String(value.accountChoice)) || text(value.account, 100);
  const iconId = candidate.choices?.icon.get(String(value.iconChoice)) || text(value.iconId, 100);
  if (!candidate.fixed.merchant && merchant) entry.merchant = merchant;
  if (description) entry.description = description;
  if (!candidate.fixed.category && category && categories.includes(category)) entry.category = category;
  if (!candidate.fixed.merchant && merchantChoice?.defaultCategory) entry.category = merchantChoice.defaultCategory;
  if (!candidate.fixed.account && account) entry.account = account;
  if (!candidate.fixed.icon && iconId && iconIds.has(iconId)) entry.icon = iconId;
  if (!candidate.fixed.merchant && !candidate.fixed.icon && merchantChoice?.iconId && merchantChoice.iconId !== "auto") entry.icon = merchantChoice.iconId;
  return entry;
}

/** Deterministic catalog choices are included in the first on-disk version. */
export function applyFinanceImportSettings(sourceRows: readonly FinanceImportRow[], settings: FinanceSettings): FinanceImportRow[] {
  return sourceRows.map((row) => {
    if (!row.entry || !row.sourceFields) return { ...row, entry: row.entry ? { ...row.entry } : null };
    const source = row.sourceFields;
    const merchant = resolveFinanceMerchant(source.counterparty, settings);
    const account = matchConfigured(source.paymentMethod, settings.accounts);
    return { ...row, entry: { ...row.entry, merchant: merchant.name,
      category: merchant.defaultCategory || row.entry.category,
      account: account?.name || (source.paymentMethod !== "/" ? source.paymentMethod : "") || row.entry.account,
      icon: merchant.iconId || "auto" } };
  });
}

export async function organizeFinanceRows(
  sourceRows: readonly FinanceImportRow[], settings: FinanceSettings, existing: readonly FinanceEntry[], options: FinanceOrganizationOptions
): Promise<FinanceOrganizationResult> {
  const rows = sourceRows.map((row): FinanceImportRow => ({ ...row, entry: row.entry ? { ...row.entry } : null }));
  const known = new Set(existing.map((entry) => `${entry.source}:${entry.sourceId}`));
  const candidates: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  for (const [index, row] of rows.entries()) {
    if (!row.entry || !row.sourceFields) continue;
    const entry = row.entry;
    const source = row.sourceFields;
    const merchantRule = matchConfigured(source.counterparty, settings.merchants);
    const accountRule = matchConfigured(source.paymentMethod, settings.accounts);
    const resolvedMerchant = resolveFinanceMerchant(source.counterparty, settings);
    entry.merchant = resolvedMerchant.name;
    entry.account = accountRule?.name || (source.paymentMethod !== "/" ? source.paymentMethod : "") || entry.account;
    entry.category = resolvedMerchant.defaultCategory || entry.category;
    entry.icon = resolvedMerchant.iconId || "auto";
    const identity = `${entry.source}:${entry.sourceId}`;
    if (known.has(identity)) continue;
    known.add(identity);
    const candidate: Candidate = { ref: index, rowIndexes: [index], source, entry, fixed: {
      merchant: !!merchantRule, category: !!resolvedMerchant.defaultCategory, account: !!accountRule,
      icon: !!merchantRule && merchantRule.iconId !== "auto"
    } };
    const key = candidateKey(candidate);
    const earlier = byKey.get(key);
    if (earlier) earlier.rowIndexes.push(index);
    else { byKey.set(key, candidate); candidates.push(candidate); }
  }
  const warnings: string[] = [];
  if (!options.generate || !options.skillContent) {
    warnings.push("智能整理未运行，已保留原字段及你设置的资料匹配，可核对后基础导入");
    return { rows, warnings, aiCandidates: 0 };
  }
  const categories = financeSelectableCategoryNames(settings);
  const activeMerchants = settings.merchants.filter((item) => item.active);
  const activeAccounts = settings.accounts.filter((item) => item.active);
  const brands = FINANCE_BRAND_CHOICES.filter(([id]) => id !== "auto" && id !== "none");
  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    if (options.signal.aborted) abort();
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const candidateIcons = new Map<number, ReadonlySet<string>>();
    const input = {
      categories,
      rows: batch.map(({ ref, source, entry, fixed }) => {
        const context = `${source.counterparty} ${source.product} ${source.transactionType}`;
        const merchantCandidates = shortlist(context, activeMerchants, (item) => [item.name, ...item.aliases], 8)
          .map(({ name, aliases, defaultCategory, iconId }, index) => ({ id: `m${index}`, name, aliases, defaultCategory, iconId }));
        const accountCandidates = shortlist(source.paymentMethod, activeAccounts, (item) => [item.name, ...item.aliases], 5)
          .map(({ name, aliases }, index) => ({ id: `a${index}`, name, aliases }));
        const brandCandidates = shortlist(context, brands, ([, name]) => [name], 4)
          .map(([id, displayName], index) => ({ choice: `b${index}`, id, displayName }));
        const candidate = batch.find((item) => item.ref === ref)!;
        candidate.choices = {
          merchant: new Map(merchantCandidates.map(({ id, name, defaultCategory, iconId }) => [id, { name,
            defaultCategory: categories.includes(defaultCategory) ? defaultCategory : "", iconId }])),
          account: new Map(accountCandidates.map(({ id, name }) => [id, name])),
          icon: new Map(brandCandidates.map(({ choice, id }) => [choice, id]))
        };
        candidateIcons.set(ref, new Set(["auto", "none", entry.icon || "auto", ...brandCandidates.map(({ id }) => id)]));
        const { merchantOrderId: _merchantOrderId, ...modelSource } = source;
        return { ref, source: entry.source, ...modelSource, merchantCandidates, accountCandidates, brandCandidates,
          noMatchAllowed: true, current: {
        merchant: entry.merchant, description: entry.description, category: entry.category,
        account: entry.account, iconId: entry.icon || "auto"
          }, fixed };
      })
    };
    try {
      const response = await options.generate(options.skillContent, JSON.stringify(input), options.signal);
      if (options.signal.aborted) abort();
      const parsed = parseSuggestions(response);
      const handled = new Set<number>();
      for (const suggestion of parsed) {
        if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) continue;
        const candidate = batch.find((item) => item.ref === (suggestion as Record<string, unknown>).ref);
        if (!candidate) continue;
        const applied = applyFinanceSuggestion(candidate, suggestion, categories, candidateIcons.get(candidate.ref) || new Set(["auto", "none"]));
        if (!applied) continue;
        handled.add(candidate.ref);
        const review = text((suggestion as Record<string, unknown>).review, 160);
        const reason = text((suggestion as Record<string, unknown>).reason, 160);
        const proposedCategory = (suggestion as Record<string, unknown>).category;
        const proposed = suggestion as Record<string, unknown>;
        const iconOptions = candidateIcons.get(candidate.ref) || new Set(["auto", "none"]);
        for (const index of candidate.rowIndexes) {
          rows[index].entry = { ...rows[index].entry!, merchant: applied.merchant, description: applied.description,
            category: applied.category, account: applied.account, icon: applied.icon };
          if (review) rows[index].review = [rows[index].review, review].filter(Boolean).join("；");
          if (reason) rows[index].reason = reason;
          if (typeof proposedCategory !== "string")
            rows[index].review = [rows[index].review, "整理建议缺少分类，已保留基础分类"].filter(Boolean).join("；");
          if (typeof proposedCategory === "string" && !categories.includes(proposedCategory))
            rows[index].review = [rows[index].review, "建议分类不在当前目录中，已保留基础分类"].filter(Boolean).join("；");
          if (typeof proposed.merchantChoice === "string" && !candidate.choices?.merchant.has(proposed.merchantChoice))
            rows[index].review = [rows[index].review, "未能匹配商户，已保留原名称"].filter(Boolean).join("；");
          if (typeof proposed.accountChoice === "string" && !candidate.choices?.account.has(proposed.accountChoice))
            rows[index].review = [rows[index].review, "未能匹配账户，已保留原账户"].filter(Boolean).join("；");
          if ((typeof proposed.iconChoice === "string" && !candidate.choices?.icon.has(proposed.iconChoice))
            || (typeof proposed.iconId === "string" && !iconOptions.has(proposed.iconId)))
            rows[index].review = [rows[index].review, "未能匹配图标，已保留原图标"].filter(Boolean).join("；");
        }
      }
      for (const candidate of batch) if (!handled.has(candidate.ref)) for (const index of candidate.rowIndexes) {
        rows[index].review = [rows[index].review, "智能整理未返回有效建议，按基础字段待核对"].filter(Boolean).join("；");
      }
    } catch (error) {
      if (options.signal.aborted) abort();
      warnings.push(`第 ${offset + 1}–${offset + batch.length} 个候选未完成智能整理：${error instanceof Error ? error.message : String(error)}`);
      for (const candidate of batch) for (const index of candidate.rowIndexes) rows[index].review = [rows[index].review, "智能整理失败，按基础字段待核对"].filter(Boolean).join("；");
    }
    options.onProgress?.(Math.min(candidates.length, offset + batch.length), candidates.length,
      batch.flatMap((candidate) => candidate.rowIndexes.map((index) => rows[index])));
  }
  return { rows, warnings, aiCandidates: candidates.length };
}

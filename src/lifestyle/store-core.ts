export interface LifestyleFilePort {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
  backup(content: string): Promise<void>;
}

export type FinanceKind = "expense" | "income" | "refund" | "transfer";
export interface FinanceEntry {
  id: string; source: "manual" | "wechat" | "alipay";
  sourceId: string; date: string; merchant: string; category: string;
  kind: FinanceKind; amountCents: number; status: "completed" | "failed";
  account: string; description: string; currency: string; note: string;
  icon?: string;
  billPlanId?: string;
}
export interface FinanceBillPlan { id: string; name: string; budgetCents: number }

export interface FinanceBudget {
  month: string; totalCents: number; allocations: Record<string, number>;
}
export type FinanceDefaultBudget = Omit<FinanceBudget, "month">;
export type FinanceGoalMode = "manual" | "income" | "within-limit-days";
export interface FinanceGoal {
  id: string; name: string; mode: FinanceGoalMode;
  target: number; actual: number; unit: string;
}
export interface FinanceMonthlyPlan {
  month: string; dailyLimitCents: number | null; goals: FinanceGoal[];
}
export type FinanceContinuousGoal = {
  id: string; name: string; metric: "expense" | "income" | "balance";
  period: "day" | "week" | "month"; category: string; target: number;
} | {
  id: string; name: string; metric: "savings-rate" | "category-share";
  period: "month"; category: string; target: number;
};
export interface LifeReport {
  id: string; kind: string; period: string;
  createdAt: number; provider: string; promptVersion: string;
  inputFingerprint: string; inputSummary: string; text: string;
  financeSnapshot?: unknown;
}
export interface LifestyleData {
  version: 1;
  financeEntries: FinanceEntry[];
  budgets: FinanceBudget[];
  financeDefaultBudget?: FinanceDefaultBudget | null;
  financePlans: FinanceMonthlyPlan[];
  financeBillPlans: FinanceBillPlan[];
  financeGoals: FinanceContinuousGoal[];
  reports: LifeReport[];
  /** Unowned fields survive finance writes without loading another plugin. */
  [key: string]: unknown;
}

export const EMPTY_LIFESTYLE_DATA: LifestyleData = {
  version: 1, financeEntries: [], budgets: [], financeDefaultBudget: null, financePlans: [], financeBillPlans: [], financeGoals: [], reports: []
};

export function lifeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeData(raw: unknown): LifestyleData {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const list = <T>(name: keyof LifestyleData): T[] => Array.isArray(value[name]) ? value[name] as T[] : [];
  const plans = new Map<string, FinanceBillPlan>();
  for (const raw of list<FinanceBillPlan>("financeBillPlans")) {
    if (!raw || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || !raw.name.trim()
      || !Number.isSafeInteger(raw.budgetCents) || raw.budgetCents <= 0 || plans.has(raw.id)) continue;
    plans.set(raw.id, { id: raw.id, name: raw.name.trim(), budgetCents: raw.budgetCents });
  }
  return {
    ...value,
    version: 1,
    financeDefaultBudget: value.financeDefaultBudget as FinanceDefaultBudget | null ?? null,
    financeEntries: list("financeEntries"), budgets: list("budgets"), financePlans: list("financePlans"),
    financeBillPlans: [...plans.values()], financeGoals: list("financeGoals"), reports: list("reports")
  };
}

export class LifestyleStoreCore {
  private data: LifestyleData = structuredClone(EMPTY_LIFESTYLE_DATA);
  private legacyFinanceFieldPresent = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(private readonly file: LifestyleFilePort) {}

  async initialize(): Promise<void> {
    const content = await this.file.read();
    if (content === null) return;
    const raw: unknown = JSON.parse(content);
    this.legacyFinanceFieldPresent = !!raw && typeof raw === "object" && Object.hasOwn(raw, "financeEntries");
    this.data = normalizeData(raw);
  }

  snapshot(): Readonly<LifestyleData> { return structuredClone(this.data); }
  hasLegacyFinanceField(): boolean { return this.legacyFinanceFieldPresent; }
  async retainLegacyFinanceBackup(): Promise<void> {
    if (!this.data.financeEntries.length) return;
    await this.file.backup(JSON.stringify({ version: 1, financeEntries: this.data.financeEntries }, null, 2));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update<T>(mutate: (draft: LifestyleData) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = structuredClone(this.data);
      const result = mutate(draft);
      const persisted: Record<string, unknown> = { ...draft };
      if (!draft.financeEntries.length) delete persisted.financeEntries;
      await this.file.write(JSON.stringify(persisted, null, 2));
      this.data = draft;
      this.legacyFinanceFieldPresent = draft.financeEntries.length > 0;
      for (const listener of this.listeners) listener();
      return result;
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => undefined);
    return await pending;
  }
}

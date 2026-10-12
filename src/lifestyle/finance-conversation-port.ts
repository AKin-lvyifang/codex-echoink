import { sha256Hex } from "../utils/sha256";
import { localDate, validateBudget } from "./finance-domain";
import { validateFinanceBillPlan } from "./finance-bill-plan";
import { financeBudgetSnapshot, financeValueVersion } from "./finance-operation-types";
import type { LifestyleFinanceService } from "./finance-service";
import type { FinanceBillPlan } from "./store-core";
import { budgetPatch, financeToolEffect, normalizeFinanceToolRequest, type PiFinanceToolId } from "../harness/pi-native/finance-tool-policy";
import { normalizeJsonValue } from "../harness/pi-native/tool-authorization";
import type { PreparedObsidianOperation, ObsidianCliResult } from "../harness/pi-native/pi-obsidian-tools";

/** Uses the existing ledger/store; this port never invokes the official CLI. */
export function financeConversationPort(finance?: LifestyleFinanceService) {
  const json = (value: unknown) => normalizeJsonValue(JSON.parse(JSON.stringify(value)));
  return async (tool: PiFinanceToolId, args: unknown, operationSeed: string, signal?: AbortSignal): Promise<PreparedObsidianOperation> => {
    if (!finance) throw new Error("finance_service_unavailable");
    if (signal?.aborted) throw new Error("approval_cancelled");
    const input = normalizeFinanceToolRequest(tool, args);
    const effect = financeToolEffect(tool, input);
    const state = await finance.readForConversation();
    const scope = !input.scope || input.scope === "current" ? localDate().slice(0, 7) : input.scope;
    const command = `${tool}.${input.action}`;
    const recordView = (r: typeof state.records[number]) => ({ ...r.entry, path: r.path, expectedVersion: r.version });
    const bills = () => state.data.financeBillPlans.map(b => ({ ...b, expectedVersion: financeValueVersion(b) }));
    let target: unknown = { domain: "finance", tool, action: input.action };
    let targetVersion: unknown = null;
    let preview: unknown = input;
    let business: unknown = input;
    let read: unknown;
    let apply: (() => Promise<unknown>) | undefined;
    if (effect === "read") {
      if (tool === "finance_query" && input.action === "records") {
        const rows = state.records.filter(r => (!input.id || r.entry.id === input.id) && (!input.from || r.entry.date.slice(0, 10) >= input.from) && (!input.to || r.entry.date.slice(0, 10) <= input.to)
          && (!input.category || r.entry.category === input.category) && (!input.billPlanId || r.entry.billPlanId === input.billPlanId)
          && (!input.query || `${r.entry.merchant} ${r.entry.description} ${r.entry.note}`.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())))
          .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || a.entry.id.localeCompare(b.entry.id));
        const offset = input.offset ?? 0, limit = input.limit ?? 20;
        read = { records: rows.slice(offset, offset + limit).map(recordView), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null, issues: state.issues, legacyRecordsPendingMigration: state.data.financeEntries.length };
      } else if (tool === "finance_query" && input.action === "catalog") read = { categories: state.categories, accounts: state.accounts, localToday: localDate() };
      else if (tool === "finance_budget" || input.action === "budget") { const b = financeBudgetSnapshot(state.data, scope); read = { ...b, expectedVersion: b.version }; }
      else read = { bills: bills() };
    } else if (tool === "finance_record" && input.action === "create") {
      const r = input.record!;
      const category = r.category ?? (/早餐|午餐|晚餐|吃饭|餐饮/u.test(r.description ?? "") ? "餐饮" : "");
      if (!state.categories.some(c => c.active && c.name === category)) throw new Error("finance_existing_category_required");
      const token = sha256Hex(operationSeed);
      const prepared = finance.prepareManual({ date: r.date ?? localDate(), merchant: r.merchant ?? "", account: r.account ?? "", description: r.description ?? "", category,
        amountCents: r.amountCents!, kind: r.kind ?? "expense", status: "completed", currency: "CNY", note: r.note ?? "", icon: r.icon ?? "auto", ...(r.billPlanId ? { billPlanId: r.billPlanId } : {}) }, { id: `entry-${token}`, sourceId: `manual-${token}` });
      target = { domain: "finance", recordId: prepared.entry.id, path: prepared.relativePath };
      targetVersion = { absent: true, expectedEntry: prepared.entry, kind: "record-create", recordId: prepared.entry.id };
      preview = { action: "create", record: prepared.entry, path: prepared.relativePath };
      const { id: _id, sourceId: _sourceId, source: _source, ...facts } = prepared.entry;
      business = { action: "create", record: facts };
      apply = async () => {
        await prepared.create();
        const record = (await finance.readForConversation()).records.find(r => r.entry.id === prepared.entry.id);
        if (!record || Object.entries(prepared.entry).some(([key, value]) => record.entry[key as keyof typeof record.entry] !== value)) throw new Error("finance_readback_failed");
        return { record: recordView(record) };
      };
    } else if (tool === "finance_record" || tool === "finance_bill" && input.action === "associate") {
      const records = input.targets!.map(t => {
        const row = state.records.find(r => r.entry.id === t.id);
        if (!row) throw new Error("finance_record_not_found");
        if (row.version !== t.expectedVersion) throw new Error("finance_version_conflict");
        return row;
      });
      if (tool === "finance_bill") {
        const bill = state.data.financeBillPlans.find(b => b.id === input.id);
        if (!bill) throw new Error("finance_bill_not_found");
        if (financeValueVersion(bill) !== input.expectedVersion) throw new Error("finance_version_conflict");
      }
      target = { domain: "finance", records: records.map(r => ({ id: r.entry.id, path: r.path })) };
      const patch = tool === "finance_bill" ? { billPlanId: input.id } : input.patch;
      targetVersion = { kind: input.action === "delete" ? "record-delete" : "record-update", records: records.map(r => ({ id: r.entry.id, path: r.path, version: r.version,
        ...(input.action !== "delete" ? { expectedEntry: { ...r.entry, ...patch, ...(patch?.billPlanId === null ? { billPlanId: undefined } : {}) } } : {}) })), ...(tool === "finance_bill" ? { billId: input.id, billVersion: input.expectedVersion } : {}) };
      preview = { action: input.action, records: records.map(recordView), ...(patch ? { patch } : {}) };
      business = { action: input.action, recordIds: records.map(r => r.entry.id), ...(patch ? { patch } : {}) };
      apply = async () => {
        const results: unknown[] = [];
        for (const record of records) {
          if (signal?.aborted) { results.push({ id: record.entry.id, status: "cancelled" }); continue; }
          try {
            if (tool === "finance_bill") {
              const current = (await finance.readForConversation()).data.financeBillPlans.find(b => b.id === input.id);
              if (financeValueVersion(current ?? null) !== input.expectedVersion) throw new Error("finance_version_conflict");
            }
            if (input.action === "delete") results.push({ status: "completed", deletion: await finance.deleteConversationRecord(record.entry.id, record.version) });
            else results.push({ status: "completed", record: recordView(await finance.patchConversationRecord(record.entry.id, record.version, patch!)) });
          } catch (error) {
            const reason = error instanceof Error ? error.message : "finance_write_failed";
            results.push({ id: record.entry.id, status: reason === "finance_version_conflict" || reason === "finance_record_not_found" ? "failed" : "uncertain", reason });
          }
        }
        return { results };
      };
    } else if (tool === "finance_budget") {
      const before = financeBudgetSnapshot(state.data, scope), patch = budgetPatch(input);
      if (before.version !== input.expectedVersion) throw new Error("finance_version_conflict");
      if (!before.budget && patch.totalCents === undefined) throw new Error("finance_budget_total_unset");
      const allocations = { ...before.budget?.allocations, ...patch.allocations };
      for (const [name, delta] of Object.entries(patch.deltas ?? {})) {
        if (!Object.hasOwn(allocations, name)) throw new Error("finance_category_budget_unset");
        if (Object.hasOwn(patch.allocations ?? {}, name)) throw new Error("finance_duplicate_allocation_change");
        allocations[name] += delta;
      }
      try { validateBudget({ month: scope === "default" ? "2000-01" : scope, totalCents: patch.totalCents ?? before.budget!.totalCents, allocations }); }
      catch (error) { throw new Error(`finance_budget_invalid:${error instanceof Error ? error.message : error}`); }
      const afterBudget = { ...before.budget, totalCents: patch.totalCents ?? before.budget!.totalCents, allocations, ...(scope !== "default" ? { month: scope } : {}) };
      target = { domain: "finance", budgetScope: scope }; targetVersion = { kind: "budget", scope, beforeVersion: before.version, expectedBudget: afterBudget };
      preview = { action: "update", before, patch };
      business = { action: "update", scope, patch };
      apply = () => finance.patchConversationBudget(scope, before.version, patch);
    } else {
      const id = input.action === "create" ? `bill-${sha256Hex(operationSeed)}` : input.id!;
      const before = state.data.financeBillPlans.find(b => b.id === id) ?? null;
      if (input.action === "update" && !before) throw new Error("finance_bill_not_found");
      const version = input.action === "create" ? financeValueVersion(null) : input.expectedVersion!;
      if (financeValueVersion(before) !== version) throw new Error("finance_version_conflict");
      const patch = { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.budgetCents !== undefined ? { budgetCents: input.budgetCents } : {}), ...(input.allocations ? { allocations: input.allocations } : {}) };
      if (patch.name !== undefined) patch.name = patch.name.trim();
      try { validateFinanceBillPlan({ ...before, ...patch, id, allocations: { ...before?.allocations, ...patch.allocations } } as FinanceBillPlan); }
      catch (error) { throw new Error(`finance_bill_invalid:${error instanceof Error ? error.message : error}`); }
      target = { domain: "finance", billId: id }; targetVersion = { kind: "bill", billId: id, beforeVersion: version, expectedBill: { ...before, ...patch, id, allocations: { ...before?.allocations, ...patch.allocations } } }; preview = { action: input.action, before, patch, id };
      business = { action: input.action, ...(input.action === "update" ? { id } : {}), ...patch, ...(input.action === "create" ? { allocations: patch.allocations ?? {} } : {}) };
      apply = () => finance.writeConversationBill(input.action as "create" | "update", id, version, patch);
    }
    return { effect, target: json(target), targetVersion: json(targetVersion), preview: json(preview), effectArgumentsSha256: financeValueVersion(business),
      execute: async (executionSignal, onEffectStarted): Promise<ObsidianCliResult> => {
        if (executionSignal?.aborted) return { available: true, engine: "echoink-finance-service", command, status: "cancelled" };
        await finance.readForConversation();
        if (effect === "read") return { available: true, engine: "echoink-finance-service", command, status: "completed", data: json(read) };
        await onEffectStarted?.();
        try {
          const data = await apply!();
          const results = (data as { results?: { status: string }[] }).results;
          const verified = !results || results.every(r => r.status === "completed");
          const noEffectVerified = !!results?.length && results.every(r => r.status === "failed" || r.status === "cancelled");
          return { available: true, engine: "echoink-finance-service", command, status: verified ? "completed" : noEffectVerified ? "failed" : "uncertain", readbackVerified: verified, noEffectVerified,
            data: json(data), observedTargetVersion: json(data) };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "finance_write_failed";
          return { available: true, engine: "echoink-finance-service", command, status: reason === "finance_version_conflict" ? "failed" : "uncertain", noEffectVerified: reason === "finance_version_conflict", reason };
        }
      } };
  };
}

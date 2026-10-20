import type { JsonValue } from "../harness/pi-native/json-value-core";
import { normalizeJsonValue } from "../harness/pi-native/json-value-core";
import { isFinanceTool, type PiFinanceToolId } from "../harness/pi-native/finance-tool-policy";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import { financeBudgetSnapshot, financeValueVersion } from "../lifestyle/finance-operation-types";

export interface MobileFinanceEvidence { tool: PiFinanceToolId; action: string; targetVersion: JsonValue; observedHash?: string }
export interface MobileFinanceObservation {
  hash: string; matches: boolean;
  records?: { id: string; path: string; version: string }[];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
/** A later completed receipt may supersede only the exact version observed by its predecessor. */
export function mobileFinanceReceiptFollows(previous: MobileFinanceEvidence, next: MobileFinanceEvidence, currentRecords: MobileFinanceObservation["records"] = []): boolean {
  if (!hash(previous.observedHash)) return false;
  const before = object(previous.targetVersion), after = object(next.targetVersion);
  if (before.kind === "budget" && after.kind === "budget") return before.scope === after.scope && previous.observedHash === after.beforeVersion;
  if (before.kind === "bill" && after.kind === "bill") return before.billId === after.billId && previous.observedHash === after.beforeVersion;
  if ((before.kind !== "record-create" && before.kind !== "record-update") || (after.kind !== "record-update" && after.kind !== "record-delete") || !Array.isArray(after.records)) return false;
  const prior = before.kind === "record-create" ? [{ id: before.recordId }] : Array.isArray(before.records) ? before.records.map(object) : [];
  if (!prior.length) return false;
  const following = after.records.map(object), versions: { id: unknown; version: unknown }[] = [];
  let continued = false;
  for (const row of prior) {
    const matches = following.filter(candidate => candidate.id === row.id && (!("path" in row) || candidate.path === row.path));
    if (matches.length > 1) return false;
    const unchanged = currentRecords.filter(candidate => candidate.id === row.id && candidate.path === row.path);
    const version = matches.length ? matches[0].version : unchanged.length === 1 ? unchanged[0].version : undefined;
    if (!hash(version)) return false;
    continued ||= matches.length === 1;
    versions.push({ id: row.id, version });
  }
  // A partial successor must leave every other record at its exact observed version.
  // The original aggregate receipt proves the complete reconstructed set together.
  return continued && previous.observedHash === financeValueVersion(before.kind === "record-create" ? versions[0] : versions);
}
export function validMobileFinanceEvidence(value: unknown, status: unknown, expectedHash: unknown): value is MobileFinanceEvidence {
  const evidence = object(value), target = object(evidence.targetVersion);
  if (Object.keys(evidence).some(key => !["tool", "action", "targetVersion", "observedHash"].includes(key)) || !isFinanceTool(String(evidence.tool))
    || typeof evidence.action !== "string" || !["create", "update", "delete", "associate"].includes(evidence.action)
    || !["record-create", "record-update", "record-delete", "budget", "bill"].includes(String(target.kind))
    || (status === "completed" ? !hash(evidence.observedHash) : evidence.observedHash !== undefined)) return false;
  const identity = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 1024 && !/[\p{Cc}]/u.test(value);
  const entry = (value: unknown, id: unknown) => { const row = object(value); return identity(id) && row.id === id && identity(row.category)
    && Number.isSafeInteger(row.amountCents) && Number(row.amountCents) > 0 && ["expense", "income", "refund", "transfer"].includes(String(row.kind)); };
  if (target.kind === "record-create") {
    if (evidence.tool !== "finance_record" || evidence.action !== "create" || target.absent !== true || !entry(target.expectedEntry, target.recordId)
      || Object.keys(target).some(key => !["kind", "absent", "recordId", "expectedEntry"].includes(key))) return false;
  } else if (target.kind === "record-update" || target.kind === "record-delete") {
    if (!(evidence.tool === "finance_record" && evidence.action === (target.kind === "record-delete" ? "delete" : "update") || evidence.tool === "finance_bill" && evidence.action === "associate" && target.kind === "record-update")
      || !Array.isArray(target.records) || !target.records.length || target.records.length > 50
      || Object.keys(target).some(key => !["kind", "records", "billId", "billVersion"].includes(key))) return false;
    const ids = new Set<string>();
    for (const value of target.records) {
      const row = object(value);
      if (!identity(row.id) || ids.has(row.id) || !identity(row.path) || !hash(row.version)
        || Object.keys(row).some(key => !["id", "path", "version", "expectedEntry"].includes(key))
        || (target.kind === "record-update" ? !entry(row.expectedEntry, row.id) : row.expectedEntry !== undefined)) return false;
      ids.add(row.id);
    }
    if (evidence.tool === "finance_bill" ? !identity(target.billId) || !hash(target.billVersion) : target.billId !== undefined || target.billVersion !== undefined) return false;
  } else if (target.kind === "budget") {
    if (evidence.tool !== "finance_budget" || evidence.action !== "update" || !(target.scope === "default" || /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(String(target.scope)))
      || !hash(target.beforeVersion) || !Number.isSafeInteger(object(target.expectedBudget).totalCents)
      || Object.keys(target).some(key => !["kind", "scope", "beforeVersion", "expectedBudget"].includes(key))) return false;
  } else if (evidence.tool !== "finance_bill" || !["create", "update"].includes(evidence.action) || !identity(target.billId)
    || !hash(target.beforeVersion) || object(target.expectedBill).id !== target.billId || !Number.isSafeInteger(object(target.expectedBill).budgetCents)
    || Object.keys(target).some(key => !["kind", "billId", "beforeVersion", "expectedBill"].includes(key))) return false;
  try { normalizeJsonValue(evidence.targetVersion); return expectedHash === financeValueVersion(evidence.targetVersion); } catch { return false; }
}
/** Exact observed Markdown versions for records, canonical values for local budgets/bills. */
export async function mobileFinanceObservation(finance: LifestyleFinanceService | undefined, evidence: MobileFinanceEvidence): Promise<MobileFinanceObservation> {
  if (!finance) return { hash: "unreadable", matches: false };
  try {
    const state = await finance.readForConversation(), target = object(evidence.targetVersion);
    const equal = (current: unknown, expected: unknown) => {
      const found = object(current); return current != null && Object.entries(object(expected)).every(([key, value]) => financeValueVersion(found[key] ?? null) === financeValueVersion(value));
    };
    if (target.kind === "record-create") {
      const row = state.records.find(item => item.entry.id === target.recordId);
      return { hash: financeValueVersion(row ? { id: row.entry.id, version: row.version } : null), matches: !!row && equal(row.entry, target.expectedEntry) };
    }
    if (target.kind === "record-update" || target.kind === "record-delete") {
      const targets = Array.isArray(target.records) ? target.records.map(object) : [];
      const rows = targets.map(item => state.records.find(row => row.entry.id === item.id));
      return { hash: financeValueVersion(rows.map((row, index) => ({ id: targets[index].id, version: row?.version ?? "missing" }))),
        records: rows.flatMap(row => row ? [{ id: row.entry.id, path: row.path, version: row.version }] : []),
        matches: targets.length > 0 && rows.every((row, index) => target.kind === "record-delete" ? !row : !!row && equal(row.entry, targets[index].expectedEntry)) };
    }
    if (target.kind === "budget") {
      const budget = financeBudgetSnapshot(state.data, String(target.scope));
      return { hash: budget.version, matches: equal(budget.budget, target.expectedBudget) };
    }
    const bill = state.data.financeBillPlans.find(item => item.id === target.billId);
    return { hash: financeValueVersion(bill ?? null), matches: !!bill && equal(bill, target.expectedBill) };
  } catch { return { hash: "unreadable", matches: false }; }
}

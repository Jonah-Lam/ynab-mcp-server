import type {
  Account,
  Category,
  MonthSummary,
  ScheduledTransaction,
  SubTransaction,
  Transaction,
} from "./types";

/** YNAB milliunits → currency units (e.g. -12340 → -12.34). */
export function fromMilli(milliunits: number): number {
  return milliunits / 1000;
}

/** Currency units → YNAB milliunits, rounded to the nearest milliunit. */
export function toMilli(amount: number): number {
  return Math.round(amount * 1000);
}

function optMilli(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : fromMilli(value);
}

/** Drop null/undefined/empty-string fields to keep tool output compact. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function formatAccount(a: Account) {
  return compact({
    id: a.id,
    name: a.name,
    type: a.type,
    on_budget: a.on_budget,
    closed: a.closed || undefined,
    balance: fromMilli(a.balance),
    cleared_balance: fromMilli(a.cleared_balance),
    uncleared_balance: fromMilli(a.uncleared_balance),
    last_reconciled_at: a.last_reconciled_at,
    transfer_payee_id: a.transfer_payee_id,
    note: a.note,
  });
}

export function formatCategory(c: Category) {
  const goal = c.goal_type
    ? compact({
        type: c.goal_type,
        target: optMilli(c.goal_target),
        target_date: c.goal_target_date ?? c.goal_target_month,
        percentage_complete: c.goal_percentage_complete,
        under_funded: optMilli(c.goal_under_funded),
        overall_left: optMilli(c.goal_overall_left),
      })
    : undefined;
  return compact({
    id: c.id,
    name: c.name,
    group: c.category_group_name,
    hidden: c.hidden || undefined,
    assigned: fromMilli(c.budgeted),
    activity: fromMilli(c.activity),
    available: fromMilli(c.balance),
    goal,
    note: c.note,
  });
}

function formatSub(s: SubTransaction) {
  return compact({
    id: s.id,
    amount: fromMilli(s.amount),
    payee: s.payee_name,
    payee_id: s.payee_id,
    category: s.category_name,
    category_id: s.category_id,
    memo: s.memo,
    transfer_account_id: s.transfer_account_id,
  });
}

export function formatTransaction(t: Transaction) {
  return compact({
    id: t.id,
    date: t.date,
    amount: fromMilli(t.amount),
    payee: t.payee_name,
    payee_id: t.payee_id,
    category: t.category_name,
    category_id: t.category_id,
    account: t.account_name,
    account_id: t.account_id,
    memo: t.memo,
    cleared: t.cleared,
    approved: t.approved,
    flag: t.flag_name || t.flag_color,
    transfer_account_id: t.transfer_account_id,
    parent_transaction_id: t.parent_transaction_id,
    subtransactions: t.subtransactions?.filter((s) => !s.deleted).map(formatSub),
  });
}

export function formatScheduled(s: ScheduledTransaction) {
  return compact({
    id: s.id,
    next_date: s.date_next,
    first_date: s.date_first,
    frequency: s.frequency,
    amount: fromMilli(s.amount),
    payee: s.payee_name,
    payee_id: s.payee_id,
    category: s.category_name,
    category_id: s.category_id,
    account: s.account_name,
    account_id: s.account_id,
    memo: s.memo,
    flag: s.flag_color,
    transfer_account_id: s.transfer_account_id,
  });
}

export function formatMonth(m: MonthSummary) {
  return compact({
    month: m.month,
    income: fromMilli(m.income),
    assigned: fromMilli(m.budgeted),
    activity: fromMilli(m.activity),
    ready_to_assign: fromMilli(m.to_be_budgeted),
    age_of_money: m.age_of_money,
    note: m.note,
  });
}

/** Normalises "2026-09", "2026-09-15" or "current" to YNAB's month format ("2026-09-01" / "current"). */
export function normalizeMonth(input: string | undefined): string {
  if (!input || input === "current") return "current";
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(input.trim());
  if (!match) throw new Error(`Invalid month "${input}". Use YYYY-MM or "current".`);
  return `${match[1]}-${match[2]}-01`;
}

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { seg } from "../ynab/client";
import {
  formatAccount,
  formatCategory,
  formatMonth,
  formatScheduled,
  formatTransaction,
  fromMilli,
  normalizeMonth,
} from "../ynab/format";
import type {
  Account,
  Category,
  MonthDetail,
  MonthSummary,
  MoneyMovement,
  Payee,
  PlanSummary,
  ScheduledTransaction,
  Transaction,
} from "../ynab/types";
import {
  READ_ONLY,
  isoDate,
  monthSchema,
  planIdSchema,
  planPath,
  run,
  transactionId,
  uuid,
  type ToolContext,
} from "./common";

export async function fetchMonth(ctx: ToolContext, planId: string | undefined, month: string | undefined) {
  const { month: detail } = await ctx.ynab.get<{ month: MonthDetail }>(
    `${planPath(ctx, planId)}/months/${seg(normalizeMonth(month))}`,
  );
  return detail;
}

export function groupCategories(categories: Category[], includeHidden: boolean) {
  const groups = new Map<string, ReturnType<typeof formatCategory>[]>();
  for (const c of categories) {
    if (c.deleted || (c.hidden && !includeHidden)) continue;
    const group = c.category_group_name ?? "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(formatCategory(c));
  }
  return [...groups].map(([name, cats]) => ({ group: name, categories: cats }));
}

export function registerReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_plans",
    {
      title: "List plans",
      description:
        "List the YNAB plans (budgets) the user has, with their IDs and currency. Most tools default to the last-used plan, so this is only needed when the user has several plans.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const { plans, default_plan } = await ctx.ynab.get<{ plans: PlanSummary[]; default_plan?: PlanSummary | null }>("/plans");
        return {
          default_plan_id: default_plan?.id,
          plans: plans.map((p) => ({
            id: p.id,
            name: p.name,
            currency: p.currency_format?.iso_code,
            last_modified_on: p.last_modified_on,
            first_month: p.first_month,
            last_month: p.last_month,
          })),
        };
      }),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List accounts with current, cleared and uncleared balances. on_budget=false means a tracking account. transfer_payee_id is the payee to use when creating a transfer INTO that account.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        include_closed: z.boolean().default(false).describe("Include closed accounts"),
      }),
      annotations: READ_ONLY,
    },
    ({ plan_id, include_closed }) =>
      run(async () => {
        const { accounts } = await ctx.ynab.get<{ accounts: Account[] }>(`${planPath(ctx, plan_id)}/accounts`);
        const visible = accounts.filter((a) => !a.deleted && (include_closed || !a.closed));
        const onBudget = visible.filter((a) => a.on_budget && !a.closed);
        return {
          total_on_budget_balance: fromMilli(onBudget.reduce((sum, a) => sum + a.balance, 0)),
          accounts: visible.map(formatAccount),
        };
      }),
  );

  server.registerTool(
    "get_budget_month",
    {
      title: "Get budget month",
      description:
        "Get the budget for one month: Ready to Assign, income, total assigned and activity, plus every category grouped by category group with assigned, activity, available and target (goal) progress. Use this to answer 'how much is left in X', 'am I overspent', or to find category IDs.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        month: monthSchema,
        include_hidden: z.boolean().default(false).describe("Include hidden categories"),
      }),
      annotations: READ_ONLY,
    },
    ({ plan_id, month, include_hidden }) =>
      run(async () => {
        const detail = await fetchMonth(ctx, plan_id, month);
        const overspent = detail.categories
          .filter((c) => !c.deleted && c.balance < 0)
          .map((c) => ({ id: c.id, name: c.name, available: fromMilli(c.balance) }));
        return {
          ...formatMonth(detail),
          overspent_categories: overspent,
          category_groups: groupCategories(detail.categories, include_hidden),
        };
      }),
  );

  server.registerTool(
    "list_months",
    {
      title: "List budget months",
      description:
        "List month-by-month summaries (income, assigned, activity, Ready to Assign, age of money). Useful for trends over time.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        from_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Earliest month to include, YYYY-MM"),
        to_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Latest month to include, YYYY-MM"),
      }),
      annotations: READ_ONLY,
    },
    ({ plan_id, from_month, to_month }) =>
      run(async () => {
        const { months } = await ctx.ynab.get<{ months: MonthSummary[] }>(`${planPath(ctx, plan_id)}/months`);
        return months
          .filter((m) => !m.deleted)
          .filter((m) => !from_month || m.month >= `${from_month}-01`)
          .filter((m) => !to_month || m.month <= `${to_month}-01`)
          .sort((a, b) => a.month.localeCompare(b.month))
          .map(formatMonth);
      }),
  );

  server.registerTool(
    "list_payees",
    {
      title: "List payees",
      description: "List payees, optionally filtered by name. Transfer payees (transfer_account_id set) represent transfers to that account.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        name_contains: z.string().max(200).optional().describe("Case-insensitive name filter"),
      }),
      annotations: READ_ONLY,
    },
    ({ plan_id, name_contains }) =>
      run(async () => {
        const { payees } = await ctx.ynab.get<{ payees: Payee[] }>(`${planPath(ctx, plan_id)}/payees`);
        const needle = name_contains?.toLowerCase();
        return payees
          .filter((p) => !p.deleted && (!needle || p.name.toLowerCase().includes(needle)))
          .map((p) => ({ id: p.id, name: p.name, ...(p.transfer_account_id ? { transfer_account_id: p.transfer_account_id } : {}) }));
      }),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List transactions, newest first. Filter by account, category, payee, month, date range, text, or type (unapproved / uncategorized). Amounts are in currency units; negative = outflow. Without since_date or month, YNAB returns roughly the last year.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        account_id: uuid("account").optional(),
        category_id: uuid("category").optional(),
        payee_id: uuid("payee").optional(),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Only transactions in this month, YYYY-MM"),
        since_date: isoDate.optional().describe("Only transactions on or after this date"),
        until_date: isoDate.optional().describe("Only transactions on or before this date"),
        type: z.enum(["unapproved", "uncategorized"]).optional(),
        text: z.string().max(200).optional().describe("Case-insensitive match on payee, memo or category name"),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const base = planPath(ctx, args.plan_id);
        // Pick the most specific endpoint; remaining filters are applied locally.
        let path = `${base}/transactions`;
        if (args.account_id) path = `${base}/accounts/${seg(args.account_id)}/transactions`;
        else if (args.category_id) path = `${base}/categories/${seg(args.category_id)}/transactions`;
        else if (args.payee_id) path = `${base}/payees/${seg(args.payee_id)}/transactions`;
        else if (args.month) path = `${base}/months/${seg(`${args.month}-01`)}/transactions`;

        const since = args.since_date ?? (args.month ? `${args.month}-01` : undefined);
        const { transactions } = await ctx.ynab.get<{ transactions: Transaction[] }>(path, {
          since_date: since,
          until_date: args.until_date,
          type: args.type,
        });

        const needle = args.text?.toLowerCase();
        const matches = transactions.filter((t) => {
          if (t.deleted) return false;
          if (args.account_id && t.account_id !== args.account_id) return false;
          if (args.category_id && t.category_id !== args.category_id) return false;
          if (args.payee_id && t.payee_id !== args.payee_id) return false;
          if (args.month && !t.date.startsWith(args.month)) return false;
          if (args.until_date && t.date > args.until_date) return false;
          if (needle) {
            const hay = [t.payee_name, t.memo, t.category_name].filter(Boolean).join(" ").toLowerCase();
            if (!hay.includes(needle)) return false;
          }
          return true;
        });
        matches.sort((a, b) => b.date.localeCompare(a.date));
        const page = matches.slice(0, args.limit);
        const outflow = matches.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
        const inflow = matches.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
        return {
          total_matching: matches.length,
          returned: page.length,
          truncated: matches.length > page.length,
          total_outflow: fromMilli(outflow),
          total_inflow: fromMilli(inflow),
          transactions: page.map(formatTransaction),
        };
      }),
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description: "Get one transaction by ID, including split subtransactions.",
      inputSchema: z.object({ plan_id: planIdSchema, transaction_id: transactionId }),
      annotations: READ_ONLY,
    },
    ({ plan_id, transaction_id }) =>
      run(async () => {
        const { transaction } = await ctx.ynab.get<{ transaction: Transaction }>(
          `${planPath(ctx, plan_id)}/transactions/${seg(transaction_id)}`,
        );
        return formatTransaction(transaction);
      }),
  );

  server.registerTool(
    "list_scheduled_transactions",
    {
      title: "List scheduled transactions",
      description: "List upcoming and recurring scheduled transactions, soonest first.",
      inputSchema: z.object({ plan_id: planIdSchema }),
      annotations: READ_ONLY,
    },
    ({ plan_id }) =>
      run(async () => {
        const { scheduled_transactions } = await ctx.ynab.get<{ scheduled_transactions: ScheduledTransaction[] }>(
          `${planPath(ctx, plan_id)}/scheduled_transactions`,
        );
        return scheduled_transactions
          .filter((s) => !s.deleted)
          .sort((a, b) => a.date_next.localeCompare(b.date_next))
          .map(formatScheduled);
      }),
  );

  server.registerTool(
    "list_money_movements",
    {
      title: "List money movements",
      description:
        "List money moved between categories (or to/from Ready to Assign) in a month, with category names. A missing from/to category means Ready to Assign.",
      inputSchema: z.object({ plan_id: planIdSchema, month: monthSchema }),
      annotations: READ_ONLY,
    },
    ({ plan_id, month }) =>
      run(async () => {
        const base = planPath(ctx, plan_id);
        const m = normalizeMonth(month);
        const [{ money_movements }, detail] = await Promise.all([
          ctx.ynab.get<{ money_movements: MoneyMovement[] }>(`${base}/months/${seg(m)}/money_movements`),
          fetchMonth(ctx, plan_id, m),
        ]);
        const names = new Map(detail.categories.map((c) => [c.id, c.name]));
        const label = (id?: string | null) => (id ? (names.get(id) ?? id) : "Ready to Assign");
        return money_movements.map((mm) => ({
          id: mm.id,
          moved_at: mm.moved_at,
          from: label(mm.from_category_id),
          to: label(mm.to_category_id),
          amount: fromMilli(mm.amount),
          ...(mm.note ? { note: mm.note } : {}),
        }));
      }),
  );
}

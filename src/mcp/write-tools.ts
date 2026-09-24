import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { seg } from "../ynab/client";
import { formatCategory, formatScheduled, formatTransaction, fromMilli, normalizeMonth, toMilli } from "../ynab/format";
import type { Category, Payee, ScheduledTransaction, Transaction } from "../ynab/types";
import {
  DESTRUCTIVE,
  WRITE,
  WRITE_IDEMPOTENT,
  amountSchema,
  flagColor,
  isoDate,
  monthSchema,
  planIdSchema,
  planPath,
  run,
  transactionId,
  uuid,
  type ToolContext,
} from "./common";
import { fetchMonth } from "./read-tools";

const memo = z.string().max(500).nullable().optional();
const payeeName = z
  .string()
  .max(200)
  .nullable()
  .optional()
  .describe("Payee name; used when payee_id is not given. Matches an existing payee or creates a new one.");

const subtransaction = z.object({
  amount: amountSchema,
  payee_id: uuid("payee").nullable().optional(),
  payee_name: payeeName,
  category_id: uuid("category").nullable().optional(),
  memo,
});

const transactionFields = {
  account_id: uuid("account"),
  date: isoDate.describe("Transaction date, YYYY-MM-DD. Future dates are not allowed."),
  amount: amountSchema,
  payee_id: uuid("payee")
    .nullable()
    .optional()
    .describe("Payee ID. For a transfer, use the target account's transfer_payee_id from list_accounts."),
  payee_name: payeeName,
  category_id: uuid("category")
    .nullable()
    .optional()
    .describe("Category ID from get_budget_month. For income, use the 'Inflow: Ready to Assign' category."),
  memo,
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional(),
  approved: z.boolean().optional().describe("Defaults to true for transactions created through this server."),
  flag_color: flagColor.optional(),
};

type SubInput = z.infer<typeof subtransaction>;

function toSaveSub(s: SubInput) {
  return { ...s, amount: toMilli(s.amount) };
}

/** Converts tool input (currency units) to a YNAB save payload (milliunits). */
function toSaveTransaction<T extends { amount?: number; subtransactions?: SubInput[] }>(t: T) {
  const out: Record<string, unknown> = { ...t };
  if (t.amount !== undefined) out.amount = toMilli(t.amount);
  if (t.subtransactions) out.subtransactions = t.subtransactions.map(toSaveSub);
  return out;
}

export function registerWriteTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "create_transactions",
    {
      title: "Create transactions",
      description:
        "Create one or more transactions. Amounts are in currency units: negative for spending, positive for income. For a split, set category_id to null and pass subtransactions whose amounts sum to the total.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        transactions: z
          .array(z.object({ ...transactionFields, subtransactions: z.array(subtransaction).max(50).optional() }))
          .min(1)
          .max(100),
      }),
      annotations: WRITE,
    },
    ({ plan_id, transactions }) =>
      run(async () => {
        const payload = transactions.map((t) => toSaveTransaction({ ...t, approved: t.approved ?? true }));
        const res = await ctx.ynab.post<{ transactions?: Transaction[]; duplicate_import_ids?: string[] }>(
          `${planPath(ctx, plan_id)}/transactions`,
          { transactions: payload },
        );
        return {
          created: (res.transactions ?? []).map(formatTransaction),
          ...(res.duplicate_import_ids?.length ? { duplicate_import_ids: res.duplicate_import_ids } : {}),
        };
      }),
  );

  server.registerTool(
    "update_transactions",
    {
      title: "Update transactions",
      description:
        "Update one or more existing transactions. Only the fields you pass are changed. Common uses: categorize, approve, fix the amount, payee or memo, set cleared status or flag. The date and amount of split transactions cannot be changed.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        transactions: z
          .array(
            z.object({
              id: transactionId,
              account_id: transactionFields.account_id.optional(),
              date: transactionFields.date.optional(),
              amount: amountSchema.optional(),
              payee_id: transactionFields.payee_id,
              payee_name: payeeName,
              category_id: transactionFields.category_id,
              memo,
              cleared: transactionFields.cleared,
              approved: z.boolean().optional(),
              flag_color: transactionFields.flag_color,
            }),
          )
          .min(1)
          .max(100),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    ({ plan_id, transactions }) =>
      run(async () => {
        const res = await ctx.ynab.patch<{ transactions?: Transaction[] }>(`${planPath(ctx, plan_id)}/transactions`, {
          transactions: transactions.map(toSaveTransaction),
        });
        return { updated: (res.transactions ?? []).map(formatTransaction) };
      }),
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete transaction",
      description: "Permanently delete a transaction. Confirm with the user before calling this.",
      inputSchema: z.object({ plan_id: planIdSchema, transaction_id: transactionId }),
      annotations: DESTRUCTIVE,
    },
    ({ plan_id, transaction_id }) =>
      run(async () => {
        const { transaction } = await ctx.ynab.delete<{ transaction: Transaction }>(
          `${planPath(ctx, plan_id)}/transactions/${seg(transaction_id)}`,
        );
        return { deleted: formatTransaction(transaction) };
      }),
  );

  server.registerTool(
    "set_category_assigned",
    {
      title: "Set assigned amount",
      description:
        "Set the total amount assigned (budgeted) to a category for a month. This replaces the current assigned amount; it does not add to it. To shift money between categories use move_money.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        category_id: uuid("category"),
        month: monthSchema,
        assigned: z.number().finite().describe("New total assigned amount for the month, in currency units"),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    ({ plan_id, category_id, month, assigned }) =>
      run(async () => {
        const { category } = await ctx.ynab.patch<{ category: Category }>(
          `${planPath(ctx, plan_id)}/months/${seg(normalizeMonth(month))}/categories/${seg(category_id)}`,
          { category: { budgeted: toMilli(assigned) } },
        );
        return formatCategory(category);
      }),
  );

  server.registerTool(
    "move_money",
    {
      title: "Move money between categories",
      description:
        "Move an amount of assigned money from one category to another in a month (like YNAB's Move Money). Omit from_category_id to assign from Ready to Assign; omit to_category_id to return money to Ready to Assign.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        month: monthSchema,
        amount: z.number().finite().positive().describe("Positive amount to move, in currency units"),
        from_category_id: uuid("category").optional(),
        to_category_id: uuid("category").optional(),
      }),
      annotations: WRITE,
    },
    ({ plan_id, month, amount, from_category_id, to_category_id }) =>
      run(async () => {
        if (!from_category_id && !to_category_id) throw new Error("Give from_category_id, to_category_id, or both.");
        if (from_category_id === to_category_id) throw new Error("from and to categories must differ.");
        const m = normalizeMonth(month);
        const detail = await fetchMonth(ctx, plan_id, m);
        const byId = new Map(detail.categories.map((c) => [c.id, c]));
        const delta = toMilli(amount);
        const updates: { id: string; budgeted: number }[] = [];
        for (const [id, sign] of [
          [from_category_id, -1],
          [to_category_id, 1],
        ] as const) {
          if (!id) continue;
          const cat = byId.get(id);
          if (!cat) throw new Error(`Category ${id} not found in ${detail.month}.`);
          updates.push({ id, budgeted: cat.budgeted + sign * delta });
        }
        const results: Category[] = [];
        for (const u of updates) {
          const { category } = await ctx.ynab.patch<{ category: Category }>(
            `${planPath(ctx, plan_id)}/months/${seg(m)}/categories/${seg(u.id)}`,
            { category: { budgeted: u.budgeted } },
          );
          results.push(category);
        }
        return { month: detail.month, moved: fromMilli(delta), categories: results.map(formatCategory) };
      }),
  );

  server.registerTool(
    "update_category",
    {
      title: "Update category",
      description:
        "Rename a category, change its note, move it to another group, or set/remove its target. goal_target is in currency units; pass null to remove the target.",
      inputSchema: z.object({
        plan_id: planIdSchema,
        category_id: uuid("category"),
        name: z.string().min(1).max(100).optional(),
        note: z.string().max(500).nullable().optional(),
        category_group_id: uuid("category group").optional(),
        goal_target: z.number().finite().nonnegative().nullable().optional(),
        goal_target_date: isoDate.nullable().optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    ({ plan_id, category_id, goal_target, ...fields }) =>
      run(async () => {
        const body: Record<string, unknown> = { ...fields };
        if (goal_target !== undefined) body.goal_target = goal_target === null ? null : toMilli(goal_target);
        const { category } = await ctx.ynab.patch<{ category: Category }>(
          `${planPath(ctx, plan_id)}/categories/${seg(category_id)}`,
          { category: body },
        );
        return formatCategory(category);
      }),
  );

  server.registerTool(
    "create_category",
    {
      title: "Create category",
      description: "Create a new category in an existing category group (find group IDs via get_budget_month).",
      inputSchema: z.object({
        plan_id: planIdSchema,
        name: z.string().min(1).max(100),
        category_group_id: uuid("category group"),
        note: z.string().max(500).optional(),
        goal_target: z.number().finite().nonnegative().optional().describe("Optional monthly target, currency units"),
      }),
      annotations: WRITE,
    },
    ({ plan_id, goal_target, ...fields }) =>
      run(async () => {
        const body: Record<string, unknown> = { ...fields };
        if (goal_target !== undefined) body.goal_target = toMilli(goal_target);
        const { category } = await ctx.ynab.post<{ category: Category }>(`${planPath(ctx, plan_id)}/categories`, {
          category: body,
        });
        return formatCategory(category);
      }),
  );

  server.registerTool(
    "rename_payee",
    {
      title: "Rename payee",
      description: "Rename a payee.",
      inputSchema: z.object({ plan_id: planIdSchema, payee_id: uuid("payee"), name: z.string().min(1).max(500) }),
      annotations: WRITE_IDEMPOTENT,
    },
    ({ plan_id, payee_id, name }) =>
      run(async () => {
        const { payee } = await ctx.ynab.patch<{ payee: Payee }>(`${planPath(ctx, plan_id)}/payees/${seg(payee_id)}`, {
          payee: { name },
        });
        return { id: payee.id, name: payee.name };
      }),
  );

  server.registerTool(
    "create_scheduled_transaction",
    {
      title: "Create scheduled transaction",
      description: "Create an upcoming or recurring scheduled transaction. The date must be in the future (up to 5 years).",
      inputSchema: z.object({
        plan_id: planIdSchema,
        account_id: uuid("account"),
        date: isoDate.describe("First occurrence, YYYY-MM-DD, in the future"),
        frequency: z
          .enum([
            "never",
            "daily",
            "weekly",
            "everyOtherWeek",
            "twiceAMonth",
            "every4Weeks",
            "monthly",
            "everyOtherMonth",
            "every3Months",
            "every4Months",
            "twiceAYear",
            "yearly",
            "everyOtherYear",
          ])
          .default("never")
          .describe('"never" means a one-off future transaction'),
        amount: amountSchema,
        payee_id: transactionFields.payee_id,
        payee_name: payeeName,
        category_id: transactionFields.category_id,
        memo,
        flag_color: flagColor.optional(),
      }),
      annotations: WRITE,
    },
    ({ plan_id, ...fields }) =>
      run(async () => {
        const { scheduled_transaction } = await ctx.ynab.post<{ scheduled_transaction: ScheduledTransaction }>(
          `${planPath(ctx, plan_id)}/scheduled_transactions`,
          { scheduled_transaction: { ...fields, amount: toMilli(fields.amount) } },
        );
        return formatScheduled(scheduled_transaction);
      }),
  );

  server.registerTool(
    "delete_scheduled_transaction",
    {
      title: "Delete scheduled transaction",
      description: "Permanently delete a scheduled transaction. Confirm with the user before calling this.",
      inputSchema: z.object({ plan_id: planIdSchema, scheduled_transaction_id: uuid("scheduled transaction") }),
      annotations: DESTRUCTIVE,
    },
    ({ plan_id, scheduled_transaction_id }) =>
      run(async () => {
        const { scheduled_transaction } = await ctx.ynab.delete<{ scheduled_transaction: ScheduledTransaction }>(
          `${planPath(ctx, plan_id)}/scheduled_transactions/${seg(scheduled_transaction_id)}`,
        );
        return { deleted: formatScheduled(scheduled_transaction) };
      }),
  );
}

import { describe, expect, test } from "bun:test";
import { fakeYnab, mcpClient } from "./helpers";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const GROCERIES = "22222222-2222-4222-8222-222222222222";
const DINING = "33333333-3333-4333-8333-333333333333";

const category = (id: string, name: string, budgeted: number, balance: number, extra = {}) => ({
  id,
  name,
  category_group_id: "g1",
  category_group_name: "Everyday",
  hidden: false,
  deleted: false,
  budgeted,
  activity: balance - budgeted,
  balance,
  ...extra,
});

const tx = (id: string, date: string, amount: number, extra = {}) => ({
  id,
  date,
  amount,
  cleared: "cleared",
  approved: true,
  account_id: ACCOUNT,
  account_name: "Checking",
  payee_name: "Shop",
  category_name: "Groceries",
  category_id: GROCERIES,
  deleted: false,
  subtransactions: [],
  ...extra,
});

describe("tool registration", () => {
  test("read-only grant hides write tools", async () => {
    const { fetchImpl } = fakeYnab({});
    const tools = await mcpClient(fetchImpl, false).listTools();
    expect(tools).toContain("list_transactions");
    expect(tools).toContain("search");
    expect(tools).toContain("fetch");
    expect(tools).not.toContain("create_transactions");
    expect(tools).not.toContain("delete_transaction");
  });

  test("write grant exposes write tools with annotations", async () => {
    const { fetchImpl } = fakeYnab({});
    const client = mcpClient(fetchImpl, true);
    const r = await client.rpc("tools/list");
    const del = r.result.tools.find((t: any) => t.name === "delete_transaction");
    expect(del.annotations.destructiveHint).toBe(true);
    const list = r.result.tools.find((t: any) => t.name === "list_accounts");
    expect(list.annotations.readOnlyHint).toBe(true);
  });
});

describe("read tools", () => {
  test("list_accounts converts milliunits and hides closed/deleted", async () => {
    const { fetchImpl, calls } = fakeYnab({
      "GET /plans/last-used/accounts": {
        accounts: [
          { id: ACCOUNT, name: "Checking", type: "checking", on_budget: true, closed: false, balance: 1234560, cleared_balance: 1000000, uncleared_balance: 234560, deleted: false },
          { id: "a2", name: "Old", type: "savings", on_budget: true, closed: true, balance: 0, cleared_balance: 0, uncleared_balance: 0, deleted: false },
          { id: "a3", name: "Gone", type: "cash", on_budget: true, closed: false, balance: 5000, cleared_balance: 0, uncleared_balance: 0, deleted: true },
        ],
      },
    });
    const { json, isError } = await mcpClient(fetchImpl).call("list_accounts");
    expect(isError).toBe(false);
    expect(calls[0]!.path).toBe("/plans/last-used/accounts");
    expect(json.accounts).toHaveLength(1);
    expect(json.accounts[0].balance).toBe(1234.56);
    expect(json.total_on_budget_balance).toBe(1234.56);
  });

  test("list_transactions uses the category endpoint and filters locally", async () => {
    const { fetchImpl, calls } = fakeYnab({
      [`GET /plans/last-used/categories/${GROCERIES}/transactions`]: {
        transactions: [
          tx("t1", "2026-08-01", -10000),
          tx("t2", "2026-08-15", -25500, { memo: "weekly shop" }),
          tx("t3", "2026-09-02", -5000),
          tx("t4", "2026-08-20", -1000, { deleted: true }),
        ],
      },
    });
    const { json } = await mcpClient(fetchImpl).call("list_transactions", {
      category_id: GROCERIES,
      since_date: "2026-08-01",
      until_date: "2026-08-31",
      limit: 1,
    });
    expect(calls[0]!.query).toEqual({ since_date: "2026-08-01", until_date: "2026-08-31" });
    expect(json.total_matching).toBe(2);
    expect(json.truncated).toBe(true);
    expect(json.transactions[0].id).toBe("t2"); // newest first
    expect(json.transactions[0].amount).toBe(-25.5);
    expect(json.total_outflow).toBe(-35.5);
  });

  test("get_budget_month groups categories and lists overspending", async () => {
    const { fetchImpl, calls } = fakeYnab({
      "GET /plans/last-used/months/2026-09-01": {
        month: {
          month: "2026-09-01",
          income: 5000000,
          budgeted: 4000000,
          activity: -3000000,
          to_be_budgeted: 1000000,
          age_of_money: 40,
          deleted: false,
          categories: [
            category(GROCERIES, "Groceries", 500000, 120000),
            category(DINING, "Dining", 100000, -20000),
            category("h", "Hidden", 0, 0, { hidden: true }),
          ],
        },
      },
    });
    const { json } = await mcpClient(fetchImpl).call("get_budget_month", { month: "2026-09" });
    expect(calls[0]!.path).toBe("/plans/last-used/months/2026-09-01");
    expect(json.ready_to_assign).toBe(1000);
    expect(json.overspent_categories).toEqual([{ id: DINING, name: "Dining", available: -20 }]);
    expect(json.category_groups[0].categories).toHaveLength(2);
  });

  test("YNAB errors are returned as tool errors", async () => {
    const { fetchImpl } = fakeYnab({});
    const { isError, text } = await mcpClient(fetchImpl).call("list_payees");
    expect(isError).toBe(true);
    expect(text).toContain("404");
  });

  test("invalid IDs are rejected before any request", async () => {
    const { fetchImpl, calls } = fakeYnab({});
    const { isError } = await mcpClient(fetchImpl).call("get_transaction", { transaction_id: "../user" });
    expect(isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("search returns ChatGPT-shaped results", async () => {
    const { fetchImpl } = fakeYnab({
      "GET /plans/last-used/accounts": { accounts: [] },
      "GET /plans/last-used/months/current": { month: { categories: [category(GROCERIES, "Groceries", 0, 0)] } },
      "GET /plans/last-used/payees": { payees: [{ id: "p1", name: "Grocer Co", deleted: false }] },
      "GET /plans/last-used/transactions": { transactions: [tx("t1", "2026-09-01", -1000)] },
    });
    const { json } = await mcpClient(fetchImpl).call("search", { query: "groc" });
    const ids = json.results.map((r: any) => r.id);
    expect(ids).toEqual([`category:${GROCERIES}`, "payee:p1", "transaction:t1"]);
    expect(json.results[0].url).toStartWith("https://app.ynab.com/");
  });
});

describe("write tools", () => {
  test("create_transactions sends milliunits and approves by default", async () => {
    const { fetchImpl, calls } = fakeYnab({
      "POST /plans/last-used/transactions": (call) => ({
        transactions: call.body.transactions.map((t: any, i: number) => ({ ...tx(`n${i}`, t.date, t.amount), approved: t.approved })),
      }),
    });
    const { json, isError } = await mcpClient(fetchImpl).call("create_transactions", {
      transactions: [
        { account_id: ACCOUNT, date: "2026-09-20", amount: -12.345, payee_name: "Cafe", category_id: DINING },
        {
          account_id: ACCOUNT,
          date: "2026-09-21",
          amount: -30,
          category_id: null,
          subtransactions: [
            { amount: -20, category_id: GROCERIES },
            { amount: -10, category_id: DINING },
          ],
        },
      ],
    });
    expect(isError).toBe(false);
    const sent = calls[0]!.body.transactions;
    expect(sent[0].amount).toBe(-12345);
    expect(sent[0].approved).toBe(true);
    expect(sent[1].subtransactions.map((s: any) => s.amount)).toEqual([-20000, -10000]);
    expect(json.created[0].amount).toBe(-12.345);
  });

  test("move_money adjusts both categories' assigned amounts", async () => {
    const { fetchImpl, calls } = fakeYnab({
      "GET /plans/last-used/months/current": {
        month: {
          month: "2026-09-01",
          categories: [category(GROCERIES, "Groceries", 500000, 100000), category(DINING, "Dining", 100000, 0)],
        },
      },
      [`PATCH /plans/last-used/months/current/categories/${GROCERIES}`]: (c) => ({
        category: category(GROCERIES, "Groceries", c.body.category.budgeted, 0),
      }),
      [`PATCH /plans/last-used/months/current/categories/${DINING}`]: (c) => ({
        category: category(DINING, "Dining", c.body.category.budgeted, 0),
      }),
    });
    const { isError } = await mcpClient(fetchImpl).call("move_money", {
      amount: 50,
      from_category_id: GROCERIES,
      to_category_id: DINING,
    });
    expect(isError).toBe(false);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((p) => p.body.category.budgeted)).toEqual([450000, 150000]);
  });

  test("move_money requires at least one category", async () => {
    const { fetchImpl, calls } = fakeYnab({});
    const { isError } = await mcpClient(fetchImpl).call("move_money", { amount: 5 });
    expect(isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("explicit plan_id is used in the path", async () => {
    const plan = "44444444-4444-4444-8444-444444444444";
    const { fetchImpl, calls } = fakeYnab({
      [`PATCH /plans/${plan}/months/2026-10-01/categories/${GROCERIES}`]: { category: category(GROCERIES, "Groceries", 75000, 0) },
    });
    const { json } = await mcpClient(fetchImpl).call("set_category_assigned", {
      plan_id: plan,
      category_id: GROCERIES,
      month: "2026-10",
      assigned: 75,
    });
    expect(calls[0]!.body).toEqual({ category: { budgeted: 75000 } });
    expect(json.assigned).toBe(75);
  });
});

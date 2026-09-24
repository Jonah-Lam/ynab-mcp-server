// `search` and `fetch` follow the shape ChatGPT expects for connectors used in
// deep research and company knowledge. Other clients can use them too.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { seg } from "../ynab/client";
import { formatAccount, formatCategory, formatTransaction, fromMilli } from "../ynab/format";
import type { Account, MonthDetail, Payee, Transaction } from "../ynab/types";
import { READ_ONLY, errorResult, planPath, type ToolContext } from "./common";

type Kind = "account" | "category" | "payee" | "transaction";

interface SearchResult {
  id: string;
  title: string;
  url: string;
}

function webUrl(ctx: ToolContext, kind: Kind, id: string): string {
  const plan = ctx.defaultPlanId;
  const isUuid = /^[0-9a-f-]{36}$/i.test(plan);
  if (!isUuid) return "https://app.ynab.com/";
  if (kind === "account") return `https://app.ynab.com/${plan}/accounts/${id}`;
  return `https://app.ynab.com/${plan}/budget`;
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function registerSearchTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "search",
    {
      title: "Search YNAB",
      description:
        "Search the default YNAB plan for accounts, categories, payees and transactions from the last 180 days whose name, payee, memo or category matches the query. Returns IDs to pass to fetch.",
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      try {
        const base = planPath(ctx, undefined);
        const needle = query.toLowerCase();
        const [{ accounts }, { month }, { payees }, { transactions }] = await Promise.all([
          ctx.ynab.get<{ accounts: Account[] }>(`${base}/accounts`),
          ctx.ynab.get<{ month: MonthDetail }>(`${base}/months/current`),
          ctx.ynab.get<{ payees: Payee[] }>(`${base}/payees`),
          ctx.ynab.get<{ transactions: Transaction[] }>(`${base}/transactions`, { since_date: daysAgo(180) }),
        ]);
        const results: SearchResult[] = [];
        for (const a of accounts) {
          if (!a.deleted && a.name.toLowerCase().includes(needle))
            results.push({ id: `account:${a.id}`, title: `Account: ${a.name}`, url: webUrl(ctx, "account", a.id) });
        }
        for (const c of month.categories) {
          if (!c.deleted && c.name.toLowerCase().includes(needle))
            results.push({ id: `category:${c.id}`, title: `Category: ${c.name}`, url: webUrl(ctx, "category", c.id) });
        }
        for (const p of payees) {
          if (!p.deleted && p.name.toLowerCase().includes(needle))
            results.push({ id: `payee:${p.id}`, title: `Payee: ${p.name}`, url: webUrl(ctx, "payee", p.id) });
        }
        const txMatches = transactions
          .filter((t) => !t.deleted)
          .filter((t) => [t.payee_name, t.memo, t.category_name].filter(Boolean).join(" ").toLowerCase().includes(needle))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 30);
        for (const t of txMatches) {
          results.push({
            id: `transaction:${t.id}`,
            title: `${t.date} ${t.payee_name ?? "(no payee)"} ${fromMilli(t.amount)}${t.category_name ? ` [${t.category_name}]` : ""}`,
            url: webUrl(ctx, "transaction", t.id),
          });
        }
        return textResult({ results: results.slice(0, 50) });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Search failed");
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch YNAB item",
      description: "Fetch full details for an ID returned by search (e.g. \"transaction:<id>\", \"category:<id>\").",
      inputSchema: z.object({ id: z.string().regex(/^(account|category|payee|transaction):[A-Za-z0-9_-]{1,100}$/, "Unknown ID format") }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      try {
        const [kind, rawId] = id.split(":") as [Kind, string];
        const base = planPath(ctx, undefined);
        let title: string;
        let data: unknown;
        if (kind === "account") {
          const { account } = await ctx.ynab.get<{ account: Account }>(`${base}/accounts/${seg(rawId)}`);
          title = account.name;
          data = formatAccount(account);
        } else if (kind === "category") {
          const { category } = await ctx.ynab.get<{ category: MonthDetail["categories"][number] }>(
            `${base}/months/current/categories/${seg(rawId)}`,
          );
          title = category.name;
          data = formatCategory(category);
        } else if (kind === "payee") {
          const [{ payee }, { transactions }] = await Promise.all([
            ctx.ynab.get<{ payee: Payee }>(`${base}/payees/${seg(rawId)}`),
            ctx.ynab.get<{ transactions: Transaction[] }>(`${base}/payees/${seg(rawId)}/transactions`, {
              since_date: daysAgo(365),
            }),
          ]);
          title = payee.name;
          const recent = transactions.filter((t) => !t.deleted).sort((a, b) => b.date.localeCompare(a.date));
          data = {
            id: payee.id,
            name: payee.name,
            transactions_last_365_days: recent.length,
            total_last_365_days: fromMilli(recent.reduce((s, t) => s + t.amount, 0)),
            recent_transactions: recent.slice(0, 20).map(formatTransaction),
          };
        } else {
          const { transaction } = await ctx.ynab.get<{ transaction: Transaction }>(`${base}/transactions/${seg(rawId)}`);
          title = `${transaction.date} ${transaction.payee_name ?? "(no payee)"} ${fromMilli(transaction.amount)}`;
          data = formatTransaction(transaction);
        }
        return textResult({
          id,
          title,
          text: JSON.stringify(data, null, 1),
          url: webUrl(ctx, kind, rawId),
          metadata: { type: kind },
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Fetch failed");
      }
    },
  );
}

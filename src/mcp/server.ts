import { McpServer } from "@modelcontextprotocol/server";
import { type FetchFn, YnabClient } from "../ynab/client";
import type { ToolContext } from "./common";
import { registerReadTools } from "./read-tools";
import { registerSearchTools } from "./search-tools";
import { registerWriteTools } from "./write-tools";

export const SERVER_NAME = "ynab-mcp";
export const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `Tools for the user's YNAB (You Need A Budget) data.
- All amounts are in the plan's currency units (not milliunits). Negative = outflow/spending, positive = inflow.
- plan_id is optional everywhere; it defaults to the user's last-used plan.
- Use get_budget_month for category balances and IDs, list_accounts for account IDs, list_transactions to look at spending.
- Confirm with the user before deleting anything or making bulk changes.`;

export interface ServerOptions {
  ynabToken: string;
  defaultPlanId?: string;
  canWrite: boolean;
  fetchImpl?: FetchFn;
}

function normalizePlanId(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "default" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
  return "last-used";
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = {
    ynab: new YnabClient(opts.ynabToken, opts.fetchImpl),
    defaultPlanId: normalizePlanId(opts.defaultPlanId),
  };
  registerReadTools(server, ctx);
  registerSearchTools(server, ctx);
  if (opts.canWrite) registerWriteTools(server, ctx);
  return server;
}

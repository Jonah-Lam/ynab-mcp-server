import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { YnabClient, YnabError } from "../ynab/client";

export interface ToolContext {
  ynab: YnabClient;
  defaultPlanId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const planIdSchema = z
  .string()
  .refine((v) => v === "last-used" || v === "default" || UUID.test(v), "Must be a plan ID, \"last-used\" or \"default\"")
  .optional()
  .describe('Plan (budget) ID from list_plans. Omit to use the server default (usually "last-used").');

export const uuid = (what: string) => z.string().regex(UUID, `Must be a ${what} ID (UUID)`);

// Transaction IDs are usually UUIDs, but scheduled instances look like "<uuid>_<date>".
export const transactionId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, "Invalid transaction ID")
  .describe("Transaction ID");

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const monthSchema = z
  .string()
  .regex(/^(current|\d{4}-\d{2}(-\d{2})?)$/, 'Use YYYY-MM or "current"')
  .optional()
  .describe('Month as YYYY-MM, or "current". Defaults to the current month.');

export const amountSchema = z
  .number()
  .finite()
  .refine((v) => Math.abs(v) < 1e12, "Amount too large")
  .describe("Amount in the plan's currency units (e.g. -42.5). Negative = outflow/spending, positive = inflow.");

export const flagColor = z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).nullable();

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool body, turning YNAB and validation errors into MCP tool errors the model can read. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (error) {
    if (error instanceof YnabError) return errorResult(error.message);
    if (error instanceof Error) return errorResult(`Error: ${error.message}`);
    return errorResult("Unknown error");
  }
}

export function planPath(ctx: ToolContext, planId: string | undefined): string {
  const id = planId ?? ctx.defaultPlanId;
  return `/plans/${encodeURIComponent(id)}`;
}
